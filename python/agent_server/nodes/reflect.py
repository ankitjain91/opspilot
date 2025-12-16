
from ..state import AgentState
from ..state import AgentState
from ..prompts.reflect.main import REFLECT_PROMPT
from ..llm import call_llm
from ..parsing import parse_reflection
from ..utils import truncate_output, emit_event
from ..context_builder import build_discovered_context

async def reflect_node(state: AgentState) -> dict:
    """Reflect Node (70B): Assesses the result."""
    events = list(state.get('events', []))
    last_cmd = state['command_history'][-1]
    last_output = last_cmd.get('output') or last_cmd.get('error') or '(no output)'

    # Ensure last_output is always a string
    if last_output is None:
        last_output = '(no output)'

    # CODE-LEVEL SAFETY CHECK: Detect "empty output = success" for find queries
    # This prevents unnecessary LLM calls and guarantees correct behavior
    query_lower = (state.get('query') or '').lower().strip()
    is_find_query = any(kw in query_lower for kw in [
        'find', 'show', 'any', 'which', 'list ', 'get ', 'crashloop', 'failing', 'broken', 'unhealthy'
    ])
    is_empty_output = last_output.strip() in ['', '(no output)'] or (
        not last_cmd.get('error') and len(last_output.strip()) == 0
    )

    if is_find_query and is_empty_output and not last_cmd.get('error'):
        # Shortcut: Empty output for find query = no matching resources found
        print(f"[agent-sidecar] ⚡ Safety check: Empty output for find query → AUTO-SOLVED", flush=True)

        # Create reflection without final_response so synthesizer generates it
        reflection = {
            "directive": "SOLVED",
            "found_solution": True,
            "thought": f"No matching resources found for '{state['query']}'",
            "verified_facts": [f"No failing/broken pods found in the cluster"],
            "next_step_hint": "",
            "reason": "Empty command output indicates no resources match the search criteria"
        }

        assessment = "SOLVED"
        events.append(emit_event("reflection", {
            "assessment": assessment,
            "reasoning": reflection["thought"],
            "found_solution": True,
        }))

        updated_history = list(state['command_history'])
        feedback = reflection["thought"]
        updated_history[-1] = {
            **updated_history[-1],
            'assessment': "SOLVED",
            'useful': True,
            'reasoning': feedback,
        }

        # Route to synthesizer for proper response generation
        # Don't provide final_response here - let synthesizer create it
        accumulated_evidence = state.get('accumulated_evidence', [])

        # Check if we're in plan execution mode
        execution_plan = state.get('execution_plan')
        if execution_plan:
            # In plan mode: Store reflection and let plan_executor handle routing
            return {
                **state,
                'next_action': 'execute_next_step',  # Return to plan executor
                'command_history': updated_history,
                'reflection_reasoning': reflection["thought"],
                'accumulated_evidence': accumulated_evidence + [reflection["thought"]],
                'last_reflection': reflection,  # Store structured reflection
                'events': events,
            }
        else:
            # Simple delegate mode: Route to synthesizer
            return {
                **state,
                'next_action': 'synthesizer',  # Let synthesizer generate proper final response
                'command_history': updated_history,
                'reflection_reasoning': reflection["thought"],
                'accumulated_evidence': accumulated_evidence + [reflection["thought"]],
                'last_reflection': reflection,  # Store structured reflection
                'events': events,
            }

    # Native AI Refactor: Removed regex-based "Phase 2" Semantic Checks.
    # The Reflection LLM (70B) is fully capable of reading "Connection Refused" 
    # or "Namespace Not Found" from the output and deciding the next step.
    # Hardcoded checks here were causing false positives/negatives.

    # Build discovered context for reflection
    discovered_context_str = build_discovered_context(state.get('discovered_resources'))

    # Format accumulated evidence
    accumulated_evidence = state.get('accumulated_evidence', [])
    evidence_str = "\n".join([f"- {fact}" for fact in accumulated_evidence]) if accumulated_evidence else "(No evidence accumulated yet)"

    # Get current step description if in plan execution
    current_step = state.get('current_plan', 'N/A')

    prompt = REFLECT_PROMPT.format(
        query=state['query'],
        last_command=last_cmd['command'],
        result=truncate_output(last_output, 8000),
        hypothesis=state.get('current_hypothesis', 'None'),
        discovered_context=discovered_context_str,
        accumulated_evidence=evidence_str,
        current_step=current_step
    )

    try:
        # Low #20 fix: Add 30s timeout to prevent hangs
        import asyncio
        response = await asyncio.wait_for(
            call_llm(prompt, state['llm_endpoint'], state['llm_model'], state.get('llm_provider', 'ollama'), temperature=0.2, api_key=state.get('api_key')),
            timeout=30.0
        )
        reflection = parse_reflection(response)

        # Hypothesis Validation Logic
        current_hypothesis = state.get('current_hypothesis')
        new_hypothesis = reflection.get('hypothesis', current_hypothesis)

        # If reflection suggests updating hypothesis based on new evidence, use it
        if not new_hypothesis or new_hypothesis == current_hypothesis:
            # Keep existing hypothesis if reflection didn't provide a better one
            new_hypothesis = current_hypothesis

        # Process Directive
        directive = reflection.get('directive', 'CONTINUE')
        verified_facts = reflection.get('verified_facts', [])
        
        # Log decision
        print(f"[agent-sidecar] 🧠 Reflection Decision: {directive}", flush=True)
        if verified_facts:
            print(f"[agent-sidecar] 📝 New Facts: {verified_facts}", flush=True)
            
        events.append(emit_event("reflection", {
            "assessment": directive,
            "reasoning": reflection["thought"],
            "found_solution": (directive == 'SOLVED'),
            "verified_facts": verified_facts
        }))

        updated_history = list(state['command_history'])
        
        feedback = reflection["thought"]
        if directive == 'SOLVED':
            feedback += f"\nSOLUTION FOUND: {reflection.get('final_response', '')}"
        elif directive == 'RETRY':
            feedback += f"\nRETRY HINT: {reflection.get('next_command_hint', '')}"
        elif directive == 'ABORT':
             feedback += f"\nABORT REASON: {reflection.get('reason', '')}"

        updated_history[-1] = {
            **updated_history[-1],
            'assessment': directive,
            'useful': (directive != 'RETRY'),
            'reasoning': feedback,
        }
        
        # --- Heuristic: Adaptive Log Expansion ---
        # If the last command was a log fetching command and it provided no useful errors,
        # but the pod is known to be broken, we should RETRY with a larger sample.
        last_cmd_str = last_cmd.get('command', '')
        if 'kubectl logs' in last_cmd_str and not reflection.get('found_solution', False):
            # Check if we already retried this
            retry_count = state.get('retry_count', 0)
            
            # If the thought explicitly says "no errors found" or "inconclusive"
            thought_lower = reflection.get('thought', '').lower()
            if any(msg in thought_lower for msg in ['no errors', 'clean logs', 'didn\'t see any issues', 'inconclusive']):
                
                # Look for --tail flag
                import re
                match = re.search(r'--tail=(\d+)', last_cmd_str)
                current_tail = int(match.group(1)) if match else 100
                
                # If tail is small, suggest expanding
                if current_tail < 2000 and retry_count < 2:
                    new_tail = current_tail * 5 # 100 -> 500 -> 2500
                    print(f"[agent-sidecar] 🔍 Logs inconclusive. Expanding tail to {new_tail}...", flush=True)
                    
                    return {
                        **state,
                        "last_reflection": {
                            "directive": "RETRY",
                            "reason": "Logs were inconclusive. I need to check a larger log window.",
                            "thought": f"The logs didn't show the error. I will increase --tail to {new_tail} to see previous events.",
                            "next_step_hint": f"Run the same log command but with --tail={new_tail} (or use --previous if crashed)"
                        },
                        "events": events + [emit_event("reflection", {"assessment": "ZOOM_OUT", "reasoning": f"Logs inconclusive. expanding search window."})],
                        "next_action": "execute_next_step"
                    }

        # ROUTING DECISION: Are we in a plan or simple delegate mode?
        execution_plan = state.get('execution_plan')
        if execution_plan:
            # IN PLAN MODE: Route back to plan_executor
            next_action = 'execute_next_step'
        else:
            # SIMPLE DELEGATE MODE: Route to synthesizer for answer generation
            next_action = 'synthesizer'
            print(f"[reflect] 📊 No plan detected - routing to synthesizer for answer generation", flush=True)

        return {
            **state,
            'next_action': next_action,
            'command_history': updated_history,
            'reflection_reasoning': reflection["thought"],
            'last_reflection': reflection, # Pass the structured object back
            'current_hypothesis': new_hypothesis,
            'events': events,
        }
    except asyncio.TimeoutError:
        print(f"[agent-sidecar] ⚠️ Reflection Timeout: LLM call exceeded 30s", flush=True)
        events.append(emit_event("error", {"message": "Reflection timeout"}))
        return {
            **state,
            'next_action': 'execute_next_step',
            'last_reflection': {
                'directive': 'CONTINUE',
                'thought': "Reflection timed out. Proceeding with next step.",
                'found_solution': False,
                'verified_facts': [],
                'next_step_hint': 'Continue despite timeout',
                'reason': "Reflection Timeout"
            },
            'events': events,
        }
    except Exception as e:
        print(f"[agent-sidecar] ⚠️ Reflection Error: {e}", flush=True)
        events.append(emit_event("error", {"message": f"Reflection error: {e}"}))
        return {
            **state,
            'next_action': 'execute_next_step',
            'last_reflection': {
                'directive': 'RETRY',
                'thought': f"Reflection mechanism failed: {str(e)}. Retrying the step.",
                'found_solution': False,
                'verified_facts': [],
                'next_step_hint': 'Retry due to internal error',
                'reason': f"Internal Error: {str(e)}"
            },
            'events': events,
        }
