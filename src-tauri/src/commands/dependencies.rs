use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct DependencyStatus {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Custom tool paths configured by the user (Windows only feature)
#[derive(Debug, Serialize, Deserialize, Default)]
struct CustomToolPaths {
    paths: HashMap<String, String>,
}

/// Get the path to the custom tool paths config file
fn get_custom_paths_file() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("opspilot").join("tool_paths.json"))
}

/// Load custom tool paths from config file
fn load_custom_paths() -> CustomToolPaths {
    if let Some(path) = get_custom_paths_file() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(paths) = serde_json::from_str(&content) {
                return paths;
            }
        }
    }
    CustomToolPaths::default()
}

/// Save custom tool paths to config file
fn save_custom_paths(paths: &CustomToolPaths) -> Result<(), String> {
    let path = get_custom_paths_file().ok_or("Could not determine config directory")?;

    // Create parent directory if it doesn't exist
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let content = serde_json::to_string_pretty(paths)
        .map_err(|e| format!("Failed to serialize paths: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

/// Get common install locations for tools on Windows
#[cfg(target_os = "windows")]
fn get_windows_common_paths(name: &str) -> Vec<String> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();

    match name {
        "kubectl" => vec![
            format!("{}\\.kube\\kubectl.exe", home),
            format!("{}\\Microsoft\\WinGet\\Packages\\Kubernetes.kubectl_Microsoft.Winget.Source_8wekyb3d8bbwe\\kubectl.exe", localappdata),
            "C:\\Program Files\\kubectl\\kubectl.exe".to_string(),
            "C:\\Program Files\\Docker\\Docker\\resources\\bin\\kubectl.exe".to_string(),
        ],
        "helm" => vec![
            format!("{}\\Microsoft\\WinGet\\Packages\\Helm.Helm_Microsoft.Winget.Source_8wekyb3d8bbwe\\helm.exe", localappdata),
            "C:\\Program Files\\Helm\\helm.exe".to_string(),
            format!("{}\\scoop\\shims\\helm.exe", home),
        ],
        "vcluster" => vec![
            format!("{}\\Microsoft\\WinGet\\Packages\\loft-sh.vcluster_Microsoft.Winget.Source_8wekyb3d8bbwe\\vcluster.exe", localappdata),
            format!("{}\\scoop\\shims\\vcluster.exe", home),
        ],
        "ollama" => vec![
            format!("{}\\Programs\\Ollama\\ollama.exe", localappdata),
            "C:\\Program Files\\Ollama\\ollama.exe".to_string(),
        ],
        "az" => vec![
            "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd".to_string(),
            "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd".to_string(),
            format!("{}\\scoop\\shims\\az.exe", home),
        ],
        _ => vec![],
    }
}

/// Check a tool at a specific path and get its version
fn check_tool_at_path(name: &str, path: &str, version_args: &[&str]) -> DependencyStatus {
    let version = if !version_args.is_empty() {
        let mut cmd = Command::new(path);
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
                let version_output = if stdout.trim().is_empty() { stderr } else { stdout };
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
        path: Some(path.to_string()),
    }
}

/// Check if a command exists in PATH and get its version
fn check_tool(name: &str, version_args: &[&str], custom_paths: &CustomToolPaths) -> DependencyStatus {
    // First check if user has configured a custom path for this tool
    if let Some(custom_path) = custom_paths.paths.get(name) {
        if std::path::Path::new(custom_path).exists() {
            return check_tool_at_path(name, custom_path, version_args);
        }
    }

    // Check if the command exists in PATH
    let which_result = if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            Command::new("where").arg(name).creation_flags(0x08000000).output()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("where").arg(name).output()
        }
    } else {
        Command::new("which").arg(name).output()
    };

    #[allow(unused_mut)]
    let mut path = match which_result {
        Ok(output) if output.status.success() => {
            let path_str = String::from_utf8_lossy(&output.stdout);
            Some(path_str.lines().next().unwrap_or("").trim().to_string())
        }
        _ => None,
    };

    // On Windows, also check common install locations if not found in PATH
    #[cfg(target_os = "windows")]
    if path.is_none() {
        for common_path in get_windows_common_paths(name) {
            if std::path::Path::new(&common_path).exists() {
                path = Some(common_path);
                break;
            }
        }
    }

    if path.is_none() {
        return DependencyStatus {
            name: name.to_string(),
            installed: false,
            version: None,
            path: None,
        };
    }

    let path_ref = path.as_ref().unwrap();

    // Get version - use the full path if we found one (important for Windows non-PATH installs)
    let version = if !version_args.is_empty() {
        let mut cmd = Command::new(path_ref);
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
    let custom_paths = load_custom_paths();
    let mut results = Vec::new();

    // Check CLI tools
    results.push(check_tool("kubectl", &["version", "--client", "--short"], &custom_paths));
    results.push(check_tool("helm", &["version", "--short"], &custom_paths));
    results.push(check_tool("vcluster", &["--version"], &custom_paths));
    results.push(check_tool("ollama", &["--version"], &custom_paths));

    // Check agent server
    results.push(check_agent_server().await);

    Ok(results)
}

/// Set a custom path for a tool (Windows only feature for tools not in PATH)
#[tauri::command]
pub async fn set_tool_path(tool_name: String, tool_path: String) -> Result<DependencyStatus, String> {
    // Validate the path exists
    if !std::path::Path::new(&tool_path).exists() {
        return Err(format!("Path does not exist: {}", tool_path));
    }

    // Load existing paths, update, and save
    let mut custom_paths = load_custom_paths();
    custom_paths.paths.insert(tool_name.clone(), tool_path.clone());
    save_custom_paths(&custom_paths)?;

    // Return the status of the tool at this path
    let version_args: &[&str] = match tool_name.as_str() {
        "kubectl" => &["version", "--client", "--short"],
        "helm" => &["version", "--short"],
        "vcluster" | "ollama" => &["--version"],
        _ => &[],
    };

    Ok(check_tool_at_path(&tool_name, &tool_path, version_args))
}

/// Clear a custom tool path
#[tauri::command]
pub async fn clear_tool_path(tool_name: String) -> Result<(), String> {
    let mut custom_paths = load_custom_paths();
    custom_paths.paths.remove(&tool_name);
    save_custom_paths(&custom_paths)?;
    Ok(())
}
