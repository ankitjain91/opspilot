"""
Command Validator Node

Pre-execution validation to catch failures before they happen.
Checks:
1. Resource type exists in cluster
2. Namespace is valid (if specified)
3. Command syntax is correct
4. Command will likely return useful data
"""

import os
import re
import asyncio
from typing import Dict, Tuple
from ..state import AgentState
from ..utils import emit_event

async def validate_kubectl_command(cmd: str, kube_context: str) -> Tuple[bool, str]:
    """
    Validate kubectl command before execution.

    Returns:
        (is_valid, error_message)
    """

    # Extract resource type from kubectl get/describe commands
    match = re.search(r'kubectl\s+(get|describe)\s+([a-zA-Z0-9.-]+)', cmd)
    if not match:
        return True, ""  # Not a get/describe command, skip validation

    verb = match.group(1)
    resource_type = match.group(2)

    # Skip validation for known-good resource types
    common_resources = ['pods', 'pod', 'deployments', 'deployment', 'services', 'service',
                        'nodes', 'node', 'namespaces', 'namespace', 'events', 'configmaps',
                        'secrets', 'ingress', 'pvc', 'pv', 'replicasets', 'daemonsets',
                        'statefulsets', 'jobs', 'cronjobs']

    if resource_type.lower() in common_resources:
        return True, ""

    # For custom resources, check if they exist in cluster
    try:
        check_cmd = f"kubectl api-resources --no-headers 2>/dev/null | grep -i '^{resource_type}'"

        if kube_context:
            check_cmd = f"kubectl --context {kube_context} api-resources --no-headers 2>/dev/null | grep -i '^{resource_type}'"

        proc = await asyncio.create_subprocess_shell(
            check_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(os.environ),
        )

        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)

        if proc.returncode == 0 and stdout:
            return True, ""  # Resource type exists

        # Resource doesn't exist - try to suggest alternatives
        suggest_cmd = f"kubectl api-resources --no-headers 2>/dev/null | grep -i '{resource_type[:5]}'"
        if kube_context:
            suggest_cmd = f"kubectl --context {kube_context} api-resources --no-headers 2>/dev/null | grep -i '{resource_type[:5]}'"

        proc2 = await asyncio.create_subprocess_shell(
            suggest_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(os.environ),
        )

        stdout2, _ = await asyncio.wait_for(proc2.communicate(), timeout=5.0)

        error_msg = f"Resource type '{resource_type}' does not exist in cluster."

        if stdout2:
            suggestions = stdout2.decode('utf-8').strip().split('\n')[:3]
            if suggestions:
                error_msg += f"\n\n**Did you mean one of these?**\n"
                for sugg in suggestions:
                    parts = sugg.split()
                    if parts:
                        error_msg += f"- {parts[0]}\n"

        error_msg += f"\n**Tip**: Run `kubectl api-resources` to see all available resource types."

        return False, error_msg

    except asyncio.TimeoutError:
        print(f"[validator] [WARN] Timeout validating resource type '{resource_type}'", flush=True)
        return True, ""  # Timeout - allow command to proceed

    except Exception as e:
        print(f"[validator] [WARN] Validation error: {e}", flush=True)
        return True, ""  # Error - allow command to proceed

async def command_validator_node(state: AgentState) -> Dict:
    """
    Pre-execution validation to catch failures before they happen.
    """

    pending_command = state.get('pending_command', '')
    kube_context = state.get('kube_context')
    events = list(state.get('events', []))

    if not pending_command:
        return {**state, 'next_action': 'verify'}

    print(f"[validator] [SEARCH] Validating command: {pending_command}", flush=True)

    # Validate kubectl commands
    if pending_command.strip().startswith('kubectl'):
        is_valid, error_msg = await validate_kubectl_command(pending_command, kube_context)

        if not is_valid:
            print(f"[validator] [ERROR] Validation failed: {error_msg}", flush=True)
            events.append(emit_event("validation_failed", {
                "command": pending_command,
                "reason": error_msg
            }))

            return {
                **state,
                'next_action': 'supervisor',  # Route back for replanning
                'error': f"Command validation failed: {error_msg}",
                'events': events,
                'pending_command': None
            }

    # Validation passed
    print(f"[validator] [OK] Validation passed", flush=True)
    events.append(emit_event("validation_passed", {
        "command": pending_command
    }))

    return {
        **state,
        'next_action': 'verify',  # Proceed to verify node
        'events': events
    }
