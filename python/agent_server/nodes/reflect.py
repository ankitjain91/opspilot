
from ..state import AgentState
from ..prompts_templates import REFLECT_PROMPT
from ..llm import call_llm
from ..parsing import parse_reflection
from ..utils import truncate_output, emit_event
from ..context_builder import build_discovered_context

async def reflect_node(state: AgentState) -> dict:
    """Reflect Node (70B): Assesses the result."""
    events = list(state.get('events', []))
    last_cmd = state['command_history'][-1]
    last_output = last_cmd.get('output', '') or last_cmd.get('error', '(no output)')

    # CODE-LEVEL SAFETY CHECK: Detect "empty output = success" for find queries
    # This prevents unnecessary LLM calls and guarantees correct behavior
    query_lower = (state.get('query') or '').lower().strip()
    is_find_query = any(kw in query_lower for kw in [
        'find', 'show', 'any', 'which', 'list failing', 'crashloop', 'failing', 'broken', 'unhealthy'
    ])
    is_empty_output = last_output.strip() in ['', '(no output)'] or (
        not last_cmd.get('error') and len(last_output.strip()) == 0
    )

    if is_find_query and is_empty_output and not last_cmd.get('error'):
        # Shortcut: Empty output for find query = no matching resources found
        print(f"[agent-sidecar] ⚡ Safety check: Empty output for find query → AUTO-SOLVED", flush=True)
        reflection = {
            "found_solution": True,
            "thought": f"No matching resources found for '{state['query']}'",
            "final_response": f"✅ No matching resources found. Your cluster is healthy in this aspect.",
            "next_step_hint": ""
        }

        assessment = "SOLVED"
        events.append(emit_event("reflection", {
            "assessment": assessment,
            "reasoning": reflection["thought"],
            "found_solution": True,
        }))

        updated_history = list(state['command_history'])
        feedback = reflection["thought"] + f"\nSOLUTION FOUND: {reflection['final_response']}"
        updated_history[-1] = {
            **updated_history[-1],
            'assessment': "SOLVED",
            'useful': True,
            'reasoning': feedback,
        }

        return {
            **state,
            'next_action': 'supervisor',
            'command_history': updated_history,
            'reflection_reasoning': reflection["thought"],
            'events': events,
        }

    # Build discovered context for reflection
    discovered_context_str = build_discovered_context(state.get('discovered_resources'))

    prompt = REFLECT_PROMPT.format(
        query=state['query'],
        last_command=last_cmd['command'],
        result=truncate_output(last_output, 8000),
        hypothesis=state.get('current_hypothesis', 'None'),
        discovered_context=discovered_context_str
    )

    try:
        response = await call_llm(prompt, state['llm_endpoint'], state['llm_model'], state.get('llm_provider', 'ollama'), temperature=0.2)
        reflection = parse_reflection(response)

        # Hypothesis Validation Logic
        current_hypothesis = state.get('current_hypothesis')
        new_hypothesis = current_hypothesis
        
        if reflection.get('hypothesis_status') == 'refuted':
            # Hypothesis refuted, check for revision
            if reflection.get('revised_hypothesis'):
                new_hypothesis = reflection['revised_hypothesis']
                events.append(emit_event("hypothesis_update", {
                    "reason": "Refuted by evidence",
                    "old": current_hypothesis,
                    "new": new_hypothesis
                }))
                print(f"[agent-sidecar] 🧪 Hypothesis REFUTED: '{current_hypothesis}' -> New: '{new_hypothesis}'", flush=True)
            else:
                print(f"[agent-sidecar] 🧪 Hypothesis REFUTED: '{current_hypothesis}' (No revision provided)", flush=True)

        elif reflection.get('hypothesis_status') == 'confirmed':
            print(f"[agent-sidecar] 🧪 Hypothesis CONFIRMED: '{current_hypothesis}'", flush=True)
            events.append(emit_event("hypothesis_confirmed", {"hypothesis": current_hypothesis}))

        assessment = "SOLVED" if reflection["found_solution"] else "ANALYZING"
        events.append(emit_event("reflection", {
            "assessment": assessment,
            "reasoning": reflection["thought"],
            "found_solution": reflection["found_solution"],
        }))

        updated_history = list(state['command_history'])
        
        feedback = reflection["thought"]
        if reflection["found_solution"]:
            feedback += f"\nSOLUTION FOUND: {reflection['final_response']}"
        else:
            feedback += f"\nHINT: {reflection['next_step_hint']}"

        updated_history[-1] = {
            **updated_history[-1],
            'assessment': "SOLVED" if reflection["found_solution"] else "ANALYZED",
            'useful': True,
            'reasoning': feedback,
        }
        
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': updated_history,
            'reflection_reasoning': reflection["thought"],
            'current_hypothesis': new_hypothesis,
            'events': events,
        }
    except Exception as e:
        events.append(emit_event("error", {"message": f"Reflection error: {e}"}))
        return {
            **state,
            'next_action': 'supervisor',
            'events': events,
        }
