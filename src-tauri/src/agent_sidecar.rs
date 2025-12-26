//! LangGraph Agent Sidecar Management
//!
//! This module manages the Python LangGraph agent server that runs as a sidecar process.
//! The sidecar is started automatically when the app launches and stopped on exit.

use log::{info, warn, error};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use std::process::Command;

/// State for managing the agent sidecar process
pub struct AgentSidecarState {
    child: Arc<Mutex<Option<CommandChild>>>,
}

impl AgentSidecarState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for AgentSidecarState {
    fn default() -> Self {
        Self::new()
    }
}

/// Response from the agent health endpoint
#[derive(serde::Deserialize)]
struct HealthResponse {
    #[allow(dead_code)]
    status: String,
    version: Option<String>,
}

/// Poll the agent's health endpoint until it responds OK or retries are exhausted
async fn wait_for_agent_ready_with_retries(
    url: &str,
    attempts: u32,
    delay: Duration,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))  // 2 second timeout to handle busy server
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    for attempt in 1..=attempts {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => {
                warn!(
                    "[agent-sidecar] Health check attempt {} failed: {} {}",
                    attempt,
                    resp.status(),
                    resp.text().await.unwrap_or_default()
                );
            }
            Err(err) => {
                warn!("[agent-sidecar] Health check attempt {} errored: {}", attempt, err);
            }
        }

        if attempt != attempts {
            tokio::time::sleep(delay).await;
        }
    }

    Err(format!(
        "Agent did not become ready after {} attempts at {}",
        attempts, url
    ))
}

/// Get the version of the running agent server, if available
async fn get_agent_version() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;

    let resp = client.get("http://127.0.0.1:8765/health").send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }

    let health: HealthResponse = resp.json().await.ok()?;
    health.version
}

async fn wait_for_agent_ready(url: &str) -> Result<(), String> {
    wait_for_agent_ready_with_retries(url, 10, Duration::from_millis(300)).await
}

/// Attempt to start the agent sidecar with retries/backoff to avoid transient launch failures
async fn start_agent_sidecar_with_retry(app: &tauri::AppHandle) -> Result<(), String> {
    const MAX_ATTEMPTS: u8 = 3;
    const BACKOFF: Duration = Duration::from_millis(800);

    for attempt in 1..=MAX_ATTEMPTS {
        match start_agent_sidecar(app).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                warn!("[agent-sidecar] Attempt {}/{} failed: {}", attempt, MAX_ATTEMPTS, e);
                if attempt == MAX_ATTEMPTS {
                    return Err(e);
                }
                tokio::time::sleep(BACKOFF * attempt as u32).await;
            }
        }
    }

    Err("Agent failed to start after retries".to_string())
}

/// Kill any process listening on the specified port (cross-platform)
fn kill_process_on_port(port: u16) {
    info!("[agent-sidecar] Checking for processes on port {}...", port);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // On Windows, use netstat to find PIDs and taskkill to terminate
        let output = match Command::new("netstat")
            .args(&["-ano"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(out) => out,
            Err(_) => return,
        };

        if !output.status.success() {
            return;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let port_pattern = format!(":{}", port);

        for line in stdout.lines() {
            if line.contains(&port_pattern) && line.contains("LISTENING") {
                // Parse PID from last column
                if let Some(pid) = line.split_whitespace().last() {
                    if let Ok(_pid_num) = pid.parse::<u32>() {
                        info!("[agent-sidecar] Killing process {} on port {}", pid, port);
                        let _ = Command::new("taskkill")
                            .args(&["/F", "/PID", pid])
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On Unix, use lsof to find the PID
        // -t: terse mode (PID only)
        // -i: select internet address
        let output = match Command::new("lsof")
            .args(&["-t", "-i", &format!(":{}", port)])
            .output()
        {
            Ok(out) => out,
            Err(_) => {
                // lsof might not be available or fail, just ignore
                return;
            }
        };

        if !output.status.success() {
            return;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Ok(pid) = line.trim().parse::<i32>() {
                info!("[agent-sidecar] Killing process {} on port {}", pid, port);
                let _ = Command::new("kill")
                    .args(&["-9", &pid.to_string()])
                    .output();
            }
        }
    }
}

/// Check if a port is in use (cross-platform)
fn is_port_in_use(port: u16) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let output = Command::new("netstat")
            .args(&["-ano"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(out) = output {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let port_pattern = format!(":{}", port);
                return stdout.lines().any(|line| {
                    line.contains(&port_pattern) && line.contains("LISTENING")
                });
            }
        }
        false
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("lsof")
            .args(&["-t", "-i", &format!(":{}", port)])
            .output();

        output
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false)
    }
}

/// Start the agent sidecar process
pub async fn start_agent_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AgentSidecarState>();
    let mut child_guard = state.child.lock().await;

    // Get the current app version
    let app_version = app.package_info().version.to_string();

    // Check if already running (we have a tracked child process)
    if child_guard.is_some() {
        // Verify the tracked process is actually healthy before returning early
        // Drop lock temporarily to do health check
        drop(child_guard);
        if wait_for_agent_ready_with_retries("http://127.0.0.1:8765/health", 2, Duration::from_millis(500)).await.is_ok() {
            // Check if version matches
            if let Some(agent_version) = get_agent_version().await {
                if agent_version == app_version {
                    info!("[agent-sidecar] Already running and healthy (v{})", agent_version);
                    return Ok(());
                }
                warn!("[agent-sidecar] Version mismatch: agent={}, app={} - restarting", agent_version, app_version);
            } else {
                info!("[agent-sidecar] Already running and healthy");
                return Ok(());
            }
        }
        // Re-acquire lock - agent is tracked but unhealthy or wrong version, will restart
        child_guard = state.child.lock().await;
        if let Some(child) = child_guard.take() {
            info!("[agent-sidecar] Killing tracked process for restart");
            let _ = child.kill();
        }
    }

    // Check if port 8765 is in use (cross-platform)
    let port_in_use = is_port_in_use(8765);

    if port_in_use {
        // Something is listening on the port - check if it responds to health
        if wait_for_agent_ready_with_retries("http://127.0.0.1:8765/health", 3, Duration::from_millis(1000)).await.is_ok() {
            // Agent is healthy, check version
            if let Some(agent_version) = get_agent_version().await {
                if agent_version == app_version {
                    info!("[agent-sidecar] Found existing healthy agent on port 8765 with matching version (v{}), reusing it", agent_version);
                    return Ok(());
                }
                // Version mismatch - kill the old agent and start a new one
                warn!("[agent-sidecar] Version mismatch: running agent={}, app={} - killing old agent", agent_version, app_version);
                kill_process_on_port(8765);
                tokio::time::sleep(Duration::from_millis(500)).await;
            } else {
                // Can't determine version, reuse existing agent
                info!("[agent-sidecar] Found existing healthy agent on port 8765, reusing it");
                return Ok(());
            }
        } else {
            // Process is on port but not responding to health - it's stuck/crashed
            // Kill it so we can start a fresh one
            warn!("[agent-sidecar] Found unresponsive process on port 8765, killing it...");
            kill_process_on_port(8765);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    info!("[agent-sidecar] Starting LangGraph agent server...");

    // Get the sidecar command
    let sidecar = app.shell().sidecar("agent-server")
        .map_err(|e| format!("Failed to get sidecar: {}. Is the agent binary packaged for this platform?", e))?;

    // Determine writable path for ChromaDB
    let chroma_path = app.path().app_data_dir()
        .map(|p| p.join("chroma_db"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./chroma_db"));
    
    // Ensure the directory exists
    if let Err(e) = std::fs::create_dir_all(&chroma_path) {
        error!("[agent-sidecar] Failed to create ChromaDB dir: {}", e);
    }
    
    let chroma_path_str = chroma_path.to_string_lossy().to_string();
    info!("[agent-sidecar] Using ChromaDB path: {}", chroma_path_str);

    // Determine KB path from bundled resources
    let kb_path = app.path().resource_dir()
        .map(|p| p.join("knowledge"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./knowledge"));
    let kb_path_str = kb_path.to_string_lossy().to_string();
    info!("[agent-sidecar] Using KB path: {}", kb_path_str);

    // Spawn with environment
    // Note: tauri_plugin_shell::Command is immutable, we must chain calls
    let (mut rx, child) = sidecar
        .env("CHROMADB_PERSIST_DIR", &chroma_path_str)
        .env("K8S_AGENT_KB_DIR", &kb_path_str)
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Store the child process
    *child_guard = Some(child);

    // Spawn a task to handle sidecar output
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    info!("[agent-sidecar] {}", line_str);
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    warn!("[agent-sidecar] ERR: {}", line_str);
                }
                CommandEvent::Error(err) => {
                    error!("[agent-sidecar] Error: {}", err);
                }
                CommandEvent::Terminated(payload) => {
                    info!("[agent-sidecar] Terminated with code: {:?}", payload.code);
                    // Clear the child reference
                    if let Some(state) = app_handle.try_state::<AgentSidecarState>() {
                        let mut guard = state.child.lock().await;
                        *guard = None;
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Drop lock before awaiting health checks
    drop(child_guard);

    // Wait for health
    if let Err(e) = wait_for_agent_ready("http://127.0.0.1:8765/health").await {
        error!("[agent-sidecar] Health check failed: {}", e);
        if let Some(state) = app.try_state::<AgentSidecarState>() {
            let mut guard = state.child.lock().await;
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
        return Err(e);
    }

    info!("[agent-sidecar] Started successfully on http://127.0.0.1:8765");
    Ok(())
}

/// Stop the agent sidecar process
pub async fn stop_agent_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AgentSidecarState>();
    let mut child_guard = state.child.lock().await;

    if let Some(child) = child_guard.take() {
        info!("[agent-sidecar] Stopping...");
        child.kill().map_err(|e| format!("Failed to kill sidecar: {}", e))?;
        info!("[agent-sidecar] Stopped");
    }

    Ok(())
}
/// Tauri commands for sidecar management

#[tauri::command]
pub async fn start_agent(app: tauri::AppHandle) -> Result<(), String> {
    start_agent_sidecar(&app).await
}

#[tauri::command]
pub async fn stop_agent(app: tauri::AppHandle) -> Result<(), String> {
    stop_agent_sidecar(&app).await
}

#[tauri::command]
pub async fn check_agent_status(_app: tauri::AppHandle) -> Result<bool, String> {
    // Check the actual health endpoint directly - don't rely on tracked child process
    // because we may be reusing an existing healthy agent from a previous app instance
    // Use 3 attempts to handle momentary busy states
    match wait_for_agent_ready_with_retries("http://127.0.0.1:8765/health", 3, Duration::from_millis(1000)).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Background supervisor: periodically ensure the agent is healthy; restart if needed
pub async fn supervise_agent(app: tauri::AppHandle) {
    // Wait for initial startup to complete before starting supervision loop
    // This prevents racing with the initial start_agent_sidecar call
    tokio::time::sleep(Duration::from_secs(30)).await;

    let mut consecutive_failures = 0;
    const MAX_FAILURES_BEFORE_RESTART: u8 = 6;  // 6 failures × 10 sec = 60 seconds of unresponsiveness

    loop {
        // If already healthy, wait and recheck later
        match check_agent_status(app.clone()).await {
            Ok(true) => {
                consecutive_failures = 0;
                tokio::time::sleep(Duration::from_secs(15)).await;
                continue;
            }
            Ok(false) | Err(_) => {
                consecutive_failures += 1;
                // Only log every few failures to avoid spam
                if consecutive_failures == 1 || consecutive_failures >= MAX_FAILURES_BEFORE_RESTART {
                    warn!("[agent-sidecar] Agent health check failed ({}/{})",
                        consecutive_failures, MAX_FAILURES_BEFORE_RESTART);
                }

                // Only restart after multiple consecutive failures
                // This prevents killing the agent during long operations (Claude CLI can take 30+ seconds)
                if consecutive_failures >= MAX_FAILURES_BEFORE_RESTART {
                    warn!("[agent-sidecar] Agent unhealthy after {} consecutive checks (~60s), attempting restart",
                        consecutive_failures);
                    if let Err(e) = start_agent_sidecar_with_retry(&app).await {
                        error!("[agent-sidecar] Supervisor failed to restart agent: {}", e);
                    }
                    consecutive_failures = 0;
                }
            }
        }

        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::wait_for_agent_ready_with_retries;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn start_dummy_health_server() -> Option<(u16, tokio::task::JoinHandle<()>)> {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(e) => {
                // CI or sandbox might block binding; skip test in that case
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    return None;
                }
                panic!("failed to bind dummy server: {}", e);
            }
        };
        let port = listener.local_addr().unwrap().port();

        let handle = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((mut socket, _)) => {
                        let mut buf = [0u8; 1024];
                        let _ = socket.read(&mut buf).await;
                        let _ = socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length:2\r\n\r\nOK")
                            .await;
                    }
                    Err(_) => break,
                }
            }
        });

        Some((port, handle))
    }

    #[tokio::test]
    async fn wait_for_agent_ready_succeeds() {
        let Some((port, handle)) = start_dummy_health_server().await else {
            // Environment blocked socket bind; skip
            return;
        };
        let url = format!("http://127.0.0.1:{}/health", port);

        let result = wait_for_agent_ready_with_retries(&url, 3, Duration::from_millis(50)).await;
        assert!(result.is_ok(), "expected health check to succeed");

        handle.abort();
    }

    #[tokio::test]
    async fn wait_for_agent_ready_times_out() {
        // Bind and drop to get an unused port (no server running)
        let port = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => {
                let p = l.local_addr().unwrap().port();
                drop(l);
                p
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    return; // skip in restricted envs
                }
                panic!("failed to bind port: {}", e);
            }
        };

        let url = format!("http://127.0.0.1:{}/health", port);
        let result = wait_for_agent_ready_with_retries(&url, 3, Duration::from_millis(50)).await;
        assert!(result.is_err(), "expected health check to fail");
    }
}
