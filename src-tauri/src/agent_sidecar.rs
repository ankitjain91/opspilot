//! LangGraph Agent Sidecar Management
//!
//! This module manages the Python LangGraph agent server that runs as a sidecar process.
//! The sidecar is started automatically when the app launches and stopped on exit.

use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

/// State for managing the agent sidecar process
pub struct AgentSidecarState {
    child: Arc<Mutex<Option<CommandChild>>>,
}

impl AgentSidecarState {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for AgentSidecarState {
    fn default() -> Self {
        Self::new()
    }
}

/// Start the agent sidecar process
pub async fn start_agent_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AgentSidecarState>();
    let mut child_guard = state.child.lock().await;

    // Check if already running
    if child_guard.is_some() {
        println!("[agent-sidecar] Already running");
        return Ok(());
    }

    println!("[agent-sidecar] Starting LangGraph agent server...");

    // Get the sidecar command
    let sidecar = app.shell().sidecar("agent-server")
        .map_err(|e| format!("Failed to get sidecar: {}", e))?;

    // Determine writable path for ChromaDB
    let chroma_path = app.path().app_data_dir()
        .map(|p| p.join("chroma_db"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./chroma_db"));
    
    // Ensure the directory exists
    if let Err(e) = std::fs::create_dir_all(&chroma_path) {
        eprintln!("[agent-sidecar] Failed to create ChromaDB dir: {}", e);
    }
    
    let chroma_path_str = chroma_path.to_string_lossy().to_string();
    println!("[agent-sidecar] Using ChromaDB path: {}", chroma_path_str);

    // Determine KB path from bundled resources
    let kb_path = app.path().resource_dir()
        .map(|p| p.join("knowledge"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./knowledge"));
    let kb_path_str = kb_path.to_string_lossy().to_string();
    println!("[agent-sidecar] Using KB path: {}", kb_path_str);

    // Spawn with environment
    // Note: tauri_plugin_shell::Command is immutable, we must chain calls
    let (mut rx, child) = sidecar
        .env("CHROMADB_PERSIST_DIR", &chroma_path_str)
        .env("K8S_AGENT_KB_DIR", &kb_path_str)
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Store the child process
    *child_guard = Some(child);

    // Spawn a task to handle sidecar output
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    println!("[agent-sidecar] {}", line_str);
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[agent-sidecar] ERR: {}", line_str);
                }
                CommandEvent::Error(err) => {
                    eprintln!("[agent-sidecar] Error: {}", err);
                }
                CommandEvent::Terminated(payload) => {
                    println!("[agent-sidecar] Terminated with code: {:?}", payload.code);
                    // Clear the child reference
                    if let Some(state) = app_handle.try_state::<AgentSidecarState>() {
                        let mut guard = state.child.lock().await;
                        *guard = None;
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait a moment for the server to start
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    println!("[agent-sidecar] Started successfully on http://127.0.0.1:8765");
    Ok(())
}

/// Stop the agent sidecar process
pub async fn stop_agent_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AgentSidecarState>();
    let mut child_guard = state.child.lock().await;

    if let Some(child) = child_guard.take() {
        println!("[agent-sidecar] Stopping...");
        child.kill().map_err(|e| format!("Failed to kill sidecar: {}", e))?;
        println!("[agent-sidecar] Stopped");
    }

    Ok(())
}

/// Check if the agent sidecar is running
pub async fn is_agent_running(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AgentSidecarState>();
    let child_guard = state.child.lock().await;
    child_guard.is_some()
}

/// Tauri commands for sidecar management

#[tauri::command]
pub async fn start_agent(app: tauri::AppHandle) -> Result<(), String> {
    start_agent_sidecar(&app).await
}

#[tauri::command]
pub async fn stop_agent(app: tauri::AppHandle) -> Result<(), String> {
    stop_agent_sidecar(&app).await
}

#[tauri::command]
pub async fn check_agent_status(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(is_agent_running(&app).await)
}
