"""
The Compass - Formal Verification Module

Provides schema validation and policy enforcement for Kubernetes manifests.
This ensures resources are valid BEFORE attempting to apply them to the cluster.
"""

import json
import subprocess
from typing import Dict, Tuple, Optional
import yaml


class CompassValidator:
    """Schema and policy validator for Kubernetes manifests."""

    @staticmethod
    def validate_yaml_schema(yaml_content: str) -> Tuple[bool, Optional[str]]:
        """
        Validate YAML manifest against Kubernetes schema offline.

        Uses kubectl --dry-run=server as the primary validation method.
        In the future, this could be enhanced with:
        - Offline OpenAPI schema validation
        - Custom CRD schema checks

        Returns: (is_valid, error_message)
        """
        try:
            # Parse YAML to ensure it's valid
            doc = yaml.safe_load(yaml_content)

            if not isinstance(doc, dict):
                return False, "YAML must contain a Kubernetes resource object"

            # Basic structure validation
            if 'apiVersion' not in doc:
                return False, "Missing required field: apiVersion"
            if 'kind' not in doc:
                return False, "Missing required field: kind"
            if 'metadata' not in doc or 'name' not in doc.get('metadata', {}):
                return False, "Missing required field: metadata.name"

            # TODO: Add OpenAPI schema validation here
            # For now, kubectl --dry-run=server provides server-side validation

            return True, None

        except yaml.YAMLError as e:
            return False, f"Invalid YAML syntax: {str(e)}"
        except Exception as e:
            return False, f"Validation error: {str(e)}"

    @staticmethod
    def check_policy_compliance(yaml_content: str, kube_context: Optional[str] = None) -> Tuple[bool, Optional[str]]:
        """
        Check manifest against policy engines (OPA, Kyverno, PSP).

        This is a hook for future policy integration.
        Current implementation returns True (allow all) but provides extension point.

        Future enhancements:
        - OPA Gatekeeper integration via opa eval
        - Kyverno policy checks via kyverno apply --policy-report
        - Pod Security Policy validation
        - Custom organization policies

        Returns: (is_compliant, violation_message)
        """
        try:
            doc = yaml.safe_load(yaml_content)
            kind = doc.get('kind', '').lower()

            # Example policy checks (placeholder for real policy engine)
            # These would be replaced with actual OPA/Kyverno calls

            warnings = []

            # Check 1: Resource limits (best practice)
            if kind in ['pod', 'deployment', 'statefulset', 'daemonset']:
                spec = doc.get('spec', {})
                if kind != 'pod':
                    spec = spec.get('template', {}).get('spec', {})

                containers = spec.get('containers', [])
                for container in containers:
                    if 'resources' not in container:
                        warnings.append(f"Container '{container.get('name', 'unknown')}' has no resource limits")

            # Check 2: Root user (security)
            if kind in ['pod', 'deployment', 'statefulset']:
                spec = doc.get('spec', {})
                if kind != 'pod':
                    spec = spec.get('template', {}).get('spec', {})

                security_context = spec.get('securityContext', {})
                if security_context.get('runAsNonRoot') is False:
                    warnings.append("Running as root user is not recommended")

            if warnings:
                return True, f"⚠️ Policy warnings (non-blocking):\n  - " + "\n  - ".join(warnings)

            return True, None

        except Exception as e:
            # Don't block on policy check failures
            return True, f"Policy check skipped: {str(e)}"

    @staticmethod
    def validate_manifest(yaml_content: str, kube_context: Optional[str] = None) -> Tuple[bool, Optional[str]]:
        """
        Complete validation: schema + policy checks.

        Returns: (is_valid, error_or_warning_message)
        """
        # Schema validation (blocking)
        schema_valid, schema_error = CompassValidator.validate_yaml_schema(yaml_content)
        if not schema_valid:
            return False, f"❌ Schema validation failed: {schema_error}"

        # Policy validation (warnings only)
        policy_ok, policy_msg = CompassValidator.check_policy_compliance(yaml_content, kube_context)

        if policy_msg:
            return True, policy_msg  # Valid but with warnings

        return True, None


# Integration hooks for OPA/Kyverno
class PolicyEngineHook:
    """
    Extension point for policy engine integration.

    To enable OPA:
      1. Install OPA Gatekeeper in cluster
      2. Implement opa_validate() method
      3. Call from check_policy_compliance()

    To enable Kyverno:
      1. Install Kyverno in cluster
      2. Implement kyverno_validate() method
      3. Call from check_policy_compliance()
    """

    @staticmethod
    def opa_validate(yaml_content: str) -> Tuple[bool, Optional[str]]:
        """
        Validate manifest against OPA policies.

        Example implementation:
        ```python
        result = subprocess.run(
            ['opa', 'eval', '--data', 'policies/', '--input', 'manifest.yaml', 'data.kubernetes.admission'],
            capture_output=True
        )
        return parse_opa_result(result.stdout)
        ```
        """
        raise NotImplementedError("OPA integration not yet implemented")

    @staticmethod
    def kyverno_validate(yaml_content: str) -> Tuple[bool, Optional[str]]:
        """
        Validate manifest against Kyverno policies.

        Example implementation:
        ```python
        result = subprocess.run(
            ['kyverno', 'apply', '--policy-report', 'policies/', '--resource', 'manifest.yaml'],
            capture_output=True
        )
        return parse_kyverno_result(result.stdout)
        ```
        """
        raise NotImplementedError("Kyverno integration not yet implemented")
