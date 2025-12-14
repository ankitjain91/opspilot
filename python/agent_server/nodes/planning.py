
from ..state import AgentState
from ..utils import (
    emit_event, create_execution_plan, get_plan_summary,
    get_current_step, mark_step_in_progress, mark_step_completed,
    mark_step_skipped, is_plan_complete
)
from ..prompts_templates import WORKER_PROMPT
from ..llm import call_llm
from ..parsing import clean_json_response
import json

async def execute_plan_step_node(state: AgentState) -> dict:
    """Executes the next step in the plan."""
    plan = state.get('execution_plan')
    current_step_info = get_current_step(plan)

    # SAFETY: Prevent infinite plan loops (separate from supervisor iteration)
    plan_iteration = state.get('plan_iteration', 0) + 1
    MAX_PLAN_ITERATIONS = 20  # Max steps in a plan execution

    if plan_iteration > MAX_PLAN_ITERATIONS:
        events = list(state.get('events', []))
        events.append(emit_event("error", {
            "message": f"Plan execution exceeded {MAX_PLAN_ITERATIONS} iterations. Stopping to prevent infinite loop.",
            "plan_summary": get_plan_summary(plan) if plan else "No plan"
        }))

        return {
            **state,
            'next_action': 'supervisor',  # Return to supervisor to handle the situation
            'plan_iteration': plan_iteration,
            'events': events,
            'error': f'Plan execution exceeded {MAX_PLAN_ITERATIONS} iterations'
        }

    if not current_step_info:
        # Plan complete
        return {**state, 'next_action': 'supervisor', 'plan_iteration': plan_iteration}

    state['current_step'] = current_step_info['step']
    step_description = current_step_info['description']

    events = list(state.get('events', []))
    events.append(emit_event("progress", {"message": f"Executing Step {current_step_info['step']}: {step_description} (plan iter {plan_iteration})"}))

    # Treat the step as a mini-task for the supervisor/worker flow
    # Pass the specific step objective to the worker prompt but keep context
    return {
        **state,
        'next_action': 'worker', # Go to worker to generate command for this step
        'current_plan': step_description, # Focus worker on just this step
        'plan_iteration': plan_iteration,
        'events': events
    }


async def validate_plan_step_node(state: AgentState) -> dict:
    """Checks if the executed command satisfied the plan step."""
    plan = state.get('execution_plan')
    current_step_idx = state.get('current_step', 1) - 1 # 0-indexed
    
    # If no plan, return to supervisor
    if not plan:
        return {**state, 'next_action': 'supervisor'}
        
    last_cmd = state['command_history'][-1]
    last_output = last_cmd.get('output', '')
    last_error = last_cmd.get('error', '')
    
    step_description = plan[current_step_idx]['description']
    
    # Quick check: Did command fail?
    if last_error and not last_output:
        # Retry logic could go here, but for now mark as failed or ask supervisor
        # For simple robustness, we'll mark as completed but note error in history
        # and let supervisor decide next move
        pass

    # Update plan status
    plan = mark_step_completed(plan, current_step_idx + 1, result=last_output[:200]) # truncated result in plan
    
    events = list(state.get('events', []))
    
    # Check if we are done with the whole plan
    if is_plan_complete(plan):
        events.append(emit_event("progress", {"message": f"All steps completed. Summarizing results."}))
        
        # Summarize all findings
        summary_prompt = f"""
        You have completed the execution plan. Here is the summary of steps and results:
        {get_plan_summary(plan)}
        
        Please provide a final answer to the user's original query: "{state['query']}"
        """
        
        return {
            **state, 
            'execution_plan': plan,
            'next_action': 'supervisor', # Return to supervisor for final summary
            'events': events
        }
    
    # Move to next step
    next_step = get_current_step(plan)
    if next_step:
        plan = mark_step_in_progress(plan, next_step['step'])
        events.append(emit_event("progress", {"message": f"Proceeding to Step {next_step['step']}: {next_step['description']}"}))
        return {
            **state,
            'execution_plan': plan,
            'next_action': 'execute_plan_step', # Loop back to execute next step
            'events': events
        }
    else:
        # Should be covered by is_plan_complete, but safety net
        return {**state, 'next_action': 'supervisor', 'execution_plan': plan, 'events': events}
