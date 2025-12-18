#!/usr/bin/env python3
"""
Integration tests for Query Rewriter with real LLMs and cluster CRDs.

Usage:
    export GROQ_API_KEY="your-key-here"
    export LLM_PROVIDER="groq"
    export LLM_ENDPOINT="https://api.groq.com/openai/v1"
    export LLM_MODEL="llama-3.3-70b-versatile"

    python3 tests/test_query_rewriter.py
"""

import os
import sys
import asyncio
import json

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from agent_server.query_rewriter import rewrite_query


class TestQueryRewriter:
    """Test query rewriting with vague user inputs."""

    def __init__(self):
        self.llm_endpoint = os.environ.get("LLM_ENDPOINT", "http://localhost:11434")
        self.llm_provider = os.environ.get("LLM_PROVIDER", "ollama")
        self.llm_model = os.environ.get("LLM_MODEL", "qwen2.5:72b")
        self.api_key = os.environ.get("GROQ_API_KEY")

    async def test_vague_storage_account_query(self):
        """TEST 1: Rewrite 'find storage account' to specific Crossplane resources."""

        print("\n" + "="*80)
        print("TEST 1: Vague Query - 'find storage account'")
        print("="*80)

        vague_query = "find storage account"

        result = await rewrite_query(
            user_query=vague_query,
            llm_endpoint=self.llm_endpoint,
            llm_model=self.llm_model,
            llm_provider=self.llm_provider,
            api_key=self.api_key
        )

        print(f"\n✓ Original: {result.original_query}")
        print(f"✓ Rewritten: {result.rewritten_query}")
        print(f"✓ Detected Resources: {result.detected_resources}")
        print(f"✓ Confidence: {result.confidence}")
        print(f"✓ Reasoning: {result.reasoning}")

        # Assertions
        assert result.confidence > 0.5, f"❌ FAILED: Low confidence {result.confidence}"
        assert len(result.detected_resources) > 0, "❌ FAILED: No resources detected"
        assert any("storage" in r.lower() for r in result.detected_resources), \
            "❌ FAILED: Expected storage-related resources"
        assert len(result.rewritten_query) > len(vague_query), \
            "❌ FAILED: Rewritten query should be more detailed"

        print("\n✅ PASSED: Successfully rewrote vague storage account query")
        return True

    async def test_vague_customercluster_query(self):
        """TEST 2: Rewrite 'list customerclusters' to detailed query."""

        print("\n" + "="*80)
        print("TEST 2: Vague Query - 'list customerclusters'")
        print("="*80)

        vague_query = "list customerclusters"

        result = await rewrite_query(
            user_query=vague_query,
            llm_endpoint=self.llm_endpoint,
            llm_model=self.llm_model,
            llm_provider=self.llm_provider,
            api_key=self.api_key
        )

        print(f"\n✓ Original: {result.original_query}")
        print(f"✓ Rewritten: {result.rewritten_query}")
        print(f"✓ Detected Resources: {result.detected_resources}")
        print(f"✓ Confidence: {result.confidence}")
        print(f"✓ Reasoning: {result.reasoning}")

        # Assertions
        assert result.confidence > 0.5, f"❌ FAILED: Low confidence {result.confidence}"
        assert any("customercluster" in r.lower() for r in result.detected_resources), \
            "❌ FAILED: Expected customercluster resource"

        print("\n✅ PASSED: Successfully rewrote customercluster query")
        return True

    async def test_vague_debugging_query(self):
        """TEST 3: Rewrite 'why is my pod failing' to actionable debugging steps."""

        print("\n" + "="*80)
        print("TEST 3: Vague Query - 'why is my pod failing'")
        print("="*80)

        vague_query = "why is my pod failing"

        result = await rewrite_query(
            user_query=vague_query,
            llm_endpoint=self.llm_endpoint,
            llm_model=self.llm_model,
            llm_provider=self.llm_provider,
            api_key=self.api_key
        )

        print(f"\n✓ Original: {result.original_query}")
        print(f"✓ Rewritten: {result.rewritten_query}")
        print(f"✓ Detected Resources: {result.detected_resources}")
        print(f"✓ Confidence: {result.confidence}")
        print(f"✓ Reasoning: {result.reasoning}")

        # Assertions
        assert result.confidence > 0.4, f"❌ FAILED: Low confidence {result.confidence}"
        assert ("logs" in result.rewritten_query.lower() or
                "events" in result.rewritten_query.lower() or
                "describe" in result.rewritten_query.lower()), \
            "❌ FAILED: Rewritten query should mention debugging actions (logs/events/describe)"

        print("\n✅ PASSED: Successfully rewrote debugging query")
        return True

    async def test_vague_crossplane_managed_resource(self):
        """TEST 4: Rewrite 'find crossplane resource' to specific CRD search."""

        print("\n" + "="*80)
        print("TEST 4: Vague Query - 'find crossplane resource storage account'")
        print("="*80)

        vague_query = "find crossplane resource storage account"

        result = await rewrite_query(
            user_query=vague_query,
            llm_endpoint=self.llm_endpoint,
            llm_model=self.llm_model,
            llm_provider=self.llm_provider,
            api_key=self.api_key
        )

        print(f"\n✓ Original: {result.original_query}")
        print(f"✓ Rewritten: {result.rewritten_query}")
        print(f"✓ Detected Resources: {result.detected_resources}")
        print(f"✓ Confidence: {result.confidence}")
        print(f"✓ Reasoning: {result.reasoning}")

        # Assertions
        assert result.confidence > 0.5, f"❌ FAILED: Low confidence {result.confidence}"
        assert len(result.detected_resources) > 0, "❌ FAILED: No resources detected"

        print("\n✅ PASSED: Successfully rewrote Crossplane resource query")
        return True

    async def test_ambiguous_error_query(self):
        """TEST 5: Rewrite 'what's wrong' to specific error extraction."""

        print("\n" + "="*80)
        print("TEST 5: Vague Query - 'what's wrong'")
        print("="*80)

        vague_query = "what's wrong"

        result = await rewrite_query(
            user_query=vague_query,
            llm_endpoint=self.llm_endpoint,
            llm_model=self.llm_model,
            llm_provider=self.llm_provider,
            api_key=self.api_key
        )

        print(f"\n✓ Original: {result.original_query}")
        print(f"✓ Rewritten: {result.rewritten_query}")
        print(f"✓ Detected Resources: {result.detected_resources}")
        print(f"✓ Confidence: {result.confidence}")
        print(f"✓ Reasoning: {result.reasoning}")

        # For very vague queries, confidence might be low, which is acceptable
        assert result.confidence >= 0.0, f"❌ FAILED: Negative confidence {result.confidence}"
        assert len(result.rewritten_query) > len(vague_query), \
            "❌ FAILED: Rewritten query should attempt to clarify"

        print("\n✅ PASSED: Handled very vague query appropriately")
        return True


async def main():
    """Run all query rewriter tests."""

    print("\n" + "="*80)
    print("QUERY REWRITER INTEGRATION TESTS")
    print("="*80)
    print(f"\nLLM Provider: {os.environ.get('LLM_PROVIDER', 'ollama')}")
    print(f"LLM Model: {os.environ.get('LLM_MODEL', 'qwen2.5:72b')}")
    print(f"LLM Endpoint: {os.environ.get('LLM_ENDPOINT', 'http://localhost:11434')}")

    if os.environ.get("LLM_PROVIDER") == "groq" and not os.environ.get("GROQ_API_KEY"):
        print("\n❌ ERROR: GROQ_API_KEY not set but LLM_PROVIDER=groq")
        print("Set GROQ_API_KEY environment variable or switch to ollama")
        sys.exit(1)

    tester = TestQueryRewriter()

    tests = [
        tester.test_vague_storage_account_query,
        tester.test_vague_customercluster_query,
        tester.test_vague_debugging_query,
        tester.test_vague_crossplane_managed_resource,
        tester.test_ambiguous_error_query,
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

    print(f"\n{passed}/{total} tests passed")

    if passed == total:
        print("\n🎉 ALL TESTS PASSED!")
        sys.exit(0)
    else:
        print("\n❌ SOME TESTS FAILED")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
