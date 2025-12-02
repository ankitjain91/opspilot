use kube::{
    api::{Api, ListParams, DynamicObject, GroupVersionKind, DeleteParams, LogParams, AttachParams, Patch, PatchParams},
    Client, Discovery,
    config::{KubeConfigOptions, Kubeconfig},
};
use kube::discovery::Scope;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{State, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::io::{Read, Write};

mod ai_local;

// --- Data Structures ---

#[derive(Serialize, Clone)]
struct NavGroup {
    title: String,
    items: Vec<NavResource>,
}

#[derive(Serialize, Clone)]
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

#[derive(Serialize)]
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

#[derive(Serialize)]
struct ClusterStats {
    nodes: usize,
    pods: usize,
    deployments: usize,
    services: usize,
    namespaces: usize,
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
    discovery_cache: Arc<Mutex<Option<(std::time::Instant, Arc<Discovery>)>>>,
}

// --- Logic ---

async fn get_cached_discovery(state: &State<'_, AppState>, client: Client) -> Result<Arc<Discovery>, String> {
    // Check cache
    let cached = {
        let cache = state.discovery_cache.lock().unwrap();
        if let Some((timestamp, discovery)) = &*cache {
            if timestamp.elapsed().as_secs() < 60 {
                Some(discovery.clone())
            } else {
                None
            }
        } else {
            None
        }
    }; // Lock dropped here
    
    if let Some(discovery) = cached {
        return Ok(discovery);
    }
    
    // Refresh cache
    let discovery = Arc::new(Discovery::new(client).run().await.map_err(|e| e.to_string())?);
    
    // Update cache
    {
        let mut cache = state.discovery_cache.lock().unwrap();
        *cache = Some((std::time::Instant::now(), discovery.clone()));
    } // Lock dropped here
    
    Ok(discovery)
}

// Utility: Clear discovery cache so new CRDs/groups appear immediately
#[tauri::command]
async fn clear_discovery_cache(state: State<'_, AppState>) -> Result<(), String> {
    let mut cache = state.discovery_cache.lock().map_err(|e| e.to_string())?;
    *cache = None;
    Ok(())
}

// Helper to create a client based on current state
async fn create_client(state: State<'_, AppState>) -> Result<Client, String> {
    let (path, context) = {
        let path_guard = state.kubeconfig_path.lock().map_err(|e| e.to_string())?;
        let context_guard = state.selected_context.lock().map_err(|e| e.to_string())?;
        (path_guard.clone(), context_guard.clone())
    };

    let kubeconfig = if let Some(p) = &path {
        Kubeconfig::read_from(p).map_err(|e| e.to_string())?
    } else {
        Kubeconfig::read().map_err(|e| e.to_string())?
    };

    let config = kube::Config::from_custom_kubeconfig(
        kubeconfig, 
        &KubeConfigOptions {
            context: context,
            ..Default::default()
        }
    ).await.map_err(|e| e.to_string())?;

    Client::try_from(config).map_err(|e| e.to_string())
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
async fn set_kube_config(
    state: State<'_, AppState>, 
    path: Option<String>, 
    context: Option<String>
) -> Result<(), String> {
    let mut path_guard = state.kubeconfig_path.lock().map_err(|e| e.to_string())?;
    let mut context_guard = state.selected_context.lock().map_err(|e| e.to_string())?;

    *path_guard = path;
    *context_guard = context;

    Ok(())
}

// 1. DISCOVERY ENGINE: Dynamically finds what your cluster supports
#[tauri::command]
async fn discover_api_resources(state: State<'_, AppState>) -> Result<Vec<NavGroup>, String> {
    let client = create_client(state.clone()).await?;
    
    // Discovery fetches ALL groups/versions/kinds from the cluster
    let discovery = Discovery::new(client).run().await.map_err(|e| e.to_string())?;

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
            } else {
                // 2. If not standard, use the API Group as the category
                // This ensures NOTHING is hidden.
                if ar.group.is_empty() {
                    "Core".to_string()
                } else {
                    ar.group.clone()
                }
            };

            println!("Discovered: {} ({}) -> {}", ar.kind, ar.group, category);

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
    let standard_order = vec!["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control"];
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
    {
        use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
        let client2 = create_client(state.clone()).await?;
        let api_crd: Api<CustomResourceDefinition> = Api::all(client2);
        if let Ok(crd_list) = api_crd.list(&ListParams::default()).await {
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
    }

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

// 4a. STREAMING LOGS (follow mode)
#[tauri::command]
async fn start_log_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    container: Option<String>,
    session_id: String,
) -> Result<(), String> {
    let client = create_client(state).await?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);

    let lp = LogParams {
        container,
        tail_lines: Some(100),
        follow: true,
        ..LogParams::default()
    };

    let stream = pods.log_stream(&name, &lp).await.map_err(|e| e.to_string())?;

    tokio::spawn(async move {
        use futures::{AsyncBufReadExt, StreamExt};
        let mut lines = stream.lines();
        while let Some(Ok(line)) = lines.next().await {
            let _ = app.emit(&format!("log_stream:{}", session_id), line + "\n");
        }
        let _ = app.emit(&format!("log_stream_end:{}", session_id), ());
    });

    Ok(())
}

#[tauri::command]
async fn stop_log_stream(_session_id: String) -> Result<(), String> {
    // Streams auto-close when the task is dropped; for explicit control we'd track handles.
    // For now, frontend unmounts → implicit stop.
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
#[tauri::command]
async fn start_exec(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    container: Option<String>,
    session_id: String
) -> Result<(), String> {
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

    let mut attached = pods.exec(&name, vec!["/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"], &ap).await.map_err(|e| e.to_string())?;

    let mut stdin_writer = attached.stdin().ok_or("Failed to get stdin")?;
    let mut stdout = attached.stdout().ok_or("Failed to get stdout")?;

    eprintln!("Got stdin and stdout for session: {}", session_id);

    // Send initial newline to trigger the shell prompt
    use tokio::io::AsyncWriteExt;
    stdin_writer.write_all(b"\n").await.map_err(|e| format!("Failed to write initial newline: {}", e))?;
    stdin_writer.flush().await.map_err(|e| format!("Failed to flush initial newline: {}", e))?;
    eprintln!("Sent initial newline to session: {}", session_id);

    // Store stdin in session map
    let session = Arc::new(ExecSession {
        stdin: tokio::sync::Mutex::new(Box::new(stdin_writer)),
    });

    state.sessions.lock().unwrap().insert(session_id.clone(), session);

    // Spawn background task to read stdout and emit events
    let session_id_clone = session_id.clone();
    let app_handle = app.clone();
    
    tokio::spawn(async move {
        eprintln!("Started stdout reader for session: {}", session_id_clone);
        let mut buf = [0u8; 1024];
        loop {
            let n = match stdout.read(&mut buf).await {
                Ok(n) if n == 0 => {
                    eprintln!("stdout EOF for session: {}", session_id_clone);
                    break;
                }
                Ok(n) => n,
                Err(e) => {
                    eprintln!("Error reading stdout for session {}: {}", session_id_clone, e);
                    break;
                }
            };
            let data = String::from_utf8_lossy(&buf[..n]).to_string();
            eprintln!("Read {} bytes from stdout: {:?}", n, data);
            let _ = app_handle.emit(&format!("term_output:{}", session_id_clone), data);
        }
        eprintln!("Stdout reader ended for session: {}", session_id_clone);
    });

    Ok(())
}

#[tauri::command]
async fn send_exec_input(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    eprintln!("send_exec_input: session_id={}, data_len={}", session_id, data.len());
    
    let session = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&session_id).cloned()
    };

    if let Some(session) = session {
        let mut stdin = session.stdin.lock().await;
        stdin.write_all(data.as_bytes()).await.map_err(|e| {
            eprintln!("Error writing to stdin: {}", e);
            e.to_string()
        })?;
        stdin.flush().await.map_err(|e| {
            eprintln!("Error flushing stdin: {}", e);
            e.to_string()
        })?;
        eprintln!("Successfully wrote {} bytes to stdin", data.len());
    } else {
        eprintln!("Session {} not found", session_id);
        return Err(format!("Session {} not found", session_id));
    }

    Ok(())
}

#[tauri::command]
async fn resize_exec(_state: State<'_, AppState>, _session_id: String, _cols: u16, _rows: u16) -> Result<(), String> {
    // Note: kube-rs AttachedProcess doesn't expose resize easily yet without accessing the underlying websocket.
    // For now, we'll skip resizing or implement it later if critical.
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
    
    // Get pod specs to extract resource limits (only for pods)
    let pod_limits: HashMap<String, (Option<u64>, Option<u64>)> = if kind == "Pod" {
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
        
        if let Ok(pods) = pod_api.list(&ListParams::default()).await {
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
        .setup(|_app| {
            use std::env;
            let key = "PATH";
            let current_path = env::var(key).unwrap_or_default();
            
            // Common paths that might be missing in GUI environment
            let mut paths_to_add = Vec::new();
            
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
            discovery_cache: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            discover_api_resources, 
            list_resources,
            get_resource_details,
            get_resource_metrics,
            delete_resource,
            list_contexts,
            set_kube_config,
            get_pod_logs,
            start_log_stream,
            stop_log_stream,
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
            get_cluster_stats,
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
            ai_local::call_local_llm,
            ai_local::call_local_llm_with_tools,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn get_current_context_name(state: State<'_, AppState>, custom_path: Option<String>) -> Result<String, String> {
    // If custom_path is provided, read from that file directly
    if let Some(path) = custom_path {
        let kubeconfig = Kubeconfig::read_from(path).map_err(|e| e.to_string())?;
        return Ok(kubeconfig.current_context.unwrap_or_else(|| "default".to_string()));
    }

    let context_guard = state.selected_context.lock().map_err(|e| e.to_string())?;
    if let Some(ctx) = &*context_guard {
        return Ok(ctx.clone());
    }

    // Fallback to loading from kubeconfig if not set in state
    let path_guard = state.kubeconfig_path.lock().map_err(|e| e.to_string())?;
    let kubeconfig = if let Some(p) = &*path_guard {
        Kubeconfig::read_from(p).map_err(|e| e.to_string())?
    } else {
        Kubeconfig::read().map_err(|e| e.to_string())?
    };

    Ok(kubeconfig.current_context.unwrap_or_else(|| "default".to_string()))
}

#[tauri::command]
async fn start_local_shell(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    let cmd = if cfg!(target_os = "windows") {
        CommandBuilder::new("powershell")
    } else {
        let shell = std::env::var("SHELL").unwrap_or("bash".to_string());
        CommandBuilder::new(shell)
    };

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = ShellSession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
    };

    state.shell_sessions.lock().unwrap().insert(session_id.clone(), Arc::new(session));

    // Spawn reader thread
    let session_id_clone = session_id.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit(&format!("shell_output:{}", session_id_clone), data);
                }
                Ok(_) => break, // EOF
                Err(_) => break,
            }
        }
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
            write!(writer, "{}", data).map_err(|e| e.to_string())?;
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

#[tauri::command]
async fn get_cluster_stats(state: State<'_, AppState>) -> Result<ClusterStats, String> {
    let client = create_client(state).await?;
    
    let nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
    let deployments: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());
    let services: Api<k8s_openapi::api::core::v1::Service> = Api::all(client.clone());
    let namespaces: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());

    let lp = ListParams::default();
    
    // Fetch each resource individually and handle permission errors gracefully
    let nodes_count = match nodes.list(&lp).await {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list nodes (permission denied?): {}", e);
            0
        }
    };
    
    let pods_count = match pods.list(&lp).await {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list pods: {}", e);
            0
        }
    };
    
    let deployments_count = match deployments.list(&lp).await {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list deployments: {}", e);
            0
        }
    };
    
    let services_count = match services.list(&lp).await {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list services: {}", e);
            0
        }
    };
    
    let namespaces_count = match namespaces.list(&lp).await {
        Ok(list) => list.items.len(),
        Err(e) => {
            eprintln!("Warning: Cannot list namespaces: {}", e);
            0
        }
    };

    Ok(ClusterStats {
        nodes: nodes_count,
        pods: pods_count,
        deployments: deployments_count,
        services: services_count,
        namespaces: namespaces_count,
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
        if let Ok(mut context_guard) = state.selected_context.lock() {
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
    // Execute vcluster connect command without deprecated flag
    let output = tokio::process::Command::new("vcluster")
        .args(&["connect", &name, "-n", &namespace])
        .output()
        .await
        .map_err(|e| format!("Failed to execute vcluster command: {}. Make sure vcluster CLI is installed.", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("vcluster connect failed: {}", stderr));
    }

    // vcluster connect updates the kubeconfig, so we need to reload it
    // The context name will be something like "vcluster_<name>_<namespace>_<original-context>"
    let original_context = get_current_context_name(state.clone(), None).await.unwrap_or_default();
    let new_context = format!("vcluster_{}_{}_", name, namespace) + &original_context;

    
    let mut context_guard = state.selected_context.lock().map_err(|e| e.to_string())?;
    *context_guard = Some(new_context.clone());
    
    Ok(format!("Connected to vcluster '{}' in namespace '{}'. Context: {}", name, namespace, new_context))
}

#[tauri::command]
async fn list_vclusters() -> Result<String, String> {
    // Use vcluster CLI to list all vclusters
    let output = tokio::process::Command::new("vcluster")
        .args(&["list", "--output", "json"])
        .output()
        .await
        .map_err(|e| format!("Failed to execute vcluster command: {}. Make sure vcluster CLI is installed.", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("vcluster list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.to_string())
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
