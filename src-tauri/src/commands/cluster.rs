
use tauri::State;
use kube::api::{Api, ListParams, DynamicObject};
use crate::state::AppState;
use crate::models::{ClusterStats, ClusterCockpitData, NodeHealth, NodeCondition, PodStatusBreakdown, DeploymentHealth, NamespaceUsage};
use crate::client::create_client;
use crate::utils::{parse_cpu_to_milli, parse_memory_to_bytes};

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
        pod_status: pods_breakdown,
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

    Ok(data)
}
