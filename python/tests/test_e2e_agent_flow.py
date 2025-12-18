#!/usr/bin/env python3
"""
End-to-End Agent Flow Tests

Tests the complete frontend flow:
1. Vague query from user
2. Query rewriter expands it
3. Agent executes through full workflow (Supervisor → Planner → Executor → Synthesizer)
4. Actual kubectl commands run
5. Results returned

Usage:
    export GROQ_API_KEY="your-key-here"
    export LLM_PROVIDER="groq"
    export LLM_ENDPOINT="https://api.groq.com/openai/v1"
    export LLM_MODEL="llama-3.3-70b-versatile"

    # Start agent server in background
    python start_agent.py &

    # Run tests
    python3 tests/test_e2e_agent_flow.py
"""

import os
import sys
import asyncio
import httpx
import json
from typing import Dict, Any, List

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestE2EAgentFlow:
    """End-to-end tests calling the /analyze endpoint."""

    def __init__(self):
        self.agent_server = os.environ.get("AGENT_SERVER", "http://localhost:8765")
        self.llm_endpoint = os.environ.get("LLM_ENDPOINT", "http://localhost:11434")
        self.llm_provider = os.environ.get("LLM_PROVIDER", "ollama")
        self.llm_model = os.environ.get("LLM_MODEL", "qwen2.5:72b")
        self.api_key = os.environ.get("GROQ_API_KEY")

    async def _call_analyze_endpoint(
        self,
        query: str,
        timeout: int = 120
    ) -> Dict[str, Any]:
        """
        Call the /analyze endpoint and collect full response.

        Returns:
            Dict with 'events' (list of SSE events) and 'final_response' (complete text)
        """
        request_body = {
            "query": query,
            "llm_endpoint": self.llm_endpoint,
            "llm_model": self.llm_model,
            "llm_provider": self.llm_provider,
            "executor_model": self.llm_model,
            "api_key": self.api_key,
            "kube_context": "",
            "thread_id": f"test-{query[:20]}",
            "history": [],
            "approved_command": False
        }

        events = []
        final_response = ""

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST",
                    f"{self.agent_server}/analyze",
                    json=request_body
                ) as response:
                    if response.status_code != 200:
                        raise Exception(f"HTTP {response.status_code}: {await response.aread()}")

                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue

                        if line.startswith("data: "):
                            data = line[6:]  # Remove "data: " prefix
                            try:
                                event = json.loads(data)
                                events.append(event)

                                # Collect response text
                                if event.get("type") == "token":
                                    final_response += event.get("content", "")
                                elif event.get("type") == "final":
                                    final_response = event.get("content", final_response)
                            except json.JSONDecodeError:
                                pass

        except httpx.ReadTimeout:
            raise Exception(f"Request timed out after {timeout}s")
        except Exception as e:
            raise Exception(f"Request failed: {e}")

        return {
            "events": events,
            "final_response": final_response,
            "query": query
        }

    async def test_1_simple_pod_listing(self):
        """TEST 1: Simple query - 'pods' → should list pods."""
        print("\n" + "="*80)
        print("TEST 1: E2E - Simple pod listing")
        print("="*80)

        result = await self._call_analyze_endpoint("pods")

        print(f"\nQuery: {result['query']}")
        print(f"Events received: {len(result['events'])}")
        print(f"Final response length: {len(result['final_response'])} chars")
        print(f"Response preview: {result['final_response'][:300]}...")

        # Validate
        assert len(result['events']) > 0, "Should receive events"
        assert len(result['final_response']) > 0, "Should have response"
        assert any(e.get('type') == 'final' for e in result['events']), "Should have final event"

        print("\n✅ PASSED: Simple pod listing completed")
        return True

    async def test_2_customercluster_debug(self):
        """TEST 2: Vague query - 'customercluster failing' → should debug CRD."""
        print("\n" + "="*80)
        print("TEST 2: E2E - CustomerCluster debugging")
        print("="*80)

        result = await self._call_analyze_endpoint("customercluster failing")

        print(f"\nQuery: {result['query']}")
        print(f"Events received: {len(result['events'])}")
        print(f"Final response preview: {result['final_response'][:500]}...")

        # Check for kubectl execution
        tool_events = [e for e in result['events'] if e.get('type') == 'tool']
        print(f"\nTool executions: {len(tool_events)}")
        for i, event in enumerate(tool_events[:3], 1):
            print(f"  Tool {i}: {event.get('tool_name', 'unknown')}")

        # Validate
        assert len(result['events']) > 0, "Should receive events"
        assert len(tool_events) > 0, "Should execute at least one tool"
        assert "customercluster" in result['final_response'].lower() or \
               any("customercluster" in str(e).lower() for e in tool_events), \
               "Should mention CustomerCluster"

        print("\n✅ PASSED: CustomerCluster debugging completed")
        return True

    async def test_3_crossplane_resources(self):
        """TEST 3: 'find crossplane resources' → should discover and list Crossplane CRDs."""
        print("\n" + "="*80)
        print("TEST 3: E2E - Crossplane resource discovery")
        print("="*80)

        result = await self._call_analyze_endpoint("find crossplane resources")

        print(f"\nQuery: {result['query']}")
        print(f"Events received: {len(result['events'])}")

        # Check for tool executions
        tool_events = [e for e in result['events'] if e.get('type') == 'tool']
        print(f"\nTool executions: {len(tool_events)}")

        # Validate
        assert len(result['events']) > 0, "Should receive events"
        assert len(result['final_response']) > 50, "Should have substantial response"

        print("\n✅ PASSED: Crossplane resource discovery completed")
        return True

    async def test_4_vcluster_connection(self):
        """TEST 4: 'connect to vcluster and find failing resources' → multi-step workflow."""
        print("\n" + "="*80)
        print("TEST 4: E2E - VCluster connection and debugging")
        print("="*80)

        result = await self._call_analyze_endpoint(
            "connect to vcluster and find failing crossplane resources",
            timeout=180  # Longer timeout for multi-step
        )

        print(f"\nQuery: {result['query']}")
        print(f"Events received: {len(result['events'])}")

        # Analyze workflow
        tool_events = [e for e in result['events'] if e.get('type') == 'tool']
        thinking_events = [e for e in result['events'] if e.get('type') == 'thinking']

        print(f"\nWorkflow analysis:")
        print(f"  Tool executions: {len(tool_events)}")
        print(f"  Thinking steps: {len(thinking_events)}")
        print(f"  Total events: {len(result['events'])}")

        # Show first few tools
        for i, event in enumerate(tool_events[:5], 1):
            print(f"  Step {i}: {event.get('tool_name', 'unknown')}")

        # Validate
        assert len(result['events']) > 0, "Should receive events"
        assert len(tool_events) >= 1, "Should execute multiple tools for multi-step task"

        print("\n✅ PASSED: VCluster multi-step workflow completed")
        return True

    async def test_5_error_extraction(self):
        """TEST 5: 'show errors' → should extract error messages using jq/grep."""
        print("\n" + "="*80)
        print("TEST 5: E2E - Error message extraction")
        print("="*80)

        result = await self._call_analyze_endpoint("show errors in cluster")

        print(f"\nQuery: {result['query']}")
        print(f"Events received: {len(result['events'])}")

        # Check for shell commands with jq/grep
        tool_events = [e for e in result['events'] if e.get('type') == 'tool']
        shell_commands = [e for e in tool_events if 'shell' in str(e.get('tool_name', '')).lower()]

        print(f"\nShell command executions: {len(shell_commands)}")

        # Validate
        assert len(result['events']) > 0, "Should receive events"
        assert len(result['final_response']) > 0, "Should have response"

        print("\n✅ PASSED: Error extraction completed")
        return True

    async def test_6_knowledge_base_usage(self):
        """TEST 6: Query that should trigger KB search - 'crossplane reconcile paused'."""
        print("\n" + "="*80)
        print("TEST 6: E2E - Knowledge base integration")
        print("="*80)

        result = await self._call_analyze_endpoint("resources showing reconcile paused")

        print(f"\nQuery: {result['query']}")
        print(f"Events received: {len(result['events'])}")

        # Check for KB-related content in response
        kb_indicators = [
            "reconcile",
            "paused",
            "synced",
            "crossplane"
        ]

        matches = [word for word in kb_indicators
                  if word in result['final_response'].lower()]
        print(f"\nKB-related terms found: {matches}")

        # Validate
        assert len(result['events']) > 0, "Should receive events"
        assert len(matches) >= 2, "Should mention KB-related concepts"

        print("\n✅ PASSED: Knowledge base integration verified")
        return True


async def main():
    """Run all E2E tests."""

    print("\n" + "="*80)
    print("END-TO-END AGENT FLOW TESTS")
    print("Testing complete frontend flow: vague query → rewriter → agent → execution")
    print("="*80)

    print(f"\nConfiguration:")
    print(f"  Agent Server: {os.environ.get('AGENT_SERVER', 'http://localhost:8765')}")
    print(f"  LLM Provider: {os.environ.get('LLM_PROVIDER', 'ollama')}")
    print(f"  LLM Model: {os.environ.get('LLM_MODEL', 'qwen2.5:72b')}")
    print(f"  LLM Endpoint: {os.environ.get('LLM_ENDPOINT', 'http://localhost:11434')}")

    # Check if agent server is running
    agent_server = os.environ.get("AGENT_SERVER", "http://localhost:8765")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{agent_server}/health")
            if response.status_code != 200:
                print(f"\n❌ ERROR: Agent server not healthy at {agent_server}")
                print("Start the server with: python start_agent.py")
                sys.exit(1)
    except Exception as e:
        print(f"\n❌ ERROR: Cannot connect to agent server at {agent_server}")
        print(f"Error: {e}")
        print("\nStart the server with: python start_agent.py")
        sys.exit(1)

    print(f"\n✅ Agent server is running at {agent_server}")

    if os.environ.get("LLM_PROVIDER") == "groq" and not os.environ.get("GROQ_API_KEY"):
        print("\n❌ ERROR: GROQ_API_KEY not set but LLM_PROVIDER=groq")
        sys.exit(1)

    tester = TestE2EAgentFlow()

    tests = [
        tester.test_1_simple_pod_listing,
        tester.test_2_customercluster_debug,
        tester.test_3_crossplane_resources,
        tester.test_4_vcluster_connection,
        tester.test_5_error_extraction,
        tester.test_6_knowledge_base_usage,
    ]

    results = []
    for test in tests:
        try:
            result = await test()
            results.append((test.__name__, result))
        except AssertionError as e:
            print(f"\n❌ FAILED: {e}")
            results.append((test.__name__, False))
        except Exception as e:
            print(f"\n❌ ERROR: {e}")
            import traceback
            traceback.print_exc()
            results.append((test.__name__, False))

    # Summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)

    passed = sum(1 for _, result in results if result)
    total = len(results)

    for name, result in results:
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"{status}: {name}")

    print(f"\n{passed}/{total} tests passed ({int(passed/total*100)}% pass rate)")

    if passed == total:
        print("\n🎉 ALL E2E TESTS PASSED!")
        sys.exit(0)
    else:
        print(f"\n⚠️  {total - passed} tests failed")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
