//! Embedding-based semantic search module
//! 
//! Uses pre-computed embeddings for KB documents and fastembed for runtime query embedding.
//! Model downloads automatically on first use (~25MB) and is cached locally.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Manager;
use fastembed::{TextEmbedding, InitOptions, EmbeddingModel};

/// Pre-computed embedding for a document
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DocEmbedding {
    pub id: String,
    pub file: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,  // Clean summary for display
    pub embedding: Vec<f32>,
}

/// Pre-computed embedding for a tool
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolEmbedding {
    pub name: String,
    pub description: String,
    pub embedding: Vec<f32>,
}

/// Container for all pre-computed embeddings
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EmbeddingsData {
    pub model: String,
    pub dimension: usize,
    pub documents: Vec<DocEmbedding>,
    pub tools: Vec<ToolEmbedding>,
}

/// Global embeddings cache  
static EMBEDDINGS_CACHE: Mutex<Option<EmbeddingsData>> = Mutex::new(None);

/// Global TextEmbedding model cache (loads once, reused)
static TEXT_EMBEDDING_MODEL: Mutex<Option<TextEmbedding>> = Mutex::new(None);

/// Load pre-computed embeddings from bundled resources
pub fn load_embeddings(app_handle: &tauri::AppHandle) -> Result<EmbeddingsData, String> {
    // Check cache first
    if let Ok(cache) = EMBEDDINGS_CACHE.lock() {
        if let Some(ref data) = *cache {
            return Ok(data.clone());
        }
    }
    
    let resource_path = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let embeddings_path = resource_path.join("kb_embeddings.json");
    
    // Multiple fallback paths for development and production
    let cwd = std::env::current_dir().unwrap_or_default();
    let search_paths = vec![
        embeddings_path.clone(),
        cwd.join("src-tauri/resources/kb_embeddings.json"),
        cwd.join("resources/kb_embeddings.json"),
        // Parent dir (when running from src-tauri)
        cwd.parent().map(|p| p.join("src-tauri/resources/kb_embeddings.json")).unwrap_or_default(),
        // Absolute path as last resort
        std::path::PathBuf::from("/Users/ankitjain/lens-killer/src-tauri/resources/kb_embeddings.json"),
    ];
    
    eprintln!("[DEBUG] CWD: {:?}", cwd);
    let mut found_path = None;
    for path in &search_paths {
        eprintln!("[DEBUG] Checking embeddings path: {:?} exists={}", path, path.exists());
        if path.exists() {
            found_path = Some(path.clone());
            break;
        }
    }
    
    let path = found_path.ok_or("kb_embeddings.json not found")?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read embeddings: {}", e))?;
    let data: EmbeddingsData = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse embeddings: {}", e))?;
    
    // Cache the loaded data
    if let Ok(mut cache) = EMBEDDINGS_CACHE.lock() {
        *cache = Some(data.clone());
    }
    
    Ok(data)
}

/// Initialize the fastembed model (downloads on first use, ~25MB)
fn get_or_init_embedding_model() -> Result<(), String> {
    let mut model_guard = TEXT_EMBEDDING_MODEL.lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    
    if model_guard.is_none() {
        // Initialize with all-MiniLM-L6-v2 (same as the Python script uses)
        let options = InitOptions::new(EmbeddingModel::AllMiniLML6V2)
            .with_show_download_progress(true);
        
        let model = TextEmbedding::try_new(options)
            .map_err(|e| format!("Failed to load embedding model: {}", e))?;
        
        *model_guard = Some(model);
    }
    
    Ok(())
}

/// Get embedding for a query using fastembed (local ONNX inference)
pub fn embed_query(query: &str) -> Result<Vec<f32>, String> {
    // Ensure model is loaded
    get_or_init_embedding_model()?;
    
    let model_guard = TEXT_EMBEDDING_MODEL.lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    
    let model = model_guard.as_ref()
        .ok_or("Embedding model not initialized")?;
    
    // fastembed expects a Vec of documents
    let documents = vec![query];
    let embeddings = model.embed(documents, None)
        .map_err(|e| format!("Embedding failed: {}", e))?;
    
    embeddings.into_iter().next()
        .ok_or_else(|| "No embedding generated".to_string())
}

/// Compute cosine similarity between two vectors
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let mag_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let mag_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    
    if mag_a == 0.0 || mag_b == 0.0 {
        return 0.0;
    }
    
    dot / (mag_a * mag_b)
}

/// Result from semantic search
#[derive(Debug, Clone, Serialize)]
pub struct SemanticSearchResult {
    pub id: String,
    pub file: String,
    pub title: String,
    pub summary: String,
    pub score: f32,
}

/// Search documents by semantic similarity
pub fn search_documents(query_embedding: &[f32], embeddings: &EmbeddingsData, top_k: usize) -> Vec<SemanticSearchResult> {
    let mut results: Vec<_> = embeddings.documents
        .iter()
        .map(|doc| SemanticSearchResult {
            id: doc.id.clone(),
            file: doc.file.clone(),
            title: doc.title.clone(),
            summary: doc.summary.clone(),
            score: cosine_similarity(query_embedding, &doc.embedding),
        })
        .collect();
    
    // Sort by score descending
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);
    results
}

/// Tool suggestion from semantic search
#[derive(Debug, Clone, Serialize)]
pub struct ToolSuggestion {
    pub name: String,
    pub description: String,
    pub confidence: f32,
}

/// Suggest tools based on query semantic similarity
pub fn suggest_tools(query_embedding: &[f32], embeddings: &EmbeddingsData, top_k: usize) -> Vec<ToolSuggestion> {
    let mut results: Vec<_> = embeddings.tools
        .iter()
        .map(|tool| ToolSuggestion {
            name: tool.name.clone(),
            description: tool.description.clone(),
            confidence: cosine_similarity(query_embedding, &tool.embedding),
        })
        .collect();
    
    // Sort by confidence descending
    results.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);
    results
}

// ============================================================================
// Tauri Commands for Embedding Model Status
// ============================================================================

/// Status of the embedding model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingModelStatus {
    pub available: bool,
    pub model_name: String,
    pub ready: bool,
    pub error: Option<String>,
}

/// Check if the embedding model is ready (loads it if not)
#[tauri::command]
pub async fn check_embedding_model_status() -> Result<EmbeddingModelStatus, String> {
    match get_or_init_embedding_model() {
        Ok(_) => Ok(EmbeddingModelStatus {
            available: true,
            model_name: "all-MiniLM-L6-v2".to_string(),
            ready: true,
            error: None,
        }),
        Err(e) => Ok(EmbeddingModelStatus {
            available: false,
            model_name: "all-MiniLM-L6-v2".to_string(),
            ready: false,
            error: Some(e),
        }),
    }
}

/// Initialize the embedding model (call this on app startup)
#[tauri::command]
pub async fn init_embedding_model(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    
    // Emit starting event
    let _ = app_handle.emit("embedding-model-status", serde_json::json!({
        "status": "loading",
        "message": "Loading embedding model..."
    }));
    
    match get_or_init_embedding_model() {
        Ok(_) => {
            let _ = app_handle.emit("embedding-model-status", serde_json::json!({
                "status": "ready",
                "message": "Embedding model ready"
            }));
            Ok(())
        },
        Err(e) => {
            let _ = app_handle.emit("embedding-model-status", serde_json::json!({
                "status": "error",
                "message": format!("Failed to load model: {}", e)
            }));
            Err(e)
        }
    }
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity_identical() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 0.0001, "Identical vectors should have similarity 1.0");
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 0.0001, "Orthogonal vectors should have similarity 0.0");
    }

    #[test]
    fn test_cosine_similarity_opposite() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![-1.0, 0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - (-1.0)).abs() < 0.0001, "Opposite vectors should have similarity -1.0");
    }

    #[test]
    fn test_cosine_similarity_empty() {
        let a: Vec<f32> = vec![];
        let b: Vec<f32> = vec![];
        let sim = cosine_similarity(&a, &b);
        assert_eq!(sim, 0.0, "Empty vectors should have similarity 0.0");
    }

    #[test]
    fn test_search_documents_ranking() {
        let embeddings = EmbeddingsData {
            model: "test".to_string(),
            dimension: 3,
            documents: vec![
                DocEmbedding {
                    id: "doc1".to_string(),
                    file: "doc1.json".to_string(),
                    title: "CrashLoopBackOff".to_string(),
                    summary: "Pod keeps crashing in a loop".to_string(),
                    embedding: vec![1.0, 0.0, 0.0],
                },
                DocEmbedding {
                    id: "doc2".to_string(),
                    file: "doc2.json".to_string(),
                    title: "Networking".to_string(),
                    summary: "Network connectivity issues".to_string(),
                    embedding: vec![0.0, 1.0, 0.0],
                },
            ],
            tools: vec![],
        };

        let query = vec![0.9, 0.1, 0.0];
        let results = search_documents(&query, &embeddings, 2);

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "doc1", "Most similar doc should rank first");
        assert!(results[0].score > results[1].score);
    }

    #[test]
    fn test_suggest_tools_ranking() {
        let embeddings = EmbeddingsData {
            model: "test".to_string(),
            dimension: 3,
            documents: vec![],
            tools: vec![
                ToolEmbedding {
                    name: "GET_LOGS".to_string(),
                    description: "pod logs".to_string(),
                    embedding: vec![1.0, 0.0, 0.0],
                },
                ToolEmbedding {
                    name: "DESCRIBE".to_string(),
                    description: "describe".to_string(),
                    embedding: vec![0.0, 1.0, 0.0],
                },
            ],
        };

        let query = vec![0.95, 0.05, 0.0];
        let results = suggest_tools(&query, &embeddings, 2);

        assert_eq!(results[0].name, "GET_LOGS");
    }
}
