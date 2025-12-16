#!/usr/bin/env python3
"""
End-to-End Regression Test Suite for OpsPilot Agent

This test suite covers a wide variety of scenarios from simple to complex:
- Simple: Basic resource queries (pods, nodes, deployments)
- Medium: CRD queries, namespace-specific searches, service discovery
- Complex: Deep investigation (crashloops, debugging, resource relationships)
- CNCF: ArgoCD applications, Crossplane resources, cert-manager
- vcluster: Virtual cluster discovery and investigation
- Azure: Azure-specific resource queries and diagnostics

Tests use the remote LLM at http://20.56.146.53:11434
"""

import asyncio
import httpx
import json
import sys
import os
from typing import Dict, List, Tuple
from dataclasses import dataclass

# Configuration
REMOTE_ENDPOINT = os.environ.get("LLM_ENDPOINT", "https://api.groq.com/openai/v1")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "groq")
LLM_MODEL = os.environ.get("LLM_MODEL", "llama-3.3-70b-versatile")
EXECUTOR_MODEL = os.environ.get("EXECUTOR_MODEL", "qwen/qwen3-32b")
AGENT_SERVER = os.environ.get("AGENT_SERVER", "http://localhost:8765")
TEST_CONTEXT = "dedicated-aks-dev-eastus-ankitj"

@dataclass
class TestCase:
    """Test case definition"""
    name: str
    query: str
    category: str  # simple, medium, complex, cncf, vcluster, azure
    expected_keywords: List[str]  # Keywords that should appear in response
    should_not_contain: List[str] = None  # Keywords that should NOT appear
    min_response_length: int = 50  # Minimum response length
    timeout: int = 300  # Timeout in seconds (increased for LLM-based agent workflows)

    def __post_init__(self):
        if self.should_not_contain is None:
            self.should_not_contain = []


# Test cases organized by complexity
TEST_CASES = [
    # ============================================
    # SIMPLE TESTS - Basic resource queries
    # ============================================
    TestCase(
        name="List all pods",
        query="show me all pods",
        category="simple",
        expected_keywords=["pod", "namespace"],
        should_not_contain=["error", "failed", "cannot"],
    ),
    TestCase(
        name="Count nodes",
        query="how many nodes are in the cluster",
        category="simple",
        expected_keywords=["node"],
        min_response_length=20,
    ),
    TestCase(
        name="List deployments",
        query="show all deployments",
        category="simple",
        expected_keywords=["deployment", "namespace"],
    ),
    TestCase(
        name="Get services",
        query="list all services",
        category="simple",
        expected_keywords=["service"],
    ),
    TestCase(
        name="Namespace list",
        query="what namespaces exist",
        category="simple",
        expected_keywords=["namespace"],
        min_response_length=30,
    ),

    # ============================================
    # MEDIUM COMPLEXITY - CRDs, filtering, specific queries
    # ============================================
    TestCase(
        name="Find CRDs",
        query="what custom resource definitions are installed",
        category="medium",
        expected_keywords=["custom", "resource", "definition"],
    ),
    TestCase(
        name="Specific namespace pods",
        query="show pods in kube-system namespace",
        category="medium",
        expected_keywords=["kube-system", "pod"],
    ),
    TestCase(
        name="Service endpoints",
        query="show me service endpoints",
        category="medium",
        expected_keywords=["endpoint", "service"],
    ),
    TestCase(
        name="Storage classes",
        query="what storage classes are available",
        category="medium",
        expected_keywords=["storage"],
    ),
    TestCase(
        name="ConfigMaps in namespace",
        query="list configmaps in default namespace",
        category="medium",
        expected_keywords=["configmap", "default"],
    ),

    # ============================================
    # COMPLEX - Deep investigation, debugging
    # ============================================
    TestCase(
        name="Find crashlooping pods",
        query="find all crashlooping pods",
        category="complex",
        expected_keywords=["pod", "crashloop", "restart"],
        timeout=180,
    ),
    TestCase(
        name="Investigate failing pods",
        query="investigate why pods are failing",
        category="complex",
        expected_keywords=["pod", "fail"],
        timeout=180,
    ),
    TestCase(
        name="Resource bottlenecks",
        query="are there any resource bottlenecks or nodes under pressure",
        category="complex",
        expected_keywords=["node", "resource"],
        timeout=180,
    ),
    TestCase(
        name="Unhealthy deployments",
        query="find unhealthy deployments and explain why",
        category="complex",
        expected_keywords=["deployment"],
        timeout=180,
    ),
    TestCase(
        name="Network policy issues",
        query="check for network policy issues",
        category="complex",
        expected_keywords=["network"],
        timeout=180,
    ),

    # ============================================
    # CNCF COMPONENTS - ArgoCD, Crossplane, cert-manager
    # ============================================
    TestCase(
        name="ArgoCD applications",
        query="list all argocd applications",
        category="cncf",
        expected_keywords=["application", "argocd"],
    ),
    TestCase(
        name="ArgoCD sync status",
        query="show argocd application sync status",
        category="cncf",
        expected_keywords=["sync", "argocd"],
    ),
    TestCase(
        name="Crossplane providers",
        query="what crossplane providers are installed",
        category="cncf",
        expected_keywords=["crossplane", "provider"],
    ),
    TestCase(
        name="Crossplane resources",
        query="show crossplane managed resources",
        category="cncf",
        expected_keywords=["crossplane", "managed"],
    ),
    TestCase(
        name="Cert-manager certificates",
        query="list all cert-manager certificates",
        category="cncf",
        expected_keywords=["certificate", "cert"],
    ),
    TestCase(
        name="Cert-manager issuers",
        query="show cert-manager issuers",
        category="cncf",
        expected_keywords=["issuer", "cert"],
    ),

    # ============================================
    # VCLUSTER - Virtual cluster operations
    # ============================================
    TestCase(
        name="Find vclusters",
        query="find all vclusters",
        category="vcluster",
        expected_keywords=["vcluster"],
    ),
    TestCase(
        name="vcluster health",
        query="check vcluster health status",
        category="vcluster",
        expected_keywords=["vcluster", "health"],
    ),
    TestCase(
        name="vcluster resources",
        query="what resources are running in vclusters",
        category="vcluster",
        expected_keywords=["vcluster", "resource"],
    ),

    # ============================================
    # AZURE - Azure-specific queries
    # ============================================
    TestCase(
        name="Azure load balancer",
        query="show azure load balancer configuration",
        category="azure",
        expected_keywords=["azure", "load"],
    ),
    TestCase(
        name="Azure node pools",
        query="what azure node pools exist",
        category="azure",
        expected_keywords=["azure", "node"],
    ),
    TestCase(
        name="Azure storage",
        query="show azure storage configuration",
        category="azure",
        expected_keywords=["azure", "storage"],
    ),
]


async def run_test_case(test: TestCase) -> Tuple[bool, str, Dict]:
    """
    Run a single test case and return (passed, message, details)
    """
    print(f"\n{'='*80}")
    print(f"Test: {test.name}")
    print(f"Category: {test.category}")
    print(f"Query: '{test.query}'")
    print(f"{'='*80}")

    payload = {
        "query": test.query,
        "kube_context": TEST_CONTEXT,
        "llm_endpoint": REMOTE_ENDPOINT,
        "llm_provider": LLM_PROVIDER,
        "llm_model": LLM_MODEL,
        "executor_model": EXECUTOR_MODEL,
        "api_key": GROQ_API_KEY,
        "approved_command": True,  # Auto-approve all commands for E2E tests
    }

    response_text = ""
    events = []

    try:
        async with httpx.AsyncClient(timeout=test.timeout) as client:
            async with client.stream('POST', f"{AGENT_SERVER}/analyze", json=payload) as response:
                if response.status_code != 200:
                    return False, f"HTTP {response.status_code}", {"error": "Bad status code"}

                async for line in response.aiter_lines():
                    if not line or not line.startswith('data:'):
                        continue

                    try:
                        event = json.loads(line[5:].strip())
                        events.append(event)

                        if event.get('type') == 'final_response':
                            response_text = event.get('data', {}).get('response', '')
                            print(f"\n✅ RESPONSE ({len(response_text)} chars):")
                            print(f"{response_text[:300]}...")
                    except:
                        pass

    except asyncio.TimeoutError:
        return False, f"Timeout after {test.timeout}s", {"timeout": True}
    except Exception as e:
        return False, f"Error: {e}", {"exception": str(e)}

    # Validation checks
    if not response_text:
        return False, "No response received", {"empty": True}

    if len(response_text) < test.min_response_length:
        return False, f"Response too short ({len(response_text)} < {test.min_response_length})", {
            "length": len(response_text),
            "min_expected": test.min_response_length
        }

    # Check for expected keywords
    missing_keywords = []
    response_lower = response_text.lower()
    for keyword in test.expected_keywords:
        if keyword.lower() not in response_lower:
            missing_keywords.append(keyword)

    if missing_keywords:
        return False, f"Missing keywords: {missing_keywords}", {
            "missing": missing_keywords,
            "response_preview": response_text[:200]
        }

    # Check for keywords that should NOT appear
    forbidden_found = []
    for keyword in test.should_not_contain:
        if keyword.lower() in response_lower:
            forbidden_found.append(keyword)

    if forbidden_found:
        return False, f"Contains forbidden keywords: {forbidden_found}", {
            "forbidden": forbidden_found,
            "response_preview": response_text[:200]
        }

    return True, "PASSED", {
        "response_length": len(response_text),
        "events_count": len(events),
        "response_preview": response_text[:150]
    }


async def run_test_suite():
    """
    Run all test cases and generate report
    """
    print("\n" + "="*80)
    print("🧪 OpsPilot E2E Regression Test Suite")
    print("="*80)
    print(f"LLM Endpoint: {REMOTE_ENDPOINT}")
    print(f"LLM Provider: {LLM_PROVIDER}")
    print(f"LLM Model: {LLM_MODEL}")
    print(f"Executor Model: {EXECUTOR_MODEL}")
    print(f"Agent Server: {AGENT_SERVER}")
    print(f"Context: {TEST_CONTEXT}")
    print(f"Total Tests: {len(TEST_CASES)}")
    print("="*80)

    # Check connectivity (only for Ollama)
    print("\n1️⃣ Checking remote LLM connectivity...")
    if LLM_PROVIDER == "ollama":
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{REMOTE_ENDPOINT}/api/tags")
                if response.status_code == 200:
                    models = response.json().get('models', [])
                    print(f"✅ Remote LLM accessible - {len(models)} models available")
                else:
                    print(f"❌ Remote LLM returned {response.status_code}")
                    return False
        except Exception as e:
            print(f"❌ Cannot reach remote LLM: {e}")
            return False
    else:
        print(f"✅ Using {LLM_PROVIDER} provider (skipping connectivity check)")

    print("\n2️⃣ Checking agent server connectivity...")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Just check if server is up (any response is fine)
            response = await client.get(f"{AGENT_SERVER.replace('/analyze', '')}/")
    except:
        pass  # Server might not have a root endpoint, that's ok

    # Run tests by category
    results_by_category = {
        "simple": [],
        "medium": [],
        "complex": [],
        "cncf": [],
        "vcluster": [],
        "azure": [],
    }

    print("\n3️⃣ Running tests...\n")

    for test in TEST_CASES:
        passed, message, details = await run_test_case(test)
        results_by_category[test.category].append({
            "test": test,
            "passed": passed,
            "message": message,
            "details": details
        })

        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"\n{status} - {message}")

    # Generate report
    print("\n" + "="*80)
    print("📊 TEST RESULTS SUMMARY")
    print("="*80)

    total_tests = 0
    total_passed = 0

    for category, results in results_by_category.items():
        if not results:
            continue

        passed = sum(1 for r in results if r["passed"])
        total = len(results)
        total_tests += total
        total_passed += passed

        percentage = (passed / total * 100) if total > 0 else 0
        status = "✅" if passed == total else "⚠️" if passed > 0 else "❌"

        print(f"\n{status} {category.upper()}: {passed}/{total} passed ({percentage:.1f}%)")

        # Show failed tests
        failed = [r for r in results if not r["passed"]]
        for result in failed:
            print(f"   ❌ {result['test'].name}: {result['message']}")

    print("\n" + "="*80)
    overall_percentage = (total_passed / total_tests * 100) if total_tests > 0 else 0
    print(f"OVERALL: {total_passed}/{total_tests} passed ({overall_percentage:.1f}%)")
    print("="*80)

    # Exit code based on results
    if total_passed == total_tests:
        print("\n✅ ALL TESTS PASSED!")
        return True
    else:
        print(f"\n⚠️  {total_tests - total_passed} test(s) failed")
        return False


async def main():
    success = await run_test_suite()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    asyncio.run(main())
