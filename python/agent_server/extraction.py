"""
LLM-based structured data extraction from kubectl command outputs.

This module uses a lightweight LLM to extract structured debugging information
from kubectl outputs, providing persistent memory across agent iterations.
"""

import json
import re
from typing import Dict, Any, Optional

from .llm import call_llm

EXTRACTION_PROMPT_TEMPLATE = """You are a data extraction system for Kubernetes debugging.

Extract structured information from this kubectl command and its output.

**Command:**
{command}

**Output:**
{output}

**Current Debugging Context:**
{current_context}

**Your Task:**
Extract relevant information and return it as a JSON object. Only extract information that is CLEARLY present in the output. Use null for fields you cannot determine.

**JSON Schema:**
{{
  "crd_type": "string | null",  // Resource type (e.g., "customerclusters", "pods", "deployments")
  "api_group": "string | null",  // API group (e.g., "dedicated.uipath.com")
  "resource_name": "string | null",  // Specific resource name (e.g., "customercluster-prod")
  "namespace": "string | null",  // Namespace where resource is located
  "controller_pod": "string | null",  // Controller pod name if found
  "controller_namespace": "string | null",  // Controller namespace
  "controller_type": "string | null",  // Type of controller (provider/operator/controller)
  "status_state": "string | null",  // Current state (Running/CrashLoopBackOff/ASFailed/etc)
  "error_message": "string | null",  // Primary error message
  "error_code": "string | null",  // HTTP/exit code (403/404/500/137/etc)
  "error_type": "string | null",  // Error type (AuthorizationFailed/OOMKilled/etc)
  "debug_phase": "discovery | status_check | controller_search | log_analysis | root_cause_found | null",
  "root_cause_identified": "boolean",  // true if definitive root cause found
  "related_resources": ["string"],  // Related resources mentioned (format: "Kind/name")
  "owner_references": ["string"],  // Owner resources (format: "Kind/name")
  "next_target": "string | null"  // Suggested next resource to investigate
}}

**Extraction Guidelines:**

1. **CRD Discovery** (kubectl api-resources, kubectl get <type>):
   - Extract crd_type and api_group
   - If listing instances, extract namespace and resource_name

2. **Status Checks** (kubectl get/describe, -o yaml/json):
   - Extract status_state
   - Look for error fields: status.message, status.conditions[].message
   - Extract error_code if present (403, 404, 500, etc.)
   - Extract error_type (ImagePullBackOff, OOMKilled, AuthorizationFailed, etc.)

3. **Controller Search** (kubectl get pods -A | grep):
   - Extract controller_pod and controller_namespace
   - Infer controller_type from naming patterns (provider-*/operator-*/controller-*)

4. **Log Analysis** (kubectl logs):
   - Extract error_message from log entries
   - Extract error_code from HTTP responses
   - Look for stack traces, exceptions, failures

5. **Debug Phase Inference:**
   - If command is discovering CRDs/resources -> "discovery"
   - If command checks status/yaml -> "status_check"
   - If command searches for controllers/operators -> "controller_search"
   - If command fetches logs -> "log_analysis"
   - If error_message contains definitive cause -> "root_cause_found"

6. **Root Cause Identification:**
   - Set root_cause_identified=true ONLY if you see definitive errors like:
     * "403 Forbidden" + "AuthorizationFailed"
     * "OOMKilled" + memory limits
     * "ImagePullBackOff" + "401 Unauthorized"
     * Specific error messages with clear causes

7. **Context Preservation:**
   - NEVER override existing context with null
   - Only update fields if new information is found
   - Merge with current_context, don't replace it

**Response Format:**
Return ONLY a valid JSON object. No explanations, no markdown formatting, just JSON.

Example:
{{"crd_type": "customerclusters", "namespace": "argocd", "resource_name": "customercluster-prod", "status_state": "ASFailed", "debug_phase": "status_check"}}
"""


async def extract_structured_data(
    command: str,
    output: str,
    current_context: Optional[Dict[str, Any]],
    llm_endpoint: str,
    llm_provider: str,
    llm_model: str,
    api_key: Optional[str] = None
) -> Dict[str, Any]:
    """Extract structured debugging information from kubectl command output.

    Args:
        command: The kubectl command that was executed
        output: The command output
        current_context: Existing debugging context to preserve
        llm_endpoint: LLM endpoint URL
        llm_provider: LLM provider (ollama/groq/openai)
        llm_model: Model name (use small fast model for extraction)
        api_key: API key if needed

    Returns:
        Dict containing extracted structured data (merged with current context)
    """
    # Skip extraction for non-kubectl commands
    if not command.strip().startswith('kubectl'):
        return current_context or {}

    # Skip extraction for empty outputs
    if not output or len(output.strip()) < 10:
        return current_context or {}

    # Prepare current context for prompt
    current_context_json = json.dumps(current_context or {}, indent=2)

    # Truncate very long outputs (keep first 5000 chars + last 1000 chars)
    if len(output) > 6000:
        output = output[:5000] + "\n...\n[truncated]\n...\n" + output[-1000:]

    # Build extraction prompt
    prompt = EXTRACTION_PROMPT_TEMPLATE.format(
        command=command,
        output=output,
        current_context=current_context_json
    )

    try:
        # Call LLM for extraction (use small model for speed)
        response = await call_llm(
            prompt=prompt,
            endpoint=llm_endpoint,
            model=llm_model,  # Should be a fast model like llama3.2-3b or qwen2.5-coder:7b
            provider=llm_provider,
            temperature=0.0,  # Deterministic extraction
            force_json=True,
            api_key=api_key
        )

        # Parse JSON from response
        extracted = parse_json_from_response(response)

        # Merge with existing context (preserve non-null values)
        merged = merge_contexts(current_context or {}, extracted)

        return merged

    except Exception as e:
        # If extraction fails, return current context unchanged
        print(f"[EXTRACTION] Warning: Failed to extract data: {e}")
        return current_context or {}


def parse_json_from_response(response: str) -> Dict[str, Any]:
    """Parse JSON from LLM response, handling markdown code blocks."""
    # Try direct JSON parse first
    try:
        return json.loads(response.strip())
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code block
    match = re.search(r'```(?:json)?\s*(\{.+?\})\s*```', response, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Try finding JSON object anywhere in response
    match = re.search(r'\{.+\}', response, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    # Fallback: return empty dict
    return {}


def merge_contexts(current: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
    """Merge new extracted data with current context.

    Rules:
    - Preserve non-null current values unless new value is also non-null
    - Append to lists instead of replacing
    - Never downgrade from specific to null
    """
    merged = dict(current)

    for key, new_value in new.items():
        if new_value is None or new_value == "null":
            # Don't override existing values with null
            continue

        current_value = merged.get(key)

        if current_value is None:
            # Current is null, take new value
            merged[key] = new_value
        elif isinstance(current_value, list) and isinstance(new_value, list):
            # Merge lists (deduplicate)
            merged[key] = list(set(current_value + new_value))
        else:
            # Override with new value (prefer latest information)
            merged[key] = new_value

    return merged


def format_debugging_context(context: Optional[Dict[str, Any]]) -> str:
    """Format debugging context for display in prompts."""
    if not context or not isinstance(context, dict):
        return "No debugging context established yet."

    lines = ["**Auto-Extracted Debugging Context:**"]

    # Resource Discovery
    if context.get('crd_type') or context.get('resource_name'):
        lines.append("\n[SEARCH] **Resource Discovery:**")
        if context.get('crd_type'):
            lines.append(f"  • Type: {context.get('crd_type')}")
        if context.get('api_group'):
            lines.append(f"  • API Group: {context.get('api_group')}")
        if context.get('resource_name'):
            lines.append(f"  • Name: {context.get('resource_name')}")
        if context.get('namespace'):
            lines.append(f"  • Namespace: {context.get('namespace')}")

    # Controller Information
    if context.get('controller_pod') or context.get('controller_namespace'):
        lines.append("\n[CTRL] **Controller Information:**")
        if context.get('controller_pod'):
            lines.append(f"  • Pod: {context.get('controller_pod')}")
        if context.get('controller_namespace'):
            lines.append(f"  • Namespace: {context.get('controller_namespace')}")
        if context.get('controller_type'):
            lines.append(f"  • Type: {context.get('controller_type')}")

    # Status & Errors
    if context.get('status_state') or context.get('error_message'):
        lines.append("\n[WARN]  **Status & Errors:**")
        if context.get('status_state'):
            lines.append(f"  • State: {context.get('status_state')}")
        if context.get('error_message'):
            lines.append(f"  • Error: {context.get('error_message')}")
        if context.get('error_code'):
            lines.append(f"  • Code: {context.get('error_code')}")
        if context.get('error_type'):
            lines.append(f"  • Type: {context.get('error_type')}")

    # Investigation Progress
    if context.get('debug_phase'):
        lines.append(f"\n[STATS] **Debug Phase:** {context.get('debug_phase')}")

    if context.get('root_cause_identified'):
        lines.append("[OK] **Root cause has been identified!**")

    # Related Resources
    if context.get('related_resources'):
        resources = context.get('related_resources', [])
        if resources:
            lines.append(f"\n[LINK] **Related Resources:** {', '.join(resources)}")

    # Next Target
    if context.get('next_target'):
        lines.append(f"\n[TARGET] **Next Investigation Target:** {context.get('next_target')}")

    return '\n'.join(lines)
