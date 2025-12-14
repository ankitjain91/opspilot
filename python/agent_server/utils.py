
import re
import json
import subprocess
import asyncio
from datetime import datetime, timezone
from typing import List, Dict, Optional, Any
import os
import hashlib
from .config import DANGEROUS_VERBS, LARGE_OUTPUT_VERBS, AZURE_MUTATION_VERBS, AZURE_SAFE_COMMANDS, MAX_OUTPUT_LENGTH, LOG_DIR, CACHE_DIR

def is_safe_command(cmd: str) -> tuple[bool, str]:
    """Check if a command is safe (read-only) and requires approval.

    Supports both kubectl and Azure CLI commands.
    Azure CLI: ONLY read operations allowed (show, list, get). ALL mutations blocked.
    """
    lower = cmd.lower().strip()

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

    if any(verb in lower for verb in LARGE_OUTPUT_VERBS):
        return False, "LARGE_OUTPUT"

    return True, "SAFE"

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

def format_command_history(history: list) -> str:
    """Format command history for the LLM prompt.

    Limits to last 5 commands to prevent context overflow.
    Uses smart truncation to keep only important output rows.
    """
    if not history:
        return '(none yet)'

    # Limit to last 5 commands to reduce context size
    recent_history = history[-5:] if len(history) > 5 else history

    lines = []
    for i, h in enumerate(recent_history, 1):
        # Use smart truncation for kubectl output to keep error rows
        if h.get('error'):
            result = f"ERROR: {h['error']}"
        else:
            # Smart truncate keeps headers + problem rows, omits healthy resources
            result = smart_truncate_output(h['output'], max_chars=3000)

        assessment = f"\nREFLECTION: {h['assessment']} - {h.get('reasoning', '')}" if h.get('assessment') else ""
        lines.append(f"[{i}] $ {h['command']}\n{result}{assessment}")

    if len(history) > 5:
        lines.insert(0, f"(Showing last 5 of {len(history)} commands)")

    return '\n\n'.join(lines)

def format_conversation_context(history: list[dict]) -> str:
    """Format previous conversation turns (User/Assistant) for context."""
    if not history:
        return "(No previous context)"
    
    lines = []
    for msg in history:
        role = msg.get('role', 'unknown').upper()
        content = msg.get('content', '').strip()
        # Skip system signals or tool outputs if they leaked into conversation history
        if role in ['USER', 'ASSISTANT', 'SUPERVISOR', 'SCOUT']:
            lines.append(f"{role}: {content}")
            
    return '\n'.join(lines)

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
        status_icon = "✓" if step['status'] == 'completed' else "✗" if step['status'] == 'skipped' else "○"
        if step['status'] == 'in_progress':
            status_icon = "➤"
            
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
    except Exception as e:
        print(f"[agent-sidecar] Failed to log session: {e}", flush=True)

def calculate_confidence_score(state: dict) -> float:
    """Calculate confidence based on history and reflection."""
    confidence = 1.0
    
    # Decrease confidence if there was an error
    if state.get('error'):
        confidence = 0.0
        return confidence
        
    last_cmd = state['command_history'][-1] if state.get('command_history') else None
    if last_cmd and last_cmd.get('error'):
        confidence -= 0.3
        
    reasoning = state.get('reflection_reasoning', '').lower()
    uncertain_words = ['uncertain', 'unsure', 'might', 'maybe', 'not sure', 'failed to verify']
    
    
    if any(w in reasoning for w in uncertain_words):
        confidence -= 0.4
        
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
