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
  id: string; // e.g. "Pod/default/nginx-123"
  kind: TopologyNodeKind;
  name: string;
  namespace?: string;
  status?: TopologyStatus;
  labels?: Record<string, string>;
  extra?: Record<string, any>;
}

export type TopologyEdgeType =
  | "owns"
  | "selects"
  | "routes_to"
  | "mounts"
  | "backs"
  | "provisions"
  | "runs_on"
  | "controlled_by";

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  type: TopologyEdgeType;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: string; // ISO timestamp
}
