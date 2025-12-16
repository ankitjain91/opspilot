
from typing import TypedDict, Literal, List, Dict, Optional

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
    next_action: Literal['analyze', 'execute', 'reflect', 'respond', 'done', 'human_approval', 'delegate', 'batch_execute', 'create_plan', 'execute_plan_step', 'validate_plan_step', 'invoke_mcp', 'execute_next_step']
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
