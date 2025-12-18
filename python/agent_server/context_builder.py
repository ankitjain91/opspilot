"""
Context Builder - Extract discovered resources from command outputs

This module makes the AI smarter by tracking what resources actually exist in the cluster.
Instead of hardcoding placeholder validation, we GIVE THE AI THE INFORMATION IT NEEDS.
"""

import re
import json
from typing import Dict, List, Optional


def extract_resources_from_output(command: str, output: str) -> Dict[str, List[str]]:
    """
    Extract resource names, namespaces, and other useful context from kubectl output.

    This feeds the AI with ACTUAL resource names so it doesn't use placeholders.

    Examples:
        Input: kubectl get pods -A
        Output: {
            "namespaces": ["default", "kube-system", "production"],
            "pods": ["nginx-123", "api-server-456"],
        }
    """
    resources = {}

    # Try parsing as JSON first (if -o json was used)
    if output.strip().startswith('{'):
        try:
            data = json.loads(output)
            items = data.get('items', [data] if data.get('metadata') else [])
            namespaces = set()
            names = set()

            for item in items:
                metadata = item.get('metadata', {})
                name = metadata.get('name')
                namespace = metadata.get('namespace')
                if name:
                    names.add(name)
                if namespace:
                    namespaces.add(namespace)

            if namespaces:
                resources["namespaces"] = sorted(list(namespaces))
            if names:
                # Determine resource type from command
                resource_type = _extract_resource_type(command)
                if resource_type:
                    resources[resource_type] = sorted(list(names))
                else:
                    # Fallback to generic "resources" key
                    resources["resources"] = sorted(list(names))

            return resources
        except (json.JSONDecodeError, KeyError, TypeError):
            pass  # Fall through to table parsing

    # Extract namespaces from any -A command (table format)
    if "-A" in command or "--all-namespaces" in command:
        # Parse table format: NAMESPACE   NAME   ...
        lines = output.strip().split('\n')
        if len(lines) > 1:  # Has header + data
            namespaces = set()
            names = set()

            for line in lines[1:]:  # Skip header
                # Skip truncation markers
                if line.startswith('...') or 'omitted' in line:
                    continue
                    
                parts = line.split()
                if len(parts) >= 2:
                    namespaces.add(parts[0])  # First column is namespace
                    names.add(parts[1])  # Second column is name

            if namespaces:
                resources["namespaces"] = sorted(list(namespaces))

            # Determine resource type from command
            resource_type = _extract_resource_type(command)
            if resource_type and names:
                resources[resource_type] = sorted(list(names))

    # Extract specific resource names from grep output
    # Example: taasvstst   taasvstst   ASFailed   9d
    if "| grep" in command:
        lines = output.strip().split('\n')
        for line in lines:
            parts = line.split()
            if len(parts) >= 2:
                # Try to extract namespace and name
                namespace = parts[0]
                name = parts[1]

                if namespace and name:
                    if "namespaces" not in resources:
                        resources["namespaces"] = []
                    if namespace not in resources["namespaces"]:
                        resources["namespaces"].append(namespace)

                    resource_type = _extract_resource_type(command)
                    if resource_type:
                        if resource_type not in resources:
                            resources[resource_type] = []
                        if name not in resources[resource_type]:
                            resources[resource_type].append(name)

    # Extract from describe output
    if "describe" in command.lower():
        # Extract namespace from command
        ns_match = re.search(r'-n\s+(\S+)', command)
        if ns_match:
            namespace = ns_match.group(1)
            if "namespaces" not in resources:
                resources["namespaces"] = []
            if namespace not in resources["namespaces"]:
                resources["namespaces"].append(namespace)

        # Extract Name: from describe output
        name_match = re.search(r'^Name:\s+(\S+)', output, re.MULTILINE)
        if name_match:
            name = name_match.group(1)
            resource_type = _extract_resource_type(command)
            if resource_type:
                if resource_type not in resources:
                    resources[resource_type] = []
                resources[resource_type].append(name)

    # Extract from jsonpath output
    if "jsonpath" in command or "-o json" in command:
        # Try to parse JSON-like structures
        # Look for patterns like: {"name": "foo", "namespace": "bar"}
        name_matches = re.findall(r'"name"\s*:\s*"([^"]+)"', output)
        ns_matches = re.findall(r'"namespace"\s*:\s*"([^"]+)"', output)

        if ns_matches:
            if "namespaces" not in resources:
                resources["namespaces"] = []
            resources["namespaces"].extend([ns for ns in ns_matches if ns not in resources["namespaces"]])

        if name_matches:
            resource_type = _extract_resource_type(command)
            if resource_type:
                if resource_type not in resources:
                    resources[resource_type] = []
                resources[resource_type].extend([name for name in name_matches if name not in resources[resource_type]])

    return resources


def _extract_resource_type(command: str) -> Optional[str]:
    """
    Extract the Kubernetes resource type from a kubectl command.

    Examples:
        kubectl get pods -A -> "pods"
        kubectl describe deployment foo -n bar -> "deployments"
        kubectl get customercluster -A -> "customerclusters"
    """
    # Match patterns like: kubectl get <resource>
    match = re.search(r'kubectl\s+(?:get|describe|logs)\s+(\S+)', command)
    if match:
        resource = match.group(1)

        # Normalize to plural
        if not resource.endswith('s'):
            resource = resource + 's'

        return resource

    return None


def build_discovered_context(state_discovered_resources: Optional[Dict[str, List[str]]]) -> str:
    """
    Build a human-readable context string from discovered resources.

    This gets injected into the AI prompts so it knows what actually exists.
    """
    if not state_discovered_resources:
        return "No resources discovered yet. Use kubectl get <type> -A to discover namespaces and names."

    context_lines = ["DISCOVERED RESOURCES (use these actual names, NO placeholders):"]

    # Always show namespaces first
    if "namespaces" in state_discovered_resources:
        namespaces = state_discovered_resources["namespaces"]
        context_lines.append(f"  Namespaces: {', '.join(namespaces[:10])}{' ...' if len(namespaces) > 10 else ''}")

    # Show other resource types
    for resource_type, names in state_discovered_resources.items():
        if resource_type != "namespaces":
            context_lines.append(f"  {resource_type}: {', '.join(names[:10])}{' ...' if len(names) > 10 else ''}")

    return "\n".join(context_lines)


def merge_discovered_resources(
    existing: Optional[Dict[str, List[str]]],
    new: Dict[str, List[str]]
) -> Dict[str, List[str]]:
    """
    Merge new discovered resources with existing ones.
    Keeps the state up-to-date without losing previous discoveries.
    """
    if not existing:
        return new

    merged = dict(existing)

    for resource_type, names in new.items():
        if resource_type in merged:
            # Merge lists, avoiding duplicates
            merged[resource_type] = sorted(list(set(merged[resource_type] + names)))
        else:
            merged[resource_type] = names

    return merged


def validate_command_has_no_placeholders(command: str, discovered_resources: Optional[Dict[str, List[str]]]) -> tuple[bool, Optional[str]]:
    """
    Check if a command contains placeholders and provide AI-friendly feedback.

    Returns: (is_valid, error_message)

    Instead of hardcoding validation rules, this helps the AI self-correct by:
    1. Detecting common placeholder patterns
    2. Suggesting actual resource names from discovered context
    """
    # Common placeholder patterns
    placeholder_patterns = [
        r'<[^>]+>',  # <pod-name>, <namespace>
        r'\[[^\]]+\]',  # [name], [namespace]
        r'\$\{[^}]+\}',  # ${POD_NAME}
        r'\$[A-Z_]+',  # $NAMESPACE
    ]

    for pattern in placeholder_patterns:
        matches = re.findall(pattern, command)
        if matches:
            # Build helpful error with actual alternatives
            suggestions = []

            # If we have discovered resources, suggest them
            if discovered_resources:
                if "namespaces" in discovered_resources:
                    suggestions.append(f"Available namespaces: {', '.join(discovered_resources['namespaces'][:5])}")

                for resource_type, names in discovered_resources.items():
                    if resource_type != "namespaces" and names:
                        suggestions.append(f"Available {resource_type}: {', '.join(names[:5])}")

            suggestions_text = "\n".join(suggestions) if suggestions else "Run a discovery command first (kubectl get <type> -A)"

            error = f"""Command contains placeholders: {matches}

You MUST use actual resource names from discovered resources:
{suggestions_text}

If you don't have the namespace/name yet, your NEXT command should discover it with:
  kubectl get <resource-type> -A | grep <search-term>
"""
            return False, error

    return True, None
