use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

// ============================================================================
// Data Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupportBundle {
    pub path: String,
    pub namespaces: Vec<String>,
    pub resource_counts: HashMap<String, usize>,
    pub total_resources: usize,
    pub has_events: bool,
    pub has_logs: bool,
    pub has_alerts: bool,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleResource {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub labels: HashMap<String, String>,
    pub status_phase: Option<String>,
    pub conditions: Vec<ResourceCondition>,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleEvent {
    pub name: String,
    pub namespace: String,
    pub reason: String,
    pub message: String,
    pub event_type: String,
    pub involved_object_kind: String,
    pub involved_object_name: String,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleAlert {
    pub name: String,
    pub severity: String,
    pub state: String,
    pub message: Option<String>,
    pub labels: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleAlerts {
    pub critical: Vec<BundleAlert>,
    pub warning: Vec<BundleAlert>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleLogFile {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub file_path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleHealthSummary {
    pub failing_pods: Vec<PodHealthInfo>,
    pub warning_events_count: usize,
    pub critical_alerts_count: usize,
    pub pending_pvcs: Vec<String>,
    pub unhealthy_deployments: Vec<DeploymentHealthInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PodHealthInfo {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub restart_count: i32,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentHealthInfo {
    pub name: String,
    pub namespace: String,
    pub ready_replicas: i32,
    pub desired_replicas: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleNodeInfo {
    pub name: String,
    pub status: String,
    pub roles: Vec<String>,
    pub cpu_capacity: String,
    pub cpu_allocatable: String,
    pub memory_capacity: String,
    pub memory_allocatable: String,
    pub pods_capacity: String,
    pub pods_allocatable: String,
    pub conditions: Vec<NodeCondition>,
    pub labels: HashMap<String, String>,
    pub internal_ip: Option<String>,
    pub hostname: Option<String>,
    pub kubelet_version: Option<String>,
    pub os_image: Option<String>,
    pub kernel_version: Option<String>,
    pub container_runtime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleSearchResult {
    pub resource_type: String,
    pub name: String,
    pub namespace: Option<String>,
    pub match_field: String,
    pub match_snippet: String,
    pub file_path: String,
}

// ============================================================================
// Index Structure (for fast queries)
// ============================================================================

#[derive(Debug, Default)]
pub struct BundleIndex {
    pub resources: Vec<BundleResource>,
    pub events: Vec<BundleEvent>,
    pub by_kind: HashMap<String, Vec<usize>>,
    pub by_namespace: HashMap<String, Vec<usize>>,
    pub by_name: HashMap<String, usize>,
    pub by_status: HashMap<String, Vec<usize>>,
    pub health_summary: Option<BundleHealthSummary>,
}

// Global index storage
use std::sync::{Mutex, OnceLock};

static BUNDLE_INDEX: OnceLock<Mutex<Option<(String, BundleIndex)>>> = OnceLock::new();

fn get_bundle_index() -> &'static Mutex<Option<(String, BundleIndex)>> {
    BUNDLE_INDEX.get_or_init(|| Mutex::new(None))
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Load and index a support bundle
#[tauri::command]
pub async fn load_support_bundle(path: String) -> Result<SupportBundle, String> {
    let bundle_path = Path::new(&path);

    if !bundle_path.exists() {
        return Err(format!("Bundle path does not exist: {}", path));
    }

    if !bundle_path.is_dir() {
        return Err("Bundle path must be a directory".to_string());
    }

    // Discover namespaces (folders that aren't special directories)
    let skip_dirs = ["alerts", "current-logs", "cluster-scope-resources", "service-metrics", ".DS_Store"];
    let mut namespaces = Vec::new();
    let mut resource_counts: HashMap<String, usize> = HashMap::new();
    let mut total_resources = 0;

    for entry in fs::read_dir(bundle_path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        if entry.path().is_dir() && !skip_dirs.contains(&file_name.as_str()) && !file_name.starts_with('.') {
            namespaces.push(file_name.clone());

            // Count resources in this namespace
            let ns_path = entry.path();
            for resource_entry in fs::read_dir(&ns_path).unwrap_or_else(|_| fs::read_dir(".").unwrap()) {
                if let Ok(re) = resource_entry {
                    if re.path().is_dir() {
                        let resource_type = re.file_name().to_string_lossy().to_string();
                        let count = fs::read_dir(re.path())
                            .map(|d| d.filter(|e| e.is_ok()).count())
                            .unwrap_or(0);
                        *resource_counts.entry(resource_type).or_insert(0) += count;
                        total_resources += count;
                    }
                }
            }
        }
    }

    // Check for special files/dirs
    let has_events = bundle_path.join("events.json").exists();
    let has_logs = bundle_path.join("current-logs").exists();
    let has_alerts = bundle_path.join("alerts").exists();

    // Try to get timestamp from events
    let timestamp = if has_events {
        get_bundle_timestamp(&bundle_path.join("events.json"))
    } else {
        None
    };

    // Build the index
    let index = build_bundle_index(&path).await?;

    // Store in global state
    let mut guard = get_bundle_index().lock().map_err(|e| e.to_string())?;
    *guard = Some((path.clone(), index));

    namespaces.sort();

    Ok(SupportBundle {
        path,
        namespaces,
        resource_counts,
        total_resources,
        has_events,
        has_logs,
        has_alerts,
        timestamp,
    })
}

/// Get resource types available in a namespace
#[tauri::command]
pub async fn get_bundle_resource_types(
    bundle_path: String,
    namespace: Option<String>,
) -> Result<Vec<String>, String> {
    let base = Path::new(&bundle_path);

    let target = match &namespace {
        Some(ns) => base.join(ns),
        None => base.join("cluster-scope-resources"),
    };

    if !target.exists() {
        return Ok(vec![]);
    }

    let mut types = Vec::new();
    for entry in fs::read_dir(&target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') {
                types.push(name);
            }
        }
    }

    types.sort();
    Ok(types)
}

/// List resources of a specific type in a namespace
#[tauri::command]
pub async fn get_bundle_resources(
    bundle_path: String,
    namespace: Option<String>,
    resource_type: String,
) -> Result<Vec<BundleResource>, String> {
    let base = Path::new(&bundle_path);

    let target = match &namespace {
        Some(ns) => base.join(ns).join(&resource_type),
        None => base.join("cluster-scope-resources").join(&resource_type),
    };

    if !target.exists() {
        return Ok(vec![]);
    }

    let mut resources = Vec::new();

    for entry in fs::read_dir(&target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().map(|e| e == "yaml" || e == "yml").unwrap_or(false) {
            if let Ok(resource) = parse_resource_file(&path, namespace.clone()) {
                resources.push(resource);
            }
        }
    }

    // Sort by name
    resources.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(resources)
}

/// Get raw YAML for a resource
#[tauri::command]
pub async fn get_bundle_resource_yaml(
    bundle_path: String,
    namespace: Option<String>,
    resource_type: String,
    name: String,
) -> Result<String, String> {
    let base = Path::new(&bundle_path);

    let target = match &namespace {
        Some(ns) => base.join(ns).join(&resource_type),
        None => base.join("cluster-scope-resources").join(&resource_type),
    };

    // Try different filename patterns
    let patterns = [
        format!("{}.yaml", name),
        format!("{}.yml", name),
    ];

    for pattern in patterns {
        let file_path = target.join(&pattern);
        if file_path.exists() {
            return fs::read_to_string(&file_path).map_err(|e| e.to_string());
        }
    }

    Err(format!("Resource not found: {}/{}", resource_type, name))
}

/// Get events from the bundle
#[tauri::command]
pub async fn get_bundle_events(
    bundle_path: String,
    namespace: Option<String>,
    involved_object: Option<String>,
) -> Result<Vec<BundleEvent>, String> {
    let events_path = Path::new(&bundle_path).join("events.json");

    if !events_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&events_path).map_err(|e| e.to_string())?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mut result = Vec::new();

    for event in events {
        let ev = parse_event(&event);

        // Apply filters
        if let Some(ref ns) = namespace {
            if ev.namespace != *ns {
                continue;
            }
        }

        if let Some(ref obj) = involved_object {
            if ev.involved_object_name != *obj {
                continue;
            }
        }

        result.push(ev);
    }

    // Sort by last timestamp (most recent first)
    result.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));

    Ok(result)
}

/// Get available log files for a pod
#[tauri::command]
pub async fn get_bundle_log_files(
    bundle_path: String,
    namespace: String,
    pod: String,
) -> Result<Vec<BundleLogFile>, String> {
    let logs_path = Path::new(&bundle_path)
        .join("current-logs")
        .join(&namespace)
        .join(&pod);

    if !logs_path.exists() {
        return Ok(vec![]);
    }

    let mut log_files = Vec::new();

    for entry in fs::read_dir(&logs_path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().map(|e| e == "log").unwrap_or(false) {
            let file_name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let metadata = fs::metadata(&path).ok();

            log_files.push(BundleLogFile {
                namespace: namespace.clone(),
                pod: pod.clone(),
                container: file_name,
                file_path: path.to_string_lossy().to_string(),
                size_bytes: metadata.map(|m| m.len()).unwrap_or(0),
            });
        }
    }

    Ok(log_files)
}

/// Get log content
#[tauri::command]
pub async fn get_bundle_logs(
    bundle_path: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    tail: Option<usize>,
) -> Result<String, String> {
    let logs_base = Path::new(&bundle_path)
        .join("current-logs")
        .join(&namespace)
        .join(&pod);

    if !logs_base.exists() {
        return Err(format!("No logs found for pod {}/{}", namespace, pod));
    }

    // Find the log file
    let log_file = if let Some(ref c) = container {
        logs_base.join(format!("{}.log", c))
    } else {
        // Find first .log file
        fs::read_dir(&logs_base)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .find(|e| e.path().extension().map(|ext| ext == "log").unwrap_or(false))
            .map(|e| e.path())
            .ok_or_else(|| "No log files found".to_string())?
    };

    if !log_file.exists() {
        return Err(format!("Log file not found: {:?}", log_file));
    }

    let content = fs::read_to_string(&log_file).map_err(|e| e.to_string())?;

    // Apply tail if specified
    if let Some(n) = tail {
        let lines: Vec<&str> = content.lines().collect();
        let start = if lines.len() > n { lines.len() - n } else { 0 };
        Ok(lines[start..].join("\n"))
    } else {
        Ok(content)
    }
}

/// Get alerts from the bundle
#[tauri::command]
pub async fn get_bundle_alerts(bundle_path: String) -> Result<BundleAlerts, String> {
    let alerts_path = Path::new(&bundle_path).join("alerts");

    let mut result = BundleAlerts {
        critical: vec![],
        warning: vec![],
    };

    if !alerts_path.exists() {
        return Ok(result);
    }

    // Parse critical.json
    let critical_path = alerts_path.join("critical.json");
    if critical_path.exists() {
        if let Ok(content) = fs::read_to_string(&critical_path) {
            if let Ok(alerts) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                result.critical = alerts.iter().filter_map(|a| parse_alert(a)).collect();
            }
        }
    }

    // Parse warning.json
    let warning_path = alerts_path.join("warning.json");
    if warning_path.exists() {
        if let Ok(content) = fs::read_to_string(&warning_path) {
            if let Ok(alerts) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                result.warning = alerts.iter().filter_map(|a| parse_alert(a)).collect();
            }
        }
    }

    Ok(result)
}

/// Get health summary (pre-computed insights)
#[tauri::command]
pub async fn get_bundle_health_summary(bundle_path: String) -> Result<BundleHealthSummary, String> {
    // Check if we have cached health summary
    {
        let guard = get_bundle_index().lock().map_err(|e| e.to_string())?;
        if let Some((indexed_path, index)) = guard.as_ref() {
            if indexed_path == &bundle_path {
                if let Some(ref summary) = index.health_summary {
                    let result: BundleHealthSummary = summary.clone();
                    return Ok(result);
                }
            }
        }
    } // guard dropped here before await

    // Build health summary from scratch
    compute_health_summary(&bundle_path).await
}

/// Search across the bundle
#[tauri::command]
pub async fn search_bundle(
    bundle_path: String,
    query: String,
    namespace: Option<String>,
    resource_type: Option<String>,
) -> Result<Vec<BundleSearchResult>, String> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    let guard = get_bundle_index().lock().map_err(|e| e.to_string())?;

    if let Some((indexed_path, index)) = guard.as_ref() {
        if indexed_path == &bundle_path {
            for resource in &index.resources {
                // Apply filters
                if let Some(ref ns) = namespace {
                    if resource.namespace.as_ref() != Some(ns) {
                        continue;
                    }
                }

                if let Some(ref rt) = resource_type {
                    if resource.kind.to_lowercase() != rt.to_lowercase() {
                        continue;
                    }
                }

                // Search in name
                if resource.name.to_lowercase().contains(&query_lower) {
                    results.push(BundleSearchResult {
                        resource_type: resource.kind.clone(),
                        name: resource.name.clone(),
                        namespace: resource.namespace.clone(),
                        match_field: "name".to_string(),
                        match_snippet: resource.name.clone(),
                        file_path: resource.file_path.clone(),
                    });
                    continue;
                }

                // Search in labels
                for (key, value) in &resource.labels {
                    if key.to_lowercase().contains(&query_lower) || value.to_lowercase().contains(&query_lower) {
                        results.push(BundleSearchResult {
                            resource_type: resource.kind.clone(),
                            name: resource.name.clone(),
                            namespace: resource.namespace.clone(),
                            match_field: "label".to_string(),
                            match_snippet: format!("{}={}", key, value),
                            file_path: resource.file_path.clone(),
                        });
                        break;
                    }
                }
            }
        }
    }

    // Limit results
    results.truncate(100);

    Ok(results)
}

/// Get pods with specific status (e.g., "CrashLoopBackOff", "Pending")
#[tauri::command]
pub async fn get_bundle_pods_by_status(
    bundle_path: String,
    status: String,
) -> Result<Vec<BundleResource>, String> {
    let guard = get_bundle_index().lock().map_err(|e| e.to_string())?;

    let status_lower = status.to_lowercase();

    if let Some((indexed_path, index)) = guard.as_ref() {
        if indexed_path == &bundle_path {
            let pods: Vec<BundleResource> = index.resources.iter()
                .filter(|r| {
                    r.kind.to_lowercase() == "pod" &&
                    r.status_phase.as_ref().map(|s| s.to_lowercase().contains(&status_lower)).unwrap_or(false)
                })
                .cloned()
                .collect();
            return Ok(pods);
        }
    }

    Ok(vec![])
}

/// Get all resources from the indexed bundle (grouped by namespace)
#[tauri::command]
pub async fn get_all_bundle_resources(
    bundle_path: String,
) -> Result<HashMap<String, Vec<BundleResource>>, String> {
    let guard = get_bundle_index().lock().map_err(|e| e.to_string())?;

    if let Some((indexed_path, index)) = guard.as_ref() {
        if indexed_path == &bundle_path {
            let mut by_namespace: HashMap<String, Vec<BundleResource>> = HashMap::new();

            for resource in &index.resources {
                let ns = resource.namespace.clone().unwrap_or_else(|| "cluster-scope".to_string());
                by_namespace.entry(ns).or_default().push(resource.clone());
            }

            return Ok(by_namespace);
        }
    }

    // Bundle not indexed yet, return empty
    Ok(HashMap::new())
}

/// Close/unload a bundle
#[tauri::command]
pub async fn close_support_bundle() -> Result<(), String> {
    let mut guard = get_bundle_index().lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

// ============================================================================
// Helper Functions
// ============================================================================

fn get_bundle_timestamp(events_path: &Path) -> Option<String> {
    let content = fs::read_to_string(events_path).ok()?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&content).ok()?;

    // Get the most recent event timestamp
    events.iter()
        .filter_map(|e| {
            e.get("lastTimestamp")
                .or_else(|| e.get("metadata").and_then(|m| m.get("creationTimestamp")))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .max()
}

fn parse_resource_file(path: &Path, namespace: Option<String>) -> Result<BundleResource, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;

    // Handle the "object:" wrapper format
    let obj = if let Some(o) = yaml.get("object") {
        o
    } else {
        &yaml
    };

    let api_version = obj.get("apiVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("v1")
        .to_string();

    let kind = obj.get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    let metadata = obj.get("metadata").ok_or("No metadata")?;

    let name = metadata.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let ns = namespace.or_else(|| {
        metadata.get("namespace")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    // Parse labels
    let mut labels = HashMap::new();
    if let Some(label_map) = metadata.get("labels").and_then(|l| l.as_mapping()) {
        for (k, v) in label_map {
            if let (Some(key), Some(val)) = (k.as_str(), v.as_str()) {
                labels.insert(key.to_string(), val.to_string());
            }
        }
    }

    // Parse status
    let status_phase = obj.get("status")
        .and_then(|s| s.get("phase"))
        .and_then(|p| p.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            // For pods, check containerStatuses for waiting reasons
            obj.get("status")
                .and_then(|s| s.get("containerStatuses"))
                .and_then(|cs| cs.as_sequence())
                .and_then(|seq| seq.first())
                .and_then(|c| {
                    c.get("state")
                        .and_then(|st| st.get("waiting"))
                        .and_then(|w| w.get("reason"))
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string())
                })
        });

    // Parse conditions
    let mut conditions = Vec::new();
    if let Some(conds) = obj.get("status").and_then(|s| s.get("conditions")).and_then(|c| c.as_sequence()) {
        for cond in conds {
            if let Some(cond_type) = cond.get("type").and_then(|t| t.as_str()) {
                conditions.push(ResourceCondition {
                    condition_type: cond_type.to_string(),
                    status: cond.get("status").and_then(|s| s.as_str()).unwrap_or("Unknown").to_string(),
                    reason: cond.get("reason").and_then(|r| r.as_str()).map(|s| s.to_string()),
                    message: cond.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()),
                });
            }
        }
    }

    Ok(BundleResource {
        api_version,
        kind,
        name,
        namespace: ns,
        labels,
        status_phase,
        conditions,
        file_path: path.to_string_lossy().to_string(),
    })
}

fn parse_event(event: &serde_json::Value) -> BundleEvent {
    let metadata = event.get("metadata").unwrap_or(event);
    let involved = event.get("involvedObject").unwrap_or(event);

    BundleEvent {
        name: metadata.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        namespace: metadata.get("namespace").and_then(|v| v.as_str()).unwrap_or("default").to_string(),
        reason: event.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        message: event.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        event_type: event.get("type").and_then(|v| v.as_str()).unwrap_or("Normal").to_string(),
        involved_object_kind: involved.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        involved_object_name: involved.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        first_timestamp: event.get("firstTimestamp").and_then(|v| v.as_str()).map(|s| s.to_string()),
        last_timestamp: event.get("lastTimestamp").and_then(|v| v.as_str()).map(|s| s.to_string()),
        count: event.get("count").and_then(|v| v.as_i64()).unwrap_or(1) as i32,
    }
}

fn parse_alert(alert: &serde_json::Value) -> Option<BundleAlert> {
    let labels = alert.get("labels")?;

    let mut label_map = HashMap::new();
    if let Some(obj) = labels.as_object() {
        for (k, v) in obj {
            if let Some(val) = v.as_str() {
                label_map.insert(k.clone(), val.to_string());
            }
        }
    }

    Some(BundleAlert {
        name: labels.get("alertname").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
        severity: labels.get("severity").and_then(|v| v.as_str()).unwrap_or("warning").to_string(),
        state: alert.get("state").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
        message: alert.get("annotations")
            .and_then(|a| a.get("message").or_else(|| a.get("description")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        labels: label_map,
    })
}

async fn build_bundle_index(bundle_path: &str) -> Result<BundleIndex, String> {
    let base = Path::new(bundle_path);
    let mut index = BundleIndex::default();

    // Index all namespaced resources
    let skip_dirs = ["alerts", "current-logs", "cluster-scope-resources", "service-metrics"];

    for entry in fs::read_dir(base).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let dir_name = entry.file_name().to_string_lossy().to_string();

        if entry.path().is_dir() && !skip_dirs.contains(&dir_name.as_str()) && !dir_name.starts_with('.') {
            // This is a namespace directory
            index_namespace(&entry.path(), Some(dir_name), &mut index)?;
        }
    }

    // Index cluster-scope resources
    let cluster_scope = base.join("cluster-scope-resources");
    if cluster_scope.exists() {
        index_namespace(&cluster_scope, None, &mut index)?;
    }

    // Index events
    let events_path = base.join("events.json");
    if events_path.exists() {
        if let Ok(content) = fs::read_to_string(&events_path) {
            if let Ok(events) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                index.events = events.iter().map(|e| parse_event(e)).collect();
            }
        }
    }

    // Compute health summary
    index.health_summary = Some(compute_health_from_index(&index));

    Ok(index)
}

fn index_namespace(ns_path: &Path, namespace: Option<String>, index: &mut BundleIndex) -> Result<(), String> {
    for type_entry in fs::read_dir(ns_path).map_err(|e| e.to_string())? {
        let type_entry = type_entry.map_err(|e| e.to_string())?;
        if !type_entry.path().is_dir() {
            continue;
        }

        let resource_type = type_entry.file_name().to_string_lossy().to_string();
        if resource_type.starts_with('.') {
            continue;
        }

        for file_entry in fs::read_dir(type_entry.path()).map_err(|e| e.to_string())? {
            let file_entry = file_entry.map_err(|e| e.to_string())?;
            let path = file_entry.path();

            if path.extension().map(|e| e == "yaml" || e == "yml").unwrap_or(false) {
                if let Ok(resource) = parse_resource_file(&path, namespace.clone()) {
                    let idx = index.resources.len();

                    // Add to indexes
                    index.by_kind.entry(resource.kind.clone()).or_default().push(idx);

                    if let Some(ref ns) = resource.namespace {
                        index.by_namespace.entry(ns.clone()).or_default().push(idx);
                    }

                    index.by_name.insert(resource.name.clone(), idx);

                    if let Some(ref status) = resource.status_phase {
                        index.by_status.entry(status.clone()).or_default().push(idx);
                    }

                    index.resources.push(resource);
                }
            }
        }
    }

    Ok(())
}

fn compute_health_from_index(index: &BundleIndex) -> BundleHealthSummary {
    let mut failing_pods = Vec::new();
    let mut unhealthy_deployments = Vec::new();
    let mut pending_pvcs = Vec::new();

    for resource in &index.resources {
        match resource.kind.as_str() {
            "Pod" => {
                let status = resource.status_phase.as_deref().unwrap_or("");
                let is_unhealthy = matches!(status,
                    "CrashLoopBackOff" | "ImagePullBackOff" | "ErrImagePull" |
                    "Error" | "Failed" | "OOMKilled" | "Pending"
                );

                if is_unhealthy {
                    // Try to get restart count from conditions or status
                    failing_pods.push(PodHealthInfo {
                        name: resource.name.clone(),
                        namespace: resource.namespace.clone().unwrap_or_default(),
                        status: status.to_string(),
                        restart_count: 0, // Would need deeper parsing
                        reason: resource.conditions.first().and_then(|c| c.reason.clone()),
                    });
                }
            }
            "Deployment" => {
                // Check if replicas match
                let ready = resource.conditions.iter()
                    .find(|c| c.condition_type == "Available")
                    .map(|c| c.status == "True")
                    .unwrap_or(false);

                if !ready {
                    unhealthy_deployments.push(DeploymentHealthInfo {
                        name: resource.name.clone(),
                        namespace: resource.namespace.clone().unwrap_or_default(),
                        ready_replicas: 0,
                        desired_replicas: 0,
                    });
                }
            }
            "PersistentVolumeClaim" => {
                if resource.status_phase.as_deref() == Some("Pending") {
                    pending_pvcs.push(format!("{}/{}",
                        resource.namespace.as_deref().unwrap_or("default"),
                        resource.name
                    ));
                }
            }
            _ => {}
        }
    }

    // Count warning events
    let warning_events_count = index.events.iter()
        .filter(|e| e.event_type == "Warning")
        .count();

    BundleHealthSummary {
        failing_pods,
        warning_events_count,
        critical_alerts_count: 0, // Will be filled from alerts
        pending_pvcs,
        unhealthy_deployments,
    }
}

async fn compute_health_summary(bundle_path: &str) -> Result<BundleHealthSummary, String> {
    // Load and index if not already done
    let _bundle = load_support_bundle(bundle_path.to_string()).await?;

    let guard = get_bundle_index().lock().map_err(|e| e.to_string())?;
    if let Some((_, index)) = guard.as_ref() {
        if let Some(ref summary) = index.health_summary {
            let result: BundleHealthSummary = summary.clone();
            return Ok(result);
        }
    }

    Ok(BundleHealthSummary {
        failing_pods: vec![],
        warning_events_count: 0,
        critical_alerts_count: 0,
        pending_pvcs: vec![],
        unhealthy_deployments: vec![],
    })
}

/// Get all node information from the bundle
#[tauri::command]
pub async fn get_bundle_nodes(bundle_path: String) -> Result<Vec<BundleNodeInfo>, String> {
    let nodes_dir = Path::new(&bundle_path).join("cluster-scope-resources").join("nodes");

    if !nodes_dir.exists() {
        return Ok(vec![]);
    }

    let mut nodes = Vec::new();

    if let Ok(entries) = fs::read_dir(&nodes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "yaml" || e == "yml") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
                        // Handle both wrapped (object.kind) and direct formats
                        let node = if yaml.get("object").is_some() {
                            yaml.get("object").unwrap()
                        } else {
                            &yaml
                        };

                        if node.get("kind").and_then(|v| v.as_str()) == Some("Node") {
                            let name = node.get("metadata")
                                .and_then(|m| m.get("name"))
                                .and_then(|n| n.as_str())
                                .unwrap_or("unknown")
                                .to_string();

                            // Parse labels
                            let labels: HashMap<String, String> = node.get("metadata")
                                .and_then(|m| m.get("labels"))
                                .and_then(|l| l.as_mapping())
                                .map(|m| {
                                    m.iter()
                                        .filter_map(|(k, v)| {
                                            Some((k.as_str()?.to_string(), v.as_str()?.to_string()))
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();

                            // Determine roles from labels
                            let mut roles: Vec<String> = labels.iter()
                                .filter(|(k, _)| k.starts_with("node-role.kubernetes.io/"))
                                .map(|(k, _)| k.replace("node-role.kubernetes.io/", ""))
                                .collect();
                            if roles.is_empty() {
                                roles.push("worker".to_string());
                            }

                            // Parse status
                            let status_val = node.get("status");

                            // Get capacity
                            let capacity = status_val.and_then(|s| s.get("capacity"));
                            let cpu_capacity = capacity
                                .and_then(|c| c.get("cpu"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string();
                            let memory_capacity = capacity
                                .and_then(|c| c.get("memory"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string();
                            let pods_capacity = capacity
                                .and_then(|c| c.get("pods"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string();

                            // Get allocatable
                            let allocatable = status_val.and_then(|s| s.get("allocatable"));
                            let cpu_allocatable = allocatable
                                .and_then(|a| a.get("cpu"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string();
                            let memory_allocatable = allocatable
                                .and_then(|a| a.get("memory"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string();
                            let pods_allocatable = allocatable
                                .and_then(|a| a.get("pods"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string();

                            // Get conditions
                            let conditions: Vec<NodeCondition> = status_val
                                .and_then(|s| s.get("conditions"))
                                .and_then(|c| c.as_sequence())
                                .map(|seq| {
                                    seq.iter()
                                        .filter_map(|cond| {
                                            Some(NodeCondition {
                                                condition_type: cond.get("type")?.as_str()?.to_string(),
                                                status: cond.get("status")?.as_str()?.to_string(),
                                                reason: cond.get("reason").and_then(|r| r.as_str()).map(|s| s.to_string()),
                                                message: cond.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()),
                                            })
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();

                            // Determine overall status from conditions
                            let ready_condition = conditions.iter()
                                .find(|c| c.condition_type == "Ready");
                            let status = match ready_condition {
                                Some(c) if c.status == "True" => "Ready".to_string(),
                                Some(_) => "NotReady".to_string(),
                                None => "Unknown".to_string(),
                            };

                            // Get addresses
                            let addresses = status_val.and_then(|s| s.get("addresses")).and_then(|a| a.as_sequence());
                            let internal_ip = addresses.and_then(|addrs| {
                                addrs.iter()
                                    .find(|a| a.get("type").and_then(|t| t.as_str()) == Some("InternalIP"))
                                    .and_then(|a| a.get("address"))
                                    .and_then(|a| a.as_str())
                                    .map(|s| s.to_string())
                            });
                            let hostname = addresses.and_then(|addrs| {
                                addrs.iter()
                                    .find(|a| a.get("type").and_then(|t| t.as_str()) == Some("Hostname"))
                                    .and_then(|a| a.get("address"))
                                    .and_then(|a| a.as_str())
                                    .map(|s| s.to_string())
                            });

                            // Get node info
                            let node_info = status_val.and_then(|s| s.get("nodeInfo"));
                            let kubelet_version = node_info
                                .and_then(|n| n.get("kubeletVersion"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let os_image = node_info
                                .and_then(|n| n.get("osImage"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let kernel_version = node_info
                                .and_then(|n| n.get("kernelVersion"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let container_runtime = node_info
                                .and_then(|n| n.get("containerRuntimeVersion"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            nodes.push(BundleNodeInfo {
                                name,
                                status,
                                roles,
                                cpu_capacity,
                                cpu_allocatable,
                                memory_capacity,
                                memory_allocatable,
                                pods_capacity,
                                pods_allocatable,
                                conditions,
                                labels,
                                internal_ip,
                                hostname,
                                kubelet_version,
                                os_image,
                                kernel_version,
                                container_runtime,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(nodes)
}

/// AI-powered bundle analysis using the configured LLM
#[tauri::command]
pub async fn ai_analyze_bundle(bundle_context: String, user_query: String) -> Result<String, String> {
    use keyring::Entry;

    // Get the API key from keychain
    let api_key = Entry::new("opspilot", "llm_api_key")
        .ok()
        .and_then(|entry| entry.get_password().ok());

    let api_key = match api_key {
        Some(key) if !key.is_empty() => key,
        _ => {
            return Err("No API key configured. Please configure your LLM settings in the Settings page.".to_string());
        }
    };

    // Load LLM config to get the model
    let config_path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".opspilot")
        .join("llm-config.json");

    let (base_url, model) = if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(content) => {
                let config: serde_json::Value = serde_json::from_str(&content)
                    .unwrap_or(serde_json::json!({}));
                let base_url = config.get("base_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("https://api.anthropic.com/v1")
                    .to_string();
                let model = config.get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("claude-sonnet-4-20250514")
                    .to_string();
                (base_url, model)
            }
            Err(_) => ("https://api.anthropic.com/v1".to_string(), "claude-sonnet-4-20250514".to_string())
        }
    } else {
        ("https://api.anthropic.com/v1".to_string(), "claude-sonnet-4-20250514".to_string())
    };

    // Build the prompt
    let system_prompt = r#"You are an expert Kubernetes SRE assistant analyzing a support bundle.
Your role is to help identify issues, explain problems, and provide actionable recommendations.
Be concise and practical. Focus on the most critical issues first.
When analyzing the bundle data, look for patterns such as:
- Pods in CrashLoopBackOff, ImagePullBackOff, or Error states
- Pending pods that may indicate resource constraints
- Warning events that suggest configuration issues
- Critical alerts that need immediate attention
- Node health issues
- Resource pressure (memory, CPU, disk)
Provide specific kubectl commands when helpful."#;

    let full_prompt = format!("{}\n\n---\n\nUser question: {}", bundle_context, user_query);

    // Make API request
    let client = reqwest::Client::new();

    // Determine if this is Anthropic or OpenAI compatible
    let is_anthropic = base_url.contains("anthropic.com");

    let response = if is_anthropic {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 2048,
            "messages": [
                {
                    "role": "user",
                    "content": full_prompt
                }
            ],
            "system": system_prompt
        });

        client.post(format!("{}/messages", base_url))
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to call API: {}", e))?
    } else {
        // OpenAI compatible
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 2048,
            "messages": [
                {
                    "role": "system",
                    "content": system_prompt
                },
                {
                    "role": "user",
                    "content": full_prompt
                }
            ]
        });

        client.post(format!("{}/chat/completions", base_url))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to call API: {}", e))?
    };

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API error ({}): {}", status, error_text));
    }

    let response_json: serde_json::Value = response.json().await
        .map_err(|e| format!("Failed to parse API response: {}", e))?;

    // Extract content based on API type
    let content = if is_anthropic {
        response_json.get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("No response content")
            .to_string()
    } else {
        response_json.get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|msg| msg.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("No response content")
            .to_string()
    };

    Ok(content)
}
