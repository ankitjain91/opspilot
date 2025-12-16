import re
from typing import Dict, List, Optional

class ErrorKnowledgeBase:
    """
    A knowledge base of common Kubernetes error patterns and their semantic fixes.
    Used by the Refiner Loop (Reflect Node) to inject expert guidance when things fail.
    """

    ERROR_PATTERNS = [
        {
            "name": "Smart Deduplication / Loop Block",
            "pattern": r"(Smart deduplication|LOOP DETECTED|already executed)",
            "diagnosis": "state machine blocked a redundant command that was just executed.",
            "strategy": "You are stuck in a loop trying to run the same command. You MUST change your strategy.",
            "hint": "Do NOT retry the same command. Switch to a different tool (e.g. describe instead of get), different resource, or ask the user for clarification."
        },
        {
            "name": "ImagePullBackOff",
            "pattern": r"(ImagePullBackOff|ErrImagePull|pull access denied|unauthorized: access to the requested resource is denied)",
            "diagnosis": "The container image cannot be pulled from the registry.",
            "strategy": "1. Check if the image name/tag is 100% correct (typos). 2. Verify the image exists in the registry. 3. Check if 'imagePullSecrets' are required and present.",
            "hint": "Run `kubectl describe pod [POD_NAME]` to see the exact pulling error. Verify the image URL."
        },
        {
            "name": "CrashLoopBackOff",
            "pattern": r"(CrashLoopBackOff|Back-off restarting failed container)",
            "diagnosis": "The application inside the container is crashing repeatedly.",
            "strategy": "1. Check container logs for application errors. 2. Check for missing env vars or config. 3. Check liveness probe failures.",
            "hint": "Run `kubectl logs [POD_NAME]` and `kubectl logs [POD_NAME] --previous` to see the crash stack trace."
        },
        {
            "name": "OOMKilled",
            "pattern": r"(OOMKilled|reason: OOMKilled)",
            "diagnosis": "Container exceeded its memory limit.",
            "strategy": "1. Check current memory usage vs limits. 2. Increase memory limit or debug memory leak.",
            "hint": "Run `kubectl describe pod [POD_NAME]` to see which resource is constrained (CPU or Memory)."
        },
        {
            "name": "Pending (Insufficient Resources)",
            "pattern": r"(Pending|Insufficient cpu|Insufficient memory|0/.* nodes are available)",
            "diagnosis": "No node has enough free resources to schedule this pod.",
            "strategy": "Cluster is full or requested resources are too high. 1. Check `kubectl describe pod`. 2. Lower requests or add nodes.",
            "hint": "Run `kubectl describe pod <pod_name>` to see which resource is constrained (CPU or Memory)."
        },
        {
            "name": "CreateContainerConfigError",
            "pattern": r"(CreateContainerConfigError|configmap.*not found|secret.*not found)",
            "diagnosis": "Missing configuration dependency (ConfigMap or Secret).",
            "strategy": "1. Verify the ConfigMap/Secret name in the Pod spec. 2. Check if it exists in the *same namespace*.",
            "hint": "Run `kubectl describe pod [POD_NAME]` to see exactly which ConfigMap or Secret is missing."
        },
        {
            "name": "Service Connection Refused",
            "pattern": r"(Connection refused|dial tcp.*:80|upstream connect error)",
            "diagnosis": "The application cannot connect to a backend service.",
            "strategy": "1. Check if the target Service exists. 2. Check if the backend Pods are Running and Ready. 3. Verify labels/selectors.",
            "hint": "Check the status of the destination service endpoints with `kubectl get endpoints <service_name>`."
        },
        {
            "name": "RunContainerError",
            "pattern": r"(RunContainerError|failed to start container)",
            "diagnosis": "Container failed to start, often due to missing config/secrets or command errors.",
            "strategy": "1. Check if ConfigMaps/Secrets are actually mounted. 2. Check strict security context (permissions).",
            "hint": "Run `kubectl describe pod` and look at the Events section."
        },
        {
            "name": "Volume Mount Failed",
            "pattern": r"(MountVolume.SetUp failed|Unable to attach or mount volumes)",
            "diagnosis": "Node cannot attach the persistent volume.",
            "strategy": "1. Check if Volume is already attached to another node. 2. Check cloud provider permissions.",
            "hint": "Run `kubectl get pv,pvc` to check binding status."
        },
        {
            "name": "TLS/Certificate Error",
            "pattern": r"(x509|certificate signed by unknown authority|certificate has expired|handshake failure)",
            "diagnosis": "TLS trust issue between components.",
            "strategy": "1. Check if CA bundle is mounted. 2. Verify certificate expiry.",
            "hint": "Check `kubectl exec` to curl the endpoint with `-v` to see cert details."
        },
        {
            "name": "Context Deadline Exceeded",
            "pattern": r"(context deadline exceeded|i/o timeout|Client.Timeout)",
            "diagnosis": "Network timeout or slow API response.",
            "strategy": "The request took too long. Could be network latency, firewall, or overloaded control plane.",
            "hint": "Retry the operation. If persistent, check network connectivity."
        }
    ]

    @staticmethod
    def detect_error_pattern(text: str) -> Optional[Dict[str, str]]:
        """
        Scans the provided text (logs or error message) for known error patterns.
        Returns the first matching error strategy or None.
        """
        if not text:
            return None

        # Normalize text to avoid case sensitivity issues for common terms, 
        # but regexes handle specific cases.
        # We search raw text.
        
        for error in ErrorKnowledgeBase.ERROR_PATTERNS:
            if re.search(error["pattern"], text, re.IGNORECASE):
                return error
        
        return None

# Singleton instance for easy import
error_kb = ErrorKnowledgeBase()
