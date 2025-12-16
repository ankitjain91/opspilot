import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import asyncio
from unittest.mock import patch, MagicMock
from agent_server.tools.definitions import KubectlContext, AgentToolWrapper
from agent_server.tools.safe_executor import SafeExecutor
from agent_server.nodes.worker import worker_node
from agent_server.state import AgentState

def test_kubectl_context_safe_executor():
    """Verify command generation for KubectlContext."""
    print("Testing SafeExecutor...")
    
    # 1. Test List
    tool_list = KubectlContext(tool="kubectl_context", action="list")
    cmd_list = SafeExecutor.build_command(tool_list, kube_context="default")
    cmd_list = SafeExecutor.build_command(tool_list, kube_context="default")
    assert "config get-contexts" in cmd_list
    assert "-o name" in cmd_list
    print("  ✅ List action verified")
    
    # 2. Test Use
    tool_use = KubectlContext(tool="kubectl_context", action="use", context_name="vcluster-1")
    cmd_use = SafeExecutor.build_command(tool_use, kube_context="default")
    assert "echo 'Switching internal context to vcluster-1'" in cmd_use
    assert "kubectl config use-context" not in cmd_use # Ensure no global side effect
    print("  ✅ Use action verified")

async def test_worker_node_context_switch():
    """Verify worker node updates state on context switch."""
    print("Testing Worker Node State Update...")
    
    initial_state = AgentState(
        query="switch to vcluster-1",
        kube_context="default",
        command_history=[],
        llm_endpoint="http://mock",
        llm_model="mock",
        events=[],
        iteration=0,
        start_time=0.0,
        discovered_resources={},
        executor_model="mock" # Fix key error
    )
    
    # Mock LLM response to return a tool call
    mock_response = """
    {
        "thought": "Switching context",
        "tool_call": {
            "tool": "kubectl_context",
            "action": "use",
            "context_name": "vcluster-1"
        }
    }
    """
    
    with patch('agent_server.nodes.worker.call_llm', return_value=mock_response):
        # We also need to patch SafeExecutor.build_command to avoid needing actual tool imports if env is weird,
        # but here we rely on real imports which should work.
        
        # Run worker
        new_state = await worker_node(initial_state)
        
        # VERIFY: State should be updated
        assert new_state['kube_context'] == "vcluster-1", "Worker did not update kube_context in state"
        
        # VERIFY: Pending command should be the echo
        assert "Switching internal context to vcluster-1" in new_state['pending_command']
        
        print("\n✅ Context Switch Verified Successfully")

if __name__ == "__main__":
    # Manual run helper
    import sys
    try:
        test_kubectl_context_safe_executor()
        asyncio.run(test_worker_node_context_switch())
        print("All tests passed!")
    except Exception as e:
        print(f"FAILED: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
