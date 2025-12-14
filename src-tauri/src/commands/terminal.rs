
use tauri::{State, Emitter};
use crate::state::{AppState, ShellSession};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::sync::{Arc, Mutex};
use std::io::Read;

#[tauri::command]
pub async fn start_local_shell(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Clean up any existing session
    {
        let mut sessions = state.shell_sessions.lock().unwrap();
        sessions.remove(&session_id);
    }

    // Create PTY
    let pty_system = native_pty_system();
    let pty_pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build shell command
    let mut cmd = if cfg!(target_os = "windows") {
        CommandBuilder::new("powershell")
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        CommandBuilder::new(shell)
    };
    cmd.env("TERM", "xterm-256color");

    // Spawn shell in PTY
    let _child = pty_pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Get reader and writer from master
    let mut reader = pty_pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {}", e))?;
    let writer = pty_pair.master.take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    // Store session
    let session = ShellSession {
        writer: Arc::new(Mutex::new(Box::new(writer) as Box<dyn std::io::Write + Send>)),
        master: Arc::new(Mutex::new(pty_pair.master)),
    };
    state.shell_sessions.lock().unwrap().insert(session_id.clone(), Arc::new(session));

    // Read PTY output in background thread
    let session_id_clone = session_id.clone();
    let app_clone = app.clone();
    let shell_sessions = state.shell_sessions.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app_clone.emit(&format!("shell_output:{}", session_id_clone), data).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Cleanup
        shell_sessions.lock().unwrap().remove(&session_id_clone);
        let _ = app_clone.emit(&format!("shell_closed:{}", session_id_clone), ());
    });

    Ok(())
}

#[tauri::command]
pub async fn send_shell_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.shell_sessions.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        if let Ok(mut writer) = session.writer.lock() {
            let _ = writer.write_all(data.as_bytes()).map_err(|e| e.to_string());
            let _ = writer.flush();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_shell(
    state: State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.shell_sessions.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        if let Ok(master) = session.master.lock() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_local_shell(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.shell_sessions.lock().unwrap();
    sessions.remove(&session_id);
    Ok(())
}

// Remote Exec Commands (Pod Terminal)
#[tauri::command]
pub async fn send_exec_input(state: State<'_, AppState>, session_id: String, data: String) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&session_id).cloned()
    };

    if let Some(session) = session {
        use tokio::io::AsyncWriteExt;
        let mut stdin = session.stdin.lock().await;
        stdin.write_all(data.as_bytes()).await.map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Session {} not found", session_id))
    }
}

#[tauri::command]
pub async fn resize_exec(_state: State<'_, AppState>, _session_id: String, _cols: u16, _rows: u16) -> Result<(), String> {
    // Note: kube-rs AttachedProcess doesn't expose resize easily yet without accessing the underlying websocket.
    Ok(())
}
