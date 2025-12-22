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
