use tauri::{command, AppHandle, Emitter};
use std::process::{Command, Stdio};
use serde::{Serialize, Deserialize};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write, BufRead, BufReader};
use std::path::PathBuf;
use std::fs;
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command as TokioCommand;

#[derive(Debug, Serialize)]
pub struct ClaudeCodeStatus {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[command]
pub async fn check_claude_code_status() -> Result<ClaudeCodeStatus, String> {
    // Check if `claude` is in PATH
    match Command::new("claude").arg("--version").output() {
        Ok(output) => {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                Ok(ClaudeCodeStatus {
                    available: true,
                    version: Some(version),
                    error: None,
                })
            } else {
                let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Ok(ClaudeCodeStatus {
                    available: false,
                    version: None,
                    error: Some(format!("Check failed: {}", error)),
                })
            }
        }
        Err(e) => {
            // Not found or execution failed
            Ok(ClaudeCodeStatus {
                available: false,
                version: None,
                error: Some(format!("Claude CLI not found: {}", e)),
            })
        }
    }
}

// Persistent implementation using portable-pty and AppState
use crate::state::AppState;
use tauri::State;
use std::sync::{Arc, Mutex};
use crate::state::ShellSession;

/// Call Claude Code using non-interactive mode (-p) with streaming output
/// This is the recommended approach - similar to how Opcode.sh works
///
/// Permission modes:
/// - "default": Normal permission prompts (requires interactive handling)
/// - "acceptEdits": Auto-accept file edits, prompt for dangerous operations
/// - "plan": Read-only mode, no file modifications
/// - "bypassPermissions": Skip all permission checks (use with caution)
#[command]
pub async fn call_claude_code(
    app: AppHandle,
    _state: State<'_, AppState>,
    prompt: String,
    system_prompt: String,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
) -> Result<String, String> {
    let _ = system_prompt;

    // Use non-interactive mode with streaming JSON output
    // This bypasses the TUI and provides clean, parseable output
    let mut cmd = TokioCommand::new("claude");
    cmd.arg("-p") // Non-interactive print mode
       .arg("--verbose") // Required for stream-json output format
       .arg("--output-format").arg("stream-json"); // Streaming JSON for real-time updates

    // Set permission mode - default to "acceptEdits" for a balance of safety and usability
    // Options: "default", "acceptEdits", "plan", "bypassPermissions"
    let mode = permission_mode.unwrap_or_else(|| "acceptEdits".to_string());
    cmd.arg("--permission-mode").arg(&mode);

    // Optionally restrict to specific tools for extra safety
    // Example: ["Read", "Glob", "Grep", "Bash(kubectl:*)"]
    if let Some(tools) = allowed_tools {
        if !tools.is_empty() {
            cmd.arg("--allowed-tools").arg(tools.join(" "));
        }
    }

    // Add the prompt
    cmd.arg(&prompt)
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());

    // Get current directory for context
    if let Ok(cwd) = std::env::current_dir() {
        cmd.current_dir(cwd);
    }

    let _ = app.emit("claude:status", "starting");

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn Claude: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let app_clone = app.clone();
    let app_clone2 = app.clone();

    // Spawn task to read stdout (streaming JSON)
    let stdout_handle = tokio::spawn(async move {
        let reader = TokioBufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            // Emit each JSON line as it arrives
            let _ = app_clone.emit("claude:stream", &line);
        }
    });

    // Spawn task to read stderr
    let stderr_handle = tokio::spawn(async move {
        let reader = TokioBufReader::new(stderr);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_clone2.emit("claude:error", &line);
        }
    });

    // Wait for process to complete
    let status = child.wait().await.map_err(|e| e.to_string())?;

    // Wait for readers to finish
    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    let _ = app.emit("claude:status", "completed");

    if status.success() {
        Ok("Claude completed successfully".to_string())
    } else {
        Err(format!("Claude exited with status: {}", status))
    }
}

/// Legacy PTY-based call for interactive mode (fallback)
#[command]
pub async fn call_claude_code_interactive(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
) -> Result<String, String> {
    // Check for existing session from start_terminal_agent
    {
        let shell_sessions = state.shell_sessions.lock().unwrap();
        if let Some(session) = shell_sessions.get("claude-agent") {
            if let Ok(mut writer) = session.writer.lock() {
                write!(writer, "{}\r", prompt).map_err(|e| e.to_string())?;
                let _ = writer.flush();
                return Ok("Sent to Claude (via terminal agent)".to_string());
            }
        }
    }

    // Fall back to claude_session
    let mut session_guard = state.claude_session.lock().unwrap();

    if session_guard.is_none() {
        let _ = app.emit("agent:terminal:data", "\x1b[33mStarting Claude Session...\x1b[0m\n");

        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| e.to_string())?;

        let cmd = CommandBuilder::new("claude");
        let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn: {}", e))?;

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let app_clone = app.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(n) if n > 0 => {
                        let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = app_clone.emit("agent:terminal:data", data);
                    }
                    Ok(_) => break,
                    Err(_) => break,
                }
            }
            let _ = app_clone.emit("agent:terminal:data", "\n[Claude Session Ended]\n");
        });

        *session_guard = Some(ShellSession {
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
        });

        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Some(session) = session_guard.as_ref() {
            if let Ok(mut w) = session.writer.lock() {
                let _ = w.write_all(b"\r");
                let _ = w.flush();
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }

    if let Some(session) = session_guard.as_ref() {
        let mut writer = session.writer.lock().map_err(|_| "Failed to lock writer".to_string())?;
        write!(writer, "{}\r", prompt).map_err(|e| e.to_string())?;
        let _ = writer.flush();
    }

    Ok("Sent to Claude".to_string())
}

// --- Session Management ---

#[derive(Debug, Serialize, Clone)]
pub struct ClaudeSession {
    pub id: String,
    pub project_path: String,
    pub last_modified: u64,
    pub message_count: usize,
    pub preview: String,
}

#[derive(Debug, Deserialize)]
struct ClaudeMessageEntry {
    #[serde(rename = "type")]
    #[allow(dead_code)]
    msg_type: Option<String>,
    message: Option<serde_json::Value>,
}

/// List Claude Code sessions from ~/.claude/projects/
#[command]
pub async fn list_claude_sessions() -> Result<Vec<ClaudeSession>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();

    // Read all project directories
    let entries = fs::read_dir(&projects_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        // Look for conversation files (JSONL format)
        let conv_dir = path.clone();
        if let Ok(files) = fs::read_dir(&conv_dir) {
            for file in files.flatten() {
                let file_path = file.path();
                if file_path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    // Parse the session
                    if let Ok(session) = parse_session_file(&file_path, &path) {
                        sessions.push(session);
                    }
                }
            }
        }
    }

    // Sort by last modified (newest first)
    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    Ok(sessions)
}

fn parse_session_file(file_path: &PathBuf, project_path: &PathBuf) -> Result<ClaudeSession, String> {
    let file = fs::File::open(file_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut message_count = 0;
    let mut preview = String::new();
    let mut last_user_message = String::new();

    for line in reader.lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(entry) = serde_json::from_str::<ClaudeMessageEntry>(&line) {
            message_count += 1;

            // Extract user messages for preview
            if let Some(msg) = &entry.message {
                if let Some(role) = msg.get("role").and_then(|r| r.as_str()) {
                    if role == "user" {
                        if let Some(content) = msg.get("content") {
                            if let Some(text) = content.as_str() {
                                last_user_message = text.chars().take(100).collect();
                            } else if let Some(arr) = content.as_array() {
                                for item in arr {
                                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                        last_user_message = text.chars().take(100).collect();
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if !last_user_message.is_empty() {
        preview = last_user_message;
    }

    // Get file metadata for timestamp
    let metadata = fs::metadata(file_path).map_err(|e| e.to_string())?;
    let last_modified = metadata
        .modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);

    // Extract session ID from filename
    let session_id = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Extract project path name
    let project_name = project_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(ClaudeSession {
        id: session_id,
        project_path: project_name,
        last_modified,
        message_count,
        preview,
    })
}

/// Get messages from a specific session
#[command]
pub async fn get_claude_session_messages(session_id: String, project_path: String) -> Result<Vec<serde_json::Value>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let file_path = home
        .join(".claude")
        .join("projects")
        .join(&project_path)
        .join(format!("{}.jsonl", session_id));

    if !file_path.exists() {
        return Err(format!("Session file not found: {:?}", file_path));
    }

    let file = fs::File::open(&file_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut messages = Vec::new();

    for line in reader.lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(msg) = entry.get("message") {
                messages.push(msg.clone());
            }
        }
    }

    Ok(messages)
}

/// Resume a Claude session by starting with --continue flag
#[command]
pub async fn resume_claude_session(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: String,
) -> Result<String, String> {
    // Kill existing session if any
    {
        let mut session_guard = state.claude_session.lock().unwrap();
        *session_guard = None;
    }

    // Start new Claude session with --continue in the project directory
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let full_project_path = home.join(".claude").join("projects").join(&project_path);

    let _ = app.emit("agent:terminal:data", format!("\x1b[33mResuming Claude session for {}...\x1b[0m\n", project_path));

    let pty_system = NativePtySystem::default();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("claude");
    cmd.arg("--continue");
    cmd.cwd(full_project_path);

    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn: {}", e))?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Spawn reader thread
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_clone.emit("agent:terminal:data", data);
                }
                Ok(_) => break,
                Err(_) => break,
            }
        }
        let _ = app_clone.emit("agent:terminal:data", "\n[Claude Session Ended]\n");
    });

    // Save session
    let mut session_guard = state.claude_session.lock().unwrap();
    *session_guard = Some(ShellSession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
    });

    // Auto-accept trust prompt
    std::thread::sleep(std::time::Duration::from_millis(500));
    if let Some(session) = session_guard.as_ref() {
        if let Ok(mut w) = session.writer.lock() {
            let _ = w.write_all(b"\n");
            let _ = w.flush();
        }
    }

    Ok("Session resumed".to_string())
}
