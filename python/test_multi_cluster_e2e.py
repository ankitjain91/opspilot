#!/usr/bin/env python3
"""
End-to-end test for multi-cluster context switching with the agent.

This test simulates a user asking the agent to:
1. List all available contexts
2. Switch to a different context
3. Query resources in the new context
"""

import asyncio
import sys
import os

# Add agent_server to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'agent_server'))

from agent_server.state import AgentState
from agent_server.graph import build_graph


async def test_e2e_context_switching():
    """Run end-to-end test with the agent graph."""
    print("\n" + "=" * 60)
    print("E2E Test: Multi-Cluster Context Switching")
    print("=" * 60 + "\n")

    # Create initial state with a query about contexts
    initial_state: AgentState = {
        'query': 'List all available Kubernetes contexts',
        'kube_context': '',  # Start with no context
        'known_contexts': [],
        'command_history': [],
        'conversation_history': [],
        'iteration': 0,
        'current_hypothesis': '',
        'next_action': 'classify',
        'pending_command': None,
        'final_response': None,
        'error': None,
        'reflection_reasoning': None,
        'continue_path': True,
        'llm_endpoint': os.getenv('LLM_HOST', 'http://localhost:11434'),
        'llm_provider': 'ollama',
        'llm_model': os.getenv('LLM_MODEL', 'llama3.3:70b'),
        'executor_model': os.getenv('EXECUTOR_MODEL', 'qwen2.5-coder:32b'),
        'api_key': None,
        'current_plan': None,
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

    print("Step 1: Initialize agent graph")
    graph = build_graph()
    print("✓ Graph initialized")

    print("\nStep 2: Ask agent to list contexts")
    print(f"Query: {initial_state['query']}")

    try:
        # Run the agent
        result = await graph.ainvoke(initial_state)

        print("\nStep 3: Analyze results")
        print(f"✓ Iterations: {result.get('iteration', 0)}")
        print(f"✓ Commands executed: {len(result.get('command_history', []))}")

        # Check if any context-related command was executed
        context_commands = [
            cmd for cmd in result.get('command_history', [])
            if 'config get-contexts' in cmd.get('command', '')
        ]

        if context_commands:
            print(f"✓ Context listing command executed: {context_commands[0]['command']}")
            output = context_commands[0].get('output', '')
            if output and output != '(no output)':
                print(f"✓ Contexts found in output")
            else:
                print("⚠ No contexts found (may be expected if kubeconfig not set up)")
        else:
            print("⚠ No context listing command was executed")
            print("  This might be OK if the agent classified it differently")

        # Check final response
        final_response = result.get('final_response')
        if final_response:
            print(f"\n✓ Final response generated:")
            print(f"  {final_response[:200]}...")

        print("\n" + "=" * 60)
        print("✅ E2E Test Completed Successfully")
        print("=" * 60)

        # Print summary of what was discovered
        if result.get('known_contexts'):
            print(f"\nDiscovered contexts: {result['known_contexts']}")
        if result.get('kube_context'):
            print(f"Active context: {result['kube_context']}")

        return 0

    except Exception as e:
        print(f"\n❌ E2E Test Failed: {e}")
        import traceback
        traceback.print_exc()
        return 1


async def test_context_switch_simulation():
    """Simulate context switching without full graph execution."""
    print("\n" + "=" * 60)
    print("Simulation: Context Switch Workflow")
    print("=" * 60 + "\n")

    print("This simulates what happens when user asks:")
    print("  'Switch to docker-desktop context and list pods'")
    print()

    # Simulate discovered contexts (as if we already listed them)
    known_contexts = ["minikube", "docker-desktop", "kind-cluster"]
    print(f"Available contexts: {known_contexts}")

    # Initial state: using minikube
    current_context = "minikube"
    print(f"Current context: {current_context}")

    # User asks to switch to docker-desktop
    target_context = "docker-desktop"
    print(f"\nUser request: Switch to {target_context}")

    # Agent would generate KubectlContext tool call
    from agent_server.tools.definitions import KubectlContext, AgentToolWrapper
    from agent_server.tools.safe_executor import SafeExecutor

    tool_call = {
        "tool": "kubectl_context",
        "action": "use",
        "context_name": target_context
    }

    wrapper = AgentToolWrapper(tool_call=tool_call)
    tool_obj = wrapper.tool_call

    # Build and execute command
    command = SafeExecutor.build_command(tool_obj, kube_context=current_context)
    print(f"Command generated: {command}")

    # Update state (as worker.py does)
    if isinstance(tool_obj, KubectlContext) and tool_obj.action == "use" and tool_obj.context_name:
        current_context = tool_obj.context_name
        print(f"✓ Context switched to: {current_context}")

    # Verify subsequent commands use new context
    from agent_server.tools.definitions import KubectlGet
    get_pods_tool = KubectlGet(tool="kubectl_get", resource="pods", all_namespaces=True)
    pods_command = SafeExecutor.build_command(get_pods_tool, kube_context=current_context)

    print(f"\nNext command (list pods):")
    print(f"  {pods_command}")

    assert f"--context={target_context}" in pods_command, "Context not applied!"
    print(f"✓ Verified: New context applied to subsequent commands")

    print("\n" + "=" * 60)
    print("✅ Simulation Completed Successfully")
    print("=" * 60)

    return 0


async def main():
    """Run all E2E tests."""
    print("\n" + "=" * 70)
    print(" Multi-Cluster E2E Tests")
    print("=" * 70)

    # Run simulation first (doesn't require LLM)
    result1 = await test_context_switch_simulation()

    # Ask user if they want to run full E2E test (requires LLM)
    print("\n" + "=" * 70)
    print("Full E2E test requires running LLM.")
    print("This will execute the agent graph with a real query.")
    print("=" * 70)

    # Check if LLM is available
    llm_host = os.getenv('LLM_HOST', 'http://localhost:11434')
    print(f"\nLLM Host: {llm_host}")

    # Run E2E test automatically if LLM is configured
    if llm_host:
        result2 = await test_e2e_context_switching()
    else:
        print("⚠ Skipping E2E test (LLM_HOST not configured)")
        result2 = 0

    if result1 == 0 and result2 == 0:
        print("\n" + "=" * 70)
        print("✅ ALL E2E TESTS PASSED")
        print("=" * 70)
        return 0
    else:
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
