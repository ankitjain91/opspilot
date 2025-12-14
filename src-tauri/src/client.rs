
use tauri::State;
use kube::{Client, config::{KubeConfigOptions, Kubeconfig}};
use crate::state::AppState;
use std::time::Duration;

// Helper to create a client based on current state - uses caching for performance
pub async fn create_client(state: State<'_, AppState>) -> Result<Client, String> {
    let (path, context) = {
        // Use try_lock with retry to avoid deadlocks
        let mut path_val = None;
        let mut context_val = None;
        for _ in 0..20 {
            if path_val.is_none() {
                if let Ok(guard) = state.kubeconfig_path.try_lock() {
                    path_val = Some(guard.clone());
                }
            }
            if context_val.is_none() {
                if let Ok(guard) = state.selected_context.try_lock() {
                    context_val = Some(guard.clone());
                }
            }
            if path_val.is_some() && context_val.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        (path_val.flatten(), context_val.flatten())
    };

    if let Some(ctx) = &context {
        println!("DEBUG: create_client using context: {}", ctx);
    } else {
        println!("DEBUG: create_client using default context");
    }

    // Check cache
    let cache_key = format!("{}:{}", path.as_deref().unwrap_or("default"), context.as_deref().unwrap_or("default"));
    println!("DEBUG: create_client cache key: {}", cache_key);

    // Check if we have a cached client (2 minute TTL)
    {
        if let Ok(cache) = state.client_cache.try_lock() {
            if let Some((created_at, key, client)) = cache.as_ref() {
                if key == &cache_key && created_at.elapsed() < Duration::from_secs(120) {
                    return Ok(client.clone());
                }
            }
        }
    }

    let kubeconfig = if let Some(p) = &path {
        Kubeconfig::read_from(p).map_err(|e| format!("Failed to read kubeconfig from {}: {}", p, e))?
    } else {
        Kubeconfig::read().map_err(|e| format!("Failed to read default kubeconfig: {}", e))?
    };

    let mut config = kube::Config::from_custom_kubeconfig(
        kubeconfig,
        &KubeConfigOptions {
            context: context.clone(),
            ..Default::default()
        }
    ).await.map_err(|e| format!("Failed to create config for context {:?}: {}", context, e))?;

    // Set reasonable timeouts for better responsiveness
    config.connect_timeout = Some(Duration::from_secs(10));
    config.read_timeout = Some(Duration::from_secs(30));
    config.write_timeout = Some(Duration::from_secs(30));


    // For vcluster contexts (local proxy), we may need to accept self-signed certs
    // vcluster creates contexts with names like "vcluster_<name>_<ns>_<host>"
    let is_vcluster = context.as_ref().map(|c| c.starts_with("vcluster_")).unwrap_or(false);
    if is_vcluster {
        // vcluster proxy uses localhost with self-signed certs
        config.accept_invalid_certs = true;
    }

    let client = Client::try_from(config).map_err(|e| format!("Failed to create Kubernetes client: {}", e))?;

    // Cache the client for reuse
    if let Ok(mut cache) = state.client_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), cache_key, client.clone()));
    }

    Ok(client)
}
