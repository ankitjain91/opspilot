#!/usr/bin/env python3
"""
Property-Based Behavioral Tests

These tests verify INVARIANTS that must ALWAYS hold true, regardless of the query.
Unlike traditional tests that check specific outputs, these check agent behaviors.

Properties tested:
1. AUTONOMY: Agent never suggests commands, always executes
2. COMPLETENESS: CRD debugging always checks controller logs
3. EXACTNESS: Agent preserves exact resource names from query
4. NON-REGRESSION: Known issues stay fixed
"""

import asyncio
import pytest
import httpx
import os
from typing import Dict, List

# Configuration
AGENT_SERVER = os.environ.get("AGENT_SERVER", "http://localhost:8765")
TEST_CONTEXT = "dedicated-aks-dev-eastus-ankitj"


async def query_agent(query: str, context: str = TEST_CONTEXT) -> tuple[str, Dict]:
    """Query the agent and return both response and full state"""
    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.post(
            f"{AGENT_SERVER}/query",
            json={
                "query": query,
                "kube_context": context,
                "llm_endpoint": os.environ.get("LLM_ENDPOINT", "https://api.groq.com/openai/v1"),
                "llm_provider": os.environ.get("LLM_PROVIDER", "groq"),
                "llm_model": os.environ.get("LLM_MODEL", "llama-3.3-70b-versatile"),
                "executor_model": os.environ.get("EXECUTOR_MODEL", "qwen/qwen3-32b"),
                "api_key": os.environ.get("GROQ_API_KEY", ""),
            }
        )
        response.raise_for_status()
        data = response.json()
        return data.get("response", ""), data


# ============================================================================
# PROPERTY 1: AUTONOMY - Agent never delegates to user
# ============================================================================

@pytest.mark.asyncio
@pytest.mark.autonomy
async def test_autonomy_property_fetch_content():
    """
    PROPERTY: When user asks for content/data, agent NEVER suggests commands.

    Invariant: Response must NOT contain delegation phrases.
    """
    queries = [
        "find insights section in tetrisinputjson configmap",
        "show me data from secret my-secret",
        "get content of configmap app-config",
    ]

    forbidden_phrases = [
        'you can run',
        'try running',
        'use kubectl',
        'execute this',
        'run the following',
        'command you can use'
    ]

    for query in queries:
        response, state = await query_agent(query)

        # INVARIANT: No delegation phrases
        for phrase in forbidden_phrases:
            assert phrase.lower() not in response.lower(), \
                f"❌ AUTONOMY VIOLATED: Response contains '{phrase}' for query '{query}'\n" \
                f"Response: {response[:200]}"

        print(f"✅ AUTONOMY PASSED: {query}")


@pytest.mark.asyncio
@pytest.mark.autonomy
async def test_autonomy_property_has_actual_data():
    """
    PROPERTY: When user asks for content, response must contain actual data.

    Invariant: Response length > 100 chars AND contains specific data markers.
    """
    queries = [
        ("find insights section in tetrisinputjson configmap", ["data", "configmap"]),
    ]

    for query, required_markers in queries:
        response, state = await query_agent(query)

        # INVARIANT: Response has substance
        assert len(response) > 100, \
            f"❌ DATA MISSING: Response too short ({len(response)} chars) for '{query}'"

        # INVARIANT: Contains specific data markers
        for marker in required_markers:
            assert marker.lower() in response.lower(), \
                f"❌ DATA INCOMPLETE: Response missing '{marker}' for query '{query}'"

        print(f"✅ DATA PRESENT: {query}")


# ============================================================================
# PROPERTY 2: COMPLETENESS - CRD debugging requires controller logs
# ============================================================================

@pytest.mark.asyncio
@pytest.mark.completeness
async def test_completeness_property_crd_controller_logs():
    """
    PROPERTY: CRD troubleshooting ALWAYS checks controller logs.

    Invariant: Command history must contain 'kubectl logs' with grep.
    """
    crd_queries = [
        "why is customercluster taasvstst failing",
        "troubleshoot composition xyz",
        "debug claim abc in ASFailed state",
    ]

    for query in crd_queries:
        response, state = await query_agent(query)

        command_history = state.get('command_history', [])
        commands = [cmd.get('command', '') for cmd in command_history]

        # INVARIANT: Must have controller log check
        has_log_check = any(
            ('kubectl logs' in cmd and ('grep' in cmd or '--tail' in cmd))
            for cmd in commands
        )

        assert has_log_check, \
            f"❌ COMPLETENESS VIOLATED: No controller log check for '{query}'\n" \
            f"Commands executed: {commands}"

        print(f"✅ COMPLETENESS PASSED: {query}")


@pytest.mark.asyncio
@pytest.mark.completeness
async def test_completeness_property_multi_method_discovery():
    """
    PROPERTY: Discovery queries try multiple methods, not just api-resources.

    Invariant: At least 2 discovery methods attempted.
    """
    discovery_queries = [
        "list customerclusters",
        "find argocd instances",
        "show all istio resources",
    ]

    for query in discovery_queries:
        response, state = await query_agent(query)

        command_history = state.get('command_history', [])
        commands = [cmd.get('command', '') for cmd in command_history]

        # Count discovery methods
        methods = set()
        for cmd in commands:
            if 'api-resources' in cmd:
                methods.add('api_resources')
            if 'get pods' in cmd or 'get deploy' in cmd:
                methods.add('workload_grep')
            if 'get svc' in cmd or 'get ing' in cmd:
                methods.add('network_grep')
            if 'helm list' in cmd:
                methods.add('helm')

        # INVARIANT: At least 2 methods
        assert len(methods) >= 2, \
            f"❌ MULTI-METHOD VIOLATED: Only {len(methods)} discovery method(s) for '{query}'\n" \
            f"Commands: {commands}"

        print(f"✅ MULTI-METHOD PASSED: {query} ({len(methods)} methods)")


# ============================================================================
# PROPERTY 3: EXACTNESS - Preserve resource names from query
# ============================================================================

@pytest.mark.asyncio
@pytest.mark.exactness
async def test_exactness_property_resource_name_preservation():
    """
    PROPERTY: Agent uses exact resource names from query.

    Invariant: Resource name from query appears in at least one command.
    """
    test_cases = [
        ("list customerclusters", "customerclusters"),
        ("find azuredatabases", "azuredatabases"),
        ("show virtualclusters", "virtualclusters"),
    ]

    for query, expected_term in test_cases:
        response, state = await query_agent(query)

        command_history = state.get('command_history', [])
        commands = [cmd.get('command', '') for cmd in command_history]

        # INVARIANT: Exact term must appear in at least one command
        term_used = any(expected_term in cmd for cmd in commands)

        assert term_used, \
            f"❌ EXACTNESS VIOLATED: '{expected_term}' not used for '{query}'\n" \
            f"Commands: {commands}"

        print(f"✅ EXACTNESS PASSED: {query}")


# ============================================================================
# PROPERTY 4: NON-REGRESSION - Known issues stay fixed
# ============================================================================

@pytest.mark.asyncio
@pytest.mark.regression
async def test_regression_customerclusters_name():
    """
    REGRESSION TEST: "list customerclusters" must NOT use shortened "clusters".

    Historical issue: Agent was shortening "customerclusters" to "clusters"
    """
    query = "list customerclusters"
    response, state = await query_agent(query)

    command_history = state.get('command_history', [])
    commands = [cmd.get('command', '') for cmd in command_history]

    # Check: Must use full name
    uses_full_name = any('customerclusters' in cmd for cmd in commands)
    assert uses_full_name, \
        f"❌ REGRESSION: Not using 'customerclusters' in commands"

    # Check: Should NOT use wrong shortened version
    uses_wrong_name = any(
        ('get clusters' in cmd or 'get cluster' in cmd) and 'customerclusters' not in cmd
        for cmd in commands
    )
    assert not uses_wrong_name, \
        f"❌ REGRESSION: Using shortened 'clusters' instead of 'customerclusters'"

    print(f"✅ REGRESSION PASSED: customerclusters naming")


@pytest.mark.asyncio
@pytest.mark.regression
async def test_regression_configmap_autonomous_fetch():
    """
    REGRESSION TEST: "find X in configmap Y" must fetch yaml autonomously.

    Historical issue: Agent was suggesting command instead of fetching data
    """
    query = "find insights section in tetrisinputjson configmap"
    response, state = await query_agent(query)

    command_history = state.get('command_history', [])
    commands = [cmd.get('command', '') for cmd in command_history]

    # Check: Must have actually fetched yaml
    fetched_yaml = any('-o yaml' in cmd or '-o json' in cmd for cmd in commands)
    assert fetched_yaml, \
        f"❌ REGRESSION: Did not autonomously fetch configmap yaml"

    # Check: Response must NOT delegate
    delegation_phrases = ['you can run', 'kubectl get configmap']
    has_delegation = any(phrase in response.lower() for phrase in delegation_phrases)
    assert not has_delegation, \
        f"❌ REGRESSION: Response delegates to user instead of providing data"

    print(f"✅ REGRESSION PASSED: configmap autonomous fetch")


@pytest.mark.asyncio
@pytest.mark.regression
async def test_regression_crd_controller_discovery():
    """
    REGRESSION TEST: CRD ASFailed investigation must find and check controller.

    Historical issue: Agent gave up without finding controller or checking logs
    """
    query = "investigate why customercluster taasvstst is in ASFailed state"
    response, state = await query_agent(query)

    command_history = state.get('command_history', [])
    commands = [cmd.get('command', '') for cmd in command_history]
    debugging_context = state.get('debugging_context', {})

    # Check: Must have found a controller
    has_controller = bool(debugging_context.get('controller_pod'))
    assert has_controller, \
        f"❌ REGRESSION: Did not find controller for CRD debugging"

    # Check: Must have checked controller logs
    checked_logs = any('kubectl logs' in cmd for cmd in commands)
    assert checked_logs, \
        f"❌ REGRESSION: Did not check controller logs"

    # Check: Response must NOT say "INSUFFICIENT_EVIDENCE"
    assert 'INSUFFICIENT_EVIDENCE' not in response.upper(), \
        f"❌ REGRESSION: Gave up with INSUFFICIENT_EVIDENCE"

    print(f"✅ REGRESSION PASSED: CRD controller discovery")


# ============================================================================
# TEST RUNNER
# ============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s", "--tb=short"])
