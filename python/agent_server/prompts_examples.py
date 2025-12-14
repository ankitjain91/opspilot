
SUPERVISOR_EXAMPLES_FULL = """
EXAMPLE 1: Simple listing (stop after one command)
User: "List pods in namespace payments"
Command History:
(none yet)

Thought:
- This is a simple listing query.
- Only need one command: get pods in the requested namespace.
- No logs, no describe, no deep debugging.

Plan:
- Ask the worker to run:
  kubectl get pods -n payments -o wide

Brain JSON:
{
  "thought": "User wants a simple list of pods in a known namespace. Single get is enough.",
  "plan": "Run `kubectl get pods -n payments -o wide` and then respond with the table.",
  "next_action": "delegate",
  "final_response": null
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
  "thought": "Question is purely definitional. I should explain StatefulSets without running kubectl.",
  "plan": "Explain what a StatefulSet is, how it differs from a Deployment, and when to use it.",
  "next_action": "respond",
  "final_response": "A StatefulSet is a controller that manages pods with stable identities and persistent storage. Use it for databases like Cassandra, etc..."
}

---

EXAMPLE 3: Basic CrashLoopBackOff debugging
User: "My app pod is in CrashLoopBackOff, why?"
Command History:
1) $ kubectl get pods -A | grep my-app
   NAMESPACE   NAME          READY   STATUS              RESTARTS    AGE
   web         my-app-7c9d   0/1     CrashLoopBackOff    5           3m

Thought:
- We already know the pod and namespace.
- Next step: logs (including previous container) and describe.
- One batched command is efficient.

Plan:
- Ask worker to run:
  kubectl logs my-app-7c9d -n web --tail=100 --previous && kubectl describe pod my-app-7c9d -n web

Brain JSON:
{
  "thought": "CrashLoopBackOff needs logs and describe to find root cause.",
  "plan": "Get previous logs and describe the pod in namespace web.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 8: Existence / discovery only (stop when found)
User: "Where is the Deployment called checkout-service?"
Command History:
(none yet)

Thought:
- User only wants to know where the resource exists.
- Step 1: search across namespaces.
- Once found, respond. No describe/logs needed.

Plan:
- Ask worker to run:
  kubectl get deploy -A | grep checkout-service

Brain JSON:
{
  "thought": "We just need namespace and existence for this deployment.",
  "plan": "Find the Deployment by name across all namespaces, then respond with namespace and ready status.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 9: Crossplane discovery (must use api-resources first)
User: "List all Crossplane compositions and show me if any are failing."
Command History:
(none yet)

Thought:
- Crossplane uses CRDs, not core types.
- Never guess names like managedresources.
- First: discover CRDs via api-resources.
- Then: list **compositions** (plural) and check Ready conditions using the exact resource name.

Plan:
1) Ask worker to run:
   kubectl api-resources --verbs=list -o name | grep -i crossplane
2) Next step (after we see the real API names) will be something like:
   kubectl get compositions.apiextensions.crossplane.io -A -o wide

Brain JSON:
{
  "thought": "Need to discover Crossplane CRDs first using api-resources, then list compositions with the plural resource name.",
  "plan": "Run `kubectl api-resources --verbs=list -o name | grep -i crossplane` to discover composition and related types.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 10: Crossplane FULL DEBUG FLOW (Discovery → Resource → Controller Logs)
User: "My SQL server managed by Crossplane is failing to provision."
Command History:
1) $ kubectl get managed | grep -i sql
   NAME                                                         SYNCED   READY   EXTERNAL-NAME    AGE
   server.dbforpostgresql.azure.upbound.io/my-postgres-server    False    False   4m

Thought:
- We found the managed resource: `server.dbforpostgresql.azure.upbound.io/my-postgres-server`
- SYNCED=False means Crossplane cannot reconcile it with cloud API
- CRITICAL NEXT STEP: Check status.conditions for the actual error
- If conditions don't reveal root cause → check Crossplane provider/controller logs

Plan (FULL CROSSPLANE DEBUG SEQUENCE):
1) DONE: `kubectl get managed | grep -i sql` - Found the resource
2) NEXT: `kubectl describe server.dbforpostgresql.azure.upbound.io/my-postgres-server` - Get conditions and events
3) IF STILL UNCLEAR: Check provider health: `kubectl get providers`
4) IF PROVIDER UNHEALTHY: `kubectl describe provider provider-azure` - Check provider conditions
5) FOR DEEP DEBUG: Get controller logs: `kubectl logs -n crossplane-system -l pkg.crossplane.io/provider=provider-azure --tail=100`

Brain JSON:
{
  "thought": "Found SYNCED=False managed resource. Must check status.conditions for the actual cloud API error, then provider health if needed.",
  "plan": "Describe the managed resource to see status.conditions[].reason and message. This usually reveals the exact Azure/AWS/GCP error.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 10b: Crossplane - Reading status.conditions (THE KEY STEP)
User: "My SQL server managed by Crossplane is failing to provision."
Command History:
1) $ kubectl get managed | grep -i sql
   server.dbforpostgresql.azure.upbound.io/my-postgres-server    False    False   15m
2) $ kubectl describe server.dbforpostgresql.azure.upbound.io/my-postgres-server
   ...
   Status:
     Conditions:
       Type:    Synced
       Status:  False
       Reason:  ReconcileError
       Message: cannot create PostgreSQL Server: compute.ServersClient#CreateOrUpdate:
                Failure sending request: StatusCode=403 -- Original Error:
                autorest/azure: Service returned an error. Status=403 Code="AuthorizationFailed"
                Message="The client does not have authorization to perform action
                'Microsoft.DBforPostgreSQL/servers/write' on scope '/subscriptions/xxx/resourceGroups/yyy'"
   ...

Thought:
- FOUND ROOT CAUSE: Azure RBAC permission error (403 AuthorizationFailed)
- The Crossplane provider's service principal lacks 'Microsoft.DBforPostgreSQL/servers/write' permission
- No need to check controller logs - the error is clear in conditions
- Can respond with fix now

Brain JSON:
{
  "thought": "status.conditions reveals 403 AuthorizationFailed - the Azure service principal lacks DBforPostgreSQL write permissions.",
  "plan": "Explain the RBAC permission issue and how to fix it.",
  "next_action": "respond",
  "final_response": "Your PostgreSQL server is failing because the Crossplane Azure provider lacks permission. The error shows: `AuthorizationFailed - client does not have authorization to perform 'Microsoft.DBforPostgreSQL/servers/write'`. **Fix**: Grant the Azure service principal (used by provider-azure) the 'Contributor' role or a custom role with 'Microsoft.DBforPostgreSQL/servers/*' permissions on the target resource group or subscription."
}

---

EXAMPLE 10bh: Crossplane - ALL HEALTHY (respond immediately with good news)
User: "Are my Crossplane resources all synced?"
Command History:
1) $ kubectl get providers
   NAME              INSTALLED   HEALTHY   PACKAGE                                           AGE
   provider-azure      True        True      xpkg.upbound.io/upbound/provider-azure            5d
   provider-kubernetes   True        True      xpkg.upbound.io/upbound/provider-kubernetes       5d
2) $ kubectl get managed -A
   NAME                                              SYNCED   READY   EXTERNAL-NAME     AGE
   bucket.storage.azure.upbound.io/my-bucket           True     True    my-bucket         2d
   server.dbforpostgresql.azure.upbound.io/my-postgres  True     True    my-postgres       2d

Thought:
- ALL providers show INSTALLED=True HEALTHY=True
- ALL managed resources show SYNCED=True READY=True
- User asked about sync status → I have the answer
- NO NEED for more commands - everything is healthy
- RESPOND NOW with the good news

Brain JSON:
{
  "thought": "All providers are healthy (INSTALLED=True, HEALTHY=True) and all managed resources are synced (SYNCED=True, READY=True). No issues detected.",
  "plan": "Report healthy status to user.",
  "next_action": "respond",
  "final_response": "All your Crossplane resources are healthy and synced:\\n\\n**Providers:**\\n| Name | Installed | Healthy |\\n|------|-----------|---------|\\n| provider-azure | True | True |\\n| provider-kubernetes | True | True |\\n\\n**Managed Resources:**\\n| Resource | Synced | Ready |\\n|----------|--------|-------|\\n| bucket.storage.azure.upbound.io/my-bucket | True | True |\\n| server.dbforpostgresql.azure.upbound.io/my-postgres | True | True |\\n\\nNo issues detected - everything is working correctly."
}

---

EXAMPLE 10c: Crossplane - Provider unhealthy (need controller logs)
User: "All my Crossplane resources are stuck."
Command History:
1) $ kubectl get managed
   (all resources show SYNCED=False, READY=False)
2) $ kubectl get providers
   NAME              INSTALLED   HEALTHY   PACKAGE                                           AGE
   provider-azure      True        False     xpkg.upbound.io/upbound/provider-azure          2d
3) $ kubectl describe provider provider-azure
   ...
   Conditions:
     Type:    Healthy
     Status:  False
     Reason:  UnhealthyPackageRevision
     Message: cannot get package revision health: Deployment replicas are not ready
   ...

Thought:
- Provider is UNHEALTHY - this affects ALL its managed resources
- "Deployment replicas are not ready" → controller pod is crashing
- NEXT: Get controller pod logs to see crash reason

Plan:
- Find and get logs from the provider controller pod
- `kubectl get pods -n crossplane-system -l pkg.crossplane.io/provider=provider-azure`
- Then `kubectl logs <pod> -n crossplane-system --tail=100`

Brain JSON:
{
  "thought": "Provider is unhealthy due to deployment not ready. Must check controller pod logs for crash reason.",
  "plan": "Get logs from the provider-azure controller pod in crossplane-system namespace.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 10d: Generic CRD/Operator Debug Flow (extensible pattern)
User: "My cert-manager Certificate is stuck in not ready."
Command History:
(none yet)

Thought:
- cert-manager is an operator with CRDs (Certificate, Issuer, ClusterIssuer)
- SAME DEBUG PATTERN as Crossplane:
  1) Find the resource: `kubectl get certificates -A` or `kubectl get cert -A`
  2) Describe it: `kubectl describe certificate <name> -n <ns>` - check status.conditions
  3) If unclear, check controller: `kubectl logs -n cert-manager -l app=cert-manager --tail=100`
- This pattern works for ANY operator: Prometheus, ArgoCD, Flux, KEDA, etc.

Plan:
1) Discover: `kubectl get certificates -A` (or grep if people use partial name)
2) Describe: Check status.conditions for the exact error
3) Controller logs if still unclear

Brain JSON:
{
  "thought": "cert-manager Certificate not ready. Standard CRD debug: get resource → describe → check conditions → controller logs if needed.",
  "plan": "First list certificates across all namespaces to find the stuck one.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 10e: Custom CRD (CustomerCluster) - Status Check Complete
User: "What's the status of my customerclusters?"
Command History:
1) $ kubectl api-resources | grep -i customer
   customerclusters    [dedicated.uipath.com/v1alpha1](https://dedicated.uipath.com/v1alpha1)    true    CustomerCluster
2) $ kubectl get customerclusters.dedicated.uipath.com -A
   NAMESPACE    NAME            READY   SYNCED    AGE
   production   customer-1      True    True      10d
   staging      customer-2      True    True      5d

Thought:
- User asked about status of customerclusters
- I discovered the CRD and listed all instances
- Output shows READY=True, SYNCED=True for all
- User's question is ANSWERED - respond with the status

Brain JSON:
{
  "thought": "Found 2 customerclusters, both showing READY=True and SYNCED=True. User asked for status and I have it.",
  "plan": "Report the status to user.",
  "next_action": "respond",
  "final_response": "Your CustomerCluster resources status:\\n\\n| Namespace | Name | Ready | Synced | Age |\\n|-----------|------|-------|--------|-----|\\n| production | customer-1 | True | True | 10d |\\n| staging | customer-2 | True | True | 5d |\\n\\nBoth clusters are healthy and synced."
}

---

EXAMPLE 10f: Custom CRD - READY=False needs describe
User: "Why is my customercluster not working?"
Command History:
1) $ kubectl get customerclusters.dedicated.uipath.com -A
   NAMESPACE    NAME            READY   SYNCED    AGE
   staging      customer-2      False   False     5d

Thought:
- Found customer-2 with READY=False, SYNCED=False
- User asks WHY - I need to check status.conditions for the error
- MUST describe to find root cause

Brain JSON:
{
  "thought": "customer-2 shows READY=False and SYNCED=False. Need to describe to see status.conditions for the actual error.",
  "plan": "Describe the customercluster to check status.conditions for the reconciliation error.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 10g: Crossplane - SYNCED=False with ReconcilePaused (healthy paused resource)
User: "Why are my Crossplane role assignments showing SYNCED=False?"
Command History:
1) $ kubectl get managed -A | grep roleassignment | head -3
   NAME                                                            SYNCED   READY   EXTERNAL-NAME
   roleassignment.authorization.azure.upbound.io/taasvstst-vc      False    True    /subscriptions/.../roleAssignments/fa36df05
   roleassignment.authorization.azure.upbound.io/taasvstst-59      False    True    /subscriptions/.../roleAssignments/5bbccc07
2) $ kubectl describe roleassignment.authorization.azure.upbound.io/taasvstst-vc
   Status:
     Conditions:
       Type: Ready
       Status: True
       Reason: Available
       Type: Synced
       Status: False
       Reason: ReconcilePaused
       Last Transition Time: 2025-12-04T20:30:41Z

Thought:
- SYNCED=False but READY=True is NOT an error
- Reason: ReconcilePaused means Crossplane paused reconciliation (likely via annotation)
- The resource EXISTS and is HEALTHY in Azure (READY=True)
- This is intentional pausing, not a failure
- User's question is answered - explain paused state

Brain JSON:
{
  "thought": "Resources show SYNCED=False with Reason: ReconcilePaused. This means Crossplane intentionally paused reconciliation (common for managed resources). READY=True confirms the Azure resources exist and are healthy.",
  "plan": "Explain that ReconcilePaused is not an error - resources are healthy but reconciliation is paused.",
  "next_action": "respond",
  "final_response": "Your role assignments are healthy! They show SYNCED=False because reconciliation is **paused** (Reason: ReconcilePaused), but READY=True means the Azure resources exist and are working.\n\nThis is typically intentional - resources are often paused via the `crossplane.io/paused: 'true'` annotation to prevent changes during maintenance or to reduce API calls.\n\nIf you want to resume reconciliation, remove the pause annotation:\n```bash\nkubectl annotate roleassignment.authorization.azure.upbound.io/taasvstst-vc crossplane.io/paused-\n```"
}

---

EXAMPLE 10h: Multiple Azure Crossplane Providers - All Healthy
User: "List all Crossplane providers and show if any are failing"
Command History:
1) $ kubectl get providers.pkg.crossplane.io
   NAME                            INSTALLED   HEALTHY   PACKAGE                                                             AGE
   provider-azure-authorization      True        True      xpkg.upbound.io/upbound/provider-azure-authorization:v1.13          8d
   provider-azure-storage            True        True      xpkg.upbound.io/upbound/provider-azure-storage:v1.7                 8d
   provider-azure-keyvault           True        True      xpkg.upbound.io/upbound/provider-azure-keyvault:v1.13             8d
   provider-azure-sql                True        True      xpkg.upbound.io/upbound/provider-azure-sql:v1.13                  8d
   provider-azure-network            True        True      xpkg.upbound.io/upbound/provider-azure-network:v1.13              8d
   provider-helm                     True        True      xpkg.upbound.io/upbound/provider-helm:v0.21                       8d
   (22 more providers all showing INSTALLED=True HEALTHY=True)

Thought:
- User asked to list providers and check for failures
- ALL 26 providers show INSTALLED=True HEALTHY=True
- No failures found
- Answer is "all healthy" - no need to investigate further

Brain JSON:
{
  "thought": "All 26 Crossplane providers are installed and healthy. No failures detected.",
  "plan": "Report that all providers are healthy.",
  "next_action": "respond",
  "final_response": "All your Crossplane providers are healthy! Found 26 providers, all showing:\\n\\n✅ INSTALLED=True\\n✅ HEALTHY=True\\n\\nKey providers running:\\n- provider-azure-* family (20 Azure providers for different services)\\n- provider-helm\\n- provider-terraform\\n- crossplane-provider-castai\\n\\nNo issues detected - your Crossplane control plane is fully operational."
}

---

EXAMPLE 10i: Custom CRD with Custom State Field (CustomerClusterEnv)
User: "Check status of CustomerClusterEnv resources"
Command History:
1) $ kubectl api-resources | grep -i customer
   customerclusterenvs    [dedicated.uipath.com/v1alpha1](https://dedicated.uipath.com/v1alpha1)    true    CustomerClusterEnv
2) $ kubectl get customerclusterenvs.dedicated.uipath.com -A
   NAMESPACE    NAME        STATE        AGE
   taasvstst    taasvstst   EnvFailed    8d

Thought:
- Found CustomerClusterEnv custom CRD
- Resource shows STATE=EnvFailed (custom status field, not standard READY/SYNCED)
- User asked for status check - I have the answer
- STATUS shows failure, should describe to get error details

Brain JSON:
{
  "thought": "Found CustomerClusterEnv with STATE=EnvFailed. This is a custom CRD with non-standard status fields. Need to describe to see actual error message in status section.",
  "plan": "Describe the CustomerClusterEnv to check status for error details.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 10j: Crossplane Database Resources Discovery (MySQL, Cosmos, Redis)
User: "Find all Crossplane-managed databases in my cluster"
Command History:
1) $ kubectl get managed -A | grep -E '(postgres|sql|mysql|redis|cosmos)'
   rediscache.cache.azure.upbound.io/taasvstst             False    True    taasvstst           8d
   account.cosmosdb.azure.upbound.io/insights5807760       False    True    insights5807760     8d
   cassandracluster.cosmosdb.azure.upbound.io/taasvstst    False    True    taasvstst           8d
   flexibleserver.dbformysql.azure.upbound.io/taasvstst    False    True    taasvstst           8d
   flexibledatabase.dbformysql.azure.upbound.io/looker     False    True    looker              8d

Thought:
- User asked to FIND databases managed by Crossplane
- Found 5 database resources: Redis, Cosmos DB (2), MySQL server + database
- All show READY=True (resources exist and are healthy in Azure)
- All show SYNCED=False (likely ReconcilePaused as seen before)
- User's question "find databases" is ANSWERED - no need to describe each one

Brain JSON:
{
  "thought": "Found 5 Crossplane-managed databases across Redis, Cosmos DB, and MySQL. All are healthy (READY=True). SYNCED=False is expected (ReconcilePaused).",
  "plan": "List the discovered databases.",
  "next_action": "respond",
  "final_response": "Found 5 Crossplane-managed database resources:\n\n**Redis Cache:**\n- rediscache.cache.azure.upbound.io/taasvstst (Ready)\n\n**Cosmos DB:**\n- account.cosmosdb.azure.upbound.io/insights5807760 (Ready)\n- cassandracluster.cosmosdb.azure.upbound.io/taasvstst with datacenter (Ready)\n\n**MySQL:**\n- flexibleserver.dbformysql.azure.upbound.io/taasvstst (Ready)\n- flexibledatabase.dbformysql.azure.upbound.io/looker (Ready)\n\nAll databases are READY=True (healthy in Azure). SYNCED=False indicates paused reconciliation."
}

---

EXAMPLE 14: Istio VirtualService / DestinationRule routing issue
User: "Requests to /api fail, I think it's an Istio problem."
Command History:
1) $ kubectl get virtualservice -A | grep api
   istio-system    api-vs    1h
2) $ kubectl get destinationrule -A | grep api
   istio-system    api-dr    1h

Thought:
- We found relevant Istio resources.
- Need to describe and inspect hosts, subsets, and labels.
- Also check Service and Endpoints.

Plan:
- Ask worker to run:
  kubectl describe virtualservice api-vs -n istio-system && \
  kubectl describe destinationrule api-dr -n istio-system

Brain JSON:
{
  "thought": "The user suspects Istio. We must check VirtualService and DestinationRule routing and subsets.",
  "plan": "Describe the VS and DR for api and then correlate with Service/Endpoints.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 18: Prometheus ServiceMonitor not scraping
User: "My metrics aren't showing up in Prometheus."
Command History:
1) $ kubectl api-resources | grep -i monitor
   servicemonitors.monitoring.coreos.com
   podmonitors.monitoring.coreos.com
2) $ kubectl get servicemonitors -A | grep my-app
   monitoring    my-app-sm    10m

Thought:
- ServiceMonitor exists.
- Next: describe it and ensure its selector matches the Service.
- Also verify the Service has the right port name.

Plan:
- Ask worker to run:
  kubectl describe servicemonitor my-app-sm -n monitoring

Brain JSON:
{
  "thought": "ServiceMonitor exists; now we must check its selector and endpoints.",
  "plan": "Describe the ServiceMonitor to confirm it selects the correct Service and port.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 31: Direct OOMKilled diagnosis (instant solution)
User: "Why does this pod keep restarting?"
Command History:
1) $ kubectl describe pod api-6b8d -n payments
   ...
   State:        Terminated
     Reason:     OOMKilled
     Exit Code:  137
   ...

Thought:
- Output clearly shows OOMKilled.
- Root cause is memory limit too low or memory leak.
- We can respond immediately with fix suggestions.

Brain JSON:
{
  "thought": "Describe output shows OOMKilled with exit code 137.",
  "plan": "Explain that the pod is being killed due to memory limits and suggest increasing resources or investigating leaks.",
  "next_action": "respond",
  "final_response": "The pod is restarting because it is OOMKilled (Out Of Memory). In the describe output you can see 'Reason: OOMKilled, Exit Code: 137'. This means the container exceeded its memory limit. Fix: increase the container memory limit in the Deployment/StatefulSet spec, or reduce memory usage in the application. After updating the manifest, redeploy and verify the pod stays Running."
}

---

EXAMPLE 37: Service has no endpoints (selector mismatch)
User: "Why is my Service returning 503?"
Command History:
1) $ kubectl get svc -n web | grep checkout
   checkout-svc    ClusterIP    10.0.0.42    <none>    8080/TCP
2) $ kubectl describe svc checkout-svc -n web
   ...
   Endpoints: <none>
   Selector: app=checkout, tier=frontend
   ...

Thought:
- Endpoints are empty → Service has no backing pods.
- Root cause is usually label mismatch or pods not Ready.
- We can already respond with explanation.

Brain JSON:
{
  "thought": "The Service has Endpoints: <none>, which means it has no backing pods to route to.",
  "plan": "Explain that the Service selector doesn't match any Ready pods and how to fix labels/selectors.",
  "next_action": "respond",
  "final_response": "The 503 comes from the Service having no endpoints. In `kubectl describe svc checkout-svc -n web` you can see `Endpoints: <none>`. This means no pods with labels `app=checkout, tier=frontend` are Ready. Fix: ensure the Deployment pods have matching labels and are Ready, or update the Service selector to match the existing pods."
}

---

EXAMPLE 42: Cluster-wide health overview
User: "Is anything broken in my cluster right now?"
Command History:
1) $ kubectl get nodes
2) $ kubectl get pods -A | grep -v Running
3) $ kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp | tail -n 20

Thought:
- We collected a basic cluster overview.
- Now summarize node health, non-Running pods, and recent warnings.
- Respond with a concise health report.

Brain JSON:
{
  "thought": "We have a good overview of nodes, non-Running pods, and warnings. Time to summarize.",
  "plan": "Summarize node readiness, highlight problematic pods, and mention the most recent Warning events.",
  "next_action": "respond",
  "final_response": "Here is your cluster snapshot: Nodes: 3 (all Ready). Non-Running pods: 2 in namespace web (api-xyz in CrashLoopBackOff, worker-abc Pending). Recent warnings: FailedScheduling for worker-abc due to Insufficient CPU on all nodes. Next steps: either increase node resources or reduce requested CPU for worker-abc."
}

---

EXAMPLE 51: DNS / network issue
User: "My pod can't reach the database endpoint."
Command History:
1) $ kubectl logs api-7f9d -n web --tail=50
   ...
   dial tcp db.svc.cluster.local:5432: i/o timeout
   ...
2) $ kubectl get svc -n web | grep db
   db          ClusterIP    10.0.0.55    <none>    5432/TCP
3) $ kubectl get endpoints db -n web
   NAME    ENDPOINTS    AGE
   db      <none>       5m

Thought:
- DNS is resolving (we see db.svc.cluster.local), but Service has no endpoints.
- Root cause is the same as Service selector mismatch or pods not Ready.
- We can answer now.

Brain JSON:
{
  "thought": "Connection timeout combined with Service having no endpoints indicates no healthy DB pods behind the Service.",
  "plan": "Explain that the DB Service has no endpoints and suggest checking pod labels and readiness.",
  "next_action": "respond",
  "final_response": "Your API pod can't reach the DB because the `db` Service has no endpoints. `kubectl get endpoints db -n web` shows `<none>`, meaning no Ready pods match its selector. Fix: ensure the DB Deployment pods have the correct labels and are Running/Ready, or update the Service selector."
}

---

EXAMPLE 55: Admission webhook denial
User: "Why can't I apply this Deployment?"
Command History:
1) $ kubectl apply -f deploy.yaml
   Error from server (BadRequest): error when creating "deploy.yaml":
   admission webhook "policy.example.com" denied the request:
   containers must not run as root

Thought:
- The error clearly mentions an admission webhook and exact policy.
- Root cause is violating the policy (runAsNonRoot).
- We can respond with the exact fix.

Brain JSON:
{
  "thought": "Apply failed due to an admission webhook enforcing a 'must not run as root' policy.",
  "plan": "Explain that a ValidatingWebhook denies the Deployment and show how to set runAsNonRoot / securityContext.",
  "next_action": "respond",
  "final_response": "The Deployment is rejected by an admission webhook (`policy.example.com`) that forbids containers running as root. The error message says `containers must not run as root`. Fix: update your Pod template in deploy.yaml to set `securityContext.runAsNonRoot: true` and optionally `runAsUser` to a non-zero UID. Then apply again."
}

---

EXAMPLE 56: Expert grep - Find all unhealthy pods (multiple patterns)
User: "Show me all pods that are not healthy"
Command History:
(none)

Thought:
- User wants unhealthy pods - this means NOT Running and NOT Completed.
- Use grep -vE to exclude healthy states, or grep -E to match unhealthy ones.
- Case insensitive for safety. Show all namespaces.

Brain JSON:
{
  "thought": "Need to find pods that are NOT in healthy states. Use grep -vE to exclude Running and Completed, or grep -E for unhealthy patterns.",
  "plan": "Run `kubectl get pods -A | grep -vE 'Running|Completed'` to find all unhealthy pods.",
  "next_action": "delegate"
}

---

EXAMPLE 57: Expert grep - Search logs with context
User: "Find errors in the payment service logs"
Command History:
1) $ kubectl get pods -A | grep -i payment
   payments    payment-api-7d4f8b9c6-x2k9p    1/1     Running    0    2h

Thought:
- Found the pod. Now search logs for errors.
- Use -i for case insensitive, -E for multiple patterns, -C 3 for context.
- Add --since=30m to limit log volume.

Brain JSON:
{
  "thought": "Pod found. Now search logs for error patterns with context lines to understand what happened before/after.",
  "plan": "Run `kubectl logs -n payments payment-api-7d4f8b9c6-x2k9p --since=30m | grep -iE 'error|exception|fatal|panic' -C 3` to find errors with surrounding context.",
  "next_action": "delegate"
}

---

EXAMPLE 58: Expert grep - Find resources by partial name across namespaces
User: "Where is the checkout deployment?"
Command History:
(none)

Thought:
- User doesn't know the namespace. Use -A for all namespaces.
- Use -i for case insensitive since user may not know exact casing.
- Search deployments specifically.

Brain JSON:
{
  "thought": "User needs to locate a deployment by partial name. Search all namespaces with case-insensitive grep.",
  "plan": "Run `kubectl get deploy -A | grep -i checkout` to find the checkout deployment across all namespaces.",
  "next_action": "delegate"
}

---

EXAMPLE 59: Expert grep - Count errors in logs
User: "How many errors in the last hour for nginx?"
Command History:
1) $ kubectl get pods -A | grep -i nginx
   web         nginx-ingress-controller-abc123    1/1     Running    0    5d

Thought:
- Need to count errors, not list them. Use grep -c for count.
- Use --since=1h for time filter, -i for case insensitive.

Brain JSON:
{
  "thought": "User wants a count of errors. Use grep -c to count matches instead of listing them.",
  "plan": "Run `kubectl logs -n web nginx-ingress-controller-abc123 --since=1h | grep -ic error` to count error occurrences.",
  "next_action": "delegate"
}

---

EXAMPLE 60: Expert grep - Extract specific info with awk
User: "Which nodes are the payment pods running on?"
Command History:
(none)

Thought:
- Need pod-to-node mapping. Use -o wide to see node column.
- Grep for payment, then extract node column with awk.

Brain JSON:
{
  "thought": "Need to find which nodes host payment pods. Use -o wide and awk to extract the node column.",
  "plan": "Run `kubectl get pods -A -o wide | grep -i payment | awk '{{print $2, $8}}'` to show pod names and their nodes.",
  "next_action": "delegate"
}

---

EXAMPLE 61: Expert grep - Find pods with high restarts
User: "Show me pods that have restarted more than 5 times"
Command History:
(none)

Thought:
- Restart count is column 4 in kubectl get pods output.
- Use awk to filter where $4 > 5 (numeric comparison).
- Include header row for readability.

Brain JSON:
{
  "thought": "Need to filter by restart count. Use awk for numeric comparison on column 4.",
  "plan": "Run `kubectl get pods -A | awk 'NR==1 || $4 > 5'` to show header and pods with more than 5 restarts.",
  "next_action": "delegate"
}
"""
