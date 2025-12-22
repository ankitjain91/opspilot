# Support Bundle Import Feature - Implementation Plan

## Overview

Add a new sidebar option to import Kubernetes support bundles (like UiPath's automation-suite-support format) and view them as a point-in-time cluster snapshot. This enables offline analysis of cluster state without needing live cluster access.

## Support Bundle Structure Analysis

The bundle contains:
```
support-bundle/
├── events.json              # K8s events (JSON array)
├── alerts/
│   ├── critical.json        # Critical alerts
│   └── warning.json         # Warning alerts
├── current-logs/
│   └── {namespace}/
│       └── {pod-name}/
│           └── {container}.log
├── service-metrics/         # XML telemetry files
├── cluster-scope-resources/
│   ├── nodes/
│   ├── persistentvolumes/
│   ├── storageclasses/
│   ├── clusterroles/
│   ├── clusterrolebindings/
│   ├── namespaces/
│   ├── customresourcedefinitions/
│   └── custom-resources/
└── {namespace}/             # One folder per namespace
    ├── pods/
    ├── deployments/
    ├── statefulsets/
    ├── daemonsets/
    ├── services/
    ├── configmaps/
    ├── secrets/
    ├── jobs/
    ├── cronjobs/
    ├── replicasets/
    ├── endpoints/
    ├── roles/
    ├── rolebindings/
    ├── networkpolicies/
    ├── persistentvolumeclaims/
    └── custom-resources/
```

### File Formats
- **K8s Resources**: YAML with `object:` wrapper containing full resource spec
- **Events**: JSON array of Kubernetes Event objects
- **Logs**: Plain text with timestamps
- **Alerts**: JSON array with labels, annotations, state
- **Metrics**: XML files

---

## Implementation Plan

### Phase 1: Core Data Layer

#### 1.1 Bundle Parser (Rust)
Create `src-tauri/src/commands/support_bundle.rs`:

```rust
// Key structs
pub struct SupportBundle {
    pub path: PathBuf,
    pub namespaces: Vec<String>,
    pub timestamp: Option<DateTime<Utc>>,  // From events
    pub node_count: usize,
}

pub struct BundleResource {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub yaml: String,
    pub status: Option<String>,  // Extract from status field
}

// Commands
#[tauri::command]
pub async fn load_support_bundle(path: String) -> Result<SupportBundle, String>;

#[tauri::command]
pub async fn get_bundle_namespaces(bundle_path: String) -> Result<Vec<String>, String>;

#[tauri::command]
pub async fn get_bundle_resources(
    bundle_path: String,
    namespace: Option<String>,
    resource_type: String,
) -> Result<Vec<BundleResource>, String>;

#[tauri::command]
pub async fn get_bundle_resource_yaml(
    bundle_path: String,
    namespace: Option<String>,
    resource_type: String,
    name: String,
) -> Result<String, String>;

#[tauri::command]
pub async fn get_bundle_events(bundle_path: String) -> Result<Vec<Event>, String>;

#[tauri::command]
pub async fn get_bundle_logs(
    bundle_path: String,
    namespace: String,
    pod: String,
    container: Option<String>,
) -> Result<String, String>;

#[tauri::command]
pub async fn get_bundle_alerts(bundle_path: String) -> Result<BundleAlerts, String>;
```

#### 1.2 YAML Parser
- Parse the `object:` wrapper format
- Extract key fields (name, namespace, status, conditions)
- Handle nested structures

---

### Phase 2: UI Components

#### 2.1 Sidebar Entry
Add new sidebar option in `src/components/dashboard/MainDashboard.tsx`:

```tsx
// Add to sidebar menu
{
  id: 'support-bundle',
  icon: Archive,
  label: 'Support Bundle',
  description: 'Analyze offline cluster snapshots'
}
```

#### 2.2 Bundle Import Screen
Create `src/components/bundle/BundleImportScreen.tsx`:

- File/folder picker for bundle path
- Bundle validation and loading progress
- Summary view (namespaces, resource counts, timestamp)
- "Open Bundle" action

#### 2.3 Bundle Dashboard
Create `src/components/bundle/BundleDashboard.tsx`:

Similar to main dashboard but for bundle data:
- Namespace selector (from bundle namespaces)
- Resource type tabs (Pods, Deployments, Services, etc.)
- Resource list with status indicators
- Click to view YAML/details

#### 2.4 Bundle Resource Viewer
Create `src/components/bundle/BundleResourceViewer.tsx`:

- YAML display with syntax highlighting
- Status extraction and display
- For pods: link to logs if available
- Events tab (filtered by resource)

#### 2.5 Bundle Logs Viewer
Create `src/components/bundle/BundleLogsViewer.tsx`:

- List available log files for pod
- Log content display with search
- Container selector if multiple containers

---

### Phase 3: AI Integration

#### 3.1 Bundle-Aware AI Chat
Modify AI system to work with bundle data:

```python
# In agent_server, add bundle context
def get_bundle_context(bundle_path: str, namespace: str) -> str:
    """Get summary of bundle state for AI context"""
    # List failing pods, recent events, alerts
    pass

# Add bundle-specific tools for Claude Code
BUNDLE_TOOLS = [
    "bundle_get_pods",
    "bundle_get_logs",
    "bundle_get_events",
    "bundle_describe_resource"
]
```

#### 3.2 Offline Analysis Mode
- AI can analyze bundle without live cluster
- Correlate events with pod states
- Find issues from logs
- Suggest root causes

---

### Phase 4: Advanced Features

#### 4.1 Quick Health Summary
On bundle load, show:
- Failing/CrashLoopBackOff pods
- Recent error events
- Active alerts
- Resource utilization (if metrics available)

#### 4.2 Timeline View
- Show events on a timeline
- Correlate deployments/restarts
- Highlight problem periods

#### 4.3 Comparison Mode (Future)
- Compare two bundles
- Show what changed between snapshots

---

## File Structure

```
src/
├── components/
│   └── bundle/
│       ├── BundleImportScreen.tsx
│       ├── BundleDashboard.tsx
│       ├── BundleResourceList.tsx
│       ├── BundleResourceViewer.tsx
│       ├── BundleLogsViewer.tsx
│       ├── BundleEventsPanel.tsx
│       └── BundleHealthSummary.tsx
├── hooks/
│   └── useBundleData.ts
└── stores/
    └── bundleStore.ts           # Zustand store for bundle state

src-tauri/src/
├── commands/
│   └── support_bundle.rs        # Bundle parsing commands
└── bundle/
    ├── mod.rs
    ├── parser.rs                # YAML/JSON parsing
    └── types.rs                 # Bundle data types

python/agent_server/
└── bundle_analyzer.py           # AI bundle analysis helpers
```

---

## Implementation Order

1. **Week 1: Core Parsing**
   - [ ] Create `support_bundle.rs` with basic bundle loading
   - [ ] Parse namespaces and resource types
   - [ ] Load and parse YAML resources
   - [ ] Load events.json

2. **Week 2: Basic UI**
   - [ ] Add sidebar entry
   - [ ] Create bundle import screen
   - [ ] Create bundle dashboard with namespace/resource browsing
   - [ ] Resource YAML viewer

3. **Week 3: Logs & Events**
   - [ ] Logs viewer component
   - [ ] Events panel with filtering
   - [ ] Link resources to their events/logs

4. **Week 4: AI & Polish**
   - [ ] AI integration for bundle analysis
   - [ ] Health summary on load
   - [ ] Error handling and edge cases

---

## Technical Considerations

### Performance
- Large bundles (2GB+) need streaming/lazy loading
- Index resources on load, don't parse all YAML upfront
- Cache parsed data in memory

### Format Variations
- Support different bundle formats (not just UiPath)
- Auto-detect format from structure
- Plugin architecture for new formats

### State Management
- Separate from live cluster state
- Clear indication of "offline mode"
- Can't exec/port-forward (obviously)

---

## Questions to Resolve

1. Should bundle analysis run in main thread or background?
2. How to handle very large log files (100MB+)?
3. Store recent bundles for quick access?
4. Support compressed bundles (tar.gz)?
