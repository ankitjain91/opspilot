use tauri::State;
use kube::api::Api;
use k8s_openapi::api::core::v1::{Secret, Service};
use crate::state::AppState;
use crate::client::create_client;
use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::net::TcpListener;
use serde::Serialize;
use std::time::Duration;

/// Global state for port-forward process
static ARGOCD_PORT_FORWARD: Mutex<Option<Child>> = Mutex::new(None);

/// Port used for ArgoCD port-forward
const ARGOCD_LOCAL_PORT: u16 = 9080;

/// ArgoCD server connection info
#[derive(Serialize)]
pub struct ArgoCDServerInfo {
    pub url: String,
    pub username: String,
    pub password: String,
    pub namespace: String,
    pub port_forward_active: bool,
}

/// Find ArgoCD namespace
async fn find_argocd_namespace(client: &kube::Client) -> Option<String> {
    let namespaces = vec!["argocd", "argo-cd", "argocd-system"];

    for ns in &namespaces {
        let services: Api<Service> = Api::namespaced(client.clone(), ns);
        if services.get("argocd-server").await.is_ok() {
            return Some(ns.to_string());
        }
    }
    None
}

/// Get ArgoCD server info and start port-forward if needed
#[tauri::command]
pub async fn get_argocd_server_info(
    state: State<'_, AppState>,
) -> Result<ArgoCDServerInfo, String> {
    let client = create_client(state).await?;

    let namespace = find_argocd_namespace(&client).await
        .ok_or("ArgoCD not found in cluster. Checked namespaces: argocd, argo-cd, argocd-system")?;

    // Get admin password from secret
    let secrets: Api<Secret> = Api::namespaced(client.clone(), &namespace);

    let password = match secrets.get("argocd-initial-admin-secret").await {
        Ok(admin_secret) => {
            admin_secret.data
                .and_then(|data| data.get("password").cloned())
                .and_then(|pw| String::from_utf8(pw.0).ok())
                .map(|p| p.trim().to_string())
        }
        Err(_) => None
    };

    let password = password.ok_or_else(|| {
        "ArgoCD admin password not found. The 'argocd-initial-admin-secret' may have been deleted.".to_string()
    })?;

    // Check if port-forward is already running
    let port_forward_active = {
        let guard = ARGOCD_PORT_FORWARD.lock().unwrap();
        guard.is_some()
    };

    // Determine protocol based on target port
    // We need to re-check the port to decide protocol
    let target_port = get_argocd_http_port(&client, &namespace).await.unwrap_or(80);
    let protocol = if target_port == 80 || target_port == 8080 {
        "http"
    } else {
        "https"
    };

    Ok(ArgoCDServerInfo {
        url: format!("{}://localhost:{}", protocol, ARGOCD_LOCAL_PORT),
        username: "admin".to_string(),
        password,
        namespace,
        port_forward_active,
    })
}

/// Check if port is available (platform-agnostic, pure Rust)
fn is_port_available(port: u16) -> bool {
    // Try binding to both IPv4 and IPv6
    TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Kill process by PID (platform-agnostic)
fn kill_process(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(&["-9", &pid.to_string()])
            .stderr(Stdio::null())
            .stdout(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(&["/F", "/PID", &pid.to_string()])
            .stderr(Stdio::null())
            .stdout(Stdio::null())
            .status();
    }
}

/// Get PIDs using a specific port (platform-agnostic)
fn get_pids_using_port(port: u16) -> Vec<u32> {
    let mut pids = Vec::new();

    #[cfg(unix)]
    {
        // Use lsof (available on macOS and most Linux)
        if let Ok(output) = Command::new("lsof")
            .args(&[&format!("-ti:{}", port)])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.trim().lines() {
                if let Ok(pid) = line.trim().parse::<u32>() {
                    pids.push(pid);
                }
            }
        }
    }

    #[cfg(windows)]
    {
        // Use netstat on Windows
        if let Ok(output) = Command::new("netstat")
            .args(&["-aon"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let port_str = format!(":{}", port);
            for line in stdout.lines() {
                if line.contains(&port_str) && line.contains("LISTENING") {
                    // Last column is PID
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            pids.push(pid);
                        }
                    }
                }
            }
        }
    }

    pids
}

/// Kill any existing port-forward processes on the ArgoCD port - IRONCLAD version
fn cleanup_stale_port_forwards() {
    // Method 1: Kill by port (most reliable, platform-agnostic)
    let pids = get_pids_using_port(ARGOCD_LOCAL_PORT);
    for pid in &pids {
        eprintln!("[argocd] Killing process {} using port {}", pid, ARGOCD_LOCAL_PORT);
        kill_process(*pid);
    }

    // Method 2: Kill kubectl port-forward processes by pattern
    #[cfg(unix)]
    {
        // pkill by pattern
        let _ = Command::new("pkill")
            .args(&["-9", "-f", &format!("kubectl.*port-forward.*{}", ARGOCD_LOCAL_PORT)])
            .stderr(Stdio::null())
            .stdout(Stdio::null())
            .status();

        let _ = Command::new("pkill")
            .args(&["-9", "-f", "kubectl.*port-forward.*argocd"])
            .stderr(Stdio::null())
            .stdout(Stdio::null())
            .status();
    }

    #[cfg(windows)]
    {
        // On Windows, we can use wmic or taskkill with filters
        let _ = Command::new("taskkill")
            .args(&["/F", "/IM", "kubectl.exe"])
            .stderr(Stdio::null())
            .stdout(Stdio::null())
            .status();
    }

    // Wait for OS to release the port
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Final verification - if still occupied, try once more
    if !is_port_available(ARGOCD_LOCAL_PORT) {
        let pids = get_pids_using_port(ARGOCD_LOCAL_PORT);
        if !pids.is_empty() {
            eprintln!("[argocd] Port {} still in use by PIDs: {:?}, retrying kill", ARGOCD_LOCAL_PORT, pids);
            for pid in pids {
                kill_process(pid);
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }
}

/// Get the HTTP port for ArgoCD server service
async fn get_argocd_http_port(client: &kube::Client, namespace: &str) -> Result<i32, String> {
    let services: Api<Service> = Api::namespaced(client.clone(), namespace);
    let svc = services.get("argocd-server").await
        .map_err(|e| format!("Failed to get argocd-server service: {}", e))?;

    // Look for HTTP port (usually named "http" or port 80 or 8080)
    if let Some(spec) = svc.spec {
        if let Some(ports) = spec.ports {
            // Prefer port named "http", fallback to port 80, then 8080
            for port in &ports {
                if port.name.as_deref() == Some("http") {
                    return Ok(port.port);
                }
            }
            for port in &ports {
                if port.port == 80 {
                    return Ok(80);
                }
            }
            for port in &ports {
                if port.port == 8080 {
                    return Ok(8080);
                }
            }
            // Fallback to the first port (even if 443) rather than guessing 80
            if let Some(port) = ports.first() {
                return Ok(port.port);
            }
        }
    }

    // Default to 80 if we can't determine
    Ok(80)
}

/// Start port-forward to ArgoCD server
#[tauri::command]
pub async fn start_argocd_port_forward(
    state: State<'_, AppState>,
) -> Result<String, String> {
    // First, stop any existing port-forward we're tracking
    // Check if we already have a running port-forward
    {
        let mut guard = ARGOCD_PORT_FORWARD.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            // Check if process is still alive
            match child.try_wait() {
                Ok(None) => {
                    // Still running, assume it's good
                    // We could verify the port is actually listening, but let's assume if process is alive it's ok
                     eprintln!("[argocd] Port-forward already active");
                    return Ok(format!("Port-forward already active on localhost:{}", ARGOCD_LOCAL_PORT));
                }
                Ok(Some(_)) => {
                    // Exited, clear it
                    *guard = None;
                }
                Err(_) => {
                    // Error checking, assume dead
                    *guard = None;
                }
            }
        }
    }

    // Clean up any orphaned port-forwards from previous sessions
    cleanup_stale_port_forwards();

    // Verify port is available with retries
    let max_retries = 3;
    for attempt in 1..=max_retries {
        if is_port_available(ARGOCD_LOCAL_PORT) {
            break;
        }
        if attempt == max_retries {
            return Err(format!(
                "Port {} is still in use after {} cleanup attempts. Please manually kill the process.",
                ARGOCD_LOCAL_PORT, max_retries
            ));
        }
        eprintln!("[argocd] Port {} still in use, cleanup attempt {}/{}", ARGOCD_LOCAL_PORT, attempt, max_retries);
        cleanup_stale_port_forwards();
    }

    let client = create_client(state).await?;
    let namespace = find_argocd_namespace(&client).await
        .ok_or("ArgoCD not found in cluster")?;

    // Get the HTTP port from the service
    let target_port = get_argocd_http_port(&client, &namespace).await?;
    eprintln!("[argocd] Using target port {} for ArgoCD server", target_port);

    // Start kubectl port-forward in background
    let port_mapping = format!("{}:{}", ARGOCD_LOCAL_PORT, target_port);
    let mut child = Command::new("kubectl")
        .args(&[
            "port-forward",
            "-n", &namespace,
            "svc/argocd-server",
            &port_mapping,
        ])
        .stderr(Stdio::piped()) // Capture stderr to check for errors
        .spawn()
        .map_err(|e| format!("Failed to start port-forward: {}", e))?;

    // Wait for port-forward to bind to the local port; if it never binds, surface an error
    const BIND_RETRIES: u8 = 15;
    for attempt in 1..=BIND_RETRIES {
        if !is_port_available(ARGOCD_LOCAL_PORT) {
            break;
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                // Process exited early; capture stderr for diagnostics
                let stderr = match child.wait_with_output() {
                    Ok(output) => String::from_utf8_lossy(&output.stderr).to_string(),
                    Err(e) => format!("(failed to read stderr: {})", e),
                };
                return Err(format!(
                    "Port-forward failed (exit {}): {}",
                    status,
                    stderr.trim()
                ));
            }
            Ok(None) => {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(e) => {
                return Err(format!("Failed to check port-forward status: {}", e));
            }
        }

        if attempt == BIND_RETRIES && is_port_available(ARGOCD_LOCAL_PORT) {
            let _ = child.kill();
            return Err(format!(
                "Port-forward did not bind to localhost:{} after {} attempts",
                ARGOCD_LOCAL_PORT, BIND_RETRIES
            ));
        }
    }

    // Store the child process
    {
        let mut guard = ARGOCD_PORT_FORWARD.lock().unwrap();
        *guard = Some(child);
    }

    Ok(format!("Port-forward started on localhost:{}", ARGOCD_LOCAL_PORT))
}

/// Stop ArgoCD port-forward
#[tauri::command]
pub async fn stop_argocd_port_forward() -> Result<String, String> {
    // Stop the tracked process
    {
        let mut guard = ARGOCD_PORT_FORWARD.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait(); // Reap the zombie process
        }
    }

    // Also cleanup any orphaned processes (defensive)
    cleanup_stale_port_forwards();

    Ok("Port-forward stopped".to_string())
}

/// Check if ArgoCD exists in the cluster
#[tauri::command]
pub async fn check_argocd_exists(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let client = create_client(state).await?;
    Ok(find_argocd_namespace(&client).await.is_some())
}

/// Open ArgoCD in an embedded webview within the main window
/// Reuses existing webview if available to preserve login state
#[tauri::command]
pub async fn open_argocd_webview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    use tauri::Manager;
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    // Frontend sends CSS pixel coordinates (logical units); convert once for reuse on resize
    let logical_size = tauri::Size::Logical(tauri::LogicalSize { width, height });

    // Compute absolute screen position so the child webview lines up with the content area
    let main_window = app.get_webview_window("main")
        .or_else(|| app.get_webview_window("opspilot")) // Try fallback name just in case
        .ok_or("Failed to find main window for parenting")?;
    let scale = main_window.scale_factor().unwrap_or(1.0);
    let inner_pos = main_window
        .inner_position()
        .map(|p| p.to_logical::<f64>(scale))
        .unwrap_or(tauri::LogicalPosition { x: 0.0, y: 0.0 });
    let abs_x = inner_pos.x + x;
    let abs_y = inner_pos.y + y;
    let logical_position = tauri::Position::Logical(tauri::LogicalPosition { x: abs_x, y: abs_y });
    println!(
        "[argocd] Positioning webview: rel=({}, {}) size=({}, {}), inner_pos=({}, {}), abs=({}, {}), scale={}",
        x, y, width, height, inner_pos.x, inner_pos.y, abs_x, abs_y, scale
    );

    // Make sure port-forward is running
    start_argocd_port_forward(state.clone()).await?;

    // Check if argocd webview already exists - reuse it to preserve login state
    if let Some(existing) = app.get_webview_window("argocd-embedded") {
        // Reposition and resize the existing webview
        // START FIX: Use LogicalPosition/LogicalSize instead of Physical
        // The frontend sends CSS pixels (getBoundingClientRect), which correspond to Logical types in Tauri
        // Physical types multiply by scale factor again, causing double-scaling or incorrect offsets on Retina/High-DPI
        let _ = existing.set_position(logical_position);
        let _ = existing.set_size(logical_size);

        // Show the hidden webview
        existing.show().map_err(|e| format!("Failed to show webview: {}", e))?;
        existing.set_focus().map_err(|e| format!("Failed to focus webview: {}", e))?;

        return Ok("ArgoCD webview restored (session preserved)".to_string());
    }

    // Get server info for URL
    let info = get_argocd_server_info(state).await?;

    // Create the webview URL
    let url = info.url.parse::<tauri::Url>().map_err(|e| format!("Invalid URL: {}", e))?;

    // Login automation script
    // We use a React-compatible input setter to ensure the state updates
    let init_script = format!(
        r#"
        const ATTEMPT_DURATION_MS = 15000;
        const START_TIME = Date.now();

        function log(msg) {{
            console.log(`[OpPilot AutoLogin] ${{msg}}`);
        }}

        window.addEventListener('DOMContentLoaded', () => {{
            log("DOM Content Loaded - Starting Auto Login attempt");

            const checkAndLogin = () => {{
                // Stop if timed out
                if (Date.now() - START_TIME > ATTEMPT_DURATION_MS) {{
                    return false;
                }}

                try {{
                    // Selectors for ArgoCD login form
                    const usernameInput = document.querySelector('input[name="username"]') || document.querySelector('input[class*="login-username"]');
                    const passwordInput = document.querySelector('input[name="password"]') || document.querySelector('input[class*="login-password"]');
                    const loginButton = document.querySelector('button[type="submit"]') || document.querySelector('button[class*="login-button"]');

                    if (usernameInput && passwordInput && loginButton) {{
                        log("Found login fields");
                        
                        // Only autofill if empty (to avoid fighting with user)
                        if (usernameInput.value === "") {{
                            log("Filling credentials...");
                            
                            // React 16+ hack to trigger onChange by calling native value setter
                            // granular error handling for setter discovery
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                            
                            if (nativeInputValueSetter) {{
                                nativeInputValueSetter.call(usernameInput, "{}");
                                usernameInput.dispatchEvent(new Event('input', {{ bubbles: true }}));

                                nativeInputValueSetter.call(passwordInput, "{}");
                                passwordInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            }} else {{
                                // Fallback
                                usernameInput.value = "{}";
                                passwordInput.value = "{}";
                            }}

                            log("Credentials filled, submitting in 500ms...");
                            setTimeout(() => {{
                                loginButton.click();
                                log("Login button clicked");
                            }}, 500);
                            return true;
                        }}
                    }}
                }} catch (e) {{
                    log(`Error during auto-login: ${{e}}`);
                }}
                return false;
            }};

            // Try immediately and then retry periodically
            if (!checkAndLogin()) {{
                const interval = setInterval(() => {{
                    if (checkAndLogin() || (Date.now() - START_TIME > ATTEMPT_DURATION_MS)) {{
                        clearInterval(interval);
                    }}
                }}, 800);
            }}
        }});
        "#,
        info.username, info.password, info.username, info.password
    );

    // Build a new webview window positioned at the specified location
    // This creates a child window that appears embedded
    let _webview = WebviewWindowBuilder::new(
        &app,
        "argocd-embedded",
        WebviewUrl::External(url),
    )
    .title("ArgoCD")
    .inner_size(width, height)
    .position(abs_x, abs_y)
    .decorations(false) // No title bar - makes it look embedded
    .always_on_top(false)
    .resizable(true)
    .parent(&main_window).map_err(|e| format!("Failed to parent window: {}", e))? // Parent to main window so it moves with the app
    .initialization_script(&init_script) // Inject auto-login script
    .build()
    .map_err(|e| format!("Failed to create webview: {}", e))?;

    Ok("ArgoCD webview opened".to_string())
}

/// Close the embedded ArgoCD webview
#[tauri::command]
pub async fn close_argocd_webview(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    if let Some(webview) = app.get_webview_window("argocd-embedded") {
        // Hide instead of close to preserve login state
        webview.hide().map_err(|e| format!("Failed to hide webview: {}", e))?;
        Ok("ArgoCD webview hidden".to_string())
    } else {
        Ok("No ArgoCD webview found".to_string())
    }
}

/// Force close the ArgoCD webview (when context changes)
#[tauri::command]
pub async fn force_close_argocd_webview(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    if let Some(webview) = app.get_webview_window("argocd-embedded") {
        webview.close().map_err(|e| format!("Failed to close webview: {}", e))?;
        Ok("ArgoCD webview closed".to_string())
    } else {
        Ok("No ArgoCD webview found".to_string())
    }
}

/// Check if ArgoCD webview exists and is visible
#[tauri::command]
pub async fn is_argocd_webview_active(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::Manager;

    if let Some(webview) = app.get_webview_window("argocd-embedded") {
        Ok(webview.is_visible().unwrap_or(false))
    } else {
        Ok(false)
    }
}

/// Update the bounds of the embedded ArgoCD webview (lightweight resize)
#[tauri::command]
pub async fn update_argocd_webview_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::Manager;

    if let Some(webview) = app.get_webview_window("argocd-embedded") {
        // Compute absolute screen position
        // We reuse the main window logic to handle multi-monitor or offset scenarios
         let main_window = app.get_webview_window("main")
            .or_else(|| app.get_webview_window("opspilot"))
            .ok_or("Failed to find main window")?;
        
        let scale = main_window.scale_factor().unwrap_or(1.0);
        let inner_pos = main_window
            .inner_position()
            .map(|p| p.to_logical::<f64>(scale))
            .unwrap_or(tauri::LogicalPosition { x: 0.0, y: 0.0 });
            
        let abs_x = inner_pos.x + x;
        let abs_y = inner_pos.y + y;

        let logical_position = tauri::Position::Logical(tauri::LogicalPosition { x: abs_x, y: abs_y });
        let logical_size = tauri::Size::Logical(tauri::LogicalSize { width, height });

        let _ = webview.set_position(logical_position);
        let _ = webview.set_size(logical_size);
        
        Ok(())
    } else {
        Ok(())
    }
}
