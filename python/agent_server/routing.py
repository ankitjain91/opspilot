
import re
from typing import Literal, Set, Dict
from .config import ROUTING_ENABLED

# =============================================================================
# ROUTING MATRIX: Defines valid transitions between nodes
# This prevents infinite loops by enforcing a DAG-like structure
# =============================================================================
ROUTING_MATRIX: Dict[str, Set[str]] = {
    'classifier': {'supervisor', 'respond', 'done'},
    'supervisor': {'worker', 'batch_execute', 'execute_plan', 'synthesizer', 'architect', 'done'},
    'critic': {'execute_plan', 'supervisor', 'done'},
    'plan_executor': {'worker', 'batch_execute', 'execute_plan', 'synthesizer', 'architect', 'human_approval', 'supervisor', 'done'},
    'worker': {'verify', 'supervisor', 'self_correction'},  # Worker goes to verify/self_correction
    'self_correction': {'command_validator'},
    'command_validator': {'verify', 'supervisor', 'done'},
    'verify': {'execute', 'human_approval', 'done'},
    'human_approval': {'execute', 'human_approval', 'done'},
    'execute': {'reflect'},
    'batch_execute': {'reflect'},
    'reflect': {'execute_plan', 'supervisor', 'synthesizer', 'evidence_validator', 'done'},
    'evidence_validator': {'worker', 'synthesizer', 'done'},
    'synthesizer': {'supervisor', 'worker', 'questioner', 'done'},
    'questioner': {'supervisor', 'done'},
    'architect': {'done'},
}

# Track routing history for loop detection
_routing_history: Dict[str, list] = {}

def validate_routing(current_node: str, next_action: str, thread_id: str = "default") -> tuple[bool, str]:
    """
    Validate that a routing transition is allowed.
    Returns: (is_valid, error_message)
    """
    # Get allowed transitions for current node
    allowed = ROUTING_MATRIX.get(current_node, set())

    # Map next_action to node name (some actions map to different node names)
    action_to_node = {
        'delegate': 'worker',
        'create_plan': 'execute_plan',
        'execute_next_step': 'execute_plan',
        'respond': 'done',  # respond typically ends
    }
    target_node = action_to_node.get(next_action, next_action)

    if not allowed:
        # Unknown current node - allow but warn
        print(f"[routing] WARNING: Unknown current node '{current_node}' - allowing transition", flush=True)
        return (True, "")

    if target_node not in allowed and target_node != 'done':
        error = f"Invalid transition: {current_node} -> {target_node}. Allowed: {allowed}"
        print(f"[routing] BLOCKED: {error}", flush=True)
        return (False, error)

    # Loop detection: Check if we've seen this exact transition recently
    history = _routing_history.get(thread_id, [])
    transition = f"{current_node}->{target_node}"

    # Count recent occurrences of this transition
    recent_count = sum(1 for t in history[-10:] if t == transition)
    if recent_count >= 3:
        error = f"Loop detected: {transition} occurred {recent_count} times in last 10 transitions"
        print(f"[routing] LOOP: {error}", flush=True)
        return (False, error)

    # Record transition
    history.append(transition)
    if len(history) > 20:
        history = history[-20:]
    _routing_history[thread_id] = history

    return (True, "")

def clear_routing_history(thread_id: str = "default"):
    """Clear routing history for a thread (call on new query)."""
    if thread_id in _routing_history:
        del _routing_history[thread_id]

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

    # === STANDARD RESOURCE FILTER ===
    # Only route "list/get" queries to fast model if they target core resources.
    # Custom resources (CRDs) usually require RAG/Knowledge to know the correct API group/version
    STANDARD_RESOURCES = {
        'pod', 'pods', 'po',
        'service', 'services', 'svc',
        'node', 'nodes', 'no',
        'deployment', 'deployments', 'deploy',
        'configmap', 'configmaps', 'cm',
        'secret', 'secrets',
        'namespace', 'namespaces', 'ns',
        'event', 'events',
        'ingress', 'ingresses', 'ing',
        'job', 'jobs',
        'cronjob', 'cronjobs',
        'rs', 'replicaset', 'replicasets',
        'pv', 'pvc', 'persistentvolume', 'persistentvolumeclaim',
        'context', 'contexts',
        'sc', 'storageclass'
    }

    # Extract potential resource name from "list <resource>"
    # Regex captures the first word after "list " or "get "
    match = re.match(r'^(?:list|get|show|count|how many)\s+([a-zA-Z0-9-]+)', query_lower)
    if match:
        resource = match.group(1)
        # If resource is NOT standard (e.g., 'vclusters', 'certificaterequests'), force COMPLEX
        if resource not in STANDARD_RESOURCES and resource not in ['all']:
             return ("complex", f"custom resource '{resource}' requires knowledge context")
        
        # If it IS standard, proceed to simple checks
        pass

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

def should_continue(state: dict) -> Literal['worker', 'smart_executor', 'batch_execute', 'execute_plan', 'supervisor', 'respond', 'synthesizer', 'human_approval', 'verify', 'done']:
    """Determine next node based on supervisor decision."""
    next_action = state.get('next_action')

    if next_action == 'delegate':
        return 'worker'
    if next_action == 'smart_executor':
        return 'smart_executor'  # NEW: Goal-based execution with built-in retry
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
    if next_action == 'verify':
        return 'verify'        # Route from command_validator to verify node

    return 'done'

def handle_approval(state: dict) -> Literal['execute', 'human_approval', 'done']:
    """Determine next node based on approval status.

    Checks both 'approved' flag AND 'next_action' to respect verify node decisions.
    """
    # If verify node decided to terminate (error or completion)
    if state.get('next_action') == 'done':
        return 'done'

    # If explicitly approved by user
    if state.get('approved'):
        return 'execute'

    # If verify node already decided to execute (command is safe)
    if state.get('next_action') == 'execute':
        return 'execute'

    # Otherwise route to human approval
    return 'human_approval'
