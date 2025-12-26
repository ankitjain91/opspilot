
import re
import json
import subprocess
import asyncio
from datetime import datetime, timezone
from typing import List, Dict, Optional, Any
import os
import hashlib
from .config import DANGEROUS_VERBS, DANGEROUS_HELM_VERBS, REMEDIATION_VERBS, LARGE_OUTPUT_VERBS, AZURE_MUTATION_VERBS, AZURE_SAFE_COMMANDS, MAX_OUTPUT_LENGTH, LOG_DIR, CACHE_DIR

def is_safe_command(cmd: str) -> tuple[bool, str]:
    """Check if a command is safe (read-only) and requires approval.

    Supports kubectl, helm, and Azure CLI commands.
    ALL mutations are strictly blocked - read-only operations only.
    """
    lower = cmd.lower().strip()

    # Detect internal markers
    if lower.startswith('__python_exec__:'):
        code = lower.split(':', 1)[1]
        if any(verb in code for verb in DANGEROUS_VERBS + ['patch', 'delete', 'create', 'update', 'replace']):
             return False, "MUTATING_PYTHON"
        return True, "SAFE"

    if lower.startswith('__git_commit__:'):
        return False, "MUTATING_GIT"

    # Helm command validation - STRICTLY block all mutations
    if lower.startswith('helm '):
        # Check for dangerous helm verbs
        for verb in DANGEROUS_HELM_VERBS:
            if f'helm {verb}' in lower or re.search(rf'\bhelm\s+{verb}\b', lower):
                return False, "HELM_MUTATING"
        # Safe helm commands: list, status, get, show, search, repo list, history
        safe_helm_verbs = ['list', 'ls', 'status', 'get', 'show', 'search', 'history', 'repo list', 'env']
        is_safe_helm = any(f'helm {verb}' in lower for verb in safe_helm_verbs)
        if not is_safe_helm:
            # Unknown helm command - block by default
            return False, "HELM_UNKNOWN"
        return True, "SAFE"

    # Azure CLI command detection and validation
    if lower.startswith('az '):
        # Check if it's a whitelisted safe command (starts with any safe prefix)
        is_safe_az = any(lower.startswith(safe_cmd.lower()) for safe_cmd in AZURE_SAFE_COMMANDS)

        if not is_safe_az:
            # Check if it contains mutation verbs
            has_mutation = any(re.search(rf'\b{verb}\b', lower) for verb in AZURE_MUTATION_VERBS)
            if has_mutation:
                return False, "AZURE_MUTATING"

            # If not explicitly safe and not clearly mutating, default to blocking
            # This is a security-first approach for Azure
            return False, "AZURE_UNKNOWN"

        # Safe Azure read command
        return True, "SAFE"

    # kubectl command validation (existing logic)
    if any(re.search(rf'\b{verb}\b', lower) for verb in DANGEROUS_VERBS):
        return False, "MUTATING"

    # Check for remediation verbs (now strictly blocked)
    if any(re.search(rf'\b{verb}\b', lower) for verb in REMEDIATION_VERBS):
        return False, "MUTATING" # Changed from REMEDIATION to MUTATING

    if any(verb in lower for verb in LARGE_OUTPUT_VERBS):
        return False, "LARGE_OUTPUT"

    return True, "SAFE"

def strip_verbose_fields(data: dict) -> dict:
    """Remove verbose/noisy fields from Kubernetes resource YAML to save tokens.

    Strips managedFields, status.conditions timestamps, annotations, and other
    fields that are rarely useful for troubleshooting.
    """
    if not isinstance(data, dict):
        return data

    # Fields to remove from metadata
    metadata = data.get('metadata', {})
    if isinstance(metadata, dict):
        for field in ['managedFields', 'generation', 'resourceVersion', 'uid', 'creationTimestamp']:
            metadata.pop(field, None)
        # Keep only essential annotations
        annotations = metadata.get('annotations', {})
        if isinstance(annotations, dict) and len(annotations) > 3:
            # Keep only kubectl.kubernetes.io and app-related annotations
            essential_prefixes = ['kubectl.', 'app.', 'helm.', 'argocd.']
            filtered = {k: v for k, v in annotations.items()
                       if any(k.startswith(p) for p in essential_prefixes)}
            if len(filtered) < len(annotations):
                filtered['...'] = f'{len(annotations) - len(filtered)} more annotations stripped'
            metadata['annotations'] = filtered

    # Strip verbose status fields
    status = data.get('status', {})
    if isinstance(status, dict):
        # Remove condition lastTransitionTime to save tokens
        conditions = status.get('conditions', [])
        if isinstance(conditions, list):
            for cond in conditions:
                if isinstance(cond, dict):
                    cond.pop('lastTransitionTime', None)
                    cond.pop('lastHeartbeatTime', None)
                    cond.pop('lastProbeTime', None)

    return data


def smart_truncate_output(output: str, max_chars: int = 3000) -> str:
    """Keep header + problematic rows, truncate healthy resources.

    This intelligently filters kubectl output to show:
    1. The header line (column names)
    2. All rows with problems (Error, Failed, CrashLoop, OOM, Pending, etc.)
    3. A few healthy rows
    4. A summary of omitted healthy rows
    """
    if not output:
        return '(no output)'

    lines = output.split('\n')
    if len('\n'.join(lines)) <= max_chars:
        return output

    header = lines[0] if lines else ''
    problem_keywords = [
        'Error', 'Failed', 'CrashLoop', 'OOM', 'Pending',
        'ImagePull', 'False', '0/', 'Evicted', 'Terminating',
        'BackOff', 'Warning', 'Unhealthy', 'NotReady',
        'Invalid', 'Unknown', 'Degraded', 'ASFailed', 'EnvFailed', # CRD failure patterns
        'Killing', 'Preempting', 'ContainerStatusUnknown', # K8s events
    ]

    important = [header] if header else []
    normal = []

    for line in lines[1:]:
        if any(kw in line for kw in problem_keywords):
            important.append(line)
        else:
            normal.append(line)

    result = '\n'.join(important)
    remaining = max_chars - len(result)

    if remaining > 100 and normal:
        # Add first few normal lines to show healthy examples
        sample_count = min(5, len(normal))
        for line in normal[:sample_count]:
            if len(result) + len(line) + 1 < max_chars - 100:  # Leave room for summary
                important.append(line)

        result = '\n'.join(important)
        omitted = len(normal) - (sample_count if len(result) + len(normal[0]) < max_chars else 0)
        if omitted > 0:
            result += f"\n... ({omitted} healthy resources omitted) ..."

    return result if len(result) < max_chars else result[:max_chars]

def truncate_output(text: str, max_len: int = MAX_OUTPUT_LENGTH) -> str:
    """Truncate output while preserving beginning and end."""
    if not text:
        return '(no output)'
    if len(text) <= max_len:
        return text
    half = max_len // 2
    return f"{text[:half]}\n\n... [truncated {len(text) - max_len} chars] ...\n\n{text[-half:]}"

def format_command_history(history: list, task_type: str = None, evidence_chain: list = None) -> str:
    """Format command history for the LLM prompt with adaptive compression.

    Compression Strategy:
    1. Last 2 commands: Full detail (3000 chars) - most relevant for next step
    2. Older commands with evidence: Medium detail (1000 chars) - keeps important findings
    3. Older commands without evidence: Minimal (300 chars) - just context
    4. Commands marked SOLVED/SUCCESS: Summarize only (100 chars) - already done

    Args:
        history: List of command history entries
        task_type: Optional task type (discovery/diagnosis/remediation) for priority
        evidence_chain: Optional list of key findings to prioritize
    """
    if not history:
        return '(none yet)'

    # Adaptive window size based on history length
    # More commands = more aggressive compression
    window_size = 5 if len(history) <= 10 else 4 if len(history) <= 15 else 3
    recent_history = history[-window_size:] if len(history) > window_size else history

    lines = []
    total_items = len(recent_history)
    evidence_set = set(evidence_chain or [])

    for i, h in enumerate(recent_history, 1):
        cmd = h.get('command', '')
        assessment = h.get('assessment', '')
        output = h.get('output', '')

        # Determine compression level based on multiple factors
        is_recent = i >= total_items - 1  # Last 2 commands
        has_evidence = any(ev in output for ev in evidence_set) if evidence_set else False
        is_solved = assessment in ['SOLVED', 'AUTO_SOLVED', 'SUCCESS']
        is_error = bool(h.get('error')) or assessment in ['ERROR', 'FAILED']

        # Adaptive max_chars based on relevance
        if is_solved:
            # Already solved - minimal context needed
            max_chars = 100
        elif is_error:
            # Errors are important - keep more detail
            max_chars = 1500
        elif is_recent:
            # Most recent - full detail
            max_chars = 3000
        elif has_evidence:
            # Has key evidence - medium detail
            max_chars = 1000
        else:
            # Older, no evidence - minimal
            max_chars = 300

        if h.get('error'):
            result = f"ERROR: {h['error']}"
        else:
            result = smart_truncate_output(output, max_chars=max_chars)

        assessment_str = f"\nREFLECTION: {assessment} - {h.get('reasoning', '')[:150]}" if assessment else ""
        lines.append(f"[{i}] $ {cmd}\n{result}{assessment_str}")

    if len(history) > window_size:
        lines.insert(0, f"(Showing last {window_size} of {len(history)} commands - compression: adaptive)")

    return '\n\n'.join(lines)

def format_conversation_context(history: list[dict]) -> str:
    """
    Format previous conversation turns with smart truncation and summarization.
    Preserves recent context while summarizing older turns to prevent context overflow.
    """
    if not history:
        return "(No previous context)"

    MAX_RECENT_TURNS = 6  # Keep last 3 exchanges (6 messages) verbatim
    MAX_TOTAL_LENGTH = 3000  # Character limit for conversation context

    # Filter valid messages
    valid_messages = []
    for msg in history:
        role = msg.get('role', 'unknown').upper()
        content = msg.get('content', '').strip()
        if role in ['USER', 'ASSISTANT', 'SUPERVISOR', 'SCOUT'] and content:
            valid_messages.append({'role': role, 'content': content})

    if not valid_messages:
        return "(No previous context)"

    # Split into recent and older messages
    recent_msgs = valid_messages[-MAX_RECENT_TURNS:]
    older_msgs = valid_messages[:-MAX_RECENT_TURNS] if len(valid_messages) > MAX_RECENT_TURNS else []

    lines = []

    # Summarize older messages if they exist
    if older_msgs:
        # Extract key findings and user corrections from older context
        key_findings = []
        user_corrections = []

        for msg in older_msgs:
            content = msg['content']
            # Extract corrections (user messages that contradict or refine previous responses)
            if msg['role'] == 'USER':
                if any(keyword in content.lower() for keyword in ['actually', 'no', 'correction', 'wrong', 'not', 'instead', 'rather']):
                    user_corrections.append(content[:200])
            # Extract assistant conclusions
            elif msg['role'] == 'ASSISTANT':
                # Look for conclusion markers
                if any(marker in content.lower() for marker in ['root cause:', 'conclusion:', 'found that', 'discovered', 'issue is']):
                    # Extract the sentence with the conclusion
                    for sentence in content.split('.'):
                        if any(marker in sentence.lower() for marker in ['root cause', 'conclusion', 'found that', 'discovered', 'issue is']):
                            key_findings.append(sentence.strip()[:200])
                            break

        # Build summary section
        summary_parts = []
        if key_findings:
            summary_parts.append("Previous Findings: " + " | ".join(key_findings[:3]))
        if user_corrections:
            summary_parts.append("User Corrections: " + " | ".join(user_corrections[:2]))

        if summary_parts:
            lines.append(f"[EARLIER CONTEXT SUMMARY - {len(older_msgs)} messages]")
            lines.extend(summary_parts)
            lines.append("")

    # Add recent messages verbatim
    lines.append("[RECENT CONTEXT]")
    for msg in recent_msgs:
        lines.append(f"{msg['role']}: {msg['content']}")

    # Truncate if still too long
    result = '\n'.join(lines)
    if len(result) > MAX_TOTAL_LENGTH:
        result = result[-MAX_TOTAL_LENGTH:]
        result = "...[truncated]\n" + result

    return result

def escape_braces(s: str) -> str:
    """Escape braces for formatted strings."""
    if not s:
        return ""
    return s.replace('{', '{{').replace('}', '}}')

async def get_cluster_recon(context: str = "") -> str:
    """Gather basic cluster info (Version, Nodes, Health) for the Supervisor."""
    try:
        cmd_prefix = f"kubectl --context={context} " if context else "kubectl "
        
        # We run subprocess synchronously because asyncio subprocess handling is complex for simple tasks
        # but in a real async app we should use create_subprocess_shell.
        # However, for simplicity and to match original code logic:
        
        loop = asyncio.get_event_loop()
        
        def run_cmd(cmd):
             return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=5)

        v_res = await loop.run_in_executor(None, run_cmd, f"{cmd_prefix}version --client=false -o json")
        
        v_info = "Unknown"
        if v_res.returncode == 0:
            try:
                v_json = json.loads(v_res.stdout)
                v_info = v_json.get('serverVersion', {}).get('gitVersion', 'Unknown')
            except Exception:
                pass

        n_res = await loop.run_in_executor(None, run_cmd, f"{cmd_prefix}get nodes --no-headers")
        
        nodes = n_res.stdout.strip().split('\n') if n_res.returncode == 0 and n_res.stdout.strip() else []
        node_count = len(nodes)
        not_ready = [n for n in nodes if "NotReady" in n]
        
        recon = f"Kubernetes v{v_info} | Nodes: {node_count} ({len(not_ready)} NotReady)"
        if not_ready:
            recon += f"\nWARNING: Unhealthy Nodes identified: {not_ready[:2]}"
            
        return recon
    except Exception as e:
        return f"Recon failed: {e}"

def emit_event(event_type: str, data: dict) -> dict:
    """Create an SSE event."""
    return {
        "type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **data
    }

# =============================================================================
# PLAN MANAGEMENT
# =============================================================================

def create_execution_plan(steps_description: list[str]) -> list[dict]:
    """Create a structured execution plan from step descriptions."""
    return [
        {
            "step": i + 1,
            "description": step.strip(),
            "status": "pending",
            "result": None,
            "command": None,
            "output": None
        }
        for i, step in enumerate(steps_description)
    ]

def get_current_step(plan: list[dict]) -> dict | None:
    """Get the current step that needs execution."""
    if not plan:
        return None

    for step in plan:
        if step["status"] in ["pending", "in_progress"]:
            return step

    return None  # All steps completed

def mark_step_in_progress(plan: list[dict], step_number: int) -> list[dict]:
    """Mark a step as in progress."""
    updated_plan = list(plan)
    for step in updated_plan:
        if step["step"] == step_number:
            step["status"] = "in_progress"
            break
    return updated_plan

def mark_step_completed(plan: list[dict], step_number: int, result: str, command: str = None, output: str = None) -> list[dict]:
    """Mark a step as completed with results."""
    updated_plan = list(plan)
    for step in updated_plan:
        if step["step"] == step_number:
            step["status"] = "completed"
            step["result"] = result
            step["command"] = command
            step["output"] = output
            break
    return updated_plan

def mark_step_skipped(plan: list[dict], step_number: int, reason: str) -> list[dict]:
    """Mark a step as skipped (e.g., root cause found early)."""
    updated_plan = list(plan)
    for step in updated_plan:
        if step["step"] == step_number:
            step["status"] = "skipped"
            step["result"] = f"Skipped: {reason}"
            break
    return updated_plan

def is_plan_complete(plan: list[dict]) -> bool:
    """Check if all steps are completed or skipped."""
    if not plan:
        return False
    return all(step["status"] in ["completed", "skipped"] for step in plan)

def get_plan_summary(plan: list[dict]) -> str:
    """Get a text summary of the plan status."""
    if not plan:
        return "No plan execution."
        
    lines = []
    for step in plan:
        status_icon = "[OK]" if step['status'] == 'completed' else "[X]" if step['status'] == 'skipped' else "○"
        if step['status'] == 'in_progress':
            status_icon = "[NEXT]"
            
        lines.append(f"{step['step']}. {status_icon} {step['description']}")
        
        if step.get('result'):
            # Truncate result for summary
            res = step['result']
            if len(res) > 200:
                res = res[:200] + "..."
            lines.append(f"   Result: {res}")
            
    return "\n".join(lines)

def log_session(state: dict, duration: float, status: str = "COMPLETED"):
    """Log the session details to a JSON file."""
    try:
        if not os.path.exists(LOG_DIR):
            os.makedirs(LOG_DIR, exist_ok=True)
            
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"session-{timestamp}-{status}.json"
        filepath = os.path.join(LOG_DIR, filename)
        
        log_data = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "duration_seconds": duration,
            "status": status,
            "query": state.get('query', ''),
            "llm_model": state.get('llm_model', ''),
            "final_response": state.get('final_response', ''),
            "error": state.get('error'),
            "command_history": state.get('command_history', []),
            "events": state.get('events', [])
        }
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(log_data, f, indent=2, default=str)
            
        print(f"[agent-sidecar] Session logged to {filepath}", flush=True)

        # [BRAIN] THE LIBRARY: Learn from this session
        try:
             save_session_experience(state)
        except Exception as e:
             print(f"[Library] Failed to save experience: {e}", flush=True)

    except Exception as e:
        print(f"[agent-sidecar] Failed to log session: {e}", flush=True)

def save_session_experience(state: dict):
    """Extract and save session experience to The Library."""
    if not state.get('query'): return

    # Heuristic for outcome
    outcome = "UNKNOWN"
    if state.get('error'):
        outcome = "FAILURE"
    elif float(state.get('confidence_score') or 0.0) >= 0.8:
        outcome = "SUCCESS"
    
    # Only save definitive outcomes to avoid polluting DB with noise
    if outcome == "UNKNOWN": return
    
    # Extract plan summary
    plan = "Direct Execution"
    if state.get('execution_plan'):
        plan = get_plan_summary(state['execution_plan'])
    elif state.get('current_plan'):
        plan = state['current_plan']
        
    final_resp = state.get('final_response', '')
    
    try:
        from .memory.experience import save_experience
        save_experience({
            "query": state['query'],
            "plan": plan,
            "outcome": outcome,
            "analysis": f"Final Response: {final_resp[:300]}...", # Truncate analysis
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
    except ImportError:
        pass # Handle case where memory module not fully available yet

def calculate_confidence_score(state: dict) -> float:
    """
    Calculate calibrated confidence based on evidence quality.

    Factors:
    - Number of evidence sources (commands executed)
    - KB pattern matches
    - Command success rate
    - Reflection assessment
    """
    # Start with base confidence
    confidence = 0.7  # Changed from 1.0 (was too optimistic)

    # Critical failure cases
    if state.get('error'):
        return 0.0

    command_history = state.get('command_history', [])

    # Factor 1: Evidence quantity (multiple sources = higher confidence)
    evidence_sources = len([cmd for cmd in command_history if cmd.get('output') and not cmd.get('error')])

    if evidence_sources == 0:
        return 0.1  # Almost no confidence with zero evidence

    if evidence_sources == 1:
        confidence -= 0.15  # Single source = lower confidence
    elif evidence_sources >= 3:
        confidence += 0.1  # Multiple sources = higher confidence

    # Factor 2: Command success rate
    total_commands = len(command_history)
    if total_commands > 0:
        failed_commands = len([cmd for cmd in command_history if cmd.get('error')])
        success_rate = (total_commands - failed_commands) / total_commands

        if success_rate < 0.5:
            confidence -= 0.2  # Many failures = low confidence
        elif success_rate >= 0.9:
            confidence += 0.05  # High success rate = boost confidence

    # Factor 3: KB pattern matches (if tracked in state)
    kb_matches = len(state.get('kb_context', '').split('###')) - 1  # Count ### markers
    if kb_matches >= 3:
        confidence += 0.1  # Strong KB grounding
    elif kb_matches == 0:
        confidence -= 0.05  # No KB guidance

    # Factor 4: Reflection assessment
    last_cmd = command_history[-1] if command_history else None
    if last_cmd and last_cmd.get('error'):
        confidence -= 0.2  # Recent failure

    reasoning = (state.get('reflection_reasoning') or '').lower()
    uncertain_words = ['uncertain', 'unsure', 'might', 'maybe', 'not sure', 'failed to verify', 'unclear']

    if any(w in reasoning for w in uncertain_words):
        confidence -= 0.25  # Explicit uncertainty

    # Factor 5: Investigation depth (iterations)
    iteration = state.get('iteration', 0)
    if iteration > 5:
        confidence -= 0.1  # Took many iterations = less certain path

    # Clamp to valid range
    return max(0.0, min(1.0, confidence))

def get_cached_result(state: dict, command: str) -> str | None:
    """Retrieve command output from cache if it exists and is recent."""
    if not os.path.exists(CACHE_DIR):
        return None
        
    # Only cache discovery commands
    if not any(command.startswith(p) for p in ["kubectl get", "kubectl describe", "kubectl api-resources", "kubectl diff"]):
        return None

    # Cache key based on command + context
    ctx = state.get('kube_context', 'default')
    key = f"{ctx}:{command}"
    file_hash = hashlib.md5(key.encode()).hexdigest()
    cache_path = os.path.join(CACHE_DIR, f"{file_hash}.txt")

    if os.path.exists(cache_path):
        # check age (e.g. 5 mins?)
        # For now, just return if exists (simple session caching)
        # Or check file mtime
        try:
            mtime = os.path.getmtime(cache_path)
            if (datetime.now().timestamp() - mtime) < 300: # 5 mins
                with open(cache_path, 'r', encoding='utf-8') as f:
                    return f.read()
        except Exception:
            pass
    return None

def cache_command_result(state: dict, command: str, output: str) -> dict:
    """Save command output to cache."""
    try:
        # Only cache discovery commands
        if not any(command.startswith(p) for p in ["kubectl get", "kubectl describe", "kubectl api-resources", "kubectl diff"]):
            return state

        if not os.path.exists(CACHE_DIR):
            os.makedirs(CACHE_DIR, exist_ok=True)

        ctx = state.get('kube_context', 'default')
        key = f"{ctx}:{command}"
        file_hash = hashlib.md5(key.encode()).hexdigest()
        cache_path = os.path.join(CACHE_DIR, f"{file_hash}.txt")

        with open(cache_path, 'w', encoding='utf-8') as f:
            f.write(output)
            
    except Exception as e:
        print(f"Cache write failed: {e}", flush=True)
        
    return state


def parse_kubectl_json_output(json_output: str) -> str:
    """
    Parse generic kubectl JSON output and return a human-readable summary.
    Handles both lists (KindList) and single resources.
    """
    try:
        data = json.loads(json_output)
    except json.JSONDecodeError:
        return f"Error: Failed to parse JSON output. Check syntax."

    kind = data.get('kind', 'Unknown')
    metadata = data.get('metadata', {})
    
    # Handle Lists
    if kind.endswith('List') and 'items' in data:
        items = data['items']
        count = len(items)
        if count == 0:
            return f"No {kind.replace('List', 's')} found."
            
        summary = [f"{kind}: Found {count} items"]
        
        # Summarize each item
        for i, item in enumerate(items):
            if i >= 10: # Limit list summary
                summary.append(f"... and {count - 10} more.")
                break
                
            m = item.get('metadata', {})
            name = m.get('name', 'unknown')
            ns = m.get('namespace', '-')
            
            # Status summary
            status_obj = item.get('status', {})
            phase = status_obj.get('phase', '')
            if not phase and 'conditions' in status_obj:
                # Find True condition
                true_conds = [c['type'] for c in status_obj['conditions'] if c.get('status') == 'True']
                phase = ', '.join(true_conds[:2])
            
            status_str = f" | Status: {phase}" if phase else ""
            summary.append(f"- {name} (ns: {ns}){status_str}")
            
        return "\\n".join(summary)

    # Handle Single Object
    else:
        name = metadata.get('name', 'unknown')
        ns = metadata.get('namespace', 'default')
        
        # simplified yaml-like dump for single object
        # remove managedFields to reduce noise
        if 'managedFields' in metadata:
            del metadata['managedFields']
            
        return f"Resource: {kind}/{name} (ns: {ns})\\nData: {json.dumps(data, indent=2)}"




