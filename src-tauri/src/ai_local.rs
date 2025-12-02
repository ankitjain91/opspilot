use serde::{Deserialize, Serialize};


const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434/v1";

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
