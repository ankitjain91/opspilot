export interface ResourceCost {
    name: string;
    namespace: string;
    kind: string;
    cpu_cores: number;
    memory_gb: number;
    cpu_cost_monthly: number;
    memory_cost_monthly: number;
    total_cost_monthly: number;
    pod_count: number;
}

export interface NamespaceCost {
    namespace: string;
    total_cost_monthly: number;
    cpu_cost_monthly: number;
    memory_cost_monthly: number;
    cpu_cores: number;
    memory_gb: number;
    pod_count: number;
    top_resources: ResourceCost[];
}

export interface ClusterCostReport {
    total_cost_monthly: number;
    cpu_cost_monthly: number;
    memory_cost_monthly: number;
    total_cpu_cores: number;
    total_memory_gb: number;
    total_pods: number;
    namespaces: NamespaceCost[];
    cpu_price_per_core_hour: number;
    memory_price_per_gb_hour: number;
    provider: string;
}
