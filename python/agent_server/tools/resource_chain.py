"""
Resource Chain Traversal - Automatic K8s resource relationship discovery.

This module provides functions to traverse Kubernetes resource relationships:
- UP: Pod → ReplicaSet → Deployment (owner references)
- DOWN: Deployment → ReplicaSets → Pods (owned resources)
- LATERAL: ConfigMaps, Secrets, PVCs used by a resource

Use Cases:
1. "Why is this pod failing?" → Trace up to Deployment, check events at each level
2. "What's wrong with this deployment?" → Trace down to pods, find the failing one
3. "What resources does this pod use?" → Find ConfigMaps, Secrets, PVCs
"""

from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field
from kubernetes import client
import json


@dataclass
class ResourceRef:
    """Reference to a Kubernetes resource."""
    kind: str
    name: str
    namespace: str = ""
    api_version: str = ""

    def __str__(self) -> str:
        if self.namespace:
            return f"{self.kind}/{self.name} (ns: {self.namespace})"
        return f"{self.kind}/{self.name}"

    def to_dict(self) -> Dict:
        return {
            "kind": self.kind,
            "name": self.name,
            "namespace": self.namespace,
            "api_version": self.api_version
        }


@dataclass
class ResourceChain:
    """Complete resource relationship chain."""
    root: ResourceRef
    owners: List[ResourceRef] = field(default_factory=list)  # Parent chain (up)
    children: List[ResourceRef] = field(default_factory=list)  # Owned resources (down)
    related: List[ResourceRef] = field(default_factory=list)  # ConfigMaps, Secrets, PVCs
    events: List[Dict] = field(default_factory=list)  # Warning events for any resource in chain

    def to_dict(self) -> Dict:
        return {
            "root": self.root.to_dict(),
            "owners": [o.to_dict() for o in self.owners],
            "children": [c.to_dict() for c in self.children],
            "related": [r.to_dict() for r in self.related],
            "events": self.events
        }

    def summary(self) -> str:
        """Human-readable summary of the chain."""
        lines = [f"📍 Root: {self.root}"]

        if self.owners:
            lines.append("⬆️ Owner Chain:")
            for i, owner in enumerate(self.owners):
                lines.append(f"  {'└─' if i == len(self.owners)-1 else '├─'} {owner}")

        if self.children:
            lines.append("⬇️ Owned Resources:")
            for child in self.children[:10]:  # Limit display
                lines.append(f"  ├─ {child}")
            if len(self.children) > 10:
                lines.append(f"  └─ ... and {len(self.children) - 10} more")

        if self.related:
            lines.append("🔗 Related Resources:")
            for rel in self.related:
                lines.append(f"  ├─ {rel}")

        if self.events:
            lines.append(f"⚠️ {len(self.events)} Warning Events")

        return "\n".join(lines)


# =============================================================================
# OWNER CHAIN TRAVERSAL (UP)
# =============================================================================

def get_owner_chain(
    v1: client.CoreV1Api,
    apps_v1: client.AppsV1Api,
    kind: str,
    name: str,
    namespace: str
) -> List[ResourceRef]:
    """
    Trace the owner reference chain upward.

    Example: Pod → ReplicaSet → Deployment

    Returns list of owners from immediate parent to top-level owner.
    """
    owners = []
    current_kind = kind
    current_name = name
    current_namespace = namespace

    # Safety limit to prevent infinite loops
    max_depth = 10

    for _ in range(max_depth):
        owner_ref = _get_owner_reference(v1, apps_v1, current_kind, current_name, current_namespace)

        if not owner_ref:
            break

        owners.append(owner_ref)
        current_kind = owner_ref.kind
        current_name = owner_ref.name
        # Namespace stays the same for namespaced resources

    return owners


def _get_owner_reference(
    v1: client.CoreV1Api,
    apps_v1: client.AppsV1Api,
    kind: str,
    name: str,
    namespace: str
) -> Optional[ResourceRef]:
    """Get the owner reference for a resource."""
    try:
        metadata = None

        if kind.lower() == "pod":
            obj = v1.read_namespaced_pod(name, namespace)
            metadata = obj.metadata
        elif kind.lower() == "replicaset":
            obj = apps_v1.read_namespaced_replica_set(name, namespace)
            metadata = obj.metadata
        elif kind.lower() == "deployment":
            # Deployments typically don't have owners
            return None
        elif kind.lower() == "statefulset":
            obj = apps_v1.read_namespaced_stateful_set(name, namespace)
            metadata = obj.metadata
        elif kind.lower() == "daemonset":
            obj = apps_v1.read_namespaced_daemon_set(name, namespace)
            metadata = obj.metadata
        elif kind.lower() == "job":
            batch_v1 = client.BatchV1Api()
            obj = batch_v1.read_namespaced_job(name, namespace)
            metadata = obj.metadata
        else:
            return None

        if metadata and metadata.owner_references:
            owner = metadata.owner_references[0]  # Take first owner
            return ResourceRef(
                kind=owner.kind,
                name=owner.name,
                namespace=namespace,
                api_version=owner.api_version or ""
            )

        return None

    except Exception as e:
        print(f"[resource_chain] Error getting owner for {kind}/{name}: {e}")
        return None


def get_top_level_owner(
    v1: client.CoreV1Api,
    apps_v1: client.AppsV1Api,
    kind: str,
    name: str,
    namespace: str
) -> ResourceRef:
    """Get the top-level owner (e.g., Deployment for a Pod)."""
    owners = get_owner_chain(v1, apps_v1, kind, name, namespace)
    if owners:
        return owners[-1]  # Last in chain is the top-level owner
    return ResourceRef(kind=kind, name=name, namespace=namespace)


# =============================================================================
# OWNED RESOURCES TRAVERSAL (DOWN)
# =============================================================================

def get_owned_resources(
    v1: client.CoreV1Api,
    apps_v1: client.AppsV1Api,
    kind: str,
    name: str,
    namespace: str
) -> List[ResourceRef]:
    """
    Find all resources owned by this resource.

    Example: Deployment → ReplicaSets → Pods
    """
    owned = []

    try:
        if kind.lower() == "deployment":
            # Find ReplicaSets owned by this Deployment
            dep = apps_v1.read_namespaced_deployment(name, namespace)
            selector = dep.spec.selector.match_labels
            selector_str = ",".join([f"{k}={v}" for k, v in selector.items()])

            rss = apps_v1.list_namespaced_replica_set(namespace, label_selector=selector_str)
            for rs in rss.items:
                if _is_owned_by(rs.metadata, "Deployment", name):
                    owned.append(ResourceRef(
                        kind="ReplicaSet",
                        name=rs.metadata.name,
                        namespace=namespace
                    ))
                    # Also get pods for this RS
                    pods = _get_pods_for_rs(v1, rs.metadata.name, namespace)
                    owned.extend(pods)

        elif kind.lower() == "replicaset":
            owned.extend(_get_pods_for_rs(v1, name, namespace))

        elif kind.lower() == "statefulset":
            sts = apps_v1.read_namespaced_stateful_set(name, namespace)
            selector = sts.spec.selector.match_labels
            selector_str = ",".join([f"{k}={v}" for k, v in selector.items()])

            pods = v1.list_namespaced_pod(namespace, label_selector=selector_str)
            for pod in pods.items:
                if _is_owned_by(pod.metadata, "StatefulSet", name):
                    owned.append(ResourceRef(
                        kind="Pod",
                        name=pod.metadata.name,
                        namespace=namespace
                    ))

        elif kind.lower() == "daemonset":
            ds = apps_v1.read_namespaced_daemon_set(name, namespace)
            selector = ds.spec.selector.match_labels
            selector_str = ",".join([f"{k}={v}" for k, v in selector.items()])

            pods = v1.list_namespaced_pod(namespace, label_selector=selector_str)
            for pod in pods.items:
                if _is_owned_by(pod.metadata, "DaemonSet", name):
                    owned.append(ResourceRef(
                        kind="Pod",
                        name=pod.metadata.name,
                        namespace=namespace
                    ))

        elif kind.lower() == "service":
            # Find pods targeted by this service
            svc = v1.read_namespaced_service(name, namespace)
            if svc.spec.selector:
                selector_str = ",".join([f"{k}={v}" for k, v in svc.spec.selector.items()])
                pods = v1.list_namespaced_pod(namespace, label_selector=selector_str)
                for pod in pods.items:
                    owned.append(ResourceRef(
                        kind="Pod",
                        name=pod.metadata.name,
                        namespace=namespace
                    ))

    except Exception as e:
        print(f"[resource_chain] Error getting owned resources for {kind}/{name}: {e}")

    return owned


def _get_pods_for_rs(v1: client.CoreV1Api, rs_name: str, namespace: str) -> List[ResourceRef]:
    """Get all pods owned by a ReplicaSet."""
    pods = []
    try:
        all_pods = v1.list_namespaced_pod(namespace)
        for pod in all_pods.items:
            if _is_owned_by(pod.metadata, "ReplicaSet", rs_name):
                pods.append(ResourceRef(
                    kind="Pod",
                    name=pod.metadata.name,
                    namespace=namespace
                ))
    except Exception:
        pass
    return pods


def _is_owned_by(metadata, owner_kind: str, owner_name: str) -> bool:
    """Check if a resource is owned by the specified owner."""
    if not metadata.owner_references:
        return False
    for ref in metadata.owner_references:
        if ref.kind == owner_kind and ref.name == owner_name:
            return True
    return False


# =============================================================================
# RELATED RESOURCES (LATERAL)
# =============================================================================

def get_related_resources(
    v1: client.CoreV1Api,
    kind: str,
    name: str,
    namespace: str
) -> List[ResourceRef]:
    """
    Find resources referenced by this resource.

    For Pods: ConfigMaps, Secrets, PVCs, ServiceAccounts
    For Deployments: Same, extracted from pod template
    """
    related = []

    try:
        pod_spec = None

        if kind.lower() == "pod":
            pod = v1.read_namespaced_pod(name, namespace)
            pod_spec = pod.spec

        elif kind.lower() == "deployment":
            apps_v1 = client.AppsV1Api()
            dep = apps_v1.read_namespaced_deployment(name, namespace)
            pod_spec = dep.spec.template.spec

        elif kind.lower() == "statefulset":
            apps_v1 = client.AppsV1Api()
            sts = apps_v1.read_namespaced_stateful_set(name, namespace)
            pod_spec = sts.spec.template.spec

        if pod_spec:
            related.extend(_extract_related_from_pod_spec(pod_spec, namespace))

    except Exception as e:
        print(f"[resource_chain] Error getting related resources for {kind}/{name}: {e}")

    return related


def _extract_related_from_pod_spec(spec, namespace: str) -> List[ResourceRef]:
    """Extract ConfigMaps, Secrets, PVCs from a pod spec."""
    related = []
    seen = set()  # Deduplicate

    # Check volumes
    if spec.volumes:
        for vol in spec.volumes:
            if vol.config_map and vol.config_map.name:
                key = f"ConfigMap/{vol.config_map.name}"
                if key not in seen:
                    seen.add(key)
                    related.append(ResourceRef(
                        kind="ConfigMap",
                        name=vol.config_map.name,
                        namespace=namespace
                    ))

            if vol.secret and vol.secret.secret_name:
                key = f"Secret/{vol.secret.secret_name}"
                if key not in seen:
                    seen.add(key)
                    related.append(ResourceRef(
                        kind="Secret",
                        name=vol.secret.secret_name,
                        namespace=namespace
                    ))

            if vol.persistent_volume_claim and vol.persistent_volume_claim.claim_name:
                key = f"PVC/{vol.persistent_volume_claim.claim_name}"
                if key not in seen:
                    seen.add(key)
                    related.append(ResourceRef(
                        kind="PersistentVolumeClaim",
                        name=vol.persistent_volume_claim.claim_name,
                        namespace=namespace
                    ))

    # Check containers for env vars from ConfigMaps/Secrets
    containers = (spec.containers or []) + (spec.init_containers or [])
    for container in containers:
        if container.env:
            for env in container.env:
                if env.value_from:
                    if env.value_from.config_map_key_ref:
                        key = f"ConfigMap/{env.value_from.config_map_key_ref.name}"
                        if key not in seen:
                            seen.add(key)
                            related.append(ResourceRef(
                                kind="ConfigMap",
                                name=env.value_from.config_map_key_ref.name,
                                namespace=namespace
                            ))

                    if env.value_from.secret_key_ref:
                        key = f"Secret/{env.value_from.secret_key_ref.name}"
                        if key not in seen:
                            seen.add(key)
                            related.append(ResourceRef(
                                kind="Secret",
                                name=env.value_from.secret_key_ref.name,
                                namespace=namespace
                            ))

        if container.env_from:
            for env_from in container.env_from:
                if env_from.config_map_ref:
                    key = f"ConfigMap/{env_from.config_map_ref.name}"
                    if key not in seen:
                        seen.add(key)
                        related.append(ResourceRef(
                            kind="ConfigMap",
                            name=env_from.config_map_ref.name,
                            namespace=namespace
                        ))

                if env_from.secret_ref:
                    key = f"Secret/{env_from.secret_ref.name}"
                    if key not in seen:
                        seen.add(key)
                        related.append(ResourceRef(
                            kind="Secret",
                            name=env_from.secret_ref.name,
                            namespace=namespace
                        ))

    # Check ServiceAccount
    if spec.service_account_name and spec.service_account_name != "default":
        key = f"ServiceAccount/{spec.service_account_name}"
        if key not in seen:
            seen.add(key)
            related.append(ResourceRef(
                kind="ServiceAccount",
                name=spec.service_account_name,
                namespace=namespace
            ))

    return related


# =============================================================================
# EVENTS
# =============================================================================

def get_warning_events(
    v1: client.CoreV1Api,
    resources: List[ResourceRef],
    limit: int = 20
) -> List[Dict]:
    """Get warning events for a list of resources."""
    events = []

    for ref in resources:
        try:
            if ref.namespace:
                resource_events = v1.list_namespaced_event(
                    ref.namespace,
                    field_selector=f"involvedObject.name={ref.name},involvedObject.kind={ref.kind}"
                )
            else:
                resource_events = v1.list_event_for_all_namespaces(
                    field_selector=f"involvedObject.name={ref.name},involvedObject.kind={ref.kind}"
                )

            for e in resource_events.items:
                if e.type == "Warning":
                    events.append({
                        "resource": str(ref),
                        "reason": e.reason,
                        "message": e.message,
                        "count": e.count,
                        "last_seen": e.last_timestamp.isoformat() if e.last_timestamp else None
                    })

        except Exception as ex:
            print(f"[resource_chain] Error getting events for {ref}: {ex}")

    # Sort by count (most frequent first) and limit
    events.sort(key=lambda x: x.get("count", 0) or 0, reverse=True)
    return events[:limit]


# =============================================================================
# MAIN CHAIN BUILDER
# =============================================================================

def build_resource_chain(
    v1: client.CoreV1Api,
    apps_v1: client.AppsV1Api,
    kind: str,
    name: str,
    namespace: str,
    include_events: bool = True
) -> ResourceChain:
    """
    Build a complete resource chain starting from any resource.

    This traverses:
    - UP: Owner references to find parent resources
    - DOWN: Owned resources (pods, replicasets)
    - LATERAL: Related ConfigMaps, Secrets, PVCs
    - EVENTS: Warning events for all resources in chain

    Args:
        v1: CoreV1Api client
        apps_v1: AppsV1Api client
        kind: Resource kind (Pod, Deployment, etc.)
        name: Resource name
        namespace: Resource namespace
        include_events: Whether to fetch events (slower but more info)

    Returns:
        ResourceChain with complete relationship graph
    """
    root = ResourceRef(kind=kind, name=name, namespace=namespace)

    # Get owner chain (up)
    owners = get_owner_chain(v1, apps_v1, kind, name, namespace)

    # Get owned resources (down)
    children = get_owned_resources(v1, apps_v1, kind, name, namespace)

    # Get related resources (lateral)
    related = get_related_resources(v1, kind, name, namespace)

    # Get events for all resources
    events = []
    if include_events:
        all_resources = [root] + owners + children
        events = get_warning_events(v1, all_resources)

    return ResourceChain(
        root=root,
        owners=owners,
        children=children,
        related=related,
        events=events
    )


def format_chain_for_prompt(chain: ResourceChain) -> str:
    """Format a resource chain for inclusion in LLM prompts."""
    lines = ["## Resource Relationship Chain\n"]

    # Root
    lines.append(f"**Target Resource:** `{chain.root}`\n")

    # Owner chain
    if chain.owners:
        lines.append("### Owner Chain (up)")
        lines.append("```")
        path = [str(chain.root)]
        for owner in chain.owners:
            path.append(str(owner))
        lines.append(" → ".join(path))
        lines.append("```\n")

    # Children
    if chain.children:
        lines.append(f"### Owned Resources ({len(chain.children)} total)")
        for child in chain.children[:5]:
            lines.append(f"- `{child}`")
        if len(chain.children) > 5:
            lines.append(f"- ... and {len(chain.children) - 5} more\n")

    # Related
    if chain.related:
        lines.append("### Related Resources")
        for rel in chain.related:
            lines.append(f"- `{rel}`")
        lines.append("")

    # Events
    if chain.events:
        lines.append(f"### ⚠️ Warning Events ({len(chain.events)} total)")
        for e in chain.events[:5]:
            lines.append(f"- **{e['resource']}**: {e['reason']} - {e['message'][:100]}")
        if len(chain.events) > 5:
            lines.append(f"- ... and {len(chain.events) - 5} more warnings")

    return "\n".join(lines)
