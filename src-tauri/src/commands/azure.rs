use tauri::{command, Emitter, AppHandle};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use chrono::{Utc, Duration};


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
        // Use our structured error formatter (borrowed from context.rs logic, but we'll inline a simple version or share it if possible)
        // For now, let's implement a specific formatter for this command
        let err_str = String::from_utf8_lossy(&output.stderr).to_string();
        let name_clone = name.clone();
        
        let err_lower = err_str.to_lowercase();
        
        // Check for common Azure errors
        if err_lower.contains("device is required to be compliant") {
             return Err(format!(
                "AZURE_DEVICE_COMPLIANCE|{}|Azure AD device compliance required.|az login",
                name_clone
            ));
        }
        
        if err_lower.contains("devicecodecredential") || err_lower.contains("sign in, use a web browser") {
             return Err(format!(
                "AZURE_LOGIN_REQUIRED|{}|Azure authentication required (Device Code).|az login",
                name_clone
            ));
        }

        if err_lower.contains("refresh token has expired") {
             return Err(format!(
                "AZURE_TOKEN_EXPIRED|{}|Azure AD refresh token has expired.|az login",
                name_clone
            ));
        }

        return Err(format!("UNKNOWN_ERROR|{}|{}|", name_clone, err_str));
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

/// Azure Monitor metric data point
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AksMetricPoint {
    pub timestamp: i64,  // Unix timestamp in seconds
    pub node_count: Option<f64>,
    pub pod_count: Option<f64>,
    pub cpu_usage_percent: Option<f64>,
    pub memory_usage_percent: Option<f64>,
}

/// Response from Azure Monitor metrics query
#[derive(Debug, Deserialize)]
struct AzMetricsResponse {
    value: Vec<AzMetricValue>,
}

#[derive(Debug, Deserialize)]
struct AzMetricValue {
    name: AzMetricName,
    timeseries: Vec<AzTimeSeries>,
}

#[derive(Debug, Deserialize)]
struct AzMetricName {
    value: String,
}

#[derive(Debug, Deserialize)]
struct AzTimeSeries {
    data: Vec<AzDataPoint>,
}

#[derive(Debug, Deserialize)]
struct AzDataPoint {
    #[serde(rename = "timeStamp")]
    timestamp: String,
    average: Option<f64>,
    total: Option<f64>,
    count: Option<f64>,
}

/// Detect if the current context is an AKS cluster and return its resource ID
#[command]
pub async fn detect_aks_cluster(context_name: String) -> Result<Option<String>, String> {
    // AKS contexts can have various naming patterns:
    // - Exact cluster name: "my-cluster"
    // - With resource group: "my-rg_my-cluster"
    // - Azure naming: "my-cluster-admin" or "my-cluster-user"
    // - Full subscription pattern: "subscriptions/.../my-cluster"

    println!("[AKS Detection] Checking context: {}", context_name);

    // Scan all subscriptions to avoid missing clusters outside the current subscription
    let acct_out = Command::new("az")
        .args(&["account", "list", "--all", "-o", "json"])
        .output()
        .await
        .map_err(|e| format!("Failed to run az account list: {}", e))?;

    if !acct_out.status.success() {
        let stderr = String::from_utf8_lossy(&acct_out.stderr);
        println!("[AKS Detection] Azure CLI error or not logged in: {}", stderr);
        return Ok(None);
    }

    let accounts: Vec<AzAccount> = serde_json::from_slice(&acct_out.stdout)
        .map_err(|e| format!("Failed to parse azure accounts: {}", e))?;

    println!("[AKS Detection] Scanning {} subscriptions for AKS clusters", accounts.len());

    // Normalize context name for matching
    let ctx_lower = context_name.to_lowercase();
    // Remove common suffixes like -admin, -user
    let ctx_cleaned = ctx_lower
        .trim_end_matches("-admin")
        .trim_end_matches("-user")
        .trim_end_matches("_admin")
        .trim_end_matches("_user");

    // Try multiple matching strategies
    for account in &accounts {
        let list_out = Command::new("az")
            .args(&["aks", "list", "--subscription", &account.id, "-o", "json"])
            .output()
            .await;

        let clusters: Vec<AzCluster> = match list_out {
            Ok(o) if o.status.success() => serde_json::from_slice(&o.stdout).unwrap_or_default(),
            _ => Vec::new(),
        };

        if clusters.is_empty() {
            continue;
        }

        println!("[AKS Detection] Found {} AKS clusters in subscription {}", clusters.len(), account.name);

        for cluster in &clusters {
        let cluster_lower = cluster.name.to_lowercase();

        // Strategy 1: Exact match
        if ctx_lower == cluster_lower {
            println!("[AKS Detection] Exact match found: {}", cluster.name);
            return Ok(Some(cluster.id.clone()));
        }

        // Strategy 2: Context contains cluster name (e.g., "myaks-admin" contains "myaks")
        if ctx_lower.contains(&cluster_lower) || ctx_cleaned.contains(&cluster_lower) {
            println!("[AKS Detection] Context contains cluster: {} in {}", cluster.name, context_name);
            return Ok(Some(cluster.id.clone()));
        }

        // Strategy 3: Cluster name contains context (e.g., cluster "dev-myaks" matches context "myaks")
        if cluster_lower.contains(&ctx_lower) || cluster_lower.contains(ctx_cleaned) {
            println!("[AKS Detection] Cluster contains context: {} contains {}", cluster.name, context_name);
            return Ok(Some(cluster.id.clone()));
        }

        // Strategy 4: Check if context contains resource group pattern "rg_cluster" or "rg-cluster"
        let rg_pattern = format!("{}_{}", cluster.resource_group.to_lowercase(), cluster_lower);
        let rg_pattern2 = format!("{}-{}", cluster.resource_group.to_lowercase(), cluster_lower);
        if ctx_lower.contains(&rg_pattern) || ctx_lower.contains(&rg_pattern2) {
            println!("[AKS Detection] Resource group pattern match: {}", cluster.name);
            return Ok(Some(cluster.id.clone()));
        }
        }
    }

    println!("[AKS Detection] No matching AKS cluster found for context: {}", context_name);
    Ok(None)
}

/// Fetch historical metrics from Azure Monitor for an AKS cluster
#[command]
pub async fn get_aks_metrics_history(
    resource_id: String,
    hours: Option<i64>,
) -> Result<Vec<AksMetricPoint>, String> {
    let hours = hours.unwrap_or(1); // Default to 1 hour of history
    let end_time = Utc::now();
    let start_time = end_time - Duration::hours(hours);

    // Query CPU/memory with Average aggregation
    let cpu_mem_out = Command::new("az")
        .args(&[
            "monitor", "metrics", "list",
            "--resource", &resource_id,
            "--metric", "node_cpu_usage_percentage,node_memory_working_set_percentage",
            "--aggregation", "Average",
            "--interval", "PT5M",
            "--start-time", &start_time.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "--end-time", &end_time.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "-o", "json"
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to fetch AKS CPU/memory metrics: {}", e))?;

    if !cpu_mem_out.status.success() {
        let stderr = String::from_utf8_lossy(&cpu_mem_out.stderr);
        return Err(format!("Azure Monitor CPU/memory query failed: {}", stderr));
    }

    let cpu_mem_resp: AzMetricsResponse = serde_json::from_slice(&cpu_mem_out.stdout)
        .map_err(|e| format!("Failed to parse CPU/memory metrics response: {}", e))?;

    // Query status metrics with Count aggregation
    let status_out = Command::new("az")
        .args(&[
            "monitor", "metrics", "list",
            "--resource", &resource_id,
            "--metric", "kube_node_status_condition,kube_pod_status_ready",
            "--aggregation", "Count",
            "--interval", "PT5M",
            "--start-time", &start_time.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "--end-time", &end_time.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "-o", "json"
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to fetch AKS status metrics: {}", e))?;

    if !status_out.status.success() {
        let stderr = String::from_utf8_lossy(&status_out.stderr);
        return Err(format!("Azure Monitor status metrics query failed: {}", stderr));
    }

    let status_resp: AzMetricsResponse = serde_json::from_slice(&status_out.stdout)
        .map_err(|e| format!("Failed to parse status metrics response: {}", e))?;

    // Build a map of timestamp -> metrics
    let mut metrics_map: std::collections::HashMap<i64, AksMetricPoint> = std::collections::HashMap::new();

    for metric_value in cpu_mem_resp.value.into_iter().chain(status_resp.value.into_iter()) {
        let metric_name = metric_value.name.value.as_str();

        for ts in metric_value.timeseries {
            for point in ts.data {
                // Parse timestamp
                let ts_parsed = chrono::DateTime::parse_from_rfc3339(&point.timestamp)
                    .map(|dt| dt.timestamp())
                    .unwrap_or(0);

                if ts_parsed == 0 {
                    continue;
                }

                let entry = metrics_map.entry(ts_parsed).or_insert(AksMetricPoint {
                    timestamp: ts_parsed,
                    node_count: None,
                    pod_count: None,
                    cpu_usage_percent: None,
                    memory_usage_percent: None,
                });

                match metric_name {
                    "node_cpu_usage_percentage" => {
                        entry.cpu_usage_percent = point.average;
                    }
                    "node_memory_working_set_percentage" => {
                        entry.memory_usage_percent = point.average;
                    }
                    "kube_node_status_condition" => {
                        entry.node_count = point.count.or(point.total).or(point.average);
                    }
                    "kube_pod_status_ready" => {
                        entry.pod_count = point.count.or(point.total).or(point.average);
                    }
                    _ => {}
                }
            }
        }
    }

    // Convert to sorted vec
    let mut result: Vec<AksMetricPoint> = metrics_map.into_values().collect();
    result.sort_by_key(|p| p.timestamp);

    Ok(result)
}
