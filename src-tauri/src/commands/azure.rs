use tauri::{command, Emitter, AppHandle};
use serde::{Deserialize, Serialize};
use tokio::process::Command;


#[derive(Debug, Serialize, Deserialize)]
pub struct AzureSubscription {
    pub id: String,
    pub name: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    pub clusters: Vec<AksCluster>,
}

// STOP: Rust types are strict.
// id: String, name: String, is_default: bool.

#[derive(Debug, Serialize, Deserialize)]
pub struct AksCluster {
    pub id: String,
    pub name: String,
    #[serde(rename = "resourceGroup")]
    pub resource_group: String,
    pub location: String,
    #[serde(rename = "powerState")]
    pub power_state: PowerState,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PowerState {
    pub code: String,
}

// CLI JSON structs to parse from `az` output
#[derive(Debug, Deserialize)]
struct AzAccount {
    id: String,
    name: String,
    #[serde(rename = "isDefault")]
    is_default: bool,
}

#[derive(Debug, Deserialize)]
struct AzCluster {
    id: String,
    name: String,
    #[serde(rename = "resourceGroup")]
    resource_group: String,
    location: String,
    #[serde(rename = "powerState")]
    power_state: Option<PowerState>,
}

#[command]
pub async fn azure_login() -> Result<String, String> {
    // Interactive login might be tricky if headless, but usually opens browser.
    // "az login" opens browser.
    let output = Command::new("az")
        .arg("login")
        .output()
        .await
        .map_err(|e| format!("Failed to execute az login: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok("Logged in".to_string())
}

#[command]
pub async fn refresh_azure_data(app: AppHandle) -> Result<Vec<AzureSubscription>, String> {
    // Emit status
    let _ = app.emit("azure:status", "Finding Azure subscriptions...");

    // 1. Get Accounts
    let output = Command::new("az")
        .args(&["account", "list", "--all", "-o", "json"])
        .output()
        .await
        .map_err(|e| format!("Failed to run az account list: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let accounts: Vec<AzAccount> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse azure accounts: {}", e))?;
    
    let _ = app.emit("azure:status", format!("Found {} subscriptions. Scanning for clusters...", accounts.len()));

    // 2. Fetch clusters for all accounts in parallel using spawn or join_all
    // Since we are in an async command, we can use futures::future::join_all
    let futures = accounts.into_iter().map(|account| {
        let app_handle = app.clone();
        async move {
            let sub_id = account.id.clone();
            
            let cmd_res = Command::new("az")
                .args(&["aks", "list", "--subscription", &sub_id, "-o", "json"])
                .output()
                .await;

            let clusters = match cmd_res {
                Ok(o) => {
                    if o.status.success() {
                        let raw_clusters: Vec<AzCluster> = serde_json::from_slice(&o.stdout).unwrap_or_default();
                        raw_clusters.into_iter().map(|c| AksCluster {
                            id: c.id,
                            name: c.name,
                            resource_group: c.resource_group,
                            location: c.location,
                            power_state: c.power_state.unwrap_or(PowerState { code: "Running".to_string() })
                        }).collect()
                    } else {
                        Vec::new()
                    }
                }
                Err(_) => Vec::new(),
            };

            let sub = AzureSubscription {
                id: account.id,
                name: account.name,
                is_default: account.is_default,
                clusters,
            };

            // Emit update
            let _ = app_handle.emit("azure:subscription_update", &sub);

            sub
        }
    });

    let result = futures::future::join_all(futures).await;
    Ok(result)
}

#[command]
pub async fn get_aks_credentials(subscription_id: String, resource_group: String, name: String) -> Result<String, String> {
    let output = Command::new("az")
        .args(&[
            "aks", "get-credentials",
            "--subscription", &subscription_id,
            "--resource-group", &resource_group,
            "--name", &name,
            "--overwrite-existing"
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to get credentials: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    
    // Auto-convert to azurecli login mode to respect the user's "az login" in terminal
    // This avoids the "devicecode" flow that the user finds confusing/broken within the app context.
    // We ignore errors here because kubelogin might not be installed or needed for all clusters.
    let _ = Command::new("kubelogin")
        .args(&["convert-kubeconfig", "-l", "azurecli"])
        .output()
        .await;

    Ok("Credentials merged (and converted to azurecli mode)".to_string())
}
