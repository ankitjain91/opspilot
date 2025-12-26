
use tauri::State;
use kube::{Client, config::{KubeConfigOptions, Kubeconfig}};
use crate::state::AppState;
use crate::models::KubeContext;
use std::time::Duration;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[tauri::command]
pub async fn list_contexts(custom_path: Option<String>) -> Result<Vec<KubeContext>, String> {
    let kubeconfig = if let Some(path) = custom_path {
        Kubeconfig::read_from(path).map_err(|e| e.to_string())?
    } else {
        Kubeconfig::read().map_err(|e| e.to_string())?
    };

    let contexts = kubeconfig.contexts.into_iter().map(|c| {
        let ctx = c.context.unwrap_or_default();
        KubeContext {
            name: c.name,
            cluster: ctx.cluster,
            user: ctx.user,
        }
    }).collect();

    Ok(contexts)
}

#[tauri::command]
pub async fn delete_context(context_name: String, custom_path: Option<String>) -> Result<(), String> {
    // Get the kubeconfig path
    let kubeconfig_path = if let Some(ref path) = custom_path {
        PathBuf::from(path)
    } else {
        // Default kubeconfig path
        let home = dirs::home_dir().ok_or("Could not find HOME directory")?;
        home.join(".kube").join("config")
    };

    // Read the current kubeconfig
    let content = fs::read_to_string(&kubeconfig_path)
        .map_err(|e| format!("Failed to read kubeconfig: {}", e))?;

    // Parse as YAML
    let mut config: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse kubeconfig: {}", e))?;

    // Get the context to find its cluster and user
    let contexts = config.get("contexts")
        .and_then(|c| c.as_sequence())
        .ok_or("No contexts found in kubeconfig")?;

    let context_to_delete = contexts.iter()
        .find(|c| c.get("name").and_then(|n| n.as_str()) == Some(&context_name))
        .ok_or(format!("Context '{}' not found", context_name))?;

    let cluster_name = context_to_delete
        .get("context")
        .and_then(|c| c.get("cluster"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());

    let user_name = context_to_delete
        .get("context")
        .and_then(|c| c.get("user"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());

    // Remove the context
    if let Some(contexts) = config.get_mut("contexts").and_then(|c| c.as_sequence_mut()) {
        contexts.retain(|c| c.get("name").and_then(|n| n.as_str()) != Some(&context_name));
    }

    // Check if the cluster is still used by other contexts
    let cluster_still_used = cluster_name.as_ref().map(|cn| {
        config.get("contexts")
            .and_then(|c| c.as_sequence())
            .map(|contexts| {
                contexts.iter().any(|c| {
                    c.get("context")
                        .and_then(|ctx| ctx.get("cluster"))
                        .and_then(|cl| cl.as_str()) == Some(cn)
                })
            })
            .unwrap_or(false)
    }).unwrap_or(true);

    // Remove cluster if not used by other contexts
    if !cluster_still_used {
        if let Some(cluster_name) = &cluster_name {
            if let Some(clusters) = config.get_mut("clusters").and_then(|c| c.as_sequence_mut()) {
                clusters.retain(|c| c.get("name").and_then(|n| n.as_str()) != Some(cluster_name));
            }
        }
    }

    // Check if the user is still used by other contexts
    let user_still_used = user_name.as_ref().map(|un| {
        config.get("contexts")
            .and_then(|c| c.as_sequence())
            .map(|contexts| {
                contexts.iter().any(|c| {
                    c.get("context")
                        .and_then(|ctx| ctx.get("user"))
                        .and_then(|u| u.as_str()) == Some(un)
                })
            })
            .unwrap_or(false)
    }).unwrap_or(true);

    // Remove user if not used by other contexts
    if !user_still_used {
        if let Some(user_name) = &user_name {
            if let Some(users) = config.get_mut("users").and_then(|c| c.as_sequence_mut()) {
                users.retain(|u| u.get("name").and_then(|n| n.as_str()) != Some(user_name));
            }
        }
    }

    // If current-context was the deleted one, clear it
    if config.get("current-context").and_then(|c| c.as_str()) == Some(&context_name) {
        config["current-context"] = serde_yaml::Value::String(String::new());
    }

    // Write back to file
    let new_content = serde_yaml::to_string(&config)
        .map_err(|e| format!("Failed to serialize kubeconfig: {}", e))?;

    let mut file = fs::File::create(&kubeconfig_path)
        .map_err(|e| format!("Failed to write kubeconfig: {}", e))?;
    file.write_all(new_content.as_bytes())
        .map_err(|e| format!("Failed to write kubeconfig: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn set_kube_config(
    state: State<'_, AppState>,
    path: Option<String>,
    context: Option<String>
) -> Result<String, String> {
    // Check if we're currently connected to a vcluster and need to disconnect
    let current_context = {
        if let Ok(guard) = state.selected_context.try_lock() {
            guard.clone()
        } else {
            None
        }
    };

    // If switching FROM a vcluster context to a different context, disconnect first
    if let Some(ref curr_ctx) = current_context {
        if curr_ctx.starts_with("vcluster_") {
            // Run vcluster disconnect in background with timeout
            let _ = tokio::time::timeout(
                Duration::from_secs(5), 
                tokio::process::Command::new("vcluster")
                    .arg("disconnect")
                    .output()
            ).await;
        }
    }

    // Clear all caches first to prevent stale data
    if let Ok(mut cache) = state.discovery_cache.try_lock() {
        *cache = None;
    }
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() {
        *cache = None;
    }
    if let Ok(mut cache) = state.vcluster_cache.try_lock() {
        *cache = None;
    }
    if let Ok(mut cache) = state.pod_limits_cache.try_lock() {
        *cache = None;
    }
    if let Ok(mut cache) = state.client_cache.try_lock() {
        *cache = None;
    }

    // Use try_lock to avoid deadlocks in async context
    // Retry a few times with small delays if lock is held
    for attempt in 0..10 {
        let path_ok = if let Ok(mut path_guard) = state.kubeconfig_path.try_lock() {
            *path_guard = path.clone();
            true
        } else {
            false
        };

        let context_ok = if let Ok(mut context_guard) = state.selected_context.try_lock() {
            *context_guard = context.clone();
            true
        } else {
            false
        };

        if path_ok && context_ok {
            break;
        }

        if attempt == 9 {
            return Err("Failed to acquire state lock - please try again".to_string());
        }

        // Small delay before retry
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Verify the connection by creating a client and making a simple API call
    let context_name = context.clone().unwrap_or_else(|| "default".to_string());

    // Load kubeconfig and create client
    let kubeconfig = if let Some(p) = &path {
        Kubeconfig::read_from(p).map_err(|e| format!("Cannot read kubeconfig from {}: {}", p, e))?
    } else {
        Kubeconfig::read().map_err(|e| format!("Cannot read default kubeconfig: {}", e))?
    };

    let config_res = tokio::time::timeout(
        Duration::from_secs(25),
        kube::Config::from_custom_kubeconfig(
            kubeconfig,
            &KubeConfigOptions {
                context: context.clone(),
                ..Default::default()
            }
        )
    ).await;

    let mut config = match config_res {
        Ok(res) => res.map_err(|e| format!("Invalid context '{}': {}", context_name, e))?,
        Err(_) => return Err(format!("CONNECTION_TIMEOUT|{}|Authentication timed out (25s). Check your cloud credentials (e.g. az login).", context_name)),
    };

    // Set aggressive timeouts for connection test
    config.connect_timeout = Some(Duration::from_secs(5));
    config.read_timeout = Some(Duration::from_secs(5));

    // For vcluster contexts (local proxy), accept self-signed certs
    if context_name.starts_with("vcluster_") {
        config.accept_invalid_certs = true;
    }


    // Use timeout for client creation as it may trigger exec auth plugins (kubelogin)
    // We want to catch the "Device Code" message from stderr if it fails/times out
    println!("DEBUG: attempting Client::try_from for {}", context_name);
    
    // Note: Client::try_from is not async, but the underlying auth provider execution might be blocking or async. 
    // However, kube-rs 0.85+ implies try_from might block if it runs exec. 
    // Actually, Client::try_from IS NOT async. It returns Result<Client>.
    // If it runs an exec plugin, it usually does so synchronously *or* lazily.
    // If lazily, the timeout needs to be on the first request.
    // If synchronously, we can't easily timeout a sync function in async context without spawn_blocking.
    
    // Let's assume it might hang. We use spawn_blocking to wrap it so we can time it out.
    let config_clone = config.clone();
    let client_res = tokio::time::timeout(
        Duration::from_secs(25),
        tokio::task::spawn_blocking(move || {
            Client::try_from(config_clone)
        })
    ).await;

    let client = match client_res {
        Ok(task_res) => match task_res {
            Ok(client_res) => client_res.map_err(|e| {
                println!("DEBUG: Client creation error: {}", e);
               format_connection_error(&context_name, &e.to_string())
            })?,
            Err(e) => return Err(format!("Spawn error: {}", e)),
        },
        Err(_) => {
             // Timeout happened!
             println!("DEBUG: Client creation timed out after 25s");
             // Return the Azure Login Required error directly to trigger the UI
             return Err(format!("AZURE_LOGIN_REQUIRED|{}|Azure authentication timed out (client creation). Please log in.|az login", context_name));
        }
    };

    // Verify connection with a lightweight API call (with timeout)
    let api_check = tokio::time::timeout(
        Duration::from_secs(8),
        client.list_api_groups()
    ).await;

    match api_check {
        Ok(Ok(_)) => {
            // Success! Persist connection change to kubeconfig file so CLI tools (helm, vcluster) see it
            if let Err(e) = persist_context_change(&path, &context_name) {
                println!("Warning: Failed to persist context change to kubeconfig: {}", e);
                // Don't fail the connections, just warn
            }
            Ok(format!("Connected to {}", context_name))
        },
        Ok(Err(e)) => {
            let err_str = e.to_string();
            Err(format_connection_error(&context_name, &err_str))
        }
        Err(_) => Err(format!("CONNECTION_TIMEOUT|{}|Connection timeout: Cluster '{}' is not responding. Check if the cluster is running and accessible.", context_name, context_name))
    }
}

/// Formats connection errors with structured error codes and remediation hints
fn format_connection_error(context_name: &str, err_str: &str) -> String {
    let err_lower = err_str.to_lowercase();

    // Azure AD / Entra ID device compliance errors
    if err_lower.contains("aadsts530002") || err_lower.contains("device is required to be compliant") {
        // Extract tenant and scope from error message if available
        let tenant = extract_between(err_str, "--tenant \"", "\"").unwrap_or("YOUR_TENANT_ID");
        let scope = extract_between(err_str, "--scope \"", "\"").unwrap_or("YOUR_SCOPE/.default");
        return format!(
            "AZURE_DEVICE_COMPLIANCE|{}|Azure AD device compliance required: Your device must be enrolled in Intune/MDM to access this cluster.|az logout && az login --tenant \"{}\" --scope \"{}\"",
            context_name, tenant, scope
        );
    }

    // Azure Device Code Flow (e.g. MFA / Device Login required)
    if err_lower.contains("devicecodecredential") || err_lower.contains("to sign in, use a web browser") {
        // Try to extract the friendly message
        if let Some(start_idx) = err_str.find("To sign in, use a web browser") {
             let msg = if let Some(end_idx) = err_str[start_idx..].find(" to authenticate") {
                 &err_str[start_idx..start_idx + end_idx]
             } else {
                 &err_str[start_idx..]
             };
             return format!(
                 "AZURE_DEVICE_CODE|{}|{}|",
                 context_name, msg
             );
        } else {
             // Fallback: We know it's a device code issue but didn't get the URL/Code (likely timed out)
             return format!(
                 "AZURE_LOGIN_REQUIRED|{}|Azure authentication timed out. Please log in via terminal.|az login",
                 context_name
             );
        }
    }

    // Azure AD token expired or invalid
    if err_lower.contains("aadsts700082") || err_lower.contains("refresh token has expired") {
        let tenant = extract_between(err_str, "--tenant \"", "\"").unwrap_or("YOUR_TENANT_ID");
        return format!(
            "AZURE_TOKEN_EXPIRED|{}|Azure AD refresh token has expired. You need to re-authenticate.|az logout && az login --tenant \"{}\"",
            context_name, tenant
        );
    }
    
    // Default fallback
    format!(
        "UNKNOWN_ERROR|{}|Failed to connect: {}|",
        context_name, err_str
    )
}

/// Helper to extract text between two markers
fn extract_between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let start_idx = text.find(start)? + start.len();
    let remaining = &text[start_idx..];
    let end_idx = remaining.find(end)?;
    Some(&remaining[..end_idx])
}

#[tauri::command]
pub async fn reset_state(state: State<'_, AppState>) -> Result<(), String> {
    // Clear ALL caches
    if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.discovery_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.vcluster_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.pod_limits_cache.try_lock() { *cache = None; }
    if let Ok(mut ctx) = state.selected_context.try_lock() { *ctx = None; }
    if let Ok(mut path) = state.kubeconfig_path.try_lock() { *path = None; }
    Ok(())
}

#[tauri::command]
pub async fn get_current_context_name(state: State<'_, AppState>, custom_path: Option<String>) -> Result<String, String> {
    // If custom_path is provided, read from that file directly
    if let Some(path) = custom_path {
        let kubeconfig = Kubeconfig::read_from(path).map_err(|e| e.to_string())?;
        return Ok(kubeconfig.current_context.unwrap_or_else(|| "default".to_string()));
    }

    // Use try_lock to avoid deadlocks
    if let Ok(context_guard) = state.selected_context.try_lock() {
        if let Some(ctx) = &*context_guard {
            return Ok(ctx.clone());
        }
    }

    // Fallback to loading from kubeconfig if not set in state
    let path = if let Ok(path_guard) = state.kubeconfig_path.try_lock() {
        path_guard.clone()
    } else {
        None
    };

    let kubeconfig = if let Some(p) = &path {
        Kubeconfig::read_from(p).map_err(|e| e.to_string())?
    } else {
        Kubeconfig::read().map_err(|e| e.to_string())?
    };
    
    Ok(kubeconfig.current_context.unwrap_or_else(|| "default".to_string()))
}

// Helper to persist context change to kubeconfig file
// This ensures that external CLI tools (like vcluster, helm, kubectl) automatically use the new context
fn persist_context_change(path: &Option<String>, context_name: &str) -> Result<(), String> {
    // Determine path
    let kubeconfig_path = if let Some(ref p) = path {
        PathBuf::from(p)
    } else {
        match dirs::home_dir() {
            Some(home) => home.join(".kube").join("config"),
            None => return Err("Could not find HOME directory".to_string()),
        }
    };

    // Read file
    let content = fs::read_to_string(&kubeconfig_path)
        .map_err(|e| format!("Failed to read kubeconfig: {}", e))?;

    // Parse YAML
    let mut config: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse kubeconfig: {}", e))?;

    // Update current-context
    config["current-context"] = serde_yaml::Value::String(context_name.to_string());

    // Serialize
    let new_content = serde_yaml::to_string(&config)
        .map_err(|e| format!("Failed to serialize kubeconfig: {}", e))?;

    // Write back
    let mut file = fs::File::create(&kubeconfig_path)
        .map_err(|e| format!("Failed to write kubeconfig: {}", e))?;
    file.write_all(new_content.as_bytes())
        .map_err(|e| format!("Failed to write kubeconfig: {}", e))?;

    Ok(())
}
