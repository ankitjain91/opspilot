// LLM Provider types
export type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'custom' | 'claude-code';

export interface LLMConfig {
    provider: LLMProvider;
    api_key: string | null;
    base_url: string;
    model: string;                    // Primary "Brain" model for planning/analysis
    executor_model?: string | null;   // Optional fast "Executor" model for CLI translation
    temperature: number;
    max_tokens: number;
}

export interface LLMStatus {
    connected: boolean;
    provider: string;
    model: string;
    available_models: string[];
    error: string | null;
}

export interface PodIssue {
    name: string;
    namespace: string;
    status: string;
    restart_count: number;
    reason: string;
    message: string;
}

export interface DeploymentIssue {
    name: string;
    namespace: string;
    desired: number;
    ready: number;
    available: number;
    reason: string;
}

export interface ClusterIssue {
    severity: string;
    resource_kind: string;
    resource_name: string;
    namespace: string;
    message: string;
}

export interface ClusterHealthSummary {
    total_nodes: number;
    ready_nodes: number;
    not_ready_nodes: string[];
    total_pods: number;
    running_pods: number;
    pending_pods: number;
    failed_pods: number;
    crashloop_pods: PodIssue[];
    total_deployments: number;
    healthy_deployments: number;
    unhealthy_deployments: DeploymentIssue[];
    cluster_cpu_percent: number;
    cluster_memory_percent: number;
    critical_issues: ClusterIssue[];
    warnings: ClusterIssue[];
}

export interface ClusterEventSummary {
    namespace: string;
    name: string;
    kind: string;
    reason: string;
    message: string;
    count: number;
    last_seen: string;
    event_type: string;
}

export interface UnhealthyReport {
    timestamp: string;
    issues: ClusterIssue[];
}

export interface OllamaStatus {
    ollama_running: boolean;
    model_available: boolean;
    model_name: string;
    available_models: string[];
    error: string | null;
    // Legacy fields if needed
    models?: string[];
    current_model?: string;
    gpu_available?: boolean;
    active_model_info?: any;
}
