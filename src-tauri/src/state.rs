
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;
use portable_pty::MasterPty;
use kube::{Client, Discovery};
use crate::models::{ClusterStats, InitialClusterData};

#[allow(dead_code)]
pub struct ExecSession {
    pub stdin: TokioMutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
}

pub struct ShellSession {
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
}

pub struct PortForwardSession {
    pub id: String,
    pub pod_name: String,
    pub namespace: String,
    pub local_port: u16,
    pub pod_port: u16,
    pub handle: tokio::task::JoinHandle<()>,
}

pub struct AppState {
    pub kubeconfig_path: Mutex<Option<String>>,
    pub selected_context: Mutex<Option<String>>,
    #[allow(dead_code)]
    pub sessions: Arc<Mutex<HashMap<String, Arc<ExecSession>>>>,
    pub shell_sessions: Arc<Mutex<HashMap<String, Arc<ShellSession>>>>,
    pub port_forwards: Arc<Mutex<HashMap<String, PortForwardSession>>>,
    pub log_streams: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
    pub discovery_cache: Arc<Mutex<Option<(std::time::Instant, Arc<Discovery>)>>>,
    pub vcluster_cache: Arc<Mutex<Option<(std::time::Instant, String)>>>,
    pub cluster_stats_cache: Arc<Mutex<Option<(std::time::Instant, ClusterStats)>>>,
    // Cache pod limits to avoid refetching pods for metrics (30s TTL)
    pub pod_limits_cache: Arc<Mutex<Option<(std::time::Instant, HashMap<String, (Option<u64>, Option<u64>)>)>>>,
    // Cache Kubernetes client to avoid re-creating connections (2 minute TTL)
    // Key is (kubeconfig_path, context) to ensure cache invalidation on context switch
    pub client_cache: Arc<Mutex<Option<(std::time::Instant, String, Client)>>>,
    // Cache for initial dashboard data (15s TTL) for instant navigation
    pub initial_data_cache: Arc<Mutex<Option<(std::time::Instant, InitialClusterData)>>>,
    // Persistent session for Claude Code
    pub claude_session: Arc<Mutex<Option<ShellSession>>>,
    // Store vcluster proxy process ID to kill it on disconnect
    #[allow(dead_code)]
    pub vcluster_pid: Arc<Mutex<Option<u32>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            kubeconfig_path: Mutex::new(None),
            selected_context: Mutex::new(None),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            shell_sessions: Arc::new(Mutex::new(HashMap::new())),
            port_forwards: Arc::new(Mutex::new(HashMap::new())),
            log_streams: Arc::new(Mutex::new(HashMap::new())),
            discovery_cache: Arc::new(Mutex::new(None)),
            vcluster_cache: Arc::new(Mutex::new(None)),
            cluster_stats_cache: Arc::new(Mutex::new(None)),
            pod_limits_cache: Arc::new(Mutex::new(None)),
            client_cache: Arc::new(Mutex::new(None)),
            initial_data_cache: Arc::new(Mutex::new(None)),
            claude_session: Arc::new(Mutex::new(None)),
            vcluster_pid: Arc::new(Mutex::new(None)),
        }
    }
}
