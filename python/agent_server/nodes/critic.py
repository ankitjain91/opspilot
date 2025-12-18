import json
from ..state import AgentState
from ..prompts.critic import CRITIC_PROMPT
from ..llm import call_llm
from ..utils import emit_event, escape_braces
from ..context_builder import build_discovered_context
from ..compass import CompassValidator

async def critic_node(state: AgentState) -> dict:
    """The Judge: Reviews plans before they are executed."""

    plan = state.get('execution_plan')
    current_plan_text = state.get('current_plan')
    query = state.get('query')
    original_action = state.get('next_action', 'approved') # Capture original intent

    events = list(state.get('events', []))

    # 📐 THE COMPASS: Pre-validate kubectl apply manifests
    # Check if this is a kubectl_apply action and run schema/policy validation
    if original_action in ['delegate', 'batch_delegate']:
        try:
            # Parse tool call from plan
            if current_plan_text and 'kubectl_apply' in current_plan_text.lower():
                # Try to extract YAML from structured tool call
                tool_data = json.loads(current_plan_text) if current_plan_text.startswith('{') else {}
                if tool_data.get('tool') == 'kubectl_apply':
                    yaml_content = tool_data.get('yaml_content', '')
                    if yaml_content:
                        print(f"[agent-sidecar] 📐 THE COMPASS: Validating manifest schema...", flush=True)
                        events.append(emit_event("progress", {"message": "📐 The Compass: Validating manifest..."}))

                        is_valid, error_msg = CompassValidator.validate_manifest(
                            yaml_content,
                            kube_context=state.get('kube_context')
                        )

                        if not is_valid:
                            print(f"[agent-sidecar] 📐 COMPASS REJECTED: {error_msg}", flush=True)
                            events.append(emit_event("error", {"message": f"📐 Compass Validation Failed: {error_msg}"}))
                            return {
                                **state,
                                'next_action': 'supervisor',
                                'events': events,
                                'critic_feedback': f"Manifest validation failed: {error_msg}",
                                'command_history': state['command_history'] + [{
                                    'command': 'schema_validation',
                                    'output': f"COMPASS REJECTED MANIFEST: {error_msg}",
                                    'error': 'Schema/policy validation failed.',
                                    'assessment': 'FAILED'
                                }]
                            }
                        elif error_msg:
                            # Valid but with warnings
                            print(f"[agent-sidecar] 📐 COMPASS APPROVED (with warnings): {error_msg}", flush=True)
                            events.append(emit_event("warning", {"message": f"📐 {error_msg}"}))
        except Exception as e:
            print(f"[agent-sidecar] 📐 Compass check skipped: {e}", flush=True)

    # If no plan (direct delegation or simple response), skip critic?
    # For now, let's critique structured plans and MCP tool calls.

    plan_description = ""
    if plan and original_action == 'create_plan':
        plan_description = json.dumps(plan, indent=2)
    elif current_plan_text and original_action in ['delegate', 'batch_delegate']:
        plan_description = current_plan_text
    elif state.get('pending_tool_call') or original_action == 'invoke_mcp':
        plan_description = json.dumps(state.get('pending_tool_call', {}), indent=2)
    else:
        # Nothing to critique (maybe direct response?)
        return {**state, 'next_action': original_action, 'events': events} # Pass through

    print(f"[agent-sidecar] 👩‍⚖️ The Judge is reviewing the plan...", flush=True)
    events.append(emit_event("progress", {"message": "👩‍⚖️ The Judge is reviewing the plan for safety..."}))
    
    discovered_context = build_discovered_context(state.get('discovered_resources'))
    
    prompt = CRITIC_PROMPT.format(
        query=escape_braces(query),
        plan=escape_braces(plan_description),
        context=escape_braces(discovered_context)
    )
    
    try:
        # specialized critic model? or use same brain model?
        # Ideally a stronger model, but we default to brain model.
        # Maybe use 'executor_model' if it's smarter? Usually Brain is smartest.
        response = await call_llm(
            prompt, 
            state['llm_endpoint'], 
            state['llm_model'], 
            state.get('llm_provider', 'ollama'),
            temperature=0.0, # Strict
            force_json=True,
            api_key=state.get('api_key')
        )
        
        result = json.loads(response)
        approved = result.get('approved', False)
        critique = result.get('critique', 'No specific critique provided.')
        
        if approved:
            print(f"[agent-sidecar] 👩‍⚖️ Plan APPROVED.", flush=True)
            events.append(emit_event("progress", {"message": "✅ Plan Approved by The Judge."}))
            return {
                **state,
                'next_action': original_action, # Restore original action
                'events': events
            }
        else:
            print(f"[agent-sidecar] 👩‍⚖️ Plan REJECTED: {critique}", flush=True)
            events.append(emit_event("warning", {"message": f"⛔ Plan Rejected: {critique}"}))

            # Feed critique back to supervisor WITHOUT adding to command_history
            # The critic feedback is not evidence from kubectl - it's planning feedback
            # Adding it to command_history confuses the supervisor into thinking it has "evidence"

            return {
                **state,
                'next_action': 'supervisor', # Go back to planning
                'events': events,
                'critic_feedback': critique, # Supervisor will see this and incorporate into next plan
                # DO NOT add to command_history - this is not kubectl output
            }

    except Exception as e:
        print(f"[agent-sidecar] ⚠️ Critic failed: {e}. Defaulting to APPROVE (Fail-open to avoid stuck agent).", flush=True)
        # FIX: Return 'execute_plan' (valid routing value) instead of 'approved' (invalid)
        return {**state, 'next_action': 'execute_plan', 'events': events}
