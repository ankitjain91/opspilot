
import asyncio
from agent_server.nodes.plan_executor import plan_executor_node
from agent_server.utils import get_current_step

async def run_simulation():
    # 1. Setup initial state: Step 1 executed, Waiting for decision
    plan = [
        {"step": 1, "description": "Step 1", "status": "in_progress", "command": "echo 1"},
        {"step": 2, "description": "Step 2", "status": "pending", "command": None}
    ]
    
    mock_reflection = {
        "directive": "CONTINUE",
        "thought": "Step 1 worked.",
        "reason": "Success"
    }
    
    state = {
        "execution_plan": plan,
        "step_status": "in_progress",
        "retry_count": 0,
        "last_reflection": mock_reflection,
        "next_action": "execute_next_step", # coming back from reflect
        "command_history": [],
        "events": [],
        "kube_context": "test-context", # Added context
        "discovered_resources": {},
        "current_hypothesis": "simulation"
    }
    
    print("\n--- 1. Calling Plan Executor (Handling CONTINUE) ---")
    result_1 = await plan_executor_node(state)
    
    # Check if Step 1 is completed in the result
    new_plan_1 = result_1.get('execution_plan')
    step_1_status = new_plan_1[0]['status']
    print(f"Step 1 Status: {step_1_status}")
    print(f"Next Action: {result_1.get('next_action')}")
    
    if step_1_status != 'completed':
        print("[X] FAILURE: Step 1 not marked completed!")
        return

    # 2. Simulate Router Loop: Feed result back into Plan Executor
    state_2 = {**state, **result_1}
    
    # We expect Plan Executor to now pick Step 2
    print("\n--- 2. Calling Plan Executor (Picking Next Step) ---")
    result_2 = await plan_executor_node(state_2)
    
    # Check if it is executing Step 2
    events = result_2.get('events', [])
    # Corrected: emit_event returns flat dict, check 'message' directly
    execution_msg = next((e for e in events if e.get('type') == 'progress' and "Step 2" in e.get('message', '')), None)
    
    if execution_msg:
        print("[OK] SUCCESS: Started Step 2 correctly.")
    else:
        print("[X] FAILURE: Did not start Step 2.")
        print(f"Result Events: {events}")
        # Check what step it thought was active
        active_step = get_current_step(result_2.get('execution_plan', []))
        print(f"Active Step found: {active_step}")

if __name__ == "__main__":
    asyncio.run(run_simulation())
