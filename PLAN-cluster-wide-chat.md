# Cluster-Wide AI Chat Agent - Implementation Plan

## Overview

Add an AI chat assistant that can discuss and analyze the **entire cluster**, providing insights across all namespaces, resources, and their relationships. Unlike the existing resource-specific chat (scoped to a single pod/deployment), this will be a cluster-wide investigator.

## Goals

1. **Cluster-wide visibility** - Can query any resource in any namespace
2. **Cross-resource correlation** - Understand relationships (Service→Pod, Deployment→ReplicaSet→Pod, etc.)
3. **Health analysis** - Aggregate health issues across the cluster
4. **Resource optimization** - Identify over/under-provisioned workloads
5. **Security posture** - Check for security misconfigurations

---

## Architecture

### Location in UI

Add the cluster chat to the **ClusterCockpit** component as a floating panel (similar to resource chat in OverviewTab).

```
┌─────────────────────────────────────────────────────────────┐
│  Cluster Cockpit                              [🤖 AI Chat]  │
├─────────────────────────────────────────────────────────────┤
│  [Metrics] [Gauges] [Charts]                                │
│                                              ┌──────────────┤
│  Nodes table, Deployments, etc.              │ AI Chat      │
│                                              │ Panel        │
│                                              │ (expandable) │
└──────────────────────────────────────────────┴──────────────┘
```

### Tools for Cluster Agent

The cluster agent needs broader tools than the resource-specific one:

| Tool | Description | kubectl Equivalent |
|------|-------------|-------------------|
| `CLUSTER_HEALTH` | Get overall cluster health summary | `kubectl get nodes,pods --all-namespaces` |
| `LIST_NAMESPACES` | List all namespaces with pod counts | `kubectl get ns` |
| `LIST_ALL <kind>` | List all resources of a kind across namespaces | `kubectl get <kind> -A` |
| `DESCRIBE_RESOURCE <kind> <ns> <name>` | Get details of any resource | `kubectl describe <kind> -n <ns> <name>` |
| `GET_EVENTS [namespace]` | Get events (cluster-wide or namespace) | `kubectl get events -A` |
| `GET_LOGS <ns> <pod> [container]` | Get logs from any pod | `kubectl logs -n <ns> <pod>` |
| `TOP_NODES` | Get node resource usage | `kubectl top nodes` |
| `TOP_PODS [namespace]` | Get pod resource usage | `kubectl top pods -A` |
| `FIND_UNHEALTHY` | Find all unhealthy resources | Custom query |
| `NETWORK_TOPOLOGY <ns>` | Service→Endpoint→Pod mapping | `kubectl get svc,ep,pod -n <ns>` |
| `STORAGE_STATUS` | PVC/PV status across cluster | `kubectl get pvc,pv -A` |
| `SECURITY_CHECK` | Check for security issues | ServiceAccounts, RBAC, etc. |
| `COMPARE_RESOURCES <kind> <name1> <name2>` | Compare two resources | Diff two YAMLs |

### System Prompt Design

```
SYSTEM IDENTITY
You are a Cluster-Wide SRE AI Assistant with visibility across the ENTIRE Kubernetes cluster.

SCOPE
- All namespaces (kube-system, default, custom namespaces)
- All resource types (Deployments, Services, ConfigMaps, Secrets, CRDs, etc.)
- Cross-resource relationships
- Cluster-level metrics and health

CAPABILITIES
1. Cluster Health Analysis
   - Identify unhealthy nodes, pods, deployments
   - Correlate failures across resources
   - Resource utilization patterns

2. Troubleshooting
   - Start from symptoms → drill down to root cause
   - Follow resource ownership chains
   - Check networking, storage, scheduling issues

3. Optimization Suggestions
   - Over/under-provisioned workloads
   - Unused resources
   - Resource quota recommendations

4. Security Analysis
   - Privileged containers
   - Missing resource limits
   - Exposed secrets
   - RBAC misconfigurations

TOOLS
[Tool list with syntax]

INVESTIGATION APPROACH
1. Start with CLUSTER_HEALTH to understand overall state
2. Drill into specific namespaces/resources based on issues
3. Follow ownership chains (Deployment → ReplicaSet → Pod)
4. Correlate events across related resources
5. Check network connectivity (Service → Endpoints → Pods)
```

---

## Implementation Steps

### Phase 1: Backend Tools (lib.rs)

1. **Add cluster-wide query commands**
   ```rust
   #[tauri::command]
   async fn get_cluster_health_summary(state: State<'_, AppState>) -> Result<ClusterHealthSummary, String>

   #[tauri::command]
   async fn list_all_resources(state: State<'_, AppState>, kind: String) -> Result<Vec<ResourceSummary>, String>

   #[tauri::command]
   async fn get_cluster_events(state: State<'_, AppState>, namespace: Option<String>, limit: u32) -> Result<Vec<Event>, String>

   #[tauri::command]
   async fn find_unhealthy_resources(state: State<'_, AppState>) -> Result<UnhealthyReport, String>
   ```

2. **Add types for cluster-wide data**
   ```rust
   struct ClusterHealthSummary {
       nodes: NodesSummary,
       pods: PodsSummary,
       deployments: DeploymentsSummary,
       services: ServicesSummary,
       critical_issues: Vec<Issue>,
       warnings: Vec<Issue>,
   }
   ```

### Phase 2: Frontend - ClusterChatPanel Component

1. **Create `ClusterChatPanel` component** (similar to existing chat in OverviewTab)
   - Floating panel with expand/collapse
   - Chat history state
   - Tool execution logic
   - Markdown rendering with ReactMarkdown

2. **Add to ClusterCockpit**
   ```tsx
   function ClusterCockpit({ ... }) {
     const [showClusterChat, setShowClusterChat] = useState(false);

     return (
       <div>
         {/* Existing cockpit content */}

         {/* AI Chat Button */}
         <button onClick={() => setShowClusterChat(true)}>
           🤖 Cluster AI
         </button>

         {/* Cluster Chat Panel */}
         {showClusterChat && (
           <ClusterChatPanel
             cockpitData={cockpit}
             onClose={() => setShowClusterChat(false)}
           />
         )}
       </div>
     );
   }
   ```

### Phase 3: Tool Execution

1. **Implement tool handlers** in the chat component
   ```tsx
   const executeClusterTool = async (toolName: string, args: string) => {
     switch (toolName) {
       case 'CLUSTER_HEALTH':
         return await invoke('get_cluster_health_summary');
       case 'LIST_ALL':
         return await invoke('list_all_resources', { kind: args });
       case 'FIND_UNHEALTHY':
         return await invoke('find_unhealthy_resources');
       // ... more tools
     }
   };
   ```

2. **Format tool results** as markdown for display

### Phase 4: Context Building

1. **Build comprehensive context** on each message
   ```tsx
   const buildClusterContext = async () => {
     const health = await invoke('get_cluster_health_summary');
     return `
       Cluster Overview:
       - Nodes: ${health.nodes.total} (${health.nodes.ready} ready)
       - Pods: ${health.pods.total} (${health.pods.running} running)
       - Critical Issues: ${health.critical_issues.length}
       - Warnings: ${health.warnings.length}

       Top Issues:
       ${health.critical_issues.slice(0, 5).map(i => `- ${i.message}`).join('\n')}
     `;
   };
   ```

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src-tauri/src/lib.rs` | Add cluster-wide query commands |
| `src/App.tsx` | Add ClusterChatPanel component, integrate into ClusterCockpit |

---

## Example Conversations

**User**: "Why is my cluster slow?"

**Agent**:
```
SUMMARY
Analyzing cluster-wide resource utilization...

TOOL: CLUSTER_HEALTH
TOOL: TOP_NODES
TOOL: TOP_PODS

[After tool results]

FINDINGS:
1. [HIGH] Node worker-3 at 95% CPU utilization
2. [MEDIUM] 12 pods in namespace "api" consuming 80% of cluster memory
3. [LOW] 3 pods in CrashLoopBackOff in namespace "monitoring"

RECOMMENDATIONS:
- Consider scaling out node pool
- Review resource limits for "api" namespace pods
- Investigate monitoring pod crashes
```

**User**: "Find all pods without resource limits"

**Agent**:
```
TOOL: LIST_ALL pods

[Analyzes results]

Found 47 pods without memory limits:
- namespace/pod-1
- namespace/pod-2
...

This is a potential risk for cluster stability.
Recommend adding resource limits to prevent OOM issues.
```

---

## Questions for Clarification

1. Should the cluster chat be accessible from anywhere (global) or only from ClusterCockpit?
2. Should we persist chat history across sessions?
3. Any specific analysis capabilities to prioritize (cost, security, performance)?
