/**
 * AI Utilities - Backend support for AI-driven agent features
 *
 * Provides Tauri commands for:
 * - LLM configuration management
 * - Calling LLM endpoints
 * - Storing/retrieving investigation patterns
 * - OpsPilot configuration file support
 */

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::env;
use tokio::fs;
use keyring::Entry;

// ... imports remain ...

// =============================================================================
// SECURE STORAGE HELPERS
// =============================================================================

fn get_secret(key: &str) -> Option<String> {
    match Entry::new("opspilot", key) {
        Ok(entry) => {
            match entry.get_password() {
                Ok(pw) => {
                    println!("[secrets] Successfully retrieved '{}' from keychain", key);
                    Some(pw)
                }
                Err(e) => {
                    println!("[secrets] Failed to get password for '{}': {:?}", key, e);
                    None
                }
            }
        }
        Err(e) => {
            println!("[secrets] Failed to create keychain entry for '{}': {:?}", key, e);
            None
        }
    }
}

fn set_secret(key: &str, value: &str) -> std::io::Result<()> {
    let entry = Entry::new("opspilot", key)
        .map_err(|e| {
            println!("[secrets] Failed to create keychain entry for store '{}': {:?}", key, e);
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        })?;
    entry.set_password(value)
        .map(|_| {
            println!("[secrets] Successfully stored '{}' in keychain", key);
        })
        .map_err(|e| {
            println!("[secrets] Failed to set password for '{}': {:?}", key, e);
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        })
}

fn delete_secret(key: &str) -> std::io::Result<()> {
    let entry = Entry::new("opspilot", key)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already deleted
        Err(e) => Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())),
    }
}

// =============================================================================
// TAURI COMMANDS FOR SECRETS
// =============================================================================

#[tauri::command]
pub async fn store_secret(key: String, value: String) -> Result<(), String> {
    set_secret(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn retrieve_secret(key: String) -> Result<Option<String>, String> {
    Ok(get_secret(&key))
}

#[tauri::command]
pub async fn remove_secret(key: String) -> Result<(), String> {
    delete_secret(&key).map_err(|e| e.to_string())
}

// =============================================================================
// GENERAL UTILITIES
// =============================================================================

/// Return the current working directory of the app process.
/// In dev, this will typically be the project root. In production,
/// it will be the directory where the app is launched.
#[tauri::command]
pub async fn get_workspace_dir() -> Result<String, String> {
    match std::env::current_dir() {
        Ok(p) => Ok(p.to_string_lossy().into_owned()),
        Err(e) => Err(e.to_string()),
    }
}

// ... existing code ...

/// Load OpsPilot configuration from file
/// Searches multiple locations in priority order
#[tauri::command]
pub async fn load_opspilot_config() -> Result<OpsPilotConfig, String> {
    let paths = get_opspilot_config_paths();
    let mut config = OpsPilotConfig::default();

    // 1. Try to load from file
    for path in paths {
        if path.exists() {
            match fs::read_to_string(&path).await {
                Ok(content) => {
                    match serde_json::from_str::<OpsPilotConfig>(&content) {
                        Ok(c) => {
                            eprintln!("[config] Loaded OpsPilot config from: {:?}", path);
                            config = c;
                            break; // Stop at first found
                        }
                        Err(e) => {
                            eprintln!("[config] Failed to parse {:?}: {}", path, e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[config] Failed to read {:?}: {}", path, e);
                }
            }
        }
    }

    // 2. Overlay secrets from Keyring
    if let Some(token) = get_secret("github_token") {
        config.github_token = Some(token);
    }
    
    // Check key for other providers if needed (e.g. jira)
    // Future: generic secret loader?

    Ok(config)
}

/// Save OpsPilot configuration to file (home directory)
#[tauri::command]
pub async fn save_opspilot_config(config: OpsPilotConfig) -> Result<(), String> {
    let config_path = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".opspilot")
        .join("config.json");

    // 1. Extract and secure secrets
    let mut config_to_save = config.clone();
    
    if let Some(token) = &config.github_token {
        // Migration: Save to Keyring
        set_secret("github_token", token)
            .map_err(|e| format!("Failed to save GitHub token to keychain: {}", e))?;
            
        // Remove from file payload
        config_to_save.github_token = None;
    } else {
        // If None in config, ensure it's removed from keyring? 
        // Or assume user wants to keep it? 
        // Logic: specific remove command should handle deletion. 
        // Here we just don't save anything to file.
    }

    // 2. Save remaining config to file
    let json = serde_json::to_string_pretty(&config_to_save)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&config_path, json)
        .await
        .map_err(|e| format!("Failed to write config: {}", e))?;

    eprintln!("[config] Saved OpsPilot config to: {:?}", config_path);
    Ok(())
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMConfig {
    pub provider: String,
    pub api_key: Option<String>,
    pub base_url: String,
    pub model: String,
    pub executor_model: Option<String>,
    pub temperature: f32,
    pub max_tokens: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InvestigationPattern {
    pub timestamp: String,
    pub cluster_type: String,
    pub investigation_goal: String,
    pub successful_path: Vec<ToolStep>,
    pub solution: String,
    pub pattern_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStep {
    pub tool: String,
    pub args: Option<String>,
    pub outcome: String,
    pub useful: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SimilarInvestigation {
    pub similarity_score: f32,
    pub tool_sequence: Vec<String>,
    pub solution: String,
}

// =============================================================================
// LLM CONFIGURATION MANAGEMENT
// =============================================================================

fn get_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".opspilot")
        .join("llm-config.json")
}

/// Load LLM configuration from disk
#[tauri::command]
pub async fn load_llm_config() -> Result<Option<LLMConfig>, String> {
    let config_path = get_config_path();

    if !config_path.exists() {
        return Ok(None);
    }

    match fs::read_to_string(&config_path).await {
        Ok(content) => {
            let mut config: LLMConfig = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            
            // Overlay API key from Keyring
            if let Some(key) = get_secret("llm_api_key") {
                config.api_key = Some(key);
            }
            
            Ok(Some(config))
        }
        Err(e) => {
            eprintln!("Failed to read config file: {}", e);
            Ok(None)
        }
    }
}

/// Save LLM configuration to disk
#[tauri::command]
pub async fn save_llm_config(config: LLMConfig) -> Result<(), String> {
    let config_path = get_config_path();

    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let mut config_to_save = config.clone();
    
    // Extract and secure API key
    if let Some(key) = &config.api_key {
        set_secret("llm_api_key", key)
            .map_err(|e| format!("Failed to save API key to keychain: {}", e))?;
        
        config_to_save.api_key = None;
    }

    let json = serde_json::to_string_pretty(&config_to_save)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&config_path, json)
        .await
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

// =============================================================================
// LLM CALLING
// =============================================================================


// =============================================================================
// INVESTIGATION PATTERN STORAGE
// =============================================================================

fn get_patterns_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("lens-killer");
    path.push("investigation-patterns.jsonl");
    path
}

/// Store a successful investigation pattern for learning
#[tauri::command]
pub async fn store_investigation_pattern(pattern: InvestigationPattern) -> Result<(), String> {
    let patterns_path = get_patterns_path();

    // Ensure parent directory exists
    if let Some(parent) = patterns_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create patterns dir: {}", e))?;
    }

    // Append as JSONL (one JSON object per line)
    let json_line = serde_json::to_string(&pattern)
        .map_err(|e| format!("Failed to serialize pattern: {}", e))?;

    let mut content = if patterns_path.exists() {
        fs::read_to_string(&patterns_path).await.unwrap_or_default()
    } else {
        String::new()
    };

    content.push_str(&json_line);
    content.push('\n');

    fs::write(&patterns_path, content)
        .await
        .map_err(|e| format!("Failed to write patterns: {}", e))?;

    Ok(())
}

/// Find similar investigations based on goal and cluster type
#[tauri::command]
pub async fn find_similar_investigations(
    goal: String,
    cluster_type: String,
    limit: usize,
) -> Result<Vec<SimilarInvestigation>, String> {
    let patterns_path = get_patterns_path();

    if !patterns_path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&patterns_path)
        .await
        .map_err(|e| format!("Failed to read patterns: {}", e))?;

    let mut results: Vec<SimilarInvestigation> = Vec::new();

    // Parse each line as a pattern
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(pattern) = serde_json::from_str::<InvestigationPattern>(line) {
            // Simple similarity: check if goals/cluster types match
            let mut score = 0.0;

            if pattern.cluster_type == cluster_type {
                score += 0.5;
            }

            // Check keyword overlap in goals
            let goal_lower = goal.to_lowercase();
            let pattern_goal_lower = pattern.investigation_goal.to_lowercase();

            for word in goal_lower.split_whitespace() {
                if pattern_goal_lower.contains(word) {
                    score += 0.1;
                }
            }

            if score > 0.3 {
                results.push(SimilarInvestigation {
                    similarity_score: score,
                    tool_sequence: pattern
                        .successful_path
                        .iter()
                        .map(|step| format!("{} {}", step.tool, step.args.as_deref().unwrap_or("")))
                        .collect(),
                    solution: pattern.solution,
                });
            }
        }
    }

    // Sort by similarity score
    results.sort_by(|a, b| b.similarity_score.partial_cmp(&a.similarity_score).unwrap());

    // Return top N
    Ok(results.into_iter().take(limit).collect())
}

// =============================================================================
// OPSPILOT CONFIG FILE SUPPORT
// =============================================================================

/// OpsPilot configuration structure (matches frontend OpsPilotConfig interface)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpsPilotConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_cli_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kubeconfig: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

/// Get list of config file paths to search (in priority order)
fn get_opspilot_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // 1. Current directory (project-level config)
    paths.push(PathBuf::from(".opspilot.json"));

    // 1. Home OpsPilot directory (Primary)
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".opspilot").join("config.json"));
    }

    // 2. Legacy home directory config
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".opspilot.json"));
    }

    // 3. XDG config directory (Linux/macOS standard)
    if let Some(config_dir) = dirs::config_dir() {
        paths.push(config_dir.join("opspilot").join("config.json"));
    }

    paths
}

/// Get an environment variable value
#[tauri::command]
pub fn get_env_var(name: String) -> Option<String> {
    env::var(&name).ok()
}

/// Get all OpsPilot-related environment variables
#[tauri::command]
pub fn get_opspilot_env_vars() -> std::collections::HashMap<String, String> {
    let env_keys = vec![
        "OPSPILOT_AGENT_URL",
        "OPSPILOT_CLAUDE_CLI_PATH",
        "OPSPILOT_EMBEDDING_ENDPOINT",
        "OPSPILOT_EMBEDDING_MODEL",
        "OPSPILOT_GITHUB_TOKEN",
        "KUBECONFIG",
    ];

    let mut result = std::collections::HashMap::new();
    for key in env_keys {
        if let Ok(value) = env::var(key) {
            result.insert(key.to_string(), value);
        }
    }
    result
}

// -----------------------------------------------------------------------------
// SERVER INFO DISCOVERY
// -----------------------------------------------------------------------------

/// Server information stored by the agent sidecar
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub port: u16,
    pub pid: u32,
    pub version: Option<String>,
}

/// Read the server info file written by the agent sidecar.
/// This allows the frontend to discover the actual port being used.
#[tauri::command]
pub async fn read_server_info_file() -> Result<Option<ServerInfo>, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?;
    
    let info_path = home.join(".opspilot").join("server-info.json");

    if !info_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&info_path).await
        .map_err(|e| format!("Failed to read server info: {}", e))?;

    let info: ServerInfo = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse server info: {}", e))?;

    Ok(Some(info))
}

// =============================================================================
// KNOWLEDGE BASE INITIALIZATION
// =============================================================================

/// Information about the knowledge base directory
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KBDirectoryInfo {
    pub path: String,
    pub exists: bool,
    pub has_files: bool,
    pub file_count: usize,
    pub initialized: bool,
}

/// Get the user's knowledge base directory path
fn get_kb_directory() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".opspilot")
        .join("knowledge")
}

/// Check the status of the user's knowledge base directory
#[tauri::command]
pub async fn get_kb_directory_info() -> Result<KBDirectoryInfo, String> {
    let kb_dir = get_kb_directory();
    let exists = kb_dir.exists();

    let mut file_count = 0;
    let mut has_files = false;

    if exists {
        if let Ok(entries) = std::fs::read_dir(&kb_dir) {
            for entry in entries.flatten() {
                if let Some(ext) = entry.path().extension() {
                    if ext == "jsonl" {
                        file_count += 1;
                        has_files = true;
                    }
                }
            }
        }
    }

    // Check if README exists (indicates initialized)
    let readme_exists = kb_dir.join("README.md").exists();

    Ok(KBDirectoryInfo {
        path: kb_dir.to_string_lossy().to_string(),
        exists,
        has_files,
        file_count,
        initialized: readme_exists,
    })
}

/// Initialize the knowledge base directory with sample files
#[tauri::command]
pub async fn init_kb_directory() -> Result<KBDirectoryInfo, String> {
    let kb_dir = get_kb_directory();

    // Create directory if it doesn't exist
    fs::create_dir_all(&kb_dir)
        .await
        .map_err(|e| format!("Failed to create KB directory: {}", e))?;

    // Create README.md
    let readme_content = r#"# OpsPilot Custom Knowledge Base

This directory contains your custom knowledge base entries for OpsPilot.

## Quick Start

1. Create `.jsonl` files with your troubleshooting patterns
2. Go to Settings > Memory System > Knowledge Base
3. Click "Re-Index Data" to include your entries

## File Format

Each line in a `.jsonl` file should be a valid JSON object:

```json
{"id": "unique-id", "category": "troubleshooting", "symptoms": ["error message", "symptom"], "root_cause": "Why this happens", "investigation": ["step 1", "step 2"], "fixes": ["solution 1", "solution 2"], "related_patterns": ["tag1", "tag2"]}
```

## Entry Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier |
| `category` | string | Yes | Category (troubleshooting, runbook, best-practices) |
| `symptoms` | string[] | Yes | Search queries that should match |
| `root_cause` | string | No | Explanation of the issue |
| `investigation` | string[] | No | Steps to investigate |
| `fixes` | string[] | No | Solutions |
| `related_patterns` | string[] | No | Related topics |

## Example

See `examples.jsonl` for sample entries you can customize.

## Documentation

Full documentation: https://github.com/ankitjain-wiz/opspilot/blob/main/docs/knowledge-base.md
"#;

    fs::write(kb_dir.join("README.md"), readme_content)
        .await
        .map_err(|e| format!("Failed to write README: {}", e))?;

    // Create examples.jsonl with sample entries
    let examples_content = r#"{"id": "example-pod-pending", "category": "troubleshooting", "symptoms": ["pod stuck in Pending", "pod not scheduling", "no nodes available"], "root_cause": "Pod cannot be scheduled due to resource constraints, node selectors, or taints", "investigation": ["kubectl describe pod <name> -n <namespace>", "kubectl get nodes -o wide", "kubectl describe nodes | grep -A5 'Taints'"], "fixes": ["Check if nodes have sufficient resources", "Verify node selectors match available nodes", "Check for taints that need tolerations"], "related_patterns": ["scheduling", "resources", "taints"]}
{"id": "example-custom-runbook", "category": "runbook", "symptoms": ["my-service not responding", "my-service timeout", "connection refused to my-service"], "root_cause": "Service may need restart or has unhealthy pods", "investigation": ["kubectl get pods -l app=my-service", "kubectl logs -l app=my-service --tail=50", "kubectl get events --field-selector involvedObject.name=my-service"], "fixes": ["kubectl rollout restart deployment/my-service", "Check service endpoints: kubectl get endpoints my-service", "Verify network policies"], "related_patterns": ["service", "networking", "restart"]}
{"id": "example-best-practice", "category": "best-practices", "symptoms": ["how to set resource limits", "prevent OOMKilled", "resource recommendations"], "description": "Best practices for container resource configuration", "investigation": ["Check current usage: kubectl top pods", "Review VPA recommendations if available"], "fixes": ["Set requests to P50 usage", "Set limits to P99 usage", "Use VPA for automatic tuning"], "related_patterns": ["resources", "limits", "vpa", "oom"]}
"#;

    fs::write(kb_dir.join("examples.jsonl"), examples_content)
        .await
        .map_err(|e| format!("Failed to write examples: {}", e))?;

    eprintln!("[kb] Initialized knowledge base directory at: {:?}", kb_dir);

    // Return updated info
    get_kb_directory_info().await
}
