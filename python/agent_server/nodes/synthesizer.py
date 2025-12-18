"""
Synthesizer Node - Evidence-Based Answer Generation

This node:
1. Reviews all collected evidence (command_history, accumulated_evidence)
2. Determines if evidence is sufficient to answer the user's question
3. If SUFFICIENT: Generates final answer and routes to 'done'
4. If INSUFFICIENT: Requests specific additional information and routes back to supervisor

This is a CRITICAL node that ensures we never return vague answers.
"""

from typing import Dict
from ..state import AgentState
from ..utils import emit_event
from ..llm import call_llm
from ..response_formatter import format_intelligent_response_with_llm, validate_response_quality

async def synthesizer_node(state: AgentState) -> Dict:
    """
    Synthesizer: Reviews evidence and determines if we can answer the user.

    Decision Tree:
    1. Analyze all evidence collected so far
    2. Check: Can we answer the user's original question?
    3. If YES → Generate answer → route to 'done'
    4. If NO → Generate specific gap → route to 'supervisor' with request
    """

    query = state.get('query', '')
    command_history = state.get('command_history', [])
    accumulated_evidence = state.get('accumulated_evidence', [])
    events = list(state.get('events', []))
    try:
        from time import time
        events.append(emit_event("progress", {"message": f"[TRACE] synthesizer:start {time():.3f}"}))
    except Exception:
        pass
    iteration = state.get('iteration', 0)

    print(f"[synthesizer] 🧪 Analyzing evidence to answer: '{query}'", flush=True)

    # Emit progress
    events.append(emit_event("progress", {"message": "🧪 Synthesizing answer from collected evidence..."}))

    # Check if we have ANY evidence
    if not command_history and not accumulated_evidence:
        print(f"[synthesizer] ⚠️ No evidence collected yet, routing back to supervisor", flush=True)
        return {
            **state,
            'events': events,
            'next_action': 'supervisor',
            'error': 'No evidence collected - cannot answer query'
        }

    # Build evidence summary for LLM
    evidence_parts = []

    # Add command history (last 5 commands)
    if command_history:
        evidence_parts.append("## Command Execution History\n")
        for cmd_entry in command_history[-5:]:
            cmd = cmd_entry.get('command', '')
            output = cmd_entry.get('output', '')[:500]  # First 500 chars
            evidence_parts.append(f"**Command:** `{cmd}`")
            evidence_parts.append(f"**Output:** {output}\n")

    # Add accumulated evidence
    if accumulated_evidence:
        evidence_parts.append("\n## Verified Facts\n")
        for fact in accumulated_evidence:
            evidence_parts.append(f"- {fact}")

    evidence_summary = "\n".join(evidence_parts)

    # Ask LLM: Can we answer the question with this evidence?
    # Include KB grounding: if relevant KB snippets exist, add them to evidence summary
    kb_context = state.get('kb_context') or ''
    if kb_context:
        evidence_summary += "\n\n## KB Context (Grounding)\n" + kb_context[:2000]
    sufficiency_prompt = f"""You are analyzing whether collected evidence is sufficient to answer a user's question.

**User's Question:** {query}

**Evidence Collected:**
{evidence_summary}

**Task:** Determine if the evidence above is SUFFICIENT to answer the user's question directly.

**MANDATORY SELF-CHECK (Complete this checklist BEFORE deciding):**
┌─────────────────────────────────────────────────────────────┐
│ AUTONOMY VERIFICATION CHECKLIST                             │
├─────────────────────────────────────────────────────────────┤
│ 1. ☐ Did the user ask for specific DATA or CONTENT?        │
│      (e.g., "find X", "show me Y", "get data from Z")      │
│                                                              │
│ 2. ☐ Do I know the kubectl command to get that data?       │
│                                                              │
│ 3. ☐ Have I actually RUN that command and received output? │
│                                                              │
│ 4. ☐ Does the evidence contain the ACTUAL DATA requested?  │
│                                                              │
│ 5. ☐ Am I about to suggest a command instead of providing  │
│      the answer? (If YES → STOP, set can_answer=FALSE)     │
└─────────────────────────────────────────────────────────────┘

**CRITICAL SELF-CRITIQUE:**
- Read your drafted response carefully
- Does it contain phrases like:
  * "you can run..."
  * "try running..."
  * "use kubectl..."
  * "execute this command..."
- If ANY of these appear → DELETE that response immediately
- Set can_answer=FALSE with missing_info explaining what command needs to be run
- **The agent must be AUTONOMOUS** - no delegation to user!

**EXAMPLES - RIGHT vs WRONG:**

❌ WRONG Example 1:
Query: "find insights section in configmap tetrisinputjson"
Evidence: "found configmap in namespace taasvstst"
Response: "The configmap is in namespace taasvstst. You can run: kubectl get configmap tetrisinputjson -n taasvstst -o yaml"
WHY WRONG: Agent delegated to user instead of fetching data autonomously

✅ CORRECT Example 1:
Query: "find insights section in configmap tetrisinputjson"
Evidence: "found configmap in namespace taasvstst" + "ran kubectl get -o yaml" + "insights: [actual data]"
Response: "Found insights section in configmap: [actual data from yaml output]"
WHY CORRECT: Agent fetched and extracted data autonomously

❌ WRONG Example 2:
Query: "why is customercluster failing"
Evidence: "found customercluster in ASFailed state" + "checked events (none)"
Response: "The resource is in ASFailed state. No events found. You may need to check controller logs."
WHY WRONG: Gave up without checking controller logs, delegated investigation to user

✅ CORRECT Example 2:
Query: "why is customercluster failing"
Evidence: "ASFailed state" + "no events" + "found controller" + "logs show: 403 Forbidden"
Response: "Root cause: Azure RBAC authorization failed (403 Forbidden) in upbound-provider-azure controller logs."
WHY CORRECT: Found root cause by checking controller logs autonomously

**Output Format (JSON):**
```json
{{
    "can_answer": true/false,
    "confidence": 0.0-1.0,
    "reasoning": "Brief explanation of why evidence is/isn't sufficient",
    "missing_info": "If can_answer=false, what specific information is missing"
}}
```

**PRIMARY DIRECTIVE - "No Issues" Scenarios:**
- If the query asks "find issues/problems/health" and evidence shows resources exist BUT have NO errors/warnings → can_answer=TRUE with message "No issues found"
- Example: Query "find gateway issues", Evidence shows gateway exists with correct config and no errors → Answer: "No issues found with gateway X. Configuration is correct."
- DO NOT say "potential issue" or "could indicate problem" when there are NO actual errors.
- "Resource exists and is properly configured" = HEALTHY STATE, not an issue.
- Only report issues when you find ACTUAL errors (CrashLoopBackOff, Failed status, error logs, etc.).

**Guidelines:**
- can_answer=true ONLY if you can give a COMPLETE, SPECIFIC answer (not vague)
- can_answer=false if critical details are missing or evidence is unclear
- Be honest - prefer can_answer=false over giving vague answers

**AUTONOMY RULE (NEVER GIVE UP PREMATURELY):**
- If the user asked for specific data/content (e.g., "show me X", "find Y", "get Z")
- AND we know how to get it (we know the kubectl command to run)
- BUT we haven't actually fetched it yet
- → can_answer=FALSE with missing_info="Run kubectl command X to fetch the actual data"
- **NEVER** answer with "You can run this command..." or "Use kubectl get..." - WE run it ourselves!
- The agent must be AUTONOMOUS - if we know what command to run, we execute it and get the result

**SPECIAL CASE - "List/Get/Find" Queries:**
- If the query is "list X", "get X", "find X", "show me X" AND we have kubectl output showing X resources → can_answer=TRUE immediately
- Example: Query "list customerclusters", Evidence shows kubectl output with customercluster resources → can_answer=TRUE (we have the list)
- Don't overthink it - if we executed the list command and got results, that IS the answer
- Empty results (no resources found) is ALSO a valid answer → can_answer=TRUE with "No X resources found"

**CRITICAL - "Fetch Details" Queries (MUST CONTINUE INVESTIGATING):**
- If query asks for details/contents/sections of a resource (e.g., "find insights section in configmap X", "show me data in secret Y")
- AND evidence shows we found the resource location (namespace + name)
- BUT evidence does NOT include the actual data/contents
- → can_answer=FALSE, missing_info="Need to fetch full resource data with kubectl get <type> <name> -n <ns> -o yaml"
- **NEVER say can_answer=TRUE** if you only know WHERE a resource is but haven't fetched WHAT it contains
- Location ≠ Data. Finding the resource is only step 1. Fetching the data is step 2.

**Examples:**
✅ CORRECT: Query "find insights in configmap X", Evidence shows "found configmap X in namespace Y" but no yaml/data → can_answer=FALSE, missing="Need kubectl get configmap X -n Y -o yaml"
❌ WRONG: Query "find insights in configmap X", Evidence shows "found configmap X in namespace Y" → can_answer=TRUE with "use this command..." → NO! Fetch it yourself!

**ANTI-SPECULATION RULES** (STRICTLY ENFORCE):
- NEVER use words: "may", "might", "could", "potentially", "possibly", "seems", "appears to"
- ONLY state FACTS from evidence
- If evidence shows X → Say "X exists" (not "X may exist" or "X could be a problem")
- If evidence shows no errors → Say "No errors found" (not "may be impaired" or "potentially affecting")
- Absence of a resource type (e.g., no nginx-ingress) ≠ problem (cluster might use different solution)
- SPECULATION = WRONG. FACTS ONLY = CORRECT.

**Examples**:
❌ BAD: "This may be impaired, potentially affecting access"
✅ GOOD: "No errors detected. Gateway is configured correctly."

❌ BAD: "No ingress-nginx found, which could indicate issues"
✅ GOOD: "No ingress-nginx controller found. If you need ingress, please specify which type you'd like to check."
"""

    try:
        llm_endpoint = state.get('llm_endpoint')
        llm_model = state.get('llm_model')
        llm_provider = state.get('llm_provider', 'ollama')
        api_key = state.get('api_key')

        sufficiency_response = await call_llm(
            sufficiency_prompt,
            llm_endpoint,
            llm_model,
            llm_provider,
            temperature=0.2,
        # force_json=True,
            api_key=api_key
        )

        import json
        decision = json.loads(sufficiency_response)

        can_answer = decision.get('can_answer', False)
        confidence = decision.get('confidence', 0.0)
        reasoning = decision.get('reasoning', '')
        missing_info = decision.get('missing_info', '')

        # REMOVED: Forced answer generation on SOLVED status (causes false positives)
        # The synthesizer should always trust its own sufficiency assessment
        # last_cmd_assessment = command_history[-1].get('assessment') if command_history else None

        # LLM-DRIVEN DECISION: Trust the synthesizer LLM's analysis completely
        # No hardcoded overrides based on SOLVED/RETRY flags from previous queries
        # The LLM has full context and makes the best decision

        # Optional: Log if there's a conflict between reflection and synthesizer for debugging
        last_reflection = state.get('last_reflection')
        if last_reflection:
            directive = last_reflection.get('directive')
            if (directive == 'SOLVED' and not can_answer) or (directive == 'RETRY' and can_answer):
                print(f"[synthesizer] ℹ️ Note: Reflection directive='{directive}' but synthesizer decided can_answer={can_answer}", flush=True)
                print(f"[synthesizer] Trusting synthesizer LLM analysis: {reasoning}", flush=True)

        print(f"[synthesizer] Decision: can_answer={can_answer}, confidence={confidence:.2f}", flush=True)
        print(f"[synthesizer] Reasoning: {reasoning}", flush=True)

        # LLM-DRIVEN DECISION: Trust synthesizer's can_answer assessment completely
        # No hardcoded iteration limits, complexity keywords, or confidence thresholds
        # The LLM already analyzed evidence sufficiency - trust that decision

        if not can_answer:
                # INSUFFICIENT EVIDENCE - Route directly to worker to gather missing info
                # Routing to supervisor would create circular loop (supervisor → synthesizer → supervisor)
                print(f"[synthesizer] ❌ Insufficient evidence. Missing: {missing_info}", flush=True)
                events.append(emit_event("reflection", {
                    "assessment": "INSUFFICIENT_EVIDENCE",
                    "reasoning": reasoning,
                    "missing": missing_info
                }))

                # CRITICAL FIX: Route to 'worker' not 'supervisor' to break circular routing
                # The worker will generate a command to gather the specific missing information
                return {
                    **state,
                    'events': events,
                    'next_action': 'worker',
                    'current_plan': f"Gather missing information: {missing_info}",
                    'error': None
                }

        # SUFFICIENT EVIDENCE - Generate final answer
        print(f"[synthesizer] ✅ Sufficient evidence (confidence: {confidence:.2f}). Generating answer...", flush=True)

        events.append(emit_event("progress", {"message": "✅ Evidence sufficient - generating final answer..."}))

        # Generate final answer using the response formatter
        final_response = await format_intelligent_response_with_llm(
            query=query,
            command_history=command_history,
            discovered_resources=state.get('discovered_resources', {}),
            hypothesis=state.get('current_hypothesis'),
            llm_endpoint=llm_endpoint,
            llm_model=llm_model,
            llm_provider=llm_provider,
            accumulated_evidence=accumulated_evidence,
            api_key=api_key
        )

        # Validate the generated response and enforce grounding: if no KB/command evidence cited, downgrade
        is_valid, error_msg = validate_response_quality(final_response, query)
        # LLM-DRIVEN: Keep KB grounding check but without hardcoded confidence threshold
        # This is a safety feature for quality, not a decision gate
        if kb_context and 'Unknown' in final_response:
            # If response looks ungrounded while KB context exists, log warning but trust LLM
            print(f"[synthesizer] ℹ️ Response contains 'Unknown' despite KB context (confidence: {confidence:.2f})", flush=True)

        if not is_valid:
            print(f"[synthesizer] ⚠️ Generated response failed validation: {error_msg}", flush=True)
             
            # Native AI Refactor: Trust the LLM's output even if imperfect.
            # Only loop back if the response is completely unusable (empty).
            if error_msg == "Response too short":
                if iteration < 7:
                     events.append(emit_event("reflection", {
                        "assessment": "RESPONSE_TOO_SHORT",
                        "reasoning": f"Generated response was too short/empty. Retrying.",
                        "missing": "Full response needed"
                    }))

                     return {
                        **state,
                        'events': events,
                        'next_action': 'worker',  # Route to worker to gather more info, not supervisor
                        'current_plan': f"Response generation failed (too short). Gather more information.",
                        'error': None
                    }
            
            # For other "quality" issues (placeholders etc), just log but proceed.
            # It's better to show an imperfect answer than loop infinitely.
            print(f"[synthesizer] ℹ️ Proceeding with response despite validation warning.", flush=True)

        # CRITICAL BACKSTOP: If response is empty/None, use simple fallback
        if not final_response or len(final_response) < 10:
             print(f"[synthesizer] ⚠️ Response empty/short. Using reliable fallback.", flush=True)
             from ..response_formatter import _format_simple_fallback
             final_response = _format_simple_fallback(query, command_history, state.get('discovered_resources', {}))

        # LLM-DRIVEN: Remove hardcoded confidence threshold for follow-up suggestions
        # The synthesizer LLM already decided the answer is sufficient - trust that decision
        # If follow-ups are needed, the LLM can include them in the response
        if False:  # Disabled - LLM handles follow-up suggestions in response
            try:
                events.append(emit_event("progress", {"message": "[AUTO_FOLLOWUP] Low confidence — suggesting safe verification commands."}))
            except Exception:
                pass

        # SUCCESS - Return final answer
        print(f"[synthesizer] 🎉 Final answer generated successfully", flush=True)

        events.append(emit_event("progress", {"message": "🎉 Investigation complete!"}))
        # Emit confidence metric for UI/tracing
        try:
            events.append(emit_event("progress", {"message": f"[CONFIDENCE] {confidence:.2f}"}))
        except Exception:
            pass

        # Generate proactive next-step suggestions
        suggestions = await _generate_next_step_suggestions(
            query=query,
            final_response=final_response,
            command_history=command_history,
            discovered_resources=state.get('discovered_resources', {}),
            llm_endpoint=llm_endpoint,
            llm_model=llm_model,
            llm_provider=llm_provider,
            api_key=api_key
        )

        try:
            from time import time
            events.append(emit_event("progress", {"message": f"[TRACE] synthesizer:end {time():.3f}"}))
        except Exception:
            pass
        return {
            **state,
            'final_response': final_response,
            'confidence_score': confidence,
            'suggested_next_steps': suggestions,
            'next_action': 'questioner',  # Route to questioner for quality validation
            'events': events,
            'error': None
        }

    except Exception as e:
        import traceback
        print(f"[synthesizer] ❌ Error during synthesis: {e}", flush=True)
        print(traceback.format_exc(), flush=True)

        # CRITICAL FIX: Route to 'done' not 'supervisor' to prevent error loops
        # Generate a fallback error message for the user
        from ..response_formatter import _format_simple_fallback
        error_response = _format_simple_fallback(query, command_history, state.get('discovered_resources', {}))
        error_response += f"\n\n⚠️ **Error**: An internal error occurred during answer synthesis. The data above is what I was able to gather."

        return {
            **state,
            'events': events,
            'next_action': 'done',
            'final_response': error_response,
            'error': f"Synthesis error: {str(e)}"
        }


async def _generate_next_step_suggestions(
    query: str,
    final_response: str,
    command_history: list,
    discovered_resources: dict,
    llm_endpoint: str,
    llm_model: str,
    llm_provider: str,
    api_key: str | None
) -> list[str]:
    """
    Generate 3 proactive next-step suggestions based on the investigation.

    Returns list of short, actionable query strings (max 3).
    """
    try:
        # Build context from investigation
        resources_str = ""
        if discovered_resources:
            for resource_type, names in discovered_resources.items():
                if names and len(names) > 0:
                    resources_str += f"- {resource_type}: {', '.join(names[:5])}\n"

        last_commands = "\n".join([
            f"- {cmd.get('command', '')}"
            for cmd in command_history[-3:]
        ]) if command_history else "(no commands executed)"

        suggestions_prompt = f"""You are a Kubernetes troubleshooting assistant. Based on the investigation just completed, suggest 3 logical NEXT steps the user might want to explore.

**Original Question:** {query}

**Answer Provided:** {final_response[:500]}

**Commands Executed:**
{last_commands}

**Discovered Resources:**
{resources_str or "(none)"}

**Task:** Generate exactly 3 short, actionable follow-up questions/tasks the user might want to explore next.

**Requirements:**
- Each suggestion must be SHORT (max 6 words)
- Must be ACTIONABLE (not vague)
- Must be RELEVANT to the current investigation context
- Think about logical next steps: drill down, check related resources, investigate root causes, fix issues

**Output Format (JSON):**
```json
{{
    "suggestions": [
        "Check pod logs for errors",
        "Describe failing deployment",
        "List recent events"
    ]
}}
```

Generate suggestions now:"""

        response = await call_llm(
            suggestions_prompt,
            llm_endpoint,
            llm_model,
            llm_provider,
            temperature=0.3,
            api_key=api_key
        )

        import json
        data = json.loads(response)
        suggestions = data.get('suggestions', [])[:3]  # Max 3

        # Validate suggestions are short
        validated = []
        for s in suggestions:
            if s and len(s.split()) <= 8:  # Max 8 words
                validated.append(s)

        print(f"[synthesizer] 💡 Generated {len(validated)} next-step suggestions", flush=True)
        return validated

    except Exception as e:
        print(f"[synthesizer] ⚠️  Failed to generate suggestions: {e}", flush=True)
        # Return empty list on error - suggestions are optional
        return []
