use tauri::State;
use kube::{api::{Api, ListParams}, discovery::{Scope, Discovery}, Client};
use crate::state::AppState;
use crate::models::{NavGroup, NavResource};
use crate::client::create_client;
use crate::commands::context::get_current_context_name;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

// Helper function for cache path
fn get_discovery_cache_path(context: &str) -> Option<PathBuf> {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };

    if let Some(h) = home {
        let mut p = PathBuf::from(h);
        p.push(".kube");
        p.push("cache");
        p.push("opspilot");
        if let Err(_) = fs::create_dir_all(&p) {
            return None;
        }
        // Sanitize context name for filename
        let safe_ctx = context.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
        p.push(format!("discovery_{}.json", safe_ctx));
        Some(p)
    } else {
        None
    }
}

fn load_cached_nav_structure(context: &str) -> Option<Vec<NavGroup>> {
    if let Some(path) = get_discovery_cache_path(context) {
        if let Ok(file) = fs::File::open(&path) {
            // Check file age (e.g. 1 hour)
            if let Ok(metadata) = file.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(elapsed) = modified.elapsed() {
                        if elapsed.as_secs() > 3600 {
                            return None; // Too old
                        }
                    }
                }
            }
            let reader = std::io::BufReader::new(file);
            if let Ok(groups) = serde_json::from_reader::<_, Vec<NavGroup>>(reader) {
                if !groups.is_empty() {
                    return Some(groups);
                }
            }
        }
    }
    None
}

fn save_cached_nav_structure(context: &str, groups: &Vec<NavGroup>) {
    if groups.is_empty() { return; }
    if let Some(path) = get_discovery_cache_path(context) {
        if let Ok(file) = fs::File::create(&path) {
            let writer = std::io::BufWriter::new(file);
            let _ = serde_json::to_writer(writer, groups);
        }
    }
}

#[tauri::command]
pub async fn clear_discovery_cache(state: State<'_, AppState>) -> Result<(), String> {
    // Use try_lock to avoid deadlocks in async context
    if let Ok(mut cache) = state.discovery_cache.try_lock() {
        *cache = None;
    }

    // Also delete file from disk
    let context_name = get_current_context_name(state.clone(), None).await.unwrap_or("default".to_string());
    if let Some(path) = get_discovery_cache_path(&context_name) {
        if path.exists() {
            let _ = fs::remove_file(path); // Ignore errors - cache will refresh anyway
        }
    }

    Ok(())
}

// Helper to get cached discovery (shared by other commands)
pub async fn get_cached_discovery(state: &State<'_, AppState>, client: Client) -> Result<std::sync::Arc<Discovery>, String> {
    // Check cache using try_lock to avoid deadlocks
    let cached = {
        if let Ok(cache) = state.discovery_cache.try_lock() {
            if let Some((timestamp, discovery)) = &*cache {
                if timestamp.elapsed().as_secs() < 60 {
                    Some(discovery.clone())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None // Lock held, skip cache check
        }
    };

    if let Some(discovery) = cached {
        return Ok(discovery);
    }

    // Refresh cache
    let discovery = std::sync::Arc::new(Discovery::new(client).run().await.map_err(|e| e.to_string())?);

    // Update cache using try_lock
    if let Ok(mut cache) = state.discovery_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), discovery.clone()));
    }

    Ok(discovery)
}

#[tauri::command]
pub async fn clear_all_caches(state: State<'_, AppState>) -> Result<(), String> {
    // Clear all in-memory caches
    if let Ok(mut cache) = state.discovery_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.vcluster_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.pod_limits_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.client_cache.try_lock() { *cache = None; }
    if let Ok(mut cache) = state.initial_data_cache.try_lock() { *cache = None; }
    Ok(())
}

// 1. DISCOVERY ENGINE: Dynamically finds what your cluster supports
#[tauri::command]
pub async fn discover_api_resources(state: State<'_, AppState>) -> Result<Vec<NavGroup>, String> {
    let context_name = get_current_context_name(state.clone(), None).await.unwrap_or("default".to_string());
    
    // Try load cache
    if let Some(cached) = load_cached_nav_structure(&context_name) {
        println!("Loaded discovery from cache for {}", context_name);
        return Ok(cached);
    }
    println!("Cache miss for {}, running fresh discovery...", context_name);

    let client = create_client(state.clone()).await?;
    let client2 = client.clone();

    // Parallel Execution: Run Discovery and CRD Listing concurrently
    let (discovery_result, crd_result) = tokio::join!(
        // Task 1: Standard Discovery
        async {
            Discovery::new(client).run().await.map_err(|e| e.to_string())
        },
        // Task 2: CRD Listing (Manual fallback)
        async {
            use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
            let api_crd: Api<CustomResourceDefinition> = Api::all(client2);
            api_crd.list(&ListParams::default()).await.map_err(|e| e.to_string())
        }
    );

    let discovery = match discovery_result {
        Ok(d) => {
            println!("Discovery success. Found {} groups.", d.groups().count());
            d
        },
        Err(e) => {
            println!("Discovery failed: {}", e);
            return Err(e);
        }
    };

    if let Err(e) = &crd_result {
        println!("CRD listing failed: {}", e);
    } else {
        println!("CRD listing success. Found {} CRDs.", crd_result.as_ref().unwrap().items.len());
    }
    
    let mut groups: HashMap<String, Vec<NavResource>> = HashMap::new();

    // Standard Categories Map
    let standard_categories: HashMap<&str, &str> = HashMap::from([
        ("Pod", "Workloads"), ("Deployment", "Workloads"), ("StatefulSet", "Workloads"), 
        ("DaemonSet", "Workloads"), ("Job", "Workloads"), ("CronJob", "Workloads"), 
        ("ReplicaSet", "Workloads"),
        ("Service", "Network"), ("Ingress", "Network"), ("NetworkPolicy", "Network"), 
        ("Endpoint", "Network"), ("EndpointSlice", "Network"),
        ("ConfigMap", "Config"), ("Secret", "Config"), ("ResourceQuota", "Config"), 
        ("LimitRange", "Config"), ("HorizontalPodAutoscaler", "Config"),
        ("PersistentVolume", "Storage"), ("PersistentVolumeClaim", "Storage"), 
        ("StorageClass", "Storage"), ("VolumeAttachment", "Storage"),
        ("Node", "Cluster"), ("Namespace", "Cluster"), ("Event", "Cluster"),
        ("ServiceAccount", "Access Control"), ("Role", "Access Control"), 
        ("ClusterRole", "Access Control"), ("RoleBinding", "Access Control"), 
        ("ClusterRoleBinding", "Access Control"),
    ]);

    for group in discovery.groups() {
        for (ar, caps) in group.recommended_resources() {
             let category = if let Some(cat) = standard_categories.get(ar.kind.as_str()) {
                cat.to_string()
            } else if ar.group.contains("crossplane.io") || ar.group.contains("upbound.io") || ar.group.contains("tf.upbound.io") || ar.group.contains("infra.contrib.fluxcd.io") || ar.group.contains("hashicorp.com") {
                "IaC".to_string()
            } else {
                if ar.group.is_empty() {
                    "Core".to_string()
                } else {
                    ar.group.clone()
                }
            };

            let res = NavResource {
                kind: ar.kind.clone(),
                group: ar.group.clone(),
                version: ar.version.clone(),
                namespaced: caps.scope == Scope::Namespaced,
                title: ar.plural.clone(),
            };

            groups.entry(category).or_default().push(res);
        }
    }

    // Sort categories logic
    let standard_order = vec!["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "IaC"];
    let mut result = Vec::new();

    // 1. Add Standard Categories
    for cat in standard_order {
        if let Some(mut items) = groups.remove(cat) {
            items.sort_by(|a, b| a.kind.cmp(&b.kind));
            result.push(NavGroup { title: cat.to_string(), items });
        }
    }

    // 2. Add Remaining Categories (API Groups) Alphabetically
    let mut remaining_categories: Vec<String> = groups.keys().cloned().collect();
    remaining_categories.sort();

    for cat in remaining_categories {
        if let Some(mut items) = groups.remove(&cat) {
            items.sort_by(|a, b| a.kind.cmp(&b.kind));
            result.push(NavGroup { title: cat, items });
        }
    }

    // Fallback: ensure CRDs are visible even if discovery missed some kinds
    if let Ok(crd_list) = crd_result {
        let mut seen: std::collections::HashSet<(String,String)> = std::collections::HashSet::new();
        for ng in &result {
            for it in &ng.items {
                seen.insert((it.group.clone(), it.kind.clone()));
            }
        }
        let mut custom_resources: Vec<NavResource> = Vec::new();
        for crd in crd_list.items {
            let group = crd.spec.group.clone();
            let kind = crd.spec.names.kind.clone();
            let plural = crd.spec.names.plural.clone();
            let version = crd.spec.versions.first().map(|v| v.name.clone()).unwrap_or_else(|| "v1".into());
            let namespaced = crd.spec.scope == "Namespaced";
            if !seen.contains(&(group.clone(), kind.clone())) {
                if let Some(existing) = result.iter_mut().find(|ng| ng.title == group) {
                    existing.items.push(NavResource { kind: kind.clone(), group: group.clone(), version: version.clone(), namespaced, title: plural.clone() });
                    existing.items.sort_by(|a, b| a.kind.cmp(&b.kind));
                } else {
                    result.push(NavGroup { title: group.clone(), items: vec![NavResource { kind: kind.clone(), group: group.clone(), version: version.clone(), namespaced, title: plural.clone() }] });
                }
            }
            custom_resources.push(NavResource { kind: kind, group, version, namespaced, title: plural });
        }
        custom_resources.sort_by(|a, b| a.kind.cmp(&b.kind));
        result.push(NavGroup { title: "Custom Resources".to_string(), items: custom_resources });
    }

    save_cached_nav_structure(&context_name, &result);
    Ok(result)
}
