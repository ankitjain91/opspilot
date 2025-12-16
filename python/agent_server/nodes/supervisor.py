
import json
from ..state import AgentState
from ..config import (
    MAX_ITERATIONS, CONFIDENCE_THRESHOLD, ROUTING_ENABLED
)
from ..prompts.supervisor import SUPERVISOR_PROMPT
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
    normalize_query,
    select_relevant_examples, get_examples_text
)
from ..context_builder import build_discovered_context
from ..response_formatter import format_intelligent_response_with_llm, format_intelligent_response, validate_response_quality
from ..llm import call_llm
from ..routing import select_model_for_query
from ..tools import get_relevant_kb_snippets, ingest_cluster_knowledge  # KB/RAG semantic search

async def classify_query_complexity(query: str, command_history: list, llm_endpoint: str, llm_model: str, llm_provider: str = "ollama", api_key: str = None) -> bool:
    """Use LLM to determine if a query requires deep investigation (complex) or can be answered quickly (simple)."""

    # Build context from command history
    cmd_summary = ""
    if command_history:
        cmd_summary = f"\n\nCommands executed so far:\n"
        for i, cmd in enumerate(command_history[-3:], 1):  # Last 3 commands
            cmd_summary += f"{i}. {cmd.get('command', 'N/A')}\n"

    prompt = f"""Classify this Kubernetes query as either COMPLEX or SIMPLE.

SIMPLE queries:
- Basic resource listings (list pods, show deployments, get services)
- Single-step information retrieval
- No investigation needed, just return data

COMPLEX queries require deep investigation:
- Troubleshooting (debug, why failing, broken, crashed, issues, problems)
- Configuration verification (verify, check, validate, inspect, audit configs)
- Root cause analysis (investigate, analyze, diagnose)
- Health checks across multiple resources
- Finding specific patterns or anomalies

User Query: "{query}"{cmd_summary}

Based ONLY on the query intent, respond with JSON:
{{"complexity": "COMPLEX"}}
or
{{"complexity": "SIMPLE"}}"""

    try:
        response = await call_llm(
            prompt=prompt,
            endpoint=llm_endpoint,
            model=llm_model,
            provider=llm_provider,
            temperature=0.0,  # Deterministic
            force_json=True,
            api_key=api_key
        )

        result = json.loads(response)
        is_complex = result.get('complexity', 'COMPLEX') == 'COMPLEX'
        print(f"[agent-sidecar] 🧠 LLM Query Complexity: {result.get('complexity', 'COMPLEX')} for '{query[:50]}...'", flush=True)
        return is_complex

    except Exception as e:
        print(f"[agent-sidecar] ⚠️ Complexity classification failed: {e}. Defaulting to COMPLEX (safe).", flush=True)
        return True  # Default to complex (safer, won't cut off investigations)

async def supervisor_node(state: AgentState) -> dict:
    """Brain Node (70B): Analyzes history and plans the next step."""
    iteration = state.get('iteration', 0) + 1
    events = list(state.get('events', []))

    # Live RAG: Ingest cluster knowledge (CRDs) on first run with progress UI
    if iteration == 1:
        # Import broadcaster for SSE progress events
        from ..server import broadcaster

        # Progress callback to broadcast CRD loading progress
        async def progress_callback(current: int, total: int, message: str):
            context = state.get('kube_context', 'unknown')
            await broadcaster.broadcast({
                "type": "kb_progress",
                "current": current,
                "total": total,
                "message": message,
                "context": context
            })

        await ingest_cluster_knowledge(state, force_refresh=True, progress_callback=progress_callback)

    events.append(emit_event("progress", {"message": f"Supervisor Reasoning (iteration {iteration})..."}))

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

    # FIX 2: Auto-respond logic REMOVED to enforce planning for all queries
    # All queries will now go through the Brain model and plan creation

    # If reflection already marked solved, route to synthesizer for proper response generation
    # Don't short-circuit to done - let synthesizer create a detailed answer
    if state['command_history']:
        last_entry = state['command_history'][-1]
        if last_entry.get('assessment') in ['SOLVED', 'AUTO_SOLVED']:
            print(f"[agent-sidecar] ✅ SOLVED detected, routing to synthesizer for final response", flush=True)
            events.append(emit_event("progress", {"message": "Solution found - generating final response..."}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'synthesizer',  # Let synthesizer generate proper response
                'events': events,
            }

    # Auto-Done for Simple Queries - Use LLM to determine complexity
    query_safe = state.get('query') or ''

    # Use LLM to classify query complexity
    is_complex_query = await classify_query_complexity(
        query=query_safe,
        command_history=state.get('command_history', []),
        llm_endpoint=state.get('llm_endpoint'),
        llm_model=state.get('llm_model'),
        llm_provider=state.get('llm_provider'),
        api_key=state.get('api_key')
    )

    # Auto-solve conditions:
    # 1. Simple query with results after iteration > 1
    # 2. Complex queries never auto-solve (need full investigation)
    should_auto_solve = False
    if iteration > 1 and state.get('command_history') and not is_complex_query:
        should_auto_solve = True

    if should_auto_solve:
        print(f"[agent-sidecar] 🛑 Auto-solving simple query after {iteration} iterations", flush=True)

        # Calculate confidence score
        confidence = calculate_confidence_score(state)

        # Synthesize final response using LLM
        final_response = await format_intelligent_response_with_llm(
            query=query_safe,
            command_history=state.get('command_history', []),
            discovered_resources=state.get('discovered_resources', {}),
            hypothesis=state.get('current_hypothesis'),
            accumulated_evidence=state.get('accumulated_evidence'),
            llm_endpoint=state.get('llm_endpoint'),
            llm_model=state.get('llm_model'),
            llm_provider=state.get('llm_provider') or 'ollama',
            api_key=state.get('api_key')
        )

        # Validate response quality
        if not final_response or len(final_response) < 10:
             print(f"[agent-sidecar] ⚠️ Formatter returned empty/short response. Using fallback.", flush=True)
             from ..response_formatter import _format_simple_fallback
             final_response = _format_simple_fallback(query_safe, state.get('command_history', []), state.get('discovered_resources', {}))

        events.append(emit_event("responding", {"confidence": confidence, "reason": "auto_solved_simple_query"}))
        return {
            **state,
            'iteration': iteration,
            'next_action': 'done',
            'final_response': final_response,
            'confidence_score': confidence,
            'events': events,
        }

    # Smart Query Refinement (Brain Model) - REMOVED: refiner.py deleted as dead code
    query = state.get('query') or ''
    # if iteration == 1 and query:
    #     from .refiner import refine_query
    #     refined_query = await refine_query(state)
    #     if refined_query and refined_query != query:
    #         events.append(emit_event("reflection", {
    #             "assessment": "REFINED",
    #             "reasoning": f"Rewrote query for clarity: '{refined_query}'"
    #         }))
    #         query = refined_query
    #         state['query'] = query
    #         query_lower = query.lower()
    #         print(f"[agent-sidecar] 🧠 Query updated: {query}", flush=True)

    # Normalize query (still useful for pattern matching)
    normalized_query, normalization_note = normalize_query(query or '')  # Safety: ensure query is never None
    if normalization_note:
        events.append(emit_event("reflection", {
            "assessment": "NORMALIZED",
            "reasoning": normalization_note
        }))
        query = normalized_query or ''  # Safety: ensure query is never None
        print(f"[agent-sidecar] {normalization_note}: '{query}'", flush=True)

    # Embeddings RAG: Fetch relevant KB patterns
    kb_context = await get_relevant_kb_snippets(query, state)

    # Emit KB search event for UI transparency
    if kb_context and kb_context.strip():
        # Extract snippet count from KB context (format: "## RELEVANT KNOWLEDGE\n\n### Entry 1\n...")
        kb_snippet_count = kb_context.count('###')
        events.append(emit_event("kb_search", {
            "query": query,
            "results_found": kb_snippet_count,
            "has_results": kb_snippet_count > 0,
            "preview": kb_context[:200] + "..." if len(kb_context) > 200 else kb_context
        }))
        print(f"[supervisor] 📚 KB Search: Found {kb_snippet_count} relevant entries for '{query}'", flush=True)
    else:
        events.append(emit_event("kb_search", {
            "query": query,
            "results_found": 0,
            "has_results": False
        }))
        print(f"[supervisor] 📚 KB Search: No relevant entries found for '{query}'", flush=True)

    # 🧠 THE LIBRARY: Experience Replay
    try:
        from ..memory.experience import search_experiences
        past_exps = await search_experiences(query)
        if past_exps:
             print(f"[agent-sidecar] 🧠 The Library: Found {len(past_exps)} relevant past experiences", flush=True)
             exp_str = "## 🧠 MEMORY: RELEVANT PAST EXPERIENCES (The Library)\n"
             for exp in past_exps:
                 # Format: [DATE] QUERY -> OUTCOME
                 # Analysis: ...
                 exp_str += f"- [{exp.timestamp}] '{exp.query}' -> {exp.outcome}\n  Analysis: {exp.analysis}\n"
             
             # Prepend to KB context so it's top of mind
             kb_context = f"{exp_str}\n\n{kb_context}"
    except Exception as e:
        print(f"[Library] Error retrieving experiences: {e}", flush=True)

    # Dynamic example selection (increased to max 15 to utilize comprehensive KB for Crossplane, CRDs, vclusters, Azure)
    selected_example_ids = select_relevant_examples(query or '', max_examples=15)
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
        # CRITICAL FIX: Supervisor ALWAYS uses brain model for planning/reasoning
        # The executor model (k8s-cli) is for command generation in worker, not planning!
        # Using executor model here causes silent failures because it's trained for a different task.
        brain_model = state['llm_model']

        # Call supervisor with brain model
        llm_provider = state.get('llm_provider') or 'ollama'
        response = await call_llm(prompt, state['llm_endpoint'], brain_model, llm_provider, api_key=state.get('api_key'))

        result = parse_supervisor_response(response)

        if result['thought']:
            events.append(emit_event("reflection", {"assessment": "PLANNING", "reasoning": result['thought']}))

        # ENFORCE plan creation for ALL kubectl queries (accuracy over speed)
        confidence = result.get('confidence', 1.0)
        next_action = result['next_action']

        print(f"[agent-sidecar] 📊 Supervisor decision: action={next_action}, confidence={confidence:.2f}", flush=True)

        # Emit plan decision event for UI transparency
        events.append(emit_event("plan_decision", {
            "action": next_action,
            "confidence": confidence,
            "model_used": brain_model,
            "thought": result.get('thought', ''),
            "plan_preview": result.get('plan', '')[:150] if result.get('plan') else ''
        }))

        # Force plan creation for any kubectl query (unless responding to greeting/definition)
        # Using the same complexity logic defined above
        query_safe = query or ''
        query_lower = query_safe.lower()
        is_kubectl_query = not any(word in query_lower for word in ['hi', 'hello', 'hey', 'what is', 'explain', 'difference between'])

        if is_kubectl_query:
            # ONLY force plan creation for COMPLEX queries which need systematic steps
            # Logic already defined above as 'is_complex_query' for auto-done check
            
            if is_complex_query and next_action in ['delegate', 'batch_delegate']:
                print(f"[agent-sidecar] 🎯 Complex query detected - forcing systematic plan creation", flush=True)
                # Override to create_plan
                next_action = 'create_plan'
                result['next_action'] = 'create_plan'
                
                # If model didn't provide steps (because it thought it was delegating), generate defaults
                if not result.get('execution_steps'):
                    print(f"[agent-sidecar] ⚠️ Model delegated without steps. Generating default plan.", flush=True)
                    if result.get('plan'):
                        result['execution_steps'] = [result['plan']]
                    elif result.get('batch_commands'):
                        result['execution_steps'] = [f"Execute: {cmd}" for cmd in result['batch_commands']]
                    else:
                        result['execution_steps'] = ["Analyze query and execute discovery commands"]

        if next_action in ['delegate', 'batch_delegate']:
            events.append(emit_event("progress", {"message": f"🧠 Brain Instruction: {result['plan']}"}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'delegate',
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

            # Route to plan_executor which will handle the entire plan systematically
            events.append(emit_event("progress", {
                "message": f"🎯 Executing {len(plan)}-step plan systematically..."
            }))

            return {
                **state,
                'iteration': iteration,
                'next_action': 'create_plan',  # Routing will map this to plan_executor
                'execution_plan': plan,
                'current_hypothesis': result.get('hypothesis', state.get('current_hypothesis', '')),
                'events': events,
            }
        else:
            # Calculate confidence score for the final response (High #9 fix)
            confidence = calculate_confidence_score(state)
            print(f"[agent-sidecar] 📊 Response confidence: {confidence:.2%}", flush=True)

            # Use LLM-driven intelligent response formatter if we have command history to analyze
            if state.get('command_history'):
                final_response = await format_intelligent_response_with_llm(
                    query=state.get('query') or '',
                    command_history=state.get('command_history', []),
                    discovered_resources=state.get('discovered_resources', {}),
                    hypothesis=state.get('current_hypothesis'),
                    accumulated_evidence=state.get('accumulated_evidence'),
                    llm_endpoint=state.get('llm_endpoint'),
                    llm_model=state.get('llm_model'),
                    llm_provider=state.get('llm_provider') or 'ollama',
                    api_key=state.get('api_key')
                )

                # Validate response quality
                is_valid, error_msg = validate_response_quality(final_response, state.get('query') or '')
                if not is_valid:
                    print(f"[agent-sidecar] ⚠️ Response quality check failed: {error_msg}", flush=True)

                # CRITICAL: Ensure we never return an empty response
                if not final_response or len(final_response) < 10:
                    print(f"[agent-sidecar] ⚠️ Empty response detected. using fallback.", flush=True)
                    from ..response_formatter import _format_simple_fallback
                    final_response = _format_simple_fallback(state.get('query') or '', state.get('command_history', []), state.get('discovered_resources', {}))
            else:
                final_response = result['final_response'] or "Analysis complete."

            events.append(emit_event("responding", {"confidence": confidence}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'done',
                'final_response': final_response,
                'confidence_score': confidence,  # Ensured
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
