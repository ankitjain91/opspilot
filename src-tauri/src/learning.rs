//! Learning module for investigation outcomes
//!
//! Stores investigation outcomes with embeddings for semantic retrieval.
//! Enables pattern learning and auto-playbook generation from successful investigations.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::path::PathBuf;
use std::fs;
use tauri::Manager;
use crate::embeddings;

// =============================================================================
// DATA STRUCTURES
// =============================================================================

/// Tool execution record within an investigation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRecord {
    pub tool: String,
    pub args: Option<String>,
    pub status: String,  // "success", "error", "empty"
    pub useful: bool,
    pub duration_ms: u64,
}

/// Investigation outcome stored for learning
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestigationOutcome {
    pub id: String,
    pub timestamp: i64,
    pub question: String,
    pub question_embedding: Vec<f32>,
    pub tools_used: Vec<ToolRecord>,
    pub resolution: ResolutionType,
    pub root_cause: Option<String>,
    pub confidence_score: f32,
    pub duration_ms: u64,
    pub hypotheses_confirmed: Vec<String>,
    pub hypotheses_refuted: Vec<String>,
}

/// Resolution type for an investigation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ResolutionType {
    Solved,       // High confidence, root cause identified
    Partial,      // Medium confidence, some findings
    Inconclusive, // Low confidence, no clear answer
    UserAborted,  // User cancelled the investigation
}

/// Learned pattern from multiple similar investigations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedPattern {
    pub id: String,
    pub question_pattern: String,  // Representative question
    pub common_tools: Vec<String>,  // Tools that consistently help
    pub success_rate: f32,
    pub avg_confidence: f32,
    pub occurrence_count: usize,
    pub embedding: Vec<f32>,  // Average embedding of similar questions
}

/// Container for all learning data
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LearningData {
    pub outcomes: Vec<InvestigationOutcome>,
    pub patterns: Vec<LearnedPattern>,
    pub version: String,
}

// Global learning data cache
static LEARNING_DATA: Mutex<Option<LearningData>> = Mutex::new(None);

// =============================================================================
// PERSISTENCE
// =============================================================================

/// Get the path to the learning data file
fn get_learning_data_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure directory exists
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("learning_data.json"))
}

/// Load learning data from disk
pub fn load_learning_data(app_handle: &tauri::AppHandle) -> Result<LearningData, String> {
    // Check cache first
    if let Ok(cache) = LEARNING_DATA.lock() {
        if let Some(ref data) = *cache {
            return Ok(data.clone());
        }
    }

    let path = get_learning_data_path(app_handle)?;

    if !path.exists() {
        // Return empty data if file doesn't exist
        let data = LearningData {
            outcomes: Vec::new(),
            patterns: Vec::new(),
            version: "1.0".to_string(),
        };
        return Ok(data);
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read learning data: {}", e))?;

    let data: LearningData = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse learning data: {}", e))?;

    // Cache the loaded data
    if let Ok(mut cache) = LEARNING_DATA.lock() {
        *cache = Some(data.clone());
    }

    Ok(data)
}

/// Save learning data to disk
pub fn save_learning_data(app_handle: &tauri::AppHandle, data: &LearningData) -> Result<(), String> {
    let path = get_learning_data_path(app_handle)?;

    let content = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to serialize learning data: {}", e))?;

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write learning data: {}", e))?;

    // Update cache
    if let Ok(mut cache) = LEARNING_DATA.lock() {
        *cache = Some(data.clone());
    }

    Ok(())
}

// =============================================================================
// LEARNING OPERATIONS
// =============================================================================

/// Record a completed investigation outcome
#[tauri::command]
pub async fn record_investigation_outcome(
    question: String,
    tools_used: Vec<ToolRecord>,
    resolution: String,
    root_cause: Option<String>,
    confidence_score: f32,
    duration_ms: u64,
    hypotheses_confirmed: Vec<String>,
    hypotheses_refuted: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // Generate embedding for the question
    let question_embedding = match embeddings::embed_query(&question) {
        Ok(emb) => emb,
        Err(e) => {
            eprintln!("[Learning] Failed to embed question: {}, using empty", e);
            Vec::new()
        }
    };

    let resolution_type = match resolution.to_lowercase().as_str() {
        "solved" => ResolutionType::Solved,
        "partial" => ResolutionType::Partial,
        "aborted" => ResolutionType::UserAborted,
        _ => ResolutionType::Inconclusive,
    };

    let outcome = InvestigationOutcome {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now().timestamp(),
        question,
        question_embedding,
        tools_used,
        resolution: resolution_type,
        root_cause,
        confidence_score,
        duration_ms,
        hypotheses_confirmed,
        hypotheses_refuted,
    };

    // Load existing data
    let mut data = load_learning_data(&app_handle)?;

    let outcome_id = outcome.id.clone();
    data.outcomes.push(outcome);

    // Limit to last 500 outcomes to prevent unbounded growth
    if data.outcomes.len() > 500 {
        data.outcomes = data.outcomes.split_off(data.outcomes.len() - 500);
    }

    // Save updated data
    save_learning_data(&app_handle, &data)?;

    // Try to detect patterns after saving
    let _ = detect_and_save_patterns(&app_handle).await;

    Ok(outcome_id)
}

/// Find similar past investigations using semantic search
#[tauri::command]
pub async fn find_similar_investigations(
    question: String,
    top_k: usize,
    app_handle: tauri::AppHandle,
) -> Result<Vec<SimilarInvestigation>, String> {
    let query_embedding = embeddings::embed_query(&question)?;
    let data = load_learning_data(&app_handle)?;

    let mut results: Vec<SimilarInvestigation> = data.outcomes
        .iter()
        .filter(|o| !o.question_embedding.is_empty())
        .map(|outcome| {
            let similarity = embeddings::cosine_similarity(&query_embedding, &outcome.question_embedding);
            SimilarInvestigation {
                id: outcome.id.clone(),
                question: outcome.question.clone(),
                similarity,
                resolution: format!("{:?}", outcome.resolution),
                root_cause: outcome.root_cause.clone(),
                tools_used: outcome.tools_used.iter().map(|t| t.tool.clone()).collect(),
                confidence_score: outcome.confidence_score,
            }
        })
        .collect();

    // Sort by similarity descending
    results.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);

    // Only return results with meaningful similarity (>0.5)
    results.retain(|r| r.similarity > 0.5);

    Ok(results)
}

/// Result from finding similar investigations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimilarInvestigation {
    pub id: String,
    pub question: String,
    pub similarity: f32,
    pub resolution: String,
    pub root_cause: Option<String>,
    pub tools_used: Vec<String>,
    pub confidence_score: f32,
}

/// Get tool recommendations based on past successful investigations
#[tauri::command]
pub async fn get_learned_tool_recommendations(
    question: String,
    app_handle: tauri::AppHandle,
) -> Result<Vec<LearnedToolRecommendation>, String> {
    let query_embedding = embeddings::embed_query(&question)?;
    let data = load_learning_data(&app_handle)?;

    // Find similar successful investigations
    let similar_successful: Vec<_> = data.outcomes
        .iter()
        .filter(|o| {
            !o.question_embedding.is_empty() &&
            o.resolution == ResolutionType::Solved &&
            o.confidence_score >= 55.0
        })
        .map(|o| {
            let sim = embeddings::cosine_similarity(&query_embedding, &o.question_embedding);
            (o, sim)
        })
        .filter(|(_, sim)| *sim > 0.6)
        .collect();

    // Count tool occurrences weighted by similarity
    let mut tool_scores: std::collections::HashMap<String, (f32, usize)> = std::collections::HashMap::new();

    for (outcome, similarity) in &similar_successful {
        for tool in &outcome.tools_used {
            if tool.useful {
                let entry = tool_scores.entry(tool.tool.clone()).or_insert((0.0, 0));
                entry.0 += similarity;
                entry.1 += 1;
            }
        }
    }

    // Convert to recommendations
    let mut recommendations: Vec<LearnedToolRecommendation> = tool_scores
        .into_iter()
        .map(|(tool, (score_sum, count))| LearnedToolRecommendation {
            tool,
            confidence: score_sum / count as f32,
            occurrence_count: count,
            source: "past_investigations".to_string(),
        })
        .collect();

    recommendations.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    recommendations.truncate(5);

    Ok(recommendations)
}

/// Learned tool recommendation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedToolRecommendation {
    pub tool: String,
    pub confidence: f32,
    pub occurrence_count: usize,
    pub source: String,
}

// =============================================================================
// PATTERN DETECTION
// =============================================================================

/// Detect patterns from investigation outcomes and save
async fn detect_and_save_patterns(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let mut data = load_learning_data(app_handle)?;

    // Need at least 5 outcomes to detect patterns
    if data.outcomes.len() < 5 {
        return Ok(());
    }

    // Group similar questions using embeddings
    let successful_outcomes: Vec<_> = data.outcomes
        .iter()
        .filter(|o| {
            !o.question_embedding.is_empty() &&
            o.resolution == ResolutionType::Solved
        })
        .collect();

    if successful_outcomes.len() < 3 {
        return Ok(());
    }

    // Simple clustering: find questions with >0.75 similarity
    let mut clusters: Vec<Vec<&InvestigationOutcome>> = Vec::new();
    let mut assigned: std::collections::HashSet<String> = std::collections::HashSet::new();

    for outcome in &successful_outcomes {
        if assigned.contains(&outcome.id) {
            continue;
        }

        let mut cluster = vec![*outcome];
        assigned.insert(outcome.id.clone());

        for other in &successful_outcomes {
            if assigned.contains(&other.id) {
                continue;
            }

            let sim = embeddings::cosine_similarity(&outcome.question_embedding, &other.question_embedding);
            if sim > 0.75 {
                cluster.push(*other);
                assigned.insert(other.id.clone());
            }
        }

        if cluster.len() >= 3 {
            clusters.push(cluster);
        }
    }

    // Convert clusters to patterns
    let mut new_patterns = Vec::new();

    for cluster in clusters {
        // Find common tools (appear in >50% of cluster)
        let mut tool_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut total_confidence = 0.0;

        for outcome in &cluster {
            for tool in &outcome.tools_used {
                if tool.useful {
                    *tool_counts.entry(tool.tool.clone()).or_insert(0) += 1;
                }
            }
            total_confidence += outcome.confidence_score;
        }

        let threshold = cluster.len() / 2;
        let common_tools: Vec<String> = tool_counts
            .into_iter()
            .filter(|(_, count)| *count > threshold)
            .map(|(tool, _)| tool)
            .collect();

        if common_tools.is_empty() {
            continue;
        }

        // Average embedding for the cluster
        let dim = cluster[0].question_embedding.len();
        let mut avg_embedding = vec![0.0f32; dim];
        for outcome in &cluster {
            for (i, val) in outcome.question_embedding.iter().enumerate() {
                avg_embedding[i] += val;
            }
        }
        for val in &mut avg_embedding {
            *val /= cluster.len() as f32;
        }

        // Use the shortest question as representative
        let representative = cluster.iter()
            .min_by_key(|o| o.question.len())
            .map(|o| o.question.clone())
            .unwrap_or_default();

        new_patterns.push(LearnedPattern {
            id: uuid::Uuid::new_v4().to_string(),
            question_pattern: representative,
            common_tools,
            success_rate: 1.0,  // All outcomes in cluster were successful
            avg_confidence: total_confidence / cluster.len() as f32,
            occurrence_count: cluster.len(),
            embedding: avg_embedding,
        });
    }

    // Update patterns (merge with existing or replace)
    data.patterns = new_patterns;
    save_learning_data(app_handle, &data)?;

    Ok(())
}

/// Get learned patterns for a query
#[tauri::command]
pub async fn get_learned_patterns(
    question: String,
    app_handle: tauri::AppHandle,
) -> Result<Vec<LearnedPattern>, String> {
    let query_embedding = embeddings::embed_query(&question)?;
    let data = load_learning_data(&app_handle)?;

    let mut results: Vec<(LearnedPattern, f32)> = data.patterns
        .iter()
        .filter(|p| !p.embedding.is_empty())
        .map(|p| {
            let sim = embeddings::cosine_similarity(&query_embedding, &p.embedding);
            (p.clone(), sim)
        })
        .filter(|(_, sim)| *sim > 0.6)
        .collect();

    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    Ok(results.into_iter().map(|(p, _)| p).take(3).collect())
}

/// Get learning statistics
#[tauri::command]
pub async fn get_learning_stats(
    app_handle: tauri::AppHandle,
) -> Result<LearningStats, String> {
    let data = load_learning_data(&app_handle)?;

    let solved = data.outcomes.iter().filter(|o| o.resolution == ResolutionType::Solved).count();
    let partial = data.outcomes.iter().filter(|o| o.resolution == ResolutionType::Partial).count();

    let avg_confidence = if !data.outcomes.is_empty() {
        data.outcomes.iter().map(|o| o.confidence_score).sum::<f32>() / data.outcomes.len() as f32
    } else {
        0.0
    };

    // Most used tools
    let mut tool_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for outcome in &data.outcomes {
        for tool in &outcome.tools_used {
            *tool_counts.entry(tool.tool.clone()).or_insert(0) += 1;
        }
    }
    let mut top_tools: Vec<_> = tool_counts.into_iter().collect();
    top_tools.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    top_tools.truncate(5);

    Ok(LearningStats {
        total_investigations: data.outcomes.len(),
        solved_count: solved,
        partial_count: partial,
        pattern_count: data.patterns.len(),
        avg_confidence,
        top_tools: top_tools.into_iter().map(|(tool, count)| (tool, count)).collect(),
    })
}

/// Learning statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningStats {
    pub total_investigations: usize,
    pub solved_count: usize,
    pub partial_count: usize,
    pub pattern_count: usize,
    pub avg_confidence: f32,
    pub top_tools: Vec<(String, usize)>,
}
