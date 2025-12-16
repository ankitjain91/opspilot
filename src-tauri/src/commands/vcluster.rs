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
    // Run "vcluster list --output json"
    // Note: The flag might be --output or -o.
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
    
    // JSON parsing
    // The output might be a raw array or wrapped.
    // Let's assume standard behavior: Array of objects.
    // Adjusting based on common CLI behavior.
    
    // If output is empty, return empty list
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Try parsing as simple array of generic objects first to be safe
    // Actually, let's use a flexible struct.
    // Based on `vcluster list -o json` output (usually a list of installed vclusters)
    
    // Mock implementation fallback for reliability if CLI isn't actually there in this environment
    // But assuming it is there.
    
    // Let's try to parse generically
    let items: Vec<serde_json::Value> = serde_json::from_str(&stdout)
        .or_else(|_| {
            // Fallback: If it returns an object with "items"
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
    // Variables name/namespace already cloned above if needed, or we can clone here.
    // The previous code had duplicated logic.
    use std::thread;
    use std::time::Duration;

    let vcluster_name = name.clone();
    let vcluster_ns = namespace.clone();
    let pid_store = state.vcluster_pid.clone();

    thread::spawn(move || {
        use std::fs::File;
        use std::process::Stdio;

        // Redirect output to a log file for debugging
        let stdout_file = File::create("/tmp/vcluster-connect.out").unwrap_or_else(|_| File::create("/dev/null").unwrap());
        let stderr_file = File::create("/tmp/vcluster-connect.err").unwrap_or_else(|_| File::create("/dev/null").unwrap());

        if let Ok(mut child) = Command::new("vcluster")
            .args(["connect", &vcluster_name, "-n", &vcluster_ns, "--background-proxy=false"])
            .stdin(Stdio::null())
            .stdout(stdout_file)
            .stderr(stderr_file)
            .spawn() 
        {
            // Store PID so we can kill it later?
            // Note: This lock holding might be short, but process runs long.
            if let Ok(mut pid_guard) = pid_store.lock() {
                *pid_guard = Some(child.id());
            }

            println!("DEBUG: vcluster connect process started with PID: {}", child.id());

            // Monitor the process
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

    // Step 2: Wait for proxy to initialize (usually takes 2-3 seconds)
    thread::sleep(Duration::from_secs(5));

    // Step 3: Switch to the vcluster context explicitly
    // vcluster creates a context named "vcluster_<name>_<namespace>_<original-context>"
    // We'll use kubectl config use-context to switch
    let use_context_output = Command::new("kubectl")
        .args(["config", "use-context", &format!("vcluster_{}_{}*", name, namespace)])
        .output();

    // If exact match fails, try to find the context by pattern
    match use_context_output {
        Ok(output) if output.status.success() => {
            Ok(format!("Connected to vcluster {} in namespace {}", name, namespace))
        }
        _ => {
            // Fallback: Get all contexts and find the vcluster one
            let contexts_output = Command::new("kubectl")
                .args(["config", "get-contexts", "-o", "name"])
                .output()
                .map_err(|e| format!("Failed to get contexts: {}", e))?;

            if contexts_output.status.success() {
                let contexts = String::from_utf8_lossy(&contexts_output.stdout);
                let vcluster_prefix = format!("vcluster_{}_{}", name, namespace);

                if let Some(context) = contexts.lines().find(|c| c.starts_with(&vcluster_prefix)) {
                    // Switch to found context
                    let switch_output = Command::new("kubectl")
                        .args(["config", "use-context", context])
                        .output()
                        .map_err(|e| format!("Failed to switch context: {}", e))?;

                    if switch_output.status.success() {
                        // Clear all backend caches after context switch
                        if let Ok(mut cache) = state.discovery_cache.try_lock() { *cache = None; }
                        if let Ok(mut cache) = state.cluster_stats_cache.try_lock() { *cache = None; }
                        if let Ok(mut cache) = state.vcluster_cache.try_lock() { *cache = None; }
                        if let Ok(mut cache) = state.pod_limits_cache.try_lock() { *cache = None; }
                        if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; }
                        if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; }
                        if let Ok(mut cache) = state.initial_data_cache.try_lock() { *cache = None; }

                        // Persist the new context in state so get_current_context_name returns it immediately
                        if let Ok(mut ctx) = state.selected_context.lock() {
                            *ctx = Some(context.to_string());
                        }

                        return Ok(format!("Connected to vcluster {} in namespace {}", name, namespace));
                    } else {
                        return Err(format!("Failed to switch to vcluster context: {}",
                            String::from_utf8_lossy(&switch_output.stderr)));
                    }
                }
            }

            Err("vcluster proxy started but context switch failed. Try manually: kubectl config get-contexts".to_string())
        }
    }
}

#[tauri::command]
pub async fn disconnect_vcluster(state: State<'_, AppState>) -> Result<String, String> {
    // Run "vcluster disconnect"
    let output = Command::new("vcluster")
        .args(["disconnect"])
        .output()
        .map_err(|e| format!("Failed to execute vcluster command: {}", e))?;

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
