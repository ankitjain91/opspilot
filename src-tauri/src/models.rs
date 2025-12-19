
#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Clone)]
pub struct NavGroup {
    pub title: String,
    pub items: Vec<NavResource>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct NavResource {
    pub kind: String,
    pub group: String,
    pub version: String,
    pub namespaced: bool,
    pub title: String,
}

#[derive(Deserialize, Debug)]
pub struct ResourceRequest {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    #[allow(dead_code)]
    pub name: Option<String>,
    pub include_raw: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct ResourceSummary {
    pub id: String,
    pub name: String,
    pub namespace: String,
    pub kind: String,
    pub group: String,
    pub version: String,
    pub age: String,
    pub status: String,
    pub raw_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restarts: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
}

#[derive(Serialize, Clone)]
pub struct ResourceWatchEvent {
    pub event_type: String, // "ADDED", "MODIFIED", "DELETED", "RESTARTED"
    pub resource: ResourceSummary,
}

#[derive(Serialize)]
pub struct KubeContext {
    pub name: String,
    pub cluster: String,
    pub user: String,
}

#[derive(Serialize)]
pub struct K8sEvent {
    pub message: String,
    pub reason: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub age: String,
    #[serde(rename = "lastTimestamp")]
    pub last_timestamp: Option<String>,
    pub count: i32,
}

#[derive(Serialize, Clone)]
pub struct ClusterStats {
    pub nodes: usize,
    pub pods: usize,
    pub deployments: usize,
    pub services: usize,
    pub namespaces: usize,
}

#[derive(Serialize, Clone)]
pub struct NodeHealth {
    pub name: String,
    pub status: String,
    pub cpu_capacity: u64,       // in millicores
    pub cpu_allocatable: u64,
    pub cpu_usage: u64,
    pub memory_capacity: u64,    // in bytes
    pub memory_allocatable: u64,
    pub memory_usage: u64,
    pub pods_capacity: u32,
    pub pods_running: u32,
    pub conditions: Vec<NodeCondition>,
    pub taints: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct NodeCondition {
    pub type_: String,
    pub status: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
pub struct PodStatusBreakdown {
    pub running: usize,
    pub pending: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub unknown: usize,
}

#[derive(Serialize, Clone)]
pub struct DeploymentHealth {
    pub name: String,
    pub namespace: String,
    pub desired: u32,
    pub ready: u32,
    pub available: u32,
    pub up_to_date: u32,
}

#[derive(Serialize, Clone)]
pub struct NamespaceUsage {
    pub name: String,
    pub pod_count: usize,
    pub cpu_usage: u64,
    pub memory_usage: u64,
}

#[derive(Serialize, Clone)]
pub struct ClusterCockpitData {
    pub total_nodes: usize,
    pub healthy_nodes: usize,
    pub total_pods: usize,
    pub total_deployments: usize,
    pub total_services: usize,
    pub total_namespaces: usize,

    pub total_cpu_capacity: u64,      // millicores
    pub total_cpu_allocatable: u64,
    pub total_cpu_usage: u64,
    pub total_memory_capacity: u64,   // bytes
    pub total_memory_allocatable: u64,
    pub total_memory_usage: u64,
    pub total_pods_capacity: u32,

    pub pod_status: PodStatusBreakdown,
    pub nodes: Vec<NodeHealth>,
    pub unhealthy_deployments: Vec<DeploymentHealth>,
    pub top_namespaces: Vec<NamespaceUsage>,

    pub warning_count: usize,
    pub critical_count: usize,
    pub metrics_available: bool,
}

#[derive(Serialize, Clone)]
pub struct ClusterHealthSummary {
    pub total_nodes: usize,
    pub ready_nodes: usize,
    pub not_ready_nodes: Vec<String>,
    pub total_pods: usize,
    pub running_pods: usize,
    pub pending_pods: usize,
    pub failed_pods: usize,
    pub crashloop_pods: Vec<PodIssue>,
    pub total_deployments: usize,
    pub healthy_deployments: usize,
    pub unhealthy_deployments: Vec<DeploymentIssue>,
    pub cluster_cpu_percent: f64,
    pub cluster_memory_percent: f64,
    pub critical_issues: Vec<ClusterIssue>,
    pub warnings: Vec<ClusterIssue>,
}

#[derive(Serialize, Clone)]
pub struct PodIssue {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub restart_count: u32,
    pub reason: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
pub struct DeploymentIssue {
    pub name: String,
    pub namespace: String,
    pub desired: u32,
    pub ready: u32,
    pub available: u32,
    pub reason: String,
}

#[derive(Serialize, Clone)]
pub struct ClusterIssue {
    pub severity: String, // "critical" or "warning"
    pub resource_kind: String,
    pub resource_name: String,
    pub namespace: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
pub struct ResourceCost {
    pub name: String,
    pub namespace: String,
    pub kind: String,
    pub cpu_cores: f64,
    pub memory_gb: f64,
    pub cpu_cost_monthly: f64,
    pub memory_cost_monthly: f64,
    pub total_cost_monthly: f64,
    pub pod_count: u32,
}

#[derive(Serialize, Clone)]
pub struct NamespaceCost {
    pub namespace: String,
    pub total_cost_monthly: f64,
    pub cpu_cost_monthly: f64,
    pub memory_cost_monthly: f64,
    pub cpu_cores: f64,
    pub memory_gb: f64,
    pub pod_count: u32,
    #[serde(rename = "topResources")]
    pub top_resources: Vec<ResourceCost>,
}

#[derive(Serialize, Clone)]
pub struct ClusterCostReport {
    pub total_cost_monthly: f64,
    pub cpu_cost_monthly: f64,
    pub memory_cost_monthly: f64,
    pub total_cpu_cores: f64,
    pub total_memory_gb: f64,
    pub total_pods: u32,
    pub namespaces: Vec<NamespaceCost>,
    pub cpu_price_per_core_hour: f64,
    pub memory_price_per_gb_hour: f64,
    pub provider: String,
    pub currency: String,
    pub generated_at: String,
}

#[derive(Serialize, Clone)]
pub struct ClusterEventSummary {
    pub namespace: String,
    pub name: String,
    pub kind: String,
    pub reason: String,
    pub message: String,
    pub count: u32,
    pub last_seen: String,
    pub event_type: String,
}

#[derive(Serialize, Clone)]
pub struct UnhealthyReport {
    pub timestamp: String,
    pub issues: Vec<ClusterIssue>,
}

#[derive(Serialize, Clone)]
pub struct InitialClusterData {
    pub stats: ClusterStats,
    pub namespaces: Vec<String>,
    pub pods: Vec<ResourceSummary>,
    pub nodes: Vec<ResourceSummary>,
    pub deployments: Vec<ResourceSummary>,
    pub services: Vec<ResourceSummary>,
}

#[derive(Serialize, Clone)]
pub struct ResourceMetrics {
    pub name: String,
    pub namespace: String,
    pub cpu: String,
    pub memory: String,
    pub cpu_nano: u64,
    pub memory_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_limit_nano: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_limit_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_percent: Option<f64>,
    pub timestamp: i64,
}

#[derive(Serialize)]
pub struct CrdInfo {
    pub name: String,
    pub group: String,
    pub versions: Vec<String>,
    pub scope: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub r#type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyGraph {
    pub nodes: Vec<TopologyNode>,
    pub edges: Vec<TopologyEdge>,
    pub generated_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AzureSubscription {
    pub id: String,
    pub name: String,
    pub state: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    #[serde(default)]
    pub clusters: Vec<AksCluster>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AksCluster {
    pub id: String,
    pub name: String,
    #[serde(rename = "resourceGroup")]
    pub resource_group: String,
    pub location: String,
    #[serde(rename = "powerState")]
    pub power_state: PowerState,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PowerState {
    pub code: String,
}
