use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub revision: String,
    pub updated: String,
}

#[tauri::command]
pub async fn helm_list() -> Result<Vec<HelmRelease>, String> {
    let output = Command::new("helm")
        .args(["list", "-A", "-o", "json"])
        .output()
        .map_err(|e| format!("Failed to execute helm command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not found") || stderr.contains("no such file") {
            return Ok(Vec::new());
        }
        return Err(format!("helm list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    let releases: Vec<HelmRelease> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse helm JSON: {}. Output: {}", e, stdout))?;

    Ok(releases)
}

#[tauri::command]
pub async fn helm_uninstall(namespace: String, name: String) -> Result<String, String> {
    let output = Command::new("helm")
        .args(["uninstall", &name, "-n", &namespace])
        .output()
        .map_err(|e| format!("Failed to execute helm command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("helm uninstall failed: {}", stderr));
    }

    Ok(format!("Successfully uninstalled {} from {}", name, namespace))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HelmReleaseDetails {
    pub info: serde_json::Value,
    pub manifest: String,
    pub values: serde_json::Value,
}

#[tauri::command]
pub async fn helm_get_details(namespace: String, name: String) -> Result<HelmReleaseDetails, String> {
    // 1. Get status and manifest
    let status_output = Command::new("helm")
        .args(["status", &name, "-n", &namespace, "-o", "json"])
        .output()
        .map_err(|e| format!("Failed to execute helm status: {}", e))?;

    if !status_output.status.success() {
        return Err(format!("helm status failed: {}", String::from_utf8_lossy(&status_output.stderr)));
    }

    let status_json: serde_json::Value = serde_json::from_slice(&status_output.stdout)
        .map_err(|e| format!("Failed to parse helm status JSON: {}", e))?;

    // 2. Get values
    let values_output = Command::new("helm")
        .args(["get", "values", &name, "-n", &namespace, "-o", "json"])
        .output()
        .map_err(|e| format!("Failed to execute helm get values: {}", e))?;

    let values_json: serde_json::Value = if values_output.status.success() {
        serde_json::from_slice(&values_output.stdout).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Null
    };

    Ok(HelmReleaseDetails {
        info: status_json.get("info").cloned().unwrap_or(serde_json::Value::Null),
        manifest: status_json.get("manifest").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        values: values_json,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HelmHistoryEntry {
    pub revision: i64,
    pub updated: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub description: String,
}

#[tauri::command]
pub async fn helm_history(namespace: String, name: String) -> Result<Vec<HelmHistoryEntry>, String> {
    let output = Command::new("helm")
        .args(["history", &name, "-n", &namespace, "-o", "json"])
        .output()
        .map_err(|e| format!("Failed to execute helm history: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("helm history failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    let history: Vec<HelmHistoryEntry> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse helm history JSON: {}", e))?;

    Ok(history)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HelmResource {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub api_version: String,
}

#[tauri::command]
pub async fn helm_get_resources(namespace: String, name: String) -> Result<Vec<HelmResource>, String> {
    // Get the manifest
    let output = Command::new("helm")
        .args(["get", "manifest", &name, "-n", &namespace])
        .output()
        .map_err(|e| format!("Failed to execute helm get manifest: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("helm get manifest failed: {}", stderr));
    }

    let manifest = String::from_utf8_lossy(&output.stdout);

    // Debug: Check if manifest is empty
    if manifest.trim().is_empty() {
        println!("[helm] Warning: Empty manifest for {}/{}", namespace, name);
        return Ok(Vec::new());
    }

    let mut resources: Vec<HelmResource> = Vec::new();

    // Parse YAML documents from manifest
    // Use serde_yaml's Deserializer::from_str for multi-document support
    for document in serde_yaml::Deserializer::from_str(&manifest) {
        match serde_yaml::Value::deserialize(document) {
            Ok(yaml_value) => {
                // Skip null documents (can happen with empty --- separators)
                if yaml_value.is_null() {
                    continue;
                }

                // Extract kind
                let kind = match yaml_value.get("kind") {
                    Some(serde_yaml::Value::String(k)) => k.clone(),
                    _ => continue, // Skip if no kind
                };

                // Extract metadata
                let metadata = match yaml_value.get("metadata") {
                    Some(m) => m,
                    None => continue,
                };

                // Extract name from metadata
                let res_name = match metadata.get("name") {
                    Some(serde_yaml::Value::String(n)) => n.clone(),
                    _ => "unknown".to_string(),
                };

                // Extract namespace from metadata (optional)
                let ns = match metadata.get("namespace") {
                    Some(serde_yaml::Value::String(n)) => Some(n.clone()),
                    _ => None,
                };

                // Extract apiVersion
                let api_version = match yaml_value.get("apiVersion") {
                    Some(serde_yaml::Value::String(v)) => v.clone(),
                    _ => "v1".to_string(),
                };

                resources.push(HelmResource {
                    kind,
                    name: res_name,
                    namespace: ns,
                    api_version,
                });
            }
            Err(e) => {
                // Log parse errors but continue processing other documents
                println!("[helm] Warning: Failed to parse YAML document: {}", e);
            }
        }
    }

    println!("[helm] Found {} resources for {}/{}", resources.len(), namespace, name);
    Ok(resources)
}

#[tauri::command]
pub async fn helm_rollback(namespace: String, name: String, revision: i64) -> Result<String, String> {
    let output = Command::new("helm")
        .args(["rollback", &name, &revision.to_string(), "-n", &namespace])
        .output()
        .map_err(|e| format!("Failed to execute helm rollback: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("helm rollback failed: {}", stderr));
    }

    Ok(format!("Successfully rolled back {} to revision {}", name, revision))
}
