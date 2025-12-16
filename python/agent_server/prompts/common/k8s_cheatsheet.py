
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
    - `kubectl get pods -o jsonpath='{{.items[*].metadata.name}}'` → just pod names
    - `kubectl get pod <pod> -o jsonpath='{{.status.conditions}}'` → just conditions
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

**11. ANTI-PATTERNS & FORBIDDEN COMMANDS (DO NOT USE)**:
    - ⛔ `kubectl api-resources -o wider` → INVALID FLAG. `api-resources` does NOT support `-o wider`.
    - ⛔ `kubectl get events -w` → Infinite stream. Use `--sort-by='.lastTimestamp'` instead.
    - ⛔ `kubectl logs -f` (without timeout) → Infinite stream. Use `--tail=N` or `--since=time`.

USE THESE TRICKS - they make debugging 10x faster!
"""
