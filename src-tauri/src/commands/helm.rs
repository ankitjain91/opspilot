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
