use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use tauri::Manager;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchResult {
    pub file: String,
    pub content: String,
    pub score: f32,
}

#[tauri::command]
pub async fn search_knowledge_base(query: String, app_handle: tauri::AppHandle) -> Result<Vec<SearchResult>, String> {
    let mut results = Vec::new();
    let query_lower = query.to_lowercase();
    let query_terms: Vec<&str> = query_lower.split_whitespace().collect();

    // Resolve the knowledge directory relative to the resource path
    // In dev, this might be just "knowledge/" in the project root
    // In prod, it should be in the resource directory
    let resource_path = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let knowledge_path = resource_path.join("knowledge");

    // Fallback for development if resource dir doesn't have it (e.g. running from source)
    let search_paths = vec![
        knowledge_path.clone(),
        std::env::current_dir().unwrap_or_default().join("knowledge"),
    ];

    let mut found_path = None;
    for path in search_paths {
        if path.exists() {
            found_path = Some(path);
            break;
        }
    }

    let search_dir = match found_path {
        Some(p) => p,
        None => return Ok(vec![]), // No knowledge base found
    };

    for entry in WalkDir::new(search_dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let ext = entry.path().extension().and_then(|e| e.to_str()).unwrap_or("");
            
            let content = if ext == "md" {
                fs::read_to_string(entry.path()).unwrap_or_default()
            } else if ext == "json" {
                let file_content = fs::read_to_string(entry.path()).unwrap_or_default();
                let json: serde_json::Value = serde_json::from_str(&file_content).unwrap_or(serde_json::Value::Null);
                extract_text_from_json(&json)
            } else {
                continue;
            };

            if content.is_empty() {
                continue;
            }

            let content_lower = content.to_lowercase();
            
            let mut score = 0.0;
            let mut _matches = 0;

            for term in &query_terms {
                if content_lower.contains(term) {
                    _matches += 1;
                    score += 1.0;
                }
            }

            // Bonus for exact phrase match
            if content_lower.contains(&query_lower) {
                score += 5.0;
            }

            if score > 0.0 {
                // Extract a snippet
                let snippet = extract_snippet(&content, &query_terms);
                
                results.push(SearchResult {
                    file: entry.file_name().to_string_lossy().to_string(),
                    content: snippet,
                    score,
                });
            }
        }
    }

    // Sort by score descending
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    
    // Return top 5
    Ok(results.into_iter().take(5).collect())
}

fn extract_snippet(content: &str, terms: &[&str]) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut best_window = String::new();
    let mut max_terms_in_window = 0;

    // Simple sliding window of 5 lines
    for i in 0..lines.len() {
        let end = std::cmp::min(i + 5, lines.len());
        let window = &lines[i..end];
        let window_text = window.join("\n");
        let window_lower = window_text.to_lowercase();

        let count = terms.iter().filter(|&&t| window_lower.contains(t)).count();
        
        if count > max_terms_in_window {
            max_terms_in_window = count;
            best_window = window_text;
        }
    }

    if best_window.is_empty() {
        // Fallback to first 5 lines if no specific window is better
        lines.into_iter().take(5).collect::<Vec<&str>>().join("\n")
    } else {
        best_window
    }
}

fn extract_text_from_json(value: &serde_json::Value) -> String {
    let mut text = String::new();
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                // Check for common content fields
                if matches!(k.as_str(), 
                    "content" | "body" | "text" | "answer" | "solution" | "question" | "title" | "summary" | "description" |
                    "command" | "purpose" | "rationale" | "example" | "symptoms" | "steps" | "action" | "output" | "explanation" |
                    "diagnosis" | "prevention" | "finding" | "resolution"
                ) {
                    if let Some(s) = v.as_str() {
                        text.push_str(s);
                        text.push('\n');
                    }
                }
                // Recursively search nested objects/arrays
                text.push_str(&extract_text_from_json(v));
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                text.push_str(&extract_text_from_json(v));
            }
        }
        _ => {}
    }
    text
}
