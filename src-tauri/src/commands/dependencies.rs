use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct DependencyStatus {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Check if a command exists in PATH and get its version
fn check_tool(name: &str, version_args: &[&str]) -> DependencyStatus {
    // First check if the command exists
    let which_result = if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            Command::new("where").arg(name).creation_flags(0x08000000).output()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("where").arg(name).output() // Unreachable but keeps compiler happy if cfg check above is weird
        }
    } else {
        Command::new("which").arg(name).output()
    };

    let path = match which_result {
        Ok(output) if output.status.success() => {
            let path_str = String::from_utf8_lossy(&output.stdout);
            Some(path_str.lines().next().unwrap_or("").trim().to_string())
        }
        _ => None,
    };

    if path.is_none() {
        return DependencyStatus {
            name: name.to_string(),
            installed: false,
            version: None,
            path: None,
        };
    }

    // Get version
    let version = if !version_args.is_empty() {
        let mut cmd = Command::new(name);
        cmd.args(version_args);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        match cmd.output() {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                // Some tools output version to stderr
                let version_output = if stdout.trim().is_empty() { stderr } else { stdout };
                // Extract version number - look for patterns like v1.30.0, 3.15.0, etc.
                extract_version(&version_output)
            }
            _ => None,
        }
    } else {
        None
    };

    DependencyStatus {
        name: name.to_string(),
        installed: true,
        version,
        path,
    }
}

/// Extract version number from command output
fn extract_version(output: &str) -> Option<String> {
    // Try to find version patterns
    for line in output.lines() {
        let line = line.trim();
        // Look for version-like patterns: v1.2.3, 1.2.3, version 1.2.3, etc.
        if let Some(version) = extract_version_from_line(line) {
            return Some(version);
        }
    }
    None
}

fn extract_version_from_line(line: &str) -> Option<String> {
    // Pattern: vX.Y.Z or X.Y.Z
    let re_patterns = [
        r"v?(\d+\.\d+\.\d+[-\w]*)",      // v1.2.3 or 1.2.3 with optional suffix
        r"version[:\s]+v?(\d+\.\d+\.\d+)", // version: 1.2.3
        r"Version[:\s]+v?(\d+\.\d+\.\d+)", // Version: 1.2.3
    ];

    for pattern in re_patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(line) {
                if let Some(m) = caps.get(1) {
                    return Some(format!("v{}", m.as_str().trim_start_matches('v')));
                }
            }
        }
    }
    None
}

/// Check status of agent server by pinging its health endpoint
async fn check_agent_server() -> DependencyStatus {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok();

    if let Some(client) = client {
        match client.get("http://127.0.0.1:8765/health").send().await {
            Ok(resp) if resp.status().is_success() => {
                return DependencyStatus {
                    name: "agent-server".to_string(),
                    installed: true,
                    version: Some("running".to_string()),
                    path: Some("http://127.0.0.1:8765".to_string()),
                };
            }
            _ => {}
        }
    }

    DependencyStatus {
        name: "agent-server".to_string(),
        installed: false,
        version: None,
        path: None,
    }
}

#[tauri::command]
pub async fn check_dependencies() -> Result<Vec<DependencyStatus>, String> {
    let mut results = Vec::new();

    // Check CLI tools
    results.push(check_tool("kubectl", &["version", "--client", "--short"]));
    results.push(check_tool("helm", &["version", "--short"]));
    results.push(check_tool("vcluster", &["--version"]));
    results.push(check_tool("ollama", &["--version"]));

    // Check agent server
    results.push(check_agent_server().await);

    Ok(results)
}
