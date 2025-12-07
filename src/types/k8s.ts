export interface NavResource {
    kind: string;
    group: string;
    version: string;
    namespaced: boolean;
    title: string;
}

export interface NavGroup {
    title: string;
    items: NavResource[];
}

export interface K8sObject {
    id: string;
    name: string;
    namespace: string;
    status: string;
    kind: string;
    group: string;
    version: string;
    age: string;
    raw_json: string;
    // Pod-specific fields (optional)
    ready?: string;
    restarts?: number;
    node?: string;
    ip?: string;
}

export interface K8sEvent {
    message: string;
    reason: string;
    type_: string;
    age: string;
    count: number;
}

export interface ClusterStats {
    nodes: number;
    pods: number;
    deployments: number;
    services: number;
    namespaces: number;
}

export interface ResourceMetrics {
    name: string;
    namespace: string;
    cpu: string;
    memory: string;
    cpu_nano: number;
    memory_bytes: number;
    cpu_limit_nano?: number;
    memory_limit_bytes?: number;
    cpu_percent?: number;
    memory_percent?: number;
    timestamp: number;
}


export interface ResourceWatchEvent {
    event_type: "ADDED" | "MODIFIED" | "DELETED";
    resource: K8sObject;
}


export interface HelmRelease {
    name: string;
    namespace: string;
    status: string;
    chart: string;
    app_version: string;
    revision: string;
    updated: string;
}

export interface InitialClusterData {
    stats: ClusterStats;
    namespaces: string[];
    pods: K8sObject[];
    nodes: K8sObject[];
    deployments: K8sObject[];
    services: K8sObject[];
}
