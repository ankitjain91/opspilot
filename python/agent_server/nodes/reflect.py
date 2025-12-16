
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

    # AI-NATIVE APPROACH: Let LLM decide if empty output means success
    # REMOVED hardcoded keyword matching - now fully LLM-driven
    is_empty_output = last_output.strip() in ['', '(no output)'] or (
        not last_cmd.get('error') and len(last_output.strip()) == 0
    )

    if is_empty_output and not last_cmd.get('error'):
        # Ask LLM: Does empty output answer the user's question?
        query = state.get('query', '')
        command = last_cmd.get('command', '')

        empty_output_prompt = f"""You are analyzing a Kubernetes investigation where a command returned empty output.

**User Query:** {query}

**Command Executed:** {command}

**Result:** Empty output (no results)

**Task:** Determine if empty output ANSWERS the user's question.

**Output Format (JSON):**
```json
{{
    "empty_is_answer": true/false,
    "confidence": 0.0-1.0,
    "reasoning": "Brief explanation"
}}
```

**Guidelines:**
- empty_is_answer=true if empty output means "none found" and that ANSWERS the query
  Examples: "find failing pods" + empty = NO failing pods (ANSWERS query)
            "are there any errors" + empty = NO errors (ANSWERS query)
            "list crashlooping pods" + empty = NO crashloops (ANSWERS query)
            "check node health" + empty events = Node is HEALTHY (No bad events)
- empty_is_answer=false if empty output means we need to investigate further
  Examples: "why is pod X failing" + empty = need more investigation
            "debug deployment Y" + empty = need different approach
- Be conservative: if unsure, return false
"""

        try:
            llm_response = await call_llm(
                empty_output_prompt,
                state['llm_endpoint'],
                state['llm_model'],
                state.get('llm_provider', 'ollama'),
                temperature=0.2,
                api_key=state.get('api_key')
            )

            import json
            decision = json.loads(llm_response)

            if decision.get('empty_is_answer') and decision.get('confidence', 0) >= 0.7:
                # LLM confirmed: Empty output answers the question
                print(f"[reflect] ⚡ LLM determined empty output answers query (confidence: {decision.get('confidence'):.2f})", flush=True)
                print(f"[reflect] Reasoning: {decision.get('reasoning')}", flush=True)

                # Create reflection without final_response so synthesizer generates it
                reflection = {
                    "directive": "SOLVED",
                    "found_solution": True,
                    "thought": decision.get('reasoning', f"No matching resources found for '{query}'"),
                    "verified_facts": [f"Empty command output indicates no resources match the search criteria"],
                    "next_step_hint": "",
                    "reason": decision.get('reasoning', "Empty output answers the user's question")
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
            else:
                # LLM says empty output does NOT answer the question - continue investigation
                print(f"[reflect] ℹ️ LLM determined empty output requires further investigation", flush=True)
                # Fall through to normal reflection LLM below

        except Exception as e:
            # Error in LLM call - fall through to normal reflection
            print(f"[reflect] ⚠️ Empty output LLM check failed: {e}. Proceeding with normal reflection.", flush=True)

    # Native AI Refactor: Removed regex-based "Phase 2" Semantic Checks.
    # The Reflection LLM (70B) is fully capable of reading "Connection Refused" 
    # or "Namespace Not Found" from the output and deciding the next step.
    # Hardcoded checks here were causing false positives/negatives.

    from ..knowledge.errors import error_kb

    # Build discovered context for reflection
    discovered_context_str = build_discovered_context(state.get('discovered_resources'))

    # Format accumulated evidence
    accumulated_evidence = state.get('accumulated_evidence', [])
    evidence_str = "\n".join([f"- {fact}" for fact in accumulated_evidence]) if accumulated_evidence else "(No evidence accumulated yet)"

    # Get current step description if in plan execution
    current_step = state.get('current_plan', 'N/A')

    # REFINE Loop: Check for known error patterns
    error_match = error_kb.detect_error_pattern(last_output)
    error_guidance_section = ""
    
    if error_match:
        print(f"[agent-sidecar] 🧠 Recognized Error Pattern: {error_match['name']}", flush=True)
        error_guidance_section = f"""
*** EXPERT ERROR ANALYSIS ***
The system recognized a known error pattern: "{error_match['name']}"
Diagnosis: {error_match['diagnosis']}
Recommended Strategy:
{error_match['strategy']}
Hint: {error_match['hint']}

DIRECTIVE: You SHOULD strongly consider returning 'RETRY' with the suggested hint, or 'CONTINUE' if you have successfully applied the fix.
*** END EXPERT ANALYSIS ***
"""
        # Emit a UI hint event
        events.append(emit_event("hint", {
            "type": "error_pattern",
            "name": error_match['name'],
            "diagnosis": error_match['diagnosis'],
            "strategy": error_match['strategy']
        }))

    prompt = REFLECT_PROMPT.format(
        query=state['query'],
        last_command=last_cmd['command'],
        result=truncate_output(last_output, 8000),
        hypothesis=state.get('current_hypothesis', 'None'),
        discovered_context=discovered_context_str,
        accumulated_evidence=evidence_str,
        current_step=current_step,
        error_guidance_section=error_guidance_section
    )

    try:
        # Low #20 fix: Add 30s timeout to prevent hangs
        import asyncio
        response = await asyncio.wait_for(
            call_llm(prompt, state['llm_endpoint'], state['llm_model'], state.get('llm_provider', 'ollama'), temperature=0.2, api_key=state.get('api_key')),
            timeout=60.0
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

        # --- HEURISTIC: PREVENT PREMATURE ABORT ON "NOT FOUND" ---
        # If the agent wants to ABORT because a resource wasn't found, we should RETRY 
        # with a discovery command (get all) instead.
        if directive == 'ABORT' and any(err in last_output.lower() for err in ['not found', 'no such', 'does not exist']):
             print(f"[agent-sidecar] 🛡️  Preventing ABORT on NotFound error. Forcing RETRY to discover correct resource name.", flush=True)
             directive = 'RETRY'
             reflection['directive'] = 'RETRY'
             reflection['next_command_hint'] = "The resource was not found. List ALL resources in the namespace to find the correct name."
             reflection['thought'] = "The targeted resource does not exist. I need to list available resources to find the correct name."
             reflection['reason'] = "Resource not found recovery"

        # --- FIX: ENSURE REASON IS POPULATED ---
        if directive == 'ABORT' and not reflection.get('reason'):
            # Fallback to thought or generic message if reason is missing
            reflection['reason'] = reflection.get('thought', 'Investigation halted based on analysis.')

        # Log decision
        print(f"[agent-sidecar] 🧠 Reflection Decision: {directive}", flush=True)
        if verified_facts:
            print(f"[agent-sidecar] 📝 New Facts: {verified_facts}", flush=True)
            
        events.append(emit_event("reflection", {
            "assessment": directive,
            "reasoning": reflection.get("reason") or reflection["thought"], # Use reason if available (for Abort), else thought
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
