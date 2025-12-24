use std::sync::{Arc, Mutex};
use axum::{
    body::Body,
    extract::{State, Request},
    http::{HeaderValue, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use tower_http::cors::CorsLayer;
use tokio::sync::oneshot;

// Shared state to hold the target ArgoCD port and client
// This allows us to update the target if port-forward restarts
#[derive(Clone)]
pub struct ProxyState {
    pub target_port: Arc<Mutex<Option<u16>>>,
    pub protocol: String, // "http" or "https"
    pub client: reqwest::Client,
    pub username: String,
    pub password: String,
    pub auth_token: Arc<Mutex<Option<String>>>,
}

// Global handle to stop the server
static SHUTDOWN_TX: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);
static RUNNING_PORT: Mutex<Option<u16>> = Mutex::new(None);

#[derive(serde::Deserialize)]
struct ArgocdSessionResponse {
    token: String,
}

pub async fn start_proxy(
    target_argocd_port: u16, 
    protocol: &str,
    username: &str,
    password: &str
) -> Result<u16, String> {
    // Check if already running on same port?
    // Actually we might need to restart if protocol changed, but let's assume one instance for now
    {
        let guard = RUNNING_PORT.lock().unwrap();
        if let Some(port) = *guard {
            println!("[ArgoCD Proxy] Already running on port {}", port);
            return Ok(port);
        }
    }

    // Create a shared client efficiently
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none()) // Don't follow redirects automatically, let browser handle
        .build()
        .map_err(|e| format!("Failed to build proxy client: {}", e))?;

    let state = ProxyState {
        target_port: Arc::new(Mutex::new(Some(target_argocd_port))),
        protocol: protocol.to_string(),
        client,
        username: username.to_string(),
        password: password.to_string(),
        auth_token: Arc::new(Mutex::new(None)),
    };

    let app = Router::new()
        .route("/", any(proxy_handler))
        .route("/{*path}", any(proxy_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    // Bind to port 0 to let OS choose a free port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind proxy: {}", e))?;
    
    let port = listener.local_addr().unwrap().port();
    
    // Setup shutdown channel
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = SHUTDOWN_TX.lock().unwrap();
        *guard = Some(tx);
    }
    
    {
        let mut guard = RUNNING_PORT.lock().unwrap();
        *guard = Some(port);
    }

    println!("[ArgoCD Proxy] Started HTTP->{} proxy on 127.0.0.1:{} -> target:{}", protocol, port, target_argocd_port);

    // Spawn server in background
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                rx.await.ok();
            })
            .await 
        {
            eprintln!("[ArgoCD Proxy] Server error: {}", e);
        }
        
        // Cleanup on exit
        let mut guard = RUNNING_PORT.lock().unwrap();
        *guard = None;
    });

    Ok(port)
}

pub fn stop_proxy() {
    let mut guard = SHUTDOWN_TX.lock().unwrap();
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    let mut port_guard = RUNNING_PORT.lock().unwrap();
    *port_guard = None;
}

async fn proxy_handler(
    State(state): State<ProxyState>,
    mut req: Request,
) -> Result<Response, StatusCode> {
    let path = req.uri().path();
    let query = req.uri().query().map(|q| format!("?{}", q)).unwrap_or_default();
    
    // Get target port
    let target_port = {
        let guard = state.target_port.lock().unwrap();
        if let Some(p) = *guard {
            p
        } else {
            eprintln!("[ArgoCD Proxy] Error: Target port not set");
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
    };

    let uri_string = format!("{}://localhost:{}{}{}", state.protocol, target_port, path, query);
    
    println!("[ArgoCD Proxy] Forwarding: {} -> {}", path, uri_string);

    let url = uri_string.parse::<Uri>().map_err(|e| {
        eprintln!("[ArgoCD Proxy] Invalid URI constructed: {} ({})", uri_string, e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    *req.uri_mut() = url;

    // --- Authentication Injection ---
    // Ensure we have a token, then inject it
    let mut token = {
        let guard = state.auth_token.lock().unwrap();
        guard.clone()
    };

    if token.is_none() {
        println!("[ArgoCD Proxy] No auth token found. Attempting backend login...");
        // Try to login
        let login_url = format!("{}://localhost:{}/api/v1/session", state.protocol, target_port);
        let body = serde_json::json!({
            "username": state.username,
            "password": state.password
        });
        
        match state.client.post(&login_url).json(&body).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    if let Ok(json) = resp.json::<ArgocdSessionResponse>().await {
                        println!("[ArgoCD Proxy] Backend login successful! Token acquired.");
                        let mut guard = state.auth_token.lock().unwrap();
                        *guard = Some(json.token.clone());
                        token = Some(json.token);
                    } else {
                        eprintln!("[ArgoCD Proxy] Login response parsing failed");
                    }
                } else {
                     eprintln!("[ArgoCD Proxy] Backend login failed: {}", resp.status());
                }
            }
            Err(e) => eprintln!("[ArgoCD Proxy] Backend login request failed: {}", e),
        }
    } else {
        // Token exists.
        // TODO: Handle expiry?
    }
    
    // Remove host header so reqwest calculates it
    let method = req.method().clone();
    let mut headers = req.headers().clone();
    headers.remove("host");
    headers.remove("connection"); // Avoid 'connection: close' issues?
    headers.remove("accept-encoding"); // Let reqwest negotiate compression, or just get plain text
    
    // Inject Authorization Header if we have a token
    if let Some(tok) = token {
        // Only inject if not already present (though usually it won't be)
        if !headers.contains_key("authorization") {
             if let Ok(hv) = HeaderValue::from_str(&format!("Bearer {}", tok)) {
                 headers.insert("authorization", hv);
                 // Also strip Cookie to avoid conflicts? 
                 // Actually ArgoCD prefers Auth header, so let's keep Cookie just in case of other cookies
                 println!("[ArgoCD Proxy] Injected Authorization Header");
             }
        }
    }
    
    // Rewrite Origin and Referer to match upstream
    // This trick makes ArgoCD think the request is coming from itself (Same Origin)
    let upstream_base = format!("{}://localhost:{}", state.protocol, target_port);
    if let Some(origin) = headers.get("origin") {
        if let Ok(val) = origin.to_str() {
             println!("[ArgoCD Proxy] Rewriting Origin: {} -> {}", val, upstream_base);
        }
        if let Ok(hv) = HeaderValue::from_str(&upstream_base) {
            headers.insert("origin", hv);
        }
    }
    
    // Rewrite Referer (just the base part)
    if let Some(_) = headers.get("referer") {
         // We can just forcefully set it to the upstream base or try to replace the host part
         // For simplicity/robustness, let's just use upstream base or the current full URI
         // Usually setting it to the upstream URI is safest
         if let Ok(hv) = HeaderValue::from_str(&uri_string) {
             headers.insert("referer", hv);
         }
    }
    
    // Debug: Check for cookies
    if let Some(cookie) = headers.get("cookie") {
        let l = cookie.len();
        println!("[ArgoCD Proxy] Request has Cookie (len={})", l);
    } else {
        println!("[ArgoCD Proxy] Request MISSING Cookie!");
    }
    
    // Create request with body and headers
    let body_bytes = axum::body::to_bytes(req.into_body(), 100 * 1024 * 1024).await // 100MB limit
        .map_err(|_e| {
            eprintln!("[ArgoCD Proxy] Failed to read request body");
            StatusCode::BAD_REQUEST
        })?;

    let request_builder = state.client.request(method.clone(), uri_string.clone())
        .headers(headers)
        .body(body_bytes);

    let response = request_builder.send().await
        .map_err(|e| {
            eprintln!("[ArgoCD Proxy] Upstream Request Error: {} ({} {})", e, method, uri_string);
            StatusCode::BAD_GATEWAY
        })?;

    let status = response.status();
    let resp_headers = response.headers().clone();

    // Check content type to decide whether to inject script
    let content_type = resp_headers.get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    
    let is_html = content_type.contains("text/html");

    println!("[ArgoCD Proxy] Upstream Response: {} {} [HTML={}]", method, status, is_html);

    // Build response
    let mut builder = Response::builder().status(status);
    
    // Copy headers but STRIP hop-by-hop and blocking headers
    if let Some(headers_mut) = builder.headers_mut() {
        for (name, value) in resp_headers {
            if let Some(name) = name {
                let name_lower = name.as_str().to_lowercase();
                // Standard hop-by-hop headers + Proxy specific
                if name_lower == "connection"
                   || name_lower == "keep-alive"
                   || name_lower == "proxy-authenticate"
                   || name_lower == "proxy-authorization"
                   || name_lower == "te"
                   || name_lower == "trailer"
                   || name_lower == "transfer-encoding"
                   || name_lower == "upgrade"
                   || name_lower == "content-length" 
                   || name_lower == "content-encoding" // Let browser handle decoding if any
                   || name_lower == "x-frame-options"
                   || name_lower == "content-security-policy"
                {
                    continue;
                }
                
                // IMPORTANT: Handle Cookies for HTTP Proxy
                // ArgoCD sends "Secure; SameSite=None" which requires HTTPS.
                // Since we proxy over HTTP (localhost), we must strip "Secure".
                // And "SameSite=None" requires "Secure", so we must strip that too (reverting to Lax/Default).
                if name_lower == "set-cookie" {
                    if let Ok(v_str) = value.to_str() {
                        let new_val = v_str
                            .replace("; Secure", "")
                            .replace("; SameSite=None", "");
                        
                        println!("[ArgoCD Proxy] Rewrote Cookie: {} -> {}", v_str, new_val);
                        
                        if let Ok(hv) = HeaderValue::from_str(&new_val) {
                             headers_mut.insert(name, hv);
                             continue;
                        }
                    }
                }

                headers_mut.insert(name, value);
            }
        }
        // Force permissive headers
        headers_mut.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    }

    if is_html {
        // For HTML, we MUST buffer to inject the script
        let body_bytes = response.bytes().await.map_err(|e| {
            eprintln!("[ArgoCD Proxy] Failed to buffer HTML body: {}", e);
            StatusCode::BAD_GATEWAY
        })?;
        
        let mut html = String::from_utf8_lossy(&body_bytes).to_string();
        
        // Inject script before </body>
        // Since we inject the token via headers, we just need to ensure the UI thinks we are logged in.
        // We set a dummy cookie so client-side logic that checks for 'argocd.token' doesn't redirect to login.
        let script = r#"
            <script>
            (function() {
                // simple "cookie faker"
                if (!document.cookie.includes('argocd.token')) {
                    console.log("[OpsPilot] Injecting dummy cookie to bypass client checks");
                    document.cookie = 'argocd.token=proxied_by_opspilot; path=/; max-age=31536000';
                }
            })();
            </script>
            </body>
            "#;
        
        if let Some(idx) = html.rfind("</body>") {
            html.replace_range(idx..idx+7, &script);
        } else {
            // Append if no body tag found
            html.push_str(&script);
        }
        
        builder.body(Body::from(html))
             .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)

    } else {
        // Non-HTML: Stream as before
        use futures::TryStreamExt;
        let stream = response.bytes_stream().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
        let body = Body::from_stream(stream);
    
        builder.body(body)
            .map_err(|e| {
                 eprintln!("[ArgoCD Proxy] Failed to build response: {}", e);
                 StatusCode::INTERNAL_SERVER_ERROR
            })
    }
}
