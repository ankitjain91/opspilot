
from langgraph.graph import StateGraph, START, END
from .state import AgentState

# Nodes
from .nodes.supervisor import supervisor_node
from .nodes.worker import worker_node, execute_node, execute_batch_node
from .nodes.reflect import reflect_node
from .nodes.verify import verify_command_node, human_approval_node
from .nodes.planning import execute_plan_step_node, validate_plan_step_node

# Routing Logic
from .routing import should_continue, handle_approval, route_after_validation

def create_k8s_agent():
    """Create the LangGraph agent workflow with ReAct plan execution."""
    workflow = StateGraph(AgentState)

    # Core nodes
    workflow.add_node('supervisor', supervisor_node)
    workflow.add_node('worker', worker_node)
    workflow.add_node('verify', verify_command_node)
    workflow.add_node('human_approval', human_approval_node)
    workflow.add_node('execute', execute_node)
    workflow.add_node('batch_execute', execute_batch_node)
    workflow.add_node('reflect', reflect_node)  # CRITICAL: Stores assessment/reasoning in command history

    # Plan execution nodes (for complex investigations)
    workflow.add_node('execute_plan_step', execute_plan_step_node)
    workflow.add_node('validate_plan_step', validate_plan_step_node)

    workflow.add_edge(START, 'supervisor')
    workflow.add_conditional_edges('supervisor', should_continue, {
        'worker': 'worker',
        'batch_execute': 'batch_execute',
        'execute_plan_step': 'execute_plan_step',  # For complex investigations
        'done': END,
    })

    workflow.add_edge('worker', 'verify')

    workflow.add_conditional_edges('verify', handle_approval, {
        'human_approval': 'human_approval',
        'execute': 'execute',
    })

    workflow.add_conditional_edges('human_approval', handle_approval, {
        'human_approval': END,
        'execute': 'execute',
    })

    # After execute/batch_execute, go to reflect to store assessment
    # The reflect node is CRITICAL - it stores reasoning/assessment in command_history
    workflow.add_edge('execute', 'reflect')
    workflow.add_edge('batch_execute', 'reflect')

    # Reflect routes based on whether we're in plan mode or not
    def route_after_reflect(state: AgentState) -> str:
        """Route from reflect node - go to validation if in plan mode, supervisor otherwise."""
        if state.get('execution_plan') and state.get('current_step'):
            return 'validate_plan_step'
        return 'supervisor'

    workflow.add_conditional_edges('reflect', route_after_reflect, {
        'validate_plan_step': 'validate_plan_step',
        'supervisor': 'supervisor',
    })

    # Plan execution flow
    workflow.add_edge('execute_plan_step', 'worker')  # Plan step generates command via worker

    # Validation decides: next step or plan complete (back to supervisor)
    workflow.add_conditional_edges('validate_plan_step', route_after_validation, {
        'execute_plan_step': 'execute_plan_step',  # Next step in plan
        'supervisor': 'supervisor',                  # Plan complete, supervisor synthesizes
    })

    return workflow.compile()
