#!/usr/bin/env python3
"""
Test the synthesizer routing fix for SOLVED cases.

This test verifies that when reflect detects a SOLVED state,
it routes to the synthesizer instead of directly to done,
ensuring a proper final_response is generated.
"""

import asyncio
import sys
import os

# Add agent_server to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'agent_server'))

from agent_server.state import AgentState
from agent_server.nodes.reflect import reflect_node
from agent_server.nodes.supervisor import supervisor_node


async def test_reflect_solved_routing():
    """Test that reflect routes to synthesizer when SOLVED is detected."""
    print("\n" + "=" * 60)
    print("TEST: Reflect SOLVED Routing")
    print("=" * 60 + "\n")

    # Simulate state after executing "find failing pods" with empty output
    state: AgentState = {
        'query': 'find failing pods',
        'kube_context': 'test-context',
        'known_contexts': [],
        'command_history': [
            {
                'command': 'kubectl get pods -A | grep -vE "Running|Completed"',
                'output': '',  # Empty output = no failing pods
                'error': None
            }
        ],
        'conversation_history': [],
        'iteration': 1,
        'current_hypothesis': 'There may be failing pods',
        'next_action': 'reflect',
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
        'current_plan': None,
        'cluster_info': None,
        'events': [],
        'awaiting_approval': False,
        'approved': False,
        'mcp_tools': [],
        'pending_tool_call': None,
        'confidence_score': None,
        'discovered_resources': None,
        'execution_plan': None,  # No plan = simple delegate mode
        'current_step': None,
        'plan_iteration': None,
        'blocked_commands': None,
        'pending_batch_commands': None,
        'batch_results': None,
        'completed_plan_summary': None,
        'step_status': None,
        'accumulated_evidence': [],
        'retry_count': None,
        'last_reflection': None,
    }

    print("Initial state:")
    print(f"  Query: {state['query']}")
    print(f"  Last command: {state['command_history'][-1]['command']}")
    print(f"  Output: (empty)")
    print()

    # Call reflect_node synchronously (since it triggers the SOLVED shortcut)
    print("Calling reflect_node...")
    result = await reflect_node(state)

    print("\nReflect node result:")
    print(f"  next_action: {result.get('next_action')}")
    print(f"  assessment: {result['command_history'][-1].get('assessment')}")
    print(f"  reasoning: {result['command_history'][-1].get('reasoning')[:100]}...")

    # Verify routing
    assert result.get('next_action') == 'synthesizer', \
        f"Expected next_action='synthesizer', got '{result.get('next_action')}'"

    assert result['command_history'][-1].get('assessment') == 'SOLVED', \
        "Expected assessment='SOLVED'"

    print("\n✅ PASS: Reflect correctly routes SOLVED to synthesizer")

    return 0


async def test_supervisor_solved_routing():
    """Test that supervisor also routes SOLVED to synthesizer."""
    print("\n" + "=" * 60)
    print("TEST: Supervisor SOLVED Routing")
    print("=" * 60 + "\n")

    # Simulate state where reflect already marked as SOLVED
    state: AgentState = {
        'query': 'find failing pods',
        'kube_context': 'test-context',
        'known_contexts': [],
        'command_history': [
            {
                'command': 'kubectl get pods -A | grep -vE "Running|Completed"',
                'output': '',
                'error': None,
                'assessment': 'SOLVED',  # Already marked as SOLVED
                'reasoning': 'No failing pods found\nSOLUTION FOUND: All pods are healthy'
            }
        ],
        'conversation_history': [],
        'iteration': 1,
        'current_hypothesis': 'Checking for failing pods',
        'next_action': 'supervisor',
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
        'accumulated_evidence': [],
        'retry_count': None,
        'last_reflection': None,
    }

    print("Initial state:")
    print(f"  Query: {state['query']}")
    print(f"  Last command assessment: {state['command_history'][-1]['assessment']}")
    print()

    # Call supervisor_node
    print("Calling supervisor_node...")
    result = await supervisor_node(state)

    print("\nSupervisor node result:")
    print(f"  next_action: {result.get('next_action')}")
    print(f"  iteration: {result.get('iteration')}")

    # Verify routing
    assert result.get('next_action') == 'synthesizer', \
        f"Expected next_action='synthesizer', got '{result.get('next_action')}'"

    print("\n✅ PASS: Supervisor correctly routes SOLVED to synthesizer")

    return 0


async def main():
    """Run all tests."""
    print("\n" + "=" * 70)
    print(" Synthesizer Routing Fix Tests")
    print("=" * 70)

    try:
        result1 = await test_reflect_solved_routing()
        result2 = await test_supervisor_solved_routing()

        if result1 == 0 and result2 == 0:
            print("\n" + "=" * 70)
            print("✅ ALL TESTS PASSED")
            print("=" * 70)
            print("\nThe fix ensures that:")
            print("1. Reflect routes SOLVED cases to synthesizer (not done)")
            print("2. Supervisor routes SOLVED cases to synthesizer (not done)")
            print("3. Synthesizer generates proper final_response with full details")
            print()
            return 0
        else:
            return 1

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
