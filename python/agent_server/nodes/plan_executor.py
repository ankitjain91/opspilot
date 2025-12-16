"""
Plan Executor Node - Smart State Machine Execution.

This module implements the core logic for executing the agent's plan step-by-step.
It acts as a State Machine:
1. CHECK STATE: Analyzes the result of the previous step (via Reflection).
2. TRANSITION: Decides to Retry, Continue, or Stop.
3. EXECUTE: Runs the next appropriate action (single step execution).
"""

from ..state import AgentState
from ..utils import emit_event, mark_step_in_progress, mark_step_completed, mark_step_skipped, get_current_step, is_plan_complete
from ..response_formatter import format_intelligent_response_with_llm

async def plan_executor_node(state: AgentState) -> dict:
    """
    Execute ONE step of the plan, with SMART State Machine logic.
    Target: Handles state transitions (Retry, Continue, Solved) and dispatches execution.
    """
    plan = state.get('execution_plan')
    if not plan:
        return {**state, 'next_action': 'supervisor'}
        
    # --- 1. STATE MACHINE TRANSITION LOGIC ---
    
    # Context
    previous_reflection = state.get('last_reflection')
    retry_count = state.get('retry_count', 0)
    current_step_status = state.get('step_status', 'pending')
    
    # Define state updates to apply (Immutable pattern)
    updates = {}
    
    # ALWAYS Accumulate Evidence (if any verified facts exist)
    accumulated_evidence = list(state.get('accumulated_evidence', []) or [])
    if previous_reflection:
        new_facts = previous_reflection.get('verified_facts', [])
        if new_facts:
            # Simple dedup
            for fact in new_facts:
                if fact not in accumulated_evidence:
                    accumulated_evidence.append(fact)
            updates['accumulated_evidence'] = accumulated_evidence
            print(f"[plan_executor] 📝 Accumulated Evidence: {len(accumulated_evidence)} facts", flush=True)

    # Get the "Active" step (the one we arguably just finished or are working on)
    active_step = get_current_step(plan)

    # Prepare a working state that includes our updates (for downstream usage)
    # We DO NOT mutate 'state' directly.
    state_for_exec = {**state, **updates}

    # CRITICAL FIX: Only process reflection if we JUST came back from a reflection with status indicating work in progress
    # AND we have a reflection to process. Clear last_reflection immediately to prevent loops.
    should_process_reflection = (
        active_step and
        previous_reflection and
        current_step_status in ['in_progress', 'retrying']
    )

    if should_process_reflection:
        step_idx = active_step['step'] - 1
        directive = previous_reflection.get('directive', 'CONTINUE')

        print(f"[plan_executor] 🧠 Directive: {directive} (Step {active_step['step']}, Retry {retry_count})", flush=True)

        if directive == 'SOLVED':
            # SUCCESS - Route to synthesizer for proper final response generation
            print(f"[plan_executor] 🏆 SOLVED. Routing to synthesizer for final response.", flush=True)
            return {
                **state_for_exec,
                'next_action': 'synthesizer',  # Route to synthesizer node
                'execution_plan': None  # Clear plan - we're done executing
            }
            
        elif directive == 'ABORT':
            # FAILURE - ABORT PLAN
            reason = previous_reflection.get('reason', 'Unknown reason')
            print(f"[plan_executor] 🛑 ABORT. Returning to Supervisor.", flush=True)
            return {
                **state_for_exec,
                'next_action': 'supervisor',
                'final_response': f"I stopped the plan execution because: {reason}. I will re-examine the situation.",
                'error': f"Plan Aborted: {reason}"
            }
            
        elif directive == 'RETRY':
            # FAILURE - RETRY
            if retry_count < 3:
                # Increment retry and CONTINUE to execution (which re-runs the same step)
                print(f"[plan_executor] 🔄 Retrying step {active_step['step']}...", flush=True)
                
                # Update retry count in our working state params
                retry_updates = {
                    'retry_count': retry_count + 1,
                    'step_status': 'retrying',
                    'last_reflection': previous_reflection # Ensure hint is available
                }
                
                # Update state passed to execution
                state_for_exec.update(retry_updates)
                
                # explicit index for robustness
                execution_result = await _execute_single_step(state_for_exec, plan, step_idx)
                
                # CRITICAL FIX (Bug #2): Force the retry updates into the return value
                # _execute_single_step returns a dict based on state_for_exec, so it SHOULD have these,
                # but let's be explicitly safe and merge them again.
                return {
                    **execution_result,
                    **retry_updates
                }
            
            else:
                # RETRIES EXHAUSTED - SKIP
                print(f"[plan_executor] ⚠️ Max retries ({retry_count}) reached. Skipping step.", flush=True)
                plan = mark_step_skipped(plan, active_step['step'], reason="Max retries exceeded")
                
                # Reset state for next step
                reset_updates = {
                    'retry_count': 0,
                    'last_reflection': None,
                    'step_status': 'pending',
                    'execution_plan': plan
                }
                
                # LOOP via LangGraph (avoid recursion)
                return {
                    **state_for_exec,
                    **reset_updates,
                    'next_action': 'execute_next_step' # Routes back to plan_executor
                }
        
        elif directive == 'CONTINUE':
            # SUCCESS - NEXT STEP
            print(f"[plan_executor] ✅ Step {active_step['step']} Complete.", flush=True)

            # Use reflection reason as the result
            completion_reason = previous_reflection.get('reason', 'Step completed successfully')
            plan = mark_step_completed(plan, active_step['step'], result=completion_reason)

            # DEBUG: Verify the plan was updated
            updated_step = next((s for s in plan if s['step'] == active_step['step']), None)
            if updated_step:
                print(f"[plan_executor] DEBUG: Step {active_step['step']} marked as {updated_step['status']}", flush=True)

            # Reset state for next step - CRITICAL: Clear last_reflection to prevent reprocessing
            reset_updates = {
                'retry_count': 0,
                'last_reflection': None,
                'step_status': 'pending',
                'execution_plan': plan
            }

            # LOOP via LangGraph (avoid recursion)
            return {
                 **state_for_exec,
                 **reset_updates,
                 'next_action': 'execute_next_step' # Routes back to plan_executor
            }

    # --- 2. SELECT NEXT ACTION ---
    
    # Get the current step (after updates above)
    target_step = get_current_step(plan)

    # If no more steps or plan is complete, route to synthesizer
    if target_step is None or is_plan_complete(plan):
        print(f"[plan_executor] ✅ Plan complete. Routing to synthesizer.", flush=True)
        return {
            **state_for_exec,
            'next_action': 'synthesizer',  # Route to synthesizer for final response
            'execution_plan': None  # Clear plan
        }

    # Validate index
    step_idx = target_step['step'] - 1
    
    # --- 3. EXECUTE SINGLE STEP ---
    return await _execute_single_step(state_for_exec, plan, step_idx)


async def _execute_single_step(state: AgentState, plan: list, step_idx: int) -> dict:
    """
    Execute actions for a specific step.
    Pure execution: Worker -> Verify -> Execute -> Reflect
    NO state transition logic here.
    """
    from .worker import worker_node, execute_node
    from .verify import verify_command_node
    from .reflect import reflect_node

    step = plan[step_idx]
    step_num = step_idx + 1
    step_desc = step['description']

    events = list(state.get('events', []))
    working_plan = list(plan)

    # Mark step as in progress if not already
    working_plan = mark_step_in_progress(working_plan, step_num)

    # Emit progress
    msg = f"🔍 Step {step_num}/{len(plan)}: {step_desc}"
    if state.get('retry_count', 0) > 0:
        msg += f" (Retry {state.get('retry_count')})"
        
    events.append(emit_event("progress", {"message": msg}))
    events.append(emit_event("plan_update", {
        "plan": working_plan,
        "current_step": step_num,
        "total_steps": len(plan)
    }))

    # Prepare context for Worker
    current_state = {
        **state,
        'events': events,
        'current_step': step_num,
        'current_plan': step_desc,
        'execution_plan': working_plan,
        # status comes from state (might be retrying) or defaults to in_progress
        'step_status': state.get('step_status', 'in_progress') 
    }
    
    # If it was pending, mark it 'in_progress' now
    if current_state['step_status'] == 'pending':
        current_state['step_status'] = 'in_progress'

    try:
        # 1. Generate command
        worker_state = await worker_node(current_state)

        # CHECK FOR BATCH EXECUTION (Parallel Read)
        if worker_state.get('next_action') == 'execute_batch':
             from .worker import execute_batch_node
             batch_result = await execute_batch_node(worker_state)
             
             # Batch execution does its own reflection in a way (adding history)
             # But here we loop back to 'execute_next_step' to start fresh planning
             return {
                 **batch_result,
                 'execution_plan': working_plan,
                 'next_action': 'execute_next_step',
                 # Preserve retry count
                 'retry_count': state.get('retry_count', 0),
                 'step_status': 'in_progress',
                 # Clear last reflection as we just did a batch run
                 'last_reflection': {
                     'directive': 'CONTINUE',
                     'thought': 'Batch execution completed. Analyzing results...'
                 }
             }

        pending_cmd = worker_state.get('pending_command')

        if not pending_cmd:
            # If generation fails, we rely on REFLECTION to catch it (via empty cmd error)
            # OR we can short-circuit here.
            # Let's create a synthetic reflection failure to trigger retry logic in next loop.
             return {
                **worker_state,
                'execution_plan': working_plan,
                'next_action': 'execute_next_step', 
                'last_reflection': {
                    'directive': 'RETRY',
                    'reason': 'Failed to generate command',
                    'thought': 'Worker could not generate a valid command. I should try rephrasing the request.'
                }
            }

        # 2. Verify
        verify_state = await verify_command_node(worker_state)

        # check blocked
        if verify_state.get('blocked_commands') and pending_cmd in verify_state['blocked_commands']:
             # Blocked = Skip with reason
             working_plan = mark_step_skipped(working_plan, step_num, reason="Command Blocked")
             
             # CRITICAL FIX (Bug #5): Return CLEAN state, do not just spread verify_state if it has pollution
             # Re-construct based on valid previous state + specific updates
             return {
                 **state, # Base state
                 'events': verify_state.get('events', events),
                 'command_history': verify_state.get('command_history', state.get('command_history')),
                 'execution_plan': working_plan,
                 'next_action': 'execute_next_step', # Loop back to potentially find next step
                 'step_status': 'blocked',
                 'retry_count': 0, 
                 'last_reflection': None,
                 'blocked_commands': verify_state.get('blocked_commands')
             }

        if verify_state.get('awaiting_approval'):
            # Command needs approval - return to graph to handle approval flow
            # The graph will route to human_approval node which waits for user approval
            # The approval loop guard will generate a fallback response if stuck
            print(f"[plan_executor] ⚠️ Step requires approval. Returning to approval flow.", flush=True)
            return verify_state  # Keep next_action='human_approval' from verify node

        # 3. Execute
        exec_state = await execute_node(verify_state)

        # 4. Reflect
        reflect_state = await reflect_node(exec_state)

        # Emit updated plan from reflect state events
        final_events = list(reflect_state.get('events', []))
        
        # We DO NOT mark completed here. 
        # We loop back to `plan_executor_node` which checks the reflection and decides.
        
        return {
            **reflect_state,
            'execution_plan': working_plan,
            'next_action': 'execute_next_step', # Loop back to STATE MACHINE
            'events': final_events,
            # CRITICAL FIX: Preserve retry count from incoming state parameter
            'retry_count': state.get('retry_count', 0),
            'step_status': current_state['step_status']
        }

    except Exception as e:
        error_msg = str(e)
        # Medium #13 fix: Log full error server-side for debugging
        import traceback
        full_trace = traceback.format_exc()
        print(f"[plan_executor] ❌ Error in step {step_num}:", flush=True)
        print(full_trace, flush=True)

        # Sanitize error for user-facing reflection (hide secrets/paths)
        sanitized_error = "An internal error occurred."
        if "Connection" in error_msg:
             sanitized_error = "Connection failed. Please check network connectivity."
        elif "No such file" in error_msg:
             sanitized_error = "Required resource not found."
        elif "kb_context" in error_msg or "examples" in error_msg:
             sanitized_error = "Error formatting agent prompt."

        # Should trigger retry
        return {
            **current_state,
            'execution_plan': working_plan,
            'next_action': 'execute_next_step',
            'last_reflection': {
                'directive': 'RETRY',
                'reason': f"Execution Error: {sanitized_error}",
                'thought': "An internal error occurred during execution. I will retry."
            }
        }


async def _synthesize_final_response(state: AgentState, plan: list) -> dict:
    """Synthesize findings from all completed steps."""
    print(f"[plan_executor] ✅ Plan complete. Synthesizing findings...", flush=True)

    events = list(state.get('events', []))
    events.append(emit_event("progress", {
        "message": "✅ All investigation steps complete. Synthesizing findings..."
    }))
    
    # Collect all gathered evidence
    accumulated_evidence = state.get('accumulated_evidence', [])

    # Use LLM to synthesize comprehensive response
    final_response = await format_intelligent_response_with_llm(
        query=state.get('query', ''),
        command_history=state.get('command_history', []),
        discovered_resources=state.get('discovered_resources', {}),
        hypothesis=state.get('current_hypothesis'),
        llm_endpoint=state.get('llm_endpoint'),
        llm_model=state.get('llm_model'),
        llm_provider=state.get('llm_provider', 'ollama'),
        accumulated_evidence=accumulated_evidence, # Pass accumulated evidence
        api_key=state.get('api_key')
    )

    # Add plan completion summary with detail on skipped steps
    completed_count = sum(1 for s in plan if s.get('status') == 'completed')
    skipped_count = sum(1 for s in plan if s.get('status') == 'skipped')

    if skipped_count > 0:
        final_response += f"\n\n---\n**Systematic Investigation**: {completed_count}/{len(plan)} steps completed successfully, {skipped_count} skipped."
    else:
        final_response += f"\n\n---\n**Systematic Investigation**: {completed_count}/{len(plan)} steps completed successfully."

    return {
        **state,
        'final_response': final_response,
        'execution_plan': None,  # Clear plan
        'next_action': 'done',
        'events': events,
    }
