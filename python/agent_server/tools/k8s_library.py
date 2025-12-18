
from kubernetes import client
from typing import List, Dict, Any, Optional
import datetime

# --- CORE DISCOVERY ---

def get_pod_owner_root(pod: client.V1Pod) -> str:
    """Find the top-level owner of a pod (e.g. Deployment instead of ReplicaSet)."""
    if not pod.metadata.owner_references:
        return "Standalone"
    
    owner = pod.metadata.owner_references[0]
    if owner.kind == "ReplicaSet":
        return f"{owner.kind}/{owner.name}"
    return f"{owner.kind}/{owner.name}"

def find_pods_for_service(v1: client.CoreV1Api, service_name: str, namespace: str) -> list[client.V1Pod]:
    """Find all pods targeted by a service."""
    try:
        svc = v1.read_namespaced_service(service_name, namespace)
    except Exception:
        return []
    
    if not svc.spec.selector:
        return []
    
    selector_str = ",".join([f"{k}={v}" for k, v in svc.spec.selector.items()])
    pods = v1.list_namespaced_pod(namespace, label_selector=selector_str)
    return pods.items

def get_deployment_tree(apps_v1: client.AppsV1Api, v1: client.CoreV1Api, deployment_name: str, namespace: str) -> dict:
    """Get a tree of Deployment -> ReplicaSets -> Pods."""
    try:
        dep = apps_v1.read_namespaced_deployment(deployment_name, namespace)
    except Exception:
        return {"error": "Deployment not found"}
        
    selector_str = ",".join([f"{k}={v}" for k, v in dep.spec.selector.match_labels.items()])
    rss = apps_v1.list_namespaced_replica_set(namespace, label_selector=selector_str).items
    
    owned_rss = []
    for rs in rss:
        if rs.metadata.owner_references:
            for owner in rs.metadata.owner_references:
                if owner.kind == "Deployment" and owner.name == deployment_name:
                    owned_rss.append(rs)
                    
    tree = {
        "deployment": f"{deployment_name}",
        "replicasets": []
    }
    
    all_pods = v1.list_namespaced_pod(namespace, label_selector=selector_str).items
    
    for rs in owned_rss:
        rs_pods = []
        for p in all_pods:
            if p.metadata.owner_references:
                for o in p.metadata.owner_references:
                    if o.kind == "ReplicaSet" and o.name == rs.metadata.name:
                        rs_pods.append(p.metadata.name)
        
        tree["replicasets"].append({
            "name": rs.metadata.name,
            "pods": rs_pods
        })
        
    return tree

# --- ADVANCED DIAGNOSTICS (PHASE 3) ---

def diagnose_crash(v1: client.CoreV1Api, pod_name: str, namespace: str) -> dict:
    """
    Diagnose why a pod is crashing or not running.
    Checks: Status, Conditions, Container Exit Codes, Recent Events.
    """
    try:
        pod = v1.read_namespaced_pod(pod_name, namespace)
    except Exception as e:
        return {"error": f"Pod not found: {e}"}

    report = {
        "pod": pod_name,
        "phase": pod.status.phase,
        "conditions": [],
        "container_issues": [],
        "events": [],
        "verdict": "Unknown"
    }

    # 1. Check Conditions
    if pod.status.conditions:
        for cond in pod.status.conditions:
            if cond.status != 'True':
                report["conditions"].append(f"{cond.type}={cond.status} ({cond.reason}: {cond.message})")

    # 2. Check Containers (Init + Main)
    all_statuses = (pod.status.init_container_statuses or []) + (pod.status.container_statuses or [])
    for status in all_statuses:
        state = status.state
        if state.waiting:
            report["container_issues"].append({
                "container": status.name,
                "state": "Waiting",
                "reason": state.waiting.reason,
                "message": state.waiting.message
            })
        elif state.terminated and state.terminated.exit_code != 0:
            report["container_issues"].append({
                "container": status.name,
                "state": "Terminated",
                "exit_code": state.terminated.exit_code,
                "reason": state.terminated.reason,
                "message": state.terminated.message
            })
            
    # 3. Check Events
    events = v1.list_namespaced_event(namespace, field_selector=f"involvedObject.name={pod_name}")
    for e in events.items:
        if e.type == "Warning":
            report["events"].append(f"[{e.count}x] {e.reason}: {e.message}")

    # 4. Generate Verdict
    if report["container_issues"]:
        issues = report["container_issues"][0]
        if "exit_code" in issues:
            report["verdict"] = f"CRASH: Container '{issues['container']}' exited with code {issues['exit_code']} ({issues['reason']}). Check logs."
        elif "reason" in issues:
            report["verdict"] = f"STUCK: Container '{issues['container']}' is waiting. Reason: {issues['reason']}."
    elif report["phase"] == "Pending":
        report["verdict"] = "SCHEDULING: Pod is pending. Check events (e.g., Insufficient CPU/Memory)."
    elif report["phase"] == "Running":
        report["verdict"] = "HEALTHY: Pod is running."

    return report

def find_zombies(v1: client.CoreV1Api) -> list[str]:
    """Find pods that have been stuck terminating for >5 minutes."""
    pods = v1.list_pod_for_all_namespaces().items
    zombies = []
    
    now = datetime.datetime.now(datetime.timezone.utc)
    
    for p in pods:
        if p.metadata.deletion_timestamp:
            # Check how long it's been deleting
            # deletion_timestamp is a datetime object
            del_time = p.metadata.deletion_timestamp
            duration = (now - del_time).total_seconds()
            
            if duration > 300: # 5 minutes
                zombies.append(f"{p.metadata.namespace}/{p.metadata.name} (Stuck for {int(duration)}s)")
                
    return zombies

def audit_pvc(v1: client.CoreV1Api, namespace: str) -> list[str]:
    """Find PVCs that are not Bound (Lost/Pending)."""
    pvcs = v1.list_namespaced_persistent_volume_claim(namespace).items
    issues = []
    for pvc in pvcs:
        if pvc.status.phase != "Bound":
            issues.append(f"{pvc.metadata.name}: {pvc.status.phase}")
    return issues
