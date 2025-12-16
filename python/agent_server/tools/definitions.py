from typing import Optional, List, Literal, Union, Annotated
from pydantic import BaseModel, Field

class KubectlGet(BaseModel):
    """List resources. Equivalent to `kubectl get <resource> -n <namespace>`."""
    tool: Literal["kubectl_get"]
    resource: str = Field(..., description="Resource type (e.g., pods, services, deployments, events, nodes)")
    namespace: Optional[str] = Field(None, description="Target namespace. If omitted, uses current context default.")
    all_namespaces: bool = Field(False, description="If true, list in all namespaces (-A)")
    selector: Optional[str] = Field(None, description="Label selector (e.g., app=frontend)")
    field_selector: Optional[str] = Field(None, description="Field selector (e.g., status.phase!=Running)")

class KubectlDescribe(BaseModel):
    """Describe a specific resource. Equivalent to `kubectl describe <resource> <name>`."""
    tool: Literal["kubectl_describe"]
    resource: str = Field(..., description="Resource type (e.g., pod, service)")
    name: str = Field(..., description="Name of the resource")
    namespace: Optional[str] = Field(None, description="Target namespace")

class KubectlLogs(BaseModel):
    """Get logs for a container."""
    tool: Literal["kubectl_logs"]
    pod_name: str = Field(..., description="Name of the pod")
    namespace: Optional[str] = Field(None, description="Target namespace")
    container: Optional[str] = Field(None, description="Container name (required if pod has multiple containers)")
    previous: bool = Field(False, description="If true, get logs from previous instantiated container (-p)")
    tail: int = Field(100, description="Lines of recent log file to display")

class KubectlEvents(BaseModel):
    """List events, optionally filtering for warnings or specific resources."""
    tool: Literal["kubectl_events"]
    namespace: Optional[str] = Field(None, description="Target namespace")
    all_namespaces: bool = Field(False, description="If true, list in all namespaces")
    only_warnings: bool = Field(True, description="If true, filter for type=Warning")
    related_object: Optional[str] = Field(None, description="Filter for a specific object name (grep)")

class KubectlTop(BaseModel):
    """Get metrics (CPU/Memory) for pods or nodes."""
    tool: Literal["kubectl_top"]
    resource: Literal["pod", "node"] = Field(..., description="Target: 'pod' or 'node'")
    namespace: Optional[str] = Field(None, description="Target namespace (ignored for nodes)")
    all_namespaces: bool = Field(False, description="If true, show metrics for all namespaces (-A)")
    
class KubectlApiResources(BaseModel):
    """List available resource types (CRDs). Essential for Crossplane/Argo discovery."""
    tool: Literal["kubectl_api_resources"]
    verbs: Optional[str] = Field("list", description="Filter by verb (default: list)")
    api_group: Optional[str] = Field(None, description="Filter by API group (e.g. crossplane.io)")

class KubectlContext(BaseModel):
    """Manage cluster contexts (list or switch)."""
    tool: Literal["kubectl_context"]
    action: Literal["list", "use"] = Field(..., description="Action: 'list' (show available) or 'use' (switch)")
    context_name: Optional[str] = Field(None, description="Name of context to switch to (required for 'use')")

# --- REMEDIATION TOOLS (Requires Approval) ---
class KubectlDelete(BaseModel):
    """Delete a resource (e.g., to restart a pod). REQUIRES APPROVAL."""
    tool: Literal["kubectl_delete"]
    resource: str = Field(..., description="Resource type (e.g., pod)")
    name: str = Field(..., description="Name of the resource")
    namespace: Optional[str] = Field(None, description="Target namespace")

class KubectlRollout(BaseModel):
    """Manage rollouts (e.g., restart deployment). REQUIRES APPROVAL."""
    tool: Literal["kubectl_rollout"]
    action: Literal["restart", "undo"] = Field(..., description="Action: 'restart' or 'undo'")
    resource: str = Field(..., description="Resource type (e.g., deployment, statefulset)")
    name: str = Field(..., description="Name of the resource")
    namespace: Optional[str] = Field(None, description="Target namespace")

class KubectlScale(BaseModel):
    """Scale a resource. REQUIRES APPROVAL."""
    tool: Literal["kubectl_scale"]
    resource: str = Field(..., description="Resource type (e.g., deployment)")
    resource: str = Field(..., description="Resource type (e.g., deployment)")
    name: str = Field(..., description="Name of the resource")
    replicas: int = Field(..., description="New replica count")
    namespace: Optional[str] = Field(None, description="Target namespace")

class KubectlSetResources(BaseModel):
    """Set resource requests/limits. REQUIRES APPROVAL."""
    tool: Literal["kubectl_set_resources"]
    resource: str = Field(..., description="Resource type (e.g., deployment)")
    name: str = Field(..., description="Name of the resource")
    container: str = Field(..., description="Container name")
    requests: Optional[str] = Field(None, description="New requests (e.g., cpu=100m,memory=256Mi)")
    limits: Optional[str] = Field(None, description="New limits (e.g., cpu=200m,memory=512Mi)")
    namespace: Optional[str] = Field(None, description="Target namespace")

class KubectlDiff(BaseModel):
    """Compare a resource across two clusters/contexts. equivalent to diffing output of get -o yaml."""
    tool: Literal["kubectl_diff"]
    resource: str = Field(..., description="Resource type (e.g., deployment)")
    name: str = Field(..., description="Name of the resource")
    namespace: Optional[str] = Field(None, description="Target namespace")
    context_a: str = Field(..., description="First context (source information)")
    context_b: str = Field(..., description="Second context (target/comparison)")

class KubectlApply(BaseModel):
    """Apply YAML manifest to cluster with dry-run validation. REQUIRES APPROVAL."""
    tool: Literal["kubectl_apply"]
    yaml_content: str = Field(..., description="YAML manifest content to apply")
    namespace: Optional[str] = Field(None, description="Target namespace (overrides manifest namespace)")
    dry_run: bool = Field(True, description="Validate with dry-run first (default: true for safety)")

class GitCommit(BaseModel):
    """Commit a file to a Git repository via a new branch and Pull Request."""
    tool: Literal["git_commit"]
    repo_url: str = Field(..., description="HTTPS URL of the git repository")
    file_path: str = Field(..., description="Path to the file to create/update (relative to repo root)")
    file_content: str = Field(..., description="Full content of the file")
    commit_message: str = Field(..., description="Commit message")
    branch_name: Optional[str] = Field(None, description="Branch name (optional, defaults to agent/patch-<timestamp>)")

class PredictScaling(BaseModel):
    """Predict future resource usage based on historical metrics."""
    tool: Literal["predict_scaling"]
    resource_type: str = Field(..., description="Resource type (e.g., deployment)")
    name: str = Field(..., description="Name of the resource")
    namespace: Optional[str] = Field(None, description="Target namespace")
    # We accept a list of floats (simple time series) or a dictionary of timestamp:value
    # For simplicity, let's take a list of usage values (CPU millis or Memory bytes)
    history: List[float] = Field(..., description="List of historical metric values (oldest to newest)")
    horizon_minutes: int = Field(30, description="Minutes into the future to predict")

# Discriminated Union Entry Point
class AgentToolWrapper(BaseModel):
    tool_call: Annotated[Union[
        KubectlGet, KubectlDescribe, KubectlLogs, KubectlEvents, KubectlTop,
        KubectlApiResources, KubectlContext, KubectlDiff, GitCommit, PredictScaling,
        KubectlDelete, KubectlRollout, KubectlScale, KubectlSetResources, KubectlApply
    ], Field(discriminator='tool')]
