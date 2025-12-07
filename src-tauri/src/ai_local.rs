use serde::{Deserialize, Serialize};

// Default configurations
const DEFAULT_OLLAMA_URL: &str = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_URL: &str = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_URL: &str = "https://api.anthropic.com/v1";

// ============================================================================
// LLM Configuration Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LLMProvider {
    Ollama,
    OpenAI,
    Anthropic,
    Custom,
}

impl Default for LLMProvider {
    fn default() -> Self {
        LLMProvider::Ollama
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMConfig {
    pub provider: LLMProvider,
    pub api_key: Option<String>,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
}

impl Default for LLMConfig {
    fn default() -> Self {
        LLMConfig {
            provider: LLMProvider::Ollama,
            api_key: None,
            base_url: DEFAULT_OLLAMA_URL.to_string(),
            model: "llama3.1:8b".to_string(),
            temperature: 0.2,
            max_tokens: 2048,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct LLMStatus {
    pub connected: bool,
    pub provider: String,
    pub model: String,
    pub available_models: Vec<String>,
    pub error: Option<String>,
}

// ============================================================================
// Ollama-specific types
// ============================================================================

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

// ============================================================================
// OpenAI-compatible types (works for OpenAI, Ollama, and many others)
// ============================================================================

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

// ============================================================================
// Anthropic-specific types
// ============================================================================

#[derive(Serialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct AnthropicRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicContentBlock {
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContentBlock>,
}

// ============================================================================
// OpenAI Models List Response
// ============================================================================

#[derive(Deserialize)]
struct OpenAIModel {
    id: String,
}

#[derive(Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModel>,
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Check the status of the configured LLM provider
#[tauri::command]
pub async fn check_llm_status(config: LLMConfig) -> Result<LLMStatus, String> {
    match config.provider {
        LLMProvider::Ollama => check_ollama_status_internal(&config).await,
        LLMProvider::OpenAI | LLMProvider::Custom => check_openai_status_internal(&config).await,
        LLMProvider::Anthropic => check_anthropic_status_internal(&config).await,
    }
}

/// Legacy Ollama status check (for backwards compatibility)
#[tauri::command]
pub async fn check_ollama_status() -> Result<OllamaStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let tags_result = client
        .get(format!("{}/api/tags", DEFAULT_OLLAMA_URL))
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
                model_name: "llama3.1:8b".to_string(),
                available_models,
                error: None,
            })
        }
        Ok(resp) => {
            Ok(OllamaStatus {
                ollama_running: false,
                model_available: false,
                model_name: "llama3.1:8b".to_string(),
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
                model_name: "llama3.1:8b".to_string(),
                available_models: vec![],
                error: Some(error_msg),
            })
        }
    }
}

/// Call LLM with the provided configuration
#[tauri::command]
pub async fn call_llm(
    config: LLMConfig,
    prompt: String,
    system_prompt: Option<String>,
    conversation_history: Vec<serde_json::Value>,
) -> Result<String, String> {
    match config.provider {
        LLMProvider::Ollama | LLMProvider::OpenAI | LLMProvider::Custom => {
            call_openai_compatible(&config, prompt, system_prompt, conversation_history).await
        }
        LLMProvider::Anthropic => {
            call_anthropic(&config, prompt, system_prompt, conversation_history).await
        }
    }
}

/// Legacy function for backwards compatibility
#[tauri::command]
pub async fn call_local_llm_with_tools(
    prompt: String,
    system_prompt: Option<String>,
    conversation_history: Vec<serde_json::Value>,
) -> Result<String, String> {
    let config = LLMConfig::default();
    call_llm(config, prompt, system_prompt, conversation_history).await
}

/// Legacy function for backwards compatibility
#[tauri::command]
pub async fn call_local_llm(prompt: String, system_prompt: Option<String>) -> Result<String, String> {
    call_local_llm_with_tools(prompt, system_prompt, vec![]).await
}

// ============================================================================
// Internal Implementation Functions
// ============================================================================

async fn check_ollama_status_internal(config: &LLMConfig) -> Result<LLMStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let base_url = config.base_url.trim_end_matches('/');
    let tags_url = format!("{}/api/tags", base_url);

    let tags_result = client.get(&tags_url).send().await;

    match tags_result {
        Ok(resp) if resp.status().is_success() => {
            let tags: OllamaTagsResponse = resp.json().await.unwrap_or(OllamaTagsResponse { models: None });
            let available_models: Vec<String> = tags.models
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.name)
                .collect();

            let model_available = available_models.iter().any(|m| m.contains(&config.model) || config.model.contains(m.split(':').next().unwrap_or("")));

            Ok(LLMStatus {
                connected: true,
                provider: "Ollama".to_string(),
                model: config.model.clone(),
                available_models,
                error: if model_available { None } else { Some(format!("Model '{}' not found. Pull it with: ollama pull {}", config.model, config.model)) },
            })
        }
        Ok(resp) => {
            Ok(LLMStatus {
                connected: false,
                provider: "Ollama".to_string(),
                model: config.model.clone(),
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

            Ok(LLMStatus {
                connected: false,
                provider: "Ollama".to_string(),
                model: config.model.clone(),
                available_models: vec![],
                error: Some(error_msg),
            })
        }
    }
}

async fn check_openai_status_internal(config: &LLMConfig) -> Result<LLMStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let base_url = config.base_url.trim_end_matches('/');
    let models_url = format!("{}/models", base_url);

    let mut request = client.get(&models_url);
    if let Some(ref api_key) = config.api_key {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    }

    let result = request.send().await;

    match result {
        Ok(resp) if resp.status().is_success() => {
            let models: OpenAIModelsResponse = resp.json().await.unwrap_or(OpenAIModelsResponse { data: vec![] });
            let available_models: Vec<String> = models.data.into_iter().map(|m| m.id).collect();

            Ok(LLMStatus {
                connected: true,
                provider: match config.provider {
                    LLMProvider::OpenAI => "OpenAI".to_string(),
                    LLMProvider::Custom => "Custom OpenAI-compatible".to_string(),
                    _ => "Unknown".to_string(),
                },
                model: config.model.clone(),
                available_models,
                error: None,
            })
        }
        Ok(resp) if resp.status().as_u16() == 401 => {
            Ok(LLMStatus {
                connected: false,
                provider: "OpenAI".to_string(),
                model: config.model.clone(),
                available_models: vec![],
                error: Some("Invalid API key. Please check your API key.".to_string()),
            })
        }
        Ok(resp) => {
            Ok(LLMStatus {
                connected: false,
                provider: "OpenAI".to_string(),
                model: config.model.clone(),
                available_models: vec![],
                error: Some(format!("API returned status: {}", resp.status())),
            })
        }
        Err(e) => {
            Ok(LLMStatus {
                connected: false,
                provider: "OpenAI".to_string(),
                model: config.model.clone(),
                available_models: vec![],
                error: Some(format!("Connection failed: {}", e)),
            })
        }
    }
}

async fn check_anthropic_status_internal(config: &LLMConfig) -> Result<LLMStatus, String> {
    // Anthropic doesn't have a models list endpoint, so we just validate the API key
    // by making a minimal request
    if config.api_key.is_none() {
        return Ok(LLMStatus {
            connected: false,
            provider: "Anthropic".to_string(),
            model: config.model.clone(),
            available_models: vec![
                "claude-sonnet-4-20250514".to_string(),
                "claude-3-5-sonnet-20241022".to_string(),
                "claude-3-5-haiku-20241022".to_string(),
                "claude-3-opus-20240229".to_string(),
            ],
            error: Some("API key is required for Anthropic".to_string()),
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let base_url = config.base_url.trim_end_matches('/');

    // Make a minimal request to check API key validity
    let request = AnthropicRequest {
        model: config.model.clone(),
        messages: vec![AnthropicMessage {
            role: "user".to_string(),
            content: "Hi".to_string(),
        }],
        max_tokens: 1,
        temperature: None,
        system: None,
    };

    let result = client
        .post(format!("{}/messages", base_url))
        .header("x-api-key", config.api_key.as_ref().unwrap())
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&request)
        .send()
        .await;

    match result {
        Ok(resp) if resp.status().is_success() => {
            Ok(LLMStatus {
                connected: true,
                provider: "Anthropic".to_string(),
                model: config.model.clone(),
                available_models: vec![
                    "claude-sonnet-4-20250514".to_string(),
                    "claude-3-5-sonnet-20241022".to_string(),
                    "claude-3-5-haiku-20241022".to_string(),
                    "claude-3-opus-20240229".to_string(),
                ],
                error: None,
            })
        }
        Ok(resp) if resp.status().as_u16() == 401 => {
            Ok(LLMStatus {
                connected: false,
                provider: "Anthropic".to_string(),
                model: config.model.clone(),
                available_models: vec![],
                error: Some("Invalid API key. Please check your Anthropic API key.".to_string()),
            })
        }
        Ok(resp) => {
            // Even a 400 error means the API is reachable and key is valid
            let status = resp.status();
            if status.as_u16() == 400 {
                Ok(LLMStatus {
                    connected: true,
                    provider: "Anthropic".to_string(),
                    model: config.model.clone(),
                    available_models: vec![
                        "claude-sonnet-4-20250514".to_string(),
                        "claude-3-5-sonnet-20241022".to_string(),
                        "claude-3-5-haiku-20241022".to_string(),
                        "claude-3-opus-20240229".to_string(),
                    ],
                    error: None,
                })
            } else {
                Ok(LLMStatus {
                    connected: false,
                    provider: "Anthropic".to_string(),
                    model: config.model.clone(),
                    available_models: vec![],
                    error: Some(format!("API returned status: {}", status)),
                })
            }
        }
        Err(e) => {
            Ok(LLMStatus {
                connected: false,
                provider: "Anthropic".to_string(),
                model: config.model.clone(),
                available_models: vec![],
                error: Some(format!("Connection failed: {}", e)),
            })
        }
    }
}

async fn call_openai_compatible(
    config: &LLMConfig,
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
        model: config.model.clone(),
        messages,
        max_tokens: Some(config.max_tokens),
        temperature: Some(config.temperature),
    };

    let base_url = config.base_url.trim_end_matches('/');
    let chat_url = if config.base_url.contains("ollama") || matches!(config.provider, LLMProvider::Ollama) {
        format!("{}/v1/chat/completions", base_url)
    } else {
        format!("{}/chat/completions", base_url)
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.post(&chat_url).json(&body);
    if let Some(ref api_key) = config.api_key {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    }

    let resp = request.send().await.map_err(|e| format!("Request error: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("LLM HTTP error {}: {}", status, body));
    }

    let parsed: ChatResponse = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    let answer = parsed
        .choices
        .get(0)
        .and_then(|c| c.message.content.clone())
        .unwrap_or_else(|| "No response from model".to_string());

    Ok(answer)
}

async fn call_anthropic(
    config: &LLMConfig,
    prompt: String,
    system_prompt: Option<String>,
    conversation_history: Vec<serde_json::Value>,
) -> Result<String, String> {
    let api_key = config.api_key.as_ref()
        .ok_or_else(|| "API key is required for Anthropic".to_string())?;

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

    let mut messages: Vec<AnthropicMessage> = vec![];

    // Add conversation history
    for msg in conversation_history {
        if let Some(role) = msg.get("role").and_then(|v| v.as_str()) {
            if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
                // Anthropic only accepts 'user' and 'assistant' roles
                let anthropic_role = match role {
                    "system" => continue, // Skip system messages, we'll use the system field
                    "user" => "user",
                    _ => "assistant",
                };
                messages.push(AnthropicMessage {
                    role: anthropic_role.to_string(),
                    content: content.to_string(),
                });
            }
        }
    }

    messages.push(AnthropicMessage {
        role: "user".to_string(),
        content: prompt,
    });

    let body = AnthropicRequest {
        model: config.model.clone(),
        messages,
        max_tokens: config.max_tokens,
        temperature: Some(config.temperature),
        system: Some(sys),
    };

    let base_url = config.base_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(format!("{}/messages", base_url))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request error: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error {}: {}", status, body));
    }

    let parsed: AnthropicResponse = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    let answer = parsed
        .content
        .get(0)
        .and_then(|c| c.text.clone())
        .unwrap_or_else(|| "No response from model".to_string());

    Ok(answer)
}

/// Get default configuration for a provider
#[tauri::command]
pub fn get_default_llm_config(provider: String) -> LLMConfig {
    match provider.to_lowercase().as_str() {
        "openai" => LLMConfig {
            provider: LLMProvider::OpenAI,
            api_key: None,
            base_url: DEFAULT_OPENAI_URL.to_string(),
            model: "gpt-4o".to_string(),
            temperature: 0.2,
            max_tokens: 2048,
        },
        "anthropic" => LLMConfig {
            provider: LLMProvider::Anthropic,
            api_key: None,
            base_url: DEFAULT_ANTHROPIC_URL.to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            temperature: 0.2,
            max_tokens: 2048,
        },
        "custom" => LLMConfig {
            provider: LLMProvider::Custom,
            api_key: None,
            base_url: "http://localhost:8000/v1".to_string(),
            model: "default".to_string(),
            temperature: 0.2,
            max_tokens: 2048,
        },
        _ => LLMConfig::default(), // Ollama
    }
}

/// Analyze text using the configured LLM
#[tauri::command]
pub async fn analyze_text(text: String, context: String) -> Result<String, String> {
    let system_prompt = format!("You are a Kubernetes expert. Analyze the provided text. Context: {}. Be concise, highlight errors, and suggest fixes.", context);
    call_local_llm(text, Some(system_prompt)).await
}
