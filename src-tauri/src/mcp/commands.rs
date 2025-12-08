use tauri::State;
use std::collections::HashMap;
use serde_json::Value;
use crate::mcp::manager::McpManager;
use tokio::process::Command;

const UVX_INSTALL_SCRIPT: &str = "curl -LsSf https://astral.sh/uv/install.sh | sh";
const DEFAULT_MCP_PACKAGES: &[&str] = &[
    "mcp-server-azure-devops",
    "mcp-server-kubernetes",
    "gcp-mcp-server",
    "mcp-server-aws", 
    "mcp-github",
    "mcp-server-git",
    "mcp-server-jira",
    "mcp-server-postgres",
    "mcp-server-mysql",
    "mcp-server-redis",
    "mcp-server-snowflake",
    "mcp-server-slack",
    "mcp-server-time",
    "mcp-server-sqlite",
];

// Helper to find a command in standard paths
fn try_find_command(cmd: &str, env: &HashMap<String, String>) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let common_locations = vec![
        format!("{}/.cargo/bin/{}", home, cmd),
        format!("{}/.local/bin/{}", home, cmd),
        format!("/opt/homebrew/bin/{}", cmd),
        format!("/usr/local/bin/{}", cmd),
        format!("/usr/bin/{}", cmd),
        format!("/bin/{}", cmd),
    ];

    // Check effective PATH first
    let path_var = env.get("PATH").cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    
    for dir in path_var.split(':') {
        let p = std::path::Path::new(dir).join(cmd);
        if p.exists() {
            return Some(p.to_string_lossy().to_string()); // Return absolute path
        }
    }

    // Check common locations
    for loc in common_locations {
        if std::path::Path::new(&loc).exists() {
            return Some(loc);
        }
    }

    None
}

fn augment_path(env: &HashMap<String, String>) -> String {
    let mut paths: Vec<String> = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();
    let extras = vec![
        format!("{}/.cargo/bin", home),
        format!("{}/.local/bin", home),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    paths.extend(extras);

    let existing = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    for p in existing.split(':') {
        if !p.is_empty() {
            paths.push(p.to_string());
        }
    }

    // Dedup preserve order
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    paths.join(":")
}

#[tauri::command]
pub async fn connect_mcp_server(
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    state: State<'_, McpManager>
) -> Result<(), String> {
    let mut env_aug = env.clone();
    let augmented_path = augment_path(&env);
    env_aug.insert("PATH".into(), augmented_path.clone());
    
    // SECURITY: Force usage of Safari for browser interactions on macOS
    // This allows auth flows to work while bypassing the broken system default (Calculator)
    #[cfg(target_os = "macos")]
    env_aug.insert("BROWSER".into(), "safari".to_string());

    // Try to find the absolute path of the command if it's not a simple name
    let final_command = if command.contains('/') || command.contains('\\') {
        command.clone()
    } else {
        // Only look locally if it's a simple command like "uvx" or "python"
        try_find_command(&command, &env_aug).unwrap_or(command.clone())
    };

    // SECURITY: Absolute hard block on "open" and "calculator" to prevent abuse
    // This overrides any frontend logic or configuration.
    let lower_cmd = final_command.to_lowercase();
    if lower_cmd == "open" || lower_cmd.contains("calculator") || lower_cmd.ends_with(".app") {
        let err = format!("Blocked execution of unsafe command: {}", final_command);
        println!("[MCP] SECURITY ALERT: {}", err);
        return Err(err);
    }

    // SECURITY: Check arguments as well
    for arg in &args {
        let lower_arg = arg.to_lowercase();
        // Check for specific dangerous keywords in arguments
        if lower_arg.contains("calculator") || 
           lower_arg == "open" || 
           (lower_arg.contains("calc") && (lower_arg.ends_with(".app") || lower_arg.ends_with(".exe"))) {
            let err = format!("Blocked execution of unsafe argument: {}", arg);
            println!("[MCP] SECURITY ALERT: {}", err);
            return Err(err);
        }
    }

    println!("[MCP] Connecting to {} using command: {}", name, final_command);

    match state.add_server(name.clone(), final_command.clone(), args.clone(), env_aug).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let err_msg = format!("Failed to connect to {}: {}", name, e);
            println!("[MCP] Error: {}", err_msg);
            Err(err_msg)
        }
    }
}

#[tauri::command]
pub async fn disconnect_mcp_server(
    name: String,
    state: State<'_, McpManager>
) -> Result<(), String> {
    state.remove_server(&name).await;
    Ok(())
}

#[tauri::command]
pub async fn list_mcp_tools(
    state: State<'_, McpManager>
) -> Result<Vec<Value>, String> {
    Ok(state.list_all_tools().await)
}

#[tauri::command]
pub async fn list_connected_mcp_servers(
    state: State<'_, McpManager>
) -> Result<Vec<String>, String> {
    Ok(state.list_connected_servers().await)
}

#[tauri::command]
pub async fn call_mcp_tool(
    server_name: String,
    tool_name: String,
    args: Value,
    state: State<'_, McpManager>
) -> Result<Value, String> {
    if let Some(client) = state.get_client(&server_name).await {
        // tool_name might be "get_issue" but client expects just "get_issue"
        // Wrapper logic handled the namespacing.
        
        // MCP protocol: tools/call
        // Request params: { name: tool_name, arguments: args }
        
        let params = serde_json::json!({
            "name": tool_name,
            "arguments": args
        });
        
        let res = client.request("tools/call", Some(params)).await?;
        
        // Protocol: response result = { content: ... }
        // We return the result content
        Ok(res)
    } else {
        Err(format!("Server {} not found", server_name))
    }
}

// Simple preflight to see if a binary is available on PATH
#[tauri::command]
pub async fn check_command_exists(command: String) -> Result<bool, String> {
    let lower = command.to_lowercase();
    if lower == "open" || lower.contains("calculator") || lower.contains("calc.exe") {
        return Err("Security: Cannot check status of unsafe command".to_string());
    }
    
    let path = augment_path(&HashMap::new());
    let mut env_map = HashMap::new();
    env_map.insert("PATH".to_string(), path.clone());

    // Try to resolve full path first
    match try_find_command(&command, &env_map) {
        Some(_) => Ok(true),
        None => Err(format!("{} is not available in PATH", command)),
    }
}

// Install a set of MCP servers via uvx (best-effort; network required)
#[tauri::command]
pub async fn install_mcp_presets(packages: Option<Vec<String>>) -> Result<String, String> {
    // Ensure uvx exists
    let path = augment_path(&HashMap::new());
    match Command::new("uvx").arg("--version").env("PATH", &path).output().await {
        Ok(_) => {}
        Err(e) => return Err(format!("uvx not available: {}", e)),
    }

    let targets: Vec<String> = packages
        .unwrap_or_else(|| DEFAULT_MCP_PACKAGES.iter().map(|s| s.to_string()).collect());

    let mut log = String::new();
    for pkg in targets {
        let cmd = Command::new("uvx")
            .arg(&pkg)
            .arg("--help")
            .env("PATH", &path)
            .output()
            .await
            .map_err(|e| format!("Failed to install {}: {}", pkg, e))?;

        if cmd.status.success() {
            log.push_str(&format!("✅ {} ready\n", pkg));
        } else {
            log.push_str(&format!(
                "❌ {} failed: {}\n",
                pkg,
                String::from_utf8_lossy(&cmd.stderr)
            ));
        }
    }

    Ok(log)
}

// Explicit helper to install uvx (invoked only via UI button)
#[tauri::command]
pub async fn install_uvx() -> Result<String, String> {
    let shell = if cfg!(target_os = "windows") { "powershell" } else { "sh" };
    let cmd = if cfg!(target_os = "windows") {
        "iwr https://astral.sh/uv/install.ps1 -UseBasicParsing | iex"
    } else {
        UVX_INSTALL_SCRIPT
    };

    let output = Command::new(shell)
        .arg(if cfg!(target_os = "windows") { "-Command" } else { "-c" })
        .arg(cmd)
        .output()
        .await
        .map_err(|e| format!("Failed to start installer: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(format!(
            "Installer failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}
