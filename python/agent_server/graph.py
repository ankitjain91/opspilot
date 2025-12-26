
from langgraph.graph import StateGraph, START, END
from .state import AgentState

# Nodes
from .nodes.classifier import classifier_node
from .nodes.supervisor import supervisor_node
from .nodes.worker import worker_node, execute_node, execute_batch_node
from .nodes.self_correction import self_correction_node
from .nodes.command_validator import command_validator_node
from .nodes.reflect import reflect_node
from .nodes.verify import verify_command_node, human_approval_node
from .nodes.plan_executor import plan_executor_node
from .nodes.synthesizer import synthesizer_node
from .nodes.evidence_validator import evidence_validator_node  # NEW: Evidence gate
from .nodes.architect import architect_node
from .nodes.critic import critic_node  # NEW: The Judge
from .nodes.questioner import questioner_node  # NEW: Quality gate for answers
from .nodes.questioner import questioner_node  # NEW: Quality gate for answers

# Routing Logic
from .routing import should_continue, handle_approval

def create_k8s_agent(checkpointer=None):
    """Create the LangGraph agent workflow with simplified plan execution."""
    workflow = StateGraph(AgentState)

    # Core nodes
    workflow.add_node('classifier', classifier_node)
    workflow.add_node('supervisor', supervisor_node)
    workflow.add_node('worker', worker_node)
    workflow.add_node('verify', verify_command_node)
    workflow.add_node('human_approval', human_approval_node)
    workflow.add_node('execute', execute_node)
    workflow.add_node('batch_execute', execute_batch_node)
    workflow.add_node('reflect', reflect_node)
    workflow.add_node('evidence_validator', evidence_validator_node)  # NEW: Evidence gate
    workflow.add_node('synthesizer', synthesizer_node)
    workflow.add_node('questioner', questioner_node)  # NEW: Quality gate
    workflow.add_node('architect', architect_node)
    workflow.add_node('critic', critic_node) # NEW: Add Critc Node

    # Plan execution - simplified to single self-contained node
    workflow.add_node('plan_executor', plan_executor_node)

    # Entry Point: Classifier first
    workflow.add_edge(START, 'classifier')
    
    # Classifier currently only routes to supervisor, but we use conditional edge for future proofing
    workflow.add_conditional_edges('classifier', should_continue, {
        'supervisor': 'supervisor',
        'respond': 'supervisor',
        'done': END,
    })

    workflow.add_conditional_edges('supervisor', should_continue, {
        'worker': 'worker',
        'worker': 'worker',
        'batch_execute': 'batch_execute',
        'batch_execute': 'batch_execute',
        'execute_plan': 'critic',  # CHANGED: Route plans to Critic first
        'synthesizer': 'synthesizer',
        'architect': 'architect',
        'done': END,
    })

    # Critic decides: Approve -> Plan Executor, Reject -> Supervisor
    workflow.add_conditional_edges('critic', should_continue, {
        'execute_plan': 'plan_executor', # Approved Plan
        'invoke_mcp': 'critic',          # (Recursive? No, should map to halt/done or specialized handler. Wait, mcp usually halts. Let's map to END for now as per legacy behavior, OR implement mcp node? Supervisor halts on invoke_mcp. If Critic restores 'invoke_mcp', we need to halt.)
                                         # Actually, if supervisor returns 'invoke_mcp', routing would map it do 'done' if missing? 
                                         # Let's check should_continue logic again. It maps 'invoke_mcp' (not present) to 'done'.
                                         # So we can map 'execute_plan' to 'plan_executor'.
                                         # But what if critic rejects? It returns 'supervisor'.
        'supervisor': 'supervisor',
        'done': END, # Fallback
    })

    # Plan executor processes one step then loops back to itself or ends
    workflow.add_conditional_edges('plan_executor', should_continue, {
        'worker': 'worker', 
        'batch_execute': 'batch_execute', 
        'execute_plan': 'plan_executor',
        'synthesizer': 'synthesizer',
        'architect': 'architect',
        'human_approval': 'human_approval', 
        'supervisor': 'supervisor',
        'done': END, 
    })

    # Route worker output through self-correction -> validator -> verify
    workflow.add_edge('worker', 'self_correction')
    workflow.add_node('self_correction', self_correction_node)
    workflow.add_edge('self_correction', 'command_validator')
    workflow.add_node('command_validator', command_validator_node)

    # Validator can route to verify (if valid) or supervisor (if invalid)
    workflow.add_conditional_edges('command_validator', should_continue, {
        'verify': 'verify',
        'supervisor': 'supervisor',
        'done': END,
    })

    workflow.add_conditional_edges('verify', handle_approval, {
        'human_approval': 'human_approval',
        'execute': 'execute',
        'done': END,
    })

    # Stay in human_approval until approved; then proceed to execute
    workflow.add_conditional_edges('human_approval', handle_approval, {
        'human_approval': 'human_approval',
        'execute': 'execute',
        'done': END,
    })

    # After execute/batch_execute, go to reflect then route based on context
    workflow.add_edge('execute', 'reflect')
    workflow.add_edge('batch_execute', 'reflect')



    # NEW FLOW: Reflect -> Evidence Validator -> [Worker OR Synthesizer] -> [Done OR Supervisor]
    workflow.add_conditional_edges('reflect', should_continue, {
        'execute_plan': 'plan_executor',
        'supervisor': 'supervisor',
        'synthesizer': 'evidence_validator',  # Route to evidence validator first
        'done': END,
    })

    # Evidence Validator: Gate before synthesizer - blocks premature exits
    workflow.add_conditional_edges('evidence_validator', should_continue, {
        'worker': 'worker',          # Insufficient evidence - route back to worker
        'synthesizer': 'synthesizer', # Evidence sufficient - allow synthesizer
        'done': END,
    })

    # Synthesizer decides: Can we answer? If yes -> Questioner (quality gate), if no -> supervisor with specific request
    workflow.add_conditional_edges('synthesizer', should_continue, {
        'supervisor': 'supervisor',
        'worker': 'worker',          # NEW: Can route directly to worker
        'questioner': 'questioner',  # NEW: Route to questioner for quality validation
        'done': END,
    })

    # Questioner validates answer quality: If approved -> END, if rejected -> Supervisor
    workflow.add_conditional_edges('questioner', should_continue, {
        'supervisor': 'supervisor',  # Answer insufficient - continue investigation
        'done': END,                 # Answer approved - return to user
    })

    workflow.add_edge('architect', END) 

    return workflow.compile(checkpointer=checkpointer)
