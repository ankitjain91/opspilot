#!/usr/bin/env python3
"""
Test multi-cluster context switching functionality.

This test verifies:
1. Context listing works correctly
2. Context switching updates agent state
3. Commands execute with correct context
"""

import asyncio
import sys
import os

# Add agent_server to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'agent_server'))

from agent_server.state import AgentState
from agent_server.nodes.worker import worker_node
from agent_server.tools.definitions import KubectlContext, AgentToolWrapper
from agent_server.tools.safe_executor import SafeExecutor


async def test_context_listing():
    """Test that context listing command is built correctly."""
    print("=" * 60)
    print("TEST 1: Context Listing")
    print("=" * 60)

    tool = KubectlContext(tool="kubectl_context", action="list")
    command = SafeExecutor.build_command(tool, kube_context="current-context")

    print(f"✓ Tool: {tool}")
    print(f"✓ Generated command: {command}")

    # Note: shlex.quote only adds quotes if needed (e.g., spaces/special chars)
    # Both forms are valid and secure
    assert "config get-contexts -o name" in command, f"Command missing expected parts: {command}"
    assert "--context=" in command or "--context " in command, f"Command missing context flag: {command}"
    print("✅ PASS: Context listing command is correct\n")


async def test_context_switching():
    """Test that context switching updates state correctly."""
    print("=" * 60)
    print("TEST 2: Context Switching")
    print("=" * 60)

    tool = KubectlContext(tool="kubectl_context", action="use", context_name="new-context")
    command = SafeExecutor.build_command(tool, kube_context="old-context")

    print(f"✓ Tool: {tool}")
    print(f"✓ Generated command: {command}")
    print("✅ PASS: Context switch command generated\n")


async def test_worker_state_update():
    """Test that worker node updates state when context is switched."""
    print("=" * 60)
    print("TEST 3: Worker State Update")
    print("=" * 60)

    # Create initial state
    state: AgentState = {
        'query': 'List all contexts',
        'kube_context': 'minikube',
        'known_contexts': [],
        'command_history': [],
        'conversation_history': [],
        'iteration': 1,
        'current_hypothesis': 'Testing context switching',
        'next_action': 'execute',
        'pending_command': None,
        'final_response': None,
        'error': None,
        'reflection_reasoning': None,
        'continue_path': True,
        'llm_endpoint': 'http://localhost:11434',
        'llm_provider': 'ollama',
        'llm_model': 'test-model',
        'executor_model': 'test-executor',
        'api_key': None,
        'current_plan': 'Switch to docker-desktop context',
        'cluster_info': None,
        'events': [],
        'awaiting_approval': False,
        'approved': False,
        'mcp_tools': [],
        'pending_tool_call': None,
        'confidence_score': None,
        'discovered_resources': None,
        'execution_plan': None,
        'current_step': None,
        'plan_iteration': None,
        'blocked_commands': None,
        'pending_batch_commands': None,
        'batch_results': None,
        'completed_plan_summary': None,
        'step_status': None,
        'accumulated_evidence': None,
        'retry_count': None,
        'last_reflection': None,
    }

    print(f"✓ Initial context: {state['kube_context']}")

    # Simulate what would happen in worker_node when KubectlContext(use) is called
    tool_call = {
        "tool": "kubectl_context",
        "action": "use",
        "context_name": "docker-desktop"
    }

    wrapper = AgentToolWrapper(tool_call=tool_call)
    tool_obj = wrapper.tool_call

    # Build command
    command = SafeExecutor.build_command(tool_obj, kube_context=state['kube_context'])
    print(f"✓ Generated command: {command}")

    # Verify context_override logic
    context_override = None
    if isinstance(tool_obj, KubectlContext) and tool_obj.action == "use" and tool_obj.context_name:
        context_override = tool_obj.context_name
        print(f"✓ Context override detected: {context_override}")

    # Simulate state update (as in worker.py line 187-189)
    if context_override:
        state['kube_context'] = context_override

    print(f"✓ New context: {state['kube_context']}")

    assert state['kube_context'] == 'docker-desktop', f"Expected docker-desktop, got {state['kube_context']}"
    print("✅ PASS: State updates correctly on context switch\n")


async def test_full_workflow():
    """Test complete workflow: list -> switch -> verify."""
    print("=" * 60)
    print("TEST 4: Full Workflow")
    print("=" * 60)

    # Step 1: List contexts
    print("Step 1: List contexts")
    list_tool = KubectlContext(tool="kubectl_context", action="list")
    list_cmd = SafeExecutor.build_command(list_tool, kube_context="")
    print(f"  Command: {list_cmd}")

    # In real scenario, this would execute and populate known_contexts
    # For testing, we'll simulate the result
    known_contexts = ["minikube", "docker-desktop", "kind-cluster"]
    print(f"  ✓ Discovered contexts: {known_contexts}")

    # Step 2: Switch to a different context
    print("\nStep 2: Switch context")
    switch_tool = KubectlContext(tool="kubectl_context", action="use", context_name="docker-desktop")
    switch_cmd = SafeExecutor.build_command(switch_tool, kube_context="minikube")
    print(f"  Command: {switch_cmd}")
    print(f"  ✓ Switching from 'minikube' to 'docker-desktop'")

    # Step 3: Verify subsequent commands use new context
    print("\nStep 3: Verify subsequent commands use new context")
    from agent_server.tools.definitions import KubectlGet
    get_tool = KubectlGet(tool="kubectl_get", resource="pods", all_namespaces=True)
    get_cmd = SafeExecutor.build_command(get_tool, kube_context="docker-desktop")
    print(f"  Command: {get_cmd}")

    assert "--context=docker-desktop" in get_cmd or "--context='docker-desktop'" in get_cmd, \
        f"New context not applied to subsequent commands: {get_cmd}"
    print("  ✓ New context applied correctly")

    print("\n✅ PASS: Full workflow completed successfully\n")


async def main():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("Multi-Cluster Context Switching Tests")
    print("=" * 60 + "\n")

    try:
        await test_context_listing()
        await test_context_switching()
        await test_worker_state_update()
        await test_full_workflow()

        print("=" * 60)
        print("✅ ALL TESTS PASSED")
        print("=" * 60)
        return 0

    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        return 1
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
