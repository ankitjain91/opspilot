
import asyncio
import sys
import os
import json
from typing import Dict, Any
from unittest.mock import patch, MagicMock

# Add current dir to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from agent_server import (
        create_k8s_agent,
        AgentState,
        parse_supervisor_response,
        SUPERVISOR_PROMPT
    )
    import agent_server
    print("✅ Successfully imported agent_server components")
except ImportError as e:
    print(f"❌ Failed to import agent_server: {e}")
    sys.exit(1)

async def test_react_flow():
    print("\n--- Testing ReAct Planning Flow ---")

    # 1. Initialize the agent graph
    app = create_k8s_agent()

    # 2. Simulate a debugging query
    initial_state = {
        "messages": [("user", "Why is the sqlserver pod failing?")],
        "query": "Why is the sqlserver pod failing?",
        "kube_context": "minikube",
        "iteration": 0,
        "command_history": [],
        "execution_plan": [], # Should be populated by supervisor
        "current_step": 0,
        "llm_endpoint": "http://localhost:11434",
        "llm_provider": "ollama",
        "executor_model": "llama2"
    }

    print(f"Starting with query: {initial_state['query']}")

    # 3. Run the graph (we might not be able to run it fully if it depends on external LLM without mocking)
    # But let's try to verify the structure and maybe mock the LLM call if possible.
    # actually, agent_server.py calls the LLM. If we can't call it, this test will fail or hang.
    
    # Check if we can just import the nodes and test them individually with mock state?
    # That might be safer and faster.
    
    from agent_server import supervisor_node, execute_plan_step_node, validate_plan_step_node
    
    # --- Test Supervisor Node (Mocking LLM response) ---
    print("\n[1] Testing Supervisor Node transition to 'create_plan'...")
    
    # Mocking the LLM response within supervisor logic is hard without patching.
    # Instead, let's manually construct the state that supervisor WOULD return if it chose 'create_plan'
    # and then test `execute_plan_step_node`.
    
    mock_plan = [
        {"step": 1, "description": "Check pod status", "command": "kubectl get pods", "status": "pending"},
        {"step": 2, "description": "Check events", "command": "kubectl get events", "status": "pending"}
    ]
    
    state_after_supervisor = {
        **initial_state,
        "next_action": "create_plan",
        "execution_plan": mock_plan,
        "current_step": 1,
        "iteration": 1
    }
    
    print("State after supervisor (mocked):")
    print(json.dumps({k:v for k,v in state_after_supervisor.items() if k != 'messages'}, indent=2))
    
    # --- Test Execute Plan Step Node ---
    print("\n[2] Testing Execute Plan Step Node...")
    state_after_execute = await execute_plan_step_node(state_after_supervisor)
    
    print("State after execute_plan_step:")
    print(json.dumps({k:v for k,v in state_after_execute.items() if k != 'messages'}, indent=2))
    
    if state_after_execute["next_action"] != "delegate":
        print("❌ FAIL: next_action should be 'delegate'")
        return
    if  "Step 1: Check pod status" not in state_after_execute["current_plan"]:
         print(f"❌ FAIL: current_plan not correctly formatted: {state_after_execute.get('current_plan')}")
         return
         
    print("✅ Execute Plan Step Node passed.")
    
    # --- Test Worker Node (Mocked LLM) ---
    print("\n[3] Testing Worker Node (Mocked LLM)...")
    
    # Mock call_llm to return a valid JSON response
    async def mock_call_llm(*args, **kwargs):
        return json.dumps({"thought": "I will run kubectl get pods", "command": "kubectl get pods"})
        
    # Patch agent_server.call_llm
    with patch('agent_server.call_llm', new=mock_call_llm):
        from agent_server import worker_node
        state_after_worker = await worker_node(state_after_execute)
        
    print("State after worker_node:")
    print(json.dumps({k:v for k,v in state_after_worker.items() if k not in ['messages', 'events']}, indent=2))
    
    if state_after_worker['pending_command'] != "kubectl get pods":
        print("❌ FAIL: Worker did not generate expected command")
        return

    # --- Test Validate Plan Step Node ---
    print("\n[4] Testing Validate Plan Step Node...")
    
    # Simulate execution success
    state_after_worker['command_history'] = state_after_worker.get('command_history', []) + [
        {'command': 'kubectl get pods', 'output': 'NAME STATUS\nsqlserver Error', 'error': None}
    ]
    
    state_after_validate = await validate_plan_step_node(state_after_worker)
    
    print("State after validate_plan_step (Iteration 1 - Not Done):")
    print(json.dumps({k:v for k,v in state_after_validate.items() if k not in ['messages', 'events']}, indent=2))
    
    if state_after_validate['current_step'] != 2:
         print(f"❌ FAIL: Did not move to step 2. Current step: {state_after_validate.get('current_step')}")
         return

if __name__ == "__main__":
    asyncio.run(test_react_flow())
