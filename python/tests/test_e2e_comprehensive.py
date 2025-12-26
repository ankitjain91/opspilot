"""
COMPREHENSIVE E2E INTEGRATION TEST SUITE
=========================================

Tests EVERY scenario from conversation history with REAL agent server.
Full request → response flow with actual cluster and remote models.

Configuration:
- Agent Server: localhost:8765
- Models: 20.56.146.53 (opspilot-brain:latest + qwen2.5:72b)
- Cluster: vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj

Run with: python3 tests/test_e2e_comprehensive.py

WARNING: This test suite is COMPREHENSIVE and will take a LONG time to run.
         It covers EVERY scenario, no matter how long it takes.
"""

import asyncio
import httpx
import json
import time
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from enum import Enum

# Configuration
AGENT_SERVER_URL = "http://localhost:8765"
LLM_HOST = "http://20.56.146.53:11434"
BRAIN_MODEL = "opspilot-brain:latest"
EXECUTOR_MODEL = "qwen2.5:72b"
KUBE_CONTEXT = "vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj"


class TestCategory(Enum):
    """Test categories for organization."""
    DISCOVERY = "Discovery Queries"
    STATUS_CHECK = "Status/Health Checks"
    DEEP_INVESTIGATION = "Deep Investigation"
    SIMPLE_COMMAND = "Simple Commands"
    EDGE_CASE = "Edge Cases"
    PERFORMANCE = "Performance Regression"
    CRASH_SCENARIO = "Crash Scenarios"
    ACCURACY = "Answer Accuracy"


@dataclass
class TestCase:
    """Comprehensive test case definition."""
    name: str
    category: TestCategory
    query: str

    # Routing expectations
    expected_routing: Optional[str] = None  # smart_executor, create_plan, delegate, batch_delegate

    # Performance expectations
    max_commands: Optional[int] = None
    max_time_seconds: Optional[float] = None

    # Answer validation
    answer_must_contain: List[str] = field(default_factory=list)
    answer_must_not_contain: List[str] = field(default_factory=list)

    # Behavioral expectations
    should_not_crash: bool = True
    should_give_answer: bool = True

    # Debugging
    description: str = ""
    known_issue: Optional[str] = None


@dataclass
class TestResult:
    """Test execution result with comprehensive metrics."""
    test_case: TestCase
    passed: bool

    # Execution metrics
    command_count: int = 0
    execution_time: float = 0.0
    actual_routing: Optional[str] = None

    # Answer data
    answer: str = ""
    answer_length: int = 0

    # Events tracking
    events: List[Dict] = field(default_factory=list)
    commands_executed: List[str] = field(default_factory=list)

    # Failure details
    failure_reasons: List[str] = field(default_factory=list)
    exception: Optional[str] = None

    def add_failure(self, reason: str):
        """Add a failure reason."""
        self.failure_reasons.append(reason)
        self.passed = False

    def __str__(self):
        status = "✅ PASS" if self.passed else "❌ FAIL"
        perf = f"({self.command_count} cmds, {self.execution_time:.1f}s)"
        if self.passed:
            return f"{status} {perf} - {self.test_case.name}"
        else:
            reasons = "; ".join(self.failure_reasons)
            return f"{status} {perf} - {self.test_case.name}\n    {reasons}"


class E2ETester:
    """Comprehensive E2E test orchestrator."""

    def __init__(self):
        self.client = httpx.AsyncClient(timeout=600.0)  # 10 minute timeout
        self.results: List[TestResult] = []
        self.test_cases = self._define_all_test_cases()

    def _define_all_test_cases(self) -> List[TestCase]:
        """Define EVERY test case from conversation history and more."""

        return [
            # ================================================================
            # CATEGORY 1: DISCOVERY QUERIES
            # ================================================================
            TestCase(
                name="find_eventhubs_performance",
                category=TestCategory.DISCOVERY,
                query="find eventhubs",
                expected_routing="smart_executor",
                max_commands=3,
                max_time_seconds=30.0,
                answer_must_contain=["eventhub"],
                description="CRITICAL: Was taking 8 commands, should be 1-3",
                known_issue="Was using batch_delegate instead of smart_executor"
            ),

            TestCase(
                name="find_signalr_azure_crash",
                category=TestCategory.CRASH_SCENARIO,
                query="find signalr azure",
                expected_routing="smart_executor",
                max_commands=3,
                should_not_crash=True,
                should_give_answer=True,
                description="CRITICAL: Was crashing with SafeExecutor() error",
                known_issue="SafeExecutor instantiation bug"
            ),

            TestCase(
                name="find_crossplane_managed_azure",
                category=TestCategory.DISCOVERY,
                query="find crossplane managed azure resources",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["azure"],
                description="Crossplane Azure resource discovery"
            ),

            TestCase(
                name="list_vclusters",
                category=TestCategory.DISCOVERY,
                query="list vclusters",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["vcluster"],
                description="vcluster CRD discovery"
            ),

            TestCase(
                name="find_azure_databases",
                category=TestCategory.DISCOVERY,
                query="find all azure databases",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["database"],
                description="Azure database resource discovery"
            ),

            TestCase(
                name="show_customerclusters",
                category=TestCategory.DISCOVERY,
                query="show all customerclusters",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["customercluster"],
                description="CustomerCluster CRD discovery"
            ),

            TestCase(
                name="find_istio_resources",
                category=TestCategory.DISCOVERY,
                query="get all istio resources",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["istio"],
                description="Istio CRD discovery"
            ),

            TestCase(
                name="find_configmap_specific",
                category=TestCategory.DISCOVERY,
                query="find configmaps with name tetrisinputjson",
                expected_routing="smart_executor",
                max_commands=2,
                description="Specific ConfigMap discovery"
            ),

            TestCase(
                name="list_crossplane_crds",
                category=TestCategory.DISCOVERY,
                query="list all CRDs related to crossplane",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["crd", "crossplane"],
                description="Crossplane CRD listing"
            ),

            TestCase(
                name="find_nonexistent_resource",
                category=TestCategory.EDGE_CASE,
                query="find nonexistentresource",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["not found", "no", "none"],
                description="Non-existent resource should report not found"
            ),

            TestCase(
                name="find_azure_broad",
                category=TestCategory.DISCOVERY,
                query="find azure",
                expected_routing="smart_executor",
                max_commands=5,
                description="Broad Azure query"
            ),

            TestCase(
                name="find_azure_storage_namespace",
                category=TestCategory.DISCOVERY,
                query="find all azure storage accounts in namespace production",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["storage"],
                description="Filtered discovery with namespace"
            ),

            # ================================================================
            # CATEGORY 2: STATUS/HEALTH CHECKS
            # ================================================================
            TestCase(
                name="eventhub_health_82_steps_bug",
                category=TestCategory.STATUS_CHECK,
                query="are all eventhub healthy in this cluster?",
                expected_routing="smart_executor",
                max_commands=5,
                max_time_seconds=60.0,
                should_give_answer=True,
                description="CRITICAL: Was taking 82 steps with 79 tools!",
                known_issue="Supervisor routing to create_plan instead of smart_executor"
            ),

            TestCase(
                name="vclusters_healthy",
                category=TestCategory.STATUS_CHECK,
                query="are vclusters healthy?",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["vcluster"],
                description="vcluster health check"
            ),

            TestCase(
                name="databases_ready",
                category=TestCategory.STATUS_CHECK,
                query="check if databases are ready",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["database"],
                description="Database readiness check"
            ),

            TestCase(
                name="nginx_deployment_running",
                category=TestCategory.STATUS_CHECK,
                query="is the nginx deployment running?",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["nginx"],
                description="Specific deployment status"
            ),

            TestCase(
                name="azure_resources_status",
                category=TestCategory.STATUS_CHECK,
                query="what is the status of azure resources?",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["azure"],
                description="Azure resources status check"
            ),

            TestCase(
                name="failing_pods_check",
                category=TestCategory.STATUS_CHECK,
                query="are there any failing pods?",
                expected_routing="smart_executor",
                max_commands=3,
                description="Failing pods detection"
            ),

            TestCase(
                name="cluster_health_batch",
                category=TestCategory.STATUS_CHECK,
                query="check cluster health",
                expected_routing="batch_delegate",
                max_commands=5,
                description="Overall cluster health (batch execution)"
            ),

            # ================================================================
            # CATEGORY 3: DEEP INVESTIGATION (Why/Debug)
            # ================================================================
            TestCase(
                name="debug_eventhub_pod_failing",
                category=TestCategory.DEEP_INVESTIGATION,
                query="why is the eventhub pod failing?",
                expected_routing="create_plan",
                max_commands=20,
                max_time_seconds=120.0,
                description="Deep investigation requires create_plan"
            ),

            TestCase(
                name="debug_nginx_crashloop",
                category=TestCategory.DEEP_INVESTIGATION,
                query="debug the crash loop in nginx",
                expected_routing="create_plan",
                max_commands=20,
                description="Crash loop debugging"
            ),

            TestCase(
                name="azure_resource_failure_cause",
                category=TestCategory.DEEP_INVESTIGATION,
                query="what is causing the azure resource to fail?",
                expected_routing="create_plan",
                max_commands=20,
                description="Azure resource failure root cause"
            ),

            TestCase(
                name="database_connection_errors",
                category=TestCategory.DEEP_INVESTIGATION,
                query="root cause of database connection errors",
                expected_routing="create_plan",
                max_commands=20,
                description="Database connectivity root cause"
            ),

            # ================================================================
            # CATEGORY 4: SIMPLE COMMANDS
            # ================================================================
            TestCase(
                name="list_pods_simple",
                category=TestCategory.SIMPLE_COMMAND,
                query="list pods",
                expected_routing="delegate",
                max_commands=1,
                answer_must_contain=["pod"],
                description="Simple pod listing"
            ),

            TestCase(
                name="get_nodes",
                category=TestCategory.SIMPLE_COMMAND,
                query="get nodes",
                expected_routing="delegate",
                max_commands=1,
                answer_must_contain=["node"],
                description="Simple node listing"
            ),

            TestCase(
                name="kubectl_get_namespaces",
                category=TestCategory.SIMPLE_COMMAND,
                query="kubectl get namespaces",
                expected_routing="delegate",
                max_commands=1,
                answer_must_contain=["namespace"],
                description="Direct kubectl command"
            ),

            TestCase(
                name="show_deployments",
                category=TestCategory.SIMPLE_COMMAND,
                query="show me all deployments",
                expected_routing="delegate",
                max_commands=2,
                answer_must_contain=["deployment"],
                description="Deployment listing"
            ),

            # ================================================================
            # CATEGORY 5: PERFORMANCE REGRESSION TESTS
            # ================================================================
            TestCase(
                name="perf_eventhubs_iter1",
                category=TestCategory.PERFORMANCE,
                query="find eventhubs",
                expected_routing="smart_executor",
                max_commands=3,
                max_time_seconds=30.0,
                description="Performance baseline iteration 1"
            ),

            TestCase(
                name="perf_eventhubs_iter2",
                category=TestCategory.PERFORMANCE,
                query="find eventhubs",
                expected_routing="smart_executor",
                max_commands=3,
                max_time_seconds=30.0,
                description="Performance baseline iteration 2"
            ),

            TestCase(
                name="perf_eventhubs_iter3",
                category=TestCategory.PERFORMANCE,
                query="find eventhubs",
                expected_routing="smart_executor",
                max_commands=3,
                max_time_seconds=30.0,
                description="Performance baseline iteration 3"
            ),

            # ================================================================
            # CATEGORY 6: ACCURACY TESTS
            # ================================================================
            TestCase(
                name="accuracy_crossplane_resources",
                category=TestCategory.ACCURACY,
                query="find crossplane managed azure resources",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["managed"],
                answer_must_not_contain=["error", "crash", "failed to"],
                description="Verify accurate Crossplane resource discovery"
            ),

            TestCase(
                name="accuracy_health_check_eventhub",
                category=TestCategory.ACCURACY,
                query="are all eventhub healthy in this cluster?",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_not_contain=["pod", "might be"],  # Should check CRD, not pods
                description="Verify checks CRD status, not pod status"
            ),

            # ================================================================
            # CATEGORY 7: EDGE CASES AND STRESS TESTS
            # ================================================================
            TestCase(
                name="edge_empty_result",
                category=TestCategory.EDGE_CASE,
                query="find resources that do not exist anywhere",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["not found", "no", "none"],
                description="Gracefully handle empty results"
            ),

            TestCase(
                name="edge_ambiguous_query",
                category=TestCategory.EDGE_CASE,
                query="find things",
                expected_routing="smart_executor",
                max_commands=5,
                description="Handle ambiguous query"
            ),

            TestCase(
                name="edge_very_long_query",
                category=TestCategory.EDGE_CASE,
                query="find all azure resources including databases storage accounts eventhubs signalr managed identities role assignments and any other azure resources deployed via crossplane in all namespaces",
                expected_routing="smart_executor",
                max_commands=10,
                description="Handle complex compound query"
            ),

            TestCase(
                name="edge_typo_in_resource",
                category=TestCategory.EDGE_CASE,
                query="find vcluuusters",  # Intentional typo
                expected_routing="smart_executor",
                max_commands=3,
                description="Handle typos gracefully"
            ),

            # ================================================================
            # CATEGORY 8: CONVERSATION HISTORY SCENARIOS
            # ================================================================
            TestCase(
                name="scenario_initial_eventhub_discovery",
                category=TestCategory.DISCOVERY,
                query="find eventhubs",
                expected_routing="smart_executor",
                max_commands=3,
                description="Original scenario: User's first query"
            ),

            TestCase(
                name="scenario_followup_eventhub_health",
                category=TestCategory.STATUS_CHECK,
                query="are all eventhub healthy in this cluster?",
                expected_routing="smart_executor",
                max_commands=5,
                description="Original scenario: Follow-up health check"
            ),

            # ================================================================
            # CATEGORY 9: SPECIFIC CLUSTER RESOURCES
            # ================================================================
            TestCase(
                name="specific_customercluster_status",
                category=TestCategory.STATUS_CHECK,
                query="what is the status of customerclusters in taasvstst namespace?",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["customercluster"],
                description="Specific namespace query"
            ),

            TestCase(
                name="specific_crossplane_providers",
                category=TestCategory.STATUS_CHECK,
                query="check crossplane provider health",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["provider"],
                description="Crossplane provider health"
            ),

            TestCase(
                name="specific_azure_managed_resources",
                category=TestCategory.DISCOVERY,
                query="list all azure managed resources",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["managed"],
                description="Azure managed resources"
            ),
        ]

    async def run_test(self, test_case: TestCase) -> TestResult:
        """Execute a single test case with comprehensive validation."""
        print(f"\n{'='*80}")
        print(f"TEST: {test_case.name}")
        print(f"CATEGORY: {test_case.category.value}")
        print(f"QUERY: {test_case.query}")
        if test_case.description:
            print(f"DESCRIPTION: {test_case.description}")
        if test_case.known_issue:
            print(f"⚠️  KNOWN ISSUE: {test_case.known_issue}")
        print(f"{'='*80}")

        result = TestResult(test_case=test_case, passed=True)
        start_time = time.time()

        try:
            # Create agent
            print("[NET] Creating agent...")
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
            print(f"✅ Agent created: {thread_id}")

            # Execute query
            print(f"🔍 Executing query: {test_case.query}")
            async with self.client.stream(
                "POST",
                f"{AGENT_SERVER_URL}/query",
                json={"thread_id": thread_id, "query": test_case.query}
            ) as stream_response:
                async for line in stream_response.aiter_lines():
                    if not line.startswith("data: "):
                        continue

                    event_data = line[6:]
                    if event_data == "[DONE]":
                        break

                    try:
                        event = json.loads(event_data)
                        result.events.append(event)

                        # Track command executions
                        if event.get("type") == "command_execution":
                            cmd = event.get("data", {}).get("command", "unknown")
                            result.commands_executed.append(cmd)
                            result.command_count += 1
                            print(f"   [{result.command_count}] {cmd}")

                        # Detect routing
                        if event.get("type") == "intent":
                            msg = event.get("data", {}).get("message", "")
                            if "SmartExecutor activated" in msg:
                                result.actual_routing = "smart_executor"
                                print(f"   🎯 Routing: smart_executor")
                            elif "Creating plan" in msg or "Plan created" in msg:
                                result.actual_routing = "create_plan"
                                print(f"   📋 Routing: create_plan")
                            elif "Delegating" in msg:
                                result.actual_routing = "delegate"
                                print(f"   🔧 Routing: delegate")
                            elif "batch" in msg.lower():
                                result.actual_routing = "batch_delegate"
                                print(f"   [FAST] Routing: batch_delegate")

                        # Capture answer
                        if event.get("type") == "final_answer":
                            result.answer = event.get("data", {}).get("answer", "")
                            result.answer_length = len(result.answer)
                            print(f"   [MSG] Answer received ({result.answer_length} chars)")

                    except json.JSONDecodeError:
                        continue

            result.execution_time = time.time() - start_time

            # Validate results
            self._validate_result(result)

            # Print result
            if result.passed:
                print(f"\n✅ PASS ({result.command_count} cmds, {result.execution_time:.1f}s)")
            else:
                print(f"\n❌ FAIL ({result.command_count} cmds, {result.execution_time:.1f}s)")
                for reason in result.failure_reasons:
                    print(f"   - {reason}")

        except Exception as e:
            result.exception = str(e)
            result.execution_time = time.time() - start_time
            result.add_failure(f"Exception: {e}")
            print(f"\n💥 EXCEPTION: {e}")

        return result

    def _validate_result(self, result: TestResult):
        """Validate test result against expectations."""
        tc = result.test_case

        # Check crash
        if tc.should_not_crash:
            if result.exception:
                result.add_failure(f"Crashed with exception: {result.exception}")
            if not result.answer and result.command_count == 0:
                result.add_failure("Agent crashed - no answer or commands")

        # Check answer presence
        if tc.should_give_answer and not result.answer:
            result.add_failure("No answer provided")

        # Check routing
        if tc.expected_routing and result.actual_routing != tc.expected_routing:
            result.add_failure(
                f"Wrong routing: got '{result.actual_routing}', "
                f"expected '{tc.expected_routing}'"
            )

        # Check command count
        if tc.max_commands and result.command_count > tc.max_commands:
            result.add_failure(
                f"Excessive commands: {result.command_count} > {tc.max_commands} max"
            )

        # Check execution time
        if tc.max_time_seconds and result.execution_time > tc.max_time_seconds:
            result.add_failure(
                f"Too slow: {result.execution_time:.1f}s > {tc.max_time_seconds}s max"
            )

        # Check answer content
        answer_lower = result.answer.lower()
        for must_contain in tc.answer_must_contain:
            if must_contain.lower() not in answer_lower:
                result.add_failure(f"Answer missing '{must_contain}'")

        for must_not_contain in tc.answer_must_not_contain:
            if must_not_contain.lower() in answer_lower:
                result.add_failure(f"Answer contains forbidden '{must_not_contain}'")

    async def run_all_tests(self):
        """Run all test cases."""
        print("\n" + "="*80)
        print("COMPREHENSIVE E2E INTEGRATION TEST SUITE")
        print("="*80)
        print(f"Agent Server: {AGENT_SERVER_URL}")
        print(f"LLM Host: {LLM_HOST}")
        print(f"Brain Model: {BRAIN_MODEL}")
        print(f"Executor Model: {EXECUTOR_MODEL}")
        print(f"Cluster: {KUBE_CONTEXT}")
        print(f"Total Tests: {len(self.test_cases)}")
        print("="*80)
        print("\n⏰ WARNING: This will take a LONG time. Running EVERY scenario...")
        print("\n")

        overall_start = time.time()

        for i, test_case in enumerate(self.test_cases, 1):
            print(f"\n[{i}/{len(self.test_cases)}] Running: {test_case.name}")
            result = await self.run_test(test_case)
            self.results.append(result)

            # Rate limiting between tests
            await asyncio.sleep(2)

        total_time = time.time() - overall_start

        # Print comprehensive summary
        self._print_summary(total_time)

    def _print_summary(self, total_time: float):
        """Print comprehensive test summary."""
        print("\n" + "="*80)
        print("TEST EXECUTION SUMMARY")
        print("="*80)

        passed = [r for r in self.results if r.passed]
        failed = [r for r in self.results if not r.passed]

        print(f"\n✅ Passed: {len(passed)}/{len(self.results)}")
        print(f"❌ Failed: {len(failed)}/{len(self.results)}")
        print(f"⏱️  Total Time: {total_time/60:.1f} minutes ({total_time:.0f}s)")

        # Performance stats
        if self.results:
            avg_cmds = sum(r.command_count for r in self.results) / len(self.results)
            avg_time = sum(r.execution_time for r in self.results) / len(self.results)
            max_cmds = max(r.command_count for r in self.results)
            max_time = max(r.execution_time for r in self.results)

            print(f"\n📊 PERFORMANCE METRICS:")
            print(f"   Avg Commands: {avg_cmds:.1f}")
            print(f"   Max Commands: {max_cmds} ({[r.test_case.name for r in self.results if r.command_count == max_cmds][0]})")
            print(f"   Avg Time: {avg_time:.1f}s")
            print(f"   Max Time: {max_time:.1f}s ({[r.test_case.name for r in self.results if r.execution_time == max_time][0]})")

        # Category breakdown
        print(f"\n📁 BY CATEGORY:")
        for category in TestCategory:
            cat_tests = [r for r in self.results if r.test_case.category == category]
            if cat_tests:
                cat_passed = sum(1 for r in cat_tests if r.passed)
                print(f"   {category.value}: {cat_passed}/{len(cat_tests)} passed")

        # Failure analysis
        if failed:
            print(f"\n❌ FAILED TESTS ({len(failed)}):")
            print("-" * 80)

            for result in failed:
                tc = result.test_case
                print(f"\n{tc.name} ({tc.category.value})")
                print(f"   Query: {tc.query}")
                print(f"   Performance: {result.command_count} cmds, {result.execution_time:.1f}s")
                print(f"   Routing: {result.actual_routing} (expected: {tc.expected_routing})")
                print(f"   Failures:")
                for reason in result.failure_reasons:
                    print(f"      - {reason}")
                if tc.known_issue:
                    print(f"   Known Issue: {tc.known_issue}")

            # Pattern analysis
            routing_failures = [r for r in failed if any("routing" in f.lower() for f in r.failure_reasons)]
            perf_failures = [r for r in failed if any("command" in f.lower() or "slow" in f.lower() for f in r.failure_reasons)]
            crash_failures = [r for r in failed if any("crash" in f.lower() or "exception" in f.lower() for f in r.failure_reasons)]
            accuracy_failures = [r for r in failed if any("missing" in f.lower() or "contains" in f.lower() for f in r.failure_reasons)]

            print(f"\n🔍 FAILURE PATTERNS:")
            if routing_failures:
                print(f"   🔀 Routing Issues: {len(routing_failures)} tests")
                for r in routing_failures[:5]:  # Show first 5
                    print(f"      - {r.test_case.name}: {r.actual_routing} ≠ {r.test_case.expected_routing}")

            if perf_failures:
                print(f"   [FAST] Performance Issues: {len(perf_failures)} tests")
                for r in perf_failures[:5]:
                    print(f"      - {r.test_case.name}: {r.command_count} cmds (max: {r.test_case.max_commands})")

            if crash_failures:
                print(f"   💥 Crashes: {len(crash_failures)} tests")
                for r in crash_failures:
                    print(f"      - {r.test_case.name}: {r.exception}")

            if accuracy_failures:
                print(f"   🎯 Accuracy Issues: {len(accuracy_failures)} tests")
                for r in accuracy_failures[:5]:
                    print(f"      - {r.test_case.name}")

        # Known issues tracking
        known_issue_tests = [r for r in self.results if r.test_case.known_issue]
        if known_issue_tests:
            print(f"\n⚠️  KNOWN ISSUES TRACKING:")
            for r in known_issue_tests:
                status = "✅ FIXED" if r.passed else "❌ STILL FAILING"
                print(f"   {status} - {r.test_case.name}")
                print(f"      Issue: {r.test_case.known_issue}")

        print("\n" + "="*80)
        if failed:
            print(f"💥 TEST SUITE FAILED - {len(failed)} failures")
            print("="*80)
        else:
            print("🎉 ALL TESTS PASSED!")
            print("="*80)

    async def close(self):
        """Clean up resources."""
        await self.client.aclose()


async def main():
    """Run comprehensive E2E test suite."""
    tester = E2ETester()

    try:
        await tester.run_all_tests()

        # Exit code based on results
        failed = [r for r in tester.results if not r.passed]
        exit(1 if failed else 0)

    finally:
        await tester.close()


if __name__ == "__main__":
    asyncio.run(main())
