use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::State;
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

#[tauri::command]
pub async fn connect_vcluster(name: String, namespace: String, state: State<'_, AppState>) -> Result<String, String> {
    use std::thread;
    use std::time::Duration;
    use tokio::time::sleep;

    let vcluster_name = name.clone();
    let vcluster_ns = namespace.clone();
    let pid_store = state.vcluster_pid.clone();

    // Spawn the vcluster connect command in a separate thread because it's a long-running blocking process
    // We captured its PID to kill it on disconnect.
    thread::spawn(move || {
        use std::fs::File;
        use std::process::Stdio;

        // Redirect output to a log file for debugging
        let stdout_file = File::create("/tmp/vcluster-connect.out").unwrap_or_else(|_| File::create("/dev/null").unwrap());
        let stderr_file = File::create("/tmp/vcluster-connect.err").unwrap_or_else(|_| File::create("/dev/null").unwrap());

        // We use --background-proxy=false to force it to run in foreground so we can manage the process
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

            println!("DEBUG: vcluster connect process started with PID: {}", child.id());

            match child.wait() {
                Ok(status) => {
                    println!("DEBUG: vcluster connect process EXITED with status: {}", status);
                },
                Err(e) => {
                    println!("DEBUG: vcluster connect process wait() FAILED: {}", e);
                }
            }
        } else {
             println!("DEBUG: Failed to spawn vcluster connect command");
        }
    });

    // Smart polling mechanism
    // We wait up to 15 seconds for the context to appear
    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(15);
    let vcluster_context_prefix = format!("vcluster_{}_{}", name, namespace);
    let mut found_context = String::new();

    println!("DEBUG: Waiting for vcluster context '{}'...", vcluster_context_prefix);

    while start.elapsed() < timeout {
        // Poll for contexts
        let contexts_output = Command::new("kubectl")
            .args(["config", "get-contexts", "-o", "name"])
            .output();

        if let Ok(output) = contexts_output {
            if output.status.success() {
                let contexts = String::from_utf8_lossy(&output.stdout);
                
                // Look for strictly matching prefix to avoid false positives
                if let Some(ctx) = contexts.lines().find(|c| c.starts_with(&vcluster_context_prefix)) {
                    found_context = ctx.to_string();
                    println!("DEBUG: Found context: {}", found_context);
                    break;
                }
            }
        }
        
        // Wait 1s using async sleep to avoid blocking the runtime
        sleep(Duration::from_millis(1000)).await;
    }

    if found_context.is_empty() {
        // Read stderr from the log file to give a hint
        let err_log = std::fs::read_to_string("/tmp/vcluster-connect.err").unwrap_or_default();
        return Err(format!("Timed out waiting for vcluster context. Check /tmp/vcluster-connect.err: {}", 
            err_log.lines().last().unwrap_or("No output recorded")));
    }

    // Switch to the found context
    println!("DEBUG: Switching to context: {}", found_context);
    let switch_output = Command::new("kubectl")
        .args(["config", "use-context", &found_context])
        .output()
        .map_err(|e| format!("Failed to execute kubectl config use-context: {}", e))?;

    if !switch_output.status.success() {
        return Err(format!("Failed to switch context: {}", String::from_utf8_lossy(&switch_output.stderr)));
    }

    // Context switch successful - clear caches
    if let Ok(mut cache) = state.discovery_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.vcluster_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.pod_limits_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.initial_data_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; } // duplicate in original, kept for safety

    // Update selected context state
    if let Ok(mut ctx) = state.selected_context.lock() {
        *ctx = Some(found_context.clone());
    }

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
