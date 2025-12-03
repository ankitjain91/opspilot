use serde::{Deserialize, Serialize};

const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434/v1";
const OLLAMA_API_URL: &str = "http://127.0.0.1:11434/api";
const DEFAULT_MODEL: &str = "llama3.1:8b";

#[derive(Serialize, Deserialize)]
pub struct OllamaStatus {
    pub ollama_running: bool,
    pub model_available: bool,
    pub model_name: String,
    pub available_models: Vec<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Option<Vec<OllamaModel>>,
}

#[derive(Deserialize)]
struct OllamaModel {
    name: String,
}

#[tauri::command]
pub async fn check_ollama_status() -> Result<OllamaStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    // Check if Ollama is running by hitting the tags endpoint
    let tags_result = client
        .get(format!("{}/tags", OLLAMA_API_URL))
        .send()
        .await;

    match tags_result {
        Ok(resp) if resp.status().is_success() => {
            let tags: OllamaTagsResponse = resp.json().await.unwrap_or(OllamaTagsResponse { models: None });
            let available_models: Vec<String> = tags.models
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.name)
                .collect();

            let model_available = available_models.iter().any(|m| m.starts_with("llama3.1"));

            Ok(OllamaStatus {
                ollama_running: true,
                model_available,
                model_name: DEFAULT_MODEL.to_string(),
                available_models,
                error: None,
            })
        }
        Ok(resp) => {
            Ok(OllamaStatus {
                ollama_running: false,
                model_available: false,
                model_name: DEFAULT_MODEL.to_string(),
                available_models: vec![],
                error: Some(format!("Ollama returned status: {}", resp.status())),
            })
        }
        Err(e) => {
            let error_msg = if e.is_connect() {
                "Ollama is not running. Please start Ollama first.".to_string()
            } else if e.is_timeout() {
                "Connection to Ollama timed out.".to_string()
            } else {
                format!("Failed to connect to Ollama: {}", e)
            };

            Ok(OllamaStatus {
                ollama_running: false,
                model_available: false,
                model_name: DEFAULT_MODEL.to_string(),
                available_models: vec![],
                error: Some(error_msg),
            })
        }
    }
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: String,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}



#[tauri::command]
pub async fn call_local_llm_with_tools(
    prompt: String,
    system_prompt: Option<String>,
    conversation_history: Vec<serde_json::Value>,
) -> Result<String, String> {
    let sys = system_prompt.unwrap_or_else(|| {
        r#"You are a Kubernetes SRE assistant with the ability to execute kubectl commands.

When you need more information about a resource, you can use these tools:
- describe_resource(kind, namespace, name): Get detailed information about a resource
- get_logs(namespace, pod_name, container): Get logs from a pod
- get_events(namespace, name): Get events related to a resource
- list_pods(namespace): List all pods in a namespace

When suggesting kubectl commands, use the actual tools instead of just suggesting commands.
Format your responses in markdown. Be concise and actionable."#.to_string()
    });

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: sys,
    }];

    // Add conversation history
    for msg in conversation_history {
        if let Some(role) = msg.get("role").and_then(|v| v.as_str()) {
            if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
                messages.push(ChatMessage {
                    role: role.to_string(),
                    content: content.to_string(),
                });
            }
        }
    }

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: prompt,
    });

    let body = ChatRequest {
        model: "llama3.1:8b".to_string(),
        messages,
        max_tokens: Some(1024),
        temperature: Some(0.2),
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/chat/completions", OLLAMA_BASE_URL))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("LLM HTTP error: {}", resp.status()));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("parse error: {e}"))?;

    let answer = parsed
        .choices
        .get(0)
        .map(|c| c.message.content.clone())
        .unwrap_or_else(|| "No response from model".to_string());

    Ok(answer)
}

#[tauri::command]
pub async fn call_local_llm(prompt: String, system_prompt: Option<String>) -> Result<String, String> {
    call_local_llm_with_tools(prompt, system_prompt, vec![]).await
}
