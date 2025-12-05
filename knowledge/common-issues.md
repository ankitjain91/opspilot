# Common Kubernetes Issues & Solutions

## CrashLoopBackOff
**Symptom**: Pod status is `CrashLoopBackOff`.
**Causes**:
1. Application error (check logs).
2. Misconfiguration (missing env vars, wrong config file).
3. Liveness probe failing.
**Solution**:
- Run `kubectl logs -p <pod>` to see previous logs.
- Check exit code: `137` = OOM (increase limits), `1` = App Error.
- Fix configuration or increase resources.

## ImagePullBackOff / ErrImagePull
**Symptom**: Pod status is `ImagePullBackOff`.
**Causes**:
1. Image name/tag is wrong.
2. Image does not exist.
3. Missing image pull secret (for private registries).
**Solution**:
- Verify image name on DockerHub/Registry.
- Check if secret exists: `kubectl get secrets`.
- Patch service account or pod with `imagePullSecrets`.

## Pending
**Symptom**: Pod stays in `Pending` state.
**Causes**:
1. Insufficient cluster resources (CPU/Memory).
2. Taints/Tolerations mismatch.
3. Node affinity rules not met.
**Solution**:
- Run `kubectl describe pod <pod>` and look at "Events".
- If "Insufficient cpu/memory", scale up cluster or reduce requests.
- If "Taint", add toleration to pod.

## OOMKilled
**Symptom**: Pod restarts with exit code 137.
**Causes**:
- Container used more memory than the limit.
**Solution**:
- Check current usage: `kubectl top pod`.
- Increase memory limit in Deployment YAML.
- Debug memory leak in application.

## Service Connection Refused
**Symptom**: Cannot connect to service IP/DNS.
**Causes**:
1. Selector mismatch (Service selector != Pod labels).
2. Application not listening on the configured port.
3. Network Policy blocking traffic.
**Solution**:
- Check endpoints: `kubectl get endpoints <service>`. If empty, fix selector.
- Check targetPort matches container port.
