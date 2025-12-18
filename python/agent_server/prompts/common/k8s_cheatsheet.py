
K8S_CHEAT_SHEET = """
═══════════════════════════════════════════════════════════════════════════════
BASH & LOG ANALYSIS POWER TRICKS (use these for effective debugging)
═══════════════════════════════════════════════════════════════════════════════

**1. GREP WITH CONTEXT** (see lines around matches):
    - `kubectl logs <pod> | grep -A 5 "error"` → 5 lines AFTER each error
    - `kubectl logs <pod> | grep -B 3 "exception"` → 3 lines BEFORE
    - `kubectl logs <pod> | grep -C 2 "failed"` → 2 lines BEFORE and AFTER
    - Use this to understand what happened around an error!

**2. TIME-BASED LOG FILTERING** (focus on recent events):
    - `kubectl logs <pod> --since=10m` → logs from last 10 minutes
    - `kubectl logs <pod> --since=1h` → logs from last hour
    - `kubectl logs <pod> --since-time="2024-01-01T10:00:00Z"` → since specific time
    - ALWAYS prefer `--since=` over raw logs for large pods!

**3. MULTI-CONTAINER & CRASHED PODS**:
    - `kubectl logs <pod> --previous` → logs from CRASHED/restarted container
    - `kubectl logs <pod> -c <container>` → specific container in multi-container pod
    - `kubectl logs <pod> --all-containers` → all containers at once
    - For CrashLoopBackOff, ALWAYS use `--previous` to see crash logs!

**4. EVENTS TIMELINE** (critical for debugging):
    - `kubectl get events --sort-by='.lastTimestamp' | tail -20` → recent events sorted
    - `kubectl get events -n <ns> --field-selector involvedObject.name=<pod>` → events for specific resource
    - `kubectl get events -n <ns> --field-selector type=Warning` → only warnings
    - Events tell you WHAT HAPPENED - always check them!

**5. JSON OUTPUT & JQ FILTERING**:
    - `kubectl get pods -o json | jq '.items[] | select(.status.phase != "Running")'` → non-running pods
    - `kubectl get pods -o jsonpath='{{{{.items[*].metadata.name}}}}'` → just pod names
    - `kubectl get pod <pod> -o jsonpath='{{{{.status.conditions}}}}'` → just conditions
    - Use `-o json | jq` for complex filtering!

**6. AWK & GREP COMBOS** (powerful filtering):
    - `kubectl get pods -A | awk '$4 > 5'` → pods with >5 restarts (4th column)
    - `kubectl get pods | grep -v Running` → non-running pods
    - `kubectl get pods | grep -E 'Error|Failed|Pending'` → multiple patterns
    - `kubectl top pods | sort -k3 -h | tail -5` → top 5 by CPU usage

**7. DESCRIBE + GREP** (find specific info fast):
    - `kubectl describe pod <pod> | grep -A 5 "Events:"` → just events section
    - `kubectl describe pod <pod> | grep -A 3 "State:"` → container states
    - `kubectl describe pod <pod> | grep -i error` → any error mentions
    - `kubectl describe node <node> | grep -A 5 "Conditions:"` → node health

**8. WATCH & FOLLOW** (live monitoring):
    - `kubectl logs -f <pod> --tail=50` → follow logs live (start with last 50)
    - `kubectl get pods -w` → watch pod state changes
    - Note: Be careful with `-f` as it streams indefinitely!

**9. COMPARE & COUNT**:
    - `kubectl get pods -A | wc -l` → count all pods
    - `kubectl get pods -A | grep -c Running` → count running pods
    - `kubectl diff -f manifest.yaml` → compare local vs cluster

**10. COMBINE FOR POWER**:
    - `kubectl get events --sort-by='.lastTimestamp' | grep -E 'Error|Warning|Failed' | tail -10`
      → Recent error events
    - `kubectl logs <pod> --since=5m | grep -C 3 -i error`
      → Errors with context from last 5 minutes
    - `kubectl get pods -A -o wide | awk 'NR==1 || $5>3'`
      → Header + pods with >3 restarts

**11. RESOURCE DISCOVERY STRATEGY** (finding any resource type):
    ⚠️ IMPORTANT: Resources don't always have CRDs! Use multi-method discovery:

    **When looking for ANY resource (e.g., "istio", "argocd", "prometheus", "vcluster"):**
    1. `kubectl get pods,deployments,statefulsets -A | grep -i <NAME>` → Find workloads
    2. `kubectl get svc,ingress -A | grep -i <NAME>` → Find network resources
    3. `kubectl get ns | grep -i <NAME>` → Check if it has dedicated namespace
    4. `kubectl api-resources | grep -i <NAME>` → Check for CRDs (may not exist)
    5. `helm list -A | grep -i <NAME>` → Check Helm releases

    **Why multi-method?**
    - Resources can be deployed as plain YAML (no CRD)
    - Names may vary: "argo-cd" vs "argocd" vs "argo"
    - May use generic resources: Deployments, StatefulSets, DaemonSets
    - Operator pattern: CRD exists but instances are StatefulSets/Pods

    **⚠️ NEVER conclude "resource X not found" from just ONE check!**
    - If CRD not found → check pods/deployments/services/helm
    - If no pods found in default namespace → try -A (all namespaces)
    - If exact name fails → try grep with partial match

**12. CRD CONTROLLER DISCOVERY & ROOT CAUSE ANALYSIS** (climb the chain):
    ⚠️ When a CRD resource is failing, find its controller to see WHY!

    **Step-by-step controller discovery (try ALL methods):**

    **Method 1: Label-based (most reliable)**
    - Extract API group: `kubectl get <resource> <name> -n <ns> -o jsonpath='{{{{.apiVersion}}}}'`
      Example: `compositions.apiextensions.crossplane.io/v1` → API group = `apiextensions.crossplane.io`
    - Find controller: `kubectl get pods -A -l 'app.kubernetes.io/name=<api-group-keyword>'`
      Example: `kubectl get pods -A -l 'app.kubernetes.io/name=crossplane'`

    **Method 2: Namespace-based (common pattern)**
    - Controllers usually run in system namespaces matching their name
    - `kubectl get pods -n crossplane-system` (for Crossplane/Upbound)
    - `kubectl get pods -n upbound-system` (for Upbound Universal Crossplane)
    - `kubectl get pods -n azureserviceoperator-system` (for Azure Service Operator)
    - `kubectl get pods -n argocd` (for ArgoCD)
    - `kubectl get pods -n istio-system` (for Istio)
    - `kubectl get pods -n cert-manager` (for cert-manager)
    - `kubectl get pods -n kube-system | grep <resource-type>` (for core resources)

    **Method 3: Owner Reference (if resource has one)**
    - `kubectl get <resource> <name> -n <ns> -o jsonpath='{{{{.metadata.ownerReferences}}}}'`
    - Follow the chain up to find the controller

    **Method 4: Keyword search (last resort)**
    - `kubectl get pods -A | grep -i <crd-name>`
    - Example: `kubectl get pods -A | grep -i crossplane`

    **After finding controller - CLIMB THE CHAIN (don't stop!):**
    1. Check controller logs: `kubectl logs <controller-pod> -n <controller-ns> --tail=500 | grep -iE "error|fail|<resource-name>"`
    2. Search for YOUR resource name in logs: `kubectl logs <controller-pod> -n <controller-ns> --tail=2000 | grep -i "<your-resource-name>"`
    3. Check controller events: `kubectl get events -n <controller-ns> --field-selector involvedObject.name=<controller-pod>`
    4. Check controller's status: `kubectl describe pod <controller-pod> -n <controller-ns>`
    5. If controller is crashing: `kubectl logs <controller-pod> -n <controller-ns> --previous --tail=500`
    6. Check controller's configmaps/secrets: `kubectl get cm,secret -n <controller-ns>`
    7. Look for webhook failures: `kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations`

    **EXHAUSTIVE SEARCH RULES (keep trying!):**
    - ✅ Found controller but no errors? → Search logs with resource name, check older logs
    - ✅ Controller healthy but resource failing? → Check webhooks, RBAC, network policies
    - ✅ Can't find controller? → Try all 4 methods above, check all system namespaces
    - ✅ Controller logs empty? → Check if multiple controller pods exist, check all replicas
    - ❌ NEVER give up after one method - try ALL discovery methods
    - ❌ NEVER say "no errors found" without checking controller logs for the specific resource name

**12. ANTI-PATTERNS & FORBIDDEN COMMANDS (DO NOT USE)**:
    - ⛔ `kubectl api-resources -o wider` → INVALID FLAG. `api-resources` does NOT support `-o wider`.
    - ⛔ `kubectl get events -w` → Infinite stream. Use `--sort-by='.lastTimestamp'` instead.
    - ⛔ `kubectl logs -f` (without timeout) → Infinite stream. Use `--tail=N` or `--since=time`.

USE THESE TRICKS - they make debugging 10x faster!
"""
