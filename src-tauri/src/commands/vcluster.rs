use log::{info, warn, error};
use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{Emitter, State};
use crate::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct VCluster {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub created: String,
    pub context: Option<String>,
}

/// Detailed error types for vcluster operations
#[derive(Debug, Clone, Serialize)]
pub struct VClusterError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
    pub suggestion: Option<String>,
}

impl VClusterError {
    fn not_installed() -> Self {
        Self {
            code: "VCLUSTER_NOT_INSTALLED".to_string(),
            message: "vcluster CLI is not installed".to_string(),
            details: None,
            suggestion: Some("Install vcluster CLI: curl -L -o vcluster https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-darwin-arm64 && chmod +x vcluster && sudo mv vcluster /usr/local/bin/".to_string()),
        }
    }



    #[allow(dead_code)]
    fn context_not_found(name: &str, namespace: &str) -> Self {
        Self {
            code: "CONTEXT_NOT_FOUND".to_string(),
            message: format!("vcluster context vcluster_{}_{} was not created", name, namespace),
            details: None,
            suggestion: Some("The vcluster may still be initializing. Wait a moment and try again.".to_string()),
        }
    }

    fn cluster_unreachable(details: &str) -> Self {
        Self {
            code: "CLUSTER_UNREACHABLE".to_string(),
            message: "vcluster connected but API server is unreachable".to_string(),
            details: Some(details.to_string()),
            suggestion: Some("The port-forward may have failed. Try: 1) Check if vcluster pod is running, 2) Kill stale connections: pkill -f 'vcluster connect', 3) Run vcluster connect manually".to_string()),
        }
    }

    fn vcluster_not_ready(name: &str, namespace: &str, status: &str) -> Self {
        Self {
            code: "VCLUSTER_NOT_READY".to_string(),
            message: format!("vcluster '{}' in '{}' is not ready", name, namespace),
            details: Some(format!("Current status: {}", status)),
            suggestion: Some("Wait for the vcluster to be in 'Running' state before connecting.".to_string()),
        }
    }

    fn command_failed(cmd: &str, stderr: &str) -> Self {
        Self {
            code: "COMMAND_FAILED".to_string(),
            message: format!("Command '{}' failed", cmd),
            details: Some(stderr.to_string()),
            suggestion: None,
        }
    }
}

impl std::fmt::Display for VClusterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", serde_json::to_string(self).unwrap_or_else(|_| self.message.clone()))
    }
}



#[tauri::command]
pub async fn list_vclusters() -> Result<Vec<VCluster>, String> {
    // Check if vcluster binary exists first
    let mut ver_cmd = Command::new("vcluster");
    ver_cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        ver_cmd.creation_flags(0x08000000);
    }
    match ver_cmd.output() {
        Ok(_) => {}, // Binary exists
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return Err("VCLUSTER_NOT_INSTALLED".to_string());
            }
            // For other errors, we try to proceed or just log? 
            // Better to fail if we can't even run version.
            return Err(format!("Failed to execute vcluster command: {}", e));
        }
    }

    // Run "vcluster list --output json"
    let mut cmd = Command::new("vcluster");
    cmd.args(["list", "--output", "json"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output()
        .map_err(|e| format!("Failed to execute vcluster command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // If vcluster is not found, return empty list instead of error
        if stderr.contains("not found") || stderr.contains("no such file") {
            return Ok(Vec::new());
        }
        return Err(format!("vcluster list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    let items: Vec<serde_json::Value> = serde_json::from_str(&stdout)
        .or_else(|_| {
             let obj: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
             if let Some(arr) = obj.get("items").and_then(|i| i.as_array()) {
                 Ok(arr.clone())
             } else {
                 Err("Invalid JSON format".to_string())
             }
        })
        .map_err(|e| format!("Failed to parse vcluster JSON: {}. Output: {}", e, stdout))?;

    let mut vclusters = Vec::new();
    for item in items {
        let name = item.get("Name").or(item.get("name")).and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        let namespace = item.get("Namespace").or(item.get("namespace")).and_then(|v| v.as_str()).unwrap_or("default").to_string();
        let status = item.get("Status").or(item.get("status")).and_then(|v| v.as_str()).unwrap_or("Unknown").to_string();
        let created = item.get("Created").or(item.get("created")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let context = item.get("Context").or(item.get("context")).and_then(|v| v.as_str()).map(|s| s.to_string());

        vclusters.push(VCluster {
            name,
            namespace,
            status,
            created,
            context
        });
    }

    Ok(vclusters)
}

#[derive(Debug, Clone, Serialize)]
pub struct VClusterConnectProgress {
    pub stage: String,
    pub message: String,
    pub progress: u8,  // 0-100
    pub is_error: bool,
    pub error_code: Option<String>,
    pub suggestion: Option<String>,
}

/// Helper to create a vcluster command with augmented PATH
fn create_vcluster_command() -> Command {
    let mut cmd = Command::new("vcluster");
    
    #[cfg(not(target_os = "windows"))]
    {
        // AUGMENT PATH: macOS apps don't inherit shell PATH, so we must inject common paths
        let current_path = std::env::var("PATH").unwrap_or_default();
        let extra_paths = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
        let new_path = if current_path.is_empty() {
            extra_paths.to_string()
        } else {
            format!("{}:{}", current_path, extra_paths)
        };
        cmd.env("PATH", new_path);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    
    cmd
}

/// Check if vcluster CLI is installed and return version
fn check_vcluster_installed() -> Result<String, VClusterError> {
    let mut cmd = create_vcluster_command();
    cmd.arg("--version");

    match cmd.output() {
        Ok(output) => {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                Ok(version)
            } else {
                Err(VClusterError::not_installed())
            }
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                Err(VClusterError::not_installed())
            } else {
                Err(VClusterError::command_failed("vcluster --version", &e.to_string()))
            }
        }
    }
}

/// Check if vcluster is in a ready state before attempting connection
fn check_vcluster_status(name: &str, namespace: &str) -> Result<String, VClusterError> {
    let mut cmd = create_vcluster_command();
    cmd.args(["list", "--output", "json"]);

    match cmd.output() {
        Ok(output) => {
            if !output.status.success() {
                return Ok("unknown".to_string()); // Can't check status, proceed anyway
            }

            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.trim().is_empty() {
                return Err(VClusterError {
                    code: "VCLUSTER_NOT_FOUND".to_string(),
                    message: format!("vcluster '{}' not found in namespace '{}'", name, namespace),
                    details: None,
                    suggestion: Some(format!("Check if the vcluster exists: vcluster list -n {}", namespace)),
                });
            }

            // Parse JSON to find the vcluster
            if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
                for item in items {
                    let item_name = item.get("Name").or(item.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                    let item_ns = item.get("Namespace").or(item.get("namespace")).and_then(|v| v.as_str()).unwrap_or("");

                    if item_name == name && item_ns == namespace {
                        let status = item.get("Status").or(item.get("status")).and_then(|v| v.as_str()).unwrap_or("unknown");
                        return Ok(status.to_string());
                    }
                }
            }

            Ok("unknown".to_string())
        }
        Err(_) => Ok("unknown".to_string()) // Can't check, proceed anyway
    }
}

/// Kill any stale vcluster processes
fn kill_stale_vcluster_processes() {
    let debug_log_path = std::env::temp_dir().join("vcluster-debug.log");
    
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "vcluster.exe"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Kill any vcluster connect processes
        // Use absolute path to ensure we find pkill
        let out1 = Command::new("/usr/bin/pkill")
            .args(["-f", "vcluster connect"])
            .output();

        // Also kill any port-forward processes related to vcluster
        let out2 = Command::new("/usr/bin/pkill")
            .args(["-f", "kubectl.*port-forward.*vcluster"])
            .output();

        // Log pkill results
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&debug_log_path) {
             use std::io::Write;
             let _ = writeln!(f, "\n--- KILLING STALE PROCESSES ---");
             if let Ok(o) = out1 {
                 let _ = writeln!(f, "pkill vcluster: {}", o.status);
             }
             if let Ok(o) = out2 {
                 let _ = writeln!(f, "pkill port-forward: {}", o.status);
             }
        }
    }
}

/// Disconnect from a specific vcluster
fn disconnect_existing_vcluster(name: &str, namespace: &str) -> bool {
    let mut cmd = create_vcluster_command();
    // vcluster disconnect does NOT accept arguments
    cmd.args(["disconnect"]);

    // Debug logging
    let debug_log_path = std::env::temp_dir().join("vcluster-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&debug_log_path) {
         use std::io::Write;
         let _ = writeln!(f, "\n--- ATTEMPTING DISCONNECT ---");
         let _ = writeln!(f, "Command: vcluster disconnect {} -n {}", name, namespace);
    }

    match cmd.output() {
        Ok(output) => {
             if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&debug_log_path) {
                 use std::io::Write;
                 let _ = writeln!(f, "Disconnect Status: {}", output.status);
                 let _ = writeln!(f, "Disconnect Stdout: {}", String::from_utf8_lossy(&output.stdout));
                 let _ = writeln!(f, "Disconnect Stderr: {}", String::from_utf8_lossy(&output.stderr));
             }
             output.status.success()
        },
        Err(e) => {
             if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&debug_log_path) {
                 use std::io::Write;
                 let _ = writeln!(f, "Disconnect Failed to execute: {}", e);
             }
             false
        }
    }
}

/// Wait for vcluster context to appear in kubeconfig
#[allow(dead_code)]
async fn wait_for_context(name: &str, namespace: &str, timeout_secs: u64) -> Option<String> {
    use tokio::time::sleep;
    use std::time::Duration;

    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(timeout_secs);
    let context_prefix = format!("vcluster_{}_{}", name, namespace);

    while start.elapsed() < timeout {
        let mut cmd = Command::new("kubectl");
        cmd.args(["config", "get-contexts", "-o", "name"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let contexts = String::from_utf8_lossy(&output.stdout);
                if let Some(ctx) = contexts.lines().find(|c| c.starts_with(&context_prefix)) {
                    return Some(ctx.to_string());
                }
            }
        }

        sleep(Duration::from_millis(500)).await;
    }

    None
}

/// Verify cluster is reachable with retries
#[allow(dead_code)]
async fn verify_cluster_connection(max_attempts: u32, delay_secs: u64) -> Result<(), String> {
    use tokio::time::sleep;
    use std::time::Duration;

    let mut last_error = String::new();

    for attempt in 1..=max_attempts {
        let mut cmd = Command::new("kubectl");
        cmd.args(["get", "ns", "--request-timeout=5s"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        match cmd.output() {
            Ok(output) => {
                if output.status.success() {
                    return Ok(());
                }
                last_error = String::from_utf8_lossy(&output.stderr).to_string();
            }
            Err(e) => {
                last_error = e.to_string();
            }
        }

        if attempt < max_attempts {
            sleep(Duration::from_secs(delay_secs)).await;
        }
    }

    Err(last_error)
}

#[tauri::command]
pub async fn connect_vcluster(name: String, namespace: String, state: State<'_, AppState>, app: tauri::AppHandle) -> Result<String, String> {
    use std::thread;
    use std::time::Duration;
    use tokio::time::sleep;

    // Helper to emit progress events
    let emit_progress = |stage: &str, message: &str, progress: u8, is_error: bool, error_code: Option<&str>, suggestion: Option<&str>| {
        let _ = app.emit("vcluster-connect-progress", VClusterConnectProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            progress,
            is_error,
            error_code: error_code.map(|s| s.to_string()),
            suggestion: suggestion.map(|s| s.to_string()),
        });
    };

    let emit_ok = |stage: &str, message: &str, progress: u8| {
        emit_progress(stage, message, progress, false, None, None);
    };

    let emit_err = |stage: &str, err: &VClusterError| {
        emit_progress(stage, &err.message, 0, true, Some(&err.code), err.suggestion.as_deref());
    };

    info!("[vcluster] Starting connection to {}/{}", namespace, name);

    // ========== Stage 0: Pre-flight checks ==========
    emit_ok("preflight", "Checking vcluster CLI...", 2);

    // Check vcluster is installed
    match check_vcluster_installed() {
        Ok(version) => {
            info!("[vcluster] CLI version: {}", version);
            emit_ok("preflight", &format!("vcluster CLI found: {}", version.lines().next().unwrap_or(&version)), 5);
        }
        Err(e) => {
            error!("[vcluster] CLI not installed: {:?}", e);
            emit_err("preflight", &e);
            return Err(e.to_string());
        }
    }

    // Check vcluster status
    emit_ok("preflight", "Checking vcluster status...", 8);
    match check_vcluster_status(&name, &namespace) {
        Ok(status) => {
            info!("[vcluster] Status: {}", status);
            if status.to_lowercase() != "running" && status != "unknown" {
                let err = VClusterError::vcluster_not_ready(&name, &namespace, &status);
                warn!("[vcluster] Not ready: {}", status);
                emit_err("preflight", &err);
                return Err(err.to_string());
            }
            emit_ok("preflight", &format!("vcluster status: {}", status), 10);
        }
        Err(e) => {
            warn!("[vcluster] Could not check status: {:?}", e);
            // Non-fatal, continue anyway
        }
    }

    // ========== Stage 1: Clean up existing connections ==========
    emit_ok("cleanup", "Cleaning up existing connections...", 12);
    info!("[vcluster] Stage 1: Cleaning up existing connections");

    // Kill stale processes first
    kill_stale_vcluster_processes();

    // Small delay for processes to die
    sleep(Duration::from_millis(300)).await;

    // Disconnect cleanly
    if disconnect_existing_vcluster(&name, &namespace) {
        info!("[vcluster] Disconnected from previous vcluster");
        emit_ok("cleanup", "Disconnected from previous vcluster", 15);
    }

    // NUCLEAR OPTION: Manually delete any stale context to force vcluster to reconnect
    // vcluster CLI might think it's "already connected" if the context exists, even if the process is dead.
    let context_prefix = format!("vcluster_{}_{}", name, namespace);
    let mut clean_cmd = Command::new("kubectl");
    clean_cmd.args(["config", "get-contexts", "-o", "name"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        clean_cmd.creation_flags(0x08000000);
    }
    
    if let Ok(output) = clean_cmd.output() {
        let contexts = String::from_utf8_lossy(&output.stdout);
        for ctx in contexts.lines() {
            if ctx.starts_with(&context_prefix) {
                // Delete this stale context
                let mut del_cmd = Command::new("kubectl");
                del_cmd.args(["config", "delete-context", ctx]);
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    del_cmd.creation_flags(0x08000000);
                }
                let _ = del_cmd.output();
                
                // Log it
                let debug_log_path = std::env::temp_dir().join("vcluster-debug.log");
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&debug_log_path) {
                    use std::io::Write;
                    let _ = writeln!(f, "Deleted stale context: {}", ctx);
                }
            }
        }
    }

    // Let context settle
    sleep(Duration::from_millis(500)).await;

    // ========== Stage 2: Start vcluster connect process ==========
    emit_ok("connect", &format!("Starting connection to {}...", name), 20);
    info!("[vcluster] Stage 2: Starting vcluster connect for {}/{}", namespace, name);

    let vcluster_name = name.clone();
    let vcluster_ns = namespace.clone();
    let pid_store = state.vcluster_pid.clone();

    // Spawn the vcluster connect command in a separate thread
    let connect_handle = thread::spawn(move || {
        use std::fs::File;
        use std::process::Stdio;

        let temp_dir = std::env::temp_dir();
        let stdout_path = temp_dir.join("vcluster-connect.out");
        let stderr_path = temp_dir.join("vcluster-connect.err");

        // Clear previous log files
        let _ = std::fs::remove_file(&stdout_path);
        let _ = std::fs::remove_file(&stderr_path);

        let stdout_file = File::create(&stdout_path).unwrap_or_else(|_| {
            #[cfg(target_os = "windows")]
            { File::create("NUL").unwrap() }
            #[cfg(not(target_os = "windows"))]
            { File::create("/dev/null").unwrap() }
        });
        let stderr_file = File::create(&stderr_path).unwrap_or_else(|_| {
            #[cfg(target_os = "windows")]
            { File::create("NUL").unwrap() }
            #[cfg(not(target_os = "windows"))]
            { File::create("/dev/null").unwrap() }
        });

        // AUGMENT PATH: macOS apps don't inherit shell PATH, so we must inject common paths
        let current_path = std::env::var("PATH").unwrap_or_default();
        let new_path = if cfg!(target_os = "windows") {
             current_path.clone()
        } else {
             // Basic paths often missing in macOS .app bundles
             let extra_paths = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
             if current_path.is_empty() {
                 extra_paths.to_string()
             } else {
                 format!("{}:{}", current_path, extra_paths)
             }
        };

        // Log diagnostics to specific file for debugging
        let debug_log_path = temp_dir.join("vcluster-debug.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&debug_log_path) {
             use std::io::Write;
             let _ = writeln!(f, "\n--- SPAWNING CONNECT PROCESS ---");
             let _ = writeln!(f, "User PATH: {}", current_path);
             let _ = writeln!(f, "Augmented PATH: {}", new_path);
        }

        let mut connect_cmd = Command::new("vcluster");
        connect_cmd.args(["connect", &vcluster_name, "-n", &vcluster_ns, "--background-proxy=false", "--address", "127.0.0.1"])
            .env("PATH", &new_path)
            .stdin(Stdio::null())
            .stdout(stdout_file)
            .stderr(stderr_file);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            connect_cmd.creation_flags(0x08000000);
        }

        match connect_cmd.spawn() {
            Ok(child) => {
                let pid = child.id();
                if let Ok(mut pid_guard) = pid_store.lock() {
                    *pid_guard = Some(pid);
                }
                info!("[vcluster] Connect process started with PID: {}", pid);

                // Don't wait for the process - it runs continuously
                // The process will be managed by the OS
                Some(pid)
            }
            Err(e) => {
                error!("[vcluster] Failed to spawn vcluster connect: {}", e);
                None
            }
        }
    });

    // Wait a moment for the process to start
    sleep(Duration::from_millis(500)).await;

    // Check if spawn succeeded
    match connect_handle.join() {
        Ok(Some(pid)) => {
            emit_ok("connect", &format!("Connection process started (PID: {})", pid), 30);
        }
        Ok(None) | Err(_) => {
            let err_path = std::env::temp_dir().join("vcluster-connect.err");
            let err_log = std::fs::read_to_string(&err_path).unwrap_or_default();
            let err = VClusterError::command_failed("vcluster connect", &err_log);
            emit_err("connect", &err);
            return Err(err.to_string());
        }
    }

    // ========== Stage 3: Wait for context to appear ==========
    emit_ok("context", "Waiting for vcluster context...", 35);
    info!("[vcluster] Stage 3: Waiting for vcluster context");

    let context_timeout = 30; // seconds
    let mut found_context = String::new();
    let start = std::time::Instant::now();

    // Poll for context with progress updates
    loop {
        let elapsed = start.elapsed().as_secs();
        if elapsed >= context_timeout {
            break;
        }

        // Update progress (35 -> 70 over 30 seconds)
        let progress = 35 + ((elapsed as u8 * 35) / context_timeout as u8).min(35);
        emit_ok("context", &format!("Waiting for context... ({}/{}s)", elapsed, context_timeout), progress);

        // Check for context
        let mut cmd = Command::new("kubectl");
        cmd.args(["config", "get-contexts", "-o", "name"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let contexts = String::from_utf8_lossy(&output.stdout);
                let context_prefix = format!("vcluster_{}_{}", name, namespace);

                if let Some(ctx) = contexts.lines().find(|c| c.starts_with(&context_prefix)) {
                    found_context = ctx.to_string();
                    info!("[vcluster] Found context: {}", found_context);
                    break;
                }
            }
        }

        sleep(Duration::from_millis(500)).await;
    }

    if found_context.is_empty() {
        // Read error log for details
        let err_path = std::env::temp_dir().join("vcluster-connect.err");
        let err_log = std::fs::read_to_string(&err_path).unwrap_or_default();
        
        // Also read debug log
        let debug_log_path = std::env::temp_dir().join("vcluster-debug.log");
        let debug_log = std::fs::read_to_string(&debug_log_path).unwrap_or_default();

        let full_details = format!("Last stderr:\n{}\n\nDebug Info:\n{}", err_log.trim(), debug_log.trim());

        let err = if err_log.contains("not found") || err_log.contains("does not exist") {
            VClusterError {
                code: "VCLUSTER_NOT_FOUND".to_string(),
                message: format!("vcluster '{}' not found in namespace '{}'", name, namespace),
                details: Some(full_details),
                suggestion: Some(format!("Verify the vcluster exists: kubectl get pods -n {} | grep {}", namespace, name)),
            }
        } else if err_log.contains("permission denied") || err_log.contains("forbidden") {
            VClusterError {
                code: "PERMISSION_DENIED".to_string(),
                message: "Permission denied to access vcluster".to_string(),
                details: Some(full_details),
                suggestion: Some("Check your RBAC permissions for accessing the vcluster namespace.".to_string()),
            }
        } else {
            VClusterError {
                code: "CONNECT_TIMEOUT".to_string(),
                message: "Timed out waiting for vcluster connection".to_string(),
                details: Some(full_details),
                suggestion: Some("Check if vcluster is already connected in another terminal or if binaries are missing from PATH.".to_string()),
            }
        };

        error!("[vcluster] Context not found after timeout: {:?}", err);
        emit_err("context", &err);
        return Err(err.to_string());
    }

    emit_ok("context", &format!("Found context: {}", found_context), 75);

    // ========== Stage 4: Switch to vcluster context ==========
    emit_ok("switch", "Switching to vcluster context...", 78);
    info!("[vcluster] Stage 4: Switching to context: {}", found_context);

    let mut switch_cmd = Command::new("kubectl");
    switch_cmd.args(["config", "use-context", &found_context]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        switch_cmd.creation_flags(0x08000000);
    }

    match switch_cmd.output() {
        Ok(output) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let err = VClusterError::command_failed("kubectl config use-context", &stderr);
                emit_err("switch", &err);
                return Err(err.to_string());
            }
            emit_ok("switch", "Context switched successfully", 82);
        }
        Err(e) => {
            let err = VClusterError::command_failed("kubectl config use-context", &e.to_string());
            emit_err("switch", &err);
            return Err(err.to_string());
        }
    }

    // ========== Stage 5: Verify cluster connection ==========
    emit_ok("verify", "Verifying cluster connection...", 85);
    info!("[vcluster] Stage 5: Verifying cluster connection");

    let max_verify_attempts = 8;
    let verify_delay = 2;

    for attempt in 1..=max_verify_attempts {
        emit_ok("verify", &format!("Verifying connection (attempt {}/{})", attempt, max_verify_attempts), 85 + (attempt as u8 * 2).min(10));

        let mut verify_cmd = Command::new("kubectl");
        verify_cmd.args(["get", "ns", "--request-timeout=5s"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            verify_cmd.creation_flags(0x08000000);
        }

        match verify_cmd.output() {
            Ok(output) => {
                if output.status.success() {
                    info!("[vcluster] Connection verified on attempt {}", attempt);
                    emit_ok("verify", "Cluster connection verified!", 95);
                    break;
                }

                if attempt == max_verify_attempts {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let err = VClusterError::cluster_unreachable(&stderr);
                    error!("[vcluster] Verification failed after {} attempts", max_verify_attempts);
                    emit_err("verify", &err);
                    return Err(err.to_string());
                }
            }
            Err(e) => {
                if attempt == max_verify_attempts {
                    let err = VClusterError::cluster_unreachable(&e.to_string());
                    emit_err("verify", &err);
                    return Err(err.to_string());
                }
            }
        }

        warn!("[vcluster] Verification attempt {} failed, retrying in {}s...", attempt, verify_delay);
        sleep(Duration::from_secs(verify_delay)).await;
    }

    // ========== Stage 6: Finalize and clear caches ==========
    emit_ok("finalize", "Finalizing connection...", 97);
    info!("[vcluster] Stage 6: Clearing caches");

    // Clear all caches
    if let Ok(mut cache) = state.discovery_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.vcluster_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.pod_limits_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.initial_data_cache.try_lock() { *cache = None; }

    // Update selected context
    if let Ok(mut ctx) = state.selected_context.lock() {
        *ctx = Some(found_context.clone());
    }

    emit_ok("complete", &format!("Connected to vcluster '{}'", name), 100);
    info!("[vcluster] Successfully connected to vcluster {}/{}", namespace, name);

    Ok(format!("Connected to vcluster {} in namespace {}", name, namespace))
}

#[tauri::command]
pub async fn disconnect_vcluster(state: State<'_, AppState>) -> Result<String, String> {
    // Run "vcluster disconnect" with timeout
    let output_result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new("vcluster").args(["disconnect"]).output()
    ).await;

    let output = match output_result {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("Failed to execute vcluster command: {}", e)),
        Err(_) => return Err("vcluster disconnect timed out".to_string()),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to disconnect: {}", stderr));
    }

    // After disconnect, vcluster CLI switches context back to the host.
    // We need to verify what the current context is now.
    let context_output = Command::new("kubectl")
        .args(["config", "current-context"])
        .output()
        .map_err(|e| format!("Failed to get current context: {}", e))?;

    if context_output.status.success() {
         let new_context = String::from_utf8_lossy(&context_output.stdout).trim().to_string();
         
         // Update state with the restored context
         if let Ok(mut ctx) = state.selected_context.lock() {
             *ctx = Some(new_context.clone());
         }

         // Clear all caches to ensure UI refreshes correctly
         if let Ok(mut cache) = state.discovery_cache.try_lock() { *cache = None; }
         if let Ok(mut cache) = state.cluster_stats_cache.try_lock() { *cache = None; }
         if let Ok(mut cache) = state.vcluster_cache.try_lock() { *cache = None; }
         if let Ok(mut cache) = state.pod_limits_cache.try_lock() { *cache = None; }
         if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; }
         if let Ok(mut cache) = state.initial_data_cache.try_lock() { *cache = None; }

         return Ok(format!("Disconnected. Switched to context: {}", new_context));
    }

    Ok("Disconnected from vcluster".to_string())
}
