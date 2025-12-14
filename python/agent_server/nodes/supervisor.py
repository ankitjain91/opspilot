
import json
from ..state import AgentState
from ..config import (
    MAX_ITERATIONS, CONFIDENCE_THRESHOLD, ROUTING_ENABLED
)
from ..prompts_templates import SUPERVISOR_PROMPT
from ..prompts_examples import SUPERVISOR_EXAMPLES_FULL
from ..parsing import (
    parse_supervisor_response, parse_confidence_from_response
)
from ..utils import (
    emit_event, calculate_confidence_score,
    format_conversation_context, format_command_history,
    escape_braces, create_execution_plan, get_plan_summary,
    get_current_step, mark_step_in_progress, is_plan_complete
)
from ..heuristics import (
    autocorrect_query, normalize_query,
    select_relevant_examples, get_examples_text
)
from ..context_builder import build_discovered_context
from ..response_formatter import format_intelligent_response_with_llm, validate_response_quality
from ..llm import call_llm
from ..routing import select_model_for_query
from ..tools.search import get_relevant_kb_snippets

async def supervisor_node(state: AgentState) -> dict:
    """Brain Node (70B): Analyzes history and plans the next step."""
    iteration = state.get('iteration', 0) + 1
    events = list(state.get('events', []))

    events.append(emit_event("progress", {"message": f"Supervisor Reasoning (iteration {iteration})..."}))

    # Check if plan just completed - synthesize findings into final response
    if state.get('execution_plan') and is_plan_complete(state['execution_plan']):
        plan_summary = get_plan_summary(state['execution_plan'])
        print(f"[agent-sidecar] ✅ Plan completed! Synthesizing findings...", flush=True)
        events.append(emit_event("progress", {"message": "Plan completed. Generating comprehensive summary..."}))

        final_response = await format_intelligent_response_with_llm(
            query=state.get('query', ''),
            command_history=state.get('command_history', []),
            discovered_resources=state.get('discovered_resources', {}),
            hypothesis=state.get('current_hypothesis'),
            llm_endpoint=state.get('llm_endpoint'),
            llm_model=state.get('llm_model'),
            llm_provider=state.get('llm_provider', 'ollama')
        )

        # Add plan completion note
        final_response += f"\n\n---\n**Investigation Plan Completed**: {len(state['execution_plan'])} steps executed systematically."

        return {
            **state,
            'iteration': iteration,
            'next_action': 'done',
            'final_response': final_response,
            'execution_plan': None,  # Clear plan
            'events': events,
        }

    # Check for plan execution errors (prevents infinite loops in plan mode)
    if state.get('error') and 'Plan execution exceeded' in state.get('error', ''):
        events.append(emit_event("error", {"message": "Plan execution hit recursion limit, summarizing findings"}))

        final_response = await format_intelligent_response_with_llm(
            query=state.get('query', ''),
            command_history=state.get('command_history', []),
            discovered_resources=state.get('discovered_resources', {}),
            hypothesis=state.get('current_hypothesis'),
            llm_endpoint=state.get('llm_endpoint'),
            llm_model=state.get('llm_model'),
            llm_provider=state.get('llm_provider', 'ollama')
        )

        return {
            **state,
            'iteration': iteration,
            'next_action': 'done',
            'final_response': final_response + f"\n\n⚠️ Note: Plan execution was stopped after {state.get('plan_iteration', 0)} steps to prevent infinite loops.",
            'events': events,
        }

    # Check for command retry loops (prevents infinite blocked command loops)
    if state.get('error') and 'Command retry loop detected' in state.get('error', ''):
        events.append(emit_event("error", {"message": "Command retry loop detected, unable to proceed"}))

        blocked_cmds = state.get('blocked_commands', [])
        final_response = f"""## Command Retry Loop Detected

I've attempted to investigate your query but keep generating commands that get blocked:

### Blocked Commands:
"""
        for i, cmd in enumerate(blocked_cmds[-5:], 1):
            final_response += f"{i}. `{cmd}`\n"

        final_response += """
### Issue:
The same invalid command is being generated repeatedly, indicating I need more specific information to proceed.

### What to try:
- Provide more specific details (exact resource names, namespaces, etc.)
- Rephrase your query with different wording
- Ask a simpler, more focused question first
"""

        return {
            **state,
            'iteration': iteration,
            'next_action': 'done',
            'final_response': final_response,
            'events': events,
        }

    # Check for repeated batch commands (stuck in investigation loop)
    if iteration > 3 and state.get('pending_batch_commands'):
        # Check if we're executing the same batch repeatedly
        recent_batches = []
        for cmd in state.get('command_history', [])[-6:]:  # Check last 6 commands
            if cmd.get('command'):
                recent_batches.append(cmd['command'])

        # If more than 2 commands appear multiple times, we're looping
        from collections import Counter
        cmd_counts = Counter(recent_batches)
        repeated_cmds = [cmd for cmd, count in cmd_counts.items() if count >= 2]

        if len(repeated_cmds) >= 2:
            events.append(emit_event("error", {"message": "Investigation stuck executing repeated commands"}))

            final_response = format_intelligent_response(
                query=state.get('query', ''),
                command_history=state.get('command_history', []),
                discovered_resources=state.get('discovered_resources', {}),
                hypothesis=state.get('current_hypothesis')
            )

            final_response += f"\n\n⚠️ **Investigation Loop Detected**: The agent executed the same commands multiple times without making progress. This usually means more specific information is needed to proceed."

            return {
                **state,
                'iteration': iteration,
                'next_action': 'done',
                'final_response': final_response,
                'events': events,
            }

    # Max iteration guard
    if iteration > MAX_ITERATIONS:
        summary_parts = ["## Investigation Summary\n"]
        summary_parts.append(f"I've analyzed your query through {MAX_ITERATIONS} steps but haven't reached a definitive conclusion.\n")

        if state['command_history']:
            summary_parts.append("### Commands Executed:")
            for i, cmd in enumerate(state['command_history'][-5:], 1):
                summary_parts.append(f"- `{cmd.get('command', 'N/A')}`")

            last_cmd = state['command_history'][-1]
            if last_cmd.get('output'):
                output_content = last_cmd['output']
                if len(output_content) < 2000:
                    summary_parts.append(f"\n### Data Found:\n```\n{output_content}\n```")
                else:
                    summary_parts.append(f"\n### Data Found (Truncated):\n```\n{output_content[:1000]}\n...\n{output_content[-1000:]}\n```")

        summary_parts.append("\n### What to do next:")
        summary_parts.append("- Try asking a more specific question")
        summary_parts.append("- Focus on a particular resource or namespace")
        summary_parts.append("- Ask me to continue investigating from here")

        final_response = "\n".join(summary_parts)

        events.append(emit_event("done", {"reason": "max_iterations", "final_response": final_response}))
        return {
            **state,
            'iteration': iteration,
            'next_action': 'done',
            'final_response': final_response,
            'events': events,
        }

    # FIX 2: Auto-respond for simple queries with successful output (iteration > 1)
    if iteration > 1 and state['command_history']:
        last_cmd = state['command_history'][-1]
        query_lower = (state.get('query') or '').lower().strip()

        # Terse patterns that map to simple queries (user types short form)
        terse_patterns = {
            'node pressure': 'resource usage',
            'failing pods': 'search results',
            'crashloop': 'find query',
            'nodes': 'listing',
            'pods': 'listing',
            'services': 'listing',
            'deployments': 'listing',
            'namespaces': 'listing',
        }

        # Detect simple query patterns
        simple_keywords = ['list', 'show', 'get', 'top', 'status', 'describe', 'nodes', 'pods',
                           'services', 'deployments', 'namespaces', 'find', 'any', 'check']
        is_simple = any(kw in query_lower for kw in simple_keywords)
        is_terse = any(pattern in query_lower for pattern in terse_patterns.keys())

        output = last_cmd.get('output', '').strip()
        has_output = output and output != '(no output)'
        no_error = not last_cmd.get('error')

        # FIX: If it was a batch execution, find the most relevant command for the query
        # (e.g. if asking for pods, don't return the events output even if it was last)
        if (is_simple or is_terse) and has_output and no_error:
            cmd_text = last_cmd.get('command', '').lower()
            
            # If query asks for pods but last command was events/nodes, scan back for pods
            if ('pods' in query_lower or 'failing' in query_lower) and ('get events' in cmd_text or 'get nodes' in cmd_text):
                # Look back in history for a better match
                match_found = False
                for hist_cmd in reversed(state['command_history']):
                    # Broaden search for pod-related commands
                    cmd_check = hist_cmd.get('command', '').lower()
                    if ('get pods' in cmd_check or 'get pod' in cmd_check) and hist_cmd.get('output'):
                        last_cmd = hist_cmd
                        match_found = True
                        break
                
                if not match_found:
                    # If we only have events output but user wanted pods, DO NOT auto-respond
                    # Let reflection handle it (it might notice the missing pod list)
                    # Check against normalized "events" keyword to catch "get event", "get events", etc.
                    is_events_command = 'event' in cmd_text
                    if is_events_command:
                        print(f"[agent-sidecar] ⚠️ Skipping auto-respond: User asked for pods/failing but only have events output.", flush=True)
                        has_output = False # invalid for auto-respond

            # Check if this is a simple single-command query that executed successfully
            if (is_simple or is_terse) and has_output and no_error:
                # Use intelligent response formatter instead of raw dump
                final_response = format_intelligent_response(
                    query=state.get('query', ''),
                    command_history=state.get('command_history', []),
                    discovered_resources=state.get('discovered_resources', {}),
                    hypothesis=state.get('current_hypothesis')
                )

                # Validate response quality
                is_valid, error_msg = validate_response_quality(final_response, state.get('query', ''))
                if not is_valid:
                    print(f"[agent-sidecar] ⚠️ Response quality check failed: {error_msg}, continuing investigation", flush=True)
                    # Skip auto-respond, let investigation continue
                else:
                    confidence = calculate_confidence_score(state)
                    print(f"[agent-sidecar] ✅ Auto-responding to simple query (iteration {iteration}), confidence: {confidence:.2%}", flush=True)

                    events.append(emit_event("progress", {"message": f"Simple query completed successfully, providing intelligent analysis", "confidence": confidence}))
                    return {
                        **state,
                        'iteration': iteration,
                        'next_action': 'done',
                        'final_response': final_response,
                        'confidence_score': confidence,
                        'events': events,
                    }

    # If reflection already marked solved OR auto-solved by execute, short-circuit to done
    if state['command_history']:
        last_entry = state['command_history'][-1]
        if last_entry.get('assessment') in ['SOLVED', 'AUTO_SOLVED']:
            reasoning = last_entry.get('reasoning', '')

            # Use intelligent response formatter for SOLVED cases
            if "SOLUTION FOUND:" in reasoning:
                solution = reasoning.split("SOLUTION FOUND:", 1)[-1].strip()
            else:
                # Use intelligent formatting for better analysis
                solution = format_intelligent_response(
                    query=state.get('query', ''),
                    command_history=state.get('command_history', []),
                    discovered_resources=state.get('discovered_resources', {}),
                    hypothesis=state.get('current_hypothesis')
                )

            # Calculate confidence score for the final response
            confidence = calculate_confidence_score(state)
            print(f"[agent-sidecar] 📊 Response confidence: {confidence:.2%}", flush=True)

            events.append(emit_event("progress", {"message": "Solution identified. Wrapping up.", "confidence": confidence}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'done',
                'final_response': solution,
                'confidence_score': confidence,
                'events': events,
            }

    # Auto-correct query only on first iteration
    query = state.get('query') or ''
    if iteration == 1 and query:
        corrected_query, corrections = autocorrect_query(query)
        if corrections:
            corrections_str = ", ".join(corrections)
            events.append(emit_event("reflection", {
                "assessment": "AUTO-CORRECTED",
                "reasoning": f"Fixed typos in your query: {corrections_str}"
            }))
            query = corrected_query
            print(f"[agent-sidecar] Auto-corrected query: {corrections}", flush=True)

        # Normalize query to match standard patterns (dramatically improves pattern matching)
        normalized_query, normalization_note = normalize_query(query)
        if normalization_note:
            events.append(emit_event("reflection", {
                "assessment": "NORMALIZED",
                "reasoning": normalization_note
            }))
            query = normalized_query
            print(f"[agent-sidecar] {normalization_note}: '{query}'", flush=True)

    # Embeddings RAG: fetch KB snippets for this query
    kb_context = await get_relevant_kb_snippets(query, state)

    # Dynamic example selection (increased to max 15 to utilize comprehensive KB for Crossplane, CRDs, vclusters, Azure)
    selected_example_ids = select_relevant_examples(query, max_examples=15)
    selected_examples = get_examples_text(selected_example_ids, SUPERVISOR_EXAMPLES_FULL)
    print(f"[agent-sidecar] Selected {len(selected_example_ids)} examples (Max 15)", flush=True)

    # Escape braces in dynamic content to avoid format() interpreting them as placeholders
    # The examples contain JSON like {"thought": ...} which would cause KeyError
    # Command history and KB context might also contain braces from kubectl output


    # Build discovered context - CRITICAL FOR AI TO KNOW WHAT EXISTS!
    discovered_context_str = build_discovered_context(state.get('discovered_resources'))

    prompt = SUPERVISOR_PROMPT.format(
        kb_context=escape_braces(kb_context),
        examples=escape_braces(selected_examples),
        query=escape_braces(query),
        kube_context=state['kube_context'] or 'default',
        cluster_info=escape_braces(state.get('cluster_info', 'Not available')),
        discovered_context=escape_braces(discovered_context_str),  # <-- ADD DISCOVERED CONTEXT!
        conversation_context=escape_braces(format_conversation_context(state.get('conversation_history', []))),
        command_history=escape_braces(format_command_history(state['command_history'])),
        mcp_tools_desc=escape_braces(json.dumps(state.get("mcp_tools", []), indent=2)),
    )

    try:
        # Smart routing: use fast model for simple queries, brain for complex
        selected_model, complexity = select_model_for_query(state)

        # First attempt with routed model
        response = await call_llm(prompt, state['llm_endpoint'], selected_model, state.get('llm_provider', 'ollama'))

        # Self-verification: check if model is confident
        # If using fast model and confidence is low, escalate to brain
        if ROUTING_ENABLED and complexity == "simple":
            confidence = parse_confidence_from_response(response)
            preliminary_result = parse_supervisor_response(response)

            # Check for escalation signals
            thought_val = preliminary_result.get('thought') or ''
            thought_lower = thought_val.lower()
            should_escalate = (
                confidence < CONFIDENCE_THRESHOLD or
                preliminary_result.get('next_action') == 'escalate' or
                'uncertain' in thought_lower or
                'not sure' in thought_lower or
                'need more context' in thought_lower or
                'complex' in thought_lower or
                'unsure' in thought_lower
            )

            if should_escalate:
                brain_model = state['llm_model']
                print(f"[agent-sidecar] ESCALATING to brain model ({brain_model}): confidence={confidence:.2f}", flush=True)
                events.append(emit_event("progress", {"message": f"Escalating to advanced reasoning..."}))

                # Re-run with brain model
                response = await call_llm(prompt, state['llm_endpoint'], brain_model, state.get('llm_provider', 'ollama'))

        result = parse_supervisor_response(response)

        if result['thought']:
            events.append(emit_event("reflection", {"assessment": "PLANNING", "reasoning": result['thought']}))

        # ENFORCE plan creation for ALL kubectl queries (accuracy over speed)
        confidence = result.get('confidence', 1.0)
        next_action = result['next_action']

        print(f"[agent-sidecar] 📊 Supervisor decision: action={next_action}, confidence={confidence:.2f}", flush=True)

        # Force plan creation for any kubectl query (unless responding to greeting/definition)
        query_lower = query.lower()
        is_kubectl_query = not any(word in query_lower for word in ['hi', 'hello', 'hey', 'what is', 'explain', 'difference between'])

        if is_kubectl_query and next_action in ['delegate', 'batch_delegate']:
            print(f"[agent-sidecar] 🎯 kubectl query detected - forcing plan creation for systematic execution", flush=True)
            events.append(emit_event("progress", {"message": f"📋 Creating systematic investigation plan for accuracy"}))

            # Generate default execution steps based on query analysis
            default_steps = []

            # Check for "why" or "troubleshoot" patterns
            if any(word in query_lower for word in ['why', 'troubleshoot', 'debug', 'investigate', 'root cause']):
                if 'failed' in query_lower or 'failing' in query_lower or 'error' in query_lower:
                    # Debug pattern: what's failing + why
                    default_steps = [
                        "Identify the resource type and list all instances",
                        "Filter to resources in failed/error/unhealthy state",
                        "Check status.conditions or status.message for detailed error information",
                        "If needed, check recent events to understand what triggered the failure",
                        "If status doesn't show root cause, check logs from the failing resource",
                        "Summarize findings with specific error details and root cause"
                    ]
                else:
                    # General investigation
                    default_steps = [
                        "Identify the resource type to investigate",
                        "Check current state and status",
                        "Review recent events for anomalies",
                        "Summarize findings with detailed analysis"
                    ]
            elif 'find' in query_lower or 'which' in query_lower:
                # Discovery pattern: find specific resources
                default_steps = [
                    "Identify the resource type to search for",
                    "List all instances of the resource",
                    "Filter based on the query criteria (state, status, labels, etc.)",
                    "Present filtered results with relevant details"
                ]
            else:
                # Generic multi-step investigation
                default_steps = [
                    "Analyze the query to determine what information is needed",
                    "Execute discovery commands to gather data",
                    "Filter and analyze results to answer the question",
                    "Provide comprehensive summary"
                ]

            # Override to create_plan
            result['next_action'] = 'create_plan'
            result['execution_steps'] = default_steps
            next_action = 'create_plan'

            print(f"[agent-sidecar] Generated {len(default_steps)}-step investigation plan", flush=True)

        if next_action == 'delegate':
            events.append(emit_event("progress", {"message": f"🧠 Brain Instruction: {result['plan']}"}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'delegate',
                'current_plan': result['plan'],
                'current_hypothesis': result.get('hypothesis', state.get('current_hypothesis', '')),
                'events': events,
            }
        elif result['next_action'] == 'batch_delegate':
            batch_commands = result.get('batch_commands', [])
            if not batch_commands:
                # Fallback to regular delegate if no batch commands provided
                events.append(emit_event("error", {"message": "batch_delegate requested but no batch_commands provided"}))
                return {
                    **state,
                    'iteration': iteration,
                    'next_action': 'delegate',
                    'current_plan': result['plan'],
                    'events': events,
                }

            events.append(emit_event("progress", {"message": f"🚀 Executing {len(batch_commands)} commands in parallel: {result['plan']}"}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'batch_execute',
                'pending_batch_commands': batch_commands,
                'current_plan': result['plan'],
                'current_hypothesis': result.get('hypothesis', state.get('current_hypothesis', '')),
                'events': events,
            }
        elif result['next_action'] == 'invoke_mcp':
            # Emit tool call request and STOP graph (wait for client resumption)
            tool_call = {
                "tool": result.get('tool'),
                "args": result.get('args'),
                "history": state.get("command_history", [])
            }
            events.append(emit_event("tool_call_request", tool_call))
            
            return {
                **state,
                'iteration': iteration,
                'next_action': 'invoke_mcp',
                'pending_tool_call': tool_call,
                'events': events,
            }
        elif result['next_action'] == 'create_plan':
            # ReAct Pattern: Create multi-step execution plan
            execution_steps = result.get('execution_steps', [])
            if not execution_steps:
                # Fallback to regular delegate if no steps provided
                events.append(emit_event("error", {"message": "create_plan requested but no execution_steps provided"}))
                return {
                    **state,
                    'iteration': iteration,
                    'next_action': 'delegate',
                    'current_plan': result['plan'],
                    'events': events,
                }

            # Create structured plan
            plan = create_execution_plan(execution_steps)
            plan_summary = get_plan_summary(plan)

            print(f"[agent-sidecar] 📋 Created {len(plan)}-step execution plan", flush=True)
            print(f"[agent-sidecar] Plan:\n{plan_summary}", flush=True)

            # Emit plan to frontend for display
            events.append(emit_event("plan_created", {
                "plan": plan,
                "summary": plan_summary,
                "total_steps": len(plan)
            }))

            # Immediately start executing first step
            first_step = get_current_step(plan)
            updated_plan = mark_step_in_progress(plan, first_step['step'])

            events.append(emit_event("progress", {
                "message": f"🎯 Starting Step {first_step['step']}/{len(plan)}: {first_step['description']}"
            }))

            return {
                **state,
                'iteration': iteration,
                'next_action': 'execute_plan_step',
                'execution_plan': updated_plan,
                'current_step': first_step['step'],
                'current_hypothesis': result.get('hypothesis', state.get('current_hypothesis', '')),
                'events': events,
            }
        else:
            # Calculate confidence score for the final response
            confidence = calculate_confidence_score(state)
            print(f"[agent-sidecar] 📊 Response confidence: {confidence:.2%}", flush=True)

            # Use LLM-driven intelligent response formatter if we have command history to analyze
            if state.get('command_history'):
                final_response = await format_intelligent_response_with_llm(
                    query=state.get('query', ''),
                    command_history=state.get('command_history', []),
                    discovered_resources=state.get('discovered_resources', {}),
                    hypothesis=state.get('current_hypothesis'),
                    llm_endpoint=state.get('llm_endpoint'),
                    llm_model=state.get('llm_model'),
                    llm_provider=state.get('llm_provider', 'ollama')
                )

                # Validate response quality
                is_valid, error_msg = validate_response_quality(final_response, state.get('query', ''))
                if not is_valid:
                    print(f"[agent-sidecar] ⚠️ Response quality check failed: {error_msg}", flush=True)
                    # Log warning but still return response (user asked to respond)
            else:
                final_response = result['final_response'] or "Analysis complete."

            events.append(emit_event("responding", {"confidence": confidence}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'done',
                'final_response': final_response,
                'confidence_score': confidence,
                'events': events,
            }

    except Exception as e:
        events.append(emit_event("error", {"message": f"Supervisor Error: {e}"}))
        return {
            **state,
            'iteration': iteration,
            'next_action': 'done',
            'error': str(e),
            'final_response': f'I encountered an error planning the next step: {e}',
            'events': events,
        }
