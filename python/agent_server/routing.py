
import re
from typing import Literal
from .config import ROUTING_ENABLED

def classify_query_complexity(query: str, command_history: list) -> tuple[str, str]:
    """
    Classify query complexity to route to appropriate model.
    Returns: (complexity: "simple"|"complex", reason: str)

    Simple queries use the fast executor model.
    Complex queries use the large brain model.
    """
    if not query:
        return ("simple", "empty query")
    query_lower = query.lower().strip()

    # === INSTANT SIMPLE (no reasoning needed) ===
    simple_patterns = [
        (r'^list\s+', "listing query"),
        (r'^get\s+', "get query"),
        (r'^show\s+', "show query"),
        (r'^count\s+', "count query"),
        (r'^how many\s+', "count query"),
        (r'^what pods', "pod listing"),
        (r'^what services', "service listing"),
        (r'^what nodes', "node listing"),
        (r'^which namespace', "namespace query"),
        (r'^what version', "version query"),
        (r'^what is the status of', "status check"),
        (r'^check if .+ exists', "existence check"),
        (r'^does .+ exist', "existence check"),
        (r'^is .+ running', "running check"),
        (r'^are there any .+ in', "existence check"),
        (r'^kubectl\s+', "direct kubectl command")
    ]

    for pattern, reason in simple_patterns:
        if re.match(pattern, query_lower):
            return ("simple", reason)

    # Simple yes/no questions without debugging keywords
    if re.match(r'^(is|are|does|do|can|has|have)\s+', query_lower):
        debug_words = ['why', 'error', 'fail', 'wrong', 'problem', 'crash', 'issue']
        if not any(w in query_lower for w in debug_words):
            return ("simple", "yes/no question")

    # === INSTANT COMPLEX (needs deep reasoning) ===
    complex_keywords = [
        ('why', "causal reasoning needed"),
        ('debug', "debugging task"),
        ('troubleshoot', "troubleshooting task"),
        ('investigate', "investigation task"),
        ('root cause', "root cause analysis"),
        ('diagnose', "diagnosis task"),
        ('not working', "failure analysis"),
        ('failing', "failure analysis"),
        ('crashed', "crash analysis"),
        ('oom', "memory issue"),
        ('memory leak', "memory analysis"),
        ('timeout', "timeout analysis"),
        ('stuck', "hang analysis"),
        ('explain why', "causal explanation"),
        ("what's wrong", "problem diagnosis"),
        ('what went wrong', "problem diagnosis"),
        ('fix', "solution needed"),
        ('solve', "solution needed"),
        ('how to resolve', "solution needed"),
    ]

    for keyword, reason in complex_keywords:
        if keyword in query_lower:
            return ("complex", reason)

    # === CONTEXT-BASED (check command history for errors) ===
    if command_history:
        history_text = str(command_history).lower()
        error_indicators = ['error', 'fail', 'crash', 'oom', '137', 'backoff', 'timeout', 'refused', 'asfailed', 'envfailed']
        if any(e in history_text for e in error_indicators):
            return ("complex", "errors in command history")

    # Explanation questions need quality (use complex for better explanations)
    if re.match(r'^(what is |explain |describe |difference between)', query_lower):
        return ("complex", "explanation query")

    # Default: use simple for speed (model can escalate if needed)
    return ("simple", "default to fast model")


def select_model_for_query(state: dict) -> tuple[str, str]:
    """
    Select the appropriate model based on query complexity.
    Returns: (model_name, complexity)
    """
    if not ROUTING_ENABLED:
        return (state['llm_model'], "routing_disabled")

    query = state.get('query', '')
    history = state.get('command_history', [])

    complexity, reason = classify_query_complexity(query, history)

    if complexity == "simple":
        model = state.get('executor_model', 'k8s-cli')
        print(f"[agent-sidecar] Query routed to FAST model ({model}): {reason}", flush=True)
    else:
        model = state['llm_model']
        print(f"[agent-sidecar] Query routed to BRAIN model ({model}): {reason}", flush=True)

    return (model, complexity)

def should_continue(state: dict) -> Literal['worker', 'batch_execute', 'execute_plan', 'supervisor', 'respond', 'synthesizer', 'human_approval', 'done']:
    """Determine next node based on supervisor decision."""
    next_action = state.get('next_action')

    if next_action == 'delegate':
        return 'worker'
    if next_action == 'batch_execute':
        return 'batch_execute'
    if next_action == 'create_plan':
        return 'execute_plan'  # Start plan execution
    if next_action == 'execute_next_step':
        return 'execute_plan'  # Continue plan execution (loop back)
    if next_action == 'supervisor':
        return 'supervisor'    # Return to supervisor (from reflect or synthesizer)
    if next_action == 'synthesizer':
        return 'synthesizer'   # NEW: Route to evidence evaluation
    if next_action == 'respond':
        return 'respond'       # Classifier greeting response
    if next_action == 'architect':
        return 'architect'     # NEW: Route to Generative IaC Node
    if next_action == 'human_approval':
        return 'human_approval'  # Route to approval flow

    return 'done'

def handle_approval(state: dict) -> Literal['execute', 'human_approval']:
    """Determine next node based on approval status.

    Checks both 'approved' flag AND 'next_action' to respect verify node decisions.
    """
    # If explicitly approved by user
    if state.get('approved'):
        return 'execute'

    # If verify node already decided to execute (command is safe)
    if state.get('next_action') == 'execute':
        return 'execute'

    # Otherwise route to human approval
    return 'human_approval'
