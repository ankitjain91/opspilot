
from typing import TypedDict, Annotated, List, Dict, Any, Union, Optional, Literal

class CommandHistory(TypedDict):
    """Stores the execution and reflection result of a single command."""
    command: str
    output: str
    error: str | None
    assessment: str | None  # Self-reflection assessment
    useful: bool | None
    reasoning: str | None
    hypothesis_id: str | None  # Which hypothesis this command was testing

class Hypothesis(TypedDict):
    """A hypothesis about the root cause of an issue."""
    id: str  # Unique identifier (e.g., "hyp-1", "hyp-2")
    description: str  # The hypothesis statement
    confidence: float  # Current confidence level (0.0-1.0)
    status: Literal['active', 'confirmed', 'refuted', 'abandoned']
    supporting_evidence: List[str]  # Evidence that supports this hypothesis
    contradicting_evidence: List[str]  # Evidence that contradicts this hypothesis
    created_at: int  # Iteration when created
    last_updated: int  # Iteration when last modified
 
class ReflectionData(TypedDict, total=False):
    """Structured output from reflect node."""
    directive: Literal['CONTINUE', 'RETRY', 'SOLVED', 'ABORT']
    verified_facts: List[str]
    next_command_hint: str | None
    reason: str | None

class DebuggingContext(TypedDict, total=False):
    """Structured debugging state extracted from kubectl outputs.

    This context is automatically populated by LLM extraction after each command.
    It provides persistent memory across iterations, preventing the agent from
    "forgetting" critical information like namespaces, resource names, etc.
    """
    # Resource Discovery
    crd_type: str | None  # e.g., "customerclusters", "azuredatabases"
    api_group: str | None  # e.g., "dedicated.uipath.com"
    resource_name: str | None  # e.g., "customercluster-prod"
    namespace: str | None  # e.g., "argocd"

    # Controller Information
    controller_pod: str | None  # e.g., "upbound-provider-azure-xxx"
    controller_namespace: str | None  # e.g., "upbound-system"
    controller_type: str | None  # e.g., "provider", "operator", "controller"

    # Status & Error Information
    status_state: str | None  # e.g., "ASFailed", "Running", "CrashLoopBackOff"
    error_message: str | None  # Primary error message extracted
    error_code: str | None  # e.g., "403", "404", "500"
    error_type: str | None  # e.g., "AuthorizationFailed", "NotFound", "OOMKilled"

    # Investigation Progress (state machine tracking)
    debug_phase: Literal['discovery', 'status_check', 'controller_search', 'log_analysis', 'root_cause_found'] | None
    root_cause_identified: bool  # True if we have definitive root cause

    # Related Resources (for relationship tracking)
    related_resources: List[str] | None  # e.g., ["ReplicaSet/customer-api-7d8f9", "ConfigMap/customer-config"]
    owner_references: List[str] | None  # e.g., ["Deployment/customer-api"]

    # Next Investigation Target
    next_target: str | None  # Suggested next resource to investigate

class AgentState(TypedDict):
    """State for the K8s troubleshooting agent."""
    query: str
    kube_context: str
    known_contexts: list[str]  # Discovered kube contexts
    command_history: list[CommandHistory]
    conversation_history: list[dict] # Previous USER/ASSISTANT turns
    iteration: int
    current_hypothesis: str  # DEPRECATED: Use hypotheses list instead. Kept for backward compatibility.
    hypotheses: List[Hypothesis] | None  # All hypotheses being tracked
    active_hypothesis_id: str | None  # ID of currently active hypothesis being tested
    next_action: Literal['analyze', 'execute', 'reflect', 'respond', 'done', 'human_approval', 'delegate', 'batch_execute', 'create_plan', 'execute_plan_step', 'validate_plan_step', 'invoke_mcp', 'execute_next_step', 'smart_executor']
    pending_command: str | None
    final_response: str | None
    error: str | None
    reflection_reasoning: str | None
    continue_path: bool
    llm_endpoint: str
    llm_provider: str
    llm_model: str
    executor_model: str
    api_key: str | None
    current_plan: str | None
    cluster_info: str | None
    events: list[dict]
    awaiting_approval: bool
    approved: bool
    mcp_tools: list[dict] # Tool definitions passed from frontend
    pending_tool_call: dict | None # { tool: str, args: dict } waiting for frontend execution
    confidence_score: float | None  # Agent's confidence in the final response (0.0-1.0)
    discovered_resources: dict[str, list[str]] | None  # Cache of discovered resources for session continuity
    execution_plan: list[dict] | None  # ReAct plan tracking
    current_step: int | None  # Current step number in plan
    plan_iteration: int | None  # Plan execution iteration counter (separate from supervisor iteration)
    blocked_commands: list[str] | None  # Commands that were blocked to prevent retry loops
    pending_batch_commands: list[str] | None  # List of commands to execute in parallel
    batch_results: list[dict] | None  # Results from parallel batch execution
    completed_plan_summary: str | None  # Summary of completed plan for final synthesis
    step_status: Literal['in_progress', 'success', 'failed', 'retrying', 'solved', 'blocked'] | None  # Outcome of last execution step
    accumulated_evidence: list[str] | None  # Verified facts discovered across plan steps
    retry_count: int | None  # Number of retries for the current step
    last_reflection: ReflectionData | None  # Structured feedback from the reflect node
    suggested_next_steps: list[str] | None  # Proactive suggestions for next queries (max 3)
    debugging_context: Dict[str, Any] | None  # Auto-extracted structured debugging state
    critic_feedback: str | None  # Feedback from Judge when plan is rejected

    # SmartExecutor fields
    information_goal: str | None  # Information goal description from supervisor
    goal_achieved: bool | None  # Whether smart_executor achieved the goal
    gathered_data: str | None  # Data gathered by smart_executor
    successful_strategy: str | None  # Which strategy succeeded
    strategies_tried: list[dict] | None  # All strategies attempted

    # Human-in-the-loop controls
    user_hint: str | None  # User-provided guidance for next step
    skip_current_step: bool | None  # Skip current plan step and move to next
    pause_after_step: bool | None  # Pause for user approval after each step
    
    # Smart Discovery
    project_mappings: list[dict] | None # Image pattern -> Local path mappings
