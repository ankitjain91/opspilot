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

// Shared state to hold the target ArgoCD port
// This allows us to update the target if port-forward restarts on a different port (unlikely but good practice)
#[derive(Clone)]
pub struct ProxyState {
    pub target_port: Arc<Mutex<Option<u16>>>,
}

// Global handle to stop the server
static SHUTDOWN_TX: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);
static RUNNING_PORT: Mutex<Option<u16>> = Mutex::new(None);

pub async fn start_proxy(target_argocd_port: u16) -> Result<u16, String> {
    // Check if already running
    {
        let guard = RUNNING_PORT.lock().unwrap();
        if let Some(port) = *guard {
            return Ok(port);
        }
    }

    let state = ProxyState {
        target_port: Arc::new(Mutex::new(Some(target_argocd_port))),
    };

    let app = Router::new()
        .route("/*path", any(proxy_handler))
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

    println!("[ArgoCD Proxy] Starting on port {}", port);

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
        guard.ok_or(StatusCode::SERVICE_UNAVAILABLE)?
    };

    // Construct target URL
    // ArgoCD is usually HTTP on localhost port-forward, or HTTPS with self-signed
    // Our port-forward logic currently maps 8080 (or sim) to target. 
    // Usually it talks standard HTTP locally unless we are forwarding 443 strictly.
    // Let's assume HTTP for localhost forwarding for now as 'kubectl port-forward' to a Service often handles protocol.
    // Wait, earlier logic in argocd.rs determines if it's HTTPS. We should probably respect that or blindly try.
    // For simplicity, let's assume valid URL construction.
    
    // NOTE: argocd.rs determines protocol. We might need to pass that in state too.
    // For now, let's hardcode http://localhost:PORT because kubectl port-forward usually exposes plaintext on local end 
    // UNLESS the pod itself forces HTTPS. The 'argocd-server' usually listens on 8080 (http) and 8083 (http) side by side with 443.
    // But our port forwarder maps to the Service port.
    
    // Let's use the same logic as argocd.rs or just pass the full base URL.
    // For now, assuming HTTP is safest if we target the HTTP port.
    
    let uri_string = format!("https://localhost:{}{}{}", target_port, path, query);
    // Note: Using HTTPS and insecure client because ArgoCD server is almost always HTTPS-only by default.
    let url = uri_string.parse::<Uri>().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    *req.uri_mut() = url;
    
    // remove host header so reqwest calculates it
    req.headers_mut().remove("host");

    // Client with dangerous_accept_invalid_certs
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Execute request
    // We convert axum request to reqwest request
    // Requires copying method, headers, body
    let method = req.method().clone();
    let headers = req.headers().clone();
    
    // Stream body? For simplicity, read body (ArgoCD UI payloads are small)
    // For robust proxying, streaming is better, but 'reqwest::Client' can take 'req::into_body()' if compatible.
    // Axum Body is http_body::Body. Reqwest Body is different.
    // Let's just collect bytes for now to avoid stream compat mess without extra crates.
    let body_bytes = axum::body::to_bytes(req.into_body(), 100 * 1024 * 1024).await // 100MB limit
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let mut request_builder = client.request(method, uri_string)
        .body(body_bytes);
    
    for (name, value) in headers {
        if name != "host" {
            request_builder = request_builder.header(name, value);
        }
    }

    let response = request_builder.send().await
        .map_err(|e| {
            eprintln!("Proxy Request Error: {}", e);
            StatusCode::BAD_GATEWAY
        })?;

    let status = response.status();
    let resp_headers = response.headers().clone();
    let resp_bytes = response.bytes().await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    // Build response
    let mut builder = Response::builder().status(status);
    
    // Copy headers but STRIP blocking ones
    if let Some(headers_mut) = builder.headers_mut() {
        for (name, value) in resp_headers {
            if let Some(name) = name {
                let name_lower = name.as_str().to_lowercase();
                // STRIP HEADERS THAT BLOCK IFRAMES
                if name_lower == "x-frame-options" || name_lower == "content-security-policy" {
                    continue;
                }
                headers_mut.insert(name, value);
            }
        }
        // Force permissive headers
        headers_mut.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
        // headers_mut.insert("Content-Security-Policy", HeaderValue::from_static("frame-ancestors *;")); 
    }

    builder.body(Body::from(resp_bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
