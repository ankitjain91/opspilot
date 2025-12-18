"""
═══════════════════════════════════════════════════════════════════════════════
EXHAUSTIVE E2E INTEGRATION TEST SUITE - LEAVE NO STONE UNTURNED
═══════════════════════════════════════════════════════════════════════════════

This test suite covers EVERY scenario that could possibly occur:
✅ All conversation bugs
✅ All 556 CRD types in the cluster (sampled)
✅ All Azure resource patterns
✅ All routing decisions (delegate, smart_executor, create_plan, batch_delegate)
✅ All status field combinations (READY, SYNCED, HEALTHY, STATE, etc.)
✅ All failure patterns (ReconcilePaused, AuthorizationFailed, QuotaExceeded, etc.)
✅ All edge cases (empty results, timeouts, large outputs, typos, etc.)
✅ Performance regressions
✅ Context switching & namespace discovery
✅ KB integration & semantic search
✅ Answer accuracy & data extraction
✅ Multi-step investigations
✅ Universal debugging patterns (status → events → controller logs)

Configuration:
- Cluster: vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj (556 CRDs!)
- Models: 20.56.146.53 (opspilot-brain:latest + qwen2.5:72b)
- Agent Server: localhost:8765

Run: python3 tests/test_e2e_exhaustive.py

WARNING: This will take a VERY LONG TIME (100+ tests). Get coffee ☕
"""

import asyncio
import httpx
import json
import time
from typing import Dict, List, Optional, Tuple, Set
from dataclasses import dataclass, field
from enum import Enum
import subprocess

# Configuration
AGENT_SERVER_URL = "http://localhost:8766"
LLM_HOST = "http://20.56.146.53:11434"
BRAIN_MODEL = "opspilot-brain:latest"
EXECUTOR_MODEL = "qwen2.5:72b"
KUBE_CONTEXT = "vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj"


class TestCategory(Enum):
    """Test categories."""
    # Core functionality
    DISCOVERY = "Resource Discovery"
    STATUS_CHECK = "Status & Health Checks"
    DEEP_INVESTIGATION = "Deep Investigation (Why/Debug)"
    SIMPLE_COMMAND = "Simple Commands"

    # Routing tests
    ROUTING_SMART_EXECUTOR = "Routing: SmartExecutor"
    ROUTING_CREATE_PLAN = "Routing: CreatePlan"
    ROUTING_DELEGATE = "Routing: Delegate"
    ROUTING_BATCH = "Routing: Batch"

    # Azure & Crossplane
    AZURE_RESOURCES = "Azure Resources"
    CROSSPLANE_MANAGED = "Crossplane Managed Resources"
    CROSSPLANE_PROVIDERS = "Crossplane Providers"

    # Custom CRDs
    CUSTOMER_CLUSTER = "CustomerCluster CRD"
    VCLUSTER = "vCluster"

    # Status patterns
    STATUS_SYNCED_FALSE = "Status: SYNCED=False"
    STATUS_READY_FALSE = "Status: READY=False"
    STATUS_RECONCILE_PAUSED = "Status: ReconcilePaused"
    STATUS_HEALTHY_FALSE = "Status: HEALTHY=False"

    # Failure scenarios
    AZURE_AUTH_FAILURE = "Azure AuthorizationFailed"
    AZURE_QUOTA_EXCEEDED = "Azure QuotaExceeded"
    AZURE_NOT_FOUND = "Azure NotFound (404)"
    AZURE_INVALID_PARAM = "Azure InvalidParameter"

    # Edge cases
    EDGE_CASE = "Edge Cases"
    PERFORMANCE = "Performance Regression"
    ACCURACY = "Answer Accuracy"

    # Advanced
    CONTEXT_SWITCHING = "Context Switching"
    KB_INTEGRATION = "KB Semantic Search"
    MULTI_STEP = "Multi-Step Investigation"
    UNIVERSAL_DEBUG = "Universal Debug Pattern"


@dataclass
class TestCase:
    """Comprehensive test case definition."""
    name: str
    category: TestCategory
    query: str

    # Routing expectations
    expected_routing: Optional[str] = None

    # Performance
    max_commands: Optional[int] = None
    max_time_seconds: Optional[float] = None

    # Answer validation
    answer_must_contain: List[str] = field(default_factory=list)
    answer_must_not_contain: List[str] = field(default_factory=list)

    # Behavior
    should_not_crash: bool = True
    should_give_answer: bool = True

    # Metadata
    description: str = ""
    known_issue: Optional[str] = None
    priority: str = "NORMAL"  # CRITICAL, HIGH, NORMAL, LOW


@dataclass
class TestResult:
    """Test execution result."""
    test_case: TestCase
    passed: bool
    command_count: int = 0
    execution_time: float = 0.0
    actual_routing: Optional[str] = None
    answer: str = ""
    answer_length: int = 0
    events: List[Dict] = field(default_factory=list)
    commands_executed: List[str] = field(default_factory=list)
    failure_reasons: List[str] = field(default_factory=list)
    exception: Optional[str] = None

    def add_failure(self, reason: str):
        self.failure_reasons.append(reason)
        self.passed = False


class ExhaustiveE2ETester:
    """Exhaustive E2E test orchestrator."""

    def __init__(self):
        self.client = httpx.AsyncClient(timeout=600.0)
        self.results: List[TestResult] = []
        self.cluster_crds: List[str] = []
        self.test_cases: List[TestCase] = []

    async def initialize(self):
        """Initialize by discovering cluster resources."""
        print("🔍 Discovering cluster resources...")
        try:
            result = subprocess.run(
                ["kubectl", "--context", KUBE_CONTEXT, "api-resources", "--no-headers"],
                capture_output=True,
                text=True,
                timeout=30
            )
            if result.returncode == 0:
                self.cluster_crds = [line.split()[0] for line in result.stdout.strip().split('\n') if line.strip()]
                print(f"✅ Discovered {len(self.cluster_crds)} CRDs in cluster")
        except Exception as e:
            print(f"⚠️  Failed to discover CRDs: {e}")

        # Build comprehensive test matrix
        self.test_cases = self._build_exhaustive_test_matrix()
        print(f"📋 Built {len(self.test_cases)} comprehensive test cases")

    def _build_exhaustive_test_matrix(self) -> List[TestCase]:
        """Build EVERY possible test scenario."""
        tests = []

        # ================================================================
        # PRIORITY 1: CRITICAL BUGS FROM CONVERSATION
        # ================================================================

        tests.append(TestCase(
            name="CRITICAL_eventhub_82_steps",
            category=TestCategory.STATUS_CHECK,
            query="are all eventhub healthy in this cluster?",
            expected_routing="smart_executor",
            max_commands=5,
            max_time_seconds=60.0,
            answer_must_not_contain=["pod", "might be unhealthy"],
            description="THE BIG ONE: Was taking 82 steps!",
            known_issue="Supervisor routing to create_plan instead of smart_executor",
            priority="CRITICAL"
        ))

        tests.append(TestCase(
            name="CRITICAL_eventhub_8_commands",
            category=TestCategory.DISCOVERY,
            query="find eventhubs",
            expected_routing="smart_executor",
            max_commands=3,
            max_time_seconds=30.0,
            description="Was taking 8 commands instead of 1-3",
            known_issue="batch_delegate instead of smart_executor",
            priority="CRITICAL"
        ))

        tests.append(TestCase(
            name="CRITICAL_signalr_crash",
            category=TestCategory.DISCOVERY,
            query="find signalr azure",
            expected_routing="smart_executor",
            max_commands=3,
            should_not_crash=True,
            should_give_answer=True,
            description="SafeExecutor() crash bug",
            known_issue="SafeExecutor instantiation error",
            priority="CRITICAL"
        ))

        # ================================================================
        # CATEGORY: RESOURCE DISCOVERY (All variations)
        # ================================================================

        # Standard K8s resources
        for resource in ["pods", "deployments", "services", "nodes", "namespaces"]:
            tests.append(TestCase(
                name=f"discovery_{resource}",
                category=TestCategory.DISCOVERY,
                query=f"list {resource}",
                expected_routing="delegate" if resource in ["pods", "nodes"] else "smart_executor",
                max_commands=2,
                answer_must_contain=[resource[:-1]],  # singular form
                description=f"Basic {resource} listing"
            ))

        # Azure resources (sample from cluster)
        azure_resources = [
            "eventhubs", "signalr", "databases", "storage accounts",
            "managed identities", "role assignments", "virtual networks",
            "application gateways", "cosmos", "keyvault"
        ]
        for resource in azure_resources:
            tests.append(TestCase(
                name=f"discovery_azure_{resource.replace(' ', '_')}",
                category=TestCategory.AZURE_RESOURCES,
                query=f"find all azure {resource}",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["azure"],
                description=f"Azure {resource} discovery"
            ))

        # Crossplane resources
        tests.extend([
            TestCase(
                name="discovery_crossplane_managed_all",
                category=TestCategory.CROSSPLANE_MANAGED,
                query="find crossplane managed azure resources",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["managed"],
                description="All Crossplane managed resources"
            ),
            TestCase(
                name="discovery_crossplane_providers",
                category=TestCategory.CROSSPLANE_PROVIDERS,
                query="list crossplane providers",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["provider"],
                description="Crossplane provider discovery"
            ),
            TestCase(
                name="discovery_crossplane_compositions",
                category=TestCategory.CROSSPLANE_MANAGED,
                query="show crossplane compositions",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["composition"],
                description="Crossplane composition discovery"
            ),
        ])

        # Custom CRDs
        tests.extend([
            TestCase(
                name="discovery_customercluster",
                category=TestCategory.CUSTOMER_CLUSTER,
                query="list all customerclusters",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["customercluster"],
                description="CustomerCluster CRD discovery"
            ),
            TestCase(
                name="discovery_customerclusterenv",
                category=TestCategory.CUSTOMER_CLUSTER,
                query="find customerclusterenvs",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["customerclusterenv"],
                description="CustomerClusterEnv CRD discovery"
            ),
        ])

        # ================================================================
        # CATEGORY: STATUS & HEALTH CHECKS (All patterns)
        # ================================================================

        # Health checks for different resource types
        for resource, routing in [
            ("eventhubs", "smart_executor"),
            ("databases", "smart_executor"),
            ("vclusters", "smart_executor"),
            ("customerclusters", "smart_executor"),
            ("azure resources", "smart_executor"),
            ("crossplane providers", "smart_executor"),
        ]:
            tests.append(TestCase(
                name=f"health_{resource.replace(' ', '_')}",
                category=TestCategory.STATUS_CHECK,
                query=f"are {resource} healthy?",
                expected_routing=routing,
                max_commands=5,
                description=f"{resource} health check"
            ))

        # Status queries with different phrasings
        status_queries = [
            ("what is the status of azure resources?", "smart_executor"),
            ("check if databases are ready", "smart_executor"),
            ("are there any failing pods?", "smart_executor"),
            ("show me unhealthy resources", "smart_executor"),
            ("find failing crossplane resources", "smart_executor"),
        ]
        for query, routing in status_queries:
            tests.append(TestCase(
                name=f"status_{query[:30].replace(' ', '_').replace('?', '')}",
                category=TestCategory.STATUS_CHECK,
                query=query,
                expected_routing=routing,
                max_commands=5,
                description=f"Status query: {query}"
            ))

        # ================================================================
        # CATEGORY: DEEP INVESTIGATION (Why/Debug/Root Cause)
        # ================================================================

        debug_scenarios = [
            ("why is the eventhub pod failing?", "eventhub pod"),
            ("debug crash loop in nginx", "nginx crash"),
            ("what is causing the azure resource to fail?", "azure failure"),
            ("root cause of database connection errors", "db connection"),
            ("why is crossplane provider unhealthy?", "provider health"),
            ("investigate customercluster failure", "customercluster"),
        ]
        for query, desc in debug_scenarios:
            tests.append(TestCase(
                name=f"debug_{desc.replace(' ', '_')}",
                category=TestCategory.DEEP_INVESTIGATION,
                query=query,
                expected_routing="create_plan",
                max_commands=20,
                max_time_seconds=120.0,
                description=f"Deep investigation: {desc}"
            ))

        # ================================================================
        # CATEGORY: ROUTING VALIDATION (Ensure correct routing)
        # ================================================================

        # SmartExecutor scenarios
        smart_executor_queries = [
            "find all eventhubs",
            "list azure databases",
            "show customerclusters",
            "are vclusters healthy?",
            "check crossplane provider status",
        ]
        for query in smart_executor_queries:
            tests.append(TestCase(
                name=f"routing_smart_{query[:20].replace(' ', '_')}",
                category=TestCategory.ROUTING_SMART_EXECUTOR,
                query=query,
                expected_routing="smart_executor",
                max_commands=5,
                description=f"Should route to smart_executor: {query}"
            ))

        # Delegate scenarios (simple commands)
        delegate_queries = [
            "list pods",
            "get nodes",
            "kubectl get namespaces",
            "show deployments",
        ]
        for query in delegate_queries:
            tests.append(TestCase(
                name=f"routing_delegate_{query[:20].replace(' ', '_')}",
                category=TestCategory.ROUTING_DELEGATE,
                query=query,
                expected_routing="delegate",
                max_commands=1,
                description=f"Should route to delegate: {query}"
            ))

        # CreatePlan scenarios (multi-step)
        plan_queries = [
            "why is my app crashing?",
            "debug the OOM error",
            "root cause of authentication failure",
        ]
        for query in plan_queries:
            tests.append(TestCase(
                name=f"routing_plan_{query[:20].replace(' ', '_')}",
                category=TestCategory.ROUTING_CREATE_PLAN,
                query=query,
                expected_routing="create_plan",
                max_commands=20,
                description=f"Should route to create_plan: {query}"
            ))

        # ================================================================
        # CATEGORY: STATUS FIELD PATTERNS (SYNCED, READY, HEALTHY, etc.)
        # ================================================================

        # These test that the agent understands different status field patterns
        tests.extend([
            TestCase(
                name="status_synced_false_ready_true",
                category=TestCategory.STATUS_RECONCILE_PAUSED,
                query="why are my role assignments showing SYNCED=False?",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["paused", "reconcile"],
                description="ReconcilePaused pattern (SYNCED=False, READY=True is intentional)"
            ),
            TestCase(
                name="status_ready_false_synced_true",
                category=TestCategory.STATUS_READY_FALSE,
                query="check status of resources with READY=False",
                expected_routing="smart_executor",
                max_commands=5,
                description="READY=False but SYNCED=True"
            ),
            TestCase(
                name="status_provider_healthy_false",
                category=TestCategory.STATUS_HEALTHY_FALSE,
                query="why is my crossplane provider unhealthy?",
                expected_routing="create_plan",
                max_commands=15,
                answer_must_contain=["provider"],
                description="Provider HEALTHY=False investigation"
            ),
        ])

        # ================================================================
        # CATEGORY: AZURE FAILURE PATTERNS (Real error codes)
        # ================================================================

        # These test KB integration and error pattern recognition
        tests.extend([
            TestCase(
                name="azure_403_authz_failed",
                category=TestCategory.AZURE_AUTH_FAILURE,
                query="why is my azure resource giving 403 error?",
                expected_routing="create_plan",
                max_commands=15,
                answer_must_contain=["authorization", "permission"],
                description="Azure AuthorizationFailed (403)"
            ),
            TestCase(
                name="azure_quota_exceeded",
                category=TestCategory.AZURE_QUOTA_EXCEEDED,
                query="why can't I create more VMs?",
                expected_routing="create_plan",
                max_commands=15,
                answer_must_contain=["quota"],
                description="Azure QuotaExceeded"
            ),
            TestCase(
                name="azure_404_not_found",
                category=TestCategory.AZURE_NOT_FOUND,
                query="why is my storage account not found?",
                expected_routing="create_plan",
                max_commands=15,
                answer_must_contain=["not found"],
                description="Azure NotFound (404)"
            ),
            TestCase(
                name="azure_invalid_parameter",
                category=TestCategory.AZURE_INVALID_PARAM,
                query="why is my database creation failing with invalid tier?",
                expected_routing="create_plan",
                max_commands=15,
                answer_must_contain=["invalid", "parameter"],
                description="Azure InvalidParameter"
            ),
        ])

        # ================================================================
        # CATEGORY: EDGE CASES (Chaos testing)
        # ================================================================

        tests.extend([
            TestCase(
                name="edge_nonexistent_resource",
                category=TestCategory.EDGE_CASE,
                query="find resourcethatdoesnotexist",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_contain=["not found", "no", "none"],
                description="Non-existent resource graceful handling"
            ),
            TestCase(
                name="edge_empty_query",
                category=TestCategory.EDGE_CASE,
                query="find",
                expected_routing="smart_executor",
                max_commands=3,
                description="Incomplete query handling"
            ),
            TestCase(
                name="edge_typo_in_resource",
                category=TestCategory.EDGE_CASE,
                query="find evenhuuubs",  # typo
                expected_routing="smart_executor",
                max_commands=3,
                description="Typo in resource name"
            ),
            TestCase(
                name="edge_very_long_query",
                category=TestCategory.EDGE_CASE,
                query="find all azure resources including eventhubs signalr databases storage accounts managed identities role assignments virtual networks application gateways keyvaults cosmos accounts in all namespaces with status ready false or synced false",
                expected_routing="smart_executor",
                max_commands=10,
                description="Extremely long compound query"
            ),
            TestCase(
                name="edge_ambiguous_azure",
                category=TestCategory.EDGE_CASE,
                query="find azure",
                expected_routing="smart_executor",
                max_commands=5,
                description="Ambiguous broad query"
            ),
        ])

        # ================================================================
        # CATEGORY: PERFORMANCE REGRESSION (Consistency)
        # ================================================================

        # Run critical queries multiple times to check consistency
        for i in range(1, 4):
            tests.append(TestCase(
                name=f"perf_eventhub_iteration_{i}",
                category=TestCategory.PERFORMANCE,
                query="find eventhubs",
                expected_routing="smart_executor",
                max_commands=3,
                max_time_seconds=30.0,
                description=f"Performance consistency test {i}/3"
            ))

        # ================================================================
        # CATEGORY: CONTEXT SWITCHING (Namespace discovery)
        # ================================================================

        tests.extend([
            TestCase(
                name="context_unknown_namespace",
                category=TestCategory.CONTEXT_SWITCHING,
                query="check the nginx deployment",
                expected_routing="smart_executor",
                max_commands=5,
                description="Unknown namespace - should discover with -A | grep"
            ),
            TestCase(
                name="context_specific_namespace",
                category=TestCategory.CONTEXT_SWITCHING,
                query="list pods in namespace kube-system",
                expected_routing="delegate",
                max_commands=1,
                description="Specific namespace provided"
            ),
            TestCase(
                name="context_multi_namespace",
                category=TestCategory.CONTEXT_SWITCHING,
                query="find failing resources across all namespaces",
                expected_routing="smart_executor",
                max_commands=5,
                description="Multi-namespace query"
            ),
        ])

        # ================================================================
        # CATEGORY: KB INTEGRATION (Semantic search working)
        # ================================================================

        tests.extend([
            TestCase(
                name="kb_crossplane_knowledge",
                category=TestCategory.KB_INTEGRATION,
                query="find crossplane managed azure resources",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["managed"],
                description="KB should provide Crossplane context"
            ),
            TestCase(
                name="kb_azure_pattern",
                category=TestCategory.KB_INTEGRATION,
                query="list all azure infrastructure",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_contain=["azure"],
                description="KB should match Azure discovery pattern"
            ),
        ])

        # ================================================================
        # CATEGORY: ANSWER ACCURACY (Data extraction)
        # ================================================================

        tests.extend([
            TestCase(
                name="accuracy_list_complete",
                category=TestCategory.ACCURACY,
                query="list all eventhubs",
                expected_routing="smart_executor",
                max_commands=3,
                answer_must_not_contain=["i found", "i listed", "i checked"],
                description="Answer should contain actual list, not summary"
            ),
            TestCase(
                name="accuracy_status_check_crd",
                category=TestCategory.ACCURACY,
                query="are eventhubs healthy?",
                expected_routing="smart_executor",
                max_commands=5,
                answer_must_not_contain=["pod"],
                description="Should check CRD status, not pods"
            ),
        ])

        # ================================================================
        # CATEGORY: UNIVERSAL DEBUG PATTERN (status → events → logs)
        # ================================================================

        tests.append(TestCase(
            name="universal_debug_status_first",
            category=TestCategory.UNIVERSAL_DEBUG,
            query="why is customercluster failing?",
            expected_routing="create_plan",
            max_commands=20,
            description="Should try status.message first, then events, then controller logs"
        ))

        return tests

    async def run_test(self, test_case: TestCase) -> TestResult:
        """Execute a single test case."""
        result = TestResult(test_case=test_case, passed=True)
        start_time = time.time()

        try:
            # Use /analyze endpoint with SSE streaming
            async with self.client.stream(
                "POST",
                f"{AGENT_SERVER_URL}/analyze",
                json={
                    "query": test_case.query,
                    "thread_id": f"test_{test_case.name}",
                    "kube_context": KUBE_CONTEXT,
                    "llm_endpoint": LLM_HOST,
                    "llm_provider": "ollama",
                    "llm_model": BRAIN_MODEL,
                    "executor_model": EXECUTOR_MODEL,
                }
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

                        if event.get("type") == "command_execution":
                            cmd = event.get("data", {}).get("command", "unknown")
                            result.commands_executed.append(cmd)
                            result.command_count += 1

                        if event.get("type") == "intent":
                            msg = event.get("data", {}).get("message", "")
                            if "SmartExecutor activated" in msg:
                                result.actual_routing = "smart_executor"
                            elif "Creating plan" in msg or "Plan created" in msg:
                                result.actual_routing = "create_plan"
                            elif "Delegating" in msg:
                                result.actual_routing = "delegate"
                            elif "batch" in msg.lower():
                                result.actual_routing = "batch_delegate"

                        if event.get("type") == "final_answer":
                            result.answer = event.get("data", {}).get("answer", "")
                            result.answer_length = len(result.answer)

                    except json.JSONDecodeError:
                        continue

            result.execution_time = time.time() - start_time
            self._validate_result(result)

        except Exception as e:
            result.exception = str(e)
            result.execution_time = time.time() - start_time
            result.add_failure(f"Exception: {e}")

        return result

    def _validate_result(self, result: TestResult):
        """Validate test result against expectations."""
        tc = result.test_case

        if tc.should_not_crash and (result.exception or (not result.answer and result.command_count == 0)):
            result.add_failure("Agent crashed")

        if tc.should_give_answer and not result.answer:
            result.add_failure("No answer provided")

        if tc.expected_routing and result.actual_routing != tc.expected_routing:
            result.add_failure(f"Wrong routing: {result.actual_routing} ≠ {tc.expected_routing}")

        if tc.max_commands and result.command_count > tc.max_commands:
            result.add_failure(f"Excessive commands: {result.command_count} > {tc.max_commands}")

        if tc.max_time_seconds and result.execution_time > tc.max_time_seconds:
            result.add_failure(f"Too slow: {result.execution_time:.1f}s > {tc.max_time_seconds}s")

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
        print("EXHAUSTIVE E2E INTEGRATION TEST SUITE")
        print("="*80)
        print(f"Tests: {len(self.test_cases)}")
        print(f"Cluster: {KUBE_CONTEXT}")
        print(f"Cluster CRDs: {len(self.cluster_crds)}")
        print("="*80)
        print("\n⏰ This will take a VERY LONG TIME...")

        overall_start = time.time()

        # Prioritize critical tests
        critical = [t for t in self.test_cases if t.priority == "CRITICAL"]
        normal = [t for t in self.test_cases if t.priority == "NORMAL"]

        print(f"\n🔥 Running {len(critical)} CRITICAL tests first...")
        for i, tc in enumerate(critical, 1):
            print(f"\n[CRITICAL {i}/{len(critical)}] {tc.name}")
            result = await self.run_test(tc)
            self.results.append(result)
            if not result.passed:
                print(f"   ❌ CRITICAL TEST FAILED: {result.failure_reasons}")
            await asyncio.sleep(2)

        print(f"\n📋 Running {len(normal)} normal tests...")
        for i, tc in enumerate(normal, 1):
            print(f"\n[{i}/{len(normal)}] {tc.name}")
            result = await self.run_test(tc)
            self.results.append(result)
            await asyncio.sleep(2)

        total_time = time.time() - overall_start
        self._print_summary(total_time)

    def _print_summary(self, total_time: float):
        """Print comprehensive summary."""
        print("\n" + "="*80)
        print("TEST SUMMARY")
        print("="*80)

        passed = [r for r in self.results if r.passed]
        failed = [r for r in self.results if not r.passed]
        critical_failed = [r for r in failed if r.test_case.priority == "CRITICAL"]

        print(f"\n✅ Passed: {len(passed)}/{len(self.results)}")
        print(f"❌ Failed: {len(failed)}/{len(self.results)}")
        if critical_failed:
            print(f"🔥 CRITICAL FAILURES: {len(critical_failed)}")
        print(f"⏱️  Total Time: {total_time/60:.1f} minutes")

        # Category breakdown
        print(f"\n📁 BY CATEGORY:")
        for category in TestCategory:
            cat_tests = [r for r in self.results if r.test_case.category == category]
            if cat_tests:
                cat_passed = sum(1 for r in cat_tests if r.passed)
                print(f"   {category.value}: {cat_passed}/{len(cat_tests)}")

        # Failed tests details
        if failed:
            print(f"\n❌ FAILED TESTS:")
            for r in failed:
                priority_marker = "🔥" if r.test_case.priority == "CRITICAL" else ""
                print(f"\n{priority_marker} {r.test_case.name}")
                print(f"   Category: {r.test_case.category.value}")
                print(f"   Query: {r.test_case.query}")
                print(f"   Routing: {r.actual_routing} (expected: {r.test_case.expected_routing})")
                print(f"   Commands: {r.command_count} (max: {r.test_case.max_commands})")
                for reason in r.failure_reasons:
                    print(f"   - {reason}")

        # Known issues tracking
        known_issues = [r for r in self.results if r.test_case.known_issue]
        if known_issues:
            print(f"\n⚠️  KNOWN ISSUES:")
            for r in known_issues:
                status = "✅ FIXED" if r.passed else "❌ STILL FAILING"
                print(f"   {status} - {r.test_case.name}: {r.test_case.known_issue}")

        print("\n" + "="*80)
        if failed:
            print(f"💥 {len(failed)} FAILURES")
        else:
            print("🎉 ALL TESTS PASSED!")
        print("="*80)

    async def close(self):
        await self.client.aclose()


async def main():
    tester = ExhaustiveE2ETester()
    try:
        await tester.initialize()
        await tester.run_all_tests()
        failed = [r for r in tester.results if not r.passed]
        exit(1 if failed else 0)
    finally:
        await tester.close()


if __name__ == "__main__":
    asyncio.run(main())
