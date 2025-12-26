
import asyncio
from agent_server.nodes.plan_executor import plan_executor_node
from agent_server.state import AgentState

async def run_simulation():
    # Mock efficient plan
    plan = [
        {"step": 1, "description": "Check vclusters", "status": "in_progress", "command": "kubectl get vclusters", "output": "found it"}
    ]
    
    # Mock reflection saying SOLVED
    mock_reflection = {
        "directive": "SOLVED",
        "thought": "I found the vcluster.",
        "final_response": "Found it: vcluster-1",
        "reason": "Found it"
    }
    
    # State arriving back at plan_executor after reflection
    state: AgentState = {
        "execution_plan": plan,
        "step_status": "in_progress",
        "retry_count": 0,
        "last_reflection": mock_reflection, # This should trigger SOLVED logic
        "next_action": "execute_next_step",
        "command_history": [{"command": "kubectl get vclusters", "output": "found", "assessment": "SOLVED"}],
        "query": "find vclusters",
        "kube_context": "test"
    }
    
    print("\n--- Simulating Plan Executor (Expect: next_action='done') ---")
    result = await plan_executor_node(state)
    
    print(f"\nResult Action: {result.get('next_action')}")
    print(f"Final Response: {result.get('final_response')}")
    
    if result.get('next_action') == 'done':
        print("[OK] SUCCESS: Plan Executor stopped correctly.")
    else:
        print("[X] FAILURE: Plan Executor continued unnecessarily.")

if __name__ == "__main__":
    asyncio.run(run_simulation())
