"""
Query Rewriter: Transforms vague user queries into actionable agent tasks.

This module takes ambiguous user queries and enriches them with:
1. Cluster context (available CRDs via kubectl api-resources)
2. Knowledge base lookups
3. Query expansion and clarification
"""

import asyncio
import json
from typing import Dict, Any, Optional, List
from dataclasses import dataclass

from .llm import call_llm


@dataclass
class RewrittenQuery:
    """Result of query rewriting."""
    original_query: str
    rewritten_query: str
    detected_resources: List[str]
    required_context: Optional[str]
    confidence: float
    reasoning: str


async def fetch_cluster_crds(context: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Fetch available CRDs from the cluster using kubectl api-resources.

    Args:
        context: Kubernetes context to use (optional)

    Returns:
        List of CRD metadata dicts with {name, kind, api_group, namespaced}
    """
    import subprocess
    import shlex

    # Use wide output format instead of json (more compatible)
    cmd = ["kubectl", "api-resources", "-o", "wide"]
    if context:
        cmd.extend(["--context", context])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode != 0:
            print(f"Warning: kubectl api-resources failed: {result.stderr}")
            return []

        # Parse table output
        # Format: NAME  SHORTNAMES  APIVERSION  NAMESPACED  KIND  VERBS
        lines = result.stdout.strip().split('\n')
        if not lines:
            return []

        # Skip header
        crds = []
        for line in lines[1:]:
            parts = line.split()
            if len(parts) < 5:
                continue

            # Extract fields (handle variable spacing)
            name = parts[0]
            # Find APIVERSION (has / or starts with 'v')
            apiversion_idx = next((i for i, p in enumerate(parts[1:], 1)
                                   if '/' in p or p.startswith('v')), None)
            if not apiversion_idx:
                continue

            apiversion = parts[apiversion_idx]
            namespaced_str = parts[apiversion_idx + 1] if len(parts) > apiversion_idx + 1 else "true"
            kind = parts[apiversion_idx + 2] if len(parts) > apiversion_idx + 2 else name.capitalize()

            # Parse API group from apiversion (e.g., "apps/v1" -> "apps")
            api_group = apiversion.split('/')[0] if '/' in apiversion else ""

            crds.append({
                "name": name,
                "kind": kind,
                "api_group": api_group,
                "namespaced": namespaced_str.lower() == "true",
                "apiversion": apiversion
            })

        print(f"[CRD Discovery] Fetched {len(crds)} resources from cluster")
        return crds

    except subprocess.TimeoutExpired:
        print("Warning: kubectl api-resources timed out")
        return []
    except Exception as e:
        print(f"Warning: Failed to fetch CRDs: {e}")
        import traceback
        traceback.print_exc()
        return []


async def rewrite_query(
    user_query: str,
    context: Optional[str] = None,
    llm_endpoint: str = "http://localhost:11434",
    llm_model: str = "qwen2.5:72b",
    llm_provider: str = "ollama",
    api_key: Optional[str] = None,
    use_kb: bool = True
) -> RewrittenQuery:
    """
    Rewrite a vague user query into a specific, actionable task.

    This function:
    1. Fetches available CRDs from the cluster
    2. Searches knowledge base for relevant patterns
    3. Uses LLM to understand user intent
    4. Matches vague terms to actual resource types
    5. Expands the query with context

    Args:
        user_query: Raw user input (e.g., "find storage account")
        context: Kubernetes context (optional)
        llm_endpoint: LLM API endpoint
        llm_model: LLM model name
        llm_provider: LLM provider (ollama/groq/openai)
        api_key: API key for LLM provider
        use_kb: Whether to search knowledge base (default: True)

    Returns:
        RewrittenQuery object with expanded query and metadata
    """

    # Fetch cluster CRDs asynchronously
    crds = await fetch_cluster_crds(context)

    # Search knowledge base for relevant patterns
    kb_snippets = []
    if use_kb:
        try:
            from .tools.kb_search import get_relevant_kb_snippets
            # Build state dict for KB search
            state = {
                "llm_endpoint": llm_endpoint,
                "kube_context": context
            }
            kb_results = await get_relevant_kb_snippets(
                query=user_query,
                state=state,
                max_results=3,
                min_similarity=0.3
            )
            # get_relevant_kb_snippets returns formatted string, parse it
            if kb_results and isinstance(kb_results, str) and kb_results.strip():
                # KB results are already formatted, just store the text
                kb_snippets = [{"text": kb_results}]
                print(f"[KB Search] Found relevant patterns")
        except Exception as e:
            print(f"[KB Search] Failed to search knowledge base: {e}")

    # Build CRD summary for LLM
    crd_summary = []
    for crd in crds:
        if crd["api_group"]:  # Focus on custom resources (have API groups)
            crd_summary.append({
                "resource": crd["name"],
                "kind": crd["kind"],
                "group": crd["api_group"]
            })

    # Limit to first 100 CRDs to avoid token overflow
    crd_summary = crd_summary[:100]

    # Format KB snippets for prompt
    kb_context = ""
    if kb_snippets:
        kb_context = "\n\nRelevant Knowledge Base Patterns:\n"
        for snippet in kb_snippets[:3]:
            if isinstance(snippet, dict):
                if 'text' in snippet:
                    # Already formatted text from KB search
                    kb_context += snippet['text'] + "\n"
                elif 'id' in snippet:
                    kb_context += f"\n- ID: {snippet['id']}\n"
                    if 'category' in snippet:
                        kb_context += f"  Category: {snippet['category']}\n"
                    if 'symptoms' in snippet:
                        kb_context += f"  Symptoms: {snippet.get('symptoms', [])}\n"
                    if 'root_cause' in snippet:
                        kb_context += f"  Root Cause: {snippet.get('root_cause', '')}\n"
            else:
                kb_context += f"  {str(snippet)[:200]}\n"

    # Build prompt for query rewriting
    prompt = f"""You are a Kubernetes query rewriter. Your job is to transform vague user queries
into specific, actionable tasks for a Kubernetes troubleshooting agent.

Available Custom Resources in the cluster:
{json.dumps(crd_summary, indent=2)}{kb_context}

User Query: "{user_query}"

Analyze the query and provide:
1. Which specific Kubernetes resources the user is asking about (match vague terms to actual CRD kinds)
2. What action they want to perform (list, debug, extract error, etc.)
3. Any specific fields or data they need (use KB patterns if relevant)
4. A rewritten query that is clear and actionable

Example:
Input: "find storage account"
Output:
{{
  "detected_resources": ["storageaccounts.azure.upbound.io", "accounts.storage.azure.upbound.io"],
  "action": "list_and_inspect",
  "rewritten_query": "List all Azure Storage Account managed resources across all namespaces. If any are in a failed state, extract error messages from their status.conditions array.",
  "confidence": 0.85,
  "reasoning": "User likely wants to find Crossplane-managed Azure Storage Accounts. Matched to 'storageaccounts' and 'accounts' CRDs in storage.azure group."
}}

Now rewrite the user query. Respond with ONLY valid JSON matching the example format.
"""

    try:
        response = await call_llm(
            prompt=prompt,
            endpoint=llm_endpoint,
            model=llm_model,
            provider=llm_provider,
            temperature=0.1,
            force_json=True,
            api_key=api_key
        )

        result = json.loads(response)

        return RewrittenQuery(
            original_query=user_query,
            rewritten_query=result.get("rewritten_query", user_query),
            detected_resources=result.get("detected_resources", []),
            required_context=context,
            confidence=result.get("confidence", 0.5),
            reasoning=result.get("reasoning", "No reasoning provided")
        )

    except Exception as e:
        print(f"Warning: Query rewriting failed: {e}")
        # Fallback: return original query
        return RewrittenQuery(
            original_query=user_query,
            rewritten_query=user_query,
            detected_resources=[],
            required_context=context,
            confidence=0.0,
            reasoning=f"Query rewriting failed: {e}"
        )
