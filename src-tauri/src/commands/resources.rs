
use tauri::{State, Emitter};
use kube::{
    api::{Api, ListParams, DeleteParams, LogParams, DynamicObject, GroupVersionKind, Patch, PatchParams},
    runtime::watcher::{watcher, Config as WatcherConfig, Event as WatcherEvent},
    Discovery,
};
use crate::state::AppState;
use crate::models::{ResourceRequest, ResourceSummary, ResourceWatchEvent, K8sEvent};
use crate::client::create_client;
use crate::commands::discovery::get_cached_discovery;
use futures::{StreamExt, TryStreamExt};

// Helper to convert DynamicObject to ResourceSummary
fn to_summary(obj: DynamicObject, req_kind: &str, req_group: &str, req_version: &str, include_raw: bool) -> ResourceSummary {
    let name = obj.metadata.name.clone().unwrap_or_default();
    let namespace = obj.metadata.namespace.clone().unwrap_or("-".into());

    let is_terminating = obj.metadata.deletion_timestamp.is_some();
    let raw_json = if include_raw { 
        serde_json::to_string_pretty(&obj).unwrap_or_default() 
    } else { 
        String::new() 
    };

    let status = if is_terminating {
        "Terminating".to_string()
    } else if req_kind == "Deployment" {
        let status_obj = obj.data.get("status");
        let spec_obj = obj.data.get("spec");
        let replicas = spec_obj.and_then(|s| s.get("replicas")).and_then(|v| v.as_i64()).unwrap_or(1) as i32;
        let ready_replicas = status_obj.and_then(|s| s.get("readyReplicas")).and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let available_replicas = status_obj.and_then(|s| s.get("availableReplicas")).and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let updated_replicas = status_obj.and_then(|s| s.get("updatedReplicas")).and_then(|v| v.as_i64()).unwrap_or(replicas as i64) as i32;
        let has_unavailable = status_obj.and_then(|s| s.get("unavailableReplicas")).is_some();
        let unavailable_replicas = status_obj.and_then(|s| s.get("unavailableReplicas")).and_then(|v| v.as_i64()).unwrap_or(0) as i32;

        if ready_replicas >= replicas && available_replicas >= replicas && !has_unavailable {
            "Running".to_string()
        } else if has_unavailable && unavailable_replicas > 0 {
            "Progressing".to_string()
        } else if updated_replicas < replicas {
            "Updating".to_string()
        } else if ready_replicas < replicas || available_replicas < replicas {
            "Scaling".to_string()
        } else {
            "Running".to_string()
        }
    } else {
        obj.data.get("status")
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
            .to_string()
    };

    let (ready, restarts, node, ip) = if req_kind.to_lowercase() == "pod" {
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

    let labels = obj.metadata.labels.clone();

    ResourceSummary {
        id: obj.metadata.uid.clone().unwrap_or_default(),
        name,
        namespace,
        kind: req_kind.to_string(),
        group: req_group.to_string(),
        version: req_version.to_string(),
        age: obj.metadata.creation_timestamp.clone().map(|t| t.0.to_rfc3339()).unwrap_or_default(),
        status,
        raw_json,
        ready,
        restarts,
        node,
        ip,
        labels,
    }
}

#[tauri::command]
pub async fn list_resources(state: State<'_, AppState>, req: ResourceRequest) -> Result<Vec<ResourceSummary>, String> {
    let client = create_client(state.clone()).await?;
    let gvk = GroupVersionKind::gvk(&req.group, &req.version, &req.kind);
    let discovery = get_cached_discovery(&state, client.clone()).await?;
    
    // Resolve the GVK to an API Resource
    let ar = if let Some((res, _caps)) = discovery.resolve_gvk(&gvk) {
        res
    } else {
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
            return Err(format!("Resource kind not found: {}/{}/{}", req.group, req.version, req.kind));
        }
    };

    let ns_opt = req.namespace.clone();
    let api: Api<DynamicObject> = if let Some(ns) = ns_opt.clone() {
        Api::namespaced_with(client.clone(), &ns, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    };

    let list = match api.list(&ListParams::default()).await {
        Ok(l) => l,
        Err(e) => {
            // Retry logic omitted for brevity, returning error
            return Err(e.to_string());
        }
    };
    
    let kind = req.kind.clone();
    let group = req.group.clone();
    let version = ar.version.clone();
    // Default false, can be passed
    let include_raw = req.include_raw.unwrap_or(false);

    let summaries = list.into_iter().map(|obj| {
        to_summary(obj, &kind, &group, &version, include_raw)
    }).collect();

    Ok(summaries)
}

#[tauri::command]
pub async fn delete_resource(state: State<'_, AppState>, req: ResourceRequest, name: String) -> Result<(), String> {
    let client = create_client(state).await?;
    let gvk = GroupVersionKind::gvk(&req.group, &req.version, &req.kind);
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?; // Should use cached but this is delete (rare)
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("Resource not found")?;

    let api: Api<DynamicObject> = if let Some(ns) = req.namespace {
        Api::namespaced_with(client, &ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    api.delete(&name, &DeleteParams::default()).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_resource_details(state: State<'_, AppState>, req: ResourceRequest, name: String) -> Result<String, String> {
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
    Ok(serde_yaml::to_string(&obj).unwrap_or_default())
}

#[tauri::command]
pub async fn get_pod_logs(state: State<'_, AppState>, namespace: String, name: String, container: Option<String>) -> Result<String, String> {
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

#[tauri::command]
pub async fn start_log_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    container: Option<String>,
    session_id: String,
    tail_lines: Option<i64>,
) -> Result<(), String> {
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
        tail_lines: Some(tail_lines.unwrap_or(500)),
        follow: true,
        ..LogParams::default()
    };

    let stream = pods.log_stream(&name, &lp).await.map_err(|e| e.to_string())?;
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    {
        let mut streams = state.log_streams.lock().unwrap();
        streams.insert(session_id.clone(), cancel_tx);
    }

    let log_streams = state.log_streams.clone();
    let sid = session_id.clone();

    tokio::spawn(async move {
        use futures::AsyncReadExt;
        let mut buf = vec![0u8; 16384];
        let mut stream = Box::pin(stream);

        loop {
            tokio::select! {
                biased;
                _ = &mut cancel_rx => { break; }
                result = stream.read(&mut buf) => {
                    match result {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            println!("[Backend] Received log chunk: {} bytes at {:?}", n, std::time::Instant::now());
                            let _ = app.emit(&format!("log_stream:{}", sid), data);
                        }
                        Err(_) => break,
                    }
                }
            }
        }

        {
            let mut streams = log_streams.lock().unwrap();
            streams.remove(&sid);
        }
        let _ = app.emit(&format!("log_stream_end:{}", sid), ());
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_log_stream(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut streams = state.log_streams.lock().unwrap();
    if let Some(cancel_tx) = streams.remove(&session_id) {
        let _ = cancel_tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn start_resource_watch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    req: ResourceRequest,
    watch_id: String,
) -> Result<(), String> {
    let client = create_client(state.clone()).await?;
    let gvk = GroupVersionKind::gvk(&req.group, &req.version, &req.kind);
    let discovery = get_cached_discovery(&state, client.clone()).await?;

    let ar = if let Some((res, _caps)) = discovery.resolve_gvk(&gvk) {
        res
    } else {
        return Err(format!("Resource kind not found: {}/{}/{}", req.group, req.version, req.kind));
    };

    let kind = req.kind.clone();
    let group = req.group.clone();
    let version = ar.version.clone();
    let include_raw = req.include_raw.unwrap_or(false);

    let api: Api<DynamicObject> = if let Some(ns) = req.namespace.clone() {
        Api::namespaced_with(client.clone(), &ns, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    };

    let watch_id_clone = watch_id.clone();
    
    tokio::spawn(async move {
        let watcher_config = WatcherConfig::default();
        let mut stream = watcher(api, watcher_config).boxed();

        while let Ok(Some(event)) = stream.try_next().await {
            let watch_event = match event {
                WatcherEvent::Apply(obj) => {
                    ResourceWatchEvent {
                        event_type: "MODIFIED".to_string(),
                        resource: to_summary(obj, &kind, &group, &version, include_raw),
                    }
                }
                WatcherEvent::Delete(obj) => {
                    ResourceWatchEvent {
                        event_type: "DELETED".to_string(),
                        resource: to_summary(obj, &kind, &group, &version, include_raw),
                    }
                }
                WatcherEvent::Init => { continue; }
                WatcherEvent::InitApply(obj) => {
                    ResourceWatchEvent {
                        event_type: "ADDED".to_string(),
                        resource: to_summary(obj, &kind, &group, &version, include_raw),
                    }
                }
                WatcherEvent::InitDone => {
                    let _ = app.emit(&format!("resource_watch_sync:{}", watch_id_clone), "SYNC_COMPLETE");
                    continue;
                }
            };

            let _ = app.emit(&format!("resource_watch:{}", watch_id_clone), watch_event);
        }
        let _ = app.emit(&format!("resource_watch_end:{}", watch_id_clone), ());
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_resource_watch(_watch_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn list_events(state: State<'_, AppState>, namespace: String, name: String, uid: Option<String>) -> Result<Vec<K8sEvent>, String> {
    let client = create_client(state).await?;
    let core_api: Api<k8s_openapi::api::core::v1::Event> = if namespace == "-" { Api::all(client.clone()) } else { Api::namespaced(client.clone(), &namespace) };
    let new_api: Api<k8s_openapi::api::events::v1::Event> = if namespace == "-" { Api::all(client.clone()) } else { Api::namespaced(client.clone(), &namespace) };

    let lp = ListParams::default();

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
                    age: e.last_timestamp.clone().map(|t| t.0.to_rfc3339()).unwrap_or_else(|| e.event_time.clone().map(|t| t.0.to_rfc3339()).unwrap_or_default()),
                    last_timestamp: e.last_timestamp.map(|t| t.0.to_rfc3339()).or_else(|| e.event_time.map(|t| t.0.to_rfc3339())),
                    count: e.count.unwrap_or(1),
                })
            } else { None }
        }).collect::<Vec<_>>(),
        Err(_) => vec![]
    };

    let new_events = match new_api.list(&lp).await {
        Ok(list) => list.into_iter().filter_map(|e| {
            let regarding = &e.regarding;
            let name_match = regarding.as_ref().and_then(|r| r.name.as_ref()).map_or(false, |n| n == &name);
            let ns_match = regarding.as_ref().and_then(|r| r.namespace.as_ref()).map_or(true, |ns| ns == &namespace);
            let uid_match = if let (Some(r), Some(wanted)) = (regarding, uid.as_ref()) { r.uid.as_deref() == Some(wanted.as_str()) } else { false };
            if (name_match && ns_match) || uid_match {
                Some(K8sEvent {
                    message: e.note.unwrap_or_default(),
                    reason: e.reason.unwrap_or_default(),
                    type_: e.type_.unwrap_or_default(),
                    age: e.event_time.clone().map(|t| t.0.to_rfc3339()).unwrap_or_else(||
                        e.deprecated_last_timestamp.clone().map(|t| t.0.to_rfc3339()).unwrap_or_default()
                    ),
                    last_timestamp: e.event_time.map(|t| t.0.to_rfc3339()).or_else(|| e.deprecated_last_timestamp.map(|t| t.0.to_rfc3339())),
                    count: e.deprecated_count.unwrap_or(e.series.as_ref().map(|s| s.count).unwrap_or(1)),
                })
            } else { None }
        }).collect::<Vec<_>>(),
        Err(_) => vec![]
    };

    let mut all = core_events;
    all.extend(new_events);
    all.sort_by(|a, b| b.age.cmp(&a.age));
    Ok(all)
}

#[tauri::command]
pub async fn apply_yaml(state: State<'_, AppState>, namespace: String, kind: String, name: String, yaml_content: String) -> Result<ResourceSummary, String> {
    let client = create_client(state).await?;
    let mut data: serde_json::Value = serde_yaml::from_str(&yaml_content).map_err(|e| format!("Invalid YAML: {}", e))?;

    if let Some(metadata) = data.get_mut("metadata") {
        if let Some(obj) = metadata.as_object_mut() {
            obj.remove("managedFields");
            obj.remove("resourceVersion");
        }
    }

    // 2. Extract GVK from the payload or arguments
    let api_version = data.get("apiVersion").and_then(|v| v.as_str()).map(|s| s.to_string()).ok_or("Missing apiVersion in YAML")?;
    let (group, version) = if api_version.contains('/') {
        let parts: Vec<&str> = api_version.split('/').collect();
        (parts[0].to_string(), parts[1].to_string())
    } else {
        ("".to_string(), api_version)
    };


    let gvk = GroupVersionKind::gvk(&group, &version, &kind);
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("Resource not found")?;

    let api: Api<DynamicObject> = if namespace != "-" && !namespace.is_empty() {
        Api::namespaced_with(client, &namespace, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    let obj: DynamicObject = serde_json::from_value(data).map_err(|e| e.to_string())?;
    let pp = PatchParams::apply("opspilot-yamleditor").force();
    let patched = api.patch(&name, &pp, &Patch::Apply(&obj)).await.map_err(|e| e.to_string())?;

    let summary = to_summary(patched, &kind, &group, &version, false);

    Ok(summary)
}

#[tauri::command]
pub async fn patch_resource(
    state: State<'_, AppState>,
    namespace: Option<String>,
    kind: String,
    name: String,
    api_version: String,
    patch_data: serde_json::Value,
) -> Result<String, String> {
    let client = create_client(state).await?;

    let (group, version) = if api_version.contains('/') {
        let parts: Vec<&str> = api_version.split('/').collect();
        (parts[0].to_string(), parts[1].to_string())
    } else {
        ("".to_string(), api_version)
    };

    let gvk = GroupVersionKind::gvk(&group, &version, &kind);
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("Resource not found")?;

    let api: Api<DynamicObject> = if let Some(ns) = namespace {
        Api::namespaced_with(client, &ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    let pp = PatchParams::apply("opspilot");
    let patch = Patch::Merge(&patch_data);

    api.patch(&name, &pp, &patch)
        .await
        .map_err(|e| e.to_string())?;

    Ok("Resource patched successfully".to_string())
}

#[tauri::command]
pub async fn scale_resource(
    state: State<'_, AppState>,
    namespace: String,
    kind: String,
    name: String,
    replicas: i32,
) -> Result<String, String> {
    let client = create_client(state).await?;

    // Scale is only supported for certain resource types
    let (group, version) = match kind.as_str() {
        "Deployment" | "StatefulSet" | "ReplicaSet" => ("apps", "v1"),
        _ => return Err(format!("Scale not supported for kind {}", kind)),
    };

    let gvk = GroupVersionKind::gvk(group, version, &kind);
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("Resource not found")?;

    let api: Api<DynamicObject> = Api::namespaced_with(client, &namespace, &ar);

    let patch_json = serde_json::json!({
        "spec": {
            "replicas": replicas
        }
    });

    let pp = PatchParams::apply("opspilot");
    let patch = Patch::Merge(&patch_json);

    api.patch(&name, &pp, &patch)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Scaled to {} replicas", replicas))
}

#[tauri::command]
pub async fn restart_resource(
    state: State<'_, AppState>,
    namespace: String,
    kind: String,
    name: String,
) -> Result<String, String> {
     // Restart is just a patch annotation
    let client = create_client(state).await?;
    
    // We assume standard resources for now, but ideally we'd look up API version
    // For simplicity, handle Deployment/DaemonSet/StatefulSet
    let (group, version) = match kind.as_str() {
        "Deployment" | "StatefulSet" | "DaemonSet" => ("apps", "v1"),
        _ => return Err(format!("Restart not supported for kind {}", kind)),
    };

    let gvk = GroupVersionKind::gvk(group, version, &kind);
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("Resource not found")?;

    let api: Api<DynamicObject> = Api::namespaced_with(client, &namespace, &ar);

    let now = chrono::Utc::now().to_rfc3339();
    let patch_json = serde_json::json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": now
                    }
                }
            }
        }
    });

    let pp = PatchParams::apply("opspilot");
    let patch = Patch::Merge(&patch_json);

    api.patch(&name, &pp, &patch)
        .await
        .map_err(|e| e.to_string())?;

    Ok("Restart initiated".to_string())
}

#[tauri::command]
pub async fn get_resource_metrics(state: State<'_, AppState>, kind: Option<String>, namespace: Option<String>) -> Result<Vec<crate::models::ResourceMetrics>, String> {
    let client = create_client(state).await?;
    let k = kind.unwrap_or_else(|| "Pod".to_string());
    
    // Determine metrics kind based on resource type
    // If it's a Node, we want NodeMetrics. If it's a Pod, we want PodMetrics.
    let (api_kind, api_plural) = if k.eq_ignore_ascii_case("Node") {
        ("NodeMetrics", "nodes")
    } else {
        ("PodMetrics", "pods")
    };

    let api_resource = kube::discovery::ApiResource {
        group: "metrics.k8s.io".to_string(),
        version: "v1beta1".to_string(),
        api_version: "metrics.k8s.io/v1beta1".to_string(),
        kind: api_kind.to_string(),
        plural: api_plural.to_string(),
    };

    let api: Api<DynamicObject> = if let Some(ns) = namespace {
        Api::namespaced_with(client, &ns, &api_resource)
    } else {
        Api::all_with(client, &api_resource)
    };

    let list = api.list(&ListParams::default()).await.map_err(|e| e.to_string())?;

    let metrics = list.items.into_iter().filter_map(|item| {
        let name = item.metadata.name?;
        let ns = item.metadata.namespace.unwrap_or_default();
        let timestamp = item.metadata.creation_timestamp.map(|t| t.0.timestamp()).unwrap_or(0);
        
        let (cpu, memory, cpu_nano, mem_bytes) = if k.eq_ignore_ascii_case("Node") {
            let usage = item.data.get("usage")?;
            let cpu_str = usage.get("cpu").and_then(|v| v.as_str())?;
            let mem_str = usage.get("memory").and_then(|v| v.as_str())?;
            let cpu_n = crate::utils::parse_cpu_to_milli(cpu_str) * 1_000_000; // milli to nano
            let mem_b = crate::utils::parse_memory_to_bytes(mem_str);
            (cpu_str.to_string(), mem_str.to_string(), cpu_n, mem_b)
        } else {
            // Pod metrics are aggregated across containers
            let containers = item.data.get("containers")?.as_array()?;
            let mut total_cpu_nano: u64 = 0;
            let mut total_mem_bytes: u64 = 0;
            
            for c in containers {
                let usage = c.get("usage")?;
                if let Some(cpu) = usage.get("cpu").and_then(|v| v.as_str()) {
                    total_cpu_nano += crate::utils::parse_cpu_to_milli(cpu) * 1_000_000; 
                }
                if let Some(mem) = usage.get("memory").and_then(|v| v.as_str()) {
                    total_mem_bytes += crate::utils::parse_memory_to_bytes(mem);
                }
            }
            
            // Re-format to string roughly
            // This is a rough approximation for display.
            let cpu_fmt = format!("{}m", total_cpu_nano / 1_000_000);
            let mem_fmt = format!("{}Mi", total_mem_bytes / 1024 / 1024);
            (cpu_fmt, mem_fmt, total_cpu_nano, total_mem_bytes)
        };

        Some(crate::models::ResourceMetrics {
            name,
            namespace: ns,
            cpu,
            memory,
            cpu_nano,
            memory_bytes: mem_bytes,
            cpu_limit_nano: None, // Hard to get without cross-referencing Pod specs
            memory_limit_bytes: None,
            cpu_percent: None,
            memory_percent: None,
            timestamp,
        })
    }).collect();

    Ok(metrics)
}
