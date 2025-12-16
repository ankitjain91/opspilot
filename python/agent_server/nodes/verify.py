
import re
import json
from ..state import AgentState
from ..prompts.worker.main import VERIFY_COMMAND_PROMPT
from ..llm import call_llm
from ..parsing import clean_json_response
from ..utils import emit_event, is_safe_command
from ..context_builder import validate_command_has_no_placeholders

async def verify_command_node(state: AgentState) -> dict:
    """Verification Node (70B): Checks the worker's command and safety."""
    events = list(state.get('events', []))
    command = state.get('pending_command', '')

    if not command:
        return {**state, 'next_action': 'execute'}

    # LOOP PREVENTION: Track blocked commands to prevent infinite retry loops
    # Medium #12 fix: Limit list to last 10 entries and deduplicate
    blocked_commands = list(dict.fromkeys(state.get('blocked_commands', [])))[-10:]
    block_count = blocked_commands.count(command)

    if block_count >= 3:
        # This exact command was blocked multiple times - supervisor is stuck in a loop
        events.append(emit_event("error", {
            "message": f"Command '{command}' was blocked {block_count} times. Stopping to prevent infinite loop.",
            "blocked_count": len(blocked_commands)
        }))

        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {
                    'command': command,
                    'output': '',
                    'error': f'LOOP DETECTED: This command was blocked {block_count} times. The agent is stuck trying the same invalid command repeatedly.'
                }
            ],
            'blocked_commands': blocked_commands,
            'error': 'Command retry loop detected',
            'events': events,
        }

    # HARD GUARD: Context Name != Namespace
    # Prevent the agent from confusing the cluster context name with a namespace
    current_context = state.get('kube_context')
    if current_context and len(current_context) > 2: # Avoid blocking short names just in case
        # Check if context name is used as argument to -n or --namespace
        # Simple string check first for speed
        if f"-n {current_context}" in command or f"--namespace {current_context}" in command or f"-n={current_context}" in command:
             events.append(emit_event("blocked", {"command": command, "reason": "context_name_used_as_namespace"}))
             return {
                **state,
                'next_action': 'supervisor',
                'command_history': state['command_history'] + [
                    {
                        'command': command,
                        'output': '',
                        'error': f"BLOCKED: You are using the Cluster Context Name ('{current_context}') as the Namespace. This is incorrect. Context != Namespace. Please run 'kubectl get pods -A | grep <name>' to discover the actual namespace."
                    }
                ],
                'blocked_commands': blocked_commands + [command],
                'events': events,
            }

    # AI-FRIENDLY PLACEHOLDER CHECK - give helpful feedback instead of just blocking
    is_valid, error_message = validate_command_has_no_placeholders(
        command,
        state.get('discovered_resources')
    )
    if not is_valid:
        events.append(emit_event("blocked", {"command": command, "reason": "placeholders_detected"}))
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {
                    'command': command,
                    'output': '',
                    'error': f'PLACEHOLDER DETECTED: {error_message}'
                }
            ],
            'blocked_commands': blocked_commands + [command],
            'events': events,
        }

    # Hard guard: block complex shell with variables or command substitution
    # Only match variable assignments at start of command or after separators (not kubectl flags like --sort-by=)
    if re.search(r'(^|[;&|])\s*[A-Za-z_][A-Za-z0-9_]*=', command) or '$(' in command or '${' in command:
        events.append(emit_event("blocked", {"command": command, "reason": "complex_shell"}))
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {
                    'command': command,
                    'output': '',
                    'error': 'Blocked: Command uses shell variables or command substitution. '
                                   'Generate a single simple kubectl command instead (no NS=..., no POD_NAME=..., no $(...)).'
                }
            ],
            'blocked_commands': blocked_commands + [command],
            'events': events,
        }

    is_safe, reason = is_safe_command(command)

    if not is_safe and reason == "MUTATING":
        events.append(emit_event("blocked", {"command": command, "reason": "mutating"}))
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {'command': command, 'output': '', 'error': 'Blocked: Command contains dangerous kubectl verbs (delete, apply, etc.)'}
            ],
            'blocked_commands': blocked_commands + [command],
            'events': events,
        }

    if not is_safe and reason == "AZURE_MUTATING":
        events.append(emit_event("blocked", {"command": command, "reason": "azure_mutating"}))
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {'command': command, 'output': '', 'error': 'Blocked: Azure mutation command detected (create, delete, update, etc.). Only read-only Azure commands allowed (show, list, get).'}
            ],
            'blocked_commands': blocked_commands + [command],
            'events': events,
        }

    if not is_safe and reason == "AZURE_UNKNOWN":
        events.append(emit_event("blocked", {"command": command, "reason": "azure_unknown"}))
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {'command': command, 'output': '', 'error': 'Blocked: Unknown Azure command. Only whitelisted read-only Azure commands are allowed (az <resource> show/list).'}
            ],
            'blocked_commands': blocked_commands + [command],
            'events': events,
        }

    if not is_safe and reason == "REMEDIATION":
        print(f"[verify] ⚠️ Triggering approval for REMEDIATION: {command}", flush=True)
        events.append(emit_event("awaiting_approval", {"command": command, "reason": "remediation"}))
        return {
            **state,
            'next_action': 'human_approval',
            'awaiting_approval': True,
            'events': events,
        }

    if not is_safe and reason == "LARGE_OUTPUT":
        # LARGE_OUTPUT commands are read-only and safe - no approval needed
        # Just log and continue to execution
        print(f"[verify] ℹ️ LARGE_OUTPUT command (safe, no approval needed): {command}", flush=True)
        events.append(emit_event("reflection", {"assessment": "VERIFIED", "reasoning": "Large output command - read-only and safe"}))
        return {**state, 'next_action': 'execute', 'events': events}

    prompt = VERIFY_COMMAND_PROMPT.format(
        plan=state.get('current_plan', 'Unknown'),
        command=command
    )
    
    try:
        # Use executor model (32B) for verification - it's rule-based checking, not complex reasoning
        # This is 40% faster than using the 70B brain model
        executor_model = state.get('executor_model', 'k8s-cli')
        response = await call_llm(prompt, state['llm_endpoint'], executor_model, state.get('llm_provider', 'ollama'), temperature=0.0, api_key=state.get('api_key'))

        try:
            cleaned = clean_json_response(response)
            data = json.loads(cleaned)
            approved_syntax = data.get("approved", True)
            thought = data.get("thought", "")
            corrected = data.get("corrected_command", "")
        except Exception:
            approved_syntax = True
            thought = "Failed to parse verification, assuming safe."
            corrected = ""

        if approved_syntax:
            events.append(emit_event("reflection", {"assessment": "VERIFIED", "reasoning": "Command looks good."}))
            return {**state, 'next_action': 'execute'}
        else:
            new_command = corrected if corrected.strip() else command

            # CRITICAL: Validate the corrected command doesn't have placeholders
            is_corrected_valid, corrected_error = validate_command_has_no_placeholders(
                new_command,
                state.get('discovered_resources')
            )
            if not is_corrected_valid:
                # LLM introduced placeholders in "correction" - block it
                events.append(emit_event("blocked", {"command": new_command, "reason": "corrected_command_has_placeholders"}))
                return {
                    **state,
                    'next_action': 'supervisor',
                    'command_history': state['command_history'] + [
                        {
                            'command': new_command,
                            'output': '',
                            'error': f'PLACEHOLDER IN CORRECTED COMMAND: {corrected_error}\n\nOriginal command: {command}'
                        }
                    ],
                    'blocked_commands': blocked_commands + [command, new_command],
                    'events': events,
                }

            events.append(emit_event("reflection", {"assessment": "CORRECTED", "reasoning": f"Modifying command: {thought}"}))
            return {
                **state,
                'next_action': 'execute',
                'pending_command': new_command
            }

    except Exception:
        # On verifier errors, just execute to avoid blocking
        return {**state, 'next_action': 'execute'}

async def human_approval_node(state: AgentState) -> dict:
    """Node that stalls execution until user approval is received.

    CRITICAL: This node should only execute ONCE per approval request.
    If it executes multiple times, it indicates a graph configuration bug.
    We add a counter to detect and break infinite loops.
    """
    if state.get('approved'):
        events = list(state.get('events', []))
        events.append(emit_event("progress", {"message": "Human approved execution. Resuming."}))
        return {
            **state,
            'next_action': 'execute',
            'awaiting_approval': False,
            'approved': False,
            'events': events,
        }

    # CRITICAL GUARD: Detect if we're being called repeatedly (graph bug)
    approval_loop_count = state.get('approval_loop_count', 0) + 1

    if approval_loop_count > 2:
        # The graph is stuck in an approval loop - this is a BUG
        # Generate an error response instead of looping forever
        print(f"[human_approval] ❌ CRITICAL: Approval loop detected ({approval_loop_count} iterations). Breaking loop.", flush=True)

        from ..response_formatter import format_intelligent_response_with_llm, _format_simple_fallback

        # Try to use LLM to generate intelligent response from available data
        try:
            error_response = await format_intelligent_response_with_llm(
                query=state.get('query', ''),
                command_history=state.get('command_history', []),
                discovered_resources=state.get('discovered_resources', {}),
                hypothesis=state.get('current_hypothesis'),
                llm_endpoint=state.get('llm_endpoint'),
                llm_model=state.get('llm_model'),
                llm_provider=state.get('llm_provider', 'ollama'),
                accumulated_evidence=state.get('accumulated_evidence', []),
                api_key=state.get('api_key')
            )
        except Exception as e:
            # Fallback to simple formatter if LLM call fails
            print(f"[human_approval] ⚠️ LLM fallback failed: {e}, using simple fallback", flush=True)
            error_response = _format_simple_fallback(
                state.get('query', ''),
                state.get('command_history', []),
                state.get('discovered_resources', {})
            )

        # Append error notice
        error_response += "\n\n⚠️ **Note**: This command requires manual approval, but the workflow encountered an error while waiting for approval. Please run the agent again and approve the command when prompted."

        return {
            **state,
            'final_response': error_response,
            'next_action': 'done',
            'awaiting_approval': False,
            'error': 'Approval loop detected - graph configuration bug'
        }

    # Normal approval wait - increment counter and return
    return {
        **state,
        'next_action': 'human_approval',
        'awaiting_approval': True,
        'approval_loop_count': approval_loop_count
    }
