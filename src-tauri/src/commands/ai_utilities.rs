/**
 * AI Utilities - Backend support for AI-driven agent features
 *
 * Provides Tauri commands for:
 * - LLM configuration management
 * - Calling LLM endpoints
 * - Storing/retrieving investigation patterns
 */

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;

// =============================================================================
// TYPES
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMConfig {
    pub provider: String,
    pub api_key: Option<String>,
    pub base_url: String,
    pub model: String,
    pub executor_model: Option<String>,
    pub temperature: f32,
    pub max_tokens: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InvestigationPattern {
    pub timestamp: String,
    pub cluster_type: String,
    pub investigation_goal: String,
    pub successful_path: Vec<ToolStep>,
    pub solution: String,
    pub pattern_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStep {
    pub tool: String,
    pub args: Option<String>,
    pub outcome: String,
    pub useful: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SimilarInvestigation {
    pub similarity_score: f32,
    pub tool_sequence: Vec<String>,
    pub solution: String,
}

// =============================================================================
// LLM CONFIGURATION MANAGEMENT
// =============================================================================

fn get_config_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("lens-killer");
    path.push("llm-config.json");
    path
}

/// Load LLM configuration from disk
#[tauri::command]
pub async fn load_llm_config() -> Result<Option<LLMConfig>, String> {
    let config_path = get_config_path();

    if !config_path.exists() {
        return Ok(None);
    }

    match fs::read_to_string(&config_path).await {
        Ok(content) => {
            let config: LLMConfig = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            Ok(Some(config))
        }
        Err(e) => {
            eprintln!("Failed to read config file: {}", e);
            Ok(None)
        }
    }
}

/// Save LLM configuration to disk
#[tauri::command]
pub async fn save_llm_config(config: LLMConfig) -> Result<(), String> {
    let config_path = get_config_path();

    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&config_path, json)
        .await
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

// =============================================================================
// LLM CALLING
// =============================================================================


// =============================================================================
// INVESTIGATION PATTERN STORAGE
// =============================================================================

fn get_patterns_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("lens-killer");
    path.push("investigation-patterns.jsonl");
    path
}

/// Store a successful investigation pattern for learning
#[tauri::command]
pub async fn store_investigation_pattern(pattern: InvestigationPattern) -> Result<(), String> {
    let patterns_path = get_patterns_path();

    // Ensure parent directory exists
    if let Some(parent) = patterns_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create patterns dir: {}", e))?;
    }

    // Append as JSONL (one JSON object per line)
    let json_line = serde_json::to_string(&pattern)
        .map_err(|e| format!("Failed to serialize pattern: {}", e))?;

    let mut content = if patterns_path.exists() {
        fs::read_to_string(&patterns_path).await.unwrap_or_default()
    } else {
        String::new()
    };

    content.push_str(&json_line);
    content.push('\n');

    fs::write(&patterns_path, content)
        .await
        .map_err(|e| format!("Failed to write patterns: {}", e))?;

    Ok(())
}

/// Find similar investigations based on goal and cluster type
#[tauri::command]
pub async fn find_similar_investigations(
    goal: String,
    cluster_type: String,
    limit: usize,
) -> Result<Vec<SimilarInvestigation>, String> {
    let patterns_path = get_patterns_path();

    if !patterns_path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&patterns_path)
        .await
        .map_err(|e| format!("Failed to read patterns: {}", e))?;

    let mut results: Vec<SimilarInvestigation> = Vec::new();

    // Parse each line as a pattern
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(pattern) = serde_json::from_str::<InvestigationPattern>(line) {
            // Simple similarity: check if goals/cluster types match
            let mut score = 0.0;

            if pattern.cluster_type == cluster_type {
                score += 0.5;
            }

            // Check keyword overlap in goals
            let goal_lower = goal.to_lowercase();
            let pattern_goal_lower = pattern.investigation_goal.to_lowercase();

            for word in goal_lower.split_whitespace() {
                if pattern_goal_lower.contains(word) {
                    score += 0.1;
                }
            }

            if score > 0.3 {
                results.push(SimilarInvestigation {
                    similarity_score: score,
                    tool_sequence: pattern
                        .successful_path
                        .iter()
                        .map(|step| format!("{} {}", step.tool, step.args.as_deref().unwrap_or("")))
                        .collect(),
                    solution: pattern.solution,
                });
            }
        }
    }

    // Sort by similarity score
    results.sort_by(|a, b| b.similarity_score.partial_cmp(&a.similarity_score).unwrap());

    // Return top N
    Ok(results.into_iter().take(limit).collect())
}
