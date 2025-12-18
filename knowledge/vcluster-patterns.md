# vCluster Patterns

## What is vCluster?

vCluster creates fully functional virtual Kubernetes clusters inside a host cluster. Each virtual cluster runs inside a regular namespace and has its own API server, controller manager, and data store.

## How to List vClusters

vClusters are implemented as StatefulSets with the label `app=vcluster`. To list all vclusters:

```bash
kubectl get statefulsets -A -l "app=vcluster"
```

This will show:
- **NAMESPACE**: The namespace where the vcluster is running
- **NAME**: The name of the vcluster
- **READY**: Number of ready pods (usually 1/1)
- **AGE**: How long the vcluster has been running

## Example Output

```
NAMESPACE   NAME                 READY   AGE
taasvstst   management-cluster   1/1     11d
```

## Common vCluster Commands

### List all vclusters
```bash
kubectl get statefulsets -A -l "app=vcluster"
```

### Get vcluster details
```bash
kubectl get statefulset <vcluster-name> -n <namespace> -o yaml
```

### List vcluster pods
```bash
kubectl get pods -n <namespace> -l "app=vcluster,release=<vcluster-name>"
```

### Check vcluster status
```bash
kubectl get pods -n <namespace> -l "app=vcluster"
```

## Important Notes

- **NO CRD**: vCluster does NOT create a `virtualclusters` or `vclusters` CRD. It uses standard Kubernetes resources (StatefulSets, Services, Secrets).
- **Label-based discovery**: Always use label selectors to find vclusters: `-l "app=vcluster"`
- **Per-namespace isolation**: Each vcluster runs in its own namespace
- **Access**: To connect to a vcluster: `vcluster connect <vcluster-name> -n <namespace>`
