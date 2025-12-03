use kube::{
    api::{Api, ListParams, DynamicObject, GroupVersionKind, DeleteParams, LogParams, AttachParams, Patch, PatchParams},
    runtime::watcher::{watcher, Config as WatcherConfig, Event as WatcherEvent},
    Client, Discovery,
    config::{KubeConfigOptions, Kubeconfig},
};
use kube::discovery::Scope;
use futures::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{State, Emitter};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::fs;
use std::path::PathBuf;

mod ai_local;

// --- Data Structures ---

#[derive(Serialize, Deserialize, Clone)]
struct NavGroup {
    title: String,
    items: Vec<NavResource>,
}

#[derive(Serialize, Deserialize, Clone)]
struct NavResource {
    kind: String,
    group: String,
    version: String,
    namespaced: bool,
    title: String,
}

#[derive(Deserialize, Debug)]
struct ResourceRequest {
    group: String,
    version: String,
    kind: String,
    namespace: Option<String>,
}

#[derive(Serialize, Clone)]
struct ResourceSummary {
    id: String,
    name: String,
    namespace: String,
    kind: String,
    group: String,
    version: String,
    age: String,
    status: String,
    raw_json: String,
    // Pod-specific fields
    #[serde(skip_serializing_if = "Option::is_none")]
    ready: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    restarts: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ip: Option<String>,
}

#[derive(Serialize, Clone)]
struct ResourceWatchEvent {
    event_type: String, // "ADDED", "MODIFIED", "DELETED", "RESTARTED"
    resource: ResourceSummary,
}

#[derive(Serialize)]
struct KubeContext {
    name: String,
    cluster: String,
    user: String,
}

#[derive(Serialize)]
struct K8sEvent {
    message: String,
    reason: String,
    type_: String,
    age: String,
    count: i32,
}

#[derive(Serialize, Clone)]
struct ClusterStats {
    nodes: usize,
    pods: usize,
    deployments: usize,
    services: usize,
    namespaces: usize,
}

// Comprehensive cluster cockpit data
#[derive(Serialize, Clone)]
struct NodeHealth {
    name: String,
    status: String,
    cpu_capacity: u64,       // in millicores
    cpu_allocatable: u64,
    cpu_usage: u64,
    memory_capacity: u64,    // in bytes
    memory_allocatable: u64,
    memory_usage: u64,
    pods_capacity: u32,
    pods_running: u32,
    conditions: Vec<NodeCondition>,
    taints: Vec<String>,
}

#[derive(Serialize, Clone)]
struct NodeCondition {
    type_: String,
    status: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct PodStatusBreakdown {
    running: usize,
    pending: usize,
    succeeded: usize,
    failed: usize,
    unknown: usize,
}

#[derive(Serialize, Clone)]
struct DeploymentHealth {
    name: String,
    namespace: String,
    desired: u32,
    ready: u32,
    available: u32,
    up_to_date: u32,
}

#[derive(Serialize, Clone)]
struct NamespaceUsage {
    name: String,
    pod_count: usize,
    cpu_usage: u64,
    memory_usage: u64,
}

#[derive(Serialize, Clone)]
struct ClusterCockpitData {
    // Overall stats
    total_nodes: usize,
    healthy_nodes: usize,
    total_pods: usize,
    total_deployments: usize,
    total_services: usize,
    total_namespaces: usize,

    // Resource totals
    total_cpu_capacity: u64,      // millicores
    total_cpu_allocatable: u64,
    total_cpu_usage: u64,
    total_memory_capacity: u64,   // bytes
    total_memory_allocatable: u64,
    total_memory_usage: u64,
    total_pods_capacity: u32,

    // Breakdowns
    pod_status: PodStatusBreakdown,
    nodes: Vec<NodeHealth>,
    unhealthy_deployments: Vec<DeploymentHealth>,
    top_namespaces: Vec<NamespaceUsage>,

    // Warnings/Alerts
    warning_count: usize,
    critical_count: usize,

    // Flag to indicate if real metrics are available (from metrics-server)
    // If false, resource usage is estimated from pod requests
    metrics_available: bool,
}

// Cluster-wide health summary for AI chat
#[derive(Serialize, Clone)]
struct ClusterHealthSummary {
    // Node health
    total_nodes: usize,
    ready_nodes: usize,
    not_ready_nodes: Vec<String>,

    // Pod health
    total_pods: usize,
    running_pods: usize,
    pending_pods: usize,
    failed_pods: usize,
    crashloop_pods: Vec<PodIssue>,

    // Deployment health
    total_deployments: usize,
    healthy_deployments: usize,
    unhealthy_deployments: Vec<DeploymentIssue>,

    // Resource usage
    cluster_cpu_percent: f64,
    cluster_memory_percent: f64,

    // Critical issues (prioritized)
    critical_issues: Vec<ClusterIssue>,
    warnings: Vec<ClusterIssue>,
}

#[derive(Serialize, Clone)]
struct PodIssue {
    name: String,
    namespace: String,
    status: String,
    restart_count: u32,
    reason: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct DeploymentIssue {
    name: String,
    namespace: String,
    desired: u32,
    ready: u32,
    available: u32,
    reason: String,
}

#[derive(Serialize, Clone)]
struct ClusterIssue {
    severity: String, // "critical" or "warning"
    resource_kind: String,
    resource_name: String,
    namespace: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct ClusterEventSummary {
    namespace: String,
    name: String,
    kind: String,
    reason: String,
    message: String,
    count: u32,
    last_seen: String,
    event_type: String, // "Normal" or "Warning"
}

// Combined initial data for faster first load
#[derive(Serialize, Clone)]
struct InitialClusterData {
    stats: ClusterStats,
    namespaces: Vec<String>,
    pods: Vec<ResourceSummary>,
    nodes: Vec<ResourceSummary>,
    deployments: Vec<ResourceSummary>,
    services: Vec<ResourceSummary>,
}

#[derive(Serialize, Clone)]
struct ResourceMetrics {
    name: String,
    namespace: String,
    cpu: String,
    memory: String,
    cpu_nano: u64,
    memory_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_limit_nano: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_limit_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_percent: Option<f64>,
    timestamp: i64,
}

// Info struct for CRD inspection
#[derive(Serialize)]
struct CrdInfo {
    name: String,
    group: String,
    versions: Vec<String>,
    scope: String,
}

// --- Topology Graph Structures ---
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyNode {
    id: String,
    kind: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    labels: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyEdge {
    id: String,
    from: String,
    to: String,
    #[serde(rename = "type")]
    r#type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyGraph {
    nodes: Vec<TopologyNode>,
    edges: Vec<TopologyEdge>,
    generated_at: String,
}

fn topo_node_id(kind: &str, namespace: Option<&str>, name: &str) -> String {
    if let Some(ns) = namespace { format!("{}/{}/{}", kind, ns, name) } else { format!("{}/{}", kind, name) }
}

fn derive_pod_status(pod: &k8s_openapi::api::core::v1::Pod) -> String {
    if let Some(status) = &pod.status {
        if let Some(phase) = &status.phase {
            match phase.as_str() {
                "Running" => {
                    // Check conditions ready
                    if let Some(conds) = &status.conditions {
                        if conds.iter().any(|c| c.type_ == "Ready" && c.status == "True") { return "Healthy".into(); }
                    }
                    "Degraded".into()
                },
                "Pending" => "Pending".into(),
                "Failed" => "Failed".into(),
                _ => "Unknown".into(),
            }
        } else { "Unknown".into() }
    } else { "Unknown".into() }
}

fn derive_deployment_status(dep: &k8s_openapi::api::apps::v1::Deployment) -> String {
    let spec_repl = dep.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let avail = dep.status.as_ref().and_then(|s| s.available_replicas).unwrap_or(0);
    if spec_repl == 0 { return "Unknown".into(); }
    if avail == spec_repl { "Healthy".into() } else { "Degraded".into() }
}

fn derive_stateful_status(st: &k8s_openapi::api::apps::v1::StatefulSet) -> String {
    let desired = st.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let ready = st.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
    if desired == 0 { return "Unknown".into(); }
    if desired == ready { "Healthy".into() } else { "Degraded".into() }
}

fn derive_daemon_status(ds: &k8s_openapi::api::apps::v1::DaemonSet) -> String {
    let desired = ds.status.as_ref().map(|s| s.desired_number_scheduled).unwrap_or(0);
    let ready = ds.status.as_ref().map(|s| s.number_ready).unwrap_or(0);
    if desired == 0 { return "Unknown".into(); }
    if desired == ready { "Healthy".into() } else { "Degraded".into() }
}

fn derive_job_status(job: &k8s_openapi::api::batch::v1::Job) -> String {
    if let Some(status) = &job.status {
        if let Some(succeeded) = status.succeeded { if succeeded > 0 { return "Healthy".into(); } }
        if status.failed.unwrap_or(0) > 0 { return "Failed".into(); }
        return "Pending".into();
    }
    "Unknown".into()
}

#[derive(Serialize, Deserialize, Clone)]
struct AzureSubscription {
    id: String,
    name: String,
    state: String,
    #[serde(rename = "isDefault")]
    is_default: bool,
    #[serde(default)]
    clusters: Vec<AksCluster>,
}

#[derive(Serialize, Deserialize, Clone)]
struct AksCluster {
    id: String,
    name: String,
    #[serde(rename = "resourceGroup")]
    resource_group: String,
    location: String,
    #[serde(rename = "powerState")]
    power_state: PowerState,
}

#[derive(Serialize, Deserialize, Clone)]
struct PowerState {
    code: String,
}

struct ExecSession {
    stdin: tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
}

struct ShellSession {
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
}

struct PortForwardSession {
    id: String,
    pod_name: String,
    namespace: String,
    local_port: u16,
    pod_port: u16,
    handle: tokio::task::JoinHandle<()>,
}

struct AppState {
    kubeconfig_path: Mutex<Option<String>>,
    selected_context: Mutex<Option<String>>,
    sessions: Arc<Mutex<HashMap<String, Arc<ExecSession>>>>,
    shell_sessions: Arc<Mutex<HashMap<String, Arc<ShellSession>>>>,
    port_forwards: Arc<Mutex<HashMap<String, PortForwardSession>>>,
    log_streams: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
    discovery_cache: Arc<Mutex<Option<(std::time::Instant, Arc<Discovery>)>>>,
    vcluster_cache: Arc<Mutex<Option<(std::time::Instant, String)>>>,
    cluster_stats_cache: Arc<Mutex<Option<(std::time::Instant, ClusterStats)>>>,
    // Cache pod limits to avoid refetching pods for metrics (30s TTL)
    pod_limits_cache: Arc<Mutex<Option<(std::time::Instant, HashMap<String, (Option<u64>, Option<u64>)>)>>>,
    // Cache Kubernetes client to avoid re-creating connections (2 minute TTL)
    // Key is (kubeconfig_path, context) to ensure cache invalidation on context switch
    client_cache: Arc<Mutex<Option<(std::time::Instant, String, Client)>>>,
}

// --- Logic ---

async fn get_cached_discovery(state: &State<'_, AppState>, client: Client) -> Result<Arc<Discovery>, String> {
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
    let discovery = Arc::new(Discovery::new(client).run().await.map_err(|e| e.to_string())?);

    // Update cache using try_lock
    if let Ok(mut cache) = state.discovery_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), discovery.clone()));
    }

    Ok(discovery)
}

// Utility: Clear discovery cache so new CRDs/groups appear immediately
#[tauri::command]
async fn clear_discovery_cache(state: State<'_, AppState>) -> Result<(), String> {
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

#[tauri::command]
async fn clear_all_caches(state: State<'_, AppState>) -> Result<(), String> {
    // Clear all in-memory caches
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
    Ok(())
}

// Helper to create a client based on current state - uses caching for performance
async fn create_client(state: State<'_, AppState>) -> Result<Client, String> {
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
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
        (path_val.flatten(), context_val.flatten())
    };

    // Create cache key from path and context
    let cache_key = format!("{}:{}", path.as_deref().unwrap_or("default"), context.as_deref().unwrap_or("default"));

    // Check if we have a cached client (2 minute TTL)
    {
        if let Ok(cache) = state.client_cache.try_lock() {
            if let Some((created_at, key, client)) = cache.as_ref() {
                if key == &cache_key && created_at.elapsed() < std::time::Duration::from_secs(120) {
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
    config.connect_timeout = Some(std::time::Duration::from_secs(10));
    config.read_timeout = Some(std::time::Duration::from_secs(30));
    config.write_timeout = Some(std::time::Duration::from_secs(30));

    let client = Client::try_from(config).map_err(|e| format!("Failed to create Kubernetes client: {}", e))?;

    // Cache the client for reuse
    if let Ok(mut cache) = state.client_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), cache_key, client.clone()));
    }

    Ok(client)
}

#[tauri::command]
async fn list_contexts(custom_path: Option<String>) -> Result<Vec<KubeContext>, String> {
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
async fn delete_context(context_name: String, custom_path: Option<String>) -> Result<(), String> {
    use std::fs;
    use std::io::Write;

    // Get the kubeconfig path
    let kubeconfig_path = if let Some(ref path) = custom_path {
        std::path::PathBuf::from(path)
    } else {
        // Default kubeconfig path
        let home = std::env::var("HOME").map_err(|_| "Could not find HOME directory")?;
        std::path::PathBuf::from(home).join(".kube").join("config")
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
async fn set_kube_config(
    state: State<'_, AppState>,
    path: Option<String>,
    context: Option<String>
) -> Result<String, String> {
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
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    // Verify the connection by creating a client and making a simple API call
    let context_name = context.clone().unwrap_or_else(|| "default".to_string());

    // Load kubeconfig and create client
    let kubeconfig = if let Some(p) = &path {
        Kubeconfig::read_from(p).map_err(|e| format!("Cannot read kubeconfig from {}: {}", p, e))?
    } else {
        Kubeconfig::read().map_err(|e| format!("Cannot read default kubeconfig: {}", e))?
    };

    let mut config = kube::Config::from_custom_kubeconfig(
        kubeconfig,
        &KubeConfigOptions {
            context: context.clone(),
            ..Default::default()
        }
    ).await.map_err(|e| format!("Invalid context '{}': {}", context_name, e))?;

    // Set aggressive timeouts for connection test
    config.connect_timeout = Some(std::time::Duration::from_secs(5));
    config.read_timeout = Some(std::time::Duration::from_secs(5));

    let client = Client::try_from(config).map_err(|e| format!("Failed to create client: {}", e))?;

    // Verify connection with a lightweight API call (with timeout)
    let api_check = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        client.list_api_groups()
    ).await;

    match api_check {
        Ok(Ok(_)) => Ok(format!("Connected to {}", context_name)),
        Ok(Err(e)) => {
            // Check for common error patterns
            let err_str = e.to_string();
            if err_str.contains("certificate") || err_str.contains("tls") {
                Err(format!("TLS/Certificate error for '{}': {}. Check if the cluster certificate is valid.", context_name, err_str))
            } else if err_str.contains("connection refused") {
                Err(format!("Connection refused for '{}': The cluster API server is not reachable. Is the cluster running?", context_name))
            } else if err_str.contains("timeout") || err_str.contains("timed out") {
                Err(format!("Connection timeout for '{}': The cluster is not responding. Check network connectivity.", context_name))
            } else if err_str.contains("401") || err_str.contains("Unauthorized") {
                Err(format!("Authentication failed for '{}': Your credentials may have expired. Try re-authenticating.", context_name))
            } else if err_str.contains("403") || err_str.contains("Forbidden") {
                Err(format!("Access denied for '{}': You don't have permission to access this cluster.", context_name))
            } else {
                Err(format!("Failed to connect to '{}': {}", context_name, err_str))
            }
        }
        Err(_) => Err(format!("Connection timeout: Cluster '{}' is not responding. Check if the cluster is running and accessible.", context_name))
    }
}

#[tauri::command]
async fn reset_state(state: State<'_, AppState>) -> Result<(), String> {
    // Clear ALL caches when switching contexts to prevent stale data from previous cluster
    // Use try_lock to avoid deadlocks

    // Clear discovery cache
    if let Ok(mut cache) = state.discovery_cache.try_lock() {
        *cache = None;
    }

    // Clear vcluster cache
    if let Ok(mut cache) = state.vcluster_cache.try_lock() {
        *cache = None;
    }

    // Clear cluster stats cache
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() {
        *cache = None;
    }

    // Clear pod limits cache
    if let Ok(mut cache) = state.pod_limits_cache.try_lock() {
        *cache = None;
    }

    Ok(())
}

// --- Caching Helpers ---

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
            if let Ok(groups) = serde_json::from_reader(reader) {
                return Some(groups);
            }
        }
    }
    None
}

fn save_cached_nav_structure(context: &str, groups: &Vec<NavGroup>) {
    if let Some(path) = get_discovery_cache_path(context) {
        if let Ok(file) = fs::File::create(&path) {
            let writer = std::io::BufWriter::new(file);
            let _ = serde_json::to_writer(writer, groups);
        }
    }
}

// 1. DISCOVERY ENGINE: Dynamically finds what your cluster supports
#[tauri::command]
async fn discover_api_resources(state: State<'_, AppState>) -> Result<Vec<NavGroup>, String> {
    let context_name = get_current_context_name(state.clone(), None).await.unwrap_or("default".to_string());
    
    // Try load cache
    if let Some(cached) = load_cached_nav_structure(&context_name) {
        println!("Loaded discovery from cache for {}", context_name);
        return Ok(cached);
    }

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

    let discovery = discovery_result?;
    
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
        // Iterate recommended resources (includes CRDs); fallback logic could be added if needed
        for (ar, caps) in group.recommended_resources() {
            // Relax filter: include even if LIST not reported, to surface all CRDs.
            // Some clusters expose LIST but caps may not reflect it accurately for CRDs.

            // Categorization Logic
            // 1. Check if it's a standard resource
            let category = if let Some(cat) = standard_categories.get(ar.kind.as_str()) {
                cat.to_string()
            } else if ar.group.contains("crossplane.io") || ar.group.contains("upbound.io") {
                "Crossplane".to_string()
            } else {
                // 2. If not standard, use the API Group as the category
                // This ensures NOTHING is hidden.
                if ar.group.is_empty() {
                    "Core".to_string()
                } else {
                    ar.group.clone()
                }
            };

            // println!("Discovered: {} ({}) -> {}", ar.kind, ar.group, category);

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
    // We want standard categories first, then alphabetical for the rest
    let standard_order = vec!["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "Crossplane"];
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
    // We append any CRD kinds not already present, grouped under their API group
    if let Ok(crd_list) = crd_result {
        let mut seen: std::collections::HashSet<(String,String)> = std::collections::HashSet::new();
        // Build set of existing group/kind in result to avoid duplicates
        for ng in &result {
            for it in &ng.items {
                seen.insert((it.group.clone(), it.kind.clone()));
            }
        }
        // Collect CRDs for Custom Resources category and append missing per-group too
        let mut custom_resources: Vec<NavResource> = Vec::new();
        for crd in crd_list.items {
            let group = crd.spec.group.clone();
            let kind = crd.spec.names.kind.clone();
            let plural = crd.spec.names.plural.clone();
            let version = crd.spec.versions.first().map(|v| v.name.clone()).unwrap_or_else(|| "v1".into());
            let namespaced = crd.spec.scope == "Namespaced";
            if !seen.contains(&(group.clone(), kind.clone())) {
                // Find or create category for this API group
                if let Some(existing) = result.iter_mut().find(|ng| ng.title == group) {
                    existing.items.push(NavResource { kind: kind.clone(), group: group.clone(), version: version.clone(), namespaced, title: plural.clone() });
                    existing.items.sort_by(|a, b| a.kind.cmp(&b.kind));
                } else {
                    result.push(NavGroup { title: group.clone(), items: vec![NavResource { kind: kind.clone(), group: group.clone(), version: version.clone(), namespaced, title: plural.clone() }] });
                }
            }
            // Always include in Custom Resources top-level list
            custom_resources.push(NavResource { kind: kind, group, version, namespaced, title: plural });
        }

        // Sort and add Custom Resources category at the end
        custom_resources.sort_by(|a, b| a.kind.cmp(&b.kind));
        result.push(NavGroup { title: "Custom Resources".to_string(), items: custom_resources });
    }

    // Save cache
    save_cached_nav_structure(&context_name, &result);

    Ok(result)
}

// 2. UNIVERSAL LISTER
#[tauri::command]
async fn list_resources(state: State<'_, AppState>, req: ResourceRequest) -> Result<Vec<ResourceSummary>, String> {
    let client = create_client(state.clone()).await?;
    let gvk = GroupVersionKind::gvk(&req.group, &req.version, &req.kind);
    let discovery = get_cached_discovery(&state, client.clone()).await?;
    
    // Resolve the GVK to an API Resource
    let ar = if let Some((res, _caps)) = discovery.resolve_gvk(&gvk) {
        res
    } else {
        // Fallback: find any ApiResource matching group+kind
        let mut found: Option<kube::discovery::ApiResource> = None;
        for group in discovery.groups() {
            for (res, _caps) in group.recommended_resources() {
                if res.group == req.group && res.kind == req.kind {
                    found = Some(res.clone());
                    break;
                }
            }
            if found.is_some() { break; }
        }
        if let Some(res) = found { res } else {
            // As a last resort, try any served version from CRDs by ignoring version mismatches
            // This improves resilience when UI passes v1 but only v1alpha1 is served.
            return Err(format!("Resource kind not found: {}/{}/{}", req.group, req.version, req.kind));
        }
    };

    let ns_opt = req.namespace.clone();
    let api: Api<DynamicObject> = if let Some(ns) = ns_opt.clone() {
        Api::namespaced_with(client.clone(), &ns, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    };

    // Try listing; if version mismatch causes failure, attempt listing across all resources in the same group/kind
    let list = match api.list(&ListParams::default()).await {
        Ok(l) => l,
        Err(e) => {
            // Attempt a retry using an alternative ApiResource whose group+kind matches (different version)
            // Retry errors will be ignored; we'll return the original error if all alternatives fail
            for group in discovery.groups() {
                for (res, _caps) in group.recommended_resources() {
                    if res.group == req.group && res.kind == req.kind {
                        let alt_api: Api<DynamicObject> = if let Some(ns) = ns_opt.clone() {
                            Api::namespaced_with(client.clone(), &ns, &res)
                        } else {
                            Api::all_with(client.clone(), &res)
                        };
                        match alt_api.list(&ListParams::default()).await {
                            Ok(l) => {
                              // Build summaries matching the main path fields
                              let summaries: Vec<ResourceSummary> = l.into_iter().map(|obj| {
                                let name = obj.metadata.name.clone().unwrap_or_default();
                                let namespace = obj.metadata.namespace.clone().unwrap_or("-".into());
                                let status = obj.data.get("status")
                                    .and_then(|s| s.get("phase").or(s.get("state")))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_else(|| {
                                        obj.data.get("status")
                                            .and_then(|s| s.get("conditions"))
                                            .and_then(|c| c.as_array())
                                            .and_then(|arr| arr.last())
                                            .and_then(|cond| cond.get("type"))
                                            .and_then(|t| t.as_str())
                                            .unwrap_or("Active")
                                    })
                                    .to_string();

                                // Pod-specific extras only if kind == Pod
                                let (ready, restarts, node, ip) = if req.kind.to_lowercase() == "pod" {
                                    let status_obj = obj.data.get("status");
                                    let ready_str = if let Some(container_statuses) = status_obj.and_then(|s| s.get("containerStatuses")).and_then(|cs| cs.as_array()) {
                                        let ready_count = container_statuses.iter().filter(|c| c.get("ready").and_then(|r| r.as_bool()).unwrap_or(false)).count();
                                        let total_count = container_statuses.len();
                                        Some(format!("{}/{}", ready_count, total_count))
                                    } else { Some("0/0".to_string()) };
                                    let restart_count = if let Some(container_statuses) = status_obj.and_then(|s| s.get("containerStatuses")).and_then(|cs| cs.as_array()) {
                                        Some(container_statuses.iter()
                                            .filter_map(|c| c.get("restartCount").and_then(|r| r.as_i64()).map(|r| r as i32))
                                            .sum::<i32>())
                                    } else { Some(0) };
                                    let node_name = obj.data.get("spec").and_then(|spec| spec.get("nodeName")).and_then(|n| n.as_str()).map(|s| s.to_string());
                                    let pod_ip = status_obj.and_then(|s| s.get("podIP")).and_then(|ip| ip.as_str()).map(|s| s.to_string());
                                    (ready_str, restart_count, node_name, pod_ip)
                                } else { (None, None, None, None) };

                                                                ResourceSummary {
                                  id: obj.metadata.uid.clone().unwrap_or_default(),
                                  name,
                                  namespace,
                                  kind: req.kind.clone(),
                                  group: req.group.clone(),
                                                                      version: res.version.clone(),
                                  age: obj.metadata.creation_timestamp.clone().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
                                  status,
                                  raw_json: String::new(),
                                  ready,
                                  restarts,
                                  node,
                                  ip,
                                }
                              }).collect();
                                                            return Ok(summaries);
                            }
                            Err(_err) => { /* ignore and continue trying other versions */ }
                        }
                    }
                }
            }
            return Err(e.to_string());
        }
    };

    let summaries = list.into_iter().map(|obj| {
        let name = obj.metadata.name.clone().unwrap_or_default();
        let namespace = obj.metadata.namespace.clone().unwrap_or("-".into());
        
        // Smart Status Extraction: Looks for 'phase', 'state', or 'conditions'
        let status = obj.data.get("status")
            .and_then(|s| s.get("phase").or(s.get("state")))
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| {
                obj.data.get("status")
                    .and_then(|s| s.get("conditions"))
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.last()) 
                    .and_then(|cond| cond.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("Active")
            })
            .to_string();

        // Extract pod-specific fields if this is a Pod
        let (ready, restarts, node, ip) = if req.kind.to_lowercase() == "pod" {
            let status_obj = obj.data.get("status");
            
            // Ready count (e.g., "2/3")
            let ready_str = if let Some(container_statuses) = status_obj.and_then(|s| s.get("containerStatuses")).and_then(|cs| cs.as_array()) {
                let ready_count = container_statuses.iter().filter(|c| c.get("ready").and_then(|r| r.as_bool()).unwrap_or(false)).count();
                let total_count = container_statuses.len();
                Some(format!("{}/{}", ready_count, total_count))
            } else {
                Some("0/0".to_string())
            };
            
            // Restart count (sum of all container restarts)
            let restart_count = if let Some(container_statuses) = status_obj.and_then(|s| s.get("containerStatuses")).and_then(|cs| cs.as_array()) {
                Some(container_statuses.iter()
                    .filter_map(|c| c.get("restartCount").and_then(|r| r.as_i64()).map(|r| r as i32))
                    .sum::<i32>())
            } else {
                Some(0)
            };
            
            // Node name
            let node_name = obj.data.get("spec")
                .and_then(|spec| spec.get("nodeName"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());
            
            // Pod IP
            let pod_ip = status_obj
                .and_then(|s| s.get("podIP"))
                .and_then(|ip| ip.as_str())
                .map(|s| s.to_string());
            
            (ready_str, restart_count, node_name, pod_ip)
        } else {
            (None, None, None, None)
        };

        ResourceSummary {
            id: obj.metadata.uid.clone().unwrap_or_default(),
            name,
            namespace,
            kind: req.kind.clone(),
            group: req.group.clone(),
            version: req.version.clone(),
            age: obj.metadata.creation_timestamp.clone().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
            status,
            raw_json: String::new(), // Don't serialize full JSON for list view - saves significant time
            ready,
            restarts,
            node,
            ip,
        }
    }).collect();

    Ok(summaries)
}

// 3. UNIVERSAL DELETER
#[tauri::command]
async fn delete_resource(state: State<'_, AppState>, req: ResourceRequest, name: String) -> Result<(), String> {
    let client = create_client(state).await?;
    let gvk = GroupVersionKind::gvk(&req.group, &req.version, &req.kind);
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("Resource not found")?;

    let api: Api<DynamicObject> = if let Some(ns) = req.namespace {
        Api::namespaced_with(client, &ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    api.delete(&name, &DeleteParams::default()).await.map_err(|e| e.to_string())?;
    Ok(())
}

// 3a. GET RESOURCE DETAILS (with full YAML)
#[tauri::command]
async fn get_resource_details(state: State<'_, AppState>, req: ResourceRequest, name: String) -> Result<String, String> {
    let client = create_client(state.clone()).await?;
    let gvk = GroupVersionKind::gvk(&req.group, &req.version, &req.kind);
    let discovery = get_cached_discovery(&state, client.clone()).await?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("Resource not found")?;

    let api: Api<DynamicObject> = if let Some(ns) = req.namespace {
        Api::namespaced_with(client, &ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    let obj = api.get(&name).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&obj).unwrap_or_default())
}

// 4. LOGS FETCHER (legacy: polling-based)
#[tauri::command]
async fn get_pod_logs(state: State<'_, AppState>, namespace: String, name: String, container: Option<String>) -> Result<String, String> {
    let client = create_client(state).await?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);

    let lp = LogParams {
        container,
        tail_lines: Some(1000),
        ..LogParams::default()
    };

    let logs = pods.logs(&name, &lp).await.map_err(|e| e.to_string())?;
    Ok(logs)
}

// 4a. STREAMING LOGS (follow mode) - Optimized for high throughput
#[tauri::command]
async fn start_log_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    container: Option<String>,
    session_id: String,
) -> Result<(), String> {
    // First, cancel any existing stream with the same session_id
    {
        let mut streams = state.log_streams.lock().unwrap();
        if let Some(cancel_tx) = streams.remove(&session_id) {
            let _ = cancel_tx.send(());
        }
    }

    let client = create_client(state.clone()).await?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);

    let lp = LogParams {
        container,
        tail_lines: Some(500), // More initial lines for context
        follow: true,
        ..LogParams::default()
    };

    let stream = pods.log_stream(&name, &lp).await.map_err(|e| e.to_string())?;

    // Create cancellation channel
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    // Store the cancel sender
    {
        let mut streams = state.log_streams.lock().unwrap();
        streams.insert(session_id.clone(), cancel_tx);
    }

    let log_streams = state.log_streams.clone();
    let sid = session_id.clone();

    tokio::spawn(async move {
        use futures::AsyncReadExt;

        // Use the stream directly as an async reader with large buffer
        let mut buf = vec![0u8; 16384]; // 16KB buffer for fast reads

        // Pin the stream for reading
        let mut stream = Box::pin(stream);

        loop {
            tokio::select! {
                biased; // Prioritize cancellation check

                // Check for cancellation first
                _ = &mut cancel_rx => {
                    break;
                }
                // Read raw bytes - much faster than line-by-line
                result = stream.read(&mut buf) => {
                    match result {
                        Ok(0) => break, // EOF
                        Ok(n) => {
                            // Send raw bytes as string - let frontend handle line splitting
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app.emit(&format!("log_stream:{}", sid), data);
                        }
                        Err(_) => break,
                    }
                }
            }
        }

        // Clean up and emit end event
        {
            let mut streams = log_streams.lock().unwrap();
            streams.remove(&sid);
        }
        let _ = app.emit(&format!("log_stream_end:{}", sid), ());
    });

    Ok(())
}

#[tauri::command]
async fn stop_log_stream(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut streams = state.log_streams.lock().unwrap();
    if let Some(cancel_tx) = streams.remove(&session_id) {
        let _ = cancel_tx.send(());
    }
    Ok(())
}

// 4b. RESOURCE WATCH STREAM - Real-time updates via Kubernetes watch API
#[tauri::command]
async fn start_resource_watch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    req: ResourceRequest,
    watch_id: String,
) -> Result<(), String> {
    let client = create_client(state.clone()).await?;
    let gvk = GroupVersionKind::gvk(&req.group, &req.version, &req.kind);
    let discovery = get_cached_discovery(&state, client.clone()).await?;

    // Resolve the GVK to an API Resource
    let ar = if let Some((res, _caps)) = discovery.resolve_gvk(&gvk) {
        res
    } else {
        // Fallback: find any ApiResource matching group+kind
        let mut found: Option<kube::discovery::ApiResource> = None;
        for group in discovery.groups() {
            for (res, _caps) in group.recommended_resources() {
                if res.group == req.group && res.kind == req.kind {
                    found = Some(res.clone());
                    break;
                }
            }
            if found.is_some() { break; }
        }
        found.ok_or_else(|| format!("Resource kind not found: {}/{}/{}", req.group, req.version, req.kind))?
    };

    let ns_opt = req.namespace.clone();
    let api: Api<DynamicObject> = if let Some(ns) = ns_opt.clone() {
        Api::namespaced_with(client.clone(), &ns, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    };

    let kind = req.kind.clone();
    let group = req.group.clone();
    let version = ar.version.clone();

    // Helper function to convert DynamicObject to ResourceSummary
    let to_summary = move |obj: DynamicObject| -> ResourceSummary {
        let name = obj.metadata.name.clone().unwrap_or_default();
        let namespace = obj.metadata.namespace.clone().unwrap_or("-".into());

        let status = obj.data.get("status")
            .and_then(|s| s.get("phase").or(s.get("state")))
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| {
                obj.data.get("status")
                    .and_then(|s| s.get("conditions"))
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.last())
                    .and_then(|cond| cond.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("Active")
            })
            .to_string();

        // Pod-specific extras
        let (ready, restarts, node, ip) = if kind.to_lowercase() == "pod" {
            let status_obj = obj.data.get("status");
            let ready_str = if let Some(container_statuses) = status_obj.and_then(|s| s.get("containerStatuses")).and_then(|cs| cs.as_array()) {
                let ready_count = container_statuses.iter().filter(|c| c.get("ready").and_then(|r| r.as_bool()).unwrap_or(false)).count();
                let total_count = container_statuses.len();
                Some(format!("{}/{}", ready_count, total_count))
            } else { Some("0/0".to_string()) };
            let restart_count = if let Some(container_statuses) = status_obj.and_then(|s| s.get("containerStatuses")).and_then(|cs| cs.as_array()) {
                Some(container_statuses.iter()
                    .filter_map(|c| c.get("restartCount").and_then(|r| r.as_i64()).map(|r| r as i32))
                    .sum::<i32>())
            } else { Some(0) };
            let node_name = obj.data.get("spec").and_then(|spec| spec.get("nodeName")).and_then(|n| n.as_str()).map(|s| s.to_string());
            let pod_ip = status_obj.and_then(|s| s.get("podIP")).and_then(|ip| ip.as_str()).map(|s| s.to_string());
            (ready_str, restart_count, node_name, pod_ip)
        } else { (None, None, None, None) };

        ResourceSummary {
            id: obj.metadata.uid.clone().unwrap_or_default(),
            name,
            namespace,
            kind: kind.clone(),
            group: group.clone(),
            version: version.clone(),
            age: obj.metadata.creation_timestamp.clone().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
            status,
            raw_json: String::new(),
            ready,
            restarts,
            node,
            ip,
        }
    };

    // Start the watcher in a background task
    let watch_id_clone = watch_id.clone();
    tokio::spawn(async move {
        let watcher_config = WatcherConfig::default();
        let mut stream = watcher(api, watcher_config).boxed();

        while let Ok(Some(event)) = stream.try_next().await {
            let watch_event = match event {
                WatcherEvent::Apply(obj) => {
                    // Apply is used for both ADDED and MODIFIED in kube-runtime
                    ResourceWatchEvent {
                        event_type: "MODIFIED".to_string(),
                        resource: to_summary(obj),
                    }
                }
                WatcherEvent::Delete(obj) => {
                    ResourceWatchEvent {
                        event_type: "DELETED".to_string(),
                        resource: to_summary(obj),
                    }
                }
                WatcherEvent::Init => {
                    // Initial sync starting - could emit a "SYNC_START" event
                    continue;
                }
                WatcherEvent::InitApply(obj) => {
                    // Initial list of existing resources
                    ResourceWatchEvent {
                        event_type: "ADDED".to_string(),
                        resource: to_summary(obj),
                    }
                }
                WatcherEvent::InitDone => {
                    // Initial sync complete - emit a marker event
                    let _ = app.emit(&format!("resource_watch_sync:{}", watch_id_clone), "SYNC_COMPLETE");
                    continue;
                }
            };

            let _ = app.emit(&format!("resource_watch:{}", watch_id_clone), watch_event);
        }

        // Stream ended - notify frontend
        let _ = app.emit(&format!("resource_watch_end:{}", watch_id_clone), ());
    });

    Ok(())
}

#[tauri::command]
async fn stop_resource_watch(_watch_id: String) -> Result<(), String> {
    // Watch streams auto-close when the task is dropped
    // For explicit control, we'd need to track JoinHandles in AppState
    Ok(())
}

// 5. EVENTS FETCHER (core/v1 + events.k8s.io/v1 merged)
#[tauri::command]
async fn list_events(state: State<'_, AppState>, namespace: String, name: String, uid: Option<String>) -> Result<Vec<K8sEvent>, String> {
    let client = create_client(state).await?;
    // Core/V1 Events (older API)
    let core_api: Api<k8s_openapi::api::core::v1::Event> = if namespace == "-" { Api::all(client.clone()) } else { Api::namespaced(client.clone(), &namespace) };
    // New events.k8s.io/V1 Events
    let new_api: Api<k8s_openapi::api::events::v1::Event> = if namespace == "-" { Api::all(client.clone()) } else { Api::namespaced(client.clone(), &namespace) };

    // Prefer server-side filtering when possible
    let lp = ListParams::default();

    // Collect core events (ignore errors individually so one API failure doesn't block)
    let core_events = match core_api.list(&lp).await {
        Ok(list) => list.into_iter().filter_map(|e| {
            let involved = &e.involved_object;
            let name_match = involved.name.as_deref().map_or(false, |n| n == name);
            let ns_match = involved.namespace.as_deref().map_or(true, |ns| ns == namespace);
            let uid_match = uid.as_ref().map_or(false, |u| involved.uid.as_deref() == Some(u.as_str()));
            if (name_match && ns_match) || uid_match {
                Some(K8sEvent {
                    message: e.message.unwrap_or_default(),
                    reason: e.reason.unwrap_or_default(),
                    type_: e.type_.unwrap_or_default(),
                    age: e.last_timestamp.map(|t| t.0.to_rfc3339()).unwrap_or_else(|| e.event_time.map(|t| t.0.to_rfc3339()).unwrap_or_default()),
                    count: e.count.unwrap_or(1),
                })
            } else { None }
        }).collect::<Vec<_>>(),
        Err(_) => vec![]
    };

    // Collect new events API
    let new_events = match new_api.list(&lp).await {
        Ok(list) => list.into_iter().filter_map(|e| {
            let regarding = &e.regarding; // ObjectReference
            let name_match = regarding.as_ref().and_then(|r| r.name.as_ref()).map_or(false, |n| n == &name);
            let ns_match = regarding.as_ref().and_then(|r| r.namespace.as_ref()).map_or(true, |ns| ns == &namespace);
            let uid_match = if let (Some(r), Some(wanted)) = (regarding, uid.as_ref()) { r.uid.as_deref() == Some(wanted.as_str()) } else { false };
            if (name_match && ns_match) || uid_match {
                Some(K8sEvent {
                    message: e.note.unwrap_or_default(),
                    reason: e.reason.unwrap_or_default(),
                    type_: e.type_.unwrap_or_default(),
                    age: e.event_time.map(|t| t.0.to_rfc3339()).unwrap_or_else(||
                        e.deprecated_last_timestamp.map(|t| t.0.to_rfc3339()).unwrap_or_default()
                    ),
                    count: e.deprecated_count.unwrap_or(e.series.as_ref().map(|s| s.count).unwrap_or(1)),
                })
            } else { None }
        }).collect::<Vec<_>>(),
        Err(_) => vec![]
    };

    let mut all = core_events;
    all.extend(new_events);
    // Sort newest first (string ISO 8601 lex order ok, but parse for safety)
    all.sort_by(|a, b| b.age.cmp(&a.age));
    Ok(all)
}

// 6. EXEC (TERMINAL)
// Pod Terminal Exec - Industry-standard implementation with larger buffers
#[tauri::command]
async fn start_exec(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    container: Option<String>,
    session_id: String
) -> Result<(), String> {
    // Clean up any existing session with same ID
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.remove(&session_id);
    }

    let client = create_client(state.clone()).await?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);

    let ap = AttachParams {
        container,
        stdin: true,
        stdout: true,
        stderr: false,  // Must be false when tty is true
        tty: true,
        ..Default::default()
    };

    // Use a more robust shell detection command
    let shell_cmd = vec![
        "/bin/sh", "-c",
        "command -v bash >/dev/null 2>&1 && exec bash -l || command -v sh >/dev/null 2>&1 && exec sh || exec /bin/sh"
    ];

    let mut attached = pods.exec(&name, shell_cmd, &ap).await.map_err(|e| e.to_string())?;

    let stdin_writer = attached.stdin().ok_or("Failed to get stdin")?;
    let mut stdout = attached.stdout().ok_or("Failed to get stdout")?;

    // Store stdin in session map
    let session = Arc::new(ExecSession {
        stdin: tokio::sync::Mutex::new(Box::new(stdin_writer)),
    });

    state.sessions.lock().unwrap().insert(session_id.clone(), session);

    // Spawn background task to read stdout with larger buffer
    let session_id_clone = session_id.clone();
    let app_handle = app.clone();
    let sessions_ref = state.sessions.clone();

    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        // 8KB buffer for faster terminal output
        let mut buf = vec![0u8; 8192];

        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app_handle.emit(&format!("term_output:{}", session_id_clone), data).is_err() {
                        break; // Frontend disconnected
                    }
                }
                Err(_) => break,
            }
        }

        // Clean up session on disconnect
        sessions_ref.lock().unwrap().remove(&session_id_clone);
        let _ = app_handle.emit(&format!("term_closed:{}", session_id_clone), ());
    });

    Ok(())
}

#[tauri::command]
async fn send_exec_input(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&session_id).cloned()
    };

    if let Some(session) = session {
        use tokio::io::AsyncWriteExt;
        let mut stdin = session.stdin.lock().await;
        stdin.write_all(data.as_bytes()).await.map_err(|e| e.to_string())?;
        // Don't flush on every keystroke - let the buffer handle it for better performance
        Ok(())
    } else {
        Err(format!("Session {} not found", session_id))
    }
}

#[tauri::command]
async fn resize_exec(_state: State<'_, AppState>, _session_id: String, _cols: u16, _rows: u16) -> Result<(), String> {
    // Note: kube-rs AttachedProcess doesn't expose resize easily yet without accessing the underlying websocket.
    // Real implementation requires sending a specific JSON message to the websocket.
    Ok(())
}



#[tauri::command]
async fn start_port_forward(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    local_port: u16,
    pod_port: u16
) -> Result<String, String> {
    let client = create_client(state.clone()).await?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);

    let session_id = format!("{}-{}-{}", namespace, name, local_port);

    // Check if already exists
    {
        let pfs = state.port_forwards.lock().unwrap();
        if pfs.contains_key(&session_id) {
            return Err(format!("Port forward for {} on port {} already exists", name, local_port));
        }
    }

    let pods_clone = pods.clone();
    let name_clone = name.clone();
    let _session_id_clone = session_id.clone();
    let app_handle = app.clone();

    // Spawn the listener task
    let handle = tokio::spawn(async move {
        let addr = format!("127.0.0.1:{}", local_port);
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                let _ = app_handle.emit("pf_error", format!("Failed to bind to {}: {}", addr, e));
                return;
            }
        };

        loop {
            match listener.accept().await {
                Ok((mut socket, _)) => {
                    let pods = pods_clone.clone();
                    let name = name_clone.clone();
                    
                    tokio::spawn(async move {
                        let mut pf = match pods.portforward(&name, &[pod_port]).await {
                            Ok(pf) => pf,
                            Err(e) => {
                                eprintln!("Failed to start port forward: {}", e);
                                return;
                            }
                        };
                        
                        let mut upstream = match pf.take_stream(pod_port) {
                            Some(s) => s,
                            None => return,
                        };

                        if let Err(e) = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await {
                            eprintln!("Port forward connection error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    eprintln!("Listener accept error: {}", e);
                }
            }
        }
    });

    let session = PortForwardSession {
        id: session_id.clone(),
        pod_name: name,
        namespace,
        local_port,
        pod_port,
        handle,
    };

    state.port_forwards.lock().unwrap().insert(session_id.clone(), session);

    Ok(session_id)
}

#[tauri::command]
async fn stop_port_forward(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut pfs = state.port_forwards.lock().unwrap();
    if let Some(session) = pfs.remove(&session_id) {
        session.handle.abort();
    }
    Ok(())
}

#[tauri::command]
async fn list_port_forwards(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let pfs = state.port_forwards.lock().unwrap();
    let list = pfs.values().map(|s| {
        serde_json::json!({
            "id": s.id,
            "pod_name": s.pod_name,
            "namespace": s.namespace,
            "local_port": s.local_port,
            "pod_port": s.pod_port,
        })
    }).collect();
    Ok(list)
}

// 7. APPLY YAML (Server-Side Apply)
#[tauri::command]
async fn apply_yaml(state: State<'_, AppState>, namespace: String, kind: String, name: String, yaml_content: String) -> Result<ResourceSummary, String> {
    let client = create_client(state).await?;
    
    // 1. Parse YAML to JSON Value
    let data: serde_json::Value = serde_yaml::from_str(&yaml_content).map_err(|e| format!("Invalid YAML: {}", e))?;

    // 2. Extract GVK from the payload or arguments
    // We trust the args 'kind' but we need Group/Version. 
    // Ideally we should parse apiVersion from the YAML.
    let api_version = data.get("apiVersion").and_then(|v| v.as_str()).ok_or("Missing apiVersion in YAML")?;
    let (group, version) = if api_version.contains('/') {
        let parts: Vec<&str> = api_version.split('/').collect();
        (parts[0], parts[1])
    } else {
        ("", api_version)
    };

    let gvk = GroupVersionKind::gvk(group, version, &kind);

    // 3. Resolve Resource
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, caps) = discovery.resolve_gvk(&gvk).ok_or("Resource kind not found")?;

    // 4. Create API
    let api: Api<DynamicObject> = if caps.scope == Scope::Namespaced {
        Api::namespaced_with(client, &namespace, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    // 5. Apply (Server-Side Apply)
    let pp = PatchParams::apply("opspilot").force();
    let patched = api.patch(&name, &pp, &Patch::Apply(&data)).await.map_err(|e| e.to_string())?;

    // 6. Return Summary
    let name = patched.metadata.name.clone().unwrap_or_default();
    let namespace = patched.metadata.namespace.clone().unwrap_or("-".into());
    let status = "Updated".to_string(); // Simplified for now

    Ok(ResourceSummary {
        id: patched.metadata.uid.clone().unwrap_or_default(),
        name,
        namespace,
        kind,
        group: group.to_string(),
        version: version.to_string(),
        age: patched.metadata.creation_timestamp.clone().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
        status,
        raw_json: serde_json::to_string_pretty(&patched).unwrap_or_default(),
        ready: None,
        restarts: None,
        node: None,
        ip: None,
    })
}

// 8. HELM INTEGRATION
#[derive(Serialize, Deserialize)]
struct HelmRelease {
    name: String,
    namespace: String,
    revision: String,
    updated: String,
    status: String,
    chart: String,
    app_version: String,
}

#[tauri::command]
async fn helm_list() -> Result<Vec<HelmRelease>, String> {
    let output = std::process::Command::new("helm")
        .args(&["list", "--all-namespaces", "-o", "json"])
        .output()
        .map_err(|e| format!("Failed to execute helm: {}", e))?;

    if !output.status.success() {
        return Err(format!("Helm failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let releases: Vec<HelmRelease> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse helm output: {}", e))?;

    Ok(releases)
}

#[tauri::command]
async fn helm_uninstall(namespace: String, name: String) -> Result<(), String> {
    let output = std::process::Command::new("helm")
        .args(&["uninstall", &name, "-n", &namespace])
        .output()
        .map_err(|e| format!("Failed to execute helm: {}", e))?;

    if !output.status.success() {
        return Err(format!("Helm uninstall failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    Ok(())
}

#[tauri::command]
async fn get_resource_metrics(
    state: State<'_, AppState>,
    kind: String,
    namespace: Option<String>,
) -> Result<Vec<ResourceMetrics>, String> {
    let client = create_client(state.clone()).await?;
    
    let metrics_group = if kind == "Pod" {
        "metrics.k8s.io"
    } else if kind == "Node" {
        "metrics.k8s.io"
    } else {
        return Err("Only Pod and Node metrics are supported".to_string());
    };
    
    let gvk = GroupVersionKind {
        group: metrics_group.to_string(),
        version: "v1beta1".to_string(),
        kind: format!("{}Metrics", kind),
    };
    
    let api_resource = kube::discovery::ApiResource {
        group: metrics_group.to_string(),
        version: "v1beta1".to_string(),
        api_version: format!("{}/v1beta1", metrics_group),
        kind: gvk.kind.clone(),
        plural: format!("{}s", kind.to_lowercase()),
    };
    
    let api: Api<DynamicObject> = if let Some(ref ns) = namespace {
        Api::namespaced_with(client.clone(), ns, &api_resource)
    } else {
        Api::all_with(client.clone(), &api_resource)
    };
    
    let list = api.list(&ListParams::default())
        .await
        .map_err(|e| format!("Metrics API error: {}. Ensure metrics-server is installed.", e))?;

    // Get pod specs to extract resource limits (only for pods) - with caching
    let pod_limits: HashMap<String, (Option<u64>, Option<u64>)> = if kind == "Pod" {
        // Check cache first (30 second TTL)
        let cached = {
            if let Ok(cache) = state.pod_limits_cache.try_lock() {
                if let Some((timestamp, limits)) = &*cache {
                    if timestamp.elapsed().as_secs() < 30 {
                        Some(limits.clone())
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(limits) = cached {
            limits
        } else {
            // Fetch fresh pod limits
            let pod_api: Api<DynamicObject> = if let Some(ref ns) = namespace {
                Api::namespaced_with(client.clone(), ns, &kube::discovery::ApiResource {
                    group: "".to_string(),
                    version: "v1".to_string(),
                    api_version: "v1".to_string(),
                    kind: "Pod".to_string(),
                    plural: "pods".to_string(),
                })
            } else {
                Api::all_with(client.clone(), &kube::discovery::ApiResource {
                    group: "".to_string(),
                    version: "v1".to_string(),
                    api_version: "v1".to_string(),
                    kind: "Pod".to_string(),
                    plural: "pods".to_string(),
                })
            };

            let limits = if let Ok(pods) = pod_api.list(&ListParams::default()).await {
                pods.into_iter().filter_map(|pod| {
                    let name = pod.metadata.name.clone()?;
                    let spec = pod.data.get("spec")?;
                    let containers = spec.get("containers")?.as_array()?;

                    let mut total_cpu_limit = 0u64;
                    let mut total_memory_limit = 0u64;
                    let mut has_cpu = false;
                    let mut has_memory = false;

                    for container in containers {
                        if let Some(resources) = container.get("resources") {
                            if let Some(limits) = resources.get("limits") {
                                if let Some(cpu) = limits.get("cpu").and_then(|v| v.as_str()) {
                                    total_cpu_limit += parse_cpu_to_nano(cpu);
                                    has_cpu = true;
                                }
                                if let Some(memory) = limits.get("memory").and_then(|v| v.as_str()) {
                                    total_memory_limit += parse_memory_to_bytes(memory);
                                    has_memory = true;
                                }
                            }
                        }
                    }

                    Some((
                        name,
                        (
                            if has_cpu { Some(total_cpu_limit) } else { None },
                            if has_memory { Some(total_memory_limit) } else { None }
                        )
                    ))
                }).collect()
            } else {
                HashMap::new()
            };

            // Update cache
            if let Ok(mut cache) = state.pod_limits_cache.try_lock() {
                *cache = Some((std::time::Instant::now(), limits.clone()));
            }

            limits
        }
    } else {
        HashMap::new()
    };
    
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    
    let mut metrics = Vec::new();
    for item in list {
        let name = item.metadata.name.clone().unwrap_or_default();
        let ns = item.metadata.namespace.clone().unwrap_or_default();
        
        // Extract CPU and Memory from containers
        let mut total_cpu_nano = 0u64;
        let mut total_memory_bytes = 0u64;
        
        if kind == "Pod" {
            if let Some(containers) = item.data.get("containers").and_then(|v| v.as_array()) {
                for container in containers {
                    if let Some(usage) = container.get("usage") {
                        if let Some(cpu) = usage.get("cpu").and_then(|v| v.as_str()) {
                            total_cpu_nano += parse_cpu_to_nano(cpu);
                        }
                        if let Some(memory) = usage.get("memory").and_then(|v| v.as_str()) {
                            total_memory_bytes += parse_memory_to_bytes(memory);
                        }
                    }
                }
            }
        } else if kind == "Node" {
            if let Some(usage) = item.data.get("usage") {
                if let Some(cpu) = usage.get("cpu").and_then(|v| v.as_str()) {
                    total_cpu_nano = parse_cpu_to_nano(cpu);
                }
                if let Some(memory) = usage.get("memory").and_then(|v| v.as_str()) {
                    total_memory_bytes = parse_memory_to_bytes(memory);
                }
            }
        }
        
        let cpu_str = format_cpu(total_cpu_nano);
        let memory_str = format_memory(total_memory_bytes);
        
        let (cpu_limit, memory_limit) = pod_limits.get(&name).cloned().unwrap_or((None, None));
        
        let cpu_percent = if let Some(limit) = cpu_limit {
            if limit > 0 {
                Some((total_cpu_nano as f64 / limit as f64) * 100.0)
            } else {
                None
            }
        } else {
            None
        };
        
        let memory_percent = if let Some(limit) = memory_limit {
            if limit > 0 {
                Some((total_memory_bytes as f64 / limit as f64) * 100.0)
            } else {
                None
            }
        } else {
            None
        };
        
        metrics.push(ResourceMetrics {
            name,
            namespace: ns,
            cpu: cpu_str,
            memory: memory_str,
            cpu_nano: total_cpu_nano,
            memory_bytes: total_memory_bytes,
            cpu_limit_nano: cpu_limit,
            memory_limit_bytes: memory_limit,
            cpu_percent,
            memory_percent,
            timestamp,
        });
    }
    
    Ok(metrics)
}

fn parse_cpu_to_nano(cpu: &str) -> u64 {
    if cpu.ends_with('n') {
        cpu.trim_end_matches('n').parse().unwrap_or(0)
    } else if cpu.ends_with('u') {
        cpu.trim_end_matches('u').parse::<u64>().unwrap_or(0) * 1000
    } else if cpu.ends_with('m') {
        cpu.trim_end_matches('m').parse::<u64>().unwrap_or(0) * 1_000_000
    } else {
        cpu.parse::<u64>().unwrap_or(0) * 1_000_000_000
    }
}

fn parse_memory_to_bytes(memory: &str) -> u64 {
    let memory = memory.trim();
    if memory.ends_with("Ki") {
        memory.trim_end_matches("Ki").parse::<u64>().unwrap_or(0) * 1024
    } else if memory.ends_with("Mi") {
        memory.trim_end_matches("Mi").parse::<u64>().unwrap_or(0) * 1024 * 1024
    } else if memory.ends_with("Gi") {
        memory.trim_end_matches("Gi").parse::<u64>().unwrap_or(0) * 1024 * 1024 * 1024
    } else if memory.ends_with("Ti") {
        memory.trim_end_matches("Ti").parse::<u64>().unwrap_or(0) * 1024 * 1024 * 1024 * 1024
    } else {
        memory.parse::<u64>().unwrap_or(0)
    }
}

fn format_cpu(nano: u64) -> String {
    if nano >= 1_000_000_000 {
        format!("{:.2}", nano as f64 / 1_000_000_000.0)
    } else if nano >= 1_000_000 {
        format!("{}m", nano / 1_000_000)
    } else if nano >= 1000 {
        format!("{}u", nano / 1000)
    } else {
        format!("{}n", nano)
    }
}

fn format_memory(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2}Gi", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.2}Mi", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.2}Ki", bytes as f64 / 1024.0)
    } else {
        format!("{}B", bytes)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            use std::env;
            let key = "PATH";
            let current_path = env::var(key).unwrap_or_default();
            
            // Common paths that might be missing in GUI environment
            let mut paths_to_add: Vec<&str> = Vec::new();
            
            #[cfg(target_os = "macos")]
            {
                paths_to_add.push("/usr/local/bin");
                paths_to_add.push("/opt/homebrew/bin");
            }

            #[cfg(target_os = "linux")]
            {
                paths_to_add.push("/usr/local/bin");
                paths_to_add.push("/snap/bin");
                paths_to_add.push("/home/linuxbrew/.linuxbrew/bin");
            }

            if !paths_to_add.is_empty() {
                // Check if path is already there to avoid duplicates (simple check)
                let separator = ":"; // Unix separator
                let mut new_path = current_path.clone();
                
                for p in paths_to_add {
                    if !new_path.contains(p) {
                        new_path = format!("{}{}{}", new_path, separator, p);
                    }
                }
                env::set_var(key, new_path);
            }
            Ok(())
        })
        .manage(AppState {
            kubeconfig_path: Mutex::new(None),
            selected_context: Mutex::new(None),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            shell_sessions: Arc::new(Mutex::new(HashMap::new())),
            port_forwards: Arc::new(Mutex::new(HashMap::new())),
            log_streams: Arc::new(Mutex::new(HashMap::new())),
            discovery_cache: Arc::new(Mutex::new(None)),
            vcluster_cache: Arc::new(Mutex::new(None)),
            cluster_stats_cache: Arc::new(Mutex::new(None)),
            pod_limits_cache: Arc::new(Mutex::new(None)),
            client_cache: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            discover_api_resources, 
            list_resources,
            get_resource_details,
            get_resource_metrics,
            delete_resource,
            list_contexts,
            delete_context,
            set_kube_config,
            get_pod_logs,
            start_log_stream,
            stop_log_stream,
            start_resource_watch,
            stop_resource_watch,
            list_events,
            start_exec,
            send_exec_input,
            resize_exec,
            start_port_forward,
            stop_port_forward,
            list_port_forwards,
            apply_yaml,
            helm_list,
            helm_uninstall,
            get_current_context_name,
            start_local_shell,
            send_shell_input,
            resize_shell,
            stop_local_shell,
            get_cluster_stats,
            get_cluster_cockpit,
            get_cluster_health_summary,
            get_cluster_events_summary,
            get_initial_cluster_data,
            list_azure_subscriptions,
            list_aks_clusters,
            get_aks_credentials,
            refresh_azure_data,
            azure_login,
            connect_vcluster,
            list_vclusters,
            get_topology_graph,
            get_topology_graph_opts,
            list_crds,
            clear_discovery_cache,
            clear_all_caches,
            reset_state,
            ai_local::call_local_llm,
            ai_local::call_local_llm_with_tools,
            ai_local::check_ollama_status,
            ai_local::call_llm,
            ai_local::check_llm_status,
            ai_local::get_default_llm_config,
            test_connectivity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn test_connectivity(context: String, path: Option<String>) -> Result<String, String> {
    // 1. Create client options with context
    let options = KubeConfigOptions {
        context: Some(context),
        ..Default::default()
    };
    
    // 2. Load kubeconfig
    let kubeconfig = if let Some(p) = path {
        Kubeconfig::read_from(p).map_err(|e| e.to_string())?
    } else {
        Kubeconfig::read().map_err(|e| e.to_string())?
    };

    // 3. Create config with options
    let config = kube::Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|e| e.to_string())?;

    // 4. Set aggressive timeout for quick feedback
    let mut config = config;
    config.connect_timeout = Some(std::time::Duration::from_secs(2));
    config.read_timeout = Some(std::time::Duration::from_secs(2));
    config.write_timeout = Some(std::time::Duration::from_secs(2));

    let client = Client::try_from(config).map_err(|e| e.to_string())?;

    // 5. Try a lightweight call with tokio timeout wrapper
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        client.list_api_groups()
    )
    .await
    .map_err(|_| "Connection timeout - cluster may be unreachable".to_string())?
    .map_err(|e| format!("Cluster unreachable: {}", e))?;

    Ok("Connected".to_string())
}

#[tauri::command]
async fn get_current_context_name(state: State<'_, AppState>, custom_path: Option<String>) -> Result<String, String> {
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

// Local Shell Terminal - Industry-standard PTY implementation
#[tauri::command]
async fn start_local_shell(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Clean up any existing session
    {
        let mut sessions = state.shell_sessions.lock().unwrap();
        sessions.remove(&session_id);
    }

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 30,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = CommandBuilder::new("powershell");
        c.args(["-NoLogo", "-NoExit"]);
        c
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut c = CommandBuilder::new(&shell);
        // Start as login shell for proper environment
        c.arg("-l");
        c
    };

    // Set TERM for proper color support
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = ShellSession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
    };

    state.shell_sessions.lock().unwrap().insert(session_id.clone(), Arc::new(session));

    // Spawn reader thread with larger buffer for fast output
    let session_id_clone = session_id.clone();
    let app_handle = app.clone();
    let shell_sessions = state.shell_sessions.clone();

    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16384]; // 16KB buffer for fast reads
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app_handle.emit(&format!("shell_output:{}", session_id_clone), data).is_err() {
                        break; // Frontend disconnected
                    }
                }
                Ok(_) => break, // EOF
                Err(_) => break,
            }
        }
        // Clean up on exit
        shell_sessions.lock().unwrap().remove(&session_id_clone);
        let _ = app_handle.emit(&format!("shell_closed:{}", session_id_clone), ());
    });

    Ok(())
}

#[tauri::command]
async fn send_shell_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.shell_sessions.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        if let Ok(mut writer) = session.writer.lock() {
            writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn resize_shell(
    state: State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.shell_sessions.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        if let Ok(master) = session.master.lock() {
            master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Stop/kill a local shell session
#[tauri::command]
async fn stop_local_shell(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.shell_sessions.lock().unwrap();
    sessions.remove(&session_id);
    Ok(())
}

#[tauri::command]
async fn get_cluster_stats(state: State<'_, AppState>) -> Result<ClusterStats, String> {
    // Check cache first (15 second TTL for stats)
    if let Ok(cache) = state.cluster_stats_cache.try_lock() {
        if let Some((timestamp, cached_stats)) = &*cache {
            if timestamp.elapsed().as_secs() < 15 {
                return Ok(cached_stats.clone());
            }
        }
    }

    let client = create_client(state.clone()).await?;

    let nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
    let deployments: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());
    let services: Api<k8s_openapi::api::core::v1::Service> = Api::all(client.clone());
    let namespaces: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());

    let lp = ListParams::default();

    // Parallel Execution
    let (nodes_res, pods_res, deployments_res, services_res, namespaces_res) = tokio::join!(
        nodes.list(&lp),
        pods.list(&lp),
        deployments.list(&lp),
        services.list(&lp),
        namespaces.list(&lp)
    );

    // Critical: If nodes fail, the cluster is likely unreachable. Propagate error.
    let nodes_count = nodes_res.map_err(|e| format!("Cluster unreachable: {}", e))?.items.len();

    let pods_count = match pods_res {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list pods: {}", e);
            0
        }
    };

    let deployments_count = match deployments_res {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list deployments: {}", e);
            0
        }
    };

    let services_count = match services_res {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list services: {}", e);
            0
        }
    };

    let namespaces_count = match namespaces_res {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list namespaces: {}", e);
            0
        }
    };

    let stats = ClusterStats {
        nodes: nodes_count,
        pods: pods_count,
        deployments: deployments_count,
        services: services_count,
        namespaces: namespaces_count,
    };

    // Update cache
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), stats.clone()));
    }

    Ok(stats)
}

#[tauri::command]
async fn get_cluster_cockpit(state: State<'_, AppState>) -> Result<ClusterCockpitData, String> {
    let client = create_client(state.clone()).await?;

    let nodes_api: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let pods_api: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
    let deployments_api: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());
    let services_api: Api<k8s_openapi::api::core::v1::Service> = Api::all(client.clone());
    let namespaces_api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());

    // Also fetch node metrics
    let node_metrics_api: Api<DynamicObject> = Api::all_with(client.clone(), &kube::discovery::ApiResource {
        group: "metrics.k8s.io".to_string(),
        version: "v1beta1".to_string(),
        api_version: "metrics.k8s.io/v1beta1".to_string(),
        kind: "NodeMetrics".to_string(),
        plural: "nodes".to_string(),
    });

    let lp = ListParams::default();

    // Parallel Execution
    let (nodes_res, pods_res, deployments_res, services_res, namespaces_res, node_metrics_res) = tokio::join!(
        nodes_api.list(&lp),
        pods_api.list(&lp),
        deployments_api.list(&lp),
        services_api.list(&lp),
        namespaces_api.list(&lp),
        node_metrics_api.list(&lp)
    );

    // Process nodes
    let nodes_list = nodes_res.map_err(|e| format!("Cluster unreachable: {}", e))?;
    let pods_items: Vec<_> = pods_res.map(|l| l.items).unwrap_or_default();
    let deployments_items: Vec<_> = deployments_res.map(|l| l.items).unwrap_or_default();
    let services_count = services_res.map(|l| l.items.len()).unwrap_or(0);
    let namespaces_count = namespaces_res.map(|l| l.items.len()).unwrap_or(0);
    let node_metrics_list = node_metrics_res.ok();

    // Build node metrics map
    let node_metrics_map: std::collections::HashMap<String, (u64, u64)> = node_metrics_list
        .map(|list| {
            list.items.into_iter().filter_map(|item| {
                let name = item.metadata.name?;
                let usage = item.data.get("usage")?;
                let cpu = usage.get("cpu").and_then(|v| v.as_str()).map(parse_cpu_to_nano).unwrap_or(0);
                let memory = usage.get("memory").and_then(|v| v.as_str()).map(parse_memory_to_bytes).unwrap_or(0);
                Some((name, (cpu, memory)))
            }).collect()
        })
        .unwrap_or_default();

    // Count pods per node and calculate resource usage from pod requests (fallback when metrics unavailable)
    let mut pods_per_node: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut pod_resources_per_node: std::collections::HashMap<String, (u64, u64)> = std::collections::HashMap::new(); // (cpu_milli, memory_bytes)

    for pod in &pods_items {
        if let Some(spec) = pod.spec.as_ref() {
            if let Some(node_name) = spec.node_name.as_ref() {
                *pods_per_node.entry(node_name.clone()).or_insert(0) += 1;

                // Only count running pods for resource usage estimation
                let phase = pod.status.as_ref().and_then(|s| s.phase.as_ref()).map(|s| s.as_str()).unwrap_or("");
                if phase == "Running" {
                    // Sum up container resource requests
                    let entry = pod_resources_per_node.entry(node_name.clone()).or_insert((0, 0));
                    for container in &spec.containers {
                        if let Some(resources) = &container.resources {
                            if let Some(requests) = &resources.requests {
                                if let Some(cpu) = requests.get("cpu") {
                                    entry.0 += parse_cpu_to_milli(&cpu.0);
                                }
                                if let Some(mem) = requests.get("memory") {
                                    entry.1 += parse_memory_to_bytes(&mem.0);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Determine if we have real metrics (if any node has metrics data)
    let has_real_metrics = !node_metrics_map.is_empty();

    // Process pod status breakdown
    let mut pod_status = PodStatusBreakdown {
        running: 0,
        pending: 0,
        succeeded: 0,
        failed: 0,
        unknown: 0,
    };

    // Count pods per namespace with metrics
    let mut namespace_usage: std::collections::HashMap<String, (usize, u64, u64)> = std::collections::HashMap::new();

    for pod in &pods_items {
        let phase = pod.status.as_ref().and_then(|s| s.phase.as_ref()).map(|s| s.as_str()).unwrap_or("Unknown");
        match phase {
            "Running" => pod_status.running += 1,
            "Pending" => pod_status.pending += 1,
            "Succeeded" => pod_status.succeeded += 1,
            "Failed" => pod_status.failed += 1,
            _ => pod_status.unknown += 1,
        }

        // Count by namespace
        let ns = pod.metadata.namespace.clone().unwrap_or_default();
        let entry = namespace_usage.entry(ns).or_insert((0, 0, 0));
        entry.0 += 1;
    }

    // Process nodes
    let mut total_cpu_capacity: u64 = 0;
    let mut total_cpu_allocatable: u64 = 0;
    let mut total_cpu_usage: u64 = 0;
    let mut total_memory_capacity: u64 = 0;
    let mut total_memory_allocatable: u64 = 0;
    let mut total_memory_usage: u64 = 0;
    let mut total_pods_capacity: u32 = 0;
    let mut healthy_nodes = 0;
    let mut warning_count = 0;
    let mut critical_count = 0;

    let nodes: Vec<NodeHealth> = nodes_list.items.iter().map(|node| {
        let name = node.metadata.name.clone().unwrap_or_default();
        let status_obj = node.status.as_ref();
        let spec = node.spec.as_ref();

        // Get conditions
        let conditions: Vec<NodeCondition> = status_obj
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| conds.iter().map(|c| NodeCondition {
                type_: c.type_.clone(),
                status: c.status.clone(),
                message: c.message.clone().unwrap_or_default(),
            }).collect())
            .unwrap_or_default();

        // Check if node is healthy (Ready condition is True)
        let is_ready = conditions.iter().any(|c| c.type_ == "Ready" && c.status == "True");
        let status = if is_ready { "Ready" } else { "NotReady" };
        if is_ready {
            healthy_nodes += 1;
        } else {
            critical_count += 1;
        }

        // Check for warning conditions
        for cond in &conditions {
            if cond.type_ != "Ready" && cond.status == "True" {
                warning_count += 1;
            }
        }

        // Get taints
        let taints: Vec<String> = spec
            .and_then(|s| s.taints.as_ref())
            .map(|t| t.iter().map(|taint| {
                format!("{}={:?}:{}", taint.key, taint.value.clone().unwrap_or_default(), taint.effect)
            }).collect())
            .unwrap_or_default();

        // Parse capacity and allocatable
        let capacity = status_obj.and_then(|s| s.capacity.as_ref());
        let allocatable = status_obj.and_then(|s| s.allocatable.as_ref());

        let cpu_capacity = capacity.and_then(|c| c.get("cpu")).map(|q| parse_cpu_to_milli(&q.0)).unwrap_or(0);
        let cpu_allocatable = allocatable.and_then(|a| a.get("cpu")).map(|q| parse_cpu_to_milli(&q.0)).unwrap_or(0);
        let memory_capacity = capacity.and_then(|c| c.get("memory")).map(|q| parse_memory_to_bytes(&q.0)).unwrap_or(0);
        let memory_allocatable = allocatable.and_then(|a| a.get("memory")).map(|q| parse_memory_to_bytes(&q.0)).unwrap_or(0);
        let pods_capacity = capacity.and_then(|c| c.get("pods")).map(|q| q.0.parse::<u32>().unwrap_or(0)).unwrap_or(0);

        // Get usage from metrics, or fall back to pod requests if metrics unavailable
        let (cpu_usage, memory_usage) = if has_real_metrics {
            let (cpu_usage_nano, mem) = node_metrics_map.get(&name).cloned().unwrap_or((0, 0));
            (cpu_usage_nano / 1_000_000, mem) // Convert nano to milli
        } else {
            // Fallback: use sum of pod resource requests as an approximation
            pod_resources_per_node.get(&name).cloned().unwrap_or((0, 0))
        };

        // Update totals
        total_cpu_capacity += cpu_capacity;
        total_cpu_allocatable += cpu_allocatable;
        total_cpu_usage += cpu_usage;
        total_memory_capacity += memory_capacity;
        total_memory_allocatable += memory_allocatable;
        total_memory_usage += memory_usage;
        total_pods_capacity += pods_capacity;

        let pods_running = pods_per_node.get(&name).cloned().unwrap_or(0);

        NodeHealth {
            name,
            status: status.to_string(),
            cpu_capacity,
            cpu_allocatable,
            cpu_usage,
            memory_capacity,
            memory_allocatable,
            memory_usage,
            pods_capacity,
            pods_running,
            conditions,
            taints,
        }
    }).collect();

    // Get unhealthy deployments
    let unhealthy_deployments: Vec<DeploymentHealth> = deployments_items.iter()
        .filter_map(|dep| {
            let name = dep.metadata.name.clone()?;
            let namespace = dep.metadata.namespace.clone().unwrap_or_default();
            let status = dep.status.as_ref()?;
            let spec = dep.spec.as_ref()?;

            let desired = spec.replicas.unwrap_or(1) as u32;
            let ready = status.ready_replicas.unwrap_or(0) as u32;
            let available = status.available_replicas.unwrap_or(0) as u32;
            let up_to_date = status.updated_replicas.unwrap_or(0) as u32;

            // Only include unhealthy ones
            if ready < desired || available < desired {
                warning_count += 1;
                Some(DeploymentHealth {
                    name,
                    namespace,
                    desired,
                    ready,
                    available,
                    up_to_date,
                })
            } else {
                None
            }
        })
        .take(10) // Limit to top 10
        .collect();

    // Get top namespaces by pod count
    let mut top_namespaces: Vec<NamespaceUsage> = namespace_usage.into_iter()
        .map(|(name, (pod_count, cpu, mem))| NamespaceUsage {
            name,
            pod_count,
            cpu_usage: cpu,
            memory_usage: mem,
        })
        .collect();
    top_namespaces.sort_by(|a, b| b.pod_count.cmp(&a.pod_count));
    top_namespaces.truncate(10);

    Ok(ClusterCockpitData {
        total_nodes: nodes_list.items.len(),
        healthy_nodes,
        total_pods: pods_items.len(),
        total_deployments: deployments_items.len(),
        total_services: services_count,
        total_namespaces: namespaces_count,
        total_cpu_capacity,
        total_cpu_allocatable,
        total_cpu_usage,
        total_memory_capacity,
        total_memory_allocatable,
        total_memory_usage,
        total_pods_capacity,
        pod_status,
        nodes,
        unhealthy_deployments,
        top_namespaces,
        warning_count,
        critical_count,
        metrics_available: has_real_metrics,
    })
}

// Cluster-wide health summary for AI chat
#[tauri::command]
async fn get_cluster_health_summary(state: State<'_, AppState>) -> Result<ClusterHealthSummary, String> {
    let client = create_client(state.clone()).await?;

    let nodes_api: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let pods_api: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
    let deployments_api: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());

    let lp = ListParams::default();

    let (nodes_res, pods_res, deployments_res) = tokio::join!(
        nodes_api.list(&lp),
        pods_api.list(&lp),
        deployments_api.list(&lp)
    );

    let nodes = nodes_res.map_err(|e| format!("Failed to list nodes: {}", e))?;
    let pods = pods_res.map_err(|e| format!("Failed to list pods: {}", e))?;
    let deployments = deployments_res.map_err(|e| format!("Failed to list deployments: {}", e))?;

    // Process nodes
    let mut ready_nodes = 0;
    let mut not_ready_nodes = Vec::new();
    let mut total_cpu_capacity: u64 = 0;
    let mut total_cpu_usage: u64 = 0;
    let mut total_memory_capacity: u64 = 0;
    let mut total_memory_usage: u64 = 0;
    let mut critical_issues: Vec<ClusterIssue> = Vec::new();
    let mut warnings: Vec<ClusterIssue> = Vec::new();

    for node in &nodes.items {
        let name = node.metadata.name.clone().unwrap_or_default();
        let is_ready = node.status.as_ref()
            .and_then(|s| s.conditions.as_ref())
            .and_then(|conds| conds.iter().find(|c| c.type_ == "Ready"))
            .map(|c| c.status == "True")
            .unwrap_or(false);

        if is_ready {
            ready_nodes += 1;
        } else {
            not_ready_nodes.push(name.clone());
            critical_issues.push(ClusterIssue {
                severity: "critical".to_string(),
                resource_kind: "Node".to_string(),
                resource_name: name.clone(),
                namespace: "".to_string(),
                message: "Node is not ready".to_string(),
            });
        }

        // Get capacity
        if let Some(status) = &node.status {
            if let Some(capacity) = &status.capacity {
                if let Some(cpu) = capacity.get("cpu") {
                    total_cpu_capacity += parse_cpu_to_milli(&cpu.0);
                }
                if let Some(mem) = capacity.get("memory") {
                    total_memory_capacity += parse_memory_to_bytes(&mem.0);
                }
            }
        }
    }

    // Process pods
    let mut running_pods = 0;
    let mut pending_pods = 0;
    let mut failed_pods = 0;
    let mut crashloop_pods: Vec<PodIssue> = Vec::new();

    for pod in &pods.items {
        let name = pod.metadata.name.clone().unwrap_or_default();
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        let phase = pod.status.as_ref()
            .and_then(|s| s.phase.as_ref())
            .map(|s| s.as_str())
            .unwrap_or("Unknown");

        match phase {
            "Running" => running_pods += 1,
            "Pending" => {
                pending_pods += 1;
                // Check if pending for too long or has issues
                if let Some(status) = &pod.status {
                    if let Some(conditions) = &status.conditions {
                        for cond in conditions {
                            if cond.type_ == "PodScheduled" && cond.status == "False" {
                                warnings.push(ClusterIssue {
                                    severity: "warning".to_string(),
                                    resource_kind: "Pod".to_string(),
                                    resource_name: name.clone(),
                                    namespace: namespace.clone(),
                                    message: cond.message.clone().unwrap_or_else(|| "Pod cannot be scheduled".to_string()),
                                });
                            }
                        }
                    }
                }
            }
            "Failed" => {
                failed_pods += 1;
                critical_issues.push(ClusterIssue {
                    severity: "critical".to_string(),
                    resource_kind: "Pod".to_string(),
                    resource_name: name.clone(),
                    namespace: namespace.clone(),
                    message: "Pod has failed".to_string(),
                });
            }
            _ => {}
        }

        // Check for crashloop
        if let Some(status) = &pod.status {
            if let Some(container_statuses) = &status.container_statuses {
                for cs in container_statuses {
                    let restart_count = cs.restart_count as u32;
                    if restart_count > 5 {
                        let (reason, message) = if let Some(waiting) = &cs.state.as_ref().and_then(|s| s.waiting.as_ref()) {
                            (
                                waiting.reason.clone().unwrap_or_default(),
                                waiting.message.clone().unwrap_or_default()
                            )
                        } else {
                            ("Unknown".to_string(), "".to_string())
                        };

                        crashloop_pods.push(PodIssue {
                            name: name.clone(),
                            namespace: namespace.clone(),
                            status: phase.to_string(),
                            restart_count,
                            reason: reason.clone(),
                            message: message.clone(),
                        });

                        critical_issues.push(ClusterIssue {
                            severity: "critical".to_string(),
                            resource_kind: "Pod".to_string(),
                            resource_name: name.clone(),
                            namespace: namespace.clone(),
                            message: format!("Container {} has restarted {} times. Reason: {}", cs.name, restart_count, reason),
                        });
                    }
                }
            }
        }

        // Estimate resource usage from requests
        if let Some(spec) = &pod.spec {
            if phase == "Running" {
                for container in &spec.containers {
                    if let Some(resources) = &container.resources {
                        if let Some(requests) = &resources.requests {
                            if let Some(cpu) = requests.get("cpu") {
                                total_cpu_usage += parse_cpu_to_milli(&cpu.0);
                            }
                            if let Some(mem) = requests.get("memory") {
                                total_memory_usage += parse_memory_to_bytes(&mem.0);
                            }
                        }
                    }
                }
            }
        }
    }

    // Process deployments
    let mut healthy_deployments = 0;
    let mut unhealthy_deps: Vec<DeploymentIssue> = Vec::new();

    for dep in &deployments.items {
        let name = dep.metadata.name.clone().unwrap_or_default();
        let namespace = dep.metadata.namespace.clone().unwrap_or_default();
        let desired = dep.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1) as u32;
        let ready = dep.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0) as u32;
        let available = dep.status.as_ref().and_then(|s| s.available_replicas).unwrap_or(0) as u32;

        if ready >= desired && available >= desired {
            healthy_deployments += 1;
        } else {
            let reason = if ready < desired {
                format!("Only {}/{} replicas ready", ready, desired)
            } else {
                format!("Only {}/{} replicas available", available, desired)
            };

            unhealthy_deps.push(DeploymentIssue {
                name: name.clone(),
                namespace: namespace.clone(),
                desired,
                ready,
                available,
                reason: reason.clone(),
            });

            warnings.push(ClusterIssue {
                severity: "warning".to_string(),
                resource_kind: "Deployment".to_string(),
                resource_name: name,
                namespace,
                message: reason,
            });
        }
    }

    // Calculate percentages
    let cluster_cpu_percent = if total_cpu_capacity > 0 {
        (total_cpu_usage as f64 / total_cpu_capacity as f64) * 100.0
    } else {
        0.0
    };
    let cluster_memory_percent = if total_memory_capacity > 0 {
        (total_memory_usage as f64 / total_memory_capacity as f64) * 100.0
    } else {
        0.0
    };

    // Sort issues by severity
    critical_issues.truncate(20); // Limit to top 20
    warnings.truncate(20);

    Ok(ClusterHealthSummary {
        total_nodes: nodes.items.len(),
        ready_nodes,
        not_ready_nodes,
        total_pods: pods.items.len(),
        running_pods,
        pending_pods,
        failed_pods,
        crashloop_pods,
        total_deployments: deployments.items.len(),
        healthy_deployments,
        unhealthy_deployments: unhealthy_deps,
        cluster_cpu_percent,
        cluster_memory_percent,
        critical_issues,
        warnings,
    })
}

// Get cluster-wide events for AI chat
#[tauri::command]
async fn get_cluster_events_summary(
    state: State<'_, AppState>,
    namespace: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ClusterEventSummary>, String> {
    let client = create_client(state.clone()).await?;

    let events_api: Api<k8s_openapi::api::core::v1::Event> = if let Some(ns) = &namespace {
        Api::namespaced(client, ns)
    } else {
        Api::all(client)
    };

    let lp = ListParams::default();
    let events = events_api.list(&lp).await.map_err(|e| format!("Failed to list events: {}", e))?;

    let limit = limit.unwrap_or(50) as usize;
    let mut summaries: Vec<ClusterEventSummary> = events.items.iter()
        .filter(|e| e.type_.as_ref().map(|t| t == "Warning").unwrap_or(false) || e.count.unwrap_or(1) > 1)
        .take(limit)
        .map(|e| ClusterEventSummary {
            namespace: e.metadata.namespace.clone().unwrap_or_default(),
            name: e.involved_object.name.clone().unwrap_or_default(),
            kind: e.involved_object.kind.clone().unwrap_or_default(),
            reason: e.reason.clone().unwrap_or_default(),
            message: e.message.clone().unwrap_or_default(),
            count: e.count.unwrap_or(1) as u32,
            last_seen: e.last_timestamp.as_ref().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
            event_type: e.type_.clone().unwrap_or_else(|| "Normal".to_string()),
        })
        .collect();

    // Sort by count (most frequent first) then by time
    summaries.sort_by(|a, b| b.count.cmp(&a.count));

    Ok(summaries)
}

fn parse_cpu_to_milli(cpu: &str) -> u64 {
    if cpu.ends_with('m') {
        cpu.trim_end_matches('m').parse::<u64>().unwrap_or(0)
    } else if cpu.ends_with('n') {
        cpu.trim_end_matches('n').parse::<u64>().unwrap_or(0) / 1_000_000
    } else {
        // Assume cores
        (cpu.parse::<f64>().unwrap_or(0.0) * 1000.0) as u64
    }
}

// Fast initial cluster data fetch - gets all commonly needed data in one call
#[tauri::command]
async fn get_initial_cluster_data(state: State<'_, AppState>) -> Result<InitialClusterData, String> {
    let client = create_client(state.clone()).await?;

    let nodes_api: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let pods_api: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
    let deployments_api: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());
    let services_api: Api<k8s_openapi::api::core::v1::Service> = Api::all(client.clone());
    let namespaces_api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());

    let lp = ListParams::default();

    // Parallel Execution - fetch all resources at once
    let (nodes_res, pods_res, deployments_res, services_res, namespaces_res) = tokio::join!(
        nodes_api.list(&lp),
        pods_api.list(&lp),
        deployments_api.list(&lp),
        services_api.list(&lp),
        namespaces_api.list(&lp)
    );

    // Process nodes - this is required, fail if unavailable
    let nodes_list = nodes_res.map_err(|e| format!("Cluster unreachable: {}", e))?;
    let nodes: Vec<ResourceSummary> = nodes_list.items.iter().map(|node| {
        let name = node.metadata.name.clone().unwrap_or_default();
        let status = node.status.as_ref()
            .and_then(|s| s.conditions.as_ref())
            .and_then(|conds| conds.iter().find(|c| c.type_ == "Ready"))
            .map(|c| if c.status == "True" { "Ready" } else { "NotReady" })
            .unwrap_or("Unknown")
            .to_string();
        ResourceSummary {
            id: node.metadata.uid.clone().unwrap_or_default(),
            name,
            namespace: "-".to_string(),
            kind: "Node".to_string(),
            group: "".to_string(),
            version: "v1".to_string(),
            age: node.metadata.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
            status,
            raw_json: String::new(),
            ready: None, restarts: None, node: None, ip: None,
        }
    }).collect();

    // Process pods - gracefully handle errors
    let pods: Vec<ResourceSummary> = match pods_res {
        Ok(list) => list.items.iter().map(|pod| {
            let name = pod.metadata.name.clone().unwrap_or_default();
            let namespace = pod.metadata.namespace.clone().unwrap_or("-".into());
            let status = pod.status.as_ref()
                .and_then(|s| s.phase.clone())
                .unwrap_or("Unknown".to_string());
            let ready_str = pod.status.as_ref()
                .and_then(|s| s.container_statuses.as_ref())
                .map(|cs| {
                    let ready_count = cs.iter().filter(|c| c.ready).count();
                    format!("{}/{}", ready_count, cs.len())
                });
            let restart_count = pod.status.as_ref()
                .and_then(|s| s.container_statuses.as_ref())
                .map(|cs| cs.iter().map(|c| c.restart_count).sum::<i32>());
            let node_name = pod.spec.as_ref().and_then(|s| s.node_name.clone());
            let pod_ip = pod.status.as_ref().and_then(|s| s.pod_ip.clone());
            ResourceSummary {
                id: pod.metadata.uid.clone().unwrap_or_default(),
                name,
                namespace,
                kind: "Pod".to_string(),
                group: "".to_string(),
                version: "v1".to_string(),
                age: pod.metadata.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
                status,
                raw_json: String::new(),
                ready: ready_str,
                restarts: restart_count,
                node: node_name,
                ip: pod_ip,
            }
        }).collect(),
        Err(_) => Vec::new(),
    };

    // Process deployments - gracefully handle errors
    let deployments: Vec<ResourceSummary> = match deployments_res {
        Ok(list) => list.items.iter().map(|dep| {
            let name = dep.metadata.name.clone().unwrap_or_default();
            let namespace = dep.metadata.namespace.clone().unwrap_or("-".into());
            let ready = dep.status.as_ref()
                .map(|s| format!("{}/{}", s.ready_replicas.unwrap_or(0), s.replicas.unwrap_or(0)));
            ResourceSummary {
                id: dep.metadata.uid.clone().unwrap_or_default(),
                name,
                namespace,
                kind: "Deployment".to_string(),
                group: "apps".to_string(),
                version: "v1".to_string(),
                age: dep.metadata.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
                status: "Active".to_string(),
                raw_json: String::new(),
                ready,
                restarts: None, node: None, ip: None,
            }
        }).collect(),
        Err(_) => Vec::new(),
    };

    // Process services - gracefully handle errors
    let services: Vec<ResourceSummary> = match services_res {
        Ok(list) => list.items.iter().map(|svc| {
            let name = svc.metadata.name.clone().unwrap_or_default();
            let namespace = svc.metadata.namespace.clone().unwrap_or("-".into());
            let svc_type = svc.spec.as_ref().and_then(|s| s.type_.clone()).unwrap_or("ClusterIP".into());
            ResourceSummary {
                id: svc.metadata.uid.clone().unwrap_or_default(),
                name,
                namespace,
                kind: "Service".to_string(),
                group: "".to_string(),
                version: "v1".to_string(),
                age: svc.metadata.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
                status: svc_type,
                raw_json: String::new(),
                ready: None, restarts: None, node: None, ip: None,
            }
        }).collect(),
        Err(_) => Vec::new(),
    };

    // Process namespaces - gracefully handle errors
    let namespace_names: Vec<String> = match namespaces_res {
        Ok(list) => list.items.iter()
            .filter_map(|ns| ns.metadata.name.clone())
            .collect(),
        Err(_) => Vec::new(),
    };

    let stats = ClusterStats {
        nodes: nodes.len(),
        pods: pods.len(),
        deployments: deployments.len(),
        services: services.len(),
        namespaces: namespace_names.len(),
    };

    // Update stats cache
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), stats.clone()));
    }

    Ok(InitialClusterData {
        stats,
        namespaces: namespace_names,
        pods,
        nodes,
        deployments,
        services,
    })
}

#[tauri::command]
async fn list_azure_subscriptions() -> Result<Vec<AzureSubscription>, String> {
    let output = std::process::Command::new("az")
        .args(&["account", "list", "--output", "json"])
        .output()
        .map_err(|e| format!("Failed to execute az command: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let subscriptions: Vec<AzureSubscription> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse subscriptions: {}", e))?;

    Ok(subscriptions)
}

#[tauri::command]
async fn list_aks_clusters(subscription_id: String) -> Result<Vec<AksCluster>, String> {
    let output = std::process::Command::new("az")
        .args(&["aks", "list", "--subscription", &subscription_id, "--output", "json"])
        .output()
        .map_err(|e| format!("Failed to execute az command: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let clusters: Vec<AksCluster> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse clusters: {}", e))?;

    Ok(clusters)
}

#[tauri::command]
async fn get_aks_credentials(state: State<'_, AppState>, subscription_id: String, resource_group: String, name: String) -> Result<(), String> {
    // Step 1: Get AKS credentials
    let output = std::process::Command::new("az")
        .args(&[
            "aks", "get-credentials",
            "--subscription", &subscription_id,
            "--resource-group", &resource_group,
            "--name", &name,
            "--overwrite-existing"
        ])
        .output()
        .map_err(|e| format!("Failed to execute az command: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Step 2: Convert kubeconfig for Azure CLI authentication
    let convert_output = std::process::Command::new("kubelogin")
        .args(&["convert-kubeconfig", "-l", "azurecli"])
        .output()
        .map_err(|e| format!("Failed to execute kubelogin command: {}", e))?;

    if !convert_output.status.success() {
        return Err(format!(
            "Failed to convert kubeconfig: {}",
            String::from_utf8_lossy(&convert_output.stderr)
        ));
    }

    // Step 3: Get the new context name from kubeconfig
    let kubeconfig = Kubeconfig::read().map_err(|e| e.to_string())?;
    let new_context = kubeconfig.current_context.clone();

    // Step 4: Set the new context in state so the app auto-connects on reload
    if let Some(ctx) = new_context {
        if let Ok(mut context_guard) = state.selected_context.try_lock() {
            *context_guard = Some(ctx);
        }
    }

    Ok(())
}

#[tauri::command]
async fn refresh_azure_data() -> Result<Vec<AzureSubscription>, String> {
    // 1. Fetch Subscriptions
    let subs_output = std::process::Command::new("az")
        .args(&["account", "list", "--output", "json"])
        .output()
        .map_err(|e| format!("Failed to execute az command: {}", e))?;

    if !subs_output.status.success() {
        return Err(String::from_utf8_lossy(&subs_output.stderr).to_string());
    }

    let mut subscriptions: Vec<AzureSubscription> = serde_json::from_slice(&subs_output.stdout)
        .map_err(|e| format!("Failed to parse subscriptions: {}", e))?;

    // 2. Fetch Clusters for each subscription in parallel
    let mut handles = vec![];

    for sub in &subscriptions {
        let sub_id = sub.id.clone();
        handles.push(tokio::spawn(async move {
            let output = std::process::Command::new("az")
                .args(&["aks", "list", "--subscription", &sub_id, "--output", "json"])
                .output();
            
            match output {
                Ok(out) => {
                    if out.status.success() {
                        let clusters: Vec<AksCluster> = serde_json::from_slice(&out.stdout).unwrap_or_default();
                        Ok((sub_id, clusters))
                    } else {
                        Err(String::from_utf8_lossy(&out.stderr).to_string())
                    }
                },
                Err(e) => Err(e.to_string())
            }
        }));
    }

    let results = futures::future::join_all(handles).await;

    // 3. Aggregate results
    let mut cluster_map: HashMap<String, Vec<AksCluster>> = HashMap::new();
    for res in results {
        if let Ok(Ok((sub_id, clusters))) = res {
            cluster_map.insert(sub_id, clusters);
        }
    }

    for sub in &mut subscriptions {
        if let Some(clusters) = cluster_map.remove(&sub.id) {
            sub.clusters = clusters;
        }
    }

    Ok(subscriptions)
}

#[tauri::command]
async fn azure_login() -> Result<String, String> {
    // az login launches a browser. We can just run it.
    // It blocks until login is complete.
    let output = std::process::Command::new("az")
        .arg("login")
        .output()
        .map_err(|e| format!("Failed to execute az login: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    
    Ok("Logged in successfully".to_string())
}

#[tauri::command]
async fn connect_vcluster(
    state: State<'_, AppState>,
    name: String,
    namespace: String,
) -> Result<String, String> {
    // First, check if vcluster CLI is available
    let version_check = tokio::process::Command::new("vcluster")
        .arg("version")
        .output()
        .await;

    if version_check.is_err() {
        return Err("vcluster CLI not found. Please install it: https://www.vcluster.com/docs/getting-started/setup".to_string());
    }

    // Get the current host context before connecting
    let host_context = get_current_context_name(state.clone(), None).await.unwrap_or_default();

    // Clear all caches first
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() {
        *cache = None;
    }
    if let Ok(mut cache) = state.discovery_cache.try_lock() {
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

    // Execute vcluster connect command with timeout
    // Use --driver=helm to avoid platform-specific features that require vcluster platform login
    // The --background-proxy flag is default and handles kubeconfig updates automatically
    let connect_result = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        tokio::process::Command::new("vcluster")
            .args(&["connect", &name, "-n", &namespace, "--driver=helm"])
            .output()
    ).await;

    let output = match connect_result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("Failed to execute vcluster connect: {}", e)),
        Err(_) => return Err(format!("vcluster connect timed out after 45 seconds. The vcluster '{}' may not be running or accessible.", name)),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let _stdout = String::from_utf8_lossy(&output.stdout).to_string();

        // Provide helpful error messages
        if stderr.contains("not found") || stderr.contains("NotFound") {
            return Err(format!("vcluster '{}' not found in namespace '{}'. Check if the vcluster exists and is running.", name, namespace));
        } else if stderr.contains("connection refused") {
            return Err(format!("Connection refused to vcluster '{}'. The vcluster may not be running.", name));
        } else if stderr.contains("unauthorized") || stderr.contains("Unauthorized") {
            return Err(format!("Unauthorized access to vcluster '{}'. Check your permissions.", name));
        } else if stderr.contains("management-cluster") || stderr.contains("platform") {
            // Try again without any driver flag - let vcluster auto-detect
            let retry_result = tokio::time::timeout(
                std::time::Duration::from_secs(45),
                tokio::process::Command::new("vcluster")
                    .args(&["connect", &name, "-n", &namespace])
                    .output()
            ).await;

            match retry_result {
                Ok(Ok(retry_output)) if retry_output.status.success() => {
                    // Success on retry, continue with the flow
                }
                _ => {
                    return Err(format!("vcluster connect failed. If using vcluster platform, please run 'vcluster login' first. Error: {}", stderr.trim()));
                }
            }
        } else {
            return Err(format!("vcluster connect failed: {}", stderr.trim()));
        }
    }

    // Give the background proxy a moment to fully start
    tokio::time::sleep(tokio::time::Duration::from_millis(2000)).await;

    // vcluster connect updates the kubeconfig, so we need to reload it
    // The context name will be something like "vcluster_<name>_<namespace>_<original-context>"
    let new_context = format!("vcluster_{}_{}_", name, namespace) + &host_context;

    // Update selected context
    if let Ok(mut context_guard) = state.selected_context.try_lock() {
        *context_guard = Some(new_context.clone());
    }

    // Clear kubeconfig path since vcluster writes to default kubeconfig (~/.kube/config)
    if let Ok(mut path_guard) = state.kubeconfig_path.try_lock() {
        *path_guard = None;
    }

    // Verify connectivity with retries and better error handling
    for attempt in 0..5 {
        // Read fresh kubeconfig each attempt
        let kubeconfig = match Kubeconfig::read() {
            Ok(kc) => kc,
            Err(e) => {
                if attempt < 4 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    continue;
                }
                return Err(format!("Failed to read kubeconfig after vcluster connect: {}", e));
            }
        };

        // Try to create client with the new context
        let config = match kube::Config::from_custom_kubeconfig(
            kubeconfig,
            &KubeConfigOptions {
                context: Some(new_context.clone()),
                ..Default::default()
            }
        ).await {
            Ok(c) => c,
            Err(e) => {
                if attempt < 4 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    continue;
                }
                return Err(format!("Failed to configure vcluster context '{}': {}", new_context, e));
            }
        };

        let client = match Client::try_from(config) {
            Ok(c) => c,
            Err(e) => {
                if attempt < 4 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    continue;
                }
                return Err(format!("Failed to create client for vcluster: {}", e));
            }
        };

        // Try to list namespaces to verify connection
        let ns_api: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client);
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            ns_api.list(&Default::default())
        ).await {
            Ok(Ok(_)) => {
                return Ok(format!("Connected to vcluster '{}' in namespace '{}'. Context: {}", name, namespace, new_context));
            }
            Ok(Err(e)) => {
                if attempt < 4 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
                    continue;
                }
                return Err(format!("vcluster API not responding: {}", e));
            }
            Err(_) => {
                if attempt < 4 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
                    continue;
                }
                return Err("vcluster API timed out. The vcluster proxy may not be running correctly.".to_string());
            }
        }
    }

    // Should not reach here, but just in case
    Err("Failed to verify vcluster connection after multiple attempts".to_string())
}

#[tauri::command]
async fn list_vclusters(state: State<'_, AppState>) -> Result<String, String> {
    // Get current context to use with vcluster CLI
    let context = {
        if let Ok(guard) = state.selected_context.try_lock() {
            guard.clone()
        } else {
            None
        }
    };

    // Context is used for the vcluster CLI call below

    // Check cache first (30 second TTL)
    if let Ok(cache) = state.vcluster_cache.try_lock() {
        if let Some((timestamp, cached_result)) = &*cache {
            if timestamp.elapsed().as_secs() < 30 {
                return Ok(cached_result.clone());
            }
        }
    }

    // Use vcluster CLI to list all vclusters with context
    // Use --driver=helm to avoid platform mode which requires vcluster platform login
    let mut cmd = tokio::process::Command::new("vcluster");
    cmd.args(&["list", "--output", "json", "--driver=helm"]);

    // Add context if available
    if let Some(ctx) = &context {
        if !ctx.is_empty() {
            cmd.args(&["--context", ctx]);
        }
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute vcluster command: {}. Make sure vcluster CLI is installed.", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // If helm driver fails, try without driver (auto-detect)
        if stderr.contains("management-cluster") || stderr.contains("platform") {
            let mut retry_cmd = tokio::process::Command::new("vcluster");
            retry_cmd.args(&["list", "--output", "json"]);
            if let Some(ctx) = &context {
                if !ctx.is_empty() {
                    retry_cmd.args(&["--context", ctx]);
                }
            }
            let retry_output = retry_cmd.output().await;
            if let Ok(out) = retry_output {
                if out.status.success() {
                    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                    if let Ok(mut cache) = state.vcluster_cache.try_lock() {
                        *cache = Some((std::time::Instant::now(), stdout.clone()));
                    }
                    return Ok(stdout);
                }
            }
        }
        return Err(format!("vcluster list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    // Update cache
    if let Ok(mut cache) = state.vcluster_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), stdout.clone()));
    }

    Ok(stdout)
}
// (Removed stray extra closing brace)

// Reinsert topology command after AppState & other commands
#[tauri::command]
async fn get_topology_graph(state: State<'_, AppState>) -> Result<TopologyGraph, String> {
    let client = create_client(state).await?;
    let lp = ListParams::default();

    let api_ns: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());
    let api_nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let api_pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
    let api_svcs: Api<k8s_openapi::api::core::v1::Service> = Api::all(client.clone());
    let api_ing: Api<k8s_openapi::api::networking::v1::Ingress> = Api::all(client.clone());
    let api_dep: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());
    let api_rs: Api<k8s_openapi::api::apps::v1::ReplicaSet> = Api::all(client.clone());
    let api_sts: Api<k8s_openapi::api::apps::v1::StatefulSet> = Api::all(client.clone());
    let api_ds: Api<k8s_openapi::api::apps::v1::DaemonSet> = Api::all(client.clone());
    let api_jobs: Api<k8s_openapi::api::batch::v1::Job> = Api::all(client.clone());
    let api_pvc: Api<k8s_openapi::api::core::v1::PersistentVolumeClaim> = Api::all(client.clone());
    let api_pv: Api<k8s_openapi::api::core::v1::PersistentVolume> = Api::all(client.clone());
    let api_sc: Api<k8s_openapi::api::storage::v1::StorageClass> = Api::all(client.clone());

    macro_rules! safe_list { ($api:expr) => { match $api.list(&lp).await { Ok(l)=>l.items, Err(e)=>{ eprintln!("topology list warning: {}", e); Vec::new() } } }; }

    let namespaces = safe_list!(api_ns);
    let nodes = safe_list!(api_nodes);
    let pods = safe_list!(api_pods);
    let services = safe_list!(api_svcs);
    let ingresses = safe_list!(api_ing);
    let deployments = safe_list!(api_dep);
    let replicasets = safe_list!(api_rs);
    let statefulsets = safe_list!(api_sts);
    let daemonsets = safe_list!(api_ds);
    let jobs = safe_list!(api_jobs);
    let pvcs = safe_list!(api_pvc);
    let pvs = safe_list!(api_pv);
    let storageclasses = safe_list!(api_sc);

    let mut nodes_vec: Vec<TopologyNode> = Vec::new();
    let mut edges_vec: Vec<TopologyEdge> = Vec::new();

    for ns in &namespaces { let name = ns.metadata.name.clone().unwrap_or_default(); nodes_vec.push(TopologyNode { id: topo_node_id("Namespace", None, &name), kind: "Namespace".into(), name, namespace: None, status: Some("Unknown".into()), labels: ns.metadata.labels.clone(), extra: None }); }
    for node in &nodes { let name = node.metadata.name.clone().unwrap_or_default(); let status = if let Some(st) = &node.status { if st.conditions.as_ref().map(|v| v.iter().any(|c| c.type_ == "Ready" && c.status == "True")).unwrap_or(false) { "Healthy" } else { "Degraded" } } else { "Unknown" }; nodes_vec.push(TopologyNode { id: topo_node_id("Node", None, &name), kind: "Node".into(), name, namespace: None, status: Some(status.into()), labels: node.metadata.labels.clone(), extra: None }); }
    for dep in &deployments { let name = dep.metadata.name.clone().unwrap_or_default(); let ns = dep.metadata.namespace.clone(); nodes_vec.push(TopologyNode { id: topo_node_id("Deployment", ns.as_deref(), &name), kind: "Deployment".into(), name, namespace: ns.clone(), status: Some(derive_deployment_status(dep)), labels: dep.metadata.labels.clone(), extra: None }); }
    for rs in &replicasets { let name = rs.metadata.name.clone().unwrap_or_default(); let ns = rs.metadata.namespace.clone(); nodes_vec.push(TopologyNode { id: topo_node_id("ReplicaSet", ns.as_deref(), &name), kind: "ReplicaSet".into(), name, namespace: ns.clone(), status: Some("Unknown".into()), labels: rs.metadata.labels.clone(), extra: None }); }
    for sts in &statefulsets { let name = sts.metadata.name.clone().unwrap_or_default(); let ns = sts.metadata.namespace.clone(); nodes_vec.push(TopologyNode { id: topo_node_id("StatefulSet", ns.as_deref(), &name), kind: "StatefulSet".into(), name, namespace: ns.clone(), status: Some(derive_stateful_status(sts)), labels: sts.metadata.labels.clone(), extra: None }); }
    for ds in &daemonsets { let name = ds.metadata.name.clone().unwrap_or_default(); let ns = ds.metadata.namespace.clone(); nodes_vec.push(TopologyNode { id: topo_node_id("DaemonSet", ns.as_deref(), &name), kind: "DaemonSet".into(), name, namespace: ns.clone(), status: Some(derive_daemon_status(ds)), labels: ds.metadata.labels.clone(), extra: None }); }
    for job in &jobs { let name = job.metadata.name.clone().unwrap_or_default(); let ns = job.metadata.namespace.clone(); nodes_vec.push(TopologyNode { id: topo_node_id("Job", ns.as_deref(), &name), kind: "Job".into(), name, namespace: ns.clone(), status: Some(derive_job_status(job)), labels: job.metadata.labels.clone(), extra: None }); }
    for pod in &pods { let name = pod.metadata.name.clone().unwrap_or_default(); let ns = pod.metadata.namespace.clone(); let node_name = pod.spec.as_ref().and_then(|s| s.node_name.clone()); let mut extra_obj = serde_json::Map::new(); if let Some(nn) = node_name.clone() { extra_obj.insert("nodeName".into(), serde_json::Value::String(nn)); } nodes_vec.push(TopologyNode { id: topo_node_id("Pod", ns.as_deref(), &name), kind: "Pod".into(), name, namespace: ns.clone(), status: Some(derive_pod_status(pod)), labels: pod.metadata.labels.clone(), extra: Some(serde_json::Value::Object(extra_obj)) }); }
    for svc in &services { let name = svc.metadata.name.clone().unwrap_or_default(); let ns = svc.metadata.namespace.clone(); nodes_vec.push(TopologyNode { id: topo_node_id("Service", ns.as_deref(), &name), kind: "Service".into(), name, namespace: ns.clone(), status: Some("Unknown".into()), labels: svc.metadata.labels.clone(), extra: None }); }
    for ing in &ingresses { let name = ing.metadata.name.clone().unwrap_or_default(); let ns = ing.metadata.namespace.clone(); nodes_vec.push(TopologyNode { id: topo_node_id("Ingress", ns.as_deref(), &name), kind: "Ingress".into(), name, namespace: ns.clone(), status: Some("Unknown".into()), labels: ing.metadata.labels.clone(), extra: None }); }
    for pvc in &pvcs { let name = pvc.metadata.name.clone().unwrap_or_default(); let ns = pvc.metadata.namespace.clone(); nodes_vec.push(TopologyNode { id: topo_node_id("PVC", ns.as_deref(), &name), kind: "PVC".into(), name, namespace: ns.clone(), status: Some("Unknown".into()), labels: pvc.metadata.labels.clone(), extra: None }); }
    for pv in &pvs { let name = pv.metadata.name.clone().unwrap_or_default(); nodes_vec.push(TopologyNode { id: topo_node_id("PV", None, &name), kind: "PV".into(), name, namespace: None, status: Some("Unknown".into()), labels: pv.metadata.labels.clone(), extra: None }); }
    for sc in &storageclasses { let name = sc.metadata.name.clone().unwrap_or_default(); nodes_vec.push(TopologyNode { id: topo_node_id("StorageClass", None, &name), kind: "StorageClass".into(), name, namespace: None, status: Some("Unknown".into()), labels: sc.metadata.labels.clone(), extra: None }); }

    let mut add_owner_edges = |child_kind: &str, child_ns: Option<&str>, child_name: &str, owners: &Option<Vec<k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference>>| {
        if let Some(o_refs) = owners { for o in o_refs { let parent_id = topo_node_id(&o.kind, child_ns, &o.name); let child_id = topo_node_id(child_kind, child_ns, child_name); edges_vec.push(TopologyEdge { id: format!("{}->{}", parent_id, child_id), from: parent_id, to: child_id, r#type: "owns".into() }); } }
    };
    for rs in &replicasets { add_owner_edges("ReplicaSet", rs.metadata.namespace.as_deref(), rs.metadata.name.as_deref().unwrap_or(""), &rs.metadata.owner_references); }
    for pod in &pods { add_owner_edges("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or(""), &pod.metadata.owner_references); }
    for sts in &statefulsets { add_owner_edges("StatefulSet", sts.metadata.namespace.as_deref(), sts.metadata.name.as_deref().unwrap_or(""), &sts.metadata.owner_references); }
    for ds in &daemonsets { add_owner_edges("DaemonSet", ds.metadata.namespace.as_deref(), ds.metadata.name.as_deref().unwrap_or(""), &ds.metadata.owner_references); }
    for job in &jobs { add_owner_edges("Job", job.metadata.namespace.as_deref(), job.metadata.name.as_deref().unwrap_or(""), &job.metadata.owner_references); }

    for svc in &services { if let Some(sel) = svc.spec.as_ref().and_then(|s| s.selector.clone()) { for pod in &pods { if pod.metadata.namespace == svc.metadata.namespace { if let Some(pod_labels) = &pod.metadata.labels { if sel.iter().all(|(k,v)| pod_labels.get(k)==Some(v)) { let svc_id = topo_node_id("Service", svc.metadata.namespace.as_deref(), svc.metadata.name.as_deref().unwrap_or("")); let pod_id = topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or("")); edges_vec.push(TopologyEdge { id: format!("{}->{}", svc_id, pod_id), from: svc_id, to: pod_id, r#type: "selects".into() }); } } } } } }
    for ing in &ingresses { let ns = ing.metadata.namespace.clone(); if let Some(spec) = &ing.spec { if let Some(rules) = &spec.rules { for rule in rules { if let Some(http) = &rule.http { for path in &http.paths { if let Some(backend) = &path.backend.service { let svc_name = &backend.name; let ing_id = topo_node_id("Ingress", ns.as_deref(), ing.metadata.name.as_deref().unwrap_or("")); let svc_id = topo_node_id("Service", ns.as_deref(), svc_name); edges_vec.push(TopologyEdge { id: format!("{}->{}", ing_id, svc_id), from: ing_id.clone(), to: svc_id, r#type: "routes_to".into() }); } } } } } if let Some(def) = &spec.default_backend { if let Some(svc) = &def.service { let ing_id = topo_node_id("Ingress", ns.as_deref(), ing.metadata.name.as_deref().unwrap_or("")); let svc_id = topo_node_id("Service", ns.as_deref(), &svc.name); edges_vec.push(TopologyEdge { id: format!("{}->{}", ing_id, svc_id), from: ing_id.clone(), to: svc_id, r#type: "routes_to".into() }); } } }
    }
    for pod in &pods { let pod_id = topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or("")); if let Some(spec) = &pod.spec { if let Some(vols) = &spec.volumes { for v in vols { if let Some(pvc) = &v.persistent_volume_claim { let pvc_id = topo_node_id("PVC", pod.metadata.namespace.as_deref(), &pvc.claim_name); edges_vec.push(TopologyEdge { id: format!("{}->{}", pod_id, pvc_id), from: pod_id.clone(), to: pvc_id.clone(), r#type: "mounts".into() }); } } } } }
    for pvc in &pvcs { if let Some(vname) = pvc.spec.as_ref().and_then(|s| s.volume_name.clone()) { let pvc_id = topo_node_id("PVC", pvc.metadata.namespace.as_deref(), pvc.metadata.name.as_deref().unwrap_or("")); let pv_id = topo_node_id("PV", None, &vname); edges_vec.push(TopologyEdge { id: format!("{}->{}", pvc_id, pv_id), from: pvc_id.clone(), to: pv_id.clone(), r#type: "backs".into() }); } }
    for pv in &pvs { if let Some(sc_name) = pv.spec.as_ref().and_then(|s| s.storage_class_name.clone()) { let pv_id = topo_node_id("PV", None, pv.metadata.name.as_deref().unwrap_or("")); let sc_id = topo_node_id("StorageClass", None, &sc_name); edges_vec.push(TopologyEdge { id: format!("{}->{}", pv_id, sc_id), from: pv_id.clone(), to: sc_id.clone(), r#type: "backs".into() }); } }
    for pod in &pods { if let Some(node_name) = pod.spec.as_ref().and_then(|s| s.node_name.clone()) { let pod_id = topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or("")); let node_id = topo_node_id("Node", None, &node_name); edges_vec.push(TopologyEdge { id: format!("{}->{}", pod_id, node_id), from: pod_id.clone(), to: node_id.clone(), r#type: "runs_on".into() }); } }

    let graph = TopologyGraph { nodes: nodes_vec, edges: edges_vec, generated_at: chrono::Utc::now().to_rfc3339() };
    Ok(graph)
}

// (Removed erroneous extra closing brace)

// More performant variant: conditionally include heavy resource categories to reduce API load
#[tauri::command]
async fn get_topology_graph_opts(
    state: State<'_, AppState>,
    include_pods: bool,
    include_storage: bool,
    include_jobs: bool,
    include_replicasets: bool,
    include_ingress: bool,
) -> Result<TopologyGraph, String> {
    let client = create_client(state).await?;
    let lp = ListParams::default();

    // Mandatory APIs
    let api_ns: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());
    let api_nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let api_dep: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());
    let api_sts: Api<k8s_openapi::api::apps::v1::StatefulSet> = Api::all(client.clone());
    let api_ds: Api<k8s_openapi::api::apps::v1::DaemonSet> = Api::all(client.clone());

    // Optional APIs
    let api_pods = if include_pods { Some(Api::<k8s_openapi::api::core::v1::Pod>::all(client.clone())) } else { None };
    let api_svcs = if include_ingress { Some(Api::<k8s_openapi::api::core::v1::Service>::all(client.clone())) } else { None };
    let api_ing = if include_ingress { Some(Api::<k8s_openapi::api::networking::v1::Ingress>::all(client.clone())) } else { None };
    let api_rs = if include_replicasets { Some(Api::<k8s_openapi::api::apps::v1::ReplicaSet>::all(client.clone())) } else { None };
    let api_jobs = if include_jobs { Some(Api::<k8s_openapi::api::batch::v1::Job>::all(client.clone())) } else { None };
    let api_pvc = if include_storage { Some(Api::<k8s_openapi::api::core::v1::PersistentVolumeClaim>::all(client.clone())) } else { None };
    let api_pv = if include_storage { Some(Api::<k8s_openapi::api::core::v1::PersistentVolume>::all(client.clone())) } else { None };
    let api_sc = if include_storage { Some(Api::<k8s_openapi::api::storage::v1::StorageClass>::all(client.clone())) } else { None };

    macro_rules! list_req { ($api:expr) => { match $api.list(&lp).await { Ok(l)=>l.items, Err(e)=>{ eprintln!("topology list warning: {}", e); Vec::new() } } }; }
    macro_rules! list_opt { ($api:expr) => { if let Some(a) = $api { match a.list(&lp).await { Ok(l)=>l.items, Err(e)=>{ eprintln!("topology list warning: {}", e); Vec::new() } } } else { Vec::new() } }; }

    let namespaces = list_req!(api_ns);
    let nodes = list_req!(api_nodes);
    let deployments = list_req!(api_dep);
    let statefulsets = list_req!(api_sts);
    let daemonsets = list_req!(api_ds);
    let pods = list_opt!(api_pods);
    let services = list_opt!(api_svcs);
    let ingresses = list_opt!(api_ing);
    let replicasets = list_opt!(api_rs);
    let jobs = list_opt!(api_jobs);
    let pvcs = list_opt!(api_pvc);
    let pvs = list_opt!(api_pv);
    let storageclasses = list_opt!(api_sc);

    let mut nodes_vec: Vec<TopologyNode> = Vec::new();
    let mut edges_vec: Vec<TopologyEdge> = Vec::new();

    // Namespace & Node nodes
    for ns in &namespaces {
        let name = ns.metadata.name.clone().unwrap_or_default();
        nodes_vec.push(TopologyNode { id: topo_node_id("Namespace", None, &name), kind: "Namespace".into(), name, namespace: None, status: Some("Unknown".into()), labels: ns.metadata.labels.clone(), extra: None });
    }
    for node in &nodes {
        let name = node.metadata.name.clone().unwrap_or_default();
        let status = if let Some(st) = &node.status { if st.conditions.as_ref().map(|v| v.iter().any(|c| c.type_ == "Ready" && c.status == "True")).unwrap_or(false) { "Healthy" } else { "Degraded" } } else { "Unknown" };
        nodes_vec.push(TopologyNode { id: topo_node_id("Node", None, &name), kind: "Node".into(), name, namespace: None, status: Some(status.into()), labels: node.metadata.labels.clone(), extra: None });
    }

    // Workload nodes
    for dep in &deployments {
        let name = dep.metadata.name.clone().unwrap_or_default();
        let ns = dep.metadata.namespace.clone();
        nodes_vec.push(TopologyNode { id: topo_node_id("Deployment", ns.as_deref(), &name), kind: "Deployment".into(), name, namespace: ns.clone(), status: Some(derive_deployment_status(dep)), labels: dep.metadata.labels.clone(), extra: None });
    }
    for sts in &statefulsets {
        let name = sts.metadata.name.clone().unwrap_or_default();
        let ns = sts.metadata.namespace.clone();
        nodes_vec.push(TopologyNode { id: topo_node_id("StatefulSet", ns.as_deref(), &name), kind: "StatefulSet".into(), name, namespace: ns.clone(), status: Some(derive_stateful_status(sts)), labels: sts.metadata.labels.clone(), extra: None });
    }
    for ds in &daemonsets {
        let name = ds.metadata.name.clone().unwrap_or_default();
        let ns = ds.metadata.namespace.clone();
        nodes_vec.push(TopologyNode { id: topo_node_id("DaemonSet", ns.as_deref(), &name), kind: "DaemonSet".into(), name, namespace: ns.clone(), status: Some(derive_daemon_status(ds)), labels: ds.metadata.labels.clone(), extra: None });
    }
    if include_replicasets {
        for rs in &replicasets {
            let name = rs.metadata.name.clone().unwrap_or_default();
            let ns = rs.metadata.namespace.clone();
            nodes_vec.push(TopologyNode { id: topo_node_id("ReplicaSet", ns.as_deref(), &name), kind: "ReplicaSet".into(), name, namespace: ns.clone(), status: Some("Unknown".into()), labels: rs.metadata.labels.clone(), extra: None });
        }
    }
    if include_jobs {
        for job in &jobs {
            let name = job.metadata.name.clone().unwrap_or_default();
            let ns = job.metadata.namespace.clone();
            nodes_vec.push(TopologyNode { id: topo_node_id("Job", ns.as_deref(), &name), kind: "Job".into(), name, namespace: ns.clone(), status: Some(derive_job_status(job)), labels: job.metadata.labels.clone(), extra: None });
        }
    }
    if include_pods {
        for pod in &pods {
            let name = pod.metadata.name.clone().unwrap_or_default();
            let ns = pod.metadata.namespace.clone();
            let node_name = pod.spec.as_ref().and_then(|s| s.node_name.clone());
            let mut extra_obj = serde_json::Map::new();
            if let Some(nn) = node_name.clone() { extra_obj.insert("nodeName".into(), serde_json::Value::String(nn)); }
            nodes_vec.push(TopologyNode { id: topo_node_id("Pod", ns.as_deref(), &name), kind: "Pod".into(), name, namespace: ns.clone(), status: Some(derive_pod_status(pod)), labels: pod.metadata.labels.clone(), extra: Some(serde_json::Value::Object(extra_obj)) });
        }
    }
    if include_ingress {
        for svc in &services {
            let name = svc.metadata.name.clone().unwrap_or_default();
            let ns = svc.metadata.namespace.clone();
            nodes_vec.push(TopologyNode { id: topo_node_id("Service", ns.as_deref(), &name), kind: "Service".into(), name, namespace: ns.clone(), status: Some("Unknown".into()), labels: svc.metadata.labels.clone(), extra: None });
        }
        for ing in &ingresses {
            let name = ing.metadata.name.clone().unwrap_or_default();
            let ns = ing.metadata.namespace.clone();
            nodes_vec.push(TopologyNode { id: topo_node_id("Ingress", ns.as_deref(), &name), kind: "Ingress".into(), name, namespace: ns.clone(), status: Some("Unknown".into()), labels: ing.metadata.labels.clone(), extra: None });
        }
    }
    if include_storage {
        for pvc in &pvcs {
            let name = pvc.metadata.name.clone().unwrap_or_default();
            let ns = pvc.metadata.namespace.clone();
            nodes_vec.push(TopologyNode { id: topo_node_id("PVC", ns.as_deref(), &name), kind: "PVC".into(), name, namespace: ns.clone(), status: Some("Unknown".into()), labels: pvc.metadata.labels.clone(), extra: None });
        }
        for pv in &pvs {
            let name = pv.metadata.name.clone().unwrap_or_default();
            nodes_vec.push(TopologyNode { id: topo_node_id("PV", None, &name), kind: "PV".into(), name, namespace: None, status: Some("Unknown".into()), labels: pv.metadata.labels.clone(), extra: None });
        }
        for sc in &storageclasses {
            let name = sc.metadata.name.clone().unwrap_or_default();
            nodes_vec.push(TopologyNode { id: topo_node_id("StorageClass", None, &name), kind: "StorageClass".into(), name, namespace: None, status: Some("Unknown".into()), labels: sc.metadata.labels.clone(), extra: None });
        }
    }

    // Ownership edges
    let mut owns = |kind: &str, ns: Option<&str>, name: &str, owners: &Option<Vec<k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference>>| {
        if let Some(o_refs) = owners {
            for o in o_refs {
                edges_vec.push(TopologyEdge { id: format!("{}->{}", topo_node_id(&o.kind, ns, &o.name), topo_node_id(kind, ns, name)), from: topo_node_id(&o.kind, ns, &o.name), to: topo_node_id(kind, ns, name), r#type: "owns".into() });
            }
        }
    };
    if include_replicasets { for rs in &replicasets { owns("ReplicaSet", rs.metadata.namespace.as_deref(), rs.metadata.name.as_deref().unwrap_or(""), &rs.metadata.owner_references); } }
    if include_pods { for pod in &pods { owns("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or(""), &pod.metadata.owner_references); } }
    for sts in &statefulsets { owns("StatefulSet", sts.metadata.namespace.as_deref(), sts.metadata.name.as_deref().unwrap_or(""), &sts.metadata.owner_references); }
    for ds in &daemonsets { owns("DaemonSet", ds.metadata.namespace.as_deref(), ds.metadata.name.as_deref().unwrap_or(""), &ds.metadata.owner_references); }
    if include_jobs { for job in &jobs { owns("Job", job.metadata.namespace.as_deref(), job.metadata.name.as_deref().unwrap_or(""), &job.metadata.owner_references); } }

    // Service -> Pod edges via selector
    if include_ingress && include_pods {
        for svc in &services {
            if let Some(sel) = svc.spec.as_ref().and_then(|s| s.selector.clone()) {
                for pod in &pods {
                    if pod.metadata.namespace == svc.metadata.namespace {
                        if let Some(pod_labels) = &pod.metadata.labels {
                            if sel.iter().all(|(k,v)| pod_labels.get(k)==Some(v)) {
                                edges_vec.push(TopologyEdge { id: format!("{}->{}", topo_node_id("Service", svc.metadata.namespace.as_deref(), svc.metadata.name.as_deref().unwrap_or("")), topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or(""))), from: topo_node_id("Service", svc.metadata.namespace.as_deref(), svc.metadata.name.as_deref().unwrap_or("")), to: topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or("")), r#type: "selects".into() });
                            }
                        }
                    }
                }
            }
        }
    }

    // Ingress routing edges
    if include_ingress {
        for ing in &ingresses {
            let ns = ing.metadata.namespace.clone();
            if let Some(spec) = &ing.spec {
                if let Some(rules) = &spec.rules {
                    for rule in rules {
                        if let Some(http) = &rule.http {
                            for path in &http.paths {
                                if let Some(backend) = &path.backend.service {
                                    let svc_name = &backend.name;
                                    edges_vec.push(TopologyEdge { id: format!("{}->{}", topo_node_id("Ingress", ns.as_deref(), ing.metadata.name.as_deref().unwrap_or("")), topo_node_id("Service", ns.as_deref(), svc_name)), from: topo_node_id("Ingress", ns.as_deref(), ing.metadata.name.as_deref().unwrap_or("")), to: topo_node_id("Service", ns.as_deref(), svc_name), r#type: "routes_to".into() });
                                }
                            }
                        }
                    }
                }
                if let Some(def) = &spec.default_backend {
                    if let Some(svc) = &def.service {
                        edges_vec.push(TopologyEdge { id: format!("{}->{}", topo_node_id("Ingress", ns.as_deref(), ing.metadata.name.as_deref().unwrap_or("")), topo_node_id("Service", ns.as_deref(), &svc.name)), from: topo_node_id("Ingress", ns.as_deref(), ing.metadata.name.as_deref().unwrap_or("")), to: topo_node_id("Service", ns.as_deref(), &svc.name), r#type: "routes_to".into() });
                    }
                }
            }
        }
    }

    // Storage edges
    if include_pods && include_storage {
        for pod in &pods {
            if let Some(spec) = &pod.spec {
                if let Some(vols) = &spec.volumes {
                    for v in vols {
                        if let Some(pvc) = &v.persistent_volume_claim {
                            edges_vec.push(TopologyEdge { id: format!("{}->{}", topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or("")), topo_node_id("PVC", pod.metadata.namespace.as_deref(), &pvc.claim_name)), from: topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or("")), to: topo_node_id("PVC", pod.metadata.namespace.as_deref(), &pvc.claim_name), r#type: "mounts".into() });
                        }
                    }
                }
            }
        }
    }
    if include_storage {
        for pvc in &pvcs {
            if let Some(vname) = pvc.spec.as_ref().and_then(|s| s.volume_name.clone()) {
                edges_vec.push(TopologyEdge { id: format!("{}->{}", topo_node_id("PVC", pvc.metadata.namespace.as_deref(), pvc.metadata.name.as_deref().unwrap_or("")), topo_node_id("PV", None, &vname)), from: topo_node_id("PVC", pvc.metadata.namespace.as_deref(), pvc.metadata.name.as_deref().unwrap_or("")), to: topo_node_id("PV", None, &vname), r#type: "backs".into() });
            }
        }
        for pv in &pvs {
            if let Some(sc_name) = pv.spec.as_ref().and_then(|s| s.storage_class_name.clone()) {
                edges_vec.push(TopologyEdge { id: format!("{}->{}", topo_node_id("PV", None, pv.metadata.name.as_deref().unwrap_or("")), topo_node_id("StorageClass", None, &sc_name)), from: topo_node_id("PV", None, pv.metadata.name.as_deref().unwrap_or("")), to: topo_node_id("StorageClass", None, &sc_name), r#type: "backs".into() });
            }
        }
    }

    // Pod -> Node edges
    if include_pods {
        for pod in &pods {
            if let Some(node_name) = pod.spec.as_ref().and_then(|s| s.node_name.clone()) {
                edges_vec.push(TopologyEdge { id: format!("{}->{}", topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or("")), topo_node_id("Node", None, &node_name)), from: topo_node_id("Pod", pod.metadata.namespace.as_deref(), pod.metadata.name.as_deref().unwrap_or("")), to: topo_node_id("Node", None, &node_name), r#type: "runs_on".into() });
            }
        }
    }

    let graph = TopologyGraph { nodes: nodes_vec, edges: edges_vec, generated_at: chrono::Utc::now().to_rfc3339() };
    Ok(graph)
}

// Command to list all installed CRDs for debugging missing custom resources
#[tauri::command]
async fn list_crds(state: State<'_, AppState>) -> Result<Vec<CrdInfo>, String> {
    let client = create_client(state).await?;
    use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
    let api: Api<CustomResourceDefinition> = Api::all(client);
    let lp = ListParams::default();
    let list = api.list(&lp).await.map_err(|e| format!("CRD list error: {}", e))?;
    let infos = list.items.into_iter().map(|crd| {
        let name = crd.metadata.name.unwrap_or_default();
        let group = crd.spec.group.clone();
        let versions = crd.spec.versions.iter().map(|v| v.name.clone()).collect::<Vec<_>>();
        let scope = crd.spec.scope.clone();
        CrdInfo { name, group, versions, scope }
    }).collect();
    Ok(infos)
}
