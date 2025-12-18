use tauri::{Builder, Manager};
use crate::state::AppState;

mod models;
mod state;
mod utils;
mod client;
mod ai_local;
mod agent_sidecar;
mod embeddings;
mod commands {
    pub mod context;
    pub mod discovery;
    pub mod resources;
    pub mod terminal;
    pub mod networking;
    pub mod cluster;
    pub mod cost;
    pub mod ai_utilities;
    pub mod vcluster;
    pub mod azure;
    pub mod claude;
}

use commands::context::{list_contexts, delete_context, set_kube_config, reset_state, get_current_context_name};
use commands::discovery::{discover_api_resources, clear_discovery_cache, clear_all_caches};
use commands::resources::{list_resources, delete_resource, get_resource_details, get_pod_logs, start_log_stream, stop_log_stream, start_resource_watch, stop_resource_watch, list_events, apply_yaml, get_resource_metrics, patch_resource, restart_resource, scale_resource};
use commands::terminal::{start_local_shell, send_shell_input, resize_shell, stop_local_shell, send_exec_input, resize_exec, start_exec, execute_agent_command, start_terminal_agent, send_agent_input, resize_agent_terminal};
use commands::networking::{start_port_forward, stop_port_forward, list_port_forwards};
use commands::cluster::{get_cluster_stats, get_cluster_cockpit};
use commands::cost::get_cluster_cost_report;
use commands::ai_utilities::{load_llm_config, save_llm_config, store_investigation_pattern, find_similar_investigations};
use commands::vcluster::{list_vclusters, connect_vcluster, disconnect_vcluster};
use commands::azure::{azure_login, refresh_azure_data, get_aks_credentials};
use commands::claude::{check_claude_code_status, call_claude_code, call_claude_code_interactive, list_claude_sessions, get_claude_session_messages, resume_claude_session};
use ai_local::{check_llm_status, check_ollama_status, create_ollama_model, call_llm, call_llm_streaming, call_local_llm_with_tools, call_local_llm, get_system_specs, analyze_text};
use agent_sidecar::{AgentSidecarState, start_agent, stop_agent, check_agent_status};
use embeddings::{check_embedding_model_status, init_embedding_model};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_state = AppState::new();
            app.manage(app_state);

            // Initialize agent sidecar state
            let agent_state = AgentSidecarState::new();
            app.manage(agent_state);

            // Start the agent sidecar automatically
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = agent_sidecar::start_agent_sidecar(&app_handle).await {
                    eprintln!("[startup] Failed to start agent sidecar: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Context & State
            list_contexts,
            delete_context,
            set_kube_config,
            reset_state,
            get_current_context_name,
            
            // Discovery
            discover_api_resources,
            clear_discovery_cache,
            clear_all_caches,
            
            // Resources
            list_resources,
            delete_resource,
            get_resource_details,
            apply_yaml,
            get_resource_metrics,
            patch_resource,
            restart_resource,
            scale_resource,
            
            // Logs & Events
            get_pod_logs,
            start_log_stream,
            stop_log_stream,
            start_resource_watch,
            stop_resource_watch,
            list_events,
            
            // Terminal & Exec
            start_local_shell,
            send_shell_input,
            resize_shell,
            stop_local_shell,
            start_exec,
            send_exec_input,
            resize_exec,

            // Terminal Agent
            execute_agent_command,
            start_terminal_agent,
            send_agent_input,
            resize_agent_terminal,
            
            // Networking
            start_port_forward,
            stop_port_forward,
            list_port_forwards,
            
            // Cluster Insights
            get_cluster_stats,
            get_cluster_cockpit,
            get_cluster_cost_report,

            // AI Local
            check_llm_status,
            check_ollama_status,
            create_ollama_model,
            call_llm,
            call_llm_streaming,
            call_local_llm_with_tools,
            call_local_llm,
            get_system_specs,

            // AI Utilities (AI-Driven Agent Support)
            load_llm_config,
            save_llm_config,
            store_investigation_pattern,
            find_similar_investigations,
            analyze_text,

            // VCluster
            list_vclusters,
            connect_vcluster,
            disconnect_vcluster,

            // Azure
            azure_login,
            refresh_azure_data,
            get_aks_credentials,

            // Claude
            check_claude_code_status,
            call_claude_code,
            call_claude_code_interactive,
            list_claude_sessions,
            get_claude_session_messages,
            resume_claude_session,

            // Agent Sidecar Management
            start_agent,
            stop_agent,
            check_agent_status,

            // Embeddings (KB)
            check_embedding_model_status,
            init_embedding_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
