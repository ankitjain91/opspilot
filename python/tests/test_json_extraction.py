"""
Test comprehensive JSON extraction from kubectl outputs.

Verifies that parse_kubectl_json_output extracts actual VALUES
from spec and status fields, not just field names.
"""

import json
import pytest
from agent_server.utils import parse_kubectl_json_output


def test_comprehensive_crd_extraction():
    """Test that CRD status and spec VALUES are extracted, not just keys."""

    # Simulated kubectl get customercluster -o json output
    kubectl_output = json.dumps({
        "apiVersion": "v1",
        "items": [
            {
                "apiVersion": "uipath.com/v1alpha1",
                "kind": "CustomerCluster",
                "metadata": {
                    "name": "taasvstst",
                    "namespace": "taasvstst",
                    "creationTimestamp": "2025-12-04T17:39:04Z",
                    "labels": {
                        "env": "production",
                        "region": "us-west-2"
                    }
                },
                "spec": {
                    "aiCenter": {"enabled": True, "replicas": 3},
                    "actionCenter": {"enabled": False},
                    "clusterSize": "large",
                    "version": "2023.10.1"
                },
                "status": {
                    "currentState": "Ready",
                    "versions": "2023.10.1",
                    "health": "Healthy",
                    "conditions": [
                        {
                            "type": "Ready",
                            "status": "True",
                            "lastTransitionTime": "2025-12-04T17:45:00Z"
                        },
                        {
                            "type": "Progressing",
                            "status": "False",
                            "reason": "Completed"
                        }
                    ]
                }
            }
        ],
        "kind": "CustomerClusterList"
    })

    result = parse_kubectl_json_output(kubectl_output)

    # Verify extraction includes actual VALUES
    print("Result:", result)

    # Should contain resource name
    assert "taasvstst" in result, "Should include resource name"

    # Should contain creation timestamp
    assert "2025-12-04T17:39:04Z" in result, "Should include creation timestamp"

    # Should contain labels
    assert "env=production" in result, "Should include label values"

    # CRITICAL: Should contain spec VALUES, not just keys
    assert "clusterSize: large" in result, "Should include spec scalar values"
    assert "version: 2023.10.1" in result, "Should include spec version value"
    assert '"enabled": true' in result or "enabled" in result, "Should include spec dict values"

    # CRITICAL: Should contain status VALUES, not just field names
    assert "currentState: Ready" in result, "Should include currentState VALUE"
    assert "versions: 2023.10.1" in result, "Should include versions VALUE"
    assert "health: Healthy" in result, "Should include health VALUE"

    # Should contain conditions
    assert "Ready: True" in result, "Should include condition status"
    assert "Progressing: False" in result, "Should include progressing condition"
    assert "Completed" in result, "Should include condition reason"

    # Should NOT just list field names without values
    assert "Status Fields: currentState, versions" not in result, "Should NOT just list field names"
    assert "Spec: aiCenter, actionCenter" not in result, "Should NOT just list spec keys"


def test_extraction_handles_complex_types():
    """Test that nested dicts and lists are formatted properly."""

    # Use a generic CRD (not Pod/Deployment which have specialized handlers)
    kubectl_output = json.dumps({
        "apiVersion": "v1",
        "items": [
            {
                "apiVersion": "example.com/v1",
                "kind": "CustomApp",
                "metadata": {
                    "name": "web-app",
                    "namespace": "default"
                },
                "spec": {
                    "replicas": 5,
                    "selector": {
                        "matchLabels": {"app": "web"}
                    },
                    "containers": ["nginx", "sidecar", "init"]
                },
                "status": {
                    "availableReplicas": 5,
                    "conditions": [
                        {"type": "Available", "status": "True"}
                    ],
                    "observedGeneration": 42
                }
            }
        ],
        "kind": "CustomAppList"
    })

    result = parse_kubectl_json_output(kubectl_output)

    print("Complex types result:", result)

    # Should show simple values
    assert "replicas: 5" in result, "Should show integer values"
    assert "availableReplicas: 5" in result, "Should show status integer values"
    assert "observedGeneration: 42" in result, "Should show all status integers"

    # Should show dict keys or compact JSON for nested objects
    assert "selector:" in result, "Should show nested dict field"
    assert ("matchLabels" in result or '"app": "web"' in result), "Should show dict content"

    # Should show list length or items
    assert ("[3 items]" in result or "nginx" in result), "Should show list info"


def test_extraction_empty_status():
    """Test that resources without status don't crash."""

    kubectl_output = json.dumps({
        "apiVersion": "v1",
        "items": [
            {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": {
                    "name": "my-config",
                    "namespace": "default"
                },
                "data": {
                    "key1": "value1",
                    "key2": "value2"
                }
            }
        ],
        "kind": "ConfigMapList"
    })

    result = parse_kubectl_json_output(kubectl_output)

    # Should handle missing status gracefully
    assert "my-config" in result, "Should still extract name"
    assert "default" in result, "Should still extract namespace"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
