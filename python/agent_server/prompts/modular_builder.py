"""
Modular Prompt Builder - Token Optimization

This module dynamically assembles system prompts based on query content,
reducing token usage by 40-60% compared to the monolithic approach.

Instead of sending the full 15-20k token prompt every time, we only include
relevant modules based on query classification.
"""

import re
from typing import Set, List, Optional

# ============================================================================
# QUERY CLASSIFIER
# ============================================================================

def classify_query(query: str) -> Set[str]:
    """
    Classify a query to determine which prompt modules are needed.

    Returns a set of module names that should be included.
    This is the key to token savings - we only include what's needed.
    """
    query_lower = query.lower()
    modules = {"core"}  # Always include core identity

    # Greeting detection - minimal prompt needed
    greetings = ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening']
    if any(g in query_lower for g in greetings) and len(query.split()) <= 5:
        return {"greeting"}  # Ultra-minimal prompt

    # Off-topic detection
    off_topic_signals = ['weather', 'poem', 'joke', 'recipe', 'movie', 'music', 'song']
    if any(s in query_lower for s in off_topic_signals):
        return {"off_topic"}  # Minimal polite decline

    # Kubernetes operations
    k8s_signals = [
        'pod', 'pods', 'deploy', 'deployment', 'service', 'svc', 'namespace', 'ns',
        'node', 'nodes', 'kubectl', 'kubernetes', 'k8s', 'cluster',
        'replicaset', 'statefulset', 'daemonset', 'job', 'cronjob',
        'configmap', 'secret', 'pvc', 'pv', 'ingress', 'networkpolicy',
        'hpa', 'vpa', 'resource', 'container', 'image', 'replica',
        'crash', 'crashloop', 'oomkill', 'pending', 'failing', 'unhealthy',
        'logs', 'events', 'describe', 'status'
    ]
    if any(s in query_lower for s in k8s_signals):
        modules.add("kubectl")

    # Azure/Crossplane operations
    azure_signals = [
        'azure', 'crossplane', 'managed resource', 'provider', 'upbound',
        'resource group', 'vnet', 'subnet', 'storage account', 'aks',
        'keyvault', 'cosmos', 'sql server', 'postgresql', 'mysql',
        'az ', 'resourcegroups', 'virtualnetworks'
    ]
    if any(s in query_lower for s in azure_signals):
        modules.add("azure")

    # CRD/Custom Resource operations
    crd_signals = [
        'crd', 'custom resource', 'api-resources', 'apiversion',
        'argocd', 'argo', 'istio', 'velero', 'keda', 'cert-manager',
        'flux', 'external-dns', 'sealed-secret'
    ]
    if any(s in query_lower for s in crd_signals):
        modules.add("crd")

    # Helm operations
    helm_signals = ['helm', 'chart', 'release', 'values.yaml']
    if any(s in query_lower for s in helm_signals):
        modules.add("helm")

    # Debugging/troubleshooting - needs decision rules
    debug_signals = [
        'why', 'debug', 'troubleshoot', 'failing', 'error', 'crash',
        'not working', 'broken', 'investigate', 'root cause', 'fix'
    ]
    if any(s in query_lower for s in debug_signals):
        modules.add("debug")

    # Discovery queries
    discovery_signals = ['find', 'list', 'show', 'get all', 'what', 'which', 'where']
    if any(s in query_lower for s in discovery_signals):
        modules.add("discovery")

    return modules


# ============================================================================
# PROMPT MODULES (Compact versions)
# ============================================================================

CORE_PROMPT = """You are OpsPilot, an expert Kubernetes troubleshooting assistant.

STRICT READ-ONLY MODE: You can ONLY run read commands (get, describe, logs, events).
ALL mutations are FORBIDDEN - never run apply, delete, patch, edit, scale, rollout, etc.

When responding:
- Be concise and technical
- Use markdown for formatting
- Show actual data, not just summaries
- If user asks for modifications, provide the commands they should run manually
"""

GREETING_PROMPT = """You are OpsPilot, a Kubernetes assistant.

Respond to greetings warmly but briefly with a K8s-themed response.
Examples:
- "Hi there! Ready to debug some clusters?"
- "Hey! What K8s puzzle can I help with today?"
"""

OFF_TOPIC_PROMPT = """You are OpsPilot, specialized in Kubernetes troubleshooting.

Politely decline non-K8s requests with brief humor:
- "I'm more of a kubectl kind of assistant - what cluster issues can I help with?"
- Keep response to 1-2 sentences, then redirect to K8s topics.
"""

KUBECTL_RULES = """
## KUBECTL OPERATIONS

Use kubectl for cluster investigation:
- `kubectl get <resource> -A` - List across namespaces
- `kubectl describe <resource> <name> -n <ns>` - Detailed info
- `kubectl logs <pod> -n <ns> --tail=100` - Container logs
- `kubectl get events -n <ns> --sort-by='.lastTimestamp'` - Recent events

Always include `--context=<context>` for multi-cluster environments.

READ-ONLY: Only get, describe, logs, events, explain, api-resources, top are allowed.
"""

AZURE_CROSSPLANE_RULES = """
## AZURE & CROSSPLANE

Crossplane manages Azure resources as Kubernetes CRDs.

Key resource types:
- `resourcegroups.azure.upbound.io`
- `virtualnetworks.network.azure.upbound.io`
- `accounts.storage.azure.upbound.io`
- `managedclusters.containerservice.azure.upbound.io` (AKS)

Check Crossplane status:
- `kubectl get providers` - List installed providers
- `kubectl get managed -A` - All managed resources
- Check `status.conditions` for sync/ready state

Azure CLI allowed (read-only): `az <resource> show/list`
Azure CLI forbidden: create, delete, update, set, add, remove
"""

CRD_RULES = """
## CRD/CUSTOM RESOURCES

For custom resources:
1. `kubectl get crd | grep <name>` - Find the CRD
2. `kubectl get <crd-name> -A` - List instances
3. Check `status.conditions` for health

Common CNCF CRDs:
- ArgoCD: applications.argoproj.io
- Istio: virtualservices.networking.istio.io
- Cert-Manager: certificates.cert-manager.io
"""

HELM_RULES = """
## HELM OPERATIONS

Read-only helm commands:
- `helm list -A` - List releases
- `helm status <release> -n <ns>` - Release status
- `helm get values <release> -n <ns>` - Current values
- `helm history <release> -n <ns>` - Revision history

FORBIDDEN: helm install, upgrade, uninstall, rollback
"""

DEBUG_RULES = """
## DEBUGGING APPROACH

For troubleshooting:
1. Form a hypothesis (e.g., "Pod crashing due to OOM")
2. Gather evidence (logs, events, describe)
3. Confirm or refute hypothesis
4. Identify root cause

Common patterns:
- CrashLoopBackOff: Check logs for error, exit code 137=OOM
- ImagePullBackOff: Auth issue or image not found
- Pending: Resource constraints or scheduling issues
- FailedScheduling: Check node resources/taints
"""

DISCOVERY_RULES = """
## RESOURCE DISCOVERY

For finding resources efficiently:
- Use grep/awk for filtering: `kubectl get pods -A | grep <name>`
- Check api-resources first: `kubectl api-resources | grep -i <type>`
- Don't fetch all JSON then filter - use shell pipes

If resource not found with one method, try alternatives before concluding "not found".
"""

# ============================================================================
# PROMPT BUILDER
# ============================================================================

def build_system_prompt(
    query: str,
    kb_context: str = "",
    examples: str = "",
    include_full_instructions: bool = False
) -> str:
    """
    Build a minimal system prompt based on query classification.

    Args:
        query: User's query
        kb_context: Knowledge base context (if any)
        examples: Few-shot examples (if any)
        include_full_instructions: If True, include full instructions (for complex queries)

    Returns:
        Assembled system prompt with only necessary modules
    """
    modules = classify_query(query)

    # Special handling for greetings/off-topic (minimal prompts)
    if "greeting" in modules:
        return GREETING_PROMPT
    if "off_topic" in modules:
        return OFF_TOPIC_PROMPT

    # Build modular prompt
    parts = [CORE_PROMPT]

    # Add relevant modules
    if "kubectl" in modules:
        parts.append(KUBECTL_RULES)

    if "azure" in modules:
        parts.append(AZURE_CROSSPLANE_RULES)

    if "crd" in modules:
        parts.append(CRD_RULES)

    if "helm" in modules:
        parts.append(HELM_RULES)

    if "debug" in modules:
        parts.append(DEBUG_RULES)

    if "discovery" in modules:
        parts.append(DISCOVERY_RULES)

    # Add KB context if provided (already truncated by kb_search)
    if kb_context and kb_context.strip():
        parts.append(f"\n## KNOWLEDGE BASE CONTEXT\n{kb_context}")

    # Add examples if provided (limit to 2-3 relevant examples)
    if examples and include_full_instructions:
        parts.append(f"\n## EXAMPLES\n{examples[:3000]}")  # Truncate examples

    return "\n\n".join(parts)


def get_prompt_stats(query: str) -> dict:
    """
    Get statistics about prompt size for debugging/monitoring.

    Returns dict with module count, estimated tokens, etc.
    """
    modules = classify_query(query)
    prompt = build_system_prompt(query)

    # Rough token estimate: ~4 chars per token
    estimated_tokens = len(prompt) // 4

    return {
        "modules": list(modules),
        "module_count": len(modules),
        "prompt_chars": len(prompt),
        "estimated_tokens": estimated_tokens,
        "is_minimal": len(modules) <= 2
    }
