"""
Comprehensive Agent Accuracy & Performance Test Suite

Tests the agent against real cluster scenarios to identify:
- Routing issues (supervisor choosing wrong execution path)
- Performance regressions (excessive command count)
- Accuracy issues (wrong answers)
- Crash scenarios

Uses remote models on 20.56.146.53:
- Brain: opspilot-brain:latest
- Executor: qwen2.5:72b
"""

import asyncio
import httpx
import json
import time
from typing import Dict, List, Optional
from dataclasses import dataclass

# Configuration
AGENT_SERVER_URL = "http://localhost:8766"
LLM_HOST = "http://20.56.146.53:11434"
BRAIN_MODEL = "opspilot-brain:latest"
EXECUTOR_MODEL = "qwen2.5:72b"
KUBE_CONTEXT = "vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj"

@dataclass
class TestResult:
    """Test result with performance metrics and validation."""
    query: str
    passed: bool
    reason: str
    command_count: int = 0
    execution_time: float = 0.0
    expected_max_commands: Optional[int] = None
    answer: str = ""
    expected_routing: Optional[str] = None
    actual_routing: Optional[str] = None

    def __str__(self):
        status = "[OK] PASS" if self.passed else "[X] FAIL"
        perf = f"({self.command_count} cmds, {self.execution_time:.1f}s)"
        if not self.passed:
            return f"{status} {perf} - {self.query}\n  Reason: {self.reason}"
        return f"{status} {perf} - {self.query}"


class AgentTester:
    """Comprehensive agent testing framework."""

    def __init__(self):
        self.results: List[TestResult] = []
        self.client = httpx.AsyncClient(timeout=300.0)

    async def run_query(self, query: str, expected_max_commands: Optional[int] = None,
                       expected_routing: Optional[str] = None) -> TestResult:
        """Execute a query and validate results."""
        print(f"\n🧪 Testing: {query}")
        print(f"   Expected routing: {expected_routing}, Max commands: {expected_max_commands}")

        start_time = time.time()
        command_count = 0
        answer = ""
        actual_routing = None
        events = []

        try:
            # Create agent
            response = await self.client.post(
                f"{AGENT_SERVER_URL}/create-agent",
                json={
                    "cluster_name": "test-cluster",
                    "kube_context": KUBE_CONTEXT,
                    "llm_host": LLM_HOST,
                    "llm_model": BRAIN_MODEL,
                    "executor_model": EXECUTOR_MODEL,
                }
            )
            response.raise_for_status()
            agent_data = response.json()
            thread_id = agent_data["thread_id"]

            print(f"   Agent created: {thread_id}")

            # Execute query
            async with self.client.stream(
                "POST",
                f"{AGENT_SERVER_URL}/query",
                json={"thread_id": thread_id, "query": query}
            ) as stream_response:
                async for line in stream_response.aiter_lines():
                    if not line.startswith("data: "):
                        continue

                    event_data = line[6:]
                    if event_data == "[DONE]":
                        break

                    try:
                        event = json.loads(event_data)
                        events.append(event)

                        # Track command executions
                        if event.get("type") == "command_execution":
                            command_count += 1
                            print(f"   [{command_count}] {event.get('data', {}).get('command', 'unknown')}")

                        # Detect routing decisions
                        if event.get("type") == "intent":
                            intent_msg = event.get("data", {}).get("message", "")
                            if "SmartExecutor activated" in intent_msg:
                                actual_routing = "smart_executor"
                                print(f"   [TARGET] Routing: smart_executor")
                            elif "Creating plan" in intent_msg or "Plan created" in intent_msg:
                                actual_routing = "create_plan"
                                print(f"   [LIST] Routing: create_plan")
                            elif "Delegating" in intent_msg:
                                actual_routing = "delegate"
                                print(f"   [FIX] Routing: delegate")

                        # Capture final answer
                        if event.get("type") == "final_answer":
                            answer = event.get("data", {}).get("answer", "")
                            print(f"   [MSG] Answer received ({len(answer)} chars)")

                    except json.JSONDecodeError:
                        continue

            execution_time = time.time() - start_time

            # Validate results
            passed = True
            reason = "Success"

            # Check command count
            if expected_max_commands and command_count > expected_max_commands:
                passed = False
                reason = f"Excessive commands: {command_count} > {expected_max_commands} expected"

            # Check routing
            if expected_routing and actual_routing != expected_routing:
                passed = False
                reason = f"Wrong routing: got {actual_routing}, expected {expected_routing}"

            # Check for crashes
            if not answer and command_count == 0:
                passed = False
                reason = "Agent crashed - no answer or commands executed"

            result = TestResult(
                query=query,
                passed=passed,
                reason=reason,
                command_count=command_count,
                execution_time=execution_time,
                expected_max_commands=expected_max_commands,
                answer=answer,
                expected_routing=expected_routing,
                actual_routing=actual_routing
            )

            print(f"   {result}")
            return result

        except Exception as e:
            execution_time = time.time() - start_time
            result = TestResult(
                query=query,
                passed=False,
                reason=f"Exception: {str(e)}",
                command_count=command_count,
                execution_time=execution_time,
                expected_max_commands=expected_max_commands,
                expected_routing=expected_routing,
                actual_routing=actual_routing
            )
            print(f"   {result}")
            return result

    async def test_discovery_queries(self):
        """Test resource discovery queries - should use smart_executor."""
        print("\n" + "="*80)
        print("CATEGORY: Discovery Queries (find X, list Y)")
        print("="*80)

        tests = [
            # Known failing cases from conversation
            ("find eventhubs", 3, "smart_executor"),  # Was taking 8 commands
            ("find signalr azure", 3, "smart_executor"),  # Was crashing with SafeExecutor error
            ("find crossplane managed azure resources", 5, "smart_executor"),

            # Additional discovery tests
            ("list vclusters", 3, "smart_executor"),
            ("find all azure databases", 3, "smart_executor"),
            ("show all customerclusters", 3, "smart_executor"),
            ("get all istio resources", 3, "smart_executor"),
            ("find configmaps with name tetrisinputjson", 2, "smart_executor"),
            ("list all CRDs related to crossplane", 3, "smart_executor"),
        ]

        for query, max_cmds, expected_route in tests:
            result = await self.run_query(query, max_cmds, expected_route)
            self.results.append(result)
            await asyncio.sleep(2)  # Rate limiting

    async def test_status_health_checks(self):
        """Test status/health check queries - should use smart_executor."""
        print("\n" + "="*80)
        print("CATEGORY: Status & Health Checks")
        print("="*80)

        tests = [
            # Known failing case - THE BIG ONE (82 steps!)
            ("are all eventhub healthy in this cluster?", 5, "smart_executor"),

            # Additional health checks
            ("are vclusters healthy?", 5, "smart_executor"),
            ("check if databases are ready", 5, "smart_executor"),
            ("is the nginx deployment running?", 3, "smart_executor"),
            ("what is the status of azure resources?", 5, "smart_executor"),
            ("are there any failing pods?", 3, "smart_executor"),
            ("check cluster health", 5, "batch_delegate"),  # Known commands in parallel
        ]

        for query, max_cmds, expected_route in tests:
            result = await self.run_query(query, max_cmds, expected_route)
            self.results.append(result)
            await asyncio.sleep(2)

    async def test_deep_investigation(self):
        """Test deep investigation queries - should use create_plan."""
        print("\n" + "="*80)
        print("CATEGORY: Deep Investigation (Why/Debug)")
        print("="*80)

        tests = [
            # These SHOULD use create_plan (multi-step hypothesis testing)
            ("why is the eventhub pod failing?", 20, "create_plan"),  # Needs logs, events, analysis
            ("debug the crash loop in nginx", 20, "create_plan"),
            ("what is causing the azure resource to fail?", 20, "create_plan"),
            ("root cause of database connection errors", 20, "create_plan"),
        ]

        for query, max_cmds, expected_route in tests:
            result = await self.run_query(query, max_cmds, expected_route)
            self.results.append(result)
            await asyncio.sleep(2)

    async def test_simple_queries(self):
        """Test simple single-command queries - should use delegate."""
        print("\n" + "="*80)
        print("CATEGORY: Simple Single-Command Queries")
        print("="*80)

        tests = [
            ("list pods", 1, "delegate"),
            ("get nodes", 1, "delegate"),
            ("kubectl get namespaces", 1, "delegate"),
            ("show me all deployments", 2, "delegate"),
        ]

        for query, max_cmds, expected_route in tests:
            result = await self.run_query(query, max_cmds, expected_route)
            self.results.append(result)
            await asyncio.sleep(2)

    async def test_edge_cases(self):
        """Test edge cases and error scenarios."""
        print("\n" + "="*80)
        print("CATEGORY: Edge Cases")
        print("="*80)

        tests = [
            # Non-existent resources
            ("find nonexistentresource", 3, "smart_executor"),

            # Ambiguous queries
            ("find azure", 5, "smart_executor"),  # Too broad

            # Complex filters
            ("find all azure storage accounts in namespace production", 5, "smart_executor"),
        ]

        for query, max_cmds, expected_route in tests:
            result = await self.run_query(query, max_cmds, expected_route)
            self.results.append(result)
            await asyncio.sleep(2)

    async def test_performance_regression(self):
        """Test for performance regressions on known queries."""
        print("\n" + "="*80)
        print("CATEGORY: Performance Regression Suite")
        print("="*80)

        # Run same query 3 times to check consistency
        query = "find eventhubs"
        print(f"\n[STATS] Running performance regression: '{query}' (3 iterations)")

        command_counts = []
        times = []

        for i in range(3):
            result = await self.run_query(query, expected_max_commands=3, expected_routing="smart_executor")
            command_counts.append(result.command_count)
            times.append(result.execution_time)
            self.results.append(result)
            await asyncio.sleep(2)

        avg_cmds = sum(command_counts) / len(command_counts)
        avg_time = sum(times) / len(times)

        print(f"\n[CHART] Performance Stats:")
        print(f"   Commands: {command_counts} (avg: {avg_cmds:.1f})")
        print(f"   Times: {[f'{t:.1f}s' for t in times]} (avg: {avg_time:.1f}s)")

        # Check for consistency
        if max(command_counts) - min(command_counts) > 2:
            print(f"   [WARN]  WARNING: Inconsistent command counts!")

    def print_summary(self):
        """Print test results summary."""
        print("\n" + "="*80)
        print("TEST SUMMARY")
        print("="*80)

        passed = [r for r in self.results if r.passed]
        failed = [r for r in self.results if not r.passed]

        print(f"\n[OK] Passed: {len(passed)}/{len(self.results)}")
        print(f"[X] Failed: {len(failed)}/{len(self.results)}")

        if failed:
            print("\n[X] FAILED TESTS:")
            print("-" * 80)
            for result in failed:
                print(f"\n{result.query}")
                print(f"  Reason: {result.reason}")
                print(f"  Commands: {result.command_count} (expected ≤ {result.expected_max_commands})")
                print(f"  Routing: {result.actual_routing} (expected: {result.expected_routing})")
                print(f"  Time: {result.execution_time:.1f}s")

        # Identify patterns in failures
        routing_failures = [r for r in failed if r.expected_routing != r.actual_routing]
        command_failures = [r for r in failed if r.expected_max_commands and r.command_count > r.expected_max_commands]

        if routing_failures:
            print(f"\n🔀 ROUTING ISSUES ({len(routing_failures)} tests):")
            for r in routing_failures:
                print(f"  • {r.query}: {r.actual_routing} ≠ {r.expected_routing}")

        if command_failures:
            print(f"\n[FAST] PERFORMANCE ISSUES ({len(command_failures)} tests):")
            for r in command_failures:
                print(f"  • {r.query}: {r.command_count} commands (expected ≤ {r.expected_max_commands})")

        # Performance stats
        if self.results:
            avg_cmds = sum(r.command_count for r in self.results) / len(self.results)
            avg_time = sum(r.execution_time for r in self.results) / len(self.results)
            print(f"\n[STATS] OVERALL PERFORMANCE:")
            print(f"  Average commands: {avg_cmds:.1f}")
            print(f"  Average time: {avg_time:.1f}s")

    async def close(self):
        """Clean up resources."""
        await self.client.aclose()


async def main():
    """Run all tests."""
    print("="*80)
    print("AGENT COMPREHENSIVE TEST SUITE")
    print("="*80)
    print(f"Agent Server: {AGENT_SERVER_URL}")
    print(f"LLM Host: {LLM_HOST}")
    print(f"Brain Model: {BRAIN_MODEL}")
    print(f"Executor Model: {EXECUTOR_MODEL}")
    print(f"Cluster Context: {KUBE_CONTEXT}")
    print("="*80)

    tester = AgentTester()

    try:
        # Run all test categories
        await tester.test_discovery_queries()
        await tester.test_status_health_checks()
        await tester.test_deep_investigation()
        await tester.test_simple_queries()
        await tester.test_edge_cases()
        await tester.test_performance_regression()

        # Print summary
        tester.print_summary()

        # Exit code based on results
        failed = [r for r in tester.results if not r.passed]
        if failed:
            print(f"\n💥 TESTS FAILED - {len(failed)} failures detected")
            exit(1)
        else:
            print(f"\n[DONE] ALL TESTS PASSED")
            exit(0)

    finally:
        await tester.close()


if __name__ == "__main__":
    asyncio.run(main())
