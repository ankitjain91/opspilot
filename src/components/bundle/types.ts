// Support Bundle Types - matching Rust structs

export interface SupportBundle {
    path: string;
    namespaces: string[];
    resource_counts: Record<string, number>;
    total_resources: number;
    has_events: boolean;
    has_logs: boolean;
    has_alerts: boolean;
    timestamp: string | null;
}

export interface BundleResource {
    api_version: string;
    kind: string;
    name: string;
    namespace: string | null;
    labels: Record<string, string>;
    status_phase: string | null;
    conditions: ResourceCondition[];
    file_path: string;
}

export interface ResourceCondition {
    condition_type: string;
    status: string;
    reason: string | null;
    message: string | null;
}

export interface BundleEvent {
    name: string;
    namespace: string;
    reason: string;
    message: string;
    event_type: string;
    involved_object_kind: string;
    involved_object_name: string;
    first_timestamp: string | null;
    last_timestamp: string | null;
    count: number;
}

export interface BundleAlert {
    name: string;
    severity: string;
    state: string;
    message: string | null;
    labels: Record<string, string>;
}

export interface BundleAlerts {
    critical: BundleAlert[];
    warning: BundleAlert[];
}

export interface BundleLogFile {
    namespace: string;
    pod: string;
    container: string;
    file_path: string;
    size_bytes: number;
}

export interface BundleHealthSummary {
    failing_pods: PodHealthInfo[];
    warning_events_count: number;
    critical_alerts_count: number;
    pending_pvcs: string[];
    unhealthy_deployments: DeploymentHealthInfo[];
}

export interface PodHealthInfo {
    name: string;
    namespace: string;
    status: string;
    restart_count: number;
    reason: string | null;
}

export interface DeploymentHealthInfo {
    name: string;
    namespace: string;
    ready_replicas: number;
    desired_replicas: number;
}

export interface BundleSearchResult {
    resource_type: string;
    name: string;
    namespace: string | null;
    match_field: string;
    match_snippet: string;
    file_path: string;
}

export interface PreloadedBundleData {
    bundle: SupportBundle;
    healthSummary: BundleHealthSummary;
    events: BundleEvent[];
    alerts: BundleAlerts | null;
    allResources: Map<string, BundleResource[]>;
}

export interface DetectedIssue {
    id: string;
    type: string;
    title: string;
    description: string;
    severity: 'critical' | 'warning' | 'info';
    namespace: string;
    affectedResource: string;
    resourceKind: string;
    rootCause?: string;
    suggestions: string[];
    relatedEvents: BundleEvent[];
    timestamp?: Date;
}

export interface ClusterOverview {
    healthScore: number;
    totalPods: number;
    healthyPods: number;
    failingPods: number;
    pendingPods: number;
    totalDeployments: number;
    healthyDeployments: number;
    totalServices: number;
    warningEvents: number;
    criticalAlerts: number;
    warningAlerts: number;
    namespaceHealth: Map<string, { healthy: number; total: number }>;
}

export interface BundleNodeInfo {
    name: string;
    status: string;
    roles: string[];
    cpu_capacity: string;
    cpu_allocatable: string;
    memory_capacity: string;
    memory_allocatable: string;
    pods_capacity: string;
    pods_allocatable: string;
    conditions: NodeCondition[];
    labels: Record<string, string>;
    internal_ip: string | null;
    hostname: string | null;
    kubelet_version: string | null;
    os_image: string | null;
    kernel_version: string | null;
    container_runtime: string | null;
}

export interface NodeCondition {
    condition_type: string;
    status: string;
    reason: string | null;
    message: string | null;
}

export interface NamespaceSummary {
    name: string;
    resourceCounts: Record<string, number>;
    totalResources: number;
}

export type ViewType = 'overview' | 'namespaces' | 'workloads' | 'events' | 'logs' | 'nodes' | 'storage' | 'argocd' | 'crds';
