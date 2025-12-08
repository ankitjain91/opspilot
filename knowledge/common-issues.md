### Common Kubernetes Issues Cheat Sheet

- CrashLoopBackOff: Logs/describe; exit codes (1 app, 127 cmd, 137 OOM); fix app/config/limits.
- ImagePullBackOff: Describe pod events; fix image:tag, pull secrets, registry reachability, CA.
- Pending/Unschedulable: Describe pod events; fix resources, selectors/affinity, taints/tolerations, PVCs.
- Service 503/no endpoints: GET_ENDPOINTS; fix selector/readiness/ports; check NetworkPolicy.
- DNS failures: CoreDNS health; nslookup from debug pod; endpoints; NetworkPolicy for DNS/app ports.
- OOMKilled: Describe pod; top usage vs limits; raise limits or fix leaks; check node pressure.
- RBAC forbidden: kubectl auth can-i; ensure proper Role/ClusterRole + binding; set serviceAccount.
- Namespace terminating: List finalizers; fix controller; patch finalizers if safe.
- Webhook errors: Service/CABundle; endpoints; certs; remove stale webhook if backend gone.
- Helm failures: Inspect hook jobs; CRD conflicts; immutable fields; rerun with fixes.
