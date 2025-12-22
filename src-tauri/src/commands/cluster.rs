use tauri::State;
use kube::api::{Api, ListParams, DynamicObject};
use crate::state::AppState;
use crate::models::{ClusterStats, ClusterCockpitData, NodeHealth, NodeCondition, PodStatusBreakdown, DeploymentHealth, NamespaceUsage, ClusterMetricsSnapshot, MetricsHistoryBuffer, InitialClusterData};
use crate::client::create_client;
use crate::utils::{parse_cpu_to_milli, parse_memory_to_bytes};
use std::time::{SystemTime, UNIX_EPOCH};

#[tauri::command]
pub async fn get_cluster_stats(state: State<'_, AppState>) -> Result<ClusterStats, String> {
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

    let nodes_count = nodes_res.map(|l| l.items.len()).unwrap_or(0);
    let pods_count = pods_res.map(|l| l.items.len()).unwrap_or(0);
    let deployments_count = deployments_res.map(|l| l.items.len()).unwrap_or(0);
    let services_count = services_res.map(|l| l.items.len()).unwrap_or(0);
    let namespaces_count = namespaces_res.map(|l| l.items.len()).unwrap_or(0);

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
pub async fn get_cluster_cockpit(state: State<'_, AppState>) -> Result<ClusterCockpitData, String> {
    // Check cache first (15 second TTL)
    if let Ok(cache) = state.cockpit_cache.try_lock() {
        if let Some((timestamp, cached_data)) = &*cache {
            if timestamp.elapsed().as_secs() < 15 {
                return Ok(cached_data.clone());
            }
        }
    }

    // Capture context at start to ensure consistency between data and history
    let current_ctx = state.selected_context.lock().unwrap().clone().unwrap_or_default();

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

    let nodes_items = nodes_res.map(|l| l.items).unwrap_or_default();
    let pods_items = pods_res.map(|l| l.items).unwrap_or_default();
    let deployments_items = deployments_res.map(|l| l.items).unwrap_or_default();
    let services_count = services_res.map(|l| l.items.len()).unwrap_or(0);
    let namespaces_count = namespaces_res.map(|l| l.items.len()).unwrap_or(0);
    let node_metrics_list = node_metrics_res.ok();

    // Build node metrics map
    let node_metrics_map: std::collections::HashMap<String, (u64, u64)> = node_metrics_list
        .map(|list| {
            list.items.into_iter().filter_map(|item| {
                let name = item.metadata.name?;
                let usage = item.data.get("usage")?;
                let cpu = usage.get("cpu").and_then(|v| v.as_str()).map(parse_cpu_to_milli).unwrap_or(0);
                let memory = usage.get("memory").and_then(|v| v.as_str()).map(parse_memory_to_bytes).unwrap_or(0);
                Some((name, (cpu, memory)))
            }).collect()
        })
        .unwrap_or_default();

    let metrics_available = !node_metrics_map.is_empty();

    // Calculate aggregated stats
    let mut pods_breakdown = PodStatusBreakdown { running: 0, pending: 0, succeeded: 0, failed: 0, unknown: 0 };
    let mut nodes_health: Vec<NodeHealth> = Vec::new();
    let mut unhealthy_deps: Vec<DeploymentHealth> = Vec::new();
    let mut ns_usage: std::collections::HashMap<String, NamespaceUsage> = std::collections::HashMap::new();

    let mut total_cpu_capacity = 0;
    let mut total_cpu_allocatable = 0;
    let mut total_cpu_usage = 0;
    let mut total_mem_capacity = 0;
    let mut total_mem_allocatable = 0;
    let mut total_mem_usage = 0;
    let mut total_pods_capacity = 0;

    let mut pod_calc_cpu_usage = 0; // fallback if metrics missing
    let mut pod_calc_mem_usage = 0;

    // Pod Stats
    for pod in &pods_items {
        let phase = pod.status.as_ref().and_then(|s| s.phase.as_ref()).map(|s| s.as_str()).unwrap_or("Unknown");
        match phase {
            "Running" => pods_breakdown.running += 1,
            "Pending" => pods_breakdown.pending += 1,
            "Succeeded" => pods_breakdown.succeeded += 1,
            "Failed" => pods_breakdown.failed += 1,
            _ => pods_breakdown.unknown += 1,
        }

        let ns = pod.metadata.namespace.clone().unwrap_or("default".into());
        let entry = ns_usage.entry(ns.clone()).or_insert(NamespaceUsage {
            name: ns,
            pod_count: 0,
            cpu_usage: 0,
            memory_usage: 0,
        });
        entry.pod_count += 1;

        // Resource calc for fallback
        if phase == "Running" {
            if let Some(spec) = &pod.spec {
                for c in &spec.containers {
                    if let Some(req) = c.resources.as_ref().and_then(|r| r.requests.as_ref()) {
                        if let Some(cpu) = req.get("cpu") { 
                           let millis = parse_cpu_to_milli(&cpu.0);
                           entry.cpu_usage += millis;
                           pod_calc_cpu_usage += millis;
                        }
                        if let Some(mem) = req.get("memory") {
                            let bytes = parse_memory_to_bytes(&mem.0);
                            entry.memory_usage += bytes;
                            pod_calc_mem_usage += bytes;
                        }
                    }
                }
            }
        }
    }

    // Node Stats
    let mut healthy_nodes = 0;
    for node in &nodes_items {
        let name = node.metadata.name.clone().unwrap_or_default();
        
        // Status checks
        let mut status = "Unknown".to_string();
        let mut conditions = Vec::new();
        if let Some(node_status) = &node.status {
             if let Some(conds) = &node_status.conditions {
                 for c in conds {
                     conditions.push(NodeCondition {
                         type_: c.type_.clone(),
                         status: c.status.clone(),
                         message: c.message.clone().unwrap_or_default(),
                     });
                     if c.type_ == "Ready" {
                         status = if c.status == "True" { "Ready".to_string() } else { "NotReady".to_string() };
                     }
                 }
             }
        }
        if status == "Ready" { healthy_nodes += 1; }

        let allocatable = node.status.as_ref().and_then(|s| s.allocatable.as_ref());
        let capacity = node.status.as_ref().and_then(|s| s.capacity.as_ref());

        let cpu_cap = capacity.and_then(|m| m.get("cpu")).map(|q| parse_cpu_to_milli(&q.0)).unwrap_or(0);
        let mem_cap = capacity.and_then(|m| m.get("memory")).map(|q| parse_memory_to_bytes(&q.0)).unwrap_or(0);
        let pods_cap = capacity.and_then(|m| m.get("pods")).and_then(|q| q.0.parse::<u32>().ok()).unwrap_or(110);
        
        let cpu_alloc = allocatable.and_then(|m| m.get("cpu")).map(|q| parse_cpu_to_milli(&q.0)).unwrap_or(0);
        let mem_alloc = allocatable.and_then(|m| m.get("memory")).map(|q| parse_memory_to_bytes(&q.0)).unwrap_or(0);

        total_cpu_capacity += cpu_cap;
        total_mem_capacity += mem_cap;
        total_cpu_allocatable += cpu_alloc;
        total_mem_allocatable += mem_alloc;
        total_pods_capacity += pods_cap;

        // Usage from metrics or fallback? 
        // Note: For node list, we usually use metrics for usage.
        let (used_cpu, used_mem) = node_metrics_map.get(&name).cloned().unwrap_or((0, 0));
        
        if metrics_available {
            total_cpu_usage += used_cpu;
            total_mem_usage += used_mem;
        }

        nodes_health.push(NodeHealth {
            name,
            status,
            cpu_capacity: cpu_cap,
            cpu_allocatable: cpu_alloc,
            cpu_usage: used_cpu,
            memory_capacity: mem_cap,
            memory_allocatable: mem_alloc,
            memory_usage: used_mem,
            pods_capacity: pods_cap,
            pods_running: 0, // Need to count per node if required, skipping for brevity
            conditions,
            taints: node.spec.as_ref().and_then(|s| s.taints.clone()).map(|t| t.into_iter().map(|tx| tx.key).collect()).unwrap_or_default(),
        });
    }

    if !metrics_available {
        total_cpu_usage = pod_calc_cpu_usage;
        total_mem_usage = pod_calc_mem_usage;
    }

    // Deployments
    for d in &deployments_items {
        let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
        let status = d.status.as_ref();
        let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
        let available = status.and_then(|s| s.available_replicas).unwrap_or(0);
        let updated = status.and_then(|s| s.updated_replicas).unwrap_or(0);

        if ready < desired || available < desired {
            unhealthy_deps.push(DeploymentHealth {
                name: d.metadata.name.clone().unwrap_or_default(),
                namespace: d.metadata.namespace.clone().unwrap_or_default(),
                desired: desired as u32,
                ready: ready as u32,
                available: available as u32,
                up_to_date: updated as u32,
            });
        }
    }

    // Top Namespaces
    let mut top_ns: Vec<NamespaceUsage> = ns_usage.into_values().collect();
    top_ns.sort_by(|a, b| b.pod_count.cmp(&a.pod_count)); // sort by pods for now
    
    let warning_count = unhealthy_deps.len() + (nodes_items.len() - healthy_nodes); // Simple heuristic
    let critical_count = pods_breakdown.failed;

    // Capture pod breakdown values for history before moving into struct
    let running_pods_count = pods_breakdown.running;
    let pending_pods_count = pods_breakdown.pending;
    let failed_pods_count = pods_breakdown.failed;

    let data = ClusterCockpitData {
        total_nodes: nodes_items.len(),
        healthy_nodes,
        total_pods: pods_items.len(),
        total_deployments: deployments_items.len(),
        total_services: services_count,
        total_namespaces: namespaces_count,
        total_cpu_capacity,
        total_cpu_allocatable,
        total_cpu_usage,
        total_memory_capacity: total_mem_capacity,
        total_memory_allocatable: total_mem_allocatable,
        total_memory_usage: total_mem_usage,
        total_pods_capacity,
        pod_status: pods_breakdown.clone(),
        nodes: nodes_health,
        unhealthy_deployments: unhealthy_deps,
        top_namespaces: top_ns.into_iter().take(5).collect(),
        warning_count,
        critical_count,
        metrics_available,
    };

    // Update cache
    if let Ok(mut cache) = state.cockpit_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), data.clone()));
    }

    // Record snapshot for timeline history
    let cpu_pct = if total_cpu_allocatable > 0 {
        (total_cpu_usage as f64 / total_cpu_allocatable as f64) * 100.0
    } else { 0.0 };
    let mem_pct = if total_mem_allocatable > 0 {
        (total_mem_usage as f64 / total_mem_allocatable as f64) * 100.0
    } else { 0.0 };

    let snapshot = ClusterMetricsSnapshot {
        timestamp: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64,
        total_nodes: nodes_items.len(),
        healthy_nodes,
        total_pods: pods_items.len(),
        running_pods: running_pods_count,
        pending_pods: pending_pods_count,
        failed_pods: failed_pods_count,
        total_deployments: deployments_items.len(),
        cpu_usage_percent: cpu_pct,
        memory_usage_percent: mem_pct,
    };

    // Use current_ctx captured AT START of function
    if let Ok(mut history) = state.metrics_history.try_lock() {
        match &mut *history {
            Some(buffer) if buffer.context == current_ctx => {
                // Same context, append snapshot
                buffer.push(snapshot);
            }
            _ => {
                // New context or first time, create new buffer
                let mut new_buffer = MetricsHistoryBuffer::new(current_ctx, 60); // Keep 60 snapshots (~30 min at 30s intervals)
                new_buffer.push(snapshot);
                *history = Some(new_buffer);
            }
        }
    }

    Ok(data)
}

/// Get the metrics history for timeline charts
#[tauri::command]
pub async fn get_metrics_history(state: State<'_, AppState>) -> Result<Vec<ClusterMetricsSnapshot>, String> {
    let current_ctx = state.selected_context.lock().unwrap().clone().unwrap_or_default();

    if let Ok(history) = state.metrics_history.try_lock() {
        if let Some(buffer) = &*history {
            if buffer.context == current_ctx {
                return Ok(buffer.snapshots.clone());
            }
        }
    }

    // No history for this context yet
    Ok(Vec::new())
}

/// Clear metrics history (useful on context switch)
#[tauri::command]
pub async fn clear_metrics_history(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut history) = state.metrics_history.try_lock() {
        *history = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_initial_cluster_data(state: State<'_, AppState>) -> Result<InitialClusterData, String> {
    let client = create_client(state.clone()).await?;
    
    // We want to fetch everything needed for the first dashboard load
    // This includes: stats (calculated locally), namespaces, and the first few resource lists
    
    // 1. Fetch Resources Needed for Cockpit
    // Instead of calling get_cluster_stats (which does its own list calls),
    // and then calling list_resources (which does the same list calls),
    // we fetch the raw lists once and construct both stats and summaries from them.

    let nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());
    let deployments: Api<k8s_openapi::api::apps::v1::Deployment> = Api::all(client.clone());
    let services: Api<k8s_openapi::api::core::v1::Service> = Api::all(client.clone());
    let namespaces: Api<k8s_openapi::api::core::v1::Namespace> = Api::all(client.clone());

    let lp = ListParams::default();

    let (nodes_res, pods_res, deployments_res, services_res, namespaces_res) = tokio::join!(
        nodes.list(&lp),
        pods.list(&lp),
        deployments.list(&lp),
        services.list(&lp),
        namespaces.list(&lp)
    );

    // Filter results
    let nodes_list = nodes_res.map_err(|e| format!("Failed to list nodes: {}", e))?;
    let pods_list = pods_res.map_err(|e| format!("Failed to list pods: {}", e))?;
    let deploy_list = deployments_res.map_err(|e| format!("Failed to list deployments: {}", e))?;
    let svc_list = services_res.map_err(|e| format!("Failed to list services: {}", e))?;
    let ns_list = namespaces_res.map_err(|e| format!("Failed to list namespaces: {}", e))?;

    // 2. Calculate Stats Locally
    let stats = ClusterStats {
        nodes: nodes_list.items.len(),
        pods: pods_list.items.len(),
        deployments: deploy_list.items.len(),
        services: svc_list.items.len(),
        namespaces: ns_list.items.len(),
    };

    // Update Cache (optional but good for consistency)
    if let Ok(mut cache) = state.cluster_stats_cache.try_lock() {
        *cache = Some((std::time::Instant::now(), stats.clone()));
    }

    // 3. Convert to Summaries for Initial Tables
    // Use the `to_summary` helper but we need to match what list_resources does
    // Since list_resources converts DynamicObject, we should ideally use list_resources logic
    // But re-implementing list_resources mapping here for typed objects is safer and faster than serialization round-trip
    
    // Actually, list_resources uses DynamicObject. These are typed.
    // For simplicity and correctness with existing UI logic, we will convert these typed objects to summaries.
    // However, `to_summary` takes DynamicObject.
    // We can convert typed -> value -> dynamic or implement specific mappers.
    // To save time and lines, we'll implement lightweight mappers here matching ResourceSummary.
    
    let to_summary_pods = |pod: k8s_openapi::api::core::v1::Pod| -> crate::models::ResourceSummary {
        let name = pod.metadata.name.clone().unwrap_or_default();
        let namespace = pod.metadata.namespace.clone().unwrap_or("-".into());
        let age = pod.metadata.creation_timestamp.map(|t| t.0.to_rfc3339()).unwrap_or_default();
        let phase = pod.status.as_ref().and_then(|s| s.phase.as_ref()).map(|s| s.to_string()).unwrap_or("Unknown".into());
        
        // Pod specific
        let status_obj = pod.status.as_ref();
        let ready_str = if let Some(container_statuses) = status_obj.and_then(|s| s.container_statuses.as_ref()) {
             let ready_count = container_statuses.iter().filter(|c| c.ready).count();
             let total_count = container_statuses.len();
             Some(format!("{}/{}", ready_count, total_count))
        } else { Some("0/0".to_string()) };
        
        let restart_count = if let Some(container_statuses) = status_obj.and_then(|s| s.container_statuses.as_ref()) {
            Some(container_statuses.iter().map(|c| c.restart_count).sum())
        } else { Some(0) };
        
        let node_name = pod.spec.as_ref().and_then(|s| s.node_name.clone());
        let pod_ip = status_obj.and_then(|s| s.pod_ip.clone());

        crate::models::ResourceSummary {
           id: pod.metadata.uid.clone().unwrap_or_default(),
           name, namespace, kind: "Pod".into(), group: "".into(), version: "v1".into(),
           age, status: phase, raw_json: String::new(), // Not needed for cockpit list
           ready: ready_str, restarts: restart_count, node: node_name, ip: pod_ip,
           labels: pod.metadata.labels,
           reason: None, message: None, type_: None, count: None, source_component: None, involved_object: None
        }
    };

    let convert_nodes = |node: k8s_openapi::api::core::v1::Node| -> crate::models::ResourceSummary {
         let name = node.metadata.name.clone().unwrap_or_default();
         let age = node.metadata.creation_timestamp.map(|t| t.0.to_rfc3339()).unwrap_or_default();
         
         let mut status = "Unknown".to_string();
         if let Some(s) = &node.status {
             if let Some(conds) = &s.conditions {
                 for c in conds {
                     if c.type_ == "Ready" {
                         status = if c.status == "True" { "Ready".to_string() } else { "NotReady".to_string() };
                     }
                 }
             }
         }

         crate::models::ResourceSummary {
            id: node.metadata.uid.clone().unwrap_or_default(),
            name, namespace: "-".into(), kind: "Node".into(), group: "".into(), version: "v1".into(),
            age, status, raw_json: String::new(),
            ready: None, restarts: None, node: None, ip: None, labels: node.metadata.labels,
            reason: None, message: None, type_: None, count: None, source_component: None, involved_object: None
         }
    };

    let convert_deployments = |d: k8s_openapi::api::apps::v1::Deployment| -> crate::models::ResourceSummary {
        let name = d.metadata.name.clone().unwrap_or_default();
        let namespace = d.metadata.namespace.clone().unwrap_or("-".into());
        let age = d.metadata.creation_timestamp.map(|t| t.0.to_rfc3339()).unwrap_or_default();
        
        let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
        let status = d.status.as_ref();
        let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
        let available = status.and_then(|s| s.available_replicas).unwrap_or(0);
        
        let status_str = if available >= desired && desired > 0 { "Running".to_string() } 
                         else if available == 0 && desired > 0 { "Pending".to_string() }
                         else if desired == 0 { "ScaledDown".to_string() }
                         else { format!("{}/{} Ready", ready, desired) };

        crate::models::ResourceSummary {
           id: d.metadata.uid.clone().unwrap_or_default(),
           name, namespace, kind: "Deployment".into(), group: "apps".into(), version: "v1".into(),
           age, status: status_str, raw_json: String::new(),
           ready: Some(format!("{}/{}", ready, desired)), restarts: None, node: None, ip: None,
           labels: d.metadata.labels,
           reason: None, message: None, type_: None, count: None, source_component: None, involved_object: None
        }
    };

    let convert_services = |s: k8s_openapi::api::core::v1::Service| -> crate::models::ResourceSummary {
        let name = s.metadata.name.clone().unwrap_or_default();
        let namespace = s.metadata.namespace.clone().unwrap_or("-".into());
        let age = s.metadata.creation_timestamp.map(|t| t.0.to_rfc3339()).unwrap_or_default();
        let type_ = s.spec.as_ref().and_then(|sp| sp.type_.clone()).unwrap_or("ClusterIP".into());
        let cluster_ip = s.spec.as_ref().and_then(|sp| sp.cluster_ip.clone()).unwrap_or("-".into());

        crate::models::ResourceSummary {
           id: s.metadata.uid.clone().unwrap_or_default(),
           name, namespace, kind: "Service".into(), group: "".into(), version: "v1".into(),
           age, status: type_, raw_json: String::new(), // Use status field for Type
           ready: None, restarts: None, node: None, ip: Some(cluster_ip),
           labels: s.metadata.labels,
           reason: None, message: None, type_: None, count: None, source_component: None, involved_object: None
        }
    };

    let pod_summaries: Vec<crate::models::ResourceSummary> = pods_list.items.into_iter().map(to_summary_pods).collect();
    let node_summaries: Vec<crate::models::ResourceSummary> = nodes_list.items.into_iter().map(convert_nodes).collect();
    let deploy_summaries: Vec<crate::models::ResourceSummary> = deploy_list.items.into_iter().map(convert_deployments).collect();
    let svc_summaries: Vec<crate::models::ResourceSummary> = svc_list.items.into_iter().map(convert_services).collect();
    let ns_names: Vec<String> = ns_list.items.into_iter().filter_map(|n| n.metadata.name).collect();

    Ok(InitialClusterData {
        stats,
        namespaces: ns_names,
        pods: pod_summaries,
        nodes: node_summaries,
        deployments: deploy_summaries,
        services: svc_summaries,
    })
}
