# Kubernetes IDE – Full Feature Specification (Lens-Level Parity + Enhancements)

## 1. Overview

This project aims to build a **Kubernetes management IDE** that fully replicates and surpasses the capabilities of **Lens**, including:

- Multi-cluster management  
- Full Kubernetes resource navigation  
- Real-time dashboards and metrics  
- CRD (CustomResourceDefinition) support  
- Logging, metrics, port-forwarding, Helm management  
- RBAC visibility and security awareness  
- Extensibility via plugins/apps  
- Optional AI-assisted insights

The UI should feel like a **desktop-grade rich IDE** (Lens-like), but may be implemented as:
- Desktop app (Electron or similar), or
- Web app with a companion local agent.

This document is intended to be consumed by an **agent** that will generate code, architecture, and implementation details.

---

## 2. High-Level Goals

1. **Feature parity with Lens** for all core k8s resources and workflows.
2. **Improved UX** with clearer navigation, better search, and richer visualizations.
3. **Extensibility** via a plugin / extension framework.
4. **Deep CRD support** via schema-based forms and generic resource views.
5. **Observability integration** (metrics, logs, events, alerts).
6. **Performance**: must handle medium–large clusters gracefully.
7. **Security-aware and RBAC-aware UI**, never suggesting actions user cannot perform.

---

## 3. Architecture Requirements

### 3.1 Frontend

- Recommended: **React + TypeScript** (or similar modern framework).
- Component-based architecture with:
  - Layout: Sidebar, top bar, content pane.
  - Resource tables, detail panels, dialogs for actions.
  - Virtualized lists for large datasets.
- Global state management:
  - Selected cluster & context.
  - Selected namespace(s).
  - Active resource type and filters.
- Real-time updates:
  - WebSockets or SSE from backend for watch streams.
- Plugin/extension points:
  - Add new sidebar items.
  - Add new resource views.
  - Inject custom panels into resource detail views.

### 3.2 Backend

- Can be Node.js (TypeScript), Go, or Python-based.
- Responsibilities:
  - Connect to Kubernetes clusters (via kubeconfig / tokens).
  - Wrap k8s API calls and watches in a stable API.
  - Manage port-forwards, exec/shell, and logs streaming.
  - Integrate with Helm (via CLI or library).
  - Integrate with Prometheus/Grafana/Alertmanager (optional).
  - Provide plugin backend hooks.

### 3.3 Cluster Access

- Support multiple kubeconfigs.
- Auto-detect contexts and clusters from:
  - `~/.kube/config`
  - Custom kubeconfig paths.
- Potential provider integrations:
  - EKS, AKS, GKE (retrieving kubeconfig via cloud API).
- Connection health checking:
  - API server reachable.
  - Auth successful.
  - Version detection.

### 3.4 Real-Time Watch Support

- Use k8s **watch** APIs to avoid polling.
- Maintain a resource cache per cluster.
- Push updates to frontend via WebSocket/SSE channels.

---

## 4. Cluster Catalog

### 4.1 Features

- List of all known clusters:
  - Name (from kubeconfig context).
  - Cluster alias (user-defined).
  - Status: online, offline, error.
  - Kubernetes version (if reachable).
- Grouping and tagging:
  - Tags: “prod”, “staging”, “dev”, etc.
- Actions:
  - Select active cluster.
  - Rename cluster.
  - Remove cluster from catalog (does not delete the real cluster).
- Persisted locally (e.g., JSON config file or local DB).

---

## 5. Cluster Overview Dashboard

### 5.1 Overview Layout

- Summary cards:
  - Cluster name, version.
  - Node count.
  - Namespace count.
  - API URL.
- Health cards:
  - Nodes: Ready / NotReady.
  - Pods: Running / Pending / Failed.
  - Workloads: Deployments / StatefulSets / DaemonSets / Jobs / CronJobs.
- Metrics (if Prometheus configured):
  - CPU usage (current & historical).
  - Memory usage (current & historical).
  - Cluster capacity vs usage.

### 5.2 Quick Navigation

- Clickable counts to jump into:
  - Nodes view.
  - Workloads → specific resource types.
  - Events.
  - Namespaces.

---

## 6. Nodes

### 6.1 Nodes List View

Table columns:
- Node name.
- Roles (e.g., control-plane, worker).
- Status (Ready, NotReady).
- Age.
- CPU capacity and usage.
- Memory capacity and usage.
- Kubernetes version.

Filters:
- Status filter.
- Label filter.
- Text search.

### 6.2 Node Detail View

Tabs:

1. **Summary**
   - Metadata: labels, annotations.
   - Node conditions.
   - Capacity and allocatable resources.
   - OS image, kernel version, kubelet version.
2. **Pods on Node**
   - List of pods scheduled on this node.
   - Click-through to pod details.
3. **Metrics**
   - CPU, memory, disk, network usage charts (requires metrics integration).
4. **Events**
   - Events related to this node.
5. **YAML**
   - Full YAML with edit capability (if RBAC allows).

### 6.3 Node Actions

- Cordon / uncordon.
- Drain with options:
  - Ignore DaemonSets.
  - Delete local data.
- Edit labels.
- Edit taints.

---

## 7. Workloads

Workloads section includes:

- Pods.
- Deployments.
- ReplicaSets.
- StatefulSets.
- DaemonSets.
- Jobs.
- CronJobs.

### 7.1 Common Behavior for All Workload Types

**List views**:

- Table columns appropriate to resource type.
- Namespace filter.
- Status filter (where applicable).
- Label selector filter.
- Text search.
- “All namespaces” toggle.

**Detail views**:

Tabs:

1. **Summary**
   - Key fields (replicas, strategy, selectors, etc.).
   - High-level health status.
2. **YAML**
   - Editable YAML (with RBAC check).
3. **Events**
   - Events targeting this resource or its pods.
4. **Metrics**
   - Pod-level CPU/memory (via metrics backend).
5. **Relationships**
   - OwnerReferences.
   - Controlled pods / lower-level resources.

**Actions (generic)**:

- Edit (YAML).
- Delete.
- Scale (for scalable controllers).
- Restart (if semantics make sense, e.g., rollout restart or delete pods).

---

### 7.2 Pods

#### 7.2.1 Pods List

Columns:
- Name.
- Namespace.
- Ready containers vs total.
- Status.
- Restarts.
- Node.
- Age.

Actions per row:
- View logs.
- Exec into container.
- Port-forward.
- Open detail view.

#### 7.2.2 Pod Detail Tabs

1. **Summary**
   - Phase, pod IP, node.
   - Labels and annotations.
   - Container statuses.
   - Init containers.
   - Volume mounts.
2. **Containers**
   - For each container:
     - Image, command, args.
     - Resources (requests/limits).
     - Probes (liveness/readiness/startup).
3. **Logs**
   - Container selector.
   - Tail/follow.
   - Time-range selection.
   - Search within logs.
4. **Events**
5. **Metrics**
6. **YAML**

#### 7.2.3 Pod Actions

- Exec (interactive shell).
- Logs (follow).
- Port-forward.
- Delete (respecting RBAC).
- Copy files (optional enhancement).

---

### 7.3 Deployments

- List columns:
  - Name, namespace.
  - Desired / current / available replicas.
  - Age.
- Summary:
  - Strategy (RollingUpdate/Recreate).
  - Selector.
  - Template information.
  - Related ReplicaSets.
- Actions:
  - Scale (set replicas).
  - Rollout restart.
  - Rollout status.
  - Edit YAML.

---

### 7.4 StatefulSets

- Highlight:
  - VolumeClaimTemplates.
  - Pod index and per-pod status.
- Actions:
  - Scale.
  - Edit YAML.

---

### 7.5 DaemonSets

- Show:
  - Desired / current / ready pods.
  - Node coverage.
- Actions:
  - Rollout restart.
  - Edit YAML.

---

### 7.6 Jobs & CronJobs

- Job list:
  - Completions, active, failed, start/finish times.
- CronJob:
  - Schedule, suspend flag, last schedule time.
- Actions:
  - Suspend/resume cronjob.
  - Delete active jobs.

---

## 8. Configuration

Configuration section includes:

- ConfigMaps.
- Secrets.
- HorizontalPodAutoscalers.
- PodDisruptionBudgets.
- ResourceQuotas.
- LimitRanges.
- RuntimeClass.
- (Optional) PodSecurityPolicy (if cluster still uses it).

### 8.1 ConfigMaps

- List: name, namespace, data count, age.
- Detail:
  - Key-value editor.
  - YAML.
- Actions:
  - Edit.
  - Delete.
  - Duplicate.

### 8.2 Secrets

- List: name, namespace, type, age.
- Values masked by default.
- Option to temporarily reveal individual keys (with warning).
- YAML editing with RBAC check.

### 8.3 HPAs

- Show:
  - Target resource.
  - Min/max replicas.
  - Current replicas.
  - Metric(s) used (CPU %, custom metrics).
- Graphs for HPA behavior over time (optional).

### 8.4 Quotas & LimitRanges

- Display per namespace:
  - Quotas: used vs hard.
  - LimitRanges: default requests/limits.

---

## 9. Network

Network section includes:

- Services.
- Ingress.
- Endpoints / EndpointSlices.
- NetworkPolicies.

### 9.1 Services

- List: name, namespace, type (ClusterIP, NodePort, LoadBalancer), cluster IP, ports, age.
- Detail:
  - Selector.
  - Endpoint list and readiness.
  - Linked pods.
- Actions:
  - Port-forward service.
  - Jump to backing pods.

### 9.2 Ingress

- List: name, namespace, hosts, TLS enabled, age.
- Detail:
  - Rules (host, path, backend).
  - TLS configuration.
  - Events (e.g., from ingress controller).

### 9.3 NetworkPolicy

- Detail:
  - Pod selector.
  - Ingress rules (from, ports).
  - Egress rules.
- Optional visualization:
  - Basic network map of allowed ingress/egress.

---

## 10. Storage

Storage section includes:

- PersistentVolumes (PVs).
- PersistentVolumeClaims (PVCs).
- StorageClasses.
- VolumeSnapshots (if CRD exists).

### 10.1 PVs

- List: name, capacity, access modes, reclaim policy, status, storage class.
- Detail:
  - ClaimRef.
  - Node affinity (if any).
  - Events.

### 10.2 PVCs

- List: name, namespace, status, bound PV, requested storage, storage class.
- Detail:
  - Mounted by which pods (resolve via pod.spec.volumes).
  - Events.

### 10.3 StorageClasses

- Provisioner.
- Parameters.
- Reclaim policy.
- Volume binding mode.

---

## 11. Namespaces & RBAC

### 11.1 Namespaces

- List of namespaces:
  - Name, status, age.
- Detail:
  - Labels and annotations.
  - ResourceQuotas & LimitRanges in that namespace.
- Actions:
  - Create namespace.
  - Delete namespace.

### 11.2 RBAC Resources

Include:

- Roles.
- ClusterRoles.
- RoleBindings.
- ClusterRoleBindings.
- ServiceAccounts.

For each:

- List view.
- Detail view:
  - For Roles/ClusterRoles: rules (verbs, resources, resourceNames).
  - For Bindings: subjects and roleRef.
  - For ServiceAccounts: secrets, imagePullSecrets.

### 11.3 RBAC Graph (Advanced)

- Visual graph showing:
  - SA → RoleBinding → Role → permissions.
- Ability to answer:
  - “What can this ServiceAccount do?”

---

## 12. Events

### 12.1 Global Events View

- Streaming events list with:
  - Timestamp.
  - Type (Normal/Warning).
  - Involved object.
  - Message.
- Filters:
  - Namespace.
  - Type.
  - Text search.

### 12.2 Per-Resource Events

- Each resource detail page:
  - Events tab filtered for that resource.

---

## 13. Logging

### 13.1 Pod Logs

- Container selection dropdown.
- Features:
  - Tail/follow.
  - Select time range or `sinceSeconds`.
  - Search in logs.
  - Wrap/nowrap.
- Optional:
  - Multi-pod log view: show logs from multiple pods of a deployment with filters.

---

## 14. Exec & Terminal Integration

### 14.1 In-Cluster Exec

- Open an interactive terminal in a pod container.
- Shell selection (sh/bash/pwsh if present).
- Handles disconnect/reconnect gracefully.

### 14.2 Local Terminal (kubectl)

- Integrated terminal pane bound to the current kubeconfig context.
- User can run kubectl or other CLI tools.
- Command history per cluster.

---

## 15. Port Forwarding

- Ability to port-forward:
  - Pod ports.
  - Service ports.
- Show active port-forwards:
  - Resource, local port, remote port, state.
- Support:
  - Multiple forwards concurrently.
  - Auto-reconnect on connection loss.

---

## 16. Helm Integration

### 16.1 Repositories

- List repos.
- Add repo (name + URL).
- Remove repo.
- Update repo index.

### 16.2 Chart Browser

- Search charts.
- View chart details:
  - README.
  - Versions.
  - Maintainers.
- Install chart:
  - Target namespace.
  - Provide values (YAML editor and optional form).
- Upgrade and rollback existing releases.

### 16.3 Releases

- List releases:
  - Name, namespace, chart, version, status.
- Detail:
  - History of revisions.
  - Resources created by the release (link to those resources).
- Actions:
  - Upgrade.
  - Rollback.
  - Delete release.

---

## 17. CRD Support

### 17.1 Automatic Discovery

- Fetch all CRDs from `apiextensions.k8s.io`.
- For each CRD:
  - Register a resource type in the UI automatically.
- Provide generic:
  - List view.
  - Detail view with YAML and events.

### 17.2 Schema-Based Rendering (Advanced)

- Parse `openAPIV3Schema` from CRDs.
- Generate forms for creating/editing custom resources.
- Validate against schema on client-side if possible.

---

## 18. Observability Integrations (Optional but Recommended)

### 18.1 Prometheus

- Configure Prometheus endpoint.
- Use metrics for:
  - Node usage.
  - Pod usage.
  - Workload-level metrics.

### 18.2 Grafana

- Link to Grafana dashboards.
- Optionally show embedded panels.

### 18.3 Alertmanager

- Fetch current alerts.
- Show alerts in:
  - Cluster overview.
  - Resource details (filtered by labels).

---

## 19. Advanced Features to Surpass Lens

### 19.1 Topology Graph

- Visual graph of:
  - Workloads → Pods → Services → Ingress.
  - PVC → PV → StorageClass.
- Show edges based on:
  - Selectors.
  - OwnerReferences.
- Clickable nodes → open detail views.

### 19.2 GitOps Integration

- Detect ArgoCD/Flux resources.
- Show:
  - Sync status (Synced, OutOfSync).
  - Last commit/author.
- Show drift:
  - Desired vs live manifests.

### 19.3 Security & Policy

- Integrate with:
  - Trivy (image scanning) or similar.
  - OPA Gatekeeper / Kyverno:
    - Show violations per resource.
- Risk score per namespace or workload.

### 19.4 AI-Assisted Insights (Optional)

- Natural language queries over cluster state:
  - “Why is this deployment not ready?”
  - “Show me pods that keep crashing.”
- Auto-summarization of cluster health.

---

## 20. Extension / Plugin Framework

### 20.1 Frontend Extensions

- Allow plugins to:
  - Add new sidebar sections.
  - Add new pages.
  - Add pipelines into detail tabs (e.g., extra panels on Pod detail).

### 20.2 Backend Extensions

- Plugin API for backend:
  - Register new routes.
  - Call out to external services.
  - Add custom resource handlers.

### 20.3 Plugin Packaging

- Standard manifest format:
  - Name, version, author.
  - Frontend entrypoint.
  - Backend entrypoint (optional).

---

## 21. UX & Usability Requirements

- Global search for resources.
- Breadcrumbs for navigation.
- Keyboard shortcuts:
  - Switch cluster.
  - Open search.
  - Switch resource type.
- Themes:
  - Dark mode.
  - Light mode.
- Tabbed interface:
  - Multiple resources open in tabs like an IDE.

---

## 22. Performance Requirements

- Efficient rendering of:
  - Thousands of pods.
  - Hundreds of nodes.
- Use virtualized tables for large datasets.
- Debounced search and filtering.
- Cache and reuse API responses where possible.

---

## 23. Security Requirements

- Respect Kubernetes RBAC on all operations.
- Gray-out or hide actions the user cannot perform.
- Mask secret data by default.
- Secure local storage of kubeconfigs and tokens.
- Provide clear warning when connecting to remote clusters or exposing ports.

---

## 24. MVP Cut

**Minimum Viable Product** should include:

- Multi-cluster catalog and switching.
- Cluster overview.
- Nodes.
- Workloads (Pods, Deployments, Jobs, CronJobs, StatefulSets, DaemonSets, ReplicaSets).
- ConfigMaps & Secrets.
- Services & Ingress.
- PVs, PVCs, StorageClasses.
- Namespaces.
- Events.
- Pod logs & exec.
- Port-forward.
- Basic Helm (list, install, delete).
- Basic CRD generic support.
- YAML editor for all resources.

---

## 25. Deliverables Expected from the Agent

The agent consuming this document should produce:

1. **Frontend design & component hierarchy.**
2. **Backend API design and endpoints.**
3. **Kubernetes client abstraction layer.**
4. **Data models / TypeScript interfaces for k8s resources.**
5. **Implementation of resource list/detail views for all types listed.**
6. **Watch/streaming mechanism for resource updates.**
7. **Port-forward, exec, logs streaming infrastructure.**
8. **Helm integration module.**
9. **CRD discovery and generic UI module.**
10. **Extensibility / plugin system skeleton.**
11. **Auth/RBAC awareness handling.**
12. **Build & run instructions (for local and production).**

---

## 26. Future Extensions (Optional)

- Cluster cost estimation.
- Time-travel view of resources.
- Self-healing suggestions.
- Integration with CI/CD pipelines for deployments.
- Multi-tenant mode (teams, permissions, sharing).