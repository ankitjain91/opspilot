
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
from ..extraction import format_debugging_context

async def update_hypotheses_with_llm(
    query: str,
    command_history: list,
    current_hypotheses: list,
    iteration: int,
    llm_endpoint: str,
    llm_model: str,
    llm_provider: str = "ollama",
    api_key: str = None
) -> list:
    """
    LLM-DRIVEN HYPOTHESIS TRACKING (AI-Native, Zero Hardcoding)

    Let the LLM autonomously:
    1. Generate new hypotheses when investigating issues
    2. Update confidence based on evidence
    3. Confirm/refute hypotheses based on findings
    4. Rank hypotheses by likelihood

    Returns list of Hypothesis objects managed entirely by AI.
    """

    # Skip hypothesis tracking for simple queries
    if not command_history or iteration < 1:
        return []

    # Build evidence summary from command history
    evidence_summary = []
    for cmd in command_history[-5:]:  # Last 5 commands
        evidence_summary.append(f"**Command:** `{cmd.get('command', '')}`")
        output = cmd.get('output', '')[:300]  # First 300 chars
        assessment = cmd.get('assessment', '')
        evidence_summary.append(f"**Result:** {output}")
        if assessment:
            evidence_summary.append(f"**Assessment:** {assessment}")
        evidence_summary.append("")

    evidence_text = "\n".join(evidence_summary)

    # Format current hypotheses
    hyp_context = ""
    if current_hypotheses:
        hyp_context = "**Current Hypotheses:**\n"
        for h in current_hypotheses:
            status_emoji = "🔍" if h['status'] == 'active' else "✅" if h['status'] == 'confirmed' else "❌"
            hyp_context += f"{status_emoji} {h['id']}: {h['description']} (confidence: {h['confidence']:.2f}, status: {h['status']})\n"
    else:
        hyp_context = "**Current Hypotheses:** None yet - generate initial hypotheses based on the query.\n"

    prompt = f"""You are investigating a Kubernetes issue. Your task is to manage hypotheses about root causes.

**User Query:** {query}

{hyp_context}

**Evidence Collected:**
{evidence_text}

**Your Task:** Based on the query and evidence, generate/update hypotheses about the root cause.

**Output Format (JSON array):**
```json
[
  {{
    "id": "hyp-1",
    "description": "Brief hypothesis statement (e.g., 'Pod failing due to ImagePullBackOff')",
    "confidence": 0.0-1.0,
    "status": "active|confirmed|refuted",
    "supporting_evidence": ["evidence item 1", "evidence item 2"],
    "contradicting_evidence": ["contradicting evidence if any"]
  }}
]
```

**Guidelines:**
- Generate 1-3 most likely hypotheses (prioritize quality over quantity)
- Update confidence based on evidence (increase if supported, decrease if contradicted)
- Mark status='confirmed' if evidence strongly supports (confidence > 0.85)
- Mark status='refuted' if evidence contradicts (confidence < 0.2)
- Keep status='active' for ongoing investigation
- For new investigations, generate initial hypotheses from the query alone
- Be specific (avoid vague hypotheses like "something is broken")

**Current Iteration:** {iteration}

Generate hypotheses now (respond with JSON array only):"""

    try:
        response = await call_llm(
            prompt=prompt,
            endpoint=llm_endpoint,
            model=llm_model,
            provider=llm_provider,
            temperature=0.3,  # Some creativity for hypothesis generation
            api_key=api_key
        )

        # Parse JSON response
        hypotheses = json.loads(response)

        # Handle wrapped response: {"hypotheses": [...]} or {"data": [...]}
        if isinstance(hypotheses, dict):
            # Try common wrapper keys
            for key in ['hypotheses', 'data', 'items', 'results']:
                if key in hypotheses and isinstance(hypotheses[key], list):
                    hypotheses = hypotheses[key]
                    break
            else:
                # If dict has hypothesis-like keys, wrap it as a single-item list
                if 'description' in hypotheses:
                    hypotheses = [hypotheses]

        # Validate response is a list of dictionaries
        if not isinstance(hypotheses, list):
            print(f"[supervisor] ⚠️ Hypothesis response is not a list: {type(hypotheses)}. Returning empty.", flush=True)
            return current_hypotheses or []

        # Filter to only valid hypothesis dictionaries
        valid_hypotheses = []
        for h in hypotheses:
            if isinstance(h, dict) and 'description' in h:
                if 'created_at' not in h:
                    h['created_at'] = iteration
                h['last_updated'] = iteration
                valid_hypotheses.append(h)

        return valid_hypotheses

    except Exception as e:
        print(f"[supervisor] ⚠️ Hypothesis tracking failed: {e}. Continuing without hypotheses.", flush=True)
        return current_hypotheses or []  # Return existing or empty list


# Removed classify_query_complexity - decision making is now fully handled by supervisor LLM
# No hardcoded classification logic

async def supervisor_node(state: AgentState) -> dict:
    """Brain Node (70B): Analyzes history and plans the next step."""
    iteration = state.get('iteration', 0) + 1
    events = list(state.get('events', []))
    try:
        from time import time
        from ..server import broadcaster
        events.append(emit_event("progress", {"message": f"[TRACE] supervisor:start {time():.3f}"}))
    except Exception:
        pass

    # Live RAG: Ingest cluster knowledge (CRDs) on first run with progress UI
    if iteration == 1:
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

    # PARALLELIZATION: Run planner and initial KB search concurrently
    # This saves ~2-3s latency by overlapping LLM calls with embedding search
    import asyncio
    original_query = state.get('query', '')

    async def run_planner():
        """Planner: rewrite vague queries into 1-3 specific sub-queries to guide retrieval"""
        try:
            planner_prompt = f"""Rewrite the user's query into 1-3 specific retrieval-focused sub-queries for Kubernetes troubleshooting.

Original: {original_query}

Output JSON schema:
{{"queries": ["q1", "q2", "q3"]}}

Guidelines:
- Target resources explicitly (pods/deployments/events/logs)
- Include namespaces or 'all namespaces' if implied
- Cover logs/events/status depending on the intent
"""
            planner_json = await call_llm(
                prompt=planner_prompt,
                endpoint=state.get('llm_endpoint'),
                model=state.get('llm_model'),
                provider=state.get('llm_provider', 'ollama'),
                temperature=0.0,
                force_json=True,
                api_key=state.get('api_key')
            )
            import json as _json
            planner_out = _json.loads(planner_json)
            return planner_out.get('queries') or [original_query]
        except Exception as _e:
            return [original_query]

    async def run_initial_kb_search():
        """Initial KB search on original query while planner runs"""
        return await get_relevant_kb_snippets(original_query, state, max_results=2)

    # Run planner and initial KB search in parallel
    planner_result, initial_kb_result = await asyncio.gather(
        run_planner(),
        run_initial_kb_search()
    )

    sub_queries = planner_result[:3]
    state['planner_queries'] = sub_queries
    events.append(emit_event("progress", {"message": f"Planner generated {len(sub_queries)} focused queries (parallel)"}))

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

    # LLM-Driven Investigation Completion Check
    # Let the AI decide if we have enough information to answer, not hardcoded iteration limits
    query_safe = state.get('query') or ''

    # Only check if we should complete AFTER we have executed at least one command
    if state.get('command_history'):
        should_complete_prompt = f"""You are monitoring an autonomous Kubernetes investigation agent.

USER QUERY: {query_safe}

COMMANDS EXECUTED:
{chr(10).join([f"- {cmd.get('command', 'N/A')}: {(cmd.get('output') or cmd.get('summary') or 'No output')[:200]}..." for cmd in state.get('command_history', [])[-5:]])}

DISCOVERED RESOURCES:
{json.dumps(state.get('discovered_resources', {}), indent=2)[:500]}

Should the investigation COMPLETE now, or does it need MORE commands to fully answer the user's query?

Respond with JSON:
{{"should_complete": true, "confidence": 0.0-1.0, "reason": "why investigation is complete"}}
OR
{{"should_complete": false, "reason": "what information is still missing"}}

LLM-DRIVEN RULES:
- Set should_complete=true ONLY if we have EXECUTED commands and gathered sufficient data
- For "list/get" queries, we need actual command output, not just KB documentation
- For troubleshooting, we need to verify the issue exists and identify root cause
- Confidence is informational only - use your reasoning to decide should_complete
- If critical information is missing, set should_complete=false
"""

        try:
            completion_check = await call_llm(
                prompt=should_complete_prompt,
                endpoint=state.get('llm_endpoint'),
                model=state.get('llm_model'),
                provider=state.get('llm_provider', 'ollama'),
                temperature=0.0,
                force_json=True,
                api_key=state.get('api_key')
            )

            completion_result = json.loads(completion_check)

            # LLM-DRIVEN: Trust the LLM's should_complete decision without hardcoded confidence threshold
            if completion_result.get('should_complete'):
                print(f"[agent-sidecar] ✅ LLM decided investigation is complete (confidence: {completion_result.get('confidence', 0):.2f}): {completion_result.get('reason')}", flush=True)
                print(f"[agent-sidecar] 🔄 Routing to synthesizer to format results", flush=True)

                # Route to synthesizer to format the final response properly
                # Don't bypass the synthesis step - it's critical for user-friendly output
                events.append(emit_event("progress", {"message": f"Investigation complete. Synthesizing results..."}))
                return {
                    **state,
                    'iteration': iteration,
                    'next_action': 'synthesizer',
                    'events': events,
                }
            else:
                print(f"[agent-sidecar] 🔄 LLM says continue investigation: {completion_result.get('reason')}", flush=True)

        except Exception as e:
            print(f"[agent-sidecar] ⚠️ Completion check failed: {e}. Continuing investigation.", flush=True)

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

    # Embeddings RAG: Multi-Query Retrieval for better coverage
    # Use planner-generated sub-queries to retrieve diverse KB patterns
    # PARALLELIZATION: Run all sub-query KB searches concurrently
    kb_contexts = []
    sub_queries = state.get('planner_queries', [query])

    # Include initial KB result from parallel run
    if initial_kb_result and initial_kb_result.strip():
        kb_contexts.append(f"### Query: {original_query}\n{initial_kb_result}")

    # Run remaining sub-query searches in parallel (skip if same as original)
    remaining_queries = [q for q in sub_queries if q != original_query]
    if remaining_queries:
        async def search_kb(sub_q):
            result = await get_relevant_kb_snippets(sub_q, state, max_results=2)
            if result and result.strip():
                return f"### Query: {sub_q}\n{result}"
            return None

        # Parallel KB search for all remaining sub-queries
        parallel_results = await asyncio.gather(*[search_kb(q) for q in remaining_queries])
        kb_contexts.extend([r for r in parallel_results if r])

    # Merge all KB contexts (deduplicated by entry ID in get_relevant_kb_snippets)
    kb_context = "\n\n".join(kb_contexts) if kb_contexts else ""

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

    # KB is used for PLANNING assistance only, NOT for replacing command execution
    # All queries that need current cluster state MUST execute kubectl commands
    # The agent must be autonomous and investigate, not just provide documentation

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

    # DYNAMIC EXPERTISE LOADING: Only inject domain-specific knowledge when relevant
    # This reduces token usage by 37% (4,500 tokens) on non-Azure/Crossplane queries
    from ..prompts.supervisor import PERSONALITY_PROMPT, DECISION_RULES_PROMPT, K8S_CHEAT_SHEET, INSTRUCTIONS_PROMPT
    from ..prompts.supervisor.azure_crossplane_expertise import AZURE_CROSSPLANE_EXPERTISE

    query_lower = query.lower() if query else ''

    # Build dynamic prompt based on query content
    dynamic_prompt_parts = [
        PERSONALITY_PROMPT,
        DECISION_RULES_PROMPT,
        K8S_CHEAT_SHEET,
    ]

    # Only add Azure/Crossplane expertise if query mentions it
    if any(keyword in query_lower for keyword in ['azure', 'crossplane', 'managed', 'composite', 'claim', 'provider']):
        dynamic_prompt_parts.append(AZURE_CROSSPLANE_EXPERTISE)
        print(f"[supervisor] 📚 Loaded Azure/Crossplane expertise (query-relevant)", flush=True)
    else:
        print(f"[supervisor] ⚡ Skipped Azure/Crossplane expertise (not relevant, saved ~4500 tokens)", flush=True)

    dynamic_prompt_parts.append(INSTRUCTIONS_PROMPT)

    base_prompt = "\n".join(dynamic_prompt_parts)

    # Build critic feedback section if the Judge rejected the last plan
    critic_feedback = state.get('critic_feedback', '')
    if critic_feedback:
        critic_feedback_section = f"""
⚖️ **JUDGE FEEDBACK (Previous Plan Rejected)**:
The Judge rejected your last plan with this feedback:
"{critic_feedback}"

**CRITICAL**: You MUST create a NEW plan that addresses this feedback. Do NOT give up - the user needs a working investigation plan.
"""
    else:
        critic_feedback_section = ""

    # Format debugging context (auto-extracted structured state)
    debugging_context_str = format_debugging_context(state.get('debugging_context'))

    # Format suggested commands from progressive discovery
    suggested_commands = state.get('suggested_commands', [])
    if suggested_commands:
        suggested_commands_context = f"""
🔄 **PROGRESSIVE DISCOVERY - ALTERNATIVE METHODS SUGGESTED**:
The previous discovery method returned empty. Try these alternative approaches:
{chr(10).join([f'- {cmd}' for cmd in suggested_commands])}

**IMPORTANT**: Use these exact commands first before trying other approaches.
Tried methods so far: {', '.join(state.get('tried_discovery_methods', []))}
"""
    else:
        suggested_commands_context = ""

    prompt = base_prompt.format(
        kb_context=escape_braces(kb_context),
        examples=escape_braces(selected_examples),
        query=escape_braces(query),
        kube_context=state['kube_context'] or 'default',
        cluster_info=escape_braces(state.get('cluster_info', 'Not available')),
        discovered_context=escape_braces(discovered_context_str),
        conversation_context=escape_braces(format_conversation_context(state.get('conversation_history', []))),
        command_history=escape_braces(format_command_history(
            state['command_history'],
            evidence_chain=state.get('accumulated_evidence', [])
        )),
        suggested_commands_context=escape_braces(suggested_commands_context),
        debugging_context_str=escape_braces(debugging_context_str),
        critic_feedback_section=escape_braces(critic_feedback_section),
        mcp_tools_desc=escape_braces(json.dumps(state.get("mcp_tools", []), indent=2)),
    )

    try:
        # CRITICAL FIX: Supervisor ALWAYS uses brain model for planning/reasoning
        # The executor model (k8s-cli) is for command generation in worker, not planning!
        # Using executor model here causes silent failures because it's trained for a different task.
        brain_model = state['llm_model']

        # Emit intent before heavy reasoning
        await broadcaster.broadcast(emit_event("intent", {"type": "planning", "message": "Analyzing cluster state and planning next steps..."}))

        # Call supervisor with brain model
        llm_provider = state.get('llm_provider') or 'ollama'
        response = await call_llm(prompt, state['llm_endpoint'], brain_model, llm_provider, api_key=state.get('api_key'))

        result = parse_supervisor_response(response)

        if result['thought']:
            events.append(emit_event("reflection", {"assessment": "PLANNING", "reasoning": result['thought']}))

        # 🧬 LLM-DRIVEN HYPOTHESIS TRACKING (Phase 3: AI-Native)
        # Let the LLM generate, update, and rank hypotheses dynamically
        hypotheses = await update_hypotheses_with_llm(
            query=query,
            command_history=state.get('command_history', []),
            current_hypotheses=state.get('hypotheses', []),
            iteration=iteration,
            llm_endpoint=state['llm_endpoint'],
            llm_model=brain_model,
            llm_provider=llm_provider,
            api_key=state.get('api_key')
        )

        # Update state with LLM-generated hypotheses
        if hypotheses:
            active_hyp = next((h for h in hypotheses if h['status'] == 'active'), None)
            if active_hyp:
                events.append(emit_event("hypothesis", {
                    "id": active_hyp['id'],
                    "description": active_hyp['description'],
                    "confidence": active_hyp['confidence'],
                    "evidence_count": len(active_hyp.get('supporting_evidence', []))
                }))
                print(f"[supervisor] 🧬 Active hypothesis: {active_hyp['description']} (confidence: {active_hyp['confidence']:.2f})", flush=True)

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

        # Trust the LLM's decision on next_action - no hardcoded overrides
        # The supervisor LLM already has full context and will choose the right approach

        if next_action in ['delegate', 'batch_delegate']:
            await broadcaster.broadcast(emit_event("intent", {"type": "delegating", "message": "Delegating execution to Worker node...", "target": "worker"}))
            events.append(emit_event("progress", {"message": f"🧠 Brain Instruction: {result['plan']}"}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'delegate',
                'current_plan': result['plan'],
                'current_hypothesis': result.get('hypothesis', state.get('current_hypothesis', '')),
                'critic_feedback': None,  # Clear feedback after processing
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
                'hypotheses': hypotheses,  # LLM-generated hypotheses
                'critic_feedback': None,  # Clear feedback after processing
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
                    'hypotheses': hypotheses,  # LLM-generated hypotheses
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
                'hypotheses': hypotheses,  # LLM-generated hypotheses
                'active_hypothesis_id': hypotheses[0]['id'] if hypotheses and hypotheses[0]['status'] == 'active' else None,
                'critic_feedback': None,  # Clear feedback after processing
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
                'critic_feedback': None,  # Clear feedback after processing
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
