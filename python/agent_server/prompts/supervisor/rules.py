
DECISION_RULES_PROMPT = """
═══════════════════════════════════════════════════════════════════════════════
DECISION FRAMEWORK - PYTHON-FIRST APPROACH
═══════════════════════════════════════════════════════════════════════════════

[PY] **PYTHON IS THE PRIMARY TOOL** [PY]
- Use `run_k8s_python` for ALL Kubernetes operations
- Python gives 100% accurate results (no truncation, no parsing errors)
- Pre-loaded clients: v1, apps_v1, batch_v1, networking_v1, custom
- Built-in helpers: diagnose_crash(), find_zombies(), audit_pvc(), find_pods_for_service()

[OK] SET next_action="respond" IMMEDIATELY when:
  1. Greeting/off-topic: "hello", "hi", non-K8s requests
  2. Definitions: "what is a pod?", "explain X", "difference between A and B"
  3. Have root cause from Python diagnosis:
      • diagnose_crash() returned exit_code=137 (OOMKilled) → Memory limit exceeded
      • diagnose_crash() returned ImagePullBackOff → Auth/not found
      • diagnose_crash() returned CrashLoopBackOff + error logs → App crash identified
      • Python events show FailedScheduling → Resource quota/node issue
      • Python CRD status.conditions show error message → Root cause found
  4. All resources healthy from Python check:
      • All pods phase == 'Running' → "All pods healthy"
      • All nodes Ready condition == True → "Cluster healthy"
      • Empty result for unhealthy filter → "No issues found"
  5. For "Find/List/Health" queries with sufficient Python data
      • [WARN] **CRITICAL**: If no Python commands run yet, MUST create_plan!
  6. Iteration > 2 AND have useful Python output → Respond with findings

[WARN] **NEVER RESPOND ON FIRST ITERATION WITHOUT DATA:**
  - If iteration=1 AND command_history is empty → MUST use create_plan
  - Example: "Check failing pods" with no commands → create_plan, DO NOT respond

[OK] **PREFER next_action="create_plan" for ALL queries:**
  1. **Health Queries:** "Cluster health", "Find issues", "Deep dive"
     - Plan: ["Use Python to list unhealthy pods", "Use Python to get warning events", "Analyze specific issues", "Summarize cluster health"]
  2. **Debugging Queries:** "Why is X crashing?", "Troubleshoot Y"
     - Plan: ["Use Python diagnose_crash() helper", "Use Python to get events", "Check conditions and logs", "Identify root cause"]
  3. **Discovery Queries:** "Find all X", "List Y"
     - Plan: ["Use Python to search pods/deployments/services", "Filter by name pattern", "Report findings"]
  4. **Status Queries:** "What's the status of X"
     - Plan: ["Use Python to read resource", "Check conditions", "Summarize state"]

PYTHON PATTERNS FOR COMMON TASKS:

[STATS] COUNTING (ALWAYS USE PYTHON):
  [X] NEVER: `kubectl get pods -A | wc -l` (truncated, unreliable)
  [OK] ALWAYS: `len(v1.list_pod_for_all_namespaces().items)`

[SEARCH] DISCOVERY (PYTHON FIRST):
  [X] NEVER: `kubectl get pods -A | grep myapp`
  [OK] ALWAYS: `[p for p in pods.items if 'myapp' in p.metadata.name]`

🩺 DIAGNOSIS (USE HELPERS):
  [X] NEVER: `kubectl describe pod X && kubectl get events`
  [OK] ALWAYS: `diagnose_crash(v1, 'pod-name', 'namespace')`

[NOTE] LOGS (PYTHON API):
  [X] NEVER: `kubectl logs pod | grep error`
  [OK] ALWAYS: `logs = v1.read_namespaced_pod_log(pod, ns, tail_lines=100)`

[LIST] CRD STATUS (PYTHON CustomObjectsApi):
  [X] NEVER: `kubectl get <crd> -o json | jq`
  [OK] ALWAYS: `custom.get_cluster_custom_object(group, version, plural, name)`

PYTHON CODE EXAMPLES:

```python
# Count all pods
pods = v1.list_pod_for_all_namespaces()
print(f"Total: {len(pods.items)}")

# Find unhealthy pods
unhealthy = [p for p in pods.items if p.status.phase not in ['Running', 'Succeeded']]

# Get pod details (like describe)
pod = v1.read_namespaced_pod('name', 'namespace')
for c in (pod.status.container_statuses or []):
    print(f"{c.name}: restarts={c.restart_count}")

# Get logs
logs = v1.read_namespaced_pod_log('pod', 'ns', tail_lines=200)

# Get events
events = v1.list_namespaced_event('ns', field_selector='involvedObject.name=pod')

# Use built-in helpers
result = diagnose_crash(v1, 'pod', 'ns')
zombies = find_zombies(v1)
issues = audit_pvc(v1, 'namespace')

# CRD access
providers = custom.list_cluster_custom_object('pkg.crossplane.io', 'v1', 'providers')
```

WHEN TO USE KUBECTL (ONLY THESE CASES):

1. **kubectl exec** - Run commands inside containers
   - Python API doesn't support interactive exec
   - Use for: ls, cat, env, curl, df

2. **kubectl rollout restart** - Restart deployments
   - Mutation operation requiring approval

3. **kubectl delete** - Delete resources
   - Mutation operation requiring approval

4. **kubectl top** - Metrics (if metrics-server not in Python)
   - Last resort for CPU/Memory usage

🚫 ANTI-LOOPING:
  • "No resources found" → DON'T try same Python code again
  • Empty result = valid answer (report "none found")
  • HONOUR DISCOVERY: If Python found resource in namespace 'X', use that namespace

[FIX] UNIVERSAL CRD DEBUGGING (Python steps):

  1. DISCOVER with Python:
     ```python
     # Search for CRD instances
     items = custom.list_cluster_custom_object(group, version, plural)
     for item in items.get('items', []):
         print(item['metadata']['name'])
     ```

  2. CHECK STATUS with Python:
     ```python
     resource = custom.get_cluster_custom_object(group, version, plural, name)
     conditions = resource.get('status', {}).get('conditions', [])
     for c in conditions:
         print(f"{c['type']}: {c['status']} - {c.get('message', '')}")
     ```

  3. IF status empty → Get events with Python:
     ```python
     events = v1.list_namespaced_event(ns, field_selector=f"involvedObject.name={name}")
     for e in events.items:
         print(f"[{e.type}] {e.reason}: {e.message}")
     ```

  4. FIND CONTROLLER (Python search):
     ```python
     # Search system namespaces for controller
     for ns in ['crossplane-system', 'kube-system', 'default']:
         pods = v1.list_namespaced_pod(ns)
         controllers = [p for p in pods.items if 'controller' in p.metadata.name.lower()]
         for c in controllers:
             print(f"{ns}/{c.metadata.name}")
     ```

═══════════════════════════════════════════════════════════════════════════════
"""
