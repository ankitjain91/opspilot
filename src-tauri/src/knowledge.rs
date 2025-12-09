use std::fs;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use tauri::Manager;
use std::collections::HashSet;
use crate::embeddings;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchResult {
    pub file: String,
    pub content: String,
    pub score: f32,
    pub tags: Vec<String>,
    pub category: String,
    pub quick_fix: Option<String>,
    pub recommended_tools: Option<Vec<String>>,
}

/// Kubernetes and cloud-related term synonyms for query expansion
fn get_term_expansions(term: &str) -> Vec<&'static str> {
    match term.to_lowercase().as_str() {
        "pod" | "pods" => vec!["pod", "pods", "container", "workload"],
        "deploy" | "deployment" | "deployments" => vec!["deployment", "deployments", "deploy", "replica"],
        "svc" | "service" | "services" => vec!["service", "services", "svc", "endpoint"],
        "node" | "nodes" => vec!["node", "nodes", "worker", "master", "control-plane"],
        "crash" | "crashloop" | "crashloopbackoff" | "crashlooping" => vec!["crash", "crashloop", "crashloopbackoff", "restart", "oomkilled", "error", "failing", "failed"],
        "oom" | "oomkilled" | "memory" => vec!["oom", "oomkilled", "memory", "ram", "limit", "resource"],
        "cpu" => vec!["cpu", "processor", "throttle", "limit", "resource"],
        "pv" | "pvc" | "volume" | "storage" => vec!["pv", "pvc", "volume", "storage", "persistent", "disk"],
        "ingress" => vec!["ingress", "route", "traffic", "load-balancer", "nginx"],
        "secret" | "secrets" => vec!["secret", "secrets", "credential", "password", "key"],
        "configmap" | "cm" => vec!["configmap", "cm", "config", "configuration", "env"],
        "ns" | "namespace" | "namespaces" => vec!["namespace", "namespaces", "ns"],
        "hpa" | "autoscale" | "autoscaling" => vec!["hpa", "autoscale", "autoscaling", "scale", "horizontal"],
        "log" | "logs" | "logging" => vec!["log", "logs", "logging", "stdout", "stderr"],
        "event" | "events" => vec!["event", "events", "warning", "error"],
        "pending" => vec!["pending", "unschedulable", "waiting", "stuck"],
        "network" | "networking" => vec!["network", "networking", "dns", "connectivity", "cni"],
        "rbac" | "permission" | "permissions" => vec!["rbac", "permission", "permissions", "role", "clusterrole", "serviceaccount"],
        "helm" => vec!["helm", "chart", "release", "values"],
        "kubectl" => vec!["kubectl", "command", "cli"],
        // Crossplane and infrastructure as code
        "crossplane" | "xplane" => vec!["crossplane", "provider", "managed", "composite", "claim", "composition", "xrd", "upbound"],
        "managed" => vec!["managed", "crossplane", "provider", "provisioning", "infrastructure", "resource"],
        "provider" | "providers" => vec!["provider", "providers", "crossplane", "upbound", "credentials", "providerconfig"],
        "composite" | "xr" => vec!["composite", "xr", "crossplane", "composition", "claim"],
        "claim" | "claims" | "xrc" => vec!["claim", "claims", "xrc", "crossplane", "composite"],
        "provisioning" | "provision" => vec!["provisioning", "provision", "crossplane", "managed", "creating", "resource"],
        "infrastructure" | "infra" => vec!["infrastructure", "infra", "crossplane", "managed", "iac", "terraform"],
        "upbound" => vec!["upbound", "crossplane", "provider", "marketplace"],
        // Resource-related (more specific)
        "resource" | "resources" => vec!["resource", "resources", "managed", "crossplane", "provisioning", "infrastructure", "quota", "limits"],
        "failing" | "failed" | "fail" => vec!["failing", "failed", "fail", "error", "unhealthy", "notready", "stuck"],
        "stuck" | "stale" => vec!["stuck", "stale", "pending", "terminating", "finalizer", "blocked"],
        "sync" | "synced" | "syncing" => vec!["sync", "synced", "syncing", "crossplane", "managed", "reconcile", "ready"],
        "ready" | "notready" => vec!["ready", "notready", "synced", "healthy", "condition", "status"],
        _ => vec![],
    }
}

/// Extract tags from content for better categorization
fn extract_tags(content: &str) -> Vec<String> {
    let mut tags = HashSet::new();
    let content_lower = content.to_lowercase();

    // Kubernetes resource types
    let k8s_resources = [
        ("pod", "pods"), ("deployment", "deployments"), ("service", "services"),
        ("ingress", "ingresses"), ("configmap", "configmaps"), ("secret", "secrets"),
        ("node", "nodes"), ("namespace", "namespaces"), ("pvc", "persistent"),
        ("statefulset", "statefulsets"), ("daemonset", "daemonsets"),
        ("job", "jobs"), ("cronjob", "cronjobs"), ("hpa", "horizontal"),
    ];

    for (tag, alt) in k8s_resources {
        if content_lower.contains(tag) || content_lower.contains(alt) {
            tags.insert(tag.to_string());
        }
    }

    // Issue types
    let issue_types = [
        ("crashloopbackoff", "crash"), ("oomkilled", "oom"), ("pending", "pending"),
        ("imagepullbackoff", "image"), ("error", "error"), ("warning", "warning"),
        ("failed", "failure"), ("timeout", "timeout"), ("evicted", "eviction"),
    ];

    for (pattern, tag) in issue_types {
        if content_lower.contains(pattern) {
            tags.insert(tag.to_string());
        }
    }

    // Operations
    let operations = [
        ("debug", "debugging"), ("troubleshoot", "troubleshooting"),
        ("diagnose", "diagnosis"), ("fix", "remediation"), ("scale", "scaling"),
        ("upgrade", "upgrade"), ("rollback", "rollback"), ("restart", "restart"),
    ];

    for (pattern, tag) in operations {
        if content_lower.contains(pattern) {
            tags.insert(tag.to_string());
        }
    }

    // Crossplane and infrastructure as code
    let crossplane_patterns = [
        ("crossplane", "crossplane"), ("provider", "provider"), ("managed", "managed"),
        ("composite", "composite"), ("claim", "claim"), ("composition", "composition"),
        ("upbound", "upbound"), ("providerconfig", "providerconfig"),
        ("xrd", "xrd"), ("synced", "synced"),
    ];

    for (pattern, tag) in crossplane_patterns {
        if content_lower.contains(pattern) {
            tags.insert(tag.to_string());
        }
    }

    tags.into_iter().collect()
}

/// Determine category from filename and content
fn determine_category(filename: &str, content: &str) -> String {
    let filename_lower = filename.to_lowercase();
    let content_lower = content.to_lowercase();

    // Check for crossplane first (more specific category)
    if filename_lower.contains("crossplane") || content_lower.contains("crossplane") ||
       content_lower.contains("managed resource") || content_lower.contains("providerconfig") {
        "crossplane".to_string()
    } else if filename_lower.contains("troubleshoot") || content_lower.contains("troubleshoot") {
        "troubleshooting".to_string()
    } else if filename_lower.contains("best-practice") || content_lower.contains("best practice") {
        "best-practices".to_string()
    } else if filename_lower.contains("command") || content_lower.contains("kubectl") {
        "commands".to_string()
    } else if filename_lower.contains("debug") || content_lower.contains("debugging") {
        "debugging".to_string()
    } else if filename_lower.contains("security") || content_lower.contains("rbac") {
        "security".to_string()
    } else if filename_lower.contains("network") || content_lower.contains("networking") {
        "networking".to_string()
    } else if filename_lower.contains("storage") || content_lower.contains("persistent") {
        "storage".to_string()
    } else {
        "general".to_string()
    }
}

/// Clean and normalize a search term - remove punctuation, handle common variations
fn normalize_term(term: &str) -> String {
    // Remove punctuation and normalize
    let cleaned: String = term.chars()
        .filter(|c| c.is_alphanumeric())
        .collect();

    // Handle common suffixes/variations for better matching
    let lower = cleaned.to_lowercase();

    // Strip common suffixes to get root form
    if lower.ends_with("ing") && lower.len() > 5 {
        return lower[..lower.len()-3].to_string();
    }
    if lower.ends_with("ed") && lower.len() > 4 {
        return lower[..lower.len()-2].to_string();
    }
    if lower.ends_with("s") && lower.len() > 3 && !lower.ends_with("ss") {
        return lower[..lower.len()-1].to_string();
    }

    lower
}

#[tauri::command]
pub async fn search_knowledge_base(query: String, app_handle: tauri::AppHandle) -> Result<Vec<SearchResult>, String> {
    let mut results = Vec::new();

    // Clean and normalize query - remove punctuation, lowercase
    let query_clean: String = query.chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    let query_lower = query_clean.to_lowercase();

    // Split and normalize terms
    let query_terms: Vec<String> = query_lower
        .split_whitespace()
        .filter(|t| t.len() >= 2) // Skip very short terms
        .map(|t| normalize_term(t))
        .collect();

    // Also keep original terms for exact matching
    let original_terms: Vec<&str> = query_lower.split_whitespace().collect();

    // Expand query terms with synonyms
    let mut expanded_terms: HashSet<String> = HashSet::new();
    for term in &query_terms {
        expanded_terms.insert(term.clone());
        // Try both the normalized term and the original for expansion lookup
        for expansion in get_term_expansions(term) {
            expanded_terms.insert(expansion.to_string());
        }
    }
    for term in &original_terms {
        for expansion in get_term_expansions(term) {
            expanded_terms.insert(expansion.to_string());
        }
    }

    // Resolve the knowledge directory relative to the resource path
    let resource_path = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let knowledge_path = resource_path.join("knowledge");

    // Fallback for development if resource dir doesn't have it
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
            let filename = entry.file_name().to_string_lossy().to_string();

            let mut quick_fix: Option<String> = None;
            let mut recommended_tools: Option<Vec<String>> = None;

            let content = if ext == "md" {
                fs::read_to_string(entry.path()).unwrap_or_default()
            } else if ext == "json" {
                let file_content = fs::read_to_string(entry.path()).unwrap_or_default();
                let json: serde_json::Value = serde_json::from_str(&file_content).unwrap_or(serde_json::Value::Null);
                
                if let Some(fix) = json.get("quick_fix").and_then(|v| v.as_str()) {
                    quick_fix = Some(fix.to_string());
                }
                if let Some(tools) = json.get("recommended_tools").and_then(|v| v.as_array()) {
                    recommended_tools = Some(tools.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());
                }

                extract_text_from_json(&json)
            } else {
                continue;
            };

            if content.is_empty() {
                continue;
            }

            let content_lower = content.to_lowercase();
            let filename_lower = filename.to_lowercase();

            let mut score = 0.0;
            let mut direct_matches = 0;
            let mut expanded_matches = 0;

            // Score normalized query terms
            for term in &query_terms {
                // Check for substring match (handles crashloop matching crashloopbackoff)
                if content_lower.contains(term.as_str()) {
                    direct_matches += 1;
                    score += 2.0;
                }
                // Bonus for filename match
                if filename_lower.contains(term.as_str()) {
                    score += 3.0;
                }
            }

            // Score expanded terms
            for term in &expanded_terms {
                if !query_terms.contains(term) && content_lower.contains(term.as_str()) {
                    expanded_matches += 1;
                    score += 0.5;
                }
            }

            // Bonus for original terms (exact match)
            for term in &original_terms {
                if content_lower.contains(*term) {
                    score += 1.0;
                }
            }

            // Bonus for matching multiple terms (relevance boost)
            if direct_matches > 1 {
                score += (direct_matches as f32) * 1.5;
            }
            if expanded_matches > 2 {
                score += 1.0; // Bonus for multiple synonym matches
            }

            // Extract tags and check for tag matches
            let tags = extract_tags(&content);
            let category = determine_category(&filename, &content);

            // Bonus for tag matches with query
            for term in &query_terms {
                if tags.iter().any(|t| t.contains(term.as_str())) {
                    score += 2.0;
                }
            }

            if score > 0.0 {
                // Extract a better snippet with more context
                let snippet = extract_structured_snippet(&content, &query_terms, &expanded_terms);

                results.push(SearchResult {
                    file: filename,
                    content: snippet,
                    score,
                    tags,
                    category,
                    quick_fix: quick_fix.clone(),
                    recommended_tools: recommended_tools.clone(),
                });
            }
        }
    }

    // Sort by score descending
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Return top 8 for better coverage
    Ok(results.into_iter().take(8).collect())
}

/// Extract a structured snippet with better context
fn extract_structured_snippet(content: &str, direct_terms: &[String], expanded_terms: &HashSet<String>) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut snippets: Vec<(usize, String, usize)> = Vec::new(); // (start_idx, text, term_count)

    // Use larger window of 10 lines for better context
    let window_size = 10;

    for i in 0..lines.len() {
        let end = std::cmp::min(i + window_size, lines.len());
        let window = &lines[i..end];
        let window_text = window.join("\n");
        let window_lower = window_text.to_lowercase();

        // Count direct term matches (weighted higher)
        let direct_count: usize = direct_terms.iter()
            .filter(|t| window_lower.contains(t.as_str()))
            .count();

        // Count expanded term matches
        let expanded_count: usize = expanded_terms.iter()
            .filter(|t| !direct_terms.contains(t) && window_lower.contains(t.as_str()))
            .count();

        // Combined score: direct matches worth 2, expanded worth 1
        let total_score = direct_count * 2 + expanded_count;

        if total_score > 0 {
            snippets.push((i, window_text, total_score));
        }
    }

    // Sort by score descending
    snippets.sort_by(|a, b| b.2.cmp(&a.2));

    if snippets.is_empty() {
        // Fallback to first 10 lines
        return lines.into_iter().take(10).collect::<Vec<&str>>().join("\n");
    }

    // Take best snippet
    let best = &snippets[0];
    let mut result = best.1.clone();

    // If we have a second good snippet that doesn't overlap, include it
    if snippets.len() > 1 {
        let second = &snippets[1];
        // Check for overlap (if starts are more than window_size apart)
        if second.0.abs_diff(best.0) >= window_size && second.2 >= 2 {
            result.push_str("\n\n---\n\n");
            result.push_str(&second.1);
        }
    }

    // Limit total length
    if result.len() > 2000 {
        result.truncate(2000);
        result.push_str("...");
    }

    result
}

#[allow(dead_code)]
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
                // Check for common content fields - expanded list based on actual KB content
                if matches!(k.as_str(),
                    // Basic content fields
                    "content" | "body" | "text" | "answer" | "solution" | "question" | "title" | "summary" | "description" |
                    "command" | "purpose" | "rationale" | "example" | "symptoms" | "steps" | "action" | "output" | "explanation" |
                    "diagnosis" | "prevention" | "finding" | "resolution" |
                    // Additional fields from KB JSON files
                    "name" | "when_to_use" | "what_to_look_for" | "meaning" | "first_steps" |
                    "cause" | "likely_causes" | "fix_steps" | "diagnostic_commands" |
                    "note" | "warning" | "impact" | "alternative" |
                    "incident" | "timeline" | "lessons_learned" | "event" |
                    "error_patterns" | "mistake" | "consequence" |
                    "symptom" | "hypothesis" | "test" | "result" | "fix" |
                    "goal" | "triggers" | "actions" | "checks" | "activities" | "outputs"
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
        // Also extract string values from arrays
        serde_json::Value::String(s) => {
            text.push_str(s);
            text.push('\n');
        }
        _ => {}
    }
    text
}

/// Hybrid semantic + keyword search for best results
/// Uses semantic search as primary, with keyword boost for exact matches
#[tauri::command]
pub async fn semantic_search_knowledge_base(
    query: String,
    app_handle: tauri::AppHandle
) -> Result<Vec<SearchResult>, String> {
    // Try to load embeddings
    let kb_embeddings = match embeddings::load_embeddings(&app_handle) {
        Ok(data) => {
            eprintln!("[DEBUG] Loaded {} KB embeddings", data.documents.len());
            data
        },
        Err(e) => {
            eprintln!("[DEBUG] Failed to load KB embeddings: {}, falling back to keyword", e);
            return search_knowledge_base(query.clone(), app_handle).await;
        }
    };

    // Get query embedding using fastembed (local ONNX)
    let query_embedding = match embeddings::embed_query(&query) {
        Ok(emb) => {
            eprintln!("[DEBUG] Query embedding dimension: {}", emb.len());
            emb
        },
        Err(e) => {
            eprintln!("[DEBUG] Embedding failed: {}, falling back to keyword", e);
            return search_knowledge_base(query, app_handle).await;
        }
    };

    // Perform semantic search with more results to allow reranking
    let semantic_results = embeddings::search_documents(&query_embedding, &kb_embeddings, 15);
    let top_score = semantic_results.first().map(|r| r.score).unwrap_or(0.0);
    eprintln!("[DEBUG] Got {} semantic results, top score: {:.4}", semantic_results.len(), top_score);

    // If semantic search completely fails, fall back to keyword
    if semantic_results.is_empty() {
        eprintln!("[DEBUG] No semantic results, falling back to keyword search");
        return search_knowledge_base(query, app_handle).await;
    }

    // Load file content to build full SearchResult
    let resource_path = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let knowledge_path = resource_path.join("knowledge");
    let cwd = std::env::current_dir().unwrap_or_default();
    let search_paths = vec![
        knowledge_path.clone(),
        cwd.join("knowledge"),
        // When running from src-tauri, knowledge is in parent
        cwd.parent().map(|p| p.join("knowledge")).unwrap_or_default(),
    ];

    let mut search_dir = None;
    for path in search_paths {
        if path.exists() {
            search_dir = Some(path);
            break;
        }
    }

    let search_dir = match search_dir {
        Some(p) => {
            eprintln!("[DEBUG] Using knowledge dir: {:?}", p);
            p
        },
        None => {
            eprintln!("[DEBUG] No knowledge dir found!");
            return Ok(vec![]);
        }
    };

    // Prepare query terms for keyword boosting
    let query_lower = query.to_lowercase();
    let query_terms: Vec<&str> = query_lower.split_whitespace().collect();

    let mut results = Vec::new();
    for semantic_result in semantic_results {
        let file_path = search_dir.join(&semantic_result.file);
        let (tags, category, quick_fix, recommended_tools, content) = if file_path.exists() {
            let content = fs::read_to_string(&file_path).unwrap_or_default();

            let mut qf = None;
            let mut rt = None;

            if file_path.extension().and_then(|e| e.to_str()) == Some("json") {
                 if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                     if let Some(fix) = json.get("quick_fix").and_then(|v| v.as_str()) {
                         qf = Some(fix.to_string());
                     }
                     if let Some(tools) = json.get("recommended_tools").and_then(|v| v.as_array()) {
                         rt = Some(tools.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());
                     }
                 }
            }
            let tags = extract_tags(&content);
            let category = determine_category(&semantic_result.file, &content);
            (tags, category, qf, rt, content)
        } else {
            (vec![], "troubleshooting".to_string(), None, None, String::new())
        };

        // Compute hybrid score: semantic + keyword boost
        let mut hybrid_score = semantic_result.score;
        let content_lower = content.to_lowercase();
        let filename_lower = semantic_result.file.to_lowercase();
        let title_lower = semantic_result.title.to_lowercase();

        // Boost for exact keyword matches
        for term in &query_terms {
            if term.len() < 3 { continue; } // Skip short terms

            // Strong boost for filename match (e.g., "crossplane" in "crossplane-troubleshooting.json")
            if filename_lower.contains(term) {
                hybrid_score += 0.15;
                eprintln!("[DEBUG] Filename boost for '{}' in {}", term, semantic_result.file);
            }

            // Strong boost for title match
            if title_lower.contains(term) {
                hybrid_score += 0.12;
            }

            // Medium boost for tag match
            if tags.iter().any(|t| t.to_lowercase().contains(term)) {
                hybrid_score += 0.08;
            }

            // Small boost for content match
            if content_lower.contains(term) {
                hybrid_score += 0.03;
            }
        }

        // Boost for category match (if query mentions category-like terms)
        let category_terms = ["troubleshoot", "crossplane", "network", "storage", "security", "debug"];
        for cat_term in category_terms {
            if query_lower.contains(cat_term) && category.to_lowercase().contains(cat_term) {
                hybrid_score += 0.1;
            }
        }

        // Use summary from embeddings
        let snippet = if semantic_result.summary.is_empty() {
            format!("**{}**\n\nNo summary available.", semantic_result.title)
        } else {
            format!("**{}**\n\n{}", semantic_result.title, semantic_result.summary)
        };

        results.push(SearchResult {
            file: semantic_result.file,
            content: snippet,
            score: hybrid_score * 10.0, // Scale for compatibility
            tags,
            category,
            quick_fix,
            recommended_tools,
        });
    }

    // Re-sort by hybrid score
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Limit to top 8
    results.truncate(8);

    eprintln!("[DEBUG] Final results: {:?}", results.iter().map(|r| (&r.file, r.score)).collect::<Vec<_>>());

    Ok(results)
}

/// Get tool suggestions based on semantic similarity to query
#[tauri::command]
pub async fn suggest_tools_for_query(
    query: String,
    app_handle: tauri::AppHandle,
    mcp_manager: tauri::State<'_, crate::mcp::manager::McpManager>,
) -> Result<Vec<embeddings::ToolSuggestion>, String> {
    let kb_embeddings = embeddings::load_embeddings(&app_handle)?;
    let query_embedding = embeddings::embed_query(&query)?;
    
    // Get built-in tool suggestions
    let mut suggestions = embeddings::suggest_tools(&query_embedding, &kb_embeddings, 5);

    // Get MCP tools and add them if relevant (simple keyword matching for now)
    let mcp_tools = mcp_manager.list_all_tools().await;
    let query_lower = query.to_lowercase();
    let query_parts: Vec<&str> = query_lower.split_whitespace().collect();

    for tool_val in mcp_tools {
        if let Some(tool) = tool_val.as_object() {
            let name = tool.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let desc = tool.get("description").and_then(|v| v.as_str()).unwrap_or("");
            
            // Simple relevance check
            let mut score = 0.0;
            let name_lower = name.to_lowercase();
            let desc_lower = desc.to_lowercase();

            if name_lower.contains(&query_lower) {
                score = 0.9;
            } else if desc_lower.contains(&query_lower) {
                score = 0.7;
            } else {
                // Check for partial keyword matches
                let matches = query_parts.iter().filter(|&&part| name_lower.contains(part) || desc_lower.contains(part)).count();
                if matches > 0 {
                    score = 0.3 + (0.1 * matches as f32);
                }
            }

            if score > 0.4 {
                suggestions.push(embeddings::ToolSuggestion {
                    name: name.to_string(),
                    description: desc.chars().take(100).collect::<String>(), // Truncate description
                    confidence: score,
                });
            }
        }
    }

    // sort again
    suggestions.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    suggestions.truncate(8); // Limit total suggestions

    Ok(suggestions)
}
