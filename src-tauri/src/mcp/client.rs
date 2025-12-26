use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, oneshot};
use serde_json::{Value, json};
use crate::mcp::core::*;

pub struct McpClient {
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    next_id: AtomicU64,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    tools: Arc<Mutex<Vec<McpTool>>>,
    child: Arc<Mutex<Child>>,
}

impl McpClient {
    pub async fn new(command: &str, args: &[String], env: &HashMap<String, String>) -> Result<Self, String> {
        eprintln!("[MCP] Spawning: {} {:?}", command, args);
        eprintln!("[MCP] PATH: {}", env.get("PATH").unwrap_or(&"<not set>".to_string()));

        let mut cmd = Command::new(command);
        cmd.args(args);
        cmd.envs(env);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped()); // Capture stderr to log it

        // CORE SECURITY: Final choke point to prevent unauthorized execution
        // This runs for ALL McpClients, regardless of who created them.
        let full_cmd_str = format!("{} {}", command, args.join(" ")).to_lowercase();
        if full_cmd_str.contains("calculator") || 
           full_cmd_str.contains("calc.exe") || 
           full_cmd_str.contains("calc.app") ||
           (command.to_lowercase() == "open" && full_cmd_str.contains("calc")) {
            return Err(format!("SECURITY BLOCKED: Attempted to spawn unsafe process: {}", full_cmd_str));
        }

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn MCP server: {}", e))?;
        eprintln!("[MCP] Process spawned successfully");

        let stdin = child.stdin.take().ok_or("Failed to open stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to open stderr")?;

        // Spawn stderr reader to log server errors
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while let Ok(n) = reader.read_line(&mut line).await {
                if n == 0 { break; }
                eprintln!("[MCP stderr] {}", line.trim());
                line.clear();
            }
        });

        let pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> = Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = pending_requests.clone();

        // Spawn stdout reader loop
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();

            while let Ok(n) = reader.read_line(&mut line).await {
                if n == 0 {
                    eprintln!("[MCP] EOF received from server");
                    break;
                }

                let text = line.trim();
                if !text.is_empty() {
                    eprintln!("[MCP] Received: {}", &text[..text.len().min(200)]);
                    // Try parsing as JSON-RPC response
                    match serde_json::from_str::<JsonRpcResponse>(text) {
                        Ok(response) => {
                            if let Some(id) = response.id {
                                let mut pending = pending_clone.lock().await;
                                if let Some(tx) = pending.remove(&id) {
                                    // Send result or error
                                    let res = if let Some(err) = response.error {
                                        Err(format!("MCP Error {}: {}", err.code, err.message))
                                    } else {
                                        Ok(response.result.unwrap_or(Value::Null))
                                    };
                                    let _ = tx.send(res);
                                } else {
                                    eprintln!("[MCP] No pending request for id {}", id);
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[MCP] Failed to parse response: {}", e);
                        }
                    }
                }
                line.clear();
            }
            eprintln!("[MCP] Server process exited");
        });

        // Give the reader task and server process time to start
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            next_id: AtomicU64::new(1),
            pending_requests,
            tools: Arc::new(Mutex::new(Vec::new())),
            child: Arc::new(Mutex::new(child)),
        })
    }

    pub async fn shutdown(&self) {
        if let Ok(mut child) = self.child.try_lock() {
             let _ = child.kill().await;
        }
    }

    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
            id: Some(id),
        };

        let json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        eprintln!("[MCP] Sending request: {}", &json[..json.len().min(200)]);

        let (tx, rx) = oneshot::channel();
        
        {
            let mut pending = self.pending_requests.lock().await;
            pending.insert(id, tx);
        }

        let mut stdin = self.stdin.lock().await;
        stdin.write_all(json.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;

        // Wait for response with 30 second timeout
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Request cancelled or server died".to_string()),
            Err(_) => Err("MCP request timed out after 30 seconds".to_string()),
        }
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        };

        let json = serde_json::to_string(&notification).map_err(|e| e.to_string())?;
        
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(json.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn initialize(&self) -> Result<(), String> {
        let params = InitializeParams {
            protocol_version: "2024-11-05".to_string(),
            capabilities: ClientCapabilities {
                roots: Some(json!({
                    "listChanged": true
                })),
                sampling: Some(json!({})),
            },
            client_info: McpClientInfo {
                name: "opspilot-client".to_string(),
                version: "0.1.0".to_string(),
            },
        };

        let _res = self.request("initialize", Some(json!(params))).await?;
        
        // Notify initialized - MUST use notify (no ID)
        self.notify("notifications/initialized", None).await?;

        // Fetch tools
        let tools_res = self.request("tools/list", None).await?;
        
        if let Ok(result) = serde_json::from_value::<McpListToolsResult>(tools_res) {
            let mut tools = self.tools.lock().await;
            *tools = result.tools;
        }

        Ok(())
    }
    
    pub async fn get_tools(&self) -> Vec<McpTool> {
        self.tools.lock().await.clone()
    }
}
