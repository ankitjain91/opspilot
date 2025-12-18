use tauri::{AppHandle, Emitter, State};
use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use crate::state::{AppState, ShellSession};

// --- Terminal Agent Commands (New) ---


#[tauri::command]
pub async fn start_terminal_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // 1. Prepare PTY System
    let pty_system = NativePtySystem::default();
    
    // 2. Prepare Command (Claude CLI)
    // We assume 'claude' is in the PATH. 
    // If not, we might need to find it or ask user for path.
    // We run it in interactive mode.
    let cmd = CommandBuilder::new("claude");
    
    // 3. Open PTY
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| format!("Failed to open PTY: {}", e))?;

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // 4. Spawn Reader Thread
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    // Emit to the specific event expected by TerminalBlock
                    let _ = app_handle.emit("agent:terminal:data", data);
                }
                _ => break, // EOF or error
            }
        }
        // Emit exit/closed event?
        let _ = app_handle.emit("agent:terminal:closed", ());
    });
    
    // 5. Spawn Child Process
    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn claude: {}", e))?;

    // 6. Store Session
    // We reuse the shell_sessions map, but use a reserved ID "claude-agent"
    let session = Arc::new(ShellSession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
    });

    state.shell_sessions.lock().unwrap().insert("claude-agent".to_string(), session.clone());

    // 7. Auto-accept trust prompt
    // Claude Code shows a "Do you trust files in this folder?" prompt on startup
    // Wait for it to appear, then send Enter to accept (option 1 is pre-selected)
    // Use longer delay and carriage return (\r) which terminals expect
    std::thread::sleep(std::time::Duration::from_millis(1500));
    if let Ok(mut w) = session.writer.lock() {
        let _ = w.write_all(b"\r");
        let _ = w.flush();
    }

    Ok(())
}

#[tauri::command]
pub async fn execute_agent_command(app: AppHandle, command: String, _thread_id: String) -> Result<(), String> {
    // Legacy/Mock function - Deprecated by real PTY agent
    // But we might keep it to avoid breaking frontend calls if any still exist
    let _ = app.emit("agent:terminal:data", format!("Executing (Legacy): {}\n", command));
    Ok(())
}

#[tauri::command]
pub fn send_agent_input(
    state: State<'_, AppState>,
    data: String,
) -> Result<(), String> {
    // First try shell_sessions["claude-agent"] (from start_terminal_agent)
    if let Some(session) = state.shell_sessions.lock().unwrap().get("claude-agent") {
        if let Ok(mut writer) = session.writer.lock() {
            write!(writer, "{}", data).map_err(|e| e.to_string())?;
            let _ = writer.flush();
            return Ok(());
        }
    }

    // Fall back to claude_session (from call_claude_code)
    if let Some(session) = state.claude_session.lock().unwrap().as_ref() {
        if let Ok(mut writer) = session.writer.lock() {
            write!(writer, "{}", data).map_err(|e| e.to_string())?;
            let _ = writer.flush();
            return Ok(());
        }
    }

    Err("No active Claude session found".to_string())
}

#[tauri::command]
pub fn resize_agent_terminal(
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(session) = state.shell_sessions.lock().unwrap().get("claude-agent") {
        if let Ok(master) = session.master.lock() {
             master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}


// --- Restored Terminal Commands (Shell / Exec) ---

#[tauri::command]
pub async fn start_local_shell(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let pty_system = NativePtySystem::default();

    // Default to shell or sh
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string());
    let cmd = CommandBuilder::new(&shell);

    // Use reasonable default size, will be resized by frontend
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Spawn thread to read PTY and emit events
    let app_handle = app.clone();
    let sid = session_id.clone();

    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    // Emit with the event name the frontend expects
                    let _ = app_handle.emit(&format!("shell_output:{}", sid), data);
                }
                _ => {
                    // Emit closed event
                    let _ = app_handle.emit(&format!("shell_closed:{}", sid), ());
                    break;
                }
            }
        }
    });

    // Spawn shell
    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    // Store session
    let session = Arc::new(ShellSession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
    });

    state.shell_sessions.lock().unwrap().insert(session_id, session);

    Ok(())
}

#[tauri::command]
pub fn send_shell_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if let Some(session) = state.shell_sessions.lock().unwrap().get(&session_id) {
        if let Ok(mut writer) = session.writer.lock() {
            write!(writer, "{}", data).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn resize_shell(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(session) = state.shell_sessions.lock().unwrap().get(&session_id) {
        if let Ok(master) = session.master.lock() {
             master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stop_local_shell(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.shell_sessions.lock().unwrap().remove(&session_id);
    Ok(())
}

// --- Exec Commands (kubectl exec into pod) ---

#[tauri::command]
pub async fn start_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    container: String,
    session_id: String,
) -> Result<(), String> {
    let pty_system = NativePtySystem::default();

    // Build kubectl exec command
    let mut cmd = CommandBuilder::new("kubectl");
    cmd.args(&["exec", "-it", &name, "-n", &namespace, "-c", &container, "--", "/bin/sh"]);

    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| format!("Failed to open PTY: {}", e))?;

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Spawn reader thread
    let app_handle = app.clone();
    let sid = session_id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_handle.emit(&format!("term_output:{}", sid), data);
                }
                _ => {
                    let _ = app_handle.emit(&format!("term_closed:{}", sid), ());
                    break;
                }
            }
        }
    });

    // Spawn command
    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn kubectl exec: {}", e))?;

    // Store session
    let session = Arc::new(ShellSession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
    });

    state.shell_sessions.lock().unwrap().insert(session_id, session);

    Ok(())
}

#[tauri::command]
pub fn send_exec_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if let Some(session) = state.shell_sessions.lock().unwrap().get(&session_id) {
        if let Ok(mut writer) = session.writer.lock() {
            write!(writer, "{}", data).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn resize_exec(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(session) = state.shell_sessions.lock().unwrap().get(&session_id) {
        if let Ok(master) = session.master.lock() {
            master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
