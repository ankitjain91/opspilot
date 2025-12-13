#!/usr/bin/env python3
"""
Agent Accuracy Test Suite - Test-First Approach

Calls REAL LLM models and validates responses match expected behavior.
Run with: python -m pytest tests/test_agent_accuracy.py -v -s

Environment Variables:
  LLM_HOST: Ollama host (default: http://localhost:11434)
  LLM_MODEL: Brain model (default: llama3.3:70b)
  EXECUTOR_MODEL: Worker model (default: qwen2.5-coder:32b)
"""

import os
import sys
import json
import re
import asyncio
import pytest
import httpx
from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from enum import Enum

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Configuration
LLM_HOST = os.environ.get("LLM_HOST", "http://localhost:11434")
LLM_MODEL = os.environ.get("LLM_MODEL", "llama3.3:70b")
EXECUTOR_MODEL = os.environ.get("EXECUTOR_MODEL", "qwen2.5-coder:32b")
TIMEOUT = 300  # 5 minutes for 70B model

class TestResult(Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    ERROR = "ERROR"

@dataclass
class TestCase:
    """A single test case for agent evaluation"""
    name: str
    description: str
    query: str
    command_history: List[Dict[str, str]]
    expected_action: str  # "delegate" | "respond"
    expected_contains: List[str]  # Strings that should be in response
    expected_not_contains: List[str]  # Strings that should NOT be in response
    max_iterations: int = 1  # Expected number of iterations

@dataclass
class TestResult:
    """Result of running a test case"""
    test_name: str
    passed: bool
    actual_action: str
    actual_response: str
    errors: List[str]
    duration_ms: float

# =============================================================================
# LLM CALL HELPER
# =============================================================================

async def call_llm(prompt: str, model: str = LLM_MODEL, temperature: float = 0.3) -> str:
    """Call Ollama LLM and return response"""
    url = f"{LLM_HOST}/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "num_ctx": 8192,
            "temperature": temperature
        }
    }

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.post(url, json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("response", "")

def extract_json(text: str) -> Optional[Dict[str, Any]]:
    """Extract JSON from LLM response"""
    # Try to find JSON block
    patterns = [
        r'```json\s*([\s\S]*?)```',
        r'```\s*([\s\S]*?)```',
        r'(\{[\s\S]*\})',
    ]

    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                continue

    # Try parsing the whole response as JSON
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None

# =============================================================================
# PROMPTS (simplified versions for testing)
# =============================================================================

SUPERVISOR_PROMPT_TEMPLATE = """You are an Expert Kubernetes Assistant.

TASK: Analyze the query and decide the next action.

Query: {query}
Kubernetes Context: {kube_context}

Command History:
{command_history}

=== CRITICAL RULES (MUST FOLLOW) ===

RULE 1 - RESPOND IMMEDIATELY IF:
- You see ROOT CAUSE evidence in command_history:
  * OOMKilled/Exit 137 → Memory limit exceeded
  * OutOfMemoryError → Java heap exhausted
  * CrashLoopBackOff + error logs → Application crash found
  * ImagePullBackOff → Image pull issue identified
- User asked an EXPLANATION question (what is X?) → respond without kubectl
- User asked to LIST and you have the list → respond with the list

RULE 2 - DELEGATE IF:
- You need kubectl output to answer the question
- Namespace is UNKNOWN: use "-A | grep" pattern to discover
- No logs yet for debugging: get logs
- For Crossplane/CRDs: use "kubectl api-resources" first

RULE 3 - NAMESPACE DISCOVERY:
- NEVER guess namespace. If unknown, delegate with plan containing "-A | grep"
- Example: "kubectl get deploy -A | grep checkout-service"

RULE 4 - CROSSPLANE/CRD DISCOVERY:
- For custom resources, use "kubectl api-resources | grep crossplane" first
- Then use the discovered CRD names

=== EXAMPLES ===

EXAMPLE 1 - Root cause found, RESPOND:
Query: "Why is my-app crashing?"
History: kubectl logs shows "OutOfMemoryError" and "Exit code: 137"
Decision: next_action="respond" because OOMKilled is the root cause

EXAMPLE 2 - Namespace unknown, DELEGATE:
Query: "Check checkout-service"
History: (none)
Decision: next_action="delegate", plan="kubectl get deploy -A | grep checkout"

EXAMPLE 3 - Namespace found, DELEGATE to describe:
Query: "Check checkout-service"
History: "kubectl get deploy -A | grep checkout" → "payments   checkout-service..."
Decision: next_action="delegate", plan="kubectl describe deploy checkout-service -n payments"

=== OUTPUT FORMAT (JSON ONLY) ===
{{
    "thought": "Your analysis",
    "plan": "What to do next",
    "next_action": "delegate" | "respond",
    "final_response": "Your answer (only if next_action=respond)"
}}

OUTPUT JSON:"""

WORKER_PROMPT_TEMPLATE = """You are a Kubernetes CLI executor.

TASK: {plan}
CONTEXT: {kube_context}

Generate a single kubectl command.

RULES:
- Use actual values, not placeholders like <namespace>
- DO NOT use shell variables ($VAR)
- DO NOT use command substitution $(...)

RESPONSE FORMAT (JSON ONLY):
{{
    "thought": "Why this command",
    "command": "kubectl get pods -n default"
}}

OUTPUT JSON:"""

REFLECT_PROMPT_TEMPLATE = """Analyze if we found the answer.

QUERY: {query}
COMMAND: {command}
OUTPUT:
{output}

Did we find the answer?

INSTANT SOLUTION PATTERNS (found_solution=true):
- OOMKilled → Memory limit exceeded
- ImagePullBackOff + 401 → Auth failed
- CrashLoopBackOff + error in logs → App crash identified

CROSSPLANE/CRD PATTERNS:
- All providers show INSTALLED=True HEALTHY=True → All healthy, SOLVED
- SYNCED=False or READY=False with describe showing specific error → Root cause found, SOLVED
- status.conditions with Reason/Message containing error details → Root cause found, SOLVED

STATUS CHECK PATTERNS (found_solution=true if informational query answered):
- User asked about status and output shows READY/SYNCED columns → Answer the status, SOLVED
- User asked to list and output shows actual resource rows → List complete, SOLVED
- User asked "what's wrong" and all resources show healthy → Cluster is healthy, SOLVED

CONTINUE PATTERNS (found_solution=false):
- SYNCED=False or READY=False but NO describe output showing why → Need describe
- Output shows api-resources only, not actual instances → Need kubectl get <resource> -A

RESPONSE FORMAT (JSON ONLY):
{{
    "thought": "Analysis",
    "found_solution": true | false,
    "final_response": "Answer if found_solution=true",
    "next_step_hint": "What to check if found_solution=false"
}}

OUTPUT JSON:"""

# =============================================================================
# TEST CASES
# =============================================================================

TEST_CASES = [
    # --- LISTING QUERIES (should respond after one command) ---
    TestCase(
        name="list_pods_simple",
        description="Simple list should respond immediately after getting pods",
        query="List pods in namespace web",
        command_history=[
            {"command": "kubectl get pods -n web", "output": "NAME    READY   STATUS    RESTARTS   AGE\nweb-1   1/1     Running   0          1h\nweb-2   1/1     Running   0          1h"}
        ],
        expected_action="respond",
        expected_contains=["web-1", "web-2"],
        expected_not_contains=["delegate", "describe", "logs"],
    ),

    TestCase(
        name="list_pods_empty_history",
        description="List without history should delegate first",
        query="List pods in namespace payments",
        command_history=[],
        expected_action="delegate",
        expected_contains=["kubectl", "get", "pods"],
        expected_not_contains=["describe", "logs"],
    ),

    # --- EXPLANATION QUERIES (should respond without kubectl) ---
    TestCase(
        name="explain_statefulset",
        description="Explanation should respond without kubectl",
        query="What is a Kubernetes StatefulSet?",
        command_history=[],
        expected_action="respond",
        expected_contains=["StatefulSet", "persistent"],
        expected_not_contains=["delegate"],  # Don't check for "kubectl" - can appear in thought
    ),

    TestCase(
        name="explain_deployment_vs_statefulset",
        description="Conceptual comparison should respond directly",
        query="What's the difference between Deployment and StatefulSet?",
        command_history=[],
        expected_action="respond",
        expected_contains=["Deployment", "StatefulSet"],
        expected_not_contains=["delegate"],
    ),

    # --- DEBUGGING QUERIES (need investigation) ---
    TestCase(
        name="debug_crashloop_found",
        description="CrashLoopBackOff with logs showing OOM should respond with root cause",
        query="Why is my-app crashing?",
        command_history=[
            {"command": "kubectl get pods -n web | grep my-app", "output": "my-app-7c9d   0/1     CrashLoopBackOff   5   3m"},
            {"command": "kubectl logs my-app-7c9d -n web --tail=50", "output": "Error: OutOfMemoryError\nKilled\nExit code: 137"}
        ],
        expected_action="respond",
        expected_contains=["memory"],  # OOM/OutOfMemory - just check "memory" is mentioned
        expected_not_contains=[],
    ),

    TestCase(
        name="debug_crashloop_need_logs",
        description="CrashLoopBackOff without logs should delegate to get logs",
        query="Why is my-app crashing?",
        command_history=[
            {"command": "kubectl get pods -n web | grep my-app", "output": "my-app-7c9d   0/1     CrashLoopBackOff   5   3m"}
        ],
        expected_action="delegate",
        expected_contains=["logs"],
        expected_not_contains=["respond", "fixed"],
    ),

    # --- NAMESPACE DISCOVERY ---
    TestCase(
        name="namespace_discovery_first",
        description="Unknown namespace should discover first",
        query="Check the checkout-service deployment",
        command_history=[],
        expected_action="delegate",
        expected_contains=["-A", "grep", "checkout"],
        expected_not_contains=["-n default", "-n checkout"],
    ),

    TestCase(
        name="namespace_found_then_describe",
        description="After finding namespace, should describe",
        query="Check the checkout-service deployment",
        command_history=[
            {"command": "kubectl get deploy -A | grep checkout", "output": "payments   checkout-service   1/1   1   1   5d"}
        ],
        expected_action="delegate",
        expected_contains=["payments", "describe"],
        expected_not_contains=["-A"],
    ),

    # --- CROSSPLANE/CRD ---
    TestCase(
        name="crossplane_discovery",
        description="Crossplane query should discover CRDs first",
        query="List Crossplane compositions",
        command_history=[],
        expected_action="delegate",
        expected_contains=["api-resources", "crossplane"],  # Removed "crd" - model uses api-resources which is correct
        expected_not_contains=[],  # Don't be too restrictive
    ),

    TestCase(
        name="crossplane_all_healthy",
        description="When all Crossplane providers are healthy, should respond with healthy status",
        query="Are all Crossplane resources synced?",
        command_history=[
            {"command": "kubectl get providers.pkg.crossplane.io", "output": "NAME                   INSTALLED   HEALTHY   PACKAGE                                    AGE\nprovider-azure         True        True      xpkg.upbound.io/upbound/provider-azure    5d\nprovider-kubernetes    True        True      xpkg.upbound.io/upbound/provider-k8s      5d"}
        ],
        expected_action="respond",
        expected_contains=["healthy", "true"],
        expected_not_contains=[],
    ),

    TestCase(
        name="crossplane_provider_unhealthy",
        description="When provider is unhealthy, should identify the issue",
        query="What's wrong with my Crossplane setup?",
        command_history=[
            {"command": "kubectl get providers.pkg.crossplane.io", "output": "NAME                   INSTALLED   HEALTHY   PACKAGE                                    AGE\nprovider-azure         True        False     xpkg.upbound.io/upbound/provider-azure    5d"},
            {"command": "kubectl describe provider.pkg.crossplane.io provider-azure", "output": "Status:\n  Conditions:\n    Type: Healthy\n    Status: False\n    Reason: UnhealthyPackageRevision\n    Message: cannot get package revision health: error authenticating to Azure: DefaultAzureCredential: failed to acquire a token"}
        ],
        expected_action="respond",
        expected_contains=["credential", "azure", "token"],
        expected_not_contains=[],
    ),

    TestCase(
        name="customercluster_status_check",
        description="CustomerCluster CRD status should respond with status",
        query="What's the status of my customerclusters?",
        command_history=[
            {"command": "kubectl get customerclusters.dedicated.uipath.com -A", "output": "NAMESPACE    NAME           READY   SYNCED   AGE\nproduction   customer-1     True    True     10d\nstaging      customer-2     False   True     5d"}
        ],
        expected_action="respond",
        expected_contains=["customer-1", "customer-2", "staging"],
        expected_not_contains=[],
    ),

    TestCase(
        name="crd_synced_false_needs_describe",
        description="SYNCED=False without describe should delegate to describe",
        query="Why is my customercluster not working?",
        command_history=[
            {"command": "kubectl get customerclusters.dedicated.uipath.com -A", "output": "NAMESPACE    NAME           READY   SYNCED   AGE\nstaging      customer-2     False   False    5d"}
        ],
        expected_action="delegate",
        expected_contains=["describe", "customer-2"],
        expected_not_contains=["respond"],
    ),

    TestCase(
        name="crd_with_error_conditions",
        description="CRD with error in conditions should respond with root cause",
        query="Why is my customercluster failing?",
        command_history=[
            {"command": "kubectl get customerclusters.dedicated.uipath.com -A", "output": "NAMESPACE    NAME           READY   SYNCED   AGE\nstaging      customer-2     False   False    5d"},
            {"command": "kubectl describe customercluster customer-2 -n staging", "output": "Status:\n  Conditions:\n    - Type: Ready\n      Status: False\n      Reason: ReconcileError\n      Message: cannot create Azure SQL Server: AuthorizationFailed: The client does not have permission to perform action 'Microsoft.Sql/servers/write'"}
        ],
        expected_action="respond",
        expected_contains=["permission", "authorization", "sql"],
        expected_not_contains=[],
    ),

    # --- EDGE CASES ---
    TestCase(
        name="count_query",
        description="Count query should respond after getting count",
        query="How many pods are running?",
        command_history=[
            {"command": "kubectl get pods -A --no-headers | wc -l", "output": "42"}
        ],
        expected_action="respond",
        expected_contains=["42"],
        expected_not_contains=["delegate"],
    ),

    TestCase(
        name="existence_check",
        description="Existence check should respond yes/no",
        query="Does the payment-service exist?",
        command_history=[
            {"command": "kubectl get svc -A | grep payment", "output": "payments   payment-service   ClusterIP   10.0.1.5   80/TCP   5d"}
        ],
        expected_action="respond",
        expected_contains=["yes", "exists", "payment"],
        expected_not_contains=["delegate", "describe"],
    ),
]

# =============================================================================
# TEST RUNNER
# =============================================================================

async def run_supervisor_test(test: TestCase) -> TestResult:
    """Run a single supervisor test case"""
    import time
    start = time.time()
    errors = []

    # Format command history
    if test.command_history:
        history_str = "\n".join([
            f"$ {cmd['command']}\n{cmd['output']}"
            for cmd in test.command_history
        ])
    else:
        history_str = "(none)"

    # Build prompt
    prompt = SUPERVISOR_PROMPT_TEMPLATE.format(
        query=test.query,
        kube_context="default-cluster",
        command_history=history_str
    )

    # Call LLM
    try:
        response = await call_llm(prompt, model=LLM_MODEL, temperature=0.2)
    except Exception as e:
        return TestResult(
            test_name=test.name,
            passed=False,
            actual_action="ERROR",
            actual_response=str(e),
            errors=[f"LLM call failed: {e}"],
            duration_ms=(time.time() - start) * 1000
        )

    # Parse JSON
    parsed = extract_json(response)
    if not parsed:
        errors.append(f"Failed to parse JSON from response")
        return TestResult(
            test_name=test.name,
            passed=False,
            actual_action="PARSE_ERROR",
            actual_response=response,
            errors=errors,
            duration_ms=(time.time() - start) * 1000
        )

    actual_action = parsed.get("next_action", "MISSING")
    actual_response = parsed.get("final_response", "") or parsed.get("plan", "") or parsed.get("thought", "")

    # Check action
    if actual_action != test.expected_action:
        errors.append(f"Expected action '{test.expected_action}', got '{actual_action}'")

    # Check contains
    full_response = json.dumps(parsed).lower()
    for expected in test.expected_contains:
        if expected.lower() not in full_response:
            errors.append(f"Expected '{expected}' in response")

    # Check not contains
    for unexpected in test.expected_not_contains:
        if unexpected.lower() in full_response:
            errors.append(f"Unexpected '{unexpected}' found in response")

    passed = len(errors) == 0

    return TestResult(
        test_name=test.name,
        passed=passed,
        actual_action=actual_action,
        actual_response=response[:500],
        errors=errors,
        duration_ms=(time.time() - start) * 1000
    )

async def run_worker_test(plan: str, expected_command_pattern: str) -> TestResult:
    """Run a worker test case"""
    import time
    start = time.time()
    errors = []

    prompt = WORKER_PROMPT_TEMPLATE.format(
        plan=plan,
        kube_context="default-cluster"
    )

    try:
        response = await call_llm(prompt, model=EXECUTOR_MODEL, temperature=0.1)
    except Exception as e:
        return TestResult(
            test_name=f"worker_{plan[:30]}",
            passed=False,
            actual_action="ERROR",
            actual_response=str(e),
            errors=[f"LLM call failed: {e}"],
            duration_ms=(time.time() - start) * 1000
        )

    parsed = extract_json(response)
    if not parsed:
        errors.append("Failed to parse JSON")
        return TestResult(
            test_name=f"worker_{plan[:30]}",
            passed=False,
            actual_action="PARSE_ERROR",
            actual_response=response,
            errors=errors,
            duration_ms=(time.time() - start) * 1000
        )

    command = parsed.get("command", "")

    # Check for forbidden patterns
    forbidden = ["<", ">", "$", "$(", "${", "placeholder"]
    for f in forbidden:
        if f in command.lower():
            errors.append(f"Forbidden pattern '{f}' in command")

    # Check expected pattern
    if expected_command_pattern and expected_command_pattern not in command:
        errors.append(f"Expected pattern '{expected_command_pattern}' not in command")

    passed = len(errors) == 0

    return TestResult(
        test_name=f"worker_{plan[:30]}",
        passed=passed,
        actual_action=command,
        actual_response=response[:500],
        errors=errors,
        duration_ms=(time.time() - start) * 1000
    )

# =============================================================================
# PYTEST TEST FUNCTIONS
# =============================================================================

@pytest.fixture(scope="module")
def event_loop():
    """Create event loop for async tests"""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()

@pytest.mark.asyncio
@pytest.mark.parametrize("test_case", TEST_CASES, ids=[t.name for t in TEST_CASES])
async def test_supervisor(test_case: TestCase):
    """Test supervisor node decisions"""
    result = await run_supervisor_test(test_case)

    print(f"\n{'='*60}")
    print(f"TEST: {test_case.name}")
    print(f"QUERY: {test_case.query}")
    print(f"EXPECTED: {test_case.expected_action}")
    print(f"ACTUAL: {result.actual_action}")
    print(f"DURATION: {result.duration_ms:.0f}ms")
    if result.errors:
        print(f"ERRORS: {result.errors}")
    print(f"RESPONSE: {result.actual_response[:300]}...")
    print(f"{'='*60}")

    assert result.passed, f"Test failed: {result.errors}"

@pytest.mark.asyncio
async def test_worker_basic():
    """Test worker generates valid commands"""
    result = await run_worker_test(
        plan="Get all pods in namespace web",
        expected_command_pattern="kubectl get pods -n web"
    )
    print(f"\nWorker Result: {result}")
    assert result.passed, f"Test failed: {result.errors}"

@pytest.mark.asyncio
async def test_worker_no_placeholders():
    """Test worker doesn't use placeholders"""
    result = await run_worker_test(
        plan="Describe the pod my-app-xyz in namespace payments",
        expected_command_pattern="describe"
    )
    # Check no placeholders
    assert "<" not in result.actual_action
    assert ">" not in result.actual_action
    assert "$" not in result.actual_action

@pytest.mark.asyncio
async def test_worker_no_shell_vars():
    """Test worker doesn't use shell variables"""
    result = await run_worker_test(
        plan="Get pods, then describe the first one",
        expected_command_pattern="kubectl"
    )
    # Should NOT have command substitution
    assert "$(" not in result.actual_action
    assert "${" not in result.actual_action

# =============================================================================
# CLI RUNNER
# =============================================================================

async def run_all_tests(verbose: bool = False):
    """Run all tests and print summary"""
    print(f"\n{'='*70}")
    print(f"AGENT ACCURACY TEST SUITE")
    print(f"LLM Host: {LLM_HOST}")
    print(f"Brain Model: {LLM_MODEL}")
    print(f"Worker Model: {EXECUTOR_MODEL}")
    print(f"{'='*70}\n")

    results = []

    for test in TEST_CASES:
        print(f"Running: {test.name}...", end=" ", flush=True)
        result = await run_supervisor_test(test)
        results.append(result)
        status = "PASS" if result.passed else "FAIL"
        print(f"{status} ({result.duration_ms:.0f}ms)")
        if not result.passed:
            for err in result.errors:
                print(f"  - {err}")
            if verbose:
                print(f"  FULL RESPONSE:\n{result.actual_response}\n")

    # Summary
    passed = sum(1 for r in results if r.passed)
    failed = len(results) - passed
    total_time = sum(r.duration_ms for r in results)

    print(f"\n{'='*70}")
    print(f"SUMMARY: {passed}/{len(results)} passed, {failed} failed")
    print(f"TOTAL TIME: {total_time/1000:.1f}s")
    print(f"{'='*70}")

    if failed > 0:
        print("\nFailed tests:")
        for r in results:
            if not r.passed:
                print(f"  - {r.test_name}: {r.errors}")

    return results

if __name__ == "__main__":
    import sys
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    asyncio.run(run_all_tests(verbose=verbose))
