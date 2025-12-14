
from typing import TypedDict, Literal, List, Dict, Optional

class CommandHistory(TypedDict):
    """Stores the execution and reflection result of a single command."""
    command: str
    output: str
    error: str | None
    assessment: str | None  # Self-reflection assessment
    useful: bool | None
    reasoning: str | None

class AgentState(TypedDict):
    """State for the K8s troubleshooting agent."""
    query: str
    kube_context: str
    command_history: list[CommandHistory]
    conversation_history: list[dict] # Previous USER/ASSISTANT turns
    iteration: int
    current_hypothesis: str  # The active hypothesis being tested (e.g. "Pod is crashing due to OOM")
    next_action: Literal['analyze', 'execute', 'reflect', 'respond', 'done', 'human_approval', 'delegate', 'batch_execute', 'create_plan', 'execute_plan_step', 'validate_plan_step', 'invoke_mcp']
    pending_command: str | None
    final_response: str | None
    error: str | None
    reflection_reasoning: str | None
    continue_path: bool
    llm_endpoint: str
    llm_provider: str
    llm_model: str
    executor_model: str
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
