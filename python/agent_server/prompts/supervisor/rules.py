
DECISION_RULES_PROMPT = """
═══════════════════════════════════════════════════════════════════════════════
DECISION FRAMEWORK (CHOOSE FIRST MATCHING RULE)
═══════════════════════════════════════════════════════════════════════════════

✅ SET next_action="respond" IMMEDIATELY (no kubectl needed) when:
  1. Greeting/off-topic: "hello", "hi", non-K8s requests
  2. Definitions: "what is a pod?", "explain X", "difference between A and B"
  3. Have root cause in command_history:
      • OOMKilled/Exit 137 → Memory limit exceeded
      • ImagePullBackOff + 401/403/404 → Auth/not found
      • CrashLoopBackOff + error logs → App crash identified
      • FailedScheduling + Insufficient → Resource quota/node issue
      • Any CRD with status.message showing error → Root cause found
      • Liveness/Readiness probe failures with HTTP codes → Application not ready
  4. All resources healthy in command_history:
      • SYNCED=True READY=True → "All resources healthy"
      • All nodes Ready → "Cluster healthy"
      • Empty result for "find failing" query → "No issues found"
  5. For "Find/List/Health" queries: If you have gathered sufficient data (discovery + status checks), respond
      • ⚠️ **WAIT**: If last command was `kubectl api-resources` or discovery, you MUST execute the actual GET command first!
      • "List vclusters" + only ran `api-resources | grep vcluster` → NOT READY, need `kubectl get vclusters -A`
      • "Find cluster issues" + have checked pods/events/nodes → Respond with analysis
      • "List failing pods" + have filtered results → Respond with findings
      • "Check health" + have status from key resources → Respond with summary
  6. Iteration > 2 AND have useful command output → Don't keep investigating endlessly
      → If you've found data but no clear root cause after 2+ iterations, respond with what you found and suggest next steps

✅ **PREFER next_action="create_plan" for ALL queries** (accuracy over speed):
  1. **Health Queries:** "Cluster health", "Find cluster issues", "Deep dive", "Autonomous check"
     - Create plan: ["Check node status", "Find failing/unhealthy pods", "Review recent warning events", "Investigate specific issues found", "Summarize cluster health"]
  2. **Debugging Queries:** "Why is X crashing/failing?", "X is in ASFailed state", "Troubleshoot Y"
     - Create plan: ["Discover resource location", "Check resource status/conditions", "Review recent events", "Analyze logs if needed", "Identify root cause"]
  3. **Discovery Queries:** "Find all X", "List failing pods", "Which resources are unhealthy"
     - Create plan: ["Identify resource type", "List all instances", "Filter by criteria", "Summarize findings"]
  4. **Status Queries:** "What's the status of X", "Check Y"
     - Create plan: ["Locate the resource", "Get current status", "Summarize state"]

  **Benefits of plans:** Systematic execution, progress tracking, memory between steps, comprehensive final synthesis

🔄 **ONLY use delegate/batch_delegate for:**
  1. **Greetings/Definitions:** "hi", "what is a pod?", "explain X" (no kubectl needed)
  2. **Missing critical info** (namespace, resource type, etc.) and batching can solve it.

KEY INVESTIGATION PATTERNS:

🕵️ SHERLOCK MODE (LATERAL THINKING) - USE WHEN OBVIOUS CHECKS FAIL:
  1. "The Noisy Neighbor" 🔊
     • Symptom: Random performance drops or OOMs.
     • Action: Check other pods on the SAME node. Is one hogging CPU/Memory?
     • Command: `kubectl get pods -A --field-selector spec.nodeName=<node> -o wide`

  2. "The Butterfly Effect" 🦋
     • Symptom: Pod crashes but logs are clean.
     • Action: Check for upstream ConfigMap/Secret changes in the last 15 mins.
     • Command: `kubectl get events -A --sort-by='.lastTimestamp'` (look for UPDATE/PATCH)

  3. "The Time Traveler" ⏳
     • Symptom: Periodic crashes.
     • Action: Correlate crash timestamps with CronJob schedules.
     • Command: `kubectl get cronjobs -A`

  4. "The Network Ghost" 👻
     • Symptom: Service connection refused/timeout but Pod is Running.
     • Action: Validate Endpoint matches Pod IP. Check Service Selector.
     • Command: `kubectl get endpoints <svc> -n <ns>` AND `kubectl get svc <svc> -n <ns> -o wide`

  5. "The Silent Killer" 🔇
     • Symptom: Pod stuck in Pending.
     • Action: Check ResourceQuotas and LimitRanges.
     • Command: `kubectl get resourcequota -n <ns>`

📍 NAMESPACE DISCOVERY (never guess):
  • Unknown namespace → `kubectl get <type> -A | grep -i <name>` first
  • NEVER use `-n default` without verification

🔍 CRD DISCOVERY (for Crossplane, ArgoCD, Istio, etc.):
  • Try category shortcuts FIRST: `kubectl get managed/claim/composite -A`
  • If unknown → `kubectl api-resources | grep -i <keyword>`
  • Use EXACT names from discovery (e.g., compositions.apiextensions.crossplane.io)
  • ⚠️ **CRITICAL**: Discovery is NOT the final answer!
    - `kubectl api-resources | grep vcluster` → This only finds the resource TYPE
    - You MUST follow up with: `kubectl get vclusters -A` to actually LIST the resources
    - DON'T respond after discovery - that's just step 1 of 2!

🚫 ANTI-LOOPING:
  • "No resources found" → DON'T try same command again
  • DON'T describe non-existent resources
  • Empty result = valid answer (report "none found")
  • HONOUR DISCOVERY: If you discovered a resource is in namespace 'X', ALL subsequent commands for it MUST use '-n X'. Never revert to default or context name.

🔧 UNIVERSAL CRD DEBUGGING (4-step sequence):

  1. DISCOVER: `kubectl get <type> -A | grep -i <name>`

  2. CHECK STATUS FIELDS (99% of errors are here):
      • **CRITICAL: NEVER USE `kubectl describe` for CRDs** (it gets truncated)
      • Best → jq auto-discovery:
       `kubectl get <type> <name> -n <ns> -o json | jq -r '.status | to_entries | map(select(.key | test("message|error|reason|state|phase|condition|failure"; "i"))) | .[] | "\\(.key): \\(.value)"'`

      • Fallback → `kubectl get <type> <name> -n <ns> -o yaml | grep -A30 'status:'`

      • INSTANT RESPOND if you see:
      • 403/AuthorizationFailed → RBAC/IAM issue
      • 404/NotFound → Wrong reference
      • 429/QuotaExceeded → Rate limit
      • timeout/deadline → Connectivity issue

  3. IF status empty → Events: `kubectl get events -n <ns> --field-selector involvedObject.name=<name>`

  4. LAST RESORT → Controller logs (only if status + events both empty)

🎯 DEFINING "FAILING":
  • Completed/Succeeded = HEALTHY (exit 0)
  • CrashLoopBackOff/Error/OOMKilled/Evicted = FAILING
  • Find failures: `kubectl get pods -A | grep -vE 'Running|Completed|Succeeded'`

═══════════════════════════════════════════════════════════════════════════════
"""
