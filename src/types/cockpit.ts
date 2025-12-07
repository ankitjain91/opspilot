export interface NodeCondition {
    type_: string;
    status: string;
    message: string;
}

export interface NodeHealth {
    name: string;
    status: string;
    cpu_capacity: number;
    cpu_allocatable: number;
    cpu_usage: number;
    memory_capacity: number;
    memory_allocatable: number;
    memory_usage: number;
    pods_capacity: number;
    pods_running: number;
    conditions: NodeCondition[];
    taints: string[];
}

export interface PodStatusBreakdown {
    running: number;
    pending: number;
    succeeded: number;
    failed: number;
    unknown: number;
}

export interface DeploymentHealth {
    name: string;
    namespace: string;
    desired: number;
    ready: number;
    available: number;
    up_to_date: number;
}

export interface NamespaceUsage {
    name: string;
    pod_count: number;
    cpu_usage: number;
    memory_usage: number;
}

export interface ClusterCockpitData {
    total_nodes: number;
    healthy_nodes: number;
    total_pods: number;
    total_deployments: number;
    total_services: number;
    total_namespaces: number;
    total_cpu_capacity: number;
    total_cpu_allocatable: number;
    total_cpu_usage: number;
    total_memory_capacity: number;
    total_memory_allocatable: number;
    total_memory_usage: number;
    total_pods_capacity: number;
    pod_status: PodStatusBreakdown;
    nodes: NodeHealth[];
    unhealthy_deployments: DeploymentHealth[];
    top_namespaces: NamespaceUsage[];
    warning_count: number;
    critical_count: number;
    metrics_available: boolean;
}
