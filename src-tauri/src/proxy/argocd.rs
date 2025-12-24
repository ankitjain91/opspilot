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
}

// Global handle to stop the server
static SHUTDOWN_TX: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);
static RUNNING_PORT: Mutex<Option<u16>> = Mutex::new(None);

pub async fn start_proxy(target_argocd_port: u16, protocol: &str) -> Result<u16, String> {
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

    println!("[ArgoCD Proxy] Upstream Response: {} {}", method, status);

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
                headers_mut.insert(name, value);
            }
        }
        // Force permissive headers
        headers_mut.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    }

    // Stream the body instead of buffering
    // This allows large files (main.js) to flow through immediately
    use futures::TryStreamExt;
    let stream = response.bytes_stream().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
    let body = Body::from_stream(stream);

    builder.body(body)
        .map_err(|e| {
             eprintln!("[ArgoCD Proxy] Failed to build response: {}", e);
             StatusCode::INTERNAL_SERVER_ERROR
        })
}
