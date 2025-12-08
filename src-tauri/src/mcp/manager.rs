use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde_json::{Value, json};
use crate::mcp::client::McpClient;

pub struct McpManager {
    clients: Arc<Mutex<HashMap<String, Arc<McpClient>>>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add_server(&self, name: String, command: String, args: Vec<String>, env: HashMap<String, String>) -> Result<(), String> {
        let client = McpClient::new(&command, &args, &env).await?;
        client.initialize().await?;
        
        let mut clients = self.clients.lock().await;
        eprintln!("[MCP] Added server: {}", name);
        clients.insert(name, Arc::new(client));
        Ok(())
    }

    pub async fn remove_server(&self, name: &str) {
        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.remove(name) {
            client.shutdown().await;
            eprintln!("[MCP] Removed server: {}", name);
        }
    }
    
    pub async fn get_client(&self, name: &str) -> Option<Arc<McpClient>> {
        let clients = self.clients.lock().await;
        clients.get(name).cloned()
    }

    pub async fn list_all_tools(&self) -> Vec<Value> {
        let clients = self.clients.lock().await;
        let mut all_tools = Vec::new();

        for (server_name, client) in clients.iter() {
            let tools = client.get_tools().await;
            for tool in tools {
                 all_tools.push(json!({
                     "name": format!("{}__{}", server_name, tool.name),
                     "original_name": tool.name,
                     "server": server_name,
                     "description": tool.description,
                     "input_schema": tool.input_schema
                 }));
            }
        }
        all_tools
    }

    /// Returns list of currently connected server names
    pub async fn list_connected_servers(&self) -> Vec<String> {
        let clients = self.clients.lock().await;
        clients.keys().cloned().collect()
    }
}
