
use tauri::State;
use kube::api::{Api, ListParams};
use crate::state::AppState;
use crate::models::{ClusterCostReport, ResourceCost, NamespaceCost};
use crate::client::create_client;
use crate::utils::{parse_cpu_to_milli, parse_memory_to_bytes};

// Azure pricing constants (East US, Linux, D-series VMs as baseline)
// Based on Azure D2s v3: $0.096/hour for 2 vCPU + 8GB RAM
// CPU: ~$0.048 per vCPU per hour
// Memory: ~$0.006 per GB per hour (derived from VM pricing)
const AZURE_CPU_PRICE_PER_CORE_HOUR: f64 = 0.048;
const AZURE_MEMORY_PRICE_PER_GB_HOUR: f64 = 0.006;
const HOURS_PER_MONTH: f64 = 730.0; // Average hours in a month

#[tauri::command]
pub async fn get_cluster_cost_report(state: State<'_, AppState>) -> Result<ClusterCostReport, String> {
    let client = create_client(state.clone()).await?;
    let pods_api: Api<k8s_openapi::api::core::v1::Pod> = Api::all(client.clone());

    // We list all pods to calculate resource requests
    let pods = pods_api.list(&ListParams::default()).await.map_err(|e| e.to_string())?;

    // Aggregate costs by namespace
    let mut namespace_costs: std::collections::HashMap<String, (f64, f64, u32, Vec<ResourceCost>)> = std::collections::HashMap::new();

    for pod in pods.items {
        let namespace = pod.metadata.namespace.clone().unwrap_or_else(|| "default".to_string());
        let pod_name = pod.metadata.name.clone().unwrap_or_default();

        // Only count running pods for active cost
        let phase = pod.status.as_ref().and_then(|s| s.phase.as_ref()).map(|s| s.as_str()).unwrap_or("");
        if phase != "Running" && phase != "Pending" {
            continue;
        }

        // Sum container resource requests
        let mut pod_cpu_milli: u64 = 0;
        let mut pod_memory_bytes: u64 = 0;

        if let Some(spec) = &pod.spec {
            for container in &spec.containers {
                if let Some(resources) = &container.resources {
                    if let Some(requests) = &resources.requests {
                        if let Some(cpu) = requests.get("cpu") {
                            pod_cpu_milli += parse_cpu_to_milli(&cpu.0);
                        }
                        if let Some(mem) = requests.get("memory") {
                            pod_memory_bytes += parse_memory_to_bytes(&mem.0);
                        }
                    }
                }
            }
        }

        // Convert to vCPU cores and GB
        let cpu_cores = pod_cpu_milli as f64 / 1000.0;
        let memory_gb = pod_memory_bytes as f64 / (1024.0 * 1024.0 * 1024.0);

        // Calculate monthly costs based on requests
        let cpu_cost = cpu_cores * AZURE_CPU_PRICE_PER_CORE_HOUR * HOURS_PER_MONTH;
        let memory_cost = memory_gb * AZURE_MEMORY_PRICE_PER_GB_HOUR * HOURS_PER_MONTH;
        let total_cost = cpu_cost + memory_cost;

        // Get owner reference to group by deployment/replicaset
        let owner_name = pod.metadata.owner_references
            .as_ref()
            .and_then(|refs| refs.first())
            .map(|r| r.name.clone())
            .unwrap_or_else(|| pod_name.clone());

        let resource_cost = ResourceCost {
            name: owner_name,
            namespace: namespace.clone(),
            kind: "Pod".to_string(),
            cpu_cores,
            memory_gb,
            cpu_cost_monthly: cpu_cost,
            memory_cost_monthly: memory_cost,
            total_cost_monthly: total_cost,
            pod_count: 1,
        };

        let entry = namespace_costs.entry(namespace.clone()).or_insert((0.0, 0.0, 0, Vec::new()));
        entry.0 += total_cost;
        entry.1 += cpu_cost;
        entry.2 += 1;
        entry.3.push(resource_cost);
    }

    let mut total_monthly_cost = 0.0;
    let mut breakdown: Vec<NamespaceCost> = Vec::new();

    for (ns, (total, cpu, count, resources)) in namespace_costs {
        total_monthly_cost += total;
        
        // Group resources by owner to simplify report
        let mut grouped_resources: std::collections::HashMap<String, ResourceCost> = std::collections::HashMap::new();
        for r in resources {
            let entry = grouped_resources.entry(r.name.clone()).or_insert(ResourceCost {
                name: r.name.clone(),
                namespace: r.namespace.clone(),
                kind: "Workload".to_string(), // aggregated
                cpu_cores: 0.0,
                memory_gb: 0.0,
                cpu_cost_monthly: 0.0,
                memory_cost_monthly: 0.0,
                total_cost_monthly: 0.0,
                pod_count: 0,
            });
            entry.cpu_cores += r.cpu_cores;
            entry.memory_gb += r.memory_gb;
            entry.cpu_cost_monthly += r.cpu_cost_monthly;
            entry.memory_cost_monthly += r.memory_cost_monthly;
            entry.total_cost_monthly += r.total_cost_monthly;
            entry.pod_count += 1;
        }

        let mut top_resources: Vec<ResourceCost> = grouped_resources.into_values().collect();
        top_resources.sort_by(|a, b| b.total_cost_monthly.partial_cmp(&a.total_cost_monthly).unwrap());

        breakdown.push(NamespaceCost {
            namespace: ns,
            total_cost_monthly: total,
            cpu_cost_monthly: cpu,
            memory_cost_monthly: total - cpu,
            pod_count: count as u32,
            cpu_cores: 0.0, // Should be calculated but setting default for now
            memory_gb: 0.0,
            top_resources: top_resources.into_iter().take(10).collect(),
        });
    }

    breakdown.sort_by(|a, b| b.total_cost_monthly.partial_cmp(&a.total_cost_monthly).unwrap());

    Ok(ClusterCostReport {
        total_cost_monthly: total_monthly_cost,
        cpu_cost_monthly: 0.0, // Fill these if needed
        memory_cost_monthly: 0.0,
        total_cpu_cores: 0.0,
        total_memory_gb: 0.0,
        total_pods: 0,
        namespaces: breakdown,
        cpu_price_per_core_hour: AZURE_CPU_PRICE_PER_CORE_HOUR,
        memory_price_per_gb_hour: AZURE_MEMORY_PRICE_PER_GB_HOUR,
        provider: "Azure".to_string(),
        currency: "USD".to_string(),
        generated_at: chrono::Utc::now().to_rfc3339(),
    })
}
