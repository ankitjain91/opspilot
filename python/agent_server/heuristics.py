
import re
from typing import List, Tuple, Optional
from .config import TYPO_CORRECTIONS

# Native AI Refactor: Removed autocorrect_query
# LLMs are robust to typos; we don't need brittle dictionary lookups.

# Query expansion for better KB retrieval
SYNONYM_MAP = {
    # Resource synonyms
    'pod': ['pods', 'po', 'container'],
    'deployment': ['deployments', 'deploy', 'app'],
    'service': ['services', 'svc', 'endpoint'],
    'node': ['nodes', 'worker', 'machine'],
    'namespace': ['namespaces', 'ns', 'project'],

    # State synonyms
    'crashloop': ['crashloopbackoff', 'crashing', 'restarting', 'crash loop'],
    'pending': ['not ready', 'waiting', 'stuck'],
    'failing': ['failed', 'broken', 'unhealthy', 'down'],
    'error': ['errors', 'erroring', 'failure'],

    # Action synonyms
    'troubleshoot': ['debug', 'diagnose', 'investigate', 'analyze', 'fix'],
    'find': ['search', 'locate', 'discover', 'show', 'list'],
    'check': ['verify', 'inspect', 'examine', 'review'],

    # Technology synonyms
    'crossplane': ['xp', 'composition', 'managed resource', 'claim'],
    'postgres': ['postgresql', 'pg', 'database'],
    'cert-manager': ['cert manager', 'certificate', 'tls', 'ssl'],
}

def try_pluralization_variants(word: str) -> List[str]:
    """Generate plural/singular variants for K8s resource names.

    Handles common English pluralization rules to match CRD names.

    Examples:
        "customerclusters" -> ["customerclusters", "customercluster"]
        "databases" -> ["databases", "database"]
        "policies" -> ["policies", "policy"]
        "vcluster" -> ["vcluster", "vclusters"]
    """
    variants = [word]

    # Skip words unlikely to be resources (too short or common words)
    if len(word) < 4 or word in ['kubernetes', 'the', 'what', 'how', 'why', 'this', 'that', 'these', 'those']:
        return variants

    # Handle plural -> singular
    if word.endswith('ses') and len(word) > 5:  # "databases" -> "database"
        variants.append(word[:-2])
    elif word.endswith('ies') and len(word) > 5:  # "policies" -> "policy"
        variants.append(word[:-3] + 'y')
    elif word.endswith('s') and not word.endswith(('ss', 'us')):  # "clusters" -> "cluster"
        # Avoid false positives like "status" -> "statu"
        variants.append(word[:-1])

    # Handle singular -> plural (if not already plural)
    if not word.endswith('s'):
        if word.endswith('y') and len(word) > 3 and word[-2] not in 'aeiou':  # "policy" -> "policies"
            variants.append(word[:-1] + 'ies')
        elif word.endswith(('s', 'x', 'z', 'ch', 'sh')):  # "address" -> "addresses"
            variants.append(word + 'es')
        else:  # "cluster" -> "clusters"
            variants.append(word + 's')

    return list(set(variants))

def expand_query(query: str) -> List[str]:
    """
    Expand query with synonyms and pluralization for better KB retrieval.

    Returns list of query variants (original + expansions).

    Example:
        Input: "list customerclusters"
        Output: ["list customerclusters", "list customercluster", "find customerclusters", ...]
    """
    query_lower = query.lower()
    variants = [query]  # Always include original

    # Find matching keywords and generate variants
    for canonical, synonyms in SYNONYM_MAP.items():
        # Check if canonical term is in query
        if canonical in query_lower:
            # Generate variant for each synonym
            for syn in synonyms:
                variant = query_lower.replace(canonical, syn)
                if variant != query_lower:
                    variants.append(variant)

        # Also check reverse: if synonym is in query, add canonical
        for syn in synonyms:
            if syn in query_lower:
                variant = query_lower.replace(syn, canonical)
                if variant != query_lower and variant not in variants:
                    variants.append(variant)
                # Add other synonyms too
                for other_syn in synonyms:
                    if other_syn != syn:
                        variant2 = query_lower.replace(syn, other_syn)
                        if variant2 != query_lower and variant2 not in variants:
                            variants.append(variant2)

    # Add pluralization variants for potential resource names
    # Split query into words and try pluralization on each significant word
    words = query_lower.split()
    for i, word in enumerate(words):
        plural_variants = try_pluralization_variants(word)
        if len(plural_variants) > 1:  # If we got variants beyond the original
            for variant_word in plural_variants:
                if variant_word != word:
                    # Replace this word in the query
                    new_words = words.copy()
                    new_words[i] = variant_word
                    variant = ' '.join(new_words)
                    if variant not in variants:
                        variants.append(variant)

    # Deduplicate and limit to top 8 most diverse variants (increased from 5 to accommodate pluralization)
    variants = list(dict.fromkeys(variants))  # Preserve order, remove duplicates
    return variants[:8]

def normalize_query(query: str) -> tuple[str, str | None]:
    """Minimal query normalization - let the LLM handle natural language variations.

    Only normalize the most obvious terse queries to help classification.
    The REFLECT prompt should handle the rest via better instructions.

    Returns (normalized_query, normalization_note)
    """
    if not query:  # Safety: handle None or empty string
        return '', None

    q_lower = query.lower().strip()

    # Handle terse "adjective + noun" queries (no verb) - these are implicit "find" queries
    # Examples: "crashlooping pods", "failing deployments", "broken services"
    terse_pattern = r'^(crashloop(?:ing|backoff)?|crash|failing|broken|unhealthy|down|erroring|error)\s+(.+)$'
    match = re.match(terse_pattern, q_lower, re.IGNORECASE)
    if match:
        state = match.group(1)
        resource = match.group(2)
        normalized = f"find {state} {resource}"
        return normalized, f"Normalized terse query '{query}' -> 'find {state} {resource}'"

    # No normalization - let the LLM use its reasoning
    return query, None

def get_examples_text(selected_ids: list[str], examples_text: str) -> str:
    """Extract specific examples from the full few-shot string based on IDs."""
    if not selected_ids:
        return ""
        
    examples = []
    # This is a simple regex-based extractor assuming format "# Example X"
    for ex_id in selected_ids:
        # Match from "# Example ID" to the next "# Example" or end of string
        pattern = rf'(# Example {re.escape(ex_id)}\b.*?)(?=\n# Example|\Z)'
        match = re.search(pattern, examples_text, re.DOTALL)
        if match:
            # Add a bit of space between examples
            examples.append(match.group(1).strip())
        else:
            # Fallback if specific ID not found (shouldn't happen if configured correctly)
            pass
            
    return "\n\n".join(examples)

# =============================================================================
# DYNAMIC EXAMPLE SELECTION
# =============================================================================

EXAMPLE_CATEGORIES = {
    "core": {
        "keywords": [],
        "examples": ["1", "2", "3", "4", "5", "6", "7", "8", "8e", "8f", "8g"],
    },
    "crossplane": {
        "keywords": ["crossplane", "composition", "xrd", "provider", "managed resource", "managed", "claim", "synced", "healthy", "customercluster", "custom resource", "reconcile", "paused", "azure", "aws", "gcp", "database", "postgres", "mysql", "redis", "cosmos", "roleassignment", "ready"],
        "examples": ["9", "9b", "9c", "10", "10b", "10c", "10d", "10e", "10f", "10g", "10h", "10i", "10j"],
    },
    "cert_manager": {
        "keywords": ["cert", "certificate", "tls", "ssl", "issuer", "letsencrypt", "acme"],
        "examples": ["15"],
    },
    "argocd": {
        "keywords": ["argo", "argocd", "gitops", "sync", "application"],
        "examples": ["16", "30"],
    },
    "prometheus": {
        "keywords": ["prometheus", "servicemonitor", "podmonitor", "alertmanager", "metrics", "scrape", "monitoring"],
        "examples": ["18", "18b"],
    },
    "velero": {
        "keywords": ["velero", "backup", "restore", "disaster recovery", "dr"],
        "examples": ["19", "19b"],
    },
    "keda": {
        "keywords": ["keda", "autoscal", "scaledobject", "scaledjob", "trigger"],
        "examples": ["20", "20b"],
    },
    "flux": {
        "keywords": ["flux", "gitrepository", "kustomization", "helmrelease", "gitops"],
        "examples": ["21", "21b"],
    },
    "external_secrets": {
        "keywords": ["external secret", "secretstore", "vault", "aws secret"],
        "examples": ["22", "22b"],
    },
    "sealed_secrets": {
        "keywords": ["sealed secret", "bitnami", "kubeseal"],
        "examples": ["23"],
    },
    "cilium": {
        "keywords": ["cilium", "network policy", "cnp", "hubble"],
        "examples": ["24"],
    },
    "knative": {
        "keywords": ["knative", "serverless", "ksvc", "revision"],
        "examples": ["25", "25b"],
    },
    "linkerd": {
        "keywords": ["linkerd", "service mesh", "proxy", "sidecar"],
        "examples": ["26"],
    },
    "gateway_api": {
        "keywords": ["gateway api", "httproute", "grpcroute", "gateway.networking"],
        "examples": ["27"],
    },
    "cluster_api": {
        "keywords": ["cluster api", "capi", "machine", "machinedeployment", "capz", "capa"],
        "examples": ["28"],
    },
    "kafka": {
        "keywords": ["kafka", "strimzi", "kafkatopic", "kafkauser"],
        "examples": ["29"],
    },
    "istio": {
        "keywords": ["istio", "virtualservice", "destinationrule", "envoy", "service mesh"],
        "examples": ["14"],
    },
    "error_patterns": {
        "keywords": ["crashloop", "imagepull", "pending", "oom", "evict", "error", "fail", "crash", "stuck", "not ready", "backoff", "failing", "broken", "why", "troubleshoot", "debug", "investigate", "401", "403", "404", "timeout", "refused", "customercluster", "asfailed", "envfailed"],
        "examples": ["31", "32", "33", "34", "35", "36", "70"],
    },
    "relationships": {
        "keywords": ["endpoint", "service", "ingress", "503", "pvc", "pv", "hpa", "deployment", "replicaset"],
        "examples": ["37", "38", "39", "40", "41"],
    },
    "health_check": {
        "keywords": ["health", "broken", "unhealthy", "everything", "cluster", "overview"],
        "examples": ["17", "42", "43", "44"],
    },
    "quantitative": {
        "keywords": ["restart", "count", "how many", "utilization", "resource", "cpu", "memory", "top", "hot"],
        "examples": ["47", "48", "49", "50"],
    },
    "network": {
        "keywords": ["dns", "network", "connect", "reach", "policy", "rbac", "permission"],
        "examples": ["51", "53", "54"],
    },
    "admission": {
        "keywords": ["webhook", "reject", "denied", "admission", "validating", "mutating"],
        "examples": ["55"],
    },
    "grep_search": {
        "keywords": ["find", "search", "where", "which", "locate", "grep", "filter", "show me", "list all", "count", "how many", "unhealthy", "not running", "errors in", "logs", "discover", "all", "resources"],
        "examples": ["56", "57", "58", "59", "60", "61"],
    },
    "discovery": {
        "keywords": ["api-resources", "crd", "custom resource definition", "what resources", "available", "types", "kinds"],
        "examples": ["9", "10e", "10i"],
    },
}

def select_relevant_examples(query: str, max_examples: int = 15) -> list[str]:
    """Select the most relevant example numbers based on query keywords."""
    query_lower = query.lower()
    selected = set()

    # Always include core examples (but respect max limit)
    core_examples = EXAMPLE_CATEGORIES["core"]["examples"]
    for ex in core_examples:
        if len(selected) >= max_examples:
            break
        selected.add(ex)

    category_scores = []
    for cat_name, cat_data in EXAMPLE_CATEGORIES.items():
        if cat_name == "core":
            continue
        score = sum(1 for kw in cat_data["keywords"] if kw in query_lower)
        if score > 0:
            category_scores.append((score, cat_name, cat_data["examples"]))

    category_scores.sort(reverse=True, key=lambda x: x[0])

    # Add examples one by one to respect max limit
    for score, cat_name, examples in category_scores:
        for ex in examples:
            if len(selected) >= max_examples:
                break
            selected.add(ex)
        if len(selected) >= max_examples:
            break

    return sorted(list(selected))
