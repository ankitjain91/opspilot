#!/usr/bin/env python3
"""
Integration tests for vague query handling through full pipeline:
vague query → query rewriter → tool selection → execution

This tests the REAL user experience where users type vague queries like:
- "find storage account"
- "why is my pod failing"
- "check the database"

Usage:
    export GROQ_API_KEY="your-key-here"
    export LLM_PROVIDER="groq"
    export LLM_ENDPOINT="https://api.groq.com/openai/v1"
    export LLM_MODEL="llama-3.3-70b-versatile"

    python3 tests/test_vague_query_pipeline.py
"""

import os
import sys
import asyncio
import json
from typing import Dict, Any

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from agent_server.query_rewriter import rewrite_query
from agent_server.llm import call_llm
from agent_server.tools.definitions import AgentToolWrapper


class TestVagueQueryPipeline:
    """Test vague queries through full rewriter → tool selection pipeline."""

    def __init__(self):
        self.llm_endpoint = os.environ.get("LLM_ENDPOINT", "http://localhost:11434")
        self.llm_provider = os.environ.get("LLM_PROVIDER", "ollama")
        self.llm_model = os.environ.get("LLM_MODEL", "qwen2.5:72b")
        self.api_key = os.environ.get("GROQ_API_KEY")
        self.tool_schema = AgentToolWrapper.model_json_schema()

    async def _test_vague_query(
        self,
        vague_query: str,
        expected_resources: list = None,
        expected_tool: str = None,
        test_name: str = "",
    ) -> bool:
        """
        Test a vague query through the full pipeline.

        Args:
            vague_query: The vague user input (e.g., "find storage account")
            expected_resources: Optional list of resources we expect to detect
            expected_tool: Optional tool type we expect (e.g., "shell_command")
            test_name: Name of the test for logging
        """
        print(f"\n{'='*80}")
        print(f"{test_name}: '{vague_query}'")
        print(f"{'='*80}")

        # STEP 1: Query Rewriting
        print(f"\n[STEP 1] Query Rewriter...")
        try:
            rewritten = await rewrite_query(
                user_query=vague_query,
                llm_endpoint=self.llm_endpoint,
                llm_model=self.llm_model,
                llm_provider=self.llm_provider,
                api_key=self.api_key
            )

            print(f"  ✓ Original: {rewritten.original_query}")
            print(f"  ✓ Rewritten: {rewritten.rewritten_query}")
            print(f"  ✓ Detected Resources: {rewritten.detected_resources}")
            print(f"  ✓ Confidence: {rewritten.confidence}")
            print(f"  ✓ Reasoning: {rewritten.reasoning[:100]}...")

            # Validate rewriting worked
            assert rewritten.confidence > 0.3, f"❌ Very low confidence: {rewritten.confidence}"

            if expected_resources:
                detected_any = any(
                    exp.lower() in str(rewritten.detected_resources).lower()
                    for exp in expected_resources
                )
                if not detected_any:
                    print(f"  ⚠️  Warning: Expected resources {expected_resources} not detected")

            # Use rewritten query for next step
            query_for_tool = rewritten.rewritten_query if rewritten.confidence > 0.5 else vague_query

        except Exception as e:
            print(f"  ❌ Query rewriter failed: {e}")
            query_for_tool = vague_query

        # STEP 2: Tool Selection
        print(f"\n[STEP 2] Tool Selection...")
        try:
            full_prompt = f"""You are a Kubernetes CLI executor. Given a task, select the appropriate tool.

Available tools:
{json.dumps(self.tool_schema, indent=2)}

CRITICAL: When debugging CRDs or extracting error messages, use 'shell_command' with jq/grep pipes.
When listing resources, use 'kubectl_get'.

Task: {query_for_tool}

Respond with ONLY a valid JSON tool call in this format:
{{"tool_call": {{"tool": "shell_command", "command": "kubectl get ...", "purpose": "..."}}}}
OR
{{"tool_call": {{"tool": "kubectl_get", "resource": "...", ...}}}}
"""

            response = await call_llm(
                prompt=full_prompt,
                endpoint=self.llm_endpoint,
                model=self.llm_model,
                provider=self.llm_provider,
                temperature=0.0,
                force_json=True,
                api_key=self.api_key
            )

            result = json.loads(response)
            tool_type = result.get("tool_call", {}).get("tool")
            command_or_resource = result.get("tool_call", {}).get("command") or result.get("tool_call", {}).get("resource")

            print(f"  ✓ Selected tool: {tool_type}")
            print(f"  ✓ Command/Resource: {str(command_or_resource)[:200]}...")

            # Validate tool selection
            if expected_tool:
                assert tool_type == expected_tool, \
                    f"❌ Expected tool '{expected_tool}', got '{tool_type}'"

            print(f"\n✅ PASSED: Vague query successfully processed through pipeline")
            return True

        except Exception as e:
            print(f"  ❌ Tool selection failed: {e}")
            import traceback
            traceback.print_exc()
            return False

    async def test_1_find_storage_account(self):
        """TEST 1: 'find storage account' → detect Crossplane CRDs → use appropriate tool."""
        return await self._test_vague_query(
            vague_query="find storage account",
            expected_resources=["storageaccount", "storage"],
            test_name="TEST 1: Vague Query - find storage account"
        )

    async def test_2_why_pod_failing(self):
        """TEST 2: 'why is my pod failing' → suggest debugging actions."""
        return await self._test_vague_query(
            vague_query="why is my pod failing",
            expected_resources=["pod"],
            test_name="TEST 2: Vague Query - why is my pod failing"
        )

    async def test_3_check_database(self):
        """TEST 3: 'check the database' → detect database-related resources."""
        return await self._test_vague_query(
            vague_query="check the database",
            expected_resources=["database", "sql", "postgres", "mysql"],
            test_name="TEST 3: Vague Query - check the database"
        )

    async def test_4_list_clusters(self):
        """TEST 4: 'list clusters' → detect cluster CRDs."""
        return await self._test_vague_query(
            vague_query="list clusters",
            expected_resources=["cluster"],
            test_name="TEST 4: Vague Query - list clusters"
        )

    async def test_5_pods(self):
        """TEST 5: 'pods' → simple one-word query."""
        return await self._test_vague_query(
            vague_query="pods",
            test_name="TEST 5: Vague Query - pods"
        )

    async def test_6_high_memory(self):
        """TEST 6: 'high memory' → identify resource consumption query."""
        return await self._test_vague_query(
            vague_query="high memory",
            expected_tool="shell_command",
            test_name="TEST 6: Vague Query - high memory"
        )

    async def test_7_whats_wrong(self):
        """TEST 7: 'what's wrong' → very vague error query."""
        return await self._test_vague_query(
            vague_query="what's wrong",
            test_name="TEST 7: Vague Query - what's wrong"
        )

    async def test_8_show_errors(self):
        """TEST 8: 'show errors' → detect error extraction need."""
        return await self._test_vague_query(
            vague_query="show errors",
            expected_tool="shell_command",
            test_name="TEST 8: Vague Query - show errors"
        )

    async def test_9_customercluster_failing(self):
        """TEST 9: 'customercluster failing' → detect CRD and debugging."""
        return await self._test_vague_query(
            vague_query="customercluster failing",
            expected_resources=["customercluster"],
            expected_tool="shell_command",
            test_name="TEST 9: Vague Query - customercluster failing"
        )

    async def test_10_investigate_payment(self):
        """TEST 10: 'investigate payment service' → app-level debugging."""
        return await self._test_vague_query(
            vague_query="investigate payment service",
            test_name="TEST 10: Vague Query - investigate payment service"
        )

    async def test_11_secrets(self):
        """TEST 11: 'secrets' → one-word query for sensitive data."""
        return await self._test_vague_query(
            vague_query="secrets",
            test_name="TEST 11: Vague Query - secrets"
        )

    async def test_12_find_config(self):
        """TEST 12: 'find config' → ConfigMap detection."""
        return await self._test_vague_query(
            vague_query="find config",
            expected_resources=["configmap"],
            test_name="TEST 12: Vague Query - find config"
        )

    async def test_13_crashloop(self):
        """TEST 13: 'crashloop' → detect pod restart issues."""
        return await self._test_vague_query(
            vague_query="crashloop",
            expected_tool="shell_command",
            test_name="TEST 13: Vague Query - crashloop"
        )

    async def test_14_production_down(self):
        """TEST 14: 'production is down' → incident investigation."""
        return await self._test_vague_query(
            vague_query="production is down",
            expected_resources=["deployment", "pod", "service"],
            test_name="TEST 14: Vague Query - production is down"
        )

    async def test_15_crossplane_resources(self):
        """TEST 15: 'crossplane resources' → detect managed resources."""
        return await self._test_vague_query(
            vague_query="crossplane resources",
            test_name="TEST 15: Vague Query - crossplane resources"
        )

    async def test_16_vcluster_crossplane_debug(self):
        """TEST 16: 'connect to vcluster and find failing crossplane resources' → multi-step with context switch."""
        return await self._test_vague_query(
            vague_query="connect to vcluster and find failing crossplane resources",
            expected_resources=["vcluster", "crossplane", "managed"],
            expected_tool="shell_command",
            test_name="TEST 16: Vague Query - connect to vcluster and find failing crossplane"
        )


async def main():
    """Run all vague query pipeline tests."""

    print("\n" + "="*80)
    print("VAGUE QUERY PIPELINE INTEGRATION TESTS")
    print("Testing: vague query → query rewriter → tool selection")
    print("="*80)
    print(f"\nLLM Provider: {os.environ.get('LLM_PROVIDER', 'ollama')}")
    print(f"LLM Model: {os.environ.get('LLM_MODEL', 'qwen2.5:72b')}")
    print(f"LLM Endpoint: {os.environ.get('LLM_ENDPOINT', 'http://localhost:11434')}")

    if os.environ.get("LLM_PROVIDER") == "groq" and not os.environ.get("GROQ_API_KEY"):
        print("\n❌ ERROR: GROQ_API_KEY not set but LLM_PROVIDER=groq")
        print("Set GROQ_API_KEY environment variable or switch to ollama")
        sys.exit(1)

    tester = TestVagueQueryPipeline()

    tests = [
        tester.test_1_find_storage_account,
        tester.test_2_why_pod_failing,
        tester.test_3_check_database,
        tester.test_4_list_clusters,
        tester.test_5_pods,
        tester.test_6_high_memory,
        tester.test_7_whats_wrong,
        tester.test_8_show_errors,
        tester.test_9_customercluster_failing,
        tester.test_10_investigate_payment,
        tester.test_11_secrets,
        tester.test_12_find_config,
        tester.test_13_crashloop,
        tester.test_14_production_down,
        tester.test_15_crossplane_resources,
        tester.test_16_vcluster_crossplane_debug,
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
        print("\n🎉 ALL TESTS PASSED!")
        sys.exit(0)
    else:
        print(f"\n⚠️  {total - passed} tests failed")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
