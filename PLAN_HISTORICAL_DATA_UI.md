# Plan: Nerdy UI with Historical Cluster Data

## Executive Summary
Transform OpsPilot's UI to be more "nerdy" by adding historical data collection, time-series visualizations, and developer-focused metrics displays that provide deeper insights into cluster behavior over time.

---

## Current State Analysis

### What We Have
- **Real-time metrics** with 5-minute rolling window (MetricsChart.tsx)
- **Point-in-time snapshots** for cluster health (ClusterCockpit)
- **Learning data persistence** for AI investigations
- **React Query cache** persisted to localStorage
- **Recharts library** already integrated (Line, Bar, Pie charts)
- **Custom gauges** (Speedometer, VU meter, ring gauges)

### What's Missing
- No historical data storage beyond 5 minutes
- No event timeline or pattern detection
- No resource lifecycle tracking
- No cost/usage trends
- No "nerdy" ASCII/terminal-style displays

---

## Proposed Features (Prioritized)

### Phase 1: Historical Data Collection (Foundation)

#### 1.1 SQLite Time-Series Storage
**Location**: `src-tauri/src/history.rs` (new file)

Store historical data points:
```rust
struct MetricsSnapshot {
    timestamp: i64,
    cluster_context: String,
    cpu_total_used: u64,      // millicores
    cpu_total_capacity: u64,
    memory_total_used: u64,   // bytes
    memory_total_capacity: u64,
    pods_running: u32,
    pods_pending: u32,
    pods_failed: u32,
    nodes_ready: u32,
    nodes_total: u32,
}

struct EventSnapshot {
    timestamp: i64,
    event_type: String,       // Warning, Normal
    reason: String,           // CrashLoopBackOff, OOMKilled, etc.
    count: u32,               // events in this bucket
}

struct PodRestartHistory {
    timestamp: i64,
    pod_name: String,
    namespace: String,
    restart_count: u32,
    reason: Option<String>,
}
```

**Data Retention**:
- 1-minute granularity for last 24 hours
- 15-minute granularity for last 7 days
- 1-hour granularity for last 30 days
- Auto-cleanup via background task

#### 1.2 Background Collection Service
**Location**: `src-tauri/src/collector.rs` (new file)

- Spawn background tokio task on cluster connect
- Collect metrics every 60 seconds
- Aggregate events by type/reason
- Track pod restart deltas
- Store to SQLite

---

### Phase 2: Nerdy Dashboard Components

#### 2.1 Sparkline Charts Everywhere
**Location**: `src/components/shared/Sparkline.tsx` (new)

Tiny inline charts showing trends:
```
CPU: ▁▂▃▅▇▅▃▂▁ 45%
MEM: ▅▅▆▇▇▇▆▅▄ 78%
```

Where to add:
- ResourceList rows (CPU/Memory trend per pod)
- Node cards in ClusterCockpit
- Sidebar resource type counts

#### 2.2 ASCII-Style Event Timeline
**Location**: `src/components/dashboard/EventTimeline.tsx` (new)

Terminal-inspired event display:
```
┌─ Events (last 24h) ────────────────────────────────┐
│ 14:32 ● Warning  pod/nginx-xyz    OOMKilled        │
│ 14:28 ● Warning  pod/api-abc      CrashLoopBackOff │
│ 14:15 ○ Normal   deploy/web       ScaledUp         │
│ 13:45 ● Warning  node/worker-2    NotReady         │
│ ─────────────────────────────────────────────────  │
│ Timeline: ░░░▒▒▒▓▓░░░░▒▒░░░░░░░░░░░░ (24h)        │
│           ^warnings peak at 14:00                  │
└────────────────────────────────────────────────────┘
```

#### 2.3 Resource Heat Map
**Location**: `src/components/dashboard/ResourceHeatmap.tsx` (new)

Grid visualization of resource usage over time:
```
       00  04  08  12  16  20  24
Mon    ░░  ▒▒  ▓▓  ██  ▓▓  ▒▒  ░░
Tue    ░░  ▒▒  ▓▓  ██  ██  ▒▒  ░░
Wed    ░░  ▒▒  ██  ██  ▓▓  ▒▒  ░░
...
       └──CPU Usage (darker = higher)
```

#### 2.4 Pod Restart Tracker
**Location**: `src/components/dashboard/RestartTracker.tsx` (new)

Track restart patterns:
```
┌─ Restart Patterns (7 days) ─────────────────────────┐
│ nginx-xyz       ████████░░░░ 8 restarts  (↑3 today) │
│ api-server      ██░░░░░░░░░░ 2 restarts  (stable)   │
│ worker-job      ░░░░░░░░░░░░ 0 restarts  (healthy)  │
│                                                      │
│ Peak restart times: 02:00-03:00 UTC (cron jobs?)    │
└──────────────────────────────────────────────────────┘
```

#### 2.5 Node Health Timeline
**Location**: `src/components/dashboard/NodeHealthTimeline.tsx` (new)

```
Node: worker-1
Status: Ready ●──────────────●───●──────────● Ready
                             │   │
                         NotReady (2min)

Last 24h: ████████████████░░████████████████
          └─99.2% uptime
```

---

### Phase 3: Deep Dive Enhancements

#### 3.1 Pod Lifecycle Visualization
**Location**: Enhance `src/components/cluster/deep-dive/OverviewTab.tsx`

Show pod lifecycle events:
```
Pod: nginx-abc-xyz
────────────────────────────────────────────────────
Created     Scheduled    Running     ←Current
   │            │           │
   ●────────────●───────────●─────────────────→
   │            │           │
   12:00        12:01       12:02

Previous restarts:
  #1: 11:45 - OOMKilled (memory: 512Mi → 1Gi)
  #2: 11:30 - CrashLoopBackOff (exit code 137)
```

#### 3.2 Enhanced Metrics Charts
**Location**: Enhance `src/components/cluster/deep-dive/MetricsChart.tsx`

Add time range selector:
- Last 5 minutes (current)
- Last 1 hour (new)
- Last 24 hours (new)
- Last 7 days (new)

Add percentile bands:
```
        p99 ─────────────────────
        p95 ═══════════════════
avg ──────────────────────────────
        p5  ═══════════════════
```

#### 3.3 Resource Diff View
**Location**: `src/components/cluster/deep-dive/DiffTab.tsx` (new)

Show changes over time:
```diff
spec.replicas:
- 3 (yesterday)
+ 5 (today)

resources.limits.memory:
- 512Mi (2 days ago)
+ 1Gi (today)
```

---

### Phase 4: Cluster-Wide Analytics

#### 4.1 Cost Trend Chart
**Location**: `src/components/dashboard/CostTrend.tsx` (new)

```
Monthly Cost Trend
$1200 ┤                          ╭─
$1000 ┤              ╭───────────╯
 $800 ┤    ╭─────────╯
 $600 ┤────╯
      └────┬────┬────┬────┬────┬────
         Nov  Dec  Jan  Feb  Mar  Apr

Projection: $1,450/mo (+21% MoM)
Top cost driver: GPU nodes (+$200)
```

#### 4.2 Namespace Comparison Over Time
Compare resource usage trends across namespaces:
```
Namespace Usage (CPU) - Last 7 Days
production  ████████████████████████ 2.4 cores
staging     ████████░░░░░░░░░░░░░░░░ 0.8 cores
dev         ████░░░░░░░░░░░░░░░░░░░░ 0.4 cores

Trend: production +15%, staging -5%, dev stable
```

#### 4.3 Deployment Health Score
Track deployment health over time:
```
Deployment: api-server
Health Score: 94% (↑2% this week)

┌─ Health Components ─────────────────────────┐
│ Availability:    ████████████████░░░░ 85%   │
│ Latency (p99):   ██████████████████░░ 92%   │
│ Error Rate:      ████████████████████ 100%  │
│ Restart Rate:    ██████████████████░░ 95%   │
└─────────────────────────────────────────────┘

7-Day Trend: ▁▂▃▅▆▇▇ (improving)
```

---

### Phase 5: Terminal/Nerdy Aesthetics

#### 5.1 Monospace/Terminal Theme Option
Add theme toggle for "terminal mode":
- Monospace fonts everywhere
- Green-on-black color scheme option
- ASCII box drawing characters
- Blinking cursors on active elements

#### 5.2 Keyboard-First Navigation Indicators
Show vim-style hints:
```
[j/k] navigate  [enter] select  [esc] back  [/] search  [?] help
```

#### 5.3 Stats Bar (htop-style)
Bottom status bar with live stats:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CPU[||||||||||||      42%]  MEM[||||||||||||||||  78%]
Pods: 145/150  Nodes: 5/5  Events: 3⚠  Context: prod-cluster
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Technical Implementation Details

### Database Schema (SQLite)

```sql
-- Metrics snapshots (1-minute granularity)
CREATE TABLE metrics_snapshots (
    id INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    context TEXT NOT NULL,
    cpu_used_milli INTEGER,
    cpu_capacity_milli INTEGER,
    memory_used_bytes INTEGER,
    memory_capacity_bytes INTEGER,
    pods_running INTEGER,
    pods_pending INTEGER,
    pods_failed INTEGER,
    nodes_ready INTEGER,
    nodes_total INTEGER,
    UNIQUE(timestamp, context)
);

-- Event aggregates (hourly buckets)
CREATE TABLE event_aggregates (
    id INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,  -- hour bucket
    context TEXT NOT NULL,
    event_type TEXT NOT NULL,    -- Warning, Normal
    reason TEXT NOT NULL,        -- OOMKilled, CrashLoopBackOff, etc.
    count INTEGER DEFAULT 1,
    UNIQUE(timestamp, context, event_type, reason)
);

-- Pod restart history
CREATE TABLE pod_restarts (
    id INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    context TEXT NOT NULL,
    namespace TEXT NOT NULL,
    pod_name TEXT NOT NULL,
    restart_count INTEGER,
    reason TEXT
);

-- Resource changes (for diff view)
CREATE TABLE resource_snapshots (
    id INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    context TEXT NOT NULL,
    kind TEXT NOT NULL,
    namespace TEXT,
    name TEXT NOT NULL,
    spec_hash TEXT NOT NULL,  -- Hash of relevant spec fields
    spec_json TEXT NOT NULL,  -- JSON of tracked fields
    UNIQUE(timestamp, context, kind, namespace, name)
);

-- Indexes for performance
CREATE INDEX idx_metrics_context_time ON metrics_snapshots(context, timestamp);
CREATE INDEX idx_events_context_time ON event_aggregates(context, timestamp);
CREATE INDEX idx_restarts_pod ON pod_restarts(context, namespace, pod_name);
CREATE INDEX idx_resources_lookup ON resource_snapshots(context, kind, namespace, name);
```

### New Rust Dependencies

```toml
# Cargo.toml additions
rusqlite = { version = "0.31", features = ["bundled"] }
```

### New Frontend Dependencies

```json
{
  "dependencies": {
    "date-fns": "^3.0.0"  // Already likely present, for date formatting
  }
}
```

---

## Implementation Order

1. **Week 1**: SQLite setup + background collector
   - Create history.rs with schema
   - Create collector.rs background task
   - Wire up on cluster connect

2. **Week 2**: Sparklines + Event Timeline
   - Sparkline component
   - Add to ResourceList rows
   - Event timeline with ASCII styling

3. **Week 3**: Enhanced MetricsChart
   - Time range selector
   - Historical data queries
   - Percentile bands

4. **Week 4**: Heat maps + Restart tracker
   - Resource heatmap component
   - Pod restart tracking
   - Node health timeline

5. **Week 5**: Cost trends + Polishing
   - Cost trend charts
   - Terminal theme option
   - Stats bar component

---

## Open Questions for User

1. **Data Retention**: How long should we keep historical data? (Suggested: 30 days max)

2. **Collection Frequency**:
   - Every 60 seconds for metrics? (Balance between granularity and storage)
   - Every 5 minutes for resource snapshots?

3. **Priority Features**: Which features are most important to you?
   - [ ] Sparklines in resource lists
   - [ ] Event timeline
   - [ ] Resource heat map
   - [ ] Extended metrics history (1h/24h/7d)
   - [ ] Cost trends
   - [ ] Terminal/ASCII theme

4. **Storage Location**:
   - SQLite in app data directory? (Recommended)
   - Or prefer keeping everything in memory/localStorage?

5. **Multi-cluster**: Should history be per-cluster or combined?

---

## File Structure Changes

```
src-tauri/
├── src/
│   ├── history.rs        # NEW: SQLite storage layer
│   ├── collector.rs      # NEW: Background data collection
│   └── lib.rs            # Modified: Wire up collector
│
src/components/
├── shared/
│   ├── Sparkline.tsx     # NEW: Inline sparkline charts
│   └── AsciiBox.tsx      # NEW: Terminal-style boxes
├── dashboard/
│   ├── EventTimeline.tsx     # NEW: Event timeline
│   ├── ResourceHeatmap.tsx   # NEW: Usage heatmap
│   ├── RestartTracker.tsx    # NEW: Pod restart patterns
│   ├── NodeHealthTimeline.tsx # NEW: Node uptime viz
│   ├── CostTrend.tsx         # NEW: Cost over time
│   └── StatsBar.tsx          # NEW: htop-style status bar
└── cluster/deep-dive/
    ├── MetricsChart.tsx      # Modified: Time range selector
    └── DiffTab.tsx           # NEW: Resource diff view
```

---

## Success Metrics

- Historical data available for at least 24 hours
- Sparklines visible in all resource lists
- Event timeline showing pattern detection
- Users can spot recurring issues at a glance
- "Nerdy" aesthetic achieved with ASCII/terminal styling options
