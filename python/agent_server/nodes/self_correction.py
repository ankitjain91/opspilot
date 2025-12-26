"""
Self-Correction Node - Validates tool JSON and corrects kubectl commands.

Two-stage correction:
1. Tool JSON validation (schema conformance)
2. Kubectl command correction (syntax, common mistakes)

Prevents common command failures before execution.
"""

from typing import Dict, Optional, Tuple
import json
import re
from pydantic import ValidationError
from ..state import AgentState
from ..tools.definitions import AgentToolWrapper
from ..llm import call_llm
from ..utils import emit_event

CORRECTION_PROMPT = """You produced tool JSON that failed validation. Fix it.

Schema errors:
{errors}

Original JSON:
{original}

Return ONLY corrected JSON that conforms to the schema. No prose.
"""

def correct_kubectl_command(cmd: str) -> Tuple[str, Optional[str]]:
    """
    Apply common kubectl command corrections.

    Returns:
        (corrected_command, correction_reason) or (original_command, None)
    """

    # Correction 1: kubectl get managed (too broad, causes timeout)
    if re.search(r'kubectl\s+get\s+managed(?:\s|$)', cmd):
        return (
            'kubectl api-resources | grep -i managed',
            "Replaced 'kubectl get managed' with 'kubectl api-resources | grep' to avoid timeout on large output"
        )

    # Correction 2: Missing -A flag for namespaced resources
    # Only if no namespace flag present
    if re.search(r'kubectl\s+get\s+', cmd) and '-n ' not in cmd and '-A' not in cmd and '--all-namespaces' not in cmd:
        # Extract resource type
        match = re.search(r'kubectl\s+get\s+([a-zA-Z0-9-]+)', cmd)
        if match:
            resource = match.group(1)
            # Check if it's a known namespaced resource
            namespaced_resources = [
                'pod', 'pods', 'po',
                'deployment', 'deployments', 'deploy',
                'service', 'services', 'svc',
                'configmap', 'configmaps', 'cm',
                'secret', 'secrets',
                'replicaset', 'replicasets', 'rs',
                'statefulset', 'statefulsets', 'sts',
                'daemonset', 'daemonsets', 'ds',
                'job', 'jobs',
                'cronjob', 'cronjobs',
                'ingress', 'ingresses'
            ]

            if resource.lower() in namespaced_resources:
                corrected = cmd.replace('kubectl get', 'kubectl get -A', 1)
                return (corrected, f"Added -A flag for namespaced resource '{resource}' to search all namespaces")

    # Correction 3: kubectl get all (too broad, add namespace filter)
    if re.search(r'kubectl\s+get\s+all(?:\s|$)', cmd) and '-n ' not in cmd and '-A' not in cmd:
        corrected = cmd.replace('kubectl get all', 'kubectl get all -A', 1)
        return (corrected, "Added -A flag to 'kubectl get all' for cluster-wide search")

    # Correction 4: Missing --context when kube_context is set
    # (This would require state, so we skip for now - handled by worker node)

    # Correction 5: kubectl logs without tail limit (can hang on large logs)
    if re.search(r'kubectl\s+logs\s+', cmd) and '--tail' not in cmd and '--since' not in cmd:
        # Insert --tail=100 after 'logs'
        corrected = re.sub(r'(kubectl\s+logs)\s+', r'\1 --tail=100 ', cmd, count=1)
        return (corrected, "Added --tail=100 to kubectl logs to prevent hanging on large log files")

    # Correction 6: kubectl exec without explicit command separator
    if 'kubectl exec' in cmd and ' -- ' not in cmd and '-c ' in cmd:
        # This is risky, but common mistake is: kubectl exec -it pod -c container sh
        # Should be: kubectl exec -it pod -c container -- sh
        # Find the last token (likely the command)
        tokens = cmd.split()
        if len(tokens) > 0 and tokens[-1] in ['sh', 'bash', 'ash', '/bin/sh', '/bin/bash']:
            corrected = ' '.join(tokens[:-1]) + ' -- ' + tokens[-1]
            return (corrected, "Added command separator '--' before shell command in kubectl exec")

    # No corrections needed
    return (cmd, None)

async def self_correction_node(state: AgentState) -> Dict:
    """
    Two-stage self-correction:
    1. Tool JSON schema validation
    2. Kubectl command syntax correction
    """
    events = list(state.get('events', []))
    raw_json = state.get('pending_tool_json')
    pending_command = state.get('pending_command', '')

    # STAGE 1: Tool JSON Validation (if present)
    if raw_json:
        try:
            parsed = json.loads(raw_json)
            _ = AgentToolWrapper(tool_call=parsed)
            # Valid: proceed to command correction
            events.append(emit_event("reflection", {"assessment": "TOOL_JSON_VALID"}))
        except (json.JSONDecodeError, ValidationError) as e:
            # Ask model to correct JSON
            errors = str(e)
            prompt = CORRECTION_PROMPT.format(errors=errors, original=raw_json)
            try:
                corrected = await call_llm(
                    prompt,
                    state.get('llm_endpoint'),
                    state.get('executor_model', state.get('llm_model')),
                    state.get('llm_provider', 'ollama'),
                    temperature=0.0,
                    api_key=state.get('api_key')
                )
                # Re-validate
                parsed = json.loads(corrected)
                _ = AgentToolWrapper(tool_call=parsed)
                events.append(emit_event("reflection", {"assessment": "TOOL_JSON_CORRECTED"}))
                state = {**state, 'pending_tool_json': corrected}
            except Exception as e2:
                events.append(emit_event("error", {"message": f"Tool JSON correction failed: {e2}"}))
                # Fallback: route back to supervisor with explicit request
                return {
                    **state,
                    'next_action': 'supervisor',
                    'current_plan': 'Regenerate tool JSON with correct schema',
                    'error': 'Tool JSON invalid and correction failed',
                    'events': events,
                }

    # STAGE 2: Kubectl Command Correction (if present)
    if pending_command and pending_command.strip().startswith('kubectl'):
        corrected_cmd, reason = correct_kubectl_command(pending_command)

        if reason:
            # Command was corrected
            print(f"[self_correction] [FIX] Corrected kubectl command:", flush=True)
            print(f"  Original: {pending_command}", flush=True)
            print(f"  Corrected: {corrected_cmd}", flush=True)
            print(f"  Reason: {reason}", flush=True)

            events.append(emit_event("self_corrected", {
                "original": pending_command,
                "corrected": corrected_cmd,
                "reason": reason
            }))

            state = {**state, 'pending_command': corrected_cmd}

    # Proceed to next stage (command_validator)
    return {**state, 'next_action': 'command_validator', 'events': events}
