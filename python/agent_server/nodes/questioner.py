"""
Questioner Node - Quality Gate for Final Answers

This node acts as the user's advocate, validating that the proposed answer:
1. Actually addresses what the user asked
2. Contains sufficient data/evidence
3. Is actionable and clear

If the answer is insufficient, it sends the investigation back to the supervisor
with specific feedback on what's missing.
"""

from typing import Dict
from ..state import AgentState
from ..llm import call_llm
from ..utils import emit_event
import json


QUESTIONER_PROMPT = """You are the Questioner - a critical quality gate that validates answers on behalf of the user.

ORIGINAL USER QUERY: {query}

PROPOSED ANSWER:
{proposed_answer}

EVIDENCE GATHERED (What the agent investigated):
{accumulated_evidence}

YOUR JOB: Determine if this answer FULLY satisfies what the user asked for.

VALIDATION CHECKLIST:

1. **Does it answer the ACTUAL question?**
   - User asked "find azure resources" but got "CustomerCluster only" → ❌ INSUFFICIENT
   - User asked "why is X failing" but got "X is failing" without root cause → ❌ INSUFFICIENT
   - User asked "list all X" but got partial list or "found X" without listing → ❌ INSUFFICIENT

2. **Is there concrete data/evidence?**
   - Answer says "I found resources" but doesn't list them → ❌ INSUFFICIENT
   - Answer says "root cause is X" with supporting evidence from logs/status → ✅ SUFFICIENT
   - Answer says "no resources found" with evidence of checking → ✅ SUFFICIENT (valid answer)

3. **Is it actionable?**
   - Vague: "There might be an issue" → ❌ INSUFFICIENT
   - Clear: "OOMKilled - increase memory limit to 2Gi" → ✅ SUFFICIENT

COMMON FAILURE PATTERNS TO CATCH:
- Agent found ONE resource type when user asked for "all resources"
- Agent described what they WOULD do instead of showing results
- Agent gave partial data and said "investigation complete" prematurely
- Answer doesn't match the query (user asked X, agent answered Y)

RESPONSE FORMAT (JSON):
{{
    "is_satisfied": true | false,
    "reason": "Brief explanation of why answer is/isn't sufficient",
    "what_is_missing": "Specific guidance on what else needs investigation (only if is_satisfied=false)",
    "confidence": 0.0 to 1.0
}}

EXAMPLES:

Query: "find all azure resources"
Answer: "Found 1 CustomerCluster: taasvstst"
Evidence: ["kubectl get customercluster -A"]
→ {{"is_satisfied": false, "reason": "User asked for ALL azure resources but only checked CustomerCluster. Need to check other azure CRD types.", "what_is_missing": "Check all azure resource types: kubectl api-resources | grep azure, then check each type"}}

Query: "why is pod X crashing"
Answer: "Pod X is in CrashLoopBackOff"
Evidence: ["kubectl get pods", "kubectl describe pod X"]
→ {{"is_satisfied": false, "reason": "Identified symptom but not ROOT CAUSE. Need to check logs.", "what_is_missing": "Check pod logs: kubectl logs X --previous"}}

Query: "list failing pods"
Answer: "Found 3 failing pods: pod-a (OOMKilled), pod-b (ImagePullBackOff), pod-c (CrashLoopBackOff)"
Evidence: ["kubectl get pods -A | grep -v Running", "kubectl describe pods"]
→ {{"is_satisfied": true, "reason": "Complete list with failure reasons provided"}}

Query: "cluster health check"
Answer: "All nodes are Ready, 0 failing pods, no warning events in last hour"
Evidence: ["kubectl get nodes", "kubectl get pods -A", "kubectl get events"]
→ {{"is_satisfied": true, "reason": "Comprehensive health check with concrete findings"}}

CRITICAL: Be strict. If the answer feels incomplete or doesn't match what was asked, mark is_satisfied=false.
The user's time is valuable - better to investigate properly than give half-answers.
"""


async def questioner_node(state: AgentState) -> Dict:
    """
    Questioner: Validates if proposed answer actually satisfies the user's query.

    Acts as quality gate before returning answer to user.
    If answer is insufficient, sends investigation back to supervisor with feedback.
    """
    query = state.get('query', '')
    final_response = state.get('final_response', '')
    accumulated_evidence = state.get('accumulated_evidence', [])
    iteration = state.get('iteration', 0)
    events = list(state.get('events', []))

    print(f"[questioner] 🤔 Validating if answer satisfies user's query: '{query}'", flush=True)

    # Format evidence for review
    evidence_summary = "\n".join([
        f"- Step {i+1}: {ev.get('description', 'Unknown step')}"
        for i, ev in enumerate(accumulated_evidence)
    ]) if accumulated_evidence else "No evidence collected (answer from KB or direct response)"

    # Call LLM to validate answer quality
    prompt = QUESTIONER_PROMPT.format(
        query=query,
        proposed_answer=final_response,
        accumulated_evidence=evidence_summary
    )

    try:
        llm_endpoint = state.get('llm_endpoint', 'http://localhost:11434')
        llm_model = state.get('llm_model', 'llama3.3:70b')

        response = await call_llm(
            prompt=prompt,
            endpoint=llm_endpoint,
            model=llm_model,
            temperature=0.3,  # Low temperature for consistent validation
            max_tokens=500
        )

        # Parse validation result
        validation = json.loads(response)
        is_satisfied = validation.get('is_satisfied', False)
        reason = validation.get('reason', '')
        what_is_missing = validation.get('what_is_missing', '')
        confidence = validation.get('confidence', 0.0)

        print(f"[questioner] {'✅' if is_satisfied else '❌'} Validation: {reason} (confidence: {confidence:.2f})", flush=True)

        if is_satisfied:
            # Answer is good - let it through
            events.append(emit_event("quality_check", {
                "status": "approved",
                "reason": reason,
                "confidence": confidence
            }))

            return {
                **state,
                'events': events,
                'next_action': 'END',  # Proceed to return answer
                'questioner_approved': True
            }
        else:
            # Answer is insufficient - send back to supervisor
            print(f"[questioner] 🔄 Answer insufficient. Feedback: {what_is_missing}", flush=True)

            events.append(emit_event("quality_check", {
                "status": "rejected",
                "reason": reason,
                "what_is_missing": what_is_missing,
                "confidence": confidence
            }))

            # Clear the insufficient final_response so supervisor knows to continue
            return {
                **state,
                'events': events,
                'next_action': 'supervisor',  # Route back to supervisor
                'final_response': None,  # Clear bad answer
                'questioner_feedback': what_is_missing,  # Give supervisor guidance
                'questioner_approved': False,
                'iteration': iteration  # Don't increment - same investigation
            }

    except json.JSONDecodeError as e:
        print(f"[questioner] ⚠️ Failed to parse validation response: {e}", flush=True)
        # On parse error, be permissive and let answer through
        # (Better to show potentially incomplete answer than block everything)
        return {
            **state,
            'events': events,
            'next_action': 'END',
            'questioner_approved': True
        }
    except Exception as e:
        print(f"[questioner] ⚠️ Validation error: {e}", flush=True)
        # On error, let answer through
        return {
            **state,
            'events': events,
            'next_action': 'END',
            'questioner_approved': True
        }
