"""
Progressive Discovery Strategies - Multi-method fallback for resource discovery

When one discovery method fails, automatically tries alternatives.
This prevents the agent from giving up too early.
"""

from typing import List, Dict, Optional


class DiscoveryStrategy:
    """Represents a single discovery approach"""
    def __init__(self, name: str, description: str, commands: List[str], confidence: float = 1.0):
        self.name = name
        self.description = description
        self.commands = commands
        self.confidence = confidence  # How likely this is to work


def get_progressive_discovery_strategies(resource_name: str, query_context: str = "") -> List[DiscoveryStrategy]:
    """
    Generate progressive discovery strategies for a resource.

    Returns strategies ordered from most specific to most broad.
    Try them in order until one succeeds.

    Args:
        resource_name: The resource to find (e.g., "vcluster", "argocd", "storage account")
        query_context: Additional context from user query

    Returns:
        List of DiscoveryStrategy objects to try in order
    """

    strategies = []

    # Clean resource name
    clean_name = resource_name.lower().strip()

    # For CRDs (e.g., eventhubs.azure.upbound.io), extract the short kubectl name
    # Kubectl uses the first part before the dot as the resource short name
    short_name = clean_name
    if '.' in clean_name and len(clean_name.split('.')) >= 3:  # Looks like a CRD
        # Extract short name (first part) for kubectl commands
        short_name = clean_name.split('.')[0]
        print(f"[discovery_strategies] Detected CRD '{clean_name}', using short name '{short_name}' for kubectl", flush=True)

    # Strategy 1: Direct kubectl get (most efficient for CRDs)
    strategies.append(DiscoveryStrategy(
        name="direct_get",
        description=f"Try direct kubectl get for '{short_name}'",
        commands=[
            f"kubectl get {short_name} -A 2>/dev/null"
        ],
        confidence=0.95
    ))

    # Strategy 2: Exact CRD/API resource check
    strategies.append(DiscoveryStrategy(
        name="exact_api",
        description=f"Check if '{short_name}' is a known API resource",
        commands=[
            f"kubectl api-resources | grep -i '^{short_name}'",
            f"kubectl get crd | grep -i '{short_name}'"
        ],
        confidence=0.9
    ))

    # Strategy 3: Partial API resource match
    strategies.append(DiscoveryStrategy(
        name="partial_api",
        description=f"Search for API resources containing '{short_name}'",
        commands=[
            f"kubectl api-resources | grep -i {short_name}",
            f"kubectl get crd | grep -i {short_name}"
        ],
        confidence=0.8
    ))

    # Strategy 4: Label-based discovery
    strategies.append(DiscoveryStrategy(
        name="label_search",
        description=f"Find resources by label matching '{short_name}'",
        commands=[
            f"kubectl get all -A -l 'app.kubernetes.io/name={short_name}' 2>/dev/null",
            f"kubectl get all -A -l 'app={short_name}' 2>/dev/null",
            f"kubectl get pods -A -l 'app.kubernetes.io/name' -o json | jq '.items[] | select(.metadata.labels[\"app.kubernetes.io/name\"] | contains(\"{short_name}\"))'  2>/dev/null"
        ],
        confidence=0.7
    ))

    # Strategy 5: Namespace pattern search
    strategies.append(DiscoveryStrategy(
        name="namespace_search",
        description=f"Check if '{short_name}' exists as a namespace or in namespace names",
        commands=[
            f"kubectl get ns | grep -i {short_name}",
            f"kubectl get all -n {short_name} 2>/dev/null",
            f"kubectl get all --all-namespaces | grep -i {short_name}"
        ],
        confidence=0.6
    ))

    # Strategy 6: Pod/workload name grep
    strategies.append(DiscoveryStrategy(
        name="workload_grep",
        description=f"Search all workloads for '{short_name}' in names",
        commands=[
            f"kubectl get pods,deployments,statefulsets,daemonsets -A | grep -i {short_name}",
            f"kubectl get all -A | grep -i {short_name}"
        ],
        confidence=0.8
    ))

    # Strategy 7: Image/container search
    strategies.append(DiscoveryStrategy(
        name="image_search",
        description=f"Find pods using images containing '{short_name}'",
        commands=[
            f"kubectl get pods -A -o json | jq '.items[] | select(.spec.containers[].image | contains(\"{short_name}\")) | {{name: .metadata.name, namespace: .metadata.namespace, image: .spec.containers[].image}}' 2>/dev/null"
        ],
        confidence=0.5
    ))

    # Strategy 8: Helm release search
    strategies.append(DiscoveryStrategy(
        name="helm_search",
        description=f"Check if '{short_name}' is a Helm release",
        commands=[
            f"helm list -A | grep -i {short_name} 2>/dev/null",
            f"kubectl get secrets -A -l 'owner=helm' -o json | jq '.items[] | select(.metadata.name | contains(\"{short_name}\"))' 2>/dev/null"
        ],
        confidence=0.6
    ))

    # Strategy 9: Service/Ingress search
    strategies.append(DiscoveryStrategy(
        name="network_search",
        description=f"Find services/ingresses matching '{short_name}'",
        commands=[
            f"kubectl get svc,ingress -A | grep -i {short_name}",
            f"kubectl get endpoints -A | grep -i {short_name}"
        ],
        confidence=0.5
    ))

    # Strategy 10: ConfigMap/Secret search (for config-based resources)
    if any(word in query_context.lower() for word in ['config', 'secret', 'certificate', 'credential']):
        strategies.append(DiscoveryStrategy(
            name="config_search",
            description=f"Search ConfigMaps/Secrets for '{short_name}'",
            commands=[
                f"kubectl get cm,secret -A | grep -i {short_name}",
                f"kubectl get cm -A -o json | jq '.items[] | select(.metadata.name | contains(\"{short_name}\"))' 2>/dev/null"
            ],
            confidence=0.7
        ))

    # Strategy 11: Annotation-based search (last resort)
    strategies.append(DiscoveryStrategy(
        name="annotation_search",
        description=f"Search all resources by annotations containing '{short_name}'",
        commands=[
            f"kubectl get all -A -o json | jq '.items[] | select(.metadata.annotations | to_entries | .[] | .value | contains(\"{short_name}\"))' 2>/dev/null"
        ],
        confidence=0.3
    ))

    return strategies


def get_azure_discovery_strategies() -> List[DiscoveryStrategy]:
    """
    Specialized strategies for discovering Azure/Crossplane resources.

    These are more comprehensive than generic discovery.
    """
    return [
        DiscoveryStrategy(
            name="azure_api_grep",
            description="Find all Azure CRD types",
            commands=[
                "kubectl api-resources | grep -i azure",
                "kubectl get crd | grep -i azure"
            ],
            confidence=0.95
        ),
        DiscoveryStrategy(
            name="azure_bulk_get",
            description="Iterate through all Azure resource types",
            commands=[
                "for TYPE in $(kubectl api-resources | grep -i azure | awk '{print $1}'); do echo \"=== $TYPE ===\"; kubectl get $TYPE -A 2>/dev/null | head -20; done"
            ],
            confidence=0.9
        ),
        DiscoveryStrategy(
            name="crossplane_managed",
            description="Use Crossplane's managed resource shortcuts",
            commands=[
                "kubectl get managed -A 2>/dev/null",
                "kubectl get composite -A 2>/dev/null",
                "kubectl get claim -A 2>/dev/null"
            ],
            confidence=0.8
        ),
        DiscoveryStrategy(
            name="provider_config",
            description="Find Azure provider configs",
            commands=[
                "kubectl get providerconfig -A | grep -i azure 2>/dev/null",
                "kubectl get providers -A 2>/dev/null"
            ],
            confidence=0.7
        ),
        DiscoveryStrategy(
            name="upbound_namespace",
            description="Check upbound-system namespace for Azure resources",
            commands=[
                "kubectl get all -n upbound-system",
                "kubectl get all -n crossplane-system | grep -i azure"
            ],
            confidence=0.6
        )
    ]


def should_try_next_strategy(current_output: str, current_strategy: DiscoveryStrategy) -> bool:
    """
    Determine if we should try the next discovery strategy.

    Args:
        current_output: Output from current strategy
        current_strategy: The strategy that was just attempted

    Returns:
        True if should try next strategy (current one failed/empty)
    """

    # Empty output
    if not current_output or len(current_output.strip()) < 5:
        return True

    # Common error indicators
    error_indicators = [
        'NotFound',
        'No resources found',
        'error:',
        'the server doesn\'t have a resource type',
        'unknown',
        'not found',
        'forbidden',
        'Unable to connect'
    ]

    output_lower = current_output.lower()
    if any(indicator.lower() in output_lower for indicator in error_indicators):
        return True

    # Success indicators
    success_indicators = [
        'NAME',  # kubectl output header
        'NAMESPACE',
        'STATUS',
        '/'  # Resource format like "pod/xxx"
    ]

    if any(indicator in current_output for indicator in success_indicators):
        # Has header/data - success
        return False

    return False  # Assume success if no clear error
