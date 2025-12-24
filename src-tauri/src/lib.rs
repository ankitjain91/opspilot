use tauri::{Builder, Manager};
use crate::state::AppState;

mod models;
mod state;
mod utils;
mod client;
mod ai_local;
mod agent_sidecar;
mod embeddings;
mod mcp;
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
    pub mod helm;
    pub mod argocd;
    pub mod dependencies;
    pub mod support_bundle;
}

use commands::context::{list_contexts, delete_context, set_kube_config, reset_state, get_current_context_name};
use commands::discovery::{discover_api_resources, clear_discovery_cache, clear_all_caches};
use commands::resources::{list_resources, delete_resource, get_resource_details, get_pod_logs, start_log_stream, stop_log_stream, start_resource_watch, stop_resource_watch, list_events, apply_yaml, get_resource_metrics, patch_resource, restart_resource, scale_resource};
use commands::terminal::{start_local_shell, send_shell_input, resize_shell, stop_local_shell, send_exec_input, resize_exec, start_exec, execute_agent_command, start_terminal_agent, send_agent_input, resize_agent_terminal};
use commands::networking::{start_port_forward, stop_port_forward, list_port_forwards};
use commands::cluster::{get_cluster_stats, get_cluster_cockpit, get_metrics_history, clear_metrics_history, get_initial_cluster_data};
use commands::cost::get_cluster_cost_report;
use commands::ai_utilities::{load_llm_config, save_llm_config, store_investigation_pattern, find_similar_investigations, load_opspilot_config, save_opspilot_config, get_env_var, get_opspilot_env_vars, get_kb_directory_info, init_kb_directory, store_secret, retrieve_secret, remove_secret, get_workspace_dir, read_server_info_file};
use commands::vcluster::{list_vclusters, connect_vcluster, disconnect_vcluster};
use commands::azure::{azure_login, refresh_azure_data, get_aks_credentials, detect_aks_cluster, get_aks_metrics_history};
use commands::helm::{helm_list, helm_uninstall, helm_get_details, helm_history, helm_get_resources, helm_rollback};
use commands::argocd::{get_argocd_server_info, start_argocd_port_forward, stop_argocd_port_forward, check_argocd_exists, open_argocd_webview, close_argocd_webview, force_close_argocd_webview, is_argocd_webview_active, update_argocd_webview_bounds};
use commands::dependencies::check_dependencies;
use commands::support_bundle::{load_support_bundle, get_bundle_resource_types, get_bundle_resources, get_bundle_resource_yaml, get_bundle_events, get_bundle_log_files, get_bundle_logs, get_bundle_alerts, get_bundle_health_summary, search_bundle, get_bundle_pods_by_status, close_support_bundle};

use ai_local::{check_llm_status, check_ollama_status, create_ollama_model, call_llm, call_llm_streaming, call_local_llm_with_tools, call_local_llm, get_system_specs, analyze_text, auto_start_ollama};
use agent_sidecar::{AgentSidecarState, start_agent, stop_agent, check_agent_status, supervise_agent, start_agent_sidecar};
use embeddings::{check_embedding_model_status, init_embedding_model};
use mcp::commands::{connect_mcp_server, disconnect_mcp_server, list_mcp_tools, list_connected_mcp_servers, call_mcp_tool, check_command_exists, install_mcp_presets, install_uvx};
use mcp::manager::McpManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_state = AppState::new();
            app.manage(app_state);

            // Initialize agent sidecar state
            let agent_state = AgentSidecarState::new();
            app.manage(agent_state);

            // Initialize MCP manager
            let mcp_manager = McpManager::new();
            app.manage(mcp_manager);

            // Start the agent sidecar automatically
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_agent_sidecar(&app_handle).await {
                    eprintln!("[startup] Failed to start agent sidecar: {}", e);
                }
            });

            // Start background supervisor to keep agent healthy
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                supervise_agent(app_handle).await;
            });

            // Auto-start Ollama if installed but not running
            tauri::async_runtime::spawn(async move {
                if let Err(e) = auto_start_ollama().await {
                    // Not an error - just means Ollama isn't installed or already running
                    println!("[startup] Ollama: {}", e);
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
            get_initial_cluster_data,
            get_cluster_cost_report,
            get_metrics_history,
            clear_metrics_history,

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

            // OpsPilot Configuration
            load_opspilot_config,
            save_opspilot_config,
            get_env_var,
            get_opspilot_env_vars,
            
            // Secrets Management
            store_secret,
            retrieve_secret,
            remove_secret,
            get_workspace_dir,
            read_server_info_file,

            // Knowledge Base
            get_kb_directory_info,
            init_kb_directory,

            // VCluster
            list_vclusters,
            connect_vcluster,
            disconnect_vcluster,

            // Azure
            azure_login,
            refresh_azure_data,
            get_aks_credentials,
            detect_aks_cluster,
            get_aks_metrics_history,



            // Agent Sidecar Management
            start_agent,
            stop_agent,
            check_agent_status,

            // Embeddings (KB)
            check_embedding_model_status,
            init_embedding_model,

            // Helm
            helm_list,
            helm_uninstall,
            helm_get_details,
            helm_history,
            helm_get_resources,
            helm_rollback,

            // MCP (Model Context Protocol)
            connect_mcp_server,
            disconnect_mcp_server,
            list_mcp_tools,
            list_connected_mcp_servers,
            call_mcp_tool,
            check_command_exists,
            install_mcp_presets,
            install_uvx,

            // ArgoCD
            get_argocd_server_info,
            start_argocd_port_forward,
            stop_argocd_port_forward,
            check_argocd_exists,
            open_argocd_webview,
            close_argocd_webview,
            force_close_argocd_webview,
            is_argocd_webview_active,
            update_argocd_webview_bounds,

            // Dependencies
            check_dependencies,

            // Support Bundle
            load_support_bundle,
            get_bundle_resource_types,
            get_bundle_resources,
            get_bundle_resource_yaml,
            get_bundle_events,
            get_bundle_log_files,
            get_bundle_logs,
            get_bundle_alerts,
            get_bundle_health_summary,
            search_bundle,
            get_bundle_pods_by_status,
            close_support_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
