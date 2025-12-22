use tauri::State;
use kube::{
    api::{Api, DynamicObject, GroupVersionKind, Patch, PatchParams},
    Discovery,
};
use crate::state::AppState;
use crate::client::create_client;
use std::process::Command;

/// Patch Helm values on an ArgoCD Application
#[tauri::command]
pub async fn argo_patch_helm_values(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    values: String,
) -> Result<String, String> {
    let client = create_client(state).await?;

    let gvk = GroupVersionKind::gvk("argoproj.io", "v1alpha1", "Application");
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("ArgoCD Application CRD not found")?;

    let api: Api<DynamicObject> = Api::namespaced_with(client, &namespace, &ar);

    // First, get the current application to check if it uses sources or source
    let current = api.get(&name).await.map_err(|e| format!("Failed to get application: {}", e))?;

    let uses_sources = current.data.get("spec")
        .and_then(|s| s.get("sources"))
        .map(|s| s.is_array())
        .unwrap_or(false);

    let patch_json = if uses_sources {
        // Multi-source app - patch first source
        serde_json::json!({
            "spec": {
                "sources": [{
                    "helm": {
                        "values": values
                    }
                }]
            }
        })
    } else {
        // Single source app
        serde_json::json!({
            "spec": {
                "source": {
                    "helm": {
                        "values": values
                    }
                }
            }
        })
    };

    let pp = PatchParams::apply("opspilot");
    let patch = Patch::Merge(&patch_json);

    api.patch(&name, &pp, &patch)
        .await
        .map_err(|e| format!("Failed to patch helm values: {}", e))?;

    Ok("Helm values updated successfully".to_string())
}

/// Patch source configuration (targetRevision, chart, repoURL)
#[tauri::command]
pub async fn argo_patch_source(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    target_revision: Option<String>,
    chart: Option<String>,
    repo_url: Option<String>,
) -> Result<String, String> {
    let client = create_client(state).await?;

    let gvk = GroupVersionKind::gvk("argoproj.io", "v1alpha1", "Application");
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("ArgoCD Application CRD not found")?;

    let api: Api<DynamicObject> = Api::namespaced_with(client, &namespace, &ar);

    // Build patch with only provided fields
    let mut source_patch = serde_json::Map::new();

    if let Some(rev) = target_revision {
        source_patch.insert("targetRevision".to_string(), serde_json::Value::String(rev));
    }
    if let Some(c) = chart {
        source_patch.insert("chart".to_string(), serde_json::Value::String(c));
    }
    if let Some(url) = repo_url {
        source_patch.insert("repoURL".to_string(), serde_json::Value::String(url));
    }

    if source_patch.is_empty() {
        return Err("No changes provided".to_string());
    }

    // Check if app uses sources or source
    let current = api.get(&name).await.map_err(|e| format!("Failed to get application: {}", e))?;

    let uses_sources = current.data.get("spec")
        .and_then(|s| s.get("sources"))
        .map(|s| s.is_array())
        .unwrap_or(false);

    let patch_json = if uses_sources {
        serde_json::json!({
            "spec": {
                "sources": [serde_json::Value::Object(source_patch)]
            }
        })
    } else {
        serde_json::json!({
            "spec": {
                "source": serde_json::Value::Object(source_patch)
            }
        })
    };

    let pp = PatchParams::apply("opspilot");
    let patch = Patch::Merge(&patch_json);

    api.patch(&name, &pp, &patch)
        .await
        .map_err(|e| format!("Failed to patch source: {}", e))?;

    Ok("Source configuration updated successfully".to_string())
}

/// Sync an ArgoCD application
///
/// This uses the ArgoCD CLI if available for full sync options,
/// otherwise falls back to annotation-based refresh
#[tauri::command]
pub async fn argo_sync_application(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    prune: bool,
    force: bool,
    dry_run: bool,
) -> Result<String, String> {
    // First, try using ArgoCD CLI for full sync capabilities
    let argocd_available = Command::new("which")
        .arg("argocd")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if argocd_available {
        let mut args = vec!["app", "sync", &name];

        if prune {
            args.push("--prune");
        }
        if force {
            args.push("--force");
        }
        if dry_run {
            args.push("--dry-run");
        }

        let output = Command::new("argocd")
            .args(&args)
            .output()
            .map_err(|e| format!("Failed to execute argocd sync: {}", e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Ok(format!("Sync initiated successfully\n{}", stdout));
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Fall through to annotation-based approach
            eprintln!("ArgoCD CLI sync failed: {}, falling back to annotation", stderr);
        }
    }

    // Fallback: Use annotation-based refresh
    // This triggers ArgoCD controller to refresh and sync
    let client = create_client(state).await?;

    let gvk = GroupVersionKind::gvk("argoproj.io", "v1alpha1", "Application");
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("ArgoCD Application CRD not found")?;

    let api: Api<DynamicObject> = Api::namespaced_with(client, &namespace, &ar);

    // Set refresh annotation to trigger sync
    let patch_json = serde_json::json!({
        "metadata": {
            "annotations": {
                "argocd.argoproj.io/refresh": "hard"
            }
        },
        "operation": {
            "initiatedBy": {
                "username": "opspilot"
            },
            "sync": {
                "prune": prune,
                "syncStrategy": {
                    "apply": {
                        "force": force
                    }
                }
            }
        }
    });

    let pp = PatchParams::apply("opspilot");
    let patch = Patch::Merge(&patch_json);

    api.patch(&name, &pp, &patch)
        .await
        .map_err(|e| format!("Failed to trigger sync: {}", e))?;

    if dry_run {
        Ok("Dry run: Sync would be triggered (annotation-based sync does not support dry-run)".to_string())
    } else {
        Ok("Sync triggered via refresh annotation. Check ArgoCD for sync status.".to_string())
    }
}

/// Refresh an ArgoCD application (re-fetch from git)
#[tauri::command]
pub async fn argo_refresh_application(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    hard: bool,
) -> Result<String, String> {
    let client = create_client(state).await?;

    let gvk = GroupVersionKind::gvk("argoproj.io", "v1alpha1", "Application");
    let discovery = Discovery::new(client.clone()).run().await.map_err(|e| e.to_string())?;
    let (ar, _) = discovery.resolve_gvk(&gvk).ok_or("ArgoCD Application CRD not found")?;

    let api: Api<DynamicObject> = Api::namespaced_with(client, &namespace, &ar);

    let refresh_type = if hard { "hard" } else { "normal" };

    let patch_json = serde_json::json!({
        "metadata": {
            "annotations": {
                "argocd.argoproj.io/refresh": refresh_type
            }
        }
    });

    let pp = PatchParams::apply("opspilot");
    let patch = Patch::Merge(&patch_json);

    api.patch(&name, &pp, &patch)
        .await
        .map_err(|e| format!("Failed to refresh application: {}", e))?;

    Ok(format!("Application refresh ({}) triggered successfully", refresh_type))
}
