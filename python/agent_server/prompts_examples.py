
SUPERVISOR_EXAMPLES_FULL = """
EXAMPLE 1: Simple listing - Use Python
User: "List pods in namespace payments"
Command History:
(none yet)

Thought:
- This is a simple listing query.
- Use Python to list pods in the namespace.
- Python gives full status information without truncation.

Plan:
- Use Python to list pods in payments namespace

Brain JSON:
{
  "thought": "User wants pods in a specific namespace. Python list_namespaced_pod gives accurate results.",
  "plan": "Use Python to list all pods in payments namespace with their status.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "pods = v1.list_namespaced_pod('payments')\\nfor p in pods.items:\\n    print(f'{p.metadata.name}: {p.status.phase}')"
  }
}

---

EXAMPLE 2: Pure explanation (no kubectl needed)
User: "What is a Kubernetes StatefulSet and when should I use it?"
Command History:
(none)

Thought:
- This is a conceptual question.
- No need to talk to the cluster.
- Answer directly with explanation and examples.

Brain JSON:
{
  "thought": "Question is purely definitional. I should explain StatefulSets without running any commands.",
  "plan": "Explain what a StatefulSet is, how it differs from a Deployment, and when to use it.",
  "next_action": "respond",
  "final_response": "A StatefulSet is a controller that manages pods with stable identities and persistent storage. Use it for databases like Cassandra, etc..."
}

---

EXAMPLE 3: CrashLoopBackOff debugging - Use Python diagnose_crash()
User: "My app pod is in CrashLoopBackOff, why?"
Command History:
1) Python: Found pod my-app-7c9d in namespace web with status CrashLoopBackOff

Thought:
- We already know the pod and namespace.
- Use the built-in diagnose_crash() helper for systematic analysis.
- This checks conditions, exit codes, and events automatically.

Plan:
- Use Python diagnose_crash() for deep analysis

Brain JSON:
{
  "thought": "CrashLoopBackOff needs systematic diagnosis. Use diagnose_crash() helper.",
  "plan": "Run Python diagnose_crash() to get exit codes, conditions, and events.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "result = diagnose_crash(v1, 'my-app-7c9d', 'web')\\nprint(result)"
  }
}

---

EXAMPLE 4: Count pods - MUST use Python
User: "How many pods are running in my cluster?"
Command History:
(none)

Thought:
- Counting resources requires Python for accuracy.
- kubectl output is truncated and unreliable for counting.
- Use len() on the Python list for exact count.

Plan:
- Use Python to count all pods

Brain JSON:
{
  "thought": "Counting requires accuracy. Python len() gives exact count vs kubectl pipe which truncates.",
  "plan": "Use Python to count all pods across namespaces.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "pods = v1.list_pod_for_all_namespaces()\\nrunning = [p for p in pods.items if p.status.phase == 'Running']\\nprint(f'Total pods: {len(pods.items)}')\\nprint(f'Running pods: {len(running)}')"
  }
}

---

EXAMPLE 5: Find unhealthy pods - Use Python filtering
User: "Show me all pods that are not healthy"
Command History:
(none)

Thought:
- Need to find pods not in Running or Succeeded state.
- Python list comprehension filters accurately.
- Include restart counts for context.

Brain JSON:
{
  "thought": "Finding unhealthy pods requires filtering. Python comprehension is 100% accurate.",
  "plan": "Use Python to filter pods by status and show unhealthy ones.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "pods = v1.list_pod_for_all_namespaces()\\nunhealthy = [p for p in pods.items if p.status.phase not in ['Running', 'Succeeded']]\\nfor p in unhealthy:\\n    restarts = sum(c.restart_count for c in (p.status.container_statuses or []))\\n    print(f'{p.metadata.namespace}/{p.metadata.name}: {p.status.phase} (restarts: {restarts})')\\nprint(f'\\nTotal unhealthy: {len(unhealthy)}')"
  }
}

---

EXAMPLE 6: Find deployment by name - Use Python
User: "Where is the Deployment called checkout-service?"
Command History:
(none yet)

Thought:
- User wants to find a deployment by name.
- Python can search all namespaces with list comprehension.
- Returns exact match without grep parsing issues.

Brain JSON:
{
  "thought": "Need to find deployment by name across namespaces. Python search is accurate.",
  "plan": "Use Python to find deployments matching the name.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "deps = apps_v1.list_deployment_for_all_namespaces()\\nmatching = [d for d in deps.items if 'checkout-service' in d.metadata.name]\\nfor d in matching:\\n    ready = d.status.ready_replicas or 0\\n    desired = d.spec.replicas or 0\\n    print(f'{d.metadata.namespace}/{d.metadata.name}: {ready}/{desired} ready')"
  }
}

---

EXAMPLE 7: Get pod logs with error filtering - Use Python
User: "Find errors in the payment service logs"
Command History:
1) Python: Found pod payment-api-7d4f8b9c6-x2k9p in namespace payments

Thought:
- Need to get logs and filter for errors.
- Python can get logs and filter in one call.
- More reliable than kubectl logs | grep.

Brain JSON:
{
  "thought": "Need logs with error filtering. Python gets logs and filters accurately.",
  "plan": "Use Python to get logs and filter for error patterns.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "logs = v1.read_namespaced_pod_log('payment-api-7d4f8b9c6-x2k9p', 'payments', tail_lines=500)\\nerror_lines = [line for line in logs.split('\\\\n') if any(kw in line.lower() for kw in ['error', 'exception', 'fatal', 'panic'])]\\nfor line in error_lines[-20:]:\\n    print(line)"
  }
}

---

EXAMPLE 8: Check service endpoints - Use Python
User: "Why is my Service returning 503?"
Command History:
1) Python: Found service checkout-svc in namespace web

Thought:
- 503 errors often mean no endpoints.
- Use Python to check if service has backing pods.
- Also check the selector matches.

Brain JSON:
{
  "thought": "503 usually means no endpoints. Use Python to check service and endpoints.",
  "plan": "Use Python to get service details and check if endpoints exist.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "svc = v1.read_namespaced_service('checkout-svc', 'web')\\nprint(f'Service: {svc.metadata.name}')\\nprint(f'Selector: {svc.spec.selector}')\\neps = v1.read_namespaced_endpoints('checkout-svc', 'web')\\nif eps.subsets:\\n    for subset in eps.subsets:\\n        for addr in (subset.addresses or []):\\n            print(f'Endpoint: {addr.ip}')\\nelse:\\n    print('NO ENDPOINTS - Service has no backing pods!')\\n    # Find pods that should match\\n    if svc.spec.selector:\\n        selector = ','.join(f'{k}={v}' for k,v in svc.spec.selector.items())\\n        pods = v1.list_namespaced_pod('web', label_selector=selector)\\n        print(f'Pods matching selector: {len(pods.items)}')"
  }
}

---

EXAMPLE 9: Pods with high restarts - Use Python
User: "Show me pods that have restarted more than 5 times"
Command History:
(none)

Thought:
- Need to check restart counts across all containers.
- Python can iterate and filter by restart count.
- Sort by restart count for most critical first.

Brain JSON:
{
  "thought": "Need to filter by restart count. Python can check all containers accurately.",
  "plan": "Use Python to find pods with high restart counts.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "pods = v1.list_pod_for_all_namespaces()\\nhigh_restart = []\\nfor p in pods.items:\\n    for c in (p.status.container_statuses or []):\\n        if c.restart_count > 5:\\n            high_restart.append((p.metadata.namespace, p.metadata.name, c.name, c.restart_count))\\nfor ns, pod, container, count in sorted(high_restart, key=lambda x: -x[3]):\\n    print(f'{ns}/{pod} ({container}): {count} restarts')"
  }
}

---

EXAMPLE 10: Get events for troubleshooting - Use Python
User: "Show me recent warning events"
Command History:
(none)

Thought:
- Use Python to get warning events cluster-wide.
- Filter by type=Warning.
- Show most recent ones.

Brain JSON:
{
  "thought": "Need warning events. Python field_selector filters efficiently.",
  "plan": "Use Python to get warning events cluster-wide.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "events = v1.list_event_for_all_namespaces(field_selector='type=Warning')\\nrecent = sorted(events.items, key=lambda e: e.last_timestamp or e.event_time or '', reverse=True)[:20]\\nfor e in recent:\\n    print(f'{e.metadata.namespace}/{e.involved_object.name}: [{e.reason}] {e.message}')"
  }
}

---

EXAMPLE 11: Crossplane discovery - Use Python CustomObjectsApi
User: "List all Crossplane providers and show if any are failing"
Command History:
(none yet)

Thought:
- Crossplane uses CRDs.
- Use Python CustomObjectsApi to list providers.
- Check INSTALLED and HEALTHY conditions.

Plan:
- Use Python to list Crossplane providers

Brain JSON:
{
  "thought": "Crossplane providers are CRDs. Use Python CustomObjectsApi to list and check health.",
  "plan": "Use Python to list Crossplane providers and check their conditions.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "providers = custom.list_cluster_custom_object('pkg.crossplane.io', 'v1', 'providers')\\nfor p in providers.get('items', []):\\n    name = p['metadata']['name']\\n    conditions = {c['type']: c['status'] for c in p.get('status', {}).get('conditions', [])}\\n    installed = conditions.get('Installed', 'Unknown')\\n    healthy = conditions.get('Healthy', 'Unknown')\\n    print(f'{name}: Installed={installed}, Healthy={healthy}')"
  }
}

---

EXAMPLE 12: Crossplane managed resource debugging - Use Python
User: "My SQL server managed by Crossplane is failing to provision."
Command History:
1) Python: Found managed resource server.dbforpostgresql.azure.upbound.io/my-postgres-server with SYNCED=False

Thought:
- Need to check status.conditions for the actual error.
- Python gives access to full condition details.
- Look for ReconcileError message.

Brain JSON:
{
  "thought": "Need to check managed resource conditions for error details. Python gives full access.",
  "plan": "Use Python to get the managed resource and check status.conditions.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "resource = custom.get_cluster_custom_object('dbforpostgresql.azure.upbound.io', 'v1beta1', 'servers', 'my-postgres-server')\\nprint(f'Name: {resource[\"metadata\"][\"name\"]}')\\nconditions = resource.get('status', {}).get('conditions', [])\\nfor c in conditions:\\n    print(f'{c[\"type\"]}: {c[\"status\"]}')\\n    if c.get('reason'):\\n        print(f'  Reason: {c[\"reason\"]}')\\n    if c.get('message'):\\n        print(f'  Message: {c[\"message\"]}')"
  }
}

---

EXAMPLE 13: Node status check - Use Python
User: "Are all my nodes healthy?"
Command History:
(none)

Thought:
- Use Python to list nodes and check Ready condition.
- Also check for any NotReady or pressure conditions.

Brain JSON:
{
  "thought": "Node health check needs condition analysis. Python gives full access to all conditions.",
  "plan": "Use Python to check node conditions, especially Ready status.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "nodes = v1.list_node()\\nfor n in nodes.items:\\n    conditions = {c.type: c.status for c in n.status.conditions}\\n    ready = conditions.get('Ready', 'Unknown')\\n    status = 'HEALTHY' if ready == 'True' else 'UNHEALTHY'\\n    print(f'{n.metadata.name}: {status} (Ready={ready})')\\n    # Check for pressure conditions\\n    for ctype in ['MemoryPressure', 'DiskPressure', 'PIDPressure']:\\n        if conditions.get(ctype) == 'True':\\n            print(f'  WARNING: {ctype}=True')"
  }
}

---

EXAMPLE 14: Deployment rollout status - Use Python
User: "Is my deployment fully rolled out?"
Command History:
1) Python: Found deployment nginx-deployment in namespace default

Thought:
- Check deployment status for ready vs desired replicas.
- Also check conditions for any rollout issues.

Brain JSON:
{
  "thought": "Rollout status requires comparing ready vs desired replicas. Python gives exact numbers.",
  "plan": "Use Python to check deployment replicas and conditions.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "d = apps_v1.read_namespaced_deployment('nginx-deployment', 'default')\\nready = d.status.ready_replicas or 0\\ndesired = d.spec.replicas or 0\\nupdated = d.status.updated_replicas or 0\\navailable = d.status.available_replicas or 0\\nprint(f'Deployment: {d.metadata.name}')\\nprint(f'Desired: {desired}, Ready: {ready}, Updated: {updated}, Available: {available}')\\nif ready == desired:\\n    print('STATUS: FULLY ROLLED OUT')\\nelse:\\n    print(f'STATUS: IN PROGRESS ({ready}/{desired} ready)')\\n# Check conditions\\nfor c in (d.status.conditions or []):\\n    if c.type == 'Progressing':\\n        print(f'Progressing: {c.status} - {c.reason}')"
  }
}

---

EXAMPLE 15: PVC issues - Use Python audit_pvc()
User: "Are there any unbound PVCs?"
Command History:
(none)

Thought:
- Use the built-in audit_pvc() helper.
- Checks for PVCs not in Bound state.

Brain JSON:
{
  "thought": "PVC audit has a built-in helper. Use audit_pvc() for comprehensive check.",
  "plan": "Use Python audit_pvc() to find unbound PVCs.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "# Check all namespaces\\nnamespaces = v1.list_namespace()\\nall_issues = []\\nfor ns in namespaces.items:\\n    issues = audit_pvc(v1, ns.metadata.name)\\n    for issue in issues:\\n        all_issues.append(f'{ns.metadata.name}/{issue}')\\nif all_issues:\\n    print('Unbound PVCs found:')\\n    for pvc in all_issues:\\n        print(f'  {pvc}')\\nelse:\\n    print('All PVCs are bound!')"
  }
}

---

EXAMPLE 16: Find zombie pods - Use Python find_zombies()
User: "Are there any stuck terminating pods?"
Command History:
(none)

Thought:
- Use built-in find_zombies() helper.
- Finds pods stuck in terminating state > 5 minutes.

Brain JSON:
{
  "thought": "Zombie pod detection has a built-in helper. Use find_zombies().",
  "plan": "Use Python find_zombies() to find stuck terminating pods.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "zombies = find_zombies(v1)\\nif zombies:\\n    print('Stuck terminating pods found:')\\n    for z in zombies:\\n        print(f'  {z}')\\nelse:\\n    print('No zombie pods found!')"
  }
}

---

EXAMPLE 17: OOMKilled diagnosis - Use Python
User: "Why does this pod keep restarting?"
Command History:
1) Python: diagnose_crash() returned exit_code=137, reason=OOMKilled

Thought:
- Exit code 137 with OOMKilled is clear.
- Root cause is memory limit exceeded.
- Can respond with fix suggestions now.

Brain JSON:
{
  "thought": "diagnose_crash() shows OOMKilled with exit code 137. Root cause is clear.",
  "plan": "Explain OOMKilled and suggest fixes.",
  "next_action": "respond",
  "final_response": "The pod is being OOMKilled (exit code 137). This means the container exceeded its memory limit.\\n\\n**Root Cause:** Container is using more memory than its `resources.limits.memory` allows.\\n\\n**Fix Options:**\\n1. Increase memory limit in the Deployment spec\\n2. Investigate memory leaks in the application\\n3. Add horizontal pod autoscaling if load varies\\n\\nTo increase memory, edit the Deployment and set `resources.limits.memory` to a higher value."
}

---

EXAMPLE 18: Service-to-Pod graph - Use Python helper
User: "What pods are behind the frontend service?"
Command History:
(none)

Thought:
- Use built-in find_pods_for_service() helper.
- Returns all pods matched by the service selector.

Brain JSON:
{
  "thought": "Service-to-pod mapping has a built-in helper. Use find_pods_for_service().",
  "plan": "Use Python find_pods_for_service() to find backing pods.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "pods = find_pods_for_service(v1, 'frontend', 'default')\\nif pods:\\n    print(f'Pods backing frontend service ({len(pods)} total):')\\n    for p in pods:\\n        print(f'  {p.metadata.name}: {p.status.phase} (IP: {p.status.pod_ip})')\\nelse:\\n    print('No pods found for this service!')"
  }
}

---

EXAMPLE 19: Deployment tree - Use Python helper
User: "Show me the deployment structure for nginx"
Command History:
(none)

Thought:
- Use built-in get_deployment_tree() helper.
- Returns Deployment -> ReplicaSets -> Pods hierarchy.

Brain JSON:
{
  "thought": "Deployment tree has a built-in helper. Use get_deployment_tree().",
  "plan": "Use Python get_deployment_tree() to show hierarchy.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "tree = get_deployment_tree(apps_v1, v1, 'nginx', 'default')\\nimport json\\nprint(json.dumps(tree, indent=2))"
  }
}

---

EXAMPLE 20: ConfigMap check - Use Python
User: "What's in the app-config ConfigMap?"
Command History:
(none)

Thought:
- Use Python to read ConfigMap data.
- Show all keys and values.

Brain JSON:
{
  "thought": "ConfigMap read is straightforward with Python.",
  "plan": "Use Python to read ConfigMap and show its data.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "cm = v1.read_namespaced_config_map('app-config', 'default')\\nprint(f'ConfigMap: {cm.metadata.name}')\\nprint('Data:')\\nfor key, value in (cm.data or {}).items():\\n    print(f'  {key}: {value[:100]}...' if len(value) > 100 else f'  {key}: {value}')"
  }
}

---

EXAMPLE 21: Secret check (keys only) - Use Python
User: "What keys are in the db-credentials secret?"
Command History:
(none)

Thought:
- Use Python to read Secret.
- Show only keys, not values for security.

Brain JSON:
{
  "thought": "Secret read with Python. Only show keys for security.",
  "plan": "Use Python to read Secret and list keys only.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "secret = v1.read_namespaced_secret('db-credentials', 'default')\\nprint(f'Secret: {secret.metadata.name}')\\nprint(f'Type: {secret.type}')\\nprint('Keys:')\\nfor key in (secret.data or {}).keys():\\n    print(f'  {key}')"
  }
}

---

EXAMPLE 22: Namespace summary - Use Python
User: "Give me an overview of all namespaces"
Command History:
(none)

Thought:
- Use Python to list namespaces with resource counts.
- Show pods and deployments per namespace.

Brain JSON:
{
  "thought": "Namespace overview needs multiple counts. Python can aggregate efficiently.",
  "plan": "Use Python to list namespaces with resource counts.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "namespaces = v1.list_namespace()\\nprint(f'{'Namespace':<30} {'Pods':<10} {'Deployments':<12}')\\nprint('-' * 55)\\nfor ns in namespaces.items:\\n    pods = v1.list_namespaced_pod(ns.metadata.name)\\n    deps = apps_v1.list_namespaced_deployment(ns.metadata.name)\\n    print(f'{ns.metadata.name:<30} {len(pods.items):<10} {len(deps.items):<12}')"
  }
}

---

EXAMPLE 23: Remediation - Restart deployment (requires approval)
User: "Restart the frontend deployment"
Command History:
1) Python: Confirmed frontend deployment exists in namespace web with 3/3 replicas ready

Thought:
- User explicitly requested restart.
- This is a mutation - needs kubectl rollout restart.
- Will require human approval.

Brain JSON:
{
  "thought": "User requested deployment restart. This is a mutation that requires approval.",
  "plan": "Use kubectl_rollout to restart the deployment.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "kubectl_rollout",
    "action": "restart",
    "resource": "deployment",
    "name": "frontend",
    "namespace": "web"
  }
}

---

EXAMPLE 24: Exec for debugging - Use kubectl_exec
User: "Check what's in /var/log inside the nginx pod"
Command History:
1) Python: Found pod nginx-7c9d in namespace default

Thought:
- Need to run command inside container.
- This requires kubectl exec (can't do from Python API).
- Read-only ls command is safe.

Brain JSON:
{
  "thought": "Need to run command inside container. kubectl_exec is required for this.",
  "plan": "Use kubectl_exec to list files in /var/log.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "kubectl_exec",
    "pod_name": "nginx-7c9d",
    "namespace": "default",
    "command": ["ls", "-la", "/var/log"]
  }
}

---

EXAMPLE 25: ALL HEALTHY response - respond immediately
User: "Are my Crossplane resources all synced?"
Command History:
1) Python: Listed all providers - all show Installed=True, Healthy=True
2) Python: Listed all managed resources - all show SYNCED=True, READY=True

Thought:
- All providers healthy.
- All managed resources synced.
- User's question is ANSWERED - respond with good news.

Brain JSON:
{
  "thought": "All providers healthy, all managed resources synced. Can respond with status now.",
  "plan": "Report healthy status to user.",
  "next_action": "respond",
  "final_response": "All your Crossplane resources are healthy and synced!\\n\\n**Providers:** All showing Installed=True, Healthy=True\\n**Managed Resources:** All showing SYNCED=True, READY=True\\n\\nNo issues detected - your Crossplane control plane is fully operational."
}

---

EXAMPLE 26: Jobs and CronJobs - Use Python
User: "Show me failed jobs in the last hour"
Command History:
(none)

Thought:
- Use Python to list jobs.
- Filter for failed status.
- Check start time for recency.

Brain JSON:
{
  "thought": "Job status check with time filtering. Python gives full access to job conditions.",
  "plan": "Use Python to find failed jobs.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "from datetime import datetime, timezone, timedelta\\njobs = batch_v1.list_job_for_all_namespaces()\\none_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)\\nfor j in jobs.items:\\n    conditions = j.status.conditions or []\\n    failed = any(c.type == 'Failed' and c.status == 'True' for c in conditions)\\n    if failed and j.status.start_time and j.status.start_time > one_hour_ago:\\n        print(f'{j.metadata.namespace}/{j.metadata.name}: FAILED')\\n        for c in conditions:\\n            if c.type == 'Failed':\\n                print(f'  Reason: {c.reason}, Message: {c.message}')"
  }
}

---

EXAMPLE 27: Ingress check - Use Python
User: "List all ingresses and their hosts"
Command History:
(none)

Thought:
- Use Python NetworkingV1Api to list ingresses.
- Show hosts and paths.

Brain JSON:
{
  "thought": "Ingress listing with host details. Python gives full access to rules.",
  "plan": "Use Python to list ingresses and their routing rules.",
  "next_action": "delegate",
  "current_plan_text": {
    "tool": "run_k8s_python",
    "code": "ingresses = networking_v1.list_ingress_for_all_namespaces()\\nfor ing in ingresses.items:\\n    print(f'{ing.metadata.namespace}/{ing.metadata.name}:')\\n    for rule in (ing.spec.rules or []):\\n        print(f'  Host: {rule.host or \"*\"}')\\n        for path in (rule.http.paths if rule.http else []):\\n            print(f'    {path.path} -> {path.backend.service.name}:{path.backend.service.port.number}')"
  }
}
"""
