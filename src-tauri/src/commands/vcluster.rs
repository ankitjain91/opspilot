use log::info;
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



#[tauri::command]
pub async fn list_vclusters() -> Result<Vec<VCluster>, String> {
    // Check if vcluster binary exists first
    match Command::new("vcluster").arg("--version").output() {
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
    let output = Command::new("vcluster")
        .args(["list", "--output", "json"])
        .output()
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
}

#[tauri::command]
pub async fn connect_vcluster(name: String, namespace: String, state: State<'_, AppState>, app: tauri::AppHandle) -> Result<String, String> {
    use std::thread;
    use std::time::Duration;
    use tokio::time::sleep;

    // Helper to emit progress events
    let emit_progress = |stage: &str, message: &str, progress: u8| {
        let _ = app.emit("vcluster-connect-progress", VClusterConnectProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            progress,
        });
    };

    // Stage 1: Disconnect any existing vcluster connection first
    emit_progress("disconnect", "Disconnecting any existing vcluster...", 5);
    info!("[vcluster] Stage 1: Disconnecting any existing vcluster connection");

    // Kill any stale vcluster connect processes (cross-platform)
    #[cfg(target_os = "windows")]
    {
        // On Windows, use taskkill to kill vcluster processes
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "vcluster.exe"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("pkill")
            .args(["-f", "vcluster connect"])
            .output();
    }

    // Run vcluster disconnect (ignore errors if not connected)
    let disconnect_output = Command::new("vcluster")
        .args(["disconnect"])
        .output();

    if let Ok(output) = disconnect_output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            info!("[vcluster] Disconnected: {}", stdout.trim());
            emit_progress("disconnect", "Disconnected from previous vcluster", 10);
        }
    }

    // Small delay to let the context settle
    sleep(Duration::from_millis(500)).await;

    // Stage 2: Start vcluster connect
    emit_progress("connect", &format!("Connecting to vcluster {} in {}...", name, namespace), 15);
    info!("[vcluster] Stage 2: Starting vcluster connect for {}/{}", namespace, name);

    let vcluster_name = name.clone();
    let vcluster_ns = namespace.clone();
    let pid_store = state.vcluster_pid.clone();

    // Spawn the vcluster connect command in a separate thread
    thread::spawn(move || {
        use std::fs::File;
        use std::process::Stdio;

        // Get cross-platform temp directory for log files
        let temp_dir = std::env::temp_dir();
        let stdout_path = temp_dir.join("vcluster-connect.out");
        let stderr_path = temp_dir.join("vcluster-connect.err");

        // Redirect output to log files for debugging
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

        // Use --background-proxy=false to run in foreground so we can manage the process
        if let Ok(mut child) = Command::new("vcluster")
            .args(["connect", &vcluster_name, "-n", &vcluster_ns, "--background-proxy=false"])
            .stdin(Stdio::null())
            .stdout(stdout_file)
            .stderr(stderr_file)
            .spawn()
        {
            if let Ok(mut pid_guard) = pid_store.lock() {
                *pid_guard = Some(child.id());
            }

            log::info!("[vcluster] Connect process started with PID: {}", child.id());

            match child.wait() {
                Ok(status) => {
                    log::info!("[vcluster] Connect process exited with status: {}", status);
                },
                Err(e) => {
                    log::warn!("[vcluster] Connect process wait() failed: {}", e);
                }
            }
        } else {
            log::error!("[vcluster] Failed to spawn vcluster connect command");
        }
    });

    // Stage 3: Wait for context to appear
    emit_progress("waiting", "Waiting for vcluster context...", 30);
    info!("[vcluster] Stage 3: Waiting for vcluster context to appear");

    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(20);
    let vcluster_context_prefix = format!("vcluster_{}_{}", name, namespace);
    let mut found_context = String::new();
    let mut last_progress = 30u8;

    while start.elapsed() < timeout {
        // Update progress
        let elapsed_pct = (start.elapsed().as_secs() as u8 * 3).min(40);
        if 30 + elapsed_pct > last_progress {
            last_progress = 30 + elapsed_pct;
            emit_progress("waiting", &format!("Waiting for context... ({:.0}s)", start.elapsed().as_secs()), last_progress);
        }

        // Poll for contexts
        let contexts_output = Command::new("kubectl")
            .args(["config", "get-contexts", "-o", "name"])
            .output();

        if let Ok(output) = contexts_output {
            if output.status.success() {
                let contexts = String::from_utf8_lossy(&output.stdout);

                if let Some(ctx) = contexts.lines().find(|c| c.starts_with(&vcluster_context_prefix)) {
                    found_context = ctx.to_string();
                    info!("[vcluster] Found context: {}", found_context);
                    break;
                }
            }
        }

        sleep(Duration::from_millis(1000)).await;
    }

    if found_context.is_empty() {
        emit_progress("error", "Timed out waiting for vcluster context", 0);
        let err_path = std::env::temp_dir().join("vcluster-connect.err");
        let err_log = std::fs::read_to_string(err_path).unwrap_or_default();
        return Err(format!("Timed out waiting for vcluster context. Error: {}",
            err_log.lines().last().unwrap_or("No output recorded")));
    }

    // Stage 4: Switch context
    emit_progress("switching", "Switching to vcluster context...", 80);
    info!("[vcluster] Stage 4: Switching to context: {}", found_context);

    let switch_output = Command::new("kubectl")
        .args(["config", "use-context", &found_context])
        .output()
        .map_err(|e| format!("Failed to execute kubectl config use-context: {}", e))?;

    if !switch_output.status.success() {
        emit_progress("error", "Failed to switch context", 0);
        return Err(format!("Failed to switch context: {}", String::from_utf8_lossy(&switch_output.stderr)));
    }

    // Stage 5: Verify connection
    emit_progress("verifying", "Verifying vcluster connection...", 90);
    info!("[vcluster] Stage 5: Verifying connection");

    // Quick health check - try to list namespaces
    let verify_output = Command::new("kubectl")
        .args(["get", "ns", "--request-timeout=5s"])
        .output();

    if let Ok(output) = verify_output {
        if !output.status.success() {
            emit_progress("error", "Vcluster connected but cluster unreachable", 0);
            return Err("Vcluster connected but cluster is unreachable. Port-forward may have failed.".to_string());
        }
    }

    // Stage 6: Clear caches and finalize
    emit_progress("finalizing", "Clearing caches and finalizing...", 95);
    info!("[vcluster] Stage 6: Clearing caches");

    if let Ok(mut cache) = state.discovery_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.vcluster_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.pod_limits_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.initial_data_cache.try_lock() { *cache = None; }

    if let Ok(mut ctx) = state.selected_context.lock() {
        *ctx = Some(found_context.clone());
    }

    emit_progress("complete", &format!("Connected to vcluster {}", name), 100);
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
