#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use sysinfo::System;
use tauri::Emitter;

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
    #[serde(rename = "claude-code")]
    ClaudeCode, // Handling the hyphenated name if needed, though 'claude-code' string from JS might map here
    Groq,
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
    pub executor_model: Option<String>,
    pub embedding_model: Option<String>,
    pub embedding_endpoint: Option<String>,
    pub temperature: f32,
    pub max_tokens: u32,
}

impl Default for LLMConfig {
    fn default() -> Self {
        LLMConfig {
            provider: LLMProvider::Ollama,
            api_key: None,
            base_url: DEFAULT_OLLAMA_URL.to_string(),
            model: "llama3.1".to_string(),
            executor_model: Some("qwen2.5-coder:1.5b".to_string()),
            embedding_model: Some("nomic-embed-text".to_string()),
            embedding_endpoint: Some(DEFAULT_OLLAMA_URL.to_string()),
            temperature: 0.0,
            max_tokens: 8192,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct SystemSpecs {
    pub total_memory: u64,
    pub used_memory: u64,
    pub total_swap: u64,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub is_apple_silicon: bool,
}

#[tauri::command]
pub fn get_system_specs() -> SystemSpecs {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total_memory = sys.total_memory();
    let used_memory = sys.used_memory();
    let total_swap = sys.total_swap();
    let cpus = sys.cpus();
    let cpu_brand = cpus.first().map(|c| c.brand().to_string()).unwrap_or_default();
    let cpu_cores = cpus.len();
    
    // Simple heuristic for Apple Silicon
    let is_apple_silicon = cpu_brand.contains("Apple") && (std::env::consts::ARCH == "aarch64");

    SystemSpecs {
        total_memory,
        used_memory,
        total_swap,
        cpu_brand,
        cpu_cores,
        is_apple_silicon,
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

// Response format for structured output
#[derive(Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    format_type: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    // For Ollama JSON mode
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    // For OpenAI JSON mode
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

// Streaming response types
#[derive(Deserialize, Debug)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(Deserialize, Debug)]
struct StreamChoice {
    delta: StreamDelta,
    #[allow(dead_code)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Debug)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

// Event payload for streaming LLM responses
#[derive(Clone, Serialize)]
pub struct LLMStreamEvent {
    pub stream_id: String,
    pub event_type: String, // "start", "chunk", "done", "error"
    pub content: String,
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
        LLMProvider::OpenAI | LLMProvider::Custom | LLMProvider::Groq => check_openai_status_internal(&config).await,
        LLMProvider::Anthropic => check_anthropic_status_internal(&config).await,
        LLMProvider::ClaudeCode => Ok(LLMStatus {
            connected: true,
            provider: "Claude Code".to_string(),
            model: "claude-code-cli".to_string(),
            available_models: vec![],
            error: None,
        }),
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

            // Check if k8s-cli or base model exists
            let model_available = available_models.iter().any(|m| m.starts_with("k8s-cli") || m.starts_with("llama3.1"));

            Ok(OllamaStatus {
                ollama_running: true,
                model_available,
                model_name: "k8s-cli".to_string(),
                available_models,
                error: None,
            })
        }
        Ok(resp) => {
            Ok(OllamaStatus {
                ollama_running: false,
                model_available: false,
                model_name: "k8s-cli".to_string(),
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
                model_name: "k8s-cli".to_string(),
                available_models: vec![],
                error: Some(error_msg),
            })
        }
    }
}

#[derive(Serialize)]
struct CreateModelRequest {
    name: String,
    modelfile: String,
}

/// Create a new Ollama model from a Modelfile
#[tauri::command]
pub async fn create_ollama_model(model_name: String, modelfile: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900)) // Model creation can take time (pulling base image)
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/create", DEFAULT_OLLAMA_URL);
    let body = CreateModelRequest {
        name: model_name,
        modelfile,
    };

    let resp = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama API returned status: {}", resp.status()));
    }

    Ok("Model created successfully".to_string())
}

/// Call LLM with the provided configuration
/// Note: Parameters use camelCase to match JavaScript naming convention
#[tauri::command]
#[allow(non_snake_case)]
pub async fn call_llm(
    config: LLMConfig,
    prompt: String,
    systemPrompt: Option<String>,
    conversationHistory: Vec<serde_json::Value>,
) -> Result<String, String> {
    match config.provider {
        LLMProvider::Ollama | LLMProvider::OpenAI | LLMProvider::Custom | LLMProvider::Groq => {
            call_openai_compatible(&config, prompt, systemPrompt, conversationHistory).await
        }
        LLMProvider::Anthropic => {
            call_anthropic(&config, prompt, systemPrompt, conversationHistory).await
        }
        LLMProvider::ClaudeCode => {
            Err("Claude Code not supported for direct LLM calls".to_string())
        }
    }
}

/// Streaming LLM call - emits tokens as they arrive via Tauri events
#[tauri::command]
#[allow(non_snake_case)]
pub async fn call_llm_streaming(
    config: LLMConfig,
    prompt: String,
    systemPrompt: Option<String>,
    conversationHistory: Vec<serde_json::Value>,
    window: tauri::Window,
) -> Result<String, String> {
    use futures::StreamExt;

    let stream_id = uuid::Uuid::new_v4().to_string();

    // Emit start event
    let _ = window.emit("llm-stream", LLMStreamEvent {
        stream_id: stream_id.clone(),
        event_type: "start".to_string(),
        content: "".to_string(),
    });

    let sys = systemPrompt.unwrap_or_else(|| "You are a helpful assistant.".to_string());

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: sys.clone(),
    }];

    for msg in conversationHistory {
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
        content: prompt.clone(),
    });

    // Determine JSON mode
    let use_json_mode = sys.to_lowercase().contains("json") || sys.contains("JSON");
    let is_ollama = config.base_url.contains("ollama") ||
                    config.base_url.contains("11434") ||
                    matches!(config.provider, LLMProvider::Ollama);

    let body = ChatRequest {
        model: config.model.clone(),
        messages,
        max_tokens: Some(config.max_tokens),
        temperature: Some(config.temperature),
        stream: Some(true),  // Enable streaming
        format: if is_ollama && use_json_mode { Some("json".to_string()) } else { None },
        response_format: if !is_ollama && use_json_mode {
            Some(ResponseFormat { format_type: "json_object".to_string() })
        } else {
            None
        },
    };

    let base_url = config.base_url.trim_end_matches('/');
    // Check if base_url already contains /v1 to avoid double /v1/v1
    let chat_url = if base_url.ends_with("/v1") {
        format!("{}/chat/completions", base_url)
    } else if is_ollama {
        format!("{}/v1/chat/completions", base_url)
    } else {
        format!("{}/chat/completions", base_url)
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.post(&chat_url).json(&body);
    if let Some(ref api_key) = config.api_key {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    }

    let resp = request.send().await.map_err(|e| {
        let _ = window.emit("llm-stream", LLMStreamEvent {
            stream_id: stream_id.clone(),
            event_type: "error".to_string(),
            content: format!("Request error: {}", e),
        });
        format!("Request error: {}", e)
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let error_msg = format!("LLM HTTP error {}: {}", status, body);
        let _ = window.emit("llm-stream", LLMStreamEvent {
            stream_id: stream_id.clone(),
            event_type: "error".to_string(),
            content: error_msg.clone(),
        });
        return Err(error_msg);
    }

    let mut full_response = String::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                let chunk_str = String::from_utf8_lossy(&chunk);

                // Parse SSE format: data: {...}\n\n
                for line in chunk_str.lines() {
                    if line.starts_with("data: ") {
                        let data = &line[6..];
                        if data == "[DONE]" {
                            continue;
                        }

                        if let Ok(parsed) = serde_json::from_str::<StreamChunk>(data) {
                            if let Some(choice) = parsed.choices.first() {
                                if let Some(content) = &choice.delta.content {
                                    full_response.push_str(content);

                                    // Emit chunk event
                                    let _ = window.emit("llm-stream", LLMStreamEvent {
                                        stream_id: stream_id.clone(),
                                        event_type: "chunk".to_string(),
                                        content: content.clone(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = window.emit("llm-stream", LLMStreamEvent {
                    stream_id: stream_id.clone(),
                    event_type: "error".to_string(),
                    content: format!("Stream error: {}", e),
                });
                return Err(format!("Stream error: {}", e));
            }
        }
    }

    // Emit done event
    let _ = window.emit("llm-stream", LLMStreamEvent {
        stream_id: stream_id.clone(),
        event_type: "done".to_string(),
        content: "".to_string(),
    });

    Ok(full_response)
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
                available_models: available_models.clone(),
                error: if model_available { 
                    None 
                } else { 
                    // List available models to help user debug
                    let models_list = available_models.join(", ");
                    Some(format!("Model '{}' not found. Available models: [{}]", config.model, models_list))
                },
            })
        }
        Ok(resp) if resp.status().as_u16() == 404 => {
             Ok(LLMStatus {
                connected: false,
                provider: "Ollama".to_string(),
                model: config.model.clone(),
                available_models: vec![],
                // Specific help for 404s (common with OpenAI/vLLM endpoints confused for Ollama)
                error: Some("Endpoint not found (404). If this is an OpenAI-compatible server (like vLLM), please switch Provider to 'OpenAI'.".to_string()),
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
                "Ollama is not running. Check connection or URL.".to_string()
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

    // Determine if JSON mode should be enabled BEFORE consuming strings
    // Enable JSON mode when the system prompt mentions JSON output
    let use_json_mode = sys.to_lowercase().contains("json") ||
                        sys.contains("JSON") ||
                        prompt.to_lowercase().contains("respond with") && prompt.to_lowercase().contains("json");

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

    let is_ollama = config.base_url.contains("ollama") ||
                    config.base_url.contains("11434") ||
                    matches!(config.provider, LLMProvider::Ollama);

    let body = ChatRequest {
        model: config.model.clone(),
        messages,
        max_tokens: Some(config.max_tokens),
        temperature: Some(config.temperature),
        stream: None,
        // Ollama uses "format": "json"
        format: if is_ollama && use_json_mode { Some("json".to_string()) } else { None },
        // OpenAI uses "response_format": {"type": "json_object"}
        response_format: if !is_ollama && use_json_mode {
            Some(ResponseFormat { format_type: "json_object".to_string() })
        } else {
            None
        },
    };

    let base_url = config.base_url.trim_end_matches('/');
    // Check if base_url already contains /v1 to avoid double /v1/v1
    let chat_url = if base_url.ends_with("/v1") {
        format!("{}/chat/completions", base_url)
    } else if is_ollama {
        format!("{}/v1/chat/completions", base_url)
    } else {
        format!("{}/chat/completions", base_url)
    };

    // Increased timeout for large models (70B can take 2-3 minutes)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
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
            executor_model: Some("gpt-4o-mini".to_string()),
            embedding_model: Some("text-embedding-3-small".to_string()),
            embedding_endpoint: Some(DEFAULT_OPENAI_URL.to_string()),
            temperature: 0.2,
            max_tokens: 2048,
        },
        "anthropic" => LLMConfig {
            provider: LLMProvider::Anthropic,
            api_key: None,
            base_url: DEFAULT_ANTHROPIC_URL.to_string(),
            model: "claude-3-5-sonnet-20241022".to_string(),
            executor_model: None,
            embedding_model: None,
            embedding_endpoint: None,
            temperature: 0.2,
            max_tokens: 2048,
        },
        "custom" => LLMConfig {
            provider: LLMProvider::Custom,
            api_key: None,
            base_url: "http://localhost:1234/v1".to_string(),
            model: "local-model".to_string(),
            executor_model: None,
            embedding_model: Some("nomic-embed-text".to_string()),
            embedding_endpoint: Some("http://localhost:11434".to_string()),
            temperature: 0.2,
            max_tokens: 2048,
        },
        _ => LLMConfig::default(), // Ollama
    }
}

/// Analyze text using the configured LLM
#[tauri::command]
pub async fn analyze_text(text: String, context: String) -> Result<String, String> {
    // Try to load persisted config, fallback to default
    let mut config = LLMConfig::default();
    
    if let Some(config_dir) = dirs::config_dir() {
        let config_path = config_dir.join("lens-killer").join("llm-config.json");
        if config_path.exists() {
             if let Ok(content) = std::fs::read_to_string(config_path) {
                 if let Ok(loaded) = serde_json::from_str::<LLMConfig>(&content) {
                     config = loaded;
                 }
             }
        }
    }

    let system_prompt = format!("You are a Kubernetes expert. Analyze the provided text. Context: {}. Be concise, highlight errors, and suggest fixes.", context);
    call_llm(config, text, Some(system_prompt), vec![]).await
}

// ============================================================================
// Web Search for Investigation
// ============================================================================

#[derive(Serialize, Deserialize)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Perform a web search using DuckDuckGo Instant Answers API
/// This is a free, no-API-key-required search that returns relevant results
#[tauri::command]
pub async fn web_search(query: String) -> Result<Vec<WebSearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("OpsPilot/1.0 (Kubernetes Debugger)")
        .build()
        .map_err(|e| e.to_string())?;

    // Use DuckDuckGo Instant Answers API (no API key needed, returns JSON)
    // Adding "kubernetes" to narrow results to relevant content
    let search_query = if query.to_lowercase().contains("kubernetes") || query.to_lowercase().contains("k8s") {
        query.clone()
    } else {
        format!("kubernetes {}", query)
    };

    let encoded_query = urlencoding::encode(&search_query);
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        encoded_query
    );

    let resp = client.get(&url).send().await.map_err(|e| format!("Search request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Search API returned status: {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    let mut results: Vec<WebSearchResult> = Vec::new();

    // Parse DuckDuckGo response format
    // AbstractText/AbstractURL for main result
    if let Some(abstract_text) = body.get("AbstractText").and_then(|v| v.as_str()) {
        if !abstract_text.is_empty() {
            let abstract_url = body.get("AbstractURL").and_then(|v| v.as_str()).unwrap_or("");
            let abstract_source = body.get("AbstractSource").and_then(|v| v.as_str()).unwrap_or("DuckDuckGo");
            results.push(WebSearchResult {
                title: format!("{} (Abstract)", abstract_source),
                url: abstract_url.to_string(),
                snippet: abstract_text.to_string(),
            });
        }
    }

    // RelatedTopics for additional results
    if let Some(related) = body.get("RelatedTopics").and_then(|v| v.as_array()) {
        for topic in related.iter().take(5) {
            if let (Some(text), Some(first_url)) = (
                topic.get("Text").and_then(|v| v.as_str()),
                topic.get("FirstURL").and_then(|v| v.as_str()),
            ) {
                results.push(WebSearchResult {
                    title: text.chars().take(80).collect::<String>() + if text.len() > 80 { "..." } else { "" },
                    url: first_url.to_string(),
                    snippet: text.to_string(),
                });
            }
            // Handle nested topics (categories)
            if let Some(topics) = topic.get("Topics").and_then(|v| v.as_array()) {
                for sub_topic in topics.iter().take(2) {
                    if let (Some(text), Some(first_url)) = (
                        sub_topic.get("Text").and_then(|v| v.as_str()),
                        sub_topic.get("FirstURL").and_then(|v| v.as_str()),
                    ) {
                        results.push(WebSearchResult {
                            title: text.chars().take(80).collect::<String>() + if text.len() > 80 { "..." } else { "" },
                            url: first_url.to_string(),
                            snippet: text.to_string(),
                        });
                    }
                }
            }
        }
    }

    // If DuckDuckGo returns nothing useful, return a helpful message with fallback URLs
    if results.is_empty() {
        results.push(WebSearchResult {
            title: "Search Kubernetes Docs".to_string(),
            url: format!("https://kubernetes.io/docs/search/?q={}", encoded_query),
            snippet: "No instant answers found. Click to search Kubernetes documentation.".to_string(),
        });
        results.push(WebSearchResult {
            title: "Search Stack Overflow".to_string(),
            url: format!("https://stackoverflow.com/search?q={}", encoded_query),
            snippet: "Search Stack Overflow for community solutions.".to_string(),
        });
    }

    Ok(results)
}

// ============================================================================
// AI-Powered Command Generation
// ============================================================================

const COMMAND_GEN_SYSTEM_PROMPT: &str = r#"You are a Kubernetes expert assistant that generates investigation commands.

Given a problem context, generate 3-6 specific kubectl commands that would help investigate the issue.

OUTPUT FORMAT (STRICT):
Return ONLY a JSON array of strings. Each string should be in the format:
"Title | kubectl command | Purpose"

Example output:
["Check Failing Pods | kubectl get pods -A --field-selector=status.phase!=Running | Find all non-running pods", "Recent Events | kubectl get events -A --sort-by=.lastTimestamp | tail -30 | See recent cluster events", "Node Resources | kubectl top nodes | Check node resource pressure"]

RULES:
1. Commands must be READ-ONLY (get, describe, logs, top, events - NO apply, delete, patch, edit)
2. Use actual kubectl syntax with proper flags
3. Prefer commands with filtering (--field-selector, grep, jq) for targeted results
4. Include namespace flags (-n or -A) as appropriate
5. Each command should serve a distinct diagnostic purpose
6. Commands can use bash pipes (|) for filtering (grep, awk, jq, head, tail, sort)

DO NOT include any explanation, just the JSON array."#;

/// Generate investigation commands using LLM
#[tauri::command]
pub async fn generate_investigation_commands(context: String) -> Result<Vec<String>, String> {
    // Load LLM config
    let config = LLMConfig::default();

    // Check if LLM is available
    let status = check_llm_status(config.clone()).await?;
    if !status.connected {
        return Err("LLM not available for command generation".to_string());
    }

    let prompt = format!(
        "Generate kubectl investigation commands for this issue:\n\n{}\n\nReturn ONLY a JSON array of command strings.",
        context
    );

    // Call LLM
    let response = call_llm(
        config,
        prompt,
        Some(COMMAND_GEN_SYSTEM_PROMPT.to_string()),
        vec![],
    ).await?;

    // Parse JSON response
    let cleaned = response.trim();

    // Try to extract JSON array from response
    let json_str = if cleaned.starts_with('[') {
        cleaned.to_string()
    } else if let Some(start) = cleaned.find('[') {
        if let Some(end) = cleaned.rfind(']') {
            cleaned[start..=end].to_string()
        } else {
            return Err("Invalid response format: no closing bracket".to_string());
        }
    } else {
        return Err("Invalid response format: no JSON array found".to_string());
    };

    // Parse as JSON array
    let commands: Vec<String> = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse commands: {}", e))?;

    // Validate commands are read-only
    let safe_commands: Vec<String> = commands
        .into_iter()
        .filter(|cmd| {
            let lower = cmd.to_lowercase();
            // Block mutating commands
            !lower.contains("apply") &&
            !lower.contains("delete") &&
            !lower.contains("patch") &&
            !lower.contains("edit") &&
            !lower.contains("scale") &&
            !lower.contains("create") &&
            !lower.contains("replace") &&
            !lower.contains("drain") &&
            !lower.contains("cordon") &&
            !lower.contains("taint")
        })
        .take(6)
        .collect();

    Ok(safe_commands)
}
