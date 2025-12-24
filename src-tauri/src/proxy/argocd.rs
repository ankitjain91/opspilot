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
}

// Global handle to stop the server
static SHUTDOWN_TX: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);
static RUNNING_PORT: Mutex<Option<u16>> = Mutex::new(None);

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
    
    // Remove host header so reqwest calculates it
    let method = req.method().clone();
    let mut headers = req.headers().clone();
    headers.remove("host");
    headers.remove("connection"); // Avoid 'connection: close' issues?
    headers.remove("accept-encoding"); // Let reqwest negotiate compression, or just get plain text
    
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
        // Simple string injection
        let script = format!(
            r#"
            <script>
            (function() {{
                const USERNAME = "{}";
                const PASSWORD = "{}";
                const ATTEMPT_DURATION_MS = 15000;
                const START_TIME = Date.now();
        
                function log(msg) {{
                    console.log(`[OpPilot AutoLogin] ${{msg}}`);
                }}
        
                window.addEventListener('load', () => {{
                    log("Window Loaded - Starting Auto Login attempt");
        
                    const checkAndLogin = () => {{
                        if (Date.now() - START_TIME > ATTEMPT_DURATION_MS) return false;
        
                        try {{
                            // ArgoCD Login Form Selectors
                            const usernameInput = document.querySelector('input[name="username"]') || document.querySelector('input[class*="login-username"]');
                            const passwordInput = document.querySelector('input[name="password"]') || document.querySelector('input[class*="login-password"]');
                            const loginButton = document.querySelector('button[type="submit"]') || document.querySelector('button[class*="login-button"]');
        
                            if (usernameInput && passwordInput && loginButton) {{
                                log("Found login fields");
                                
                                // Only fill if empty
                                if (usernameInput.value === "") {{
                                    log("Filling credentials...");
                                    
                                    // Helper to trigger React/Native change events
                                    function setNativeValue(element, value) {{
                                        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
                                        const prototype = Object.getPrototypeOf(element);
                                        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
                                        
                                        if (valueSetter && valueSetter !== prototypeValueSetter) {{
                                            prototypeValueSetter.call(element, value);
                                        }} else {{
                                            valueSetter.call(element, value);
                                        }}
                                        element.dispatchEvent(new Event('input', {{ bubbles: true }}));
                                    }}
        
                                    try {{
                                        setNativeValue(usernameInput, USERNAME);
                                        setNativeValue(passwordInput, PASSWORD);
                                    }} catch (e) {{
                                        // Fallback if esoteric getter/setter fails
                                        usernameInput.value = USERNAME;
                                        passwordInput.value = PASSWORD;
                                        usernameInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                                        passwordInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                                    }}
        
                                    log("Credentials filled, submitting...");
                                    setTimeout(() => {{
                                        loginButton.click();
                                        log("Login button clicked");
                                    }}, 300);
                                    return true;
                                }}
                            }}
                        }} catch (e) {{
                            log(`Error: ${{e}}`);
                        }}
                        return false;
                    }};
        
                    if (!checkAndLogin()) {{
                        const interval = setInterval(() => {{
                            if (checkAndLogin() || (Date.now() - START_TIME > ATTEMPT_DURATION_MS)) {{
                                clearInterval(interval);
                            }}
                        }}, 500);
                    }}
                }});
            }})();
            </script>
            </body>
            "#,
            state.username, state.password
        );
        
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
