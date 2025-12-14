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
class AgentTestCase:
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
class AgentTestResult:
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
- User asked to FIND/FILTER (find failing X, show me failing X, any X failing) and command_history shows resources with failure indicators (SYNCED=False, READY=False, CrashLoopBackOff, etc.) → The list IS the answer, respond immediately
  * Example: "find failing crossplane" + history shows resources with SYNCED=False → RESPOND with the list
  * The PRESENCE of resources with failure indicators answers the "find" query

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

FIND FAILING PATTERNS (found_solution=true for "find failing X" queries):
- User asked "find failing X" and output shows resources with SYNCED=False or READY=False → SOLVED
  * The LIST of failing resources IS the answer - don't need to investigate WHY unless user asks
  * Example: "find failing crossplane" + output shows 17 resources with SYNCED=False → SOLVED
- User asked "any X failing" and output shows resources (or no resources) → SOLVED
  * Answer is either "Yes, here they are: [list]" or "No failing resources found"

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
    AgentTestCase(
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

    AgentTestCase(
        name="list_pods_empty_history",
        description="List without history should delegate first",
        query="List pods in namespace payments",
        command_history=[],
        expected_action="delegate",
        expected_contains=["kubectl", "get", "pods"],
        expected_not_contains=["describe", "logs"],
    ),

    # --- EXPLANATION QUERIES (should respond without kubectl) ---
    AgentTestCase(
        name="explain_statefulset",
        description="Explanation should respond without kubectl",
        query="What is a Kubernetes StatefulSet?",
        command_history=[],
        expected_action="respond",
        expected_contains=["StatefulSet", "persistent"],
        expected_not_contains=["delegate"],  # Don't check for "kubectl" - can appear in thought
    ),

    AgentTestCase(
        name="explain_deployment_vs_statefulset",
        description="Conceptual comparison should respond directly",
        query="What's the difference between Deployment and StatefulSet?",
        command_history=[],
        expected_action="respond",
        expected_contains=["Deployment", "StatefulSet"],
        expected_not_contains=["delegate"],
    ),

    # --- DEBUGGING QUERIES (need investigation) ---
    AgentTestCase(
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

    AgentTestCase(
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
    AgentTestCase(
        name="namespace_discovery_first",
        description="Unknown namespace should discover first",
        query="Check the checkout-service deployment",
        command_history=[],
        expected_action="delegate",
        expected_contains=["-A", "grep", "checkout"],
        expected_not_contains=["-n default", "-n checkout"],
    ),

    AgentTestCase(
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
    AgentTestCase(
        name="crossplane_discovery",
        description="Crossplane query should discover CRDs first",
        query="List Crossplane compositions",
        command_history=[],
        expected_action="delegate",
        expected_contains=["api-resources", "crossplane"],  # Removed "crd" - model uses api-resources which is correct
        expected_not_contains=[],  # Don't be too restrictive
    ),

    AgentTestCase(
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

    AgentTestCase(
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

    AgentTestCase(
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

    AgentTestCase(
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

    AgentTestCase(
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
    AgentTestCase(
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

    AgentTestCase(
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

    # ========================================================================
    # TOUGH AZURE CROSSPLANE TESTS (Based on real cluster data)
    # ========================================================================

    AgentTestCase(
        name="crossplane_find_failing_resources",
        description="CRITICAL: Find failing query should respond with list immediately (the bug we fixed!)",
        query="find failing crossplane resources",
        command_history=[
            {"command": "kubectl get managed -A", "output": """NAME                                                    SYNCED   READY   EXTERNAL-NAME
asrobots-sauipathspzjz                                  False    True    asrobots-sauipathspzjz
du-documentmanager-service-accountuipathj22rc           False    True    du-documentmanager-service-accountuipathj22rc
aicenter-jobsuipathp2s4l                                False    True    aicenter-jobsuipathp2s4l
dataservice-fe-service-accountuipathrbw74               False    True    dataservice-fe-service-accountuipathrbw74
aicenter-deployuipathcgwqt                              False    True    aicenter-deployuipathcgwqt
defaultuipath-checkssxzf                                False    True    defaultuipath-checkssxzf
infra-backup-sainfra-backupll7b9                        False    True    infra-backup-sainfra-backupll7b9
insights-adfuipath9kgg5                                 False    True    insights-adfuipath9kgg5
airflowuipathk7x4g                                      False    True    airflowuipathk7x4g
velero-servervelerork8vc                                False    True    velero-servervelerork8vc
llmobservability-service-accountuipathsk97h             False    True    llmobservability-service-accountuipathsk97h
ailoadbalancer-service-accountuipathvbqg4               False    True    ailoadbalancer-service-accountuipathvbqg4
services-configure-uipath-bauipathllwsb                 False    True    services-configure-uipath-bauipathllwsb
external-secretsuipath5h255                             False    True    external-secretsuipath5h255
dataservice-be-service-accountuipathlsthj               False    True    dataservice-be-service-accountuipathlsthj
uipathctldefaultbgxpc                                   False    True    uipathctldefaultbgxpc
defaultuipath82jnx                                      False    True    defaultuipath82jnx"""}
        ],
        expected_action="respond",
        expected_contains=["synced=false", "failing"],  # Should mention the status (count is optional)
        expected_not_contains=["delegate", "describe"],  # Should NOT investigate each resource
    ),

    AgentTestCase(
        name="crossplane_reconcile_paused_pattern",
        description="ReconcilePaused is NOT an error - SYNCED=False but READY=True is intentional",
        query="Why are my Crossplane role assignments showing SYNCED=False?",
        command_history=[
            {"command": "kubectl get roleassignment.authorization.azure.upbound.io -A", "output": "NAME                    SYNCED   READY   EXTERNAL-NAME\ntaasvstst-vc-admin      False    True    /subscriptions/.../roleAssignments/fa36df05"},
            {"command": "kubectl describe roleassignment.authorization.azure.upbound.io taasvstst-vc-admin", "output": """Status:
  Conditions:
    Type: Ready
    Status: True
    Reason: Available
    Type: Synced
    Status: False
    Reason: ReconcilePaused
    Message: Reconciliation is paused via the pause annotation"""}
        ],
        expected_action="respond",
        expected_contains=["paused", "intentional", "not an error", "healthy"],
        expected_not_contains=["failed", "broken", "fix"],
    ),

    AgentTestCase(
        name="azure_provider_credential_failure",
        description="Azure provider credential failure should identify auth issue",
        query="Why is my Crossplane Azure provider not working?",
        command_history=[
            {"command": "kubectl get providers.pkg.crossplane.io | grep azure", "output": "provider-azure-authorization    True    False   xpkg.upbound.io/upbound/provider-azure-authorization   8d"},
            {"command": "kubectl describe provider.pkg.crossplane.io provider-azure-authorization", "output": """Status:
  Conditions:
    Type: Healthy
    Status: False
    Reason: UnhealthyPackageRevision
    Message: cannot acquire Azure credentials: DefaultAzureCredential: failed to acquire token from environment: EnvironmentCredential: incomplete environment variable configuration. AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET must be set"""}
        ],
        expected_action="respond",
        expected_contains=["credential", "environment variable", "azure_tenant_id", "azure_client_id"],
        expected_not_contains=[],
    ),

    AgentTestCase(
        name="azure_rbac_403_error",
        description="Azure 403 AuthorizationFailed should identify permission issue",
        query="Why is my Azure managed cluster failing to provision?",
        command_history=[
            {"command": "kubectl get managedclusters.containerservice.azure.com -A", "output": "NAMESPACE   NAME           READY   SYNCED   AGE\naks-prod    prod-cluster   False   False    2h"},
            {"command": "kubectl describe managedcluster.containerservice.azure.com prod-cluster -n aks-prod", "output": """Status:
  Conditions:
    Type: Synced
    Status: False
    Reason: ReconcileError
    Message: cannot create AKS cluster: StatusCode=403, ErrorCode=AuthorizationFailed, Message=The client 'xyz@example.com' with object id 'abc-123' does not have authorization to perform action 'Microsoft.ContainerService/managedClusters/write' over scope '/subscriptions/981e1dd9-316a-4365-8a58-3eac3687f3cb/resourceGroups/aks-prod'"""}
        ],
        expected_action="respond",
        expected_contains=["403", "authorization", "permission", "rbac", "microsoft.containerservice"],
        expected_not_contains=[],
    ),

    AgentTestCase(
        name="customerclusterenv_custom_crd_envfailed",
        description="CustomerClusterEnv custom CRD with non-standard STATE field (not READY/SYNCED)",
        query="Why is my customer cluster environment failing?",
        command_history=[
            {"command": "kubectl get customerclusterenvs.dedicated.uipath.com -A", "output": "NAMESPACE    NAME        STATE       AGE\ntaasvstst    taasvstst   EnvFailed   8d"},
            {"command": "kubectl describe customerclusterenv taasvstst -n taasvstst", "output": """Status:
  Current State: EnvFailed
  Message: Failed to provision Azure Cosmos DB: QuotaExceeded - Subscription has reached its limit for Cosmos DB accounts in region 'eastus'. Current: 10, Limit: 10
  Conditions:
    Type: Provisioned
    Status: False
    Reason: QuotaExceeded"""}
        ],
        expected_action="respond",
        expected_contains=["quota", "cosmos", "limit", "10"],
        expected_not_contains=[],
    ),

    AgentTestCase(
        name="crossplane_azure_managed_identity_synced_false",
        description="Azure Managed Identity with SYNCED=False but READY=True (likely paused)",
        query="Check status of Azure managed identities",
        command_history=[
            {"command": "kubectl get userassignedidentities.managedidentity.azure.upbound.io -A", "output": "NAME              SYNCED   READY   EXTERNAL-NAME\ntaasvstst6n7mw    False    True    /subscriptions/981e1dd9-316a-4365-8a58-3eac3687f3cb/resourceGroups/taasvstst/providers/Microsoft.ManagedIdentity/userAssignedIdentities/taasvstst"}
        ],
        expected_action="respond",
        expected_contains=["ready=true", "exists", "azure"],
        expected_not_contains=["error", "failed"],  # READY=True means it exists, this is likely paused
    ),

    AgentTestCase(
        name="crossplane_multiple_provider_types_mixed_health",
        description="Multiple provider types with mixed health status",
        query="Check all Crossplane providers",
        command_history=[
            {"command": "kubectl get providers.pkg.crossplane.io", "output": """NAME                               INSTALLED   HEALTHY   PACKAGE
provider-azure-authorization       True        True      upbound/provider-azure-authorization
provider-azure-compute             True        False     upbound/provider-azure-compute
provider-azure-keyvault            True        True      upbound/provider-azure-keyvault
provider-azure-network             True        True      upbound/provider-azure-network
provider-azure-sql                 True        False     upbound/provider-azure-sql
provider-azure-storage             True        True      upbound/provider-azure-storage"""}
        ],
        expected_action="respond",
        expected_contains=["provider-azure-compute", "provider-azure-sql", "unhealthy", "false"],
        expected_not_contains=["all healthy"],
    ),

    AgentTestCase(
        name="crossplane_resource_not_found_404",
        description="Crossplane resource referencing non-existent Azure resource",
        query="Why is my storage account failing?",
        command_history=[
            {"command": "kubectl get account.storage.azure.upbound.io -A", "output": "NAMESPACE   NAME              READY   SYNCED   AGE\nstorage     mybackupstorage   False   False    1h"},
            {"command": "kubectl describe account.storage.azure.upbound.io mybackupstorage -n storage", "output": """Status:
  Conditions:
    Type: Synced
    Status: False
    Reason: ReconcileError
    Message: cannot get storage account: Code=ResourceNotFound, Message=The Resource 'Microsoft.Storage/storageAccounts/mybackupstorage' under resource group 'backup-rg' was not found. The resource group 'backup-rg' does not exist."""}
        ],
        expected_action="respond",
        expected_contains=["404", "not found", "resource group", "backup-rg"],
        expected_not_contains=[],
    ),

    AgentTestCase(
        name="crossplane_azure_quota_exceeded",
        description="Azure quota/rate limit error (429)",
        query="Why can't I create more VMs?",
        command_history=[
            {"command": "kubectl get virtualmachine.compute.azure.upbound.io -A", "output": "NAMESPACE   NAME      READY   SYNCED   AGE\ncompute     testvm    False   False    10m"},
            {"command": "kubectl describe virtualmachine.compute.azure.upbound.io testvm -n compute", "output": """Status:
  Conditions:
    Type: Synced
    Status: False
    Reason: ReconcileError
    Message: cannot create VM: Code=QuotaExceeded, Message=Operation could not be completed as it results in exceeding approved Standard DSv3 Family Cores quota. Current: 48, Requested: 4, Limit: 50"""}
        ],
        expected_action="respond",
        expected_contains=["quota", "exceeded", "limit", "50", "cores"],
        expected_not_contains=[],
    ),

    AgentTestCase(
        name="crossplane_invalid_parameter_validation_error",
        description="Invalid configuration in Crossplane spec",
        query="Why is my database creation failing?",
        command_history=[
            {"command": "kubectl get flexibleserver.dbformysql.azure.upbound.io -A", "output": "NAMESPACE   NAME        READY   SYNCED   AGE\ndb          mysql-prod  False   False    5m"},
            {"command": "kubectl describe flexibleserver.dbformysql.azure.upbound.io mysql-prod -n db", "output": """Status:
  Conditions:
    Type: Synced
    Status: False
    Reason: ReconcileError
    Message: cannot create MySQL server: Code=InvalidParameter, Message=The requested tier 'Ultra' is not valid. Valid values are: 'Burstable', 'GeneralPurpose', 'MemoryOptimized'"""}
        ],
        expected_action="respond",
        expected_contains=["invalid", "ultra", "valid values", "burstable"],
        expected_not_contains=[],
    ),

    AgentTestCase(
        name="crossplane_no_resources_found_empty",
        description="When no Crossplane resources exist, should report that",
        query="Are there any failing Crossplane resources?",
        command_history=[
            {"command": "kubectl get managed -A", "output": "No resources found"}
        ],
        expected_action="respond",
        expected_contains=["no", "none", "not found"],
        expected_not_contains=["delegate", "describe", "error"],
    ),

    AgentTestCase(
        name="crossplane_find_only_synced_false",
        description="Filter Crossplane resources to only show SYNCED=False",
        query="Show me only the Crossplane resources that are not synced",
        command_history=[
            {"command": "kubectl get managed -A | grep False", "output": """asrobots-sauipathspzjz                                  False    True    asrobots-sauipathspzjz
du-documentmanager-service-accountuipathj22rc           False    True    du-documentmanager-service-accountuipathj22rc
aicenter-jobsuipathp2s4l                                False    True    aicenter-jobsuipathp2s4l"""}
        ],
        expected_action="respond",
        expected_contains=["asrobots", "du-documentmanager", "aicenter"],
        expected_not_contains=["delegate"],
    ),

    # ========================================================================
    # BATCH EXECUTION TESTS
    # ========================================================================

    AgentTestCase(
        name="batch_execution_initial_discovery",
        description="Initial vague query should suggest batch execution",
        query="Check cluster health",
        command_history=[],
        expected_action="delegate",
        expected_contains=["kubectl"],  # At minimum should delegate some discovery
        expected_not_contains=[],
    ),

    AgentTestCase(
        name="crossplane_discovery_should_batch",
        description="Crossplane discovery should suggest multiple commands in plan",
        query="Find all Crossplane resources in the cluster",
        command_history=[],
        expected_action="delegate",
        expected_contains=["crossplane"],
        expected_not_contains=[],
    ),

    # ========================================================================
    # COMPLEX MULTI-NAMESPACE SCENARIOS
    # ========================================================================

    AgentTestCase(
        name="multi_namespace_crossplane_mixed_states",
        description="Crossplane resources across multiple namespaces with different states",
        query="What's the overall state of Crossplane resources?",
        command_history=[
            {"command": "kubectl get managed -A", "output": """NAMESPACE    NAME                           SYNCED   READY
prod         db-primary                     True     True
prod         storage-main                   False    True
staging      db-test                        True     True
staging      storage-test                   False    False
dev          db-dev                         True     True"""}
        ],
        expected_action="respond",
        expected_contains=["storage-main", "storage-test", "false"],
        expected_not_contains=[],
    ),

    AgentTestCase(
        name="controller_pod_crashloop_then_logs",
        description="Controller pod crashing should get logs to find root cause",
        query="Why is the Crossplane Azure provider controller crashing?",
        command_history=[
            {"command": "kubectl get pods -n crossplane-system | grep azure", "output": "crossplane-provider-azure-abc123   0/1   CrashLoopBackOff   5   3m"}
        ],
        expected_action="delegate",
        expected_contains=["logs", "crossplane-provider-azure"],
        expected_not_contains=["respond"],
    ),

    AgentTestCase(
        name="leader_election_timeout_api_server",
        description="Leader election timeout indicates API server connectivity issue",
        query="Check logs in controller pod as-operator",
        command_history=[
            {"command": "kubectl get pods -A | grep as-operator", "output": "as-air-cluster-system   as-operator-controller-manager-c5c4d96f5-tm6zt   2/2   Running   1   34h"},
            {"command": "kubectl logs as-operator-controller-manager-c5c4d96f5-tm6zt -n as-air-cluster-system --tail=100", "output": """2025-12-11T22:31:27.383Z INFO setup Checking webhook configuration
E1212 06:19:01.053880 1 leaderelection.go:441] Failed to update lock: Put "https://10.0.71.135:443/apis/coordination.k8s.io/v1/namespaces/as-air-cluster-system/leases/0be38bc9.uipath.com?timeout=5s": context deadline exceeded, falling back to slow path"""}
        ],
        expected_action="respond",
        expected_contains=["deadline exceeded", "api server", "timeout", "connectivity"],
        expected_not_contains=[],
    ),

    # ========================================================================
    # UNIVERSAL CRD DEBUGGING PATTERN - CustomerCluster Investigation
    # ========================================================================

    AgentTestCase(
        name="customercluster_failing_filter_with_grep",
        description="Find failing CustomerClusters using grep to filter ASFailed state",
        query="why are customerclusters failing in this cluster",
        command_history=[
            {"command": "kubectl get customercluster -A", "output": """NAMESPACE      NAME                STATE        AGE
production     customer-prod-1     ASReady      10d
production     customer-prod-2     ASReady      8d
staging        customer-stage-1    ASFailed     5d
staging        customer-stage-2    ASReady      3d
dev            customer-dev-1      ASFailed     2d"""},
            {"command": "kubectl get customercluster -A | grep ASFailed", "output": """staging        customer-stage-1    ASFailed     5d
dev            customer-dev-1      ASFailed     2d"""}
        ],
        expected_action="delegate",
        expected_contains=["jsonpath", "status", "customer-stage-1"],  # Should extract status.message next
        expected_not_contains=["respond", "events", "logs"],  # Should NOT skip to events/logs yet
    ),

    AgentTestCase(
        name="customercluster_asfailed_extract_status_jsonpath",
        description="CRITICAL: Extract status.message using jsonpath when CustomerCluster in ASFailed (universal pattern step 1)",
        query="why is customer-stage-1 in ASFailed state",
        command_history=[
            {"command": "kubectl get customercluster -A | grep customer-stage-1", "output": "staging        customer-stage-1    ASFailed     5d"},
            {"command": "kubectl get customercluster customer-stage-1 -n staging -o jsonpath='{.status.message}'", "output": "Azure quota exceeded: Cannot create AKS cluster in region eastus. Current vCPU quota: 100, Requested: 16, Available: 8. Request quota increase at https://portal.azure.com"}
        ],
        expected_action="respond",
        expected_contains=["quota", "exceeded", "vcpu", "100", "eastus"],
        expected_not_contains=["delegate", "events", "controller logs"],  # Found root cause in status, no need for events/logs
    ),

    AgentTestCase(
        name="customercluster_asfailed_truncated_describe_needs_yaml",
        description="CRITICAL: When kubectl describe is truncated, use yaml/jsonpath to extract full status (the looping bug!)",
        query="why is customercluster customer-prod-3 in ASFailed state",
        command_history=[
            {"command": "kubectl get customercluster customer-prod-3 -n production", "output": "NAME              STATE      AGE\ncustomer-prod-3   ASFailed   1h"},
            {"command": "kubectl describe customercluster customer-prod-3 -n production", "output": """Name:         customer-prod-3
Namespace:    production
API Version:  dedicated.uipath.com/v1
Kind:         CustomerCluster
Status:
  Current State: ASFailed
  Conditions:
    ... (507 healthy resources omitted) ..."""}
        ],
        expected_action="delegate",
        expected_contains=["jsonpath", "status", "-o yaml"],  # Should recognize truncation and use jsonpath/yaml
        expected_not_contains=["respond", "events", "pods"],  # Should NOT skip to events yet
    ),

    AgentTestCase(
        name="customercluster_multiple_failing_investigate_first",
        description="When multiple CustomerClusters failing, investigate first one using status extraction",
        query="why are customerclusters failing",
        command_history=[
            {"command": "kubectl get customercluster -A", "output": """NAMESPACE      NAME                STATE        AGE
staging        customer-stage-1    ASFailed     5d
staging        customer-stage-2    ASFailed     3d
dev            customer-dev-1      ASReady      2d"""},
            {"command": "kubectl get customercluster customer-stage-1 -n staging -o jsonpath='{.status.message}'", "output": "RBAC authorization failed: Service principal 'sp-crossplane-prod' does not have 'Microsoft.Network/virtualNetworks/write' permission on resource group 'rg-staging-eastus'"}
        ],
        expected_action="respond",
        expected_contains=["rbac", "permission", "service principal", "virtualnetworks/write"],
        expected_not_contains=["delegate"],  # Found root cause, should respond
    ),

    AgentTestCase(
        name="customercluster_status_empty_then_check_events",
        description="Universal pattern step 4: Only check events if status.message is empty",
        query="why is customercluster customer-new failing",
        command_history=[
            {"command": "kubectl get customercluster customer-new -n dev", "output": "NAME           STATE      AGE\ncustomer-new   ASFailed   5m"},
            {"command": "kubectl get customercluster customer-new -n dev -o jsonpath='{.status.message}'", "output": ""},
            {"command": "kubectl get customercluster customer-new -n dev -o yaml | grep -A30 'status:'", "output": """status:
  currentState: ASFailed
  message: ""
  conditions: []"""}
        ],
        expected_action="delegate",
        expected_contains=["events", "involvedObject.name=customer-new"],  # Status empty, now check events
        expected_not_contains=["logs", "controller"],  # Don't skip to logs yet
    ),

    AgentTestCase(
        name="customercluster_events_empty_then_controller_logs",
        description="Universal pattern step 5: LAST RESORT - check controller logs only if status AND events both empty",
        query="why is customercluster customer-broken failing",
        command_history=[
            {"command": "kubectl get customercluster customer-broken -n dev", "output": "NAME              STATE      AGE\ncustomer-broken   ASFailed   2m"},
            {"command": "kubectl get customercluster customer-broken -n dev -o jsonpath='{.status.message}'", "output": ""},
            {"command": "kubectl get events -n dev --field-selector involvedObject.name=customer-broken", "output": "No events found"}
        ],
        expected_action="delegate",
        expected_contains=["logs", "controller-manager", "customercluster"],  # Status + events empty, check controller logs as last resort
        expected_not_contains=["respond"],
    ),
]

# =============================================================================
# TEST RUNNER
# =============================================================================

async def run_supervisor_test(test: AgentTestCase) -> AgentTestResult:
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
        return AgentTestResult(
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
        return AgentTestResult(
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

    return AgentTestResult(
        test_name=test.name,
        passed=passed,
        actual_action=actual_action,
        actual_response=response[:500],
        errors=errors,
        duration_ms=(time.time() - start) * 1000
    )

async def run_worker_test(plan: str, expected_command_pattern: str) -> AgentTestResult:
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
        return AgentTestResult(
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
        return AgentTestResult(
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

    return AgentTestResult(
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
async def test_supervisor(test_case: AgentTestCase):
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
