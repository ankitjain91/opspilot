# Lens Killer – Real-Time Dependency Graph (Live Topology Intelligence)

## Goal

Implement a **real-time Kubernetes dependency graph** view that:

- Shows **namespaces, nodes, services, workloads, pods, storage, ingress** etc.
- Visualizes **relationships** (Ingress → Service → Pod → Node → PVC → PV → StorageClass).
- Updates periodically (polling-based v1).
- Integrates cleanly with existing **Tauri backend** and **React/TypeScript frontend**.
- Reuses existing `invoke("list_resources", ...)` patterns and React Query.

This spec defines:

1. A **shared graph model** (nodes + edges).
2. A **Tauri backend command**: `get_topology_graph`.
3. Relationship inference rules (how to build edges).
4. A **React component** `TopologyView` using React Flow.
5. Wiring into the existing dashboard/sidebar as a new “Topology” section.

Copilot: implement all of this spec in the repo in one go.

---

## 1. Shared Types: Topology Graph Model

Create a shared TypeScript definitions file, for example:

- `src/types/topology.ts`

These types will be used on the **frontend** and mirrored logically in the Tauri backend (Rust).

```ts
// src/types/topology.ts

export type TopologyNodeKind =
  | "Namespace"
  | "Node"
  | "Pod"
  | "Deployment"
  | "ReplicaSet"
  | "StatefulSet"
  | "DaemonSet"
  | "Job"
  | "CronJob"
  | "Service"
  | "Ingress"
  | "EndpointSlice"
  | "PVC"
  | "PV"
  | "StorageClass"
  | "ConfigMap"
  | "Secret"
  | "HPA"
  | "CrossplaneComposite"
  | "CrossplaneManaged"
  | "ExternalResource";

export type TopologyStatus =
  | "Healthy"
  | "Degraded"
  | "Failed"
  | "Pending"
  | "Unknown";

export interface TopologyNode {
  id: string;                    // globally unique, ex: "Pod/default/nginx-123"
  kind: TopologyNodeKind;
  name: string;
  namespace?: string;
  status?: TopologyStatus;
  labels?: Record<string, string>;
  extra?: Record<string, any>;   // pod nodeName, replicas, etc.
}

export type TopologyEdgeType =
  | "owns"           // e.g. Deployment -> ReplicaSet, ReplicaSet -> Pod
  | "selects"        // Service -> Pod
  | "routes_to"      // Ingress -> Service
  | "mounts"         // Pod -> PVC
  | "backs"          // PVC -> PV, PV -> StorageClass
  | "provisions"     // Crossplane -> managed resource
  | "runs_on"        // Pod -> Node
  | "controlled_by"; // HPA -> Deployment, etc.

export interface TopologyEdge {
  id: string;
  from: string;                  // node.id
  to: string;                    // node.id
  type: TopologyEdgeType;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: string;           // ISO timestamp
}
```

Backend will construct this shape and send it via `invoke("get_topology_graph")`.

---

## 2. Backend: `get_topology_graph` Tauri Command

### 2.1. New command

In the Tauri backend (Rust), add a new command:

- Name: `get_topology_graph`
- Returns: `TopologyGraph` (Rust struct mirroring the TS model)
- Implementation:
  - Use existing Kubernetes client + `list_resources`-like logic.
  - Fetch relevant resources.
  - Convert them into nodes.
  - Derive edges using the rules below.

### 2.2. Rust structs

Create Rust structs that match the TS model (you can place them near other API types):

```rs
// Rust pseudo-code, place in a suitable module, derive serde Serialize.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub status: Option<String>, // "Healthy" | "Degraded" | ...
    pub labels: Option<std::collections::HashMap<String, String>>,
    pub extra: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub r#type: String, // "owns", "selects", ...
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyGraph {
    pub nodes: Vec<TopologyNode>,
    pub edges: Vec<TopologyEdge>,
    pub generated_at: String,
}
```

### 2.3. Helper: node ID function

Add a helper to build stable IDs:

```rs
fn topo_node_id(kind: &str, namespace: Option<&str>, name: &str) -> String {
    match namespace {
        Some(ns) => format!("{}/{}/{}", kind, ns, name),
        None => format!("{}/{}", kind, name),
    }
}
```

### 2.4. Fetch resources

Inside `get_topology_graph`, fetch at least:

- Namespaces
- Nodes
- Pods
- Deployments
- ReplicaSets
- StatefulSets
- DaemonSets
- Jobs
- Services
- Ingresses
- PVCs
- PVs
- StorageClasses

Use your existing `list_resources` helper or the underlying client you already have wired.

Pseudo-code:

```rs
#[tauri::command]
pub async fn get_topology_graph() -> Result<TopologyGraph, String> {
    // 1. Fetch raw resources (API calls)
    let namespaces = list_namespaces().await.map_err(|e| e.to_string())?;
    let nodes      = list_nodes().await.map_err(|e| e.to_string())?;
    let pods       = list_pods_all_namespaces().await.map_err(|e| e.to_string())?;
    let svcs       = list_services_all_namespaces().await.map_err(|e| e.to_string())?;
    let ingresses  = list_ingresses_all_namespaces().await.map_err(|e| e.to_string())?;
    let deployments= list_deployments_all_namespaces().await.map_err(|e| e.to_string())?;
    let replicasets= list_replicasets_all_namespaces().await.map_err(|e| e.to_string())?;
    let stateful   = list_statefulsets_all_namespaces().await.map_err(|e| e.to_string())?;
    let daemonsets = list_daemonsets_all_namespaces().await.map_err(|e| e.to_string())?;
    let pvcs       = list_pvcs_all_namespaces().await.map_err(|e| e.to_string())?;
    let pvs        = list_pvs().await.map_err(|e| e.to_string())?;
    let storagecls = list_storageclasses().await.map_err(|e| e.to_string())?;

    // 2. Build nodes
    let mut nodes_vec: Vec<TopologyNode> = Vec::new();
    let mut edges_vec: Vec<TopologyEdge> = Vec::new();

    // Convert each k8s resource type -> TopologyNode and push into nodes_vec
    // Use derive_* helper functions to compute "status" field where possible.

    // 3. Infer edges using rules below.

    let graph = TopologyGraph {
        nodes: nodes_vec,
        edges: edges_vec,
        generated_at: chrono::Utc::now().to_rfc3339(),
    };

    Ok(graph)
}
```

Copilot: wire the `list_*` calls using whatever abstraction is already present (`invoke("list_resources")` equivalent on backend).

---

## 3. Relationship Rules (Edges)

Below are the explicit rules the backend must implement when constructing `TopologyEdge`s.

### 3.1. Ownership (`owns`)

Use `metadata.ownerReferences` to connect controllers to their children:

- **Deployment → ReplicaSet**
- **ReplicaSet → Pod**
- **StatefulSet → Pod**
- **DaemonSet → Pod**
- **Job → Pod**

For each resource with `ownerReferences`:

```rs
fn add_owner_edges(
    edges: &mut Vec<TopologyEdge>,
    child_kind: &str,
    child_ns: Option<&str>,
    child_name: &str,
    owner_refs: &[OwnerReference],
) {
    let child_id = topo_node_id(child_kind, child_ns, child_name);
    for owner in owner_refs {
        let parent_id = topo_node_id(&owner.kind, child_ns, &owner.name);
        edges.push(TopologyEdge {
            id: format!("{}->{}", parent_id, child_id),
            from: parent_id,
            to: child_id.clone(),
            r#type: "owns".into(),
        });
    }
}
```

Call this helper for Pods, ReplicaSets, etc.

---

### 3.2. Service `selects` Pods

For each Service:

- Get `spec.selector` (map of labels).
- In same namespace, find Pods whose labels **match** the selector.
- Add `Service (from) -> Pod (to)` edges with type `"selects"`.

```rs
fn labels_match(
    pod_labels: &std::collections::HashMap<String, String>,
    selector: &std::collections::HashMap<String, String>,
) -> bool {
    selector.iter().all(|(k, v)| pod_labels.get(k) == Some(v))
}
```

Edge creation:

```rs
let svc_id = topo_node_id("Service", svc.metadata.namespace.as_deref(), &svc.metadata.name);

for pod in &pods {
    if pod.metadata.namespace == svc.metadata.namespace {
        if let Some(pod_labels) = &pod.metadata.labels {
            if labels_match(pod_labels, svc.spec.selector.as_ref().unwrap_or(&Default::default())) {
                let pod_id = topo_node_id("Pod", pod.metadata.namespace.as_deref(), &pod.metadata.name);
                edges_vec.push(TopologyEdge {
                    id: format!("{}->{}", svc_id, pod_id),
                    from: svc_id.clone(),
                    to: pod_id,
                    r#type: "selects".into(),
                });
            }
        }
    }
}
```

---

### 3.3. Ingress `routes_to` Service

For each Ingress:

- For each `rule.http.paths[].backend.service.name`
- Or `spec.defaultBackend.service.name`
- Add `Ingress -> Service` edges with type `"routes_to"`.

---

### 3.4. Pod `mounts` PVC, PVC `backs` PV, PV `backs` StorageClass

**Pod → PVC**:

- For each volume in `pod.spec.volumes` with a `persistentVolumeClaim`:
  - Add edge Pod (from) → PVC (to), type `"mounts"`.

**PVC → PV**:

- If `pvc.spec.volumeName` is set, connect PVC → PV with type `"backs"`.

**PV → StorageClass**:

- If `pv.spec.storageClassName` is set, connect PV → StorageClass with type `"backs"`.

---

### 3.5. Pod `runs_on` Node

If `pod.spec.nodeName` is set, add edge:

- Pod (from) → Node (to), type `"runs_on"`.

---

### 3.6. HPA `controlled_by` Workload (optional v1)

If you also fetch HPAs:

- For each HPA: parse `spec.scaleTargetRef` (kind + name + namespace).
- Connect HPA (from) → target workload (to), type `"controlled_by"`.

---

### 3.7. Crossplane (optional phase 2)

Later, add:

- Crossplane Composites → composed resources (via ownerReferences).
- Managed resources → synthetic `ExternalResource` nodes based on `status.atProvider`.

For now, leave this as a TODO for Copilot.

---

## 4. Node Status Derivation (Basic)

Basic v1 status derivation rules:

- **Pod**:
  - If phase = `Running`, ready condition true → `Healthy`
  - If phase = `Pending` → `Pending`
  - If phase = `Failed` → `Failed`
  - Else → `Unknown`

- **Deployment**:
  - If `.status.availableReplicas == .spec.replicas` → `Healthy`
  - If `.status.availableReplicas < .spec.replicas` → `Degraded`

- **StatefulSet / DaemonSet**:
  - Similar: compare desired vs ready replicas.

- **Service / Ingress / PVC / PV / StorageClass / Node**:
  - For v1, you can set `status: "Unknown"` or implement simple checks
    (e.g. Node Ready condition).

Implement helper functions like:

```rs
fn derive_pod_status(pod: &k8s_openapi::api::core::v1::Pod) -> String { /* ... */ }
fn derive_deployment_status(dep: &apps::Deployment) -> String { /* ... */ }
```

And assign `node.status = Some("Healthy".into())` etc.

---

## 5. Frontend: TopologyView Component

Use **React Flow** to render the graph.

### 5.1. Install dependency (if not already)

In the frontend:

```bash
npm install reactflow
# or
pnpm add reactflow
```

### 5.2. New component: `TopologyView.tsx`

Create:

- `src/components/TopologyView.tsx`

This component:

- Calls `invoke("get_topology_graph")` using React Query.
- Maps `TopologyGraph` → React Flow nodes + edges.
- Shows loading/error states.
- On node click, optionally trigger selection to integrate with existing detail panel later.

```tsx
// src/components/TopologyView.tsx

import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import ReactFlow, {
  Background,
  Controls,
  Node as RFNode,
  Edge as RFEdge,
} from "reactflow";
import "reactflow/dist/style.css";
import type { TopologyGraph, TopologyNode, TopologyEdge } from "../types/topology";
import { Loader2, AlertCircle } from "lucide-react";

function nodeStatusColor(status?: string): string {
  switch (status) {
    case "Healthy":
      return "#22c55e"; // green
    case "Degraded":
      return "#facc15"; // yellow
    case "Failed":
      return "#f97373"; // red
    case "Pending":
      return "#38bdf8"; // blue
    default:
      return "#9ca3af"; // gray
  }
}

function kindGroup(kind: string): number {
  // Used to roughly group nodes vertically by layer.
  switch (kind) {
    case "Ingress":
      return 0;
    case "Service":
      return 1;
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
    case "Job":
    case "CronJob":
      return 2;
    case "Pod":
      return 3;
    case "PVC":
    case "PV":
    case "StorageClass":
      return 4;
    case "Node":
      return 5;
    default:
      return 6;
  }
}

export function TopologyView() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["topology_graph"],
    queryFn: async () => {
      const graph = await invoke<TopologyGraph>("get_topology_graph");
      return graph;
    },
    refetchInterval: 15000,
  });

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!data) return { rfNodes: [] as RFNode[], rfEdges: [] as RFEdge[] };

    const spacingX = 240;
    const spacingY = 160;

    const groupedByKind: Record<string, TopologyNode[]> = {};
    for (const node of data.nodes) {
      if (!groupedByKind[node.kind]) groupedByKind[node.kind] = [];
      groupedByKind[node.kind].push(node);
    }

    const nodes: RFNode[] = [];
    Object.entries(groupedByKind).forEach(([kind, kindNodes]) => {
      const groupIndex = kindGroup(kind);
      kindNodes.forEach((n, idx) => {
        nodes.push({
          id: n.id,
          data: {
            label: `${n.kind}/${n.namespace ? n.namespace + "/" : ""}${n.name}`,
            status: n.status,
          },
          position: {
            x: idx * spacingX,
            y: groupIndex * spacingY,
          },
          style: {
            borderRadius: 8,
            padding: 6,
            border: `1px solid ${nodeStatusColor(n.status)}`,
            background: "#020617",
            color: "#e5e7eb",
            fontSize: 11,
          },
        });
      });
    });

    const edges: RFEdge[] = data.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.type,
      animated: e.type === "routes_to" || e.type === "selects",
      style: { strokeWidth: 1.5 },
      labelStyle: {
        fontSize: 9,
        fill: "#9ca3af",
        background: "#020617",
      },
    }));

    return { rfNodes: nodes, rfEdges: edges };
  }, [data]);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-black">
        <Loader2 className="animate-spin text-cyan-400" size={32} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-black text-red-400">
        <AlertCircle size={32} className="mb-2" />
        <div className="text-sm font-medium">Failed to load topology graph</div>
        <div className="text-xs text-gray-500 mt-2">
          {String((error as Error)?.message ?? error ?? "")}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-black">
      <ReactFlow nodes={rfNodes} edges={rfEdges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

---

## 6. Integrate Topology into Existing Dashboard / Sidebar

### 6.1. Add a “Topology” entry in sidebar

In your existing `Dashboard` or sidebar code (the one already handling Cluster Overview, Workloads, etc.), add a new button/entry:

- Label: `Topology`
- Icon: e.g. `Network` or `Layers` from `lucide-react`
- Behavior:
  - When clicked, set some state like `activeRes = { kind: "Topology", ... }`
  - Or set a dedicated `activeView` string (e.g., `"topology"`).

Example snippet in the sidebar (pseudo-TSX):

```tsx
// In Dashboard's sidebar JSX:
<button
  onClick={() => {
    // Option 1: Use a dedicated flag
    setActiveRes({ kind: "Topology", group: "internal", version: "v1", namespaced: false, title: "Topology" });
    setActiveTabId(null);
  }}
  className={/* similar styling as Cluster Overview / Azure buttons */}
>
  <div className="flex items-center gap-2.5">
    <Network size={18} className="text-cyan-400" />
    <span>Topology</span>
  </div>
</button>
```

### 6.2. Render `TopologyView` in the main panel

In the main content area (where you currently switch between:

- Cluster Overview
- Resource List
- Azure view, etc.

Extend the conditional render:

```tsx
// Inside Dashboard main content render:

let mainContent: React.ReactNode = null;

if (!activeRes && !activeTabId) {
  // Existing: Cluster Overview when nothing selected
  mainContent = (
    <ClusterOverview onNavigate={...} navStructure={navStructure} />
  );
} else if (activeRes?.kind === "Azure") {
  // existing Azure view
} else if (activeRes?.kind === "Topology") {
  mainContent = <TopologyView />;
} else {
  // existing ResourceList + details panel based on activeRes, selectedObj, ...
}
```

Wire imports:

```ts
import { TopologyView } from "./components/TopologyView";
import { Network } from "lucide-react";
```

---

## 7. Future Enhancements (Optional, after v1 is done)

**Not required for v1, but Copilot may leave TODOs / comments:**

1. **Status propagation:** derive “Degraded” on controllers based on children.
2. **Filtering:**
   - by namespace
   - by label
   - by kind
3. **Node click integration:**
   - Click a node → open existing K8s object detail sidebar for the underlying resource.
4. **Better layout:**
   - Integrate Dagre or Elk layout engines for nicer graph.
5. **Crossplane:**
   - Add XRs / MR relationships (provisions edges).
6. **Incremental updates:**
   - Replace polling with K8s watch-based Tauri events later.

---

## 8. Implementation Checklist for Copilot

1. [ ] Create `src/types/topology.ts` with the shared TS graph types.
2. [ ] In the Tauri backend, define Rust structs `TopologyNode`, `TopologyEdge`, `TopologyGraph`.
3. [ ] Implement helper `topo_node_id(kind, ns, name)`.
4. [ ] Implement `get_topology_graph` command:
    - [ ] Fetch core resources (Namespace, Node, Pod, Service, Ingress, Deployment, ReplicaSet, StatefulSet, DaemonSet, PVC, PV, StorageClass).
    - [ ] Build nodes.
    - [ ] Build edges according to rules in section 3.
    - [ ] Set `generated_at`.
5. [ ] Expose `get_topology_graph` in Tauri commands list.
6. [ ] Create `src/components/TopologyView.tsx` as defined above.
7. [ ] Add a “Topology” button to the sidebar, similar styling to existing buttons.
8. [ ] In Dashboard main content, wire `activeRes.kind === "Topology"` to render `<TopologyView />`.
9. [ ] Ensure `reactflow` is installed and bundled correctly.
10. [ ] Verify `Topology` view loads and refreshes every 15s without blocking other UI.

---

End of file.
