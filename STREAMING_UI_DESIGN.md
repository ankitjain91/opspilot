# 🎨 New Streaming Progress UI Design

## Problem Solved
- ❌ **Old**: Chat flooded with 50+ noisy progress messages
- ❌ **Old**: Updates scroll too fast, hard to follow
- ❌ **Old**: No transparency about what commands are running
- ❌ **Old**: Raw kubectl output, no human-readable summaries

## Solution
✅ **Single persistent progress card** with phases
✅ **500ms throttling** prevents UI jank
✅ **Expandable command log** with summaries
✅ **Raw output on-demand** (click to expand)

---

## Visual Design

### 1. Planning Phase
```
┌─────────────────────────────────────────────────┐
│ 🧠  Planning                                    │
│                                                 │
│ Creating investigation plan...                 │
└─────────────────────────────────────────────────┘
```

### 2. Executing Phase (with command transparency)
```
┌─────────────────────────────────────────────────┐
│ 🔧  Executing                            2/4    │
│                                                 │
│ Executing kubectl commands...                  │
│                                                 │
│ $ kubectl get pods -A                          │
│                                                 │
│ ████████████░░░░░░░░░░ 50%                     │
│                                                 │
│ ─────────────────────────────────────────────  │
│                                                 │
│ ▼ Commands Executed (2)                        │
│                                                 │
│ ┌─────────────────────────────────────────┐   │
│ │ ✓ kubectl get customerclusters -A       │   │
│ │   Found 1 resource(s)                    │   │
│ │   ▼ Show raw output                      │   │
│ └─────────────────────────────────────────┘   │
│                                                 │
│ ┌─────────────────────────────────────────┐   │
│ │ ⏳ kubectl describe customercluster...   │   │
│ │   Running...                             │   │
│ └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### 3. Analyzing Phase
```
┌─────────────────────────────────────────────────┐
│ 🧪  Analyzing                                   │
│                                                 │
│ Analyzing results...                           │
│                                                 │
│ ▼ Commands Executed (4)                        │
│                                                 │
│ ┌─────────────────────────────────────────┐   │
│ │ ✓ kubectl get customerclusters -A       │   │
│ │   Found 1 resource(s)                    │   │
│ └─────────────────────────────────────────┘   │
│                                                 │
│ ┌─────────────────────────────────────────┐   │
│ │ ✓ kubectl get customercluster -o yaml   │   │
│ │   Retrieved full resource definition    │   │
│ └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### 4. Complete Phase
```
┌─────────────────────────────────────────────────┐
│ ✅  Complete                                    │
│                                                 │
│ Investigation complete                         │
│                                                 │
│ ▼ Commands Executed (4)                        │
│                                                 │
│ [All commands shown with summaries]            │
└─────────────────────────────────────────────────┘
```

---

## Key Features

### 1. Command Transparency
Each executed command shows:
- ✓/❌ Status icon
- Full command (e.g., `kubectl get pods -n default`)
- Human-readable summary (e.g., "Found 5 pods, 2 failing")
- Optional raw output (click to expand)

### 2. Smart Summaries
Auto-generated from output:
- `kubectl get pods` → "Found 12 pod(s)"
- `kubectl get` with errors → "Command failed - see raw output"
- `CrashLoopBackOff` detected → "Found 3 pod(s) in CrashLoopBackOff"

### 3. Throttled Updates
- Max 1 update per 500ms
- Batches rapid-fire events
- Smooth, readable progress

### 4. Collapsible Sections
- Command log auto-expands (transparency)
- User can collapse to reduce clutter
- Raw output hidden by default (click to show)

---

## Backend Event Mapping

| Backend Event      | UI Phase    | Command Tracking |
|--------------------|-------------|------------------|
| `planning`         | Planning    | -                |
| `supervisor`       | Planning    | -                |
| `executing`        | Executing   | Start command    |
| `command_start`    | Executing   | Start command    |
| `command_complete` | Executing   | Complete command |
| `tool_result`      | Executing   | Complete command |
| `analyzing`        | Analyzing   | -                |
| `reflection`       | Analyzing   | -                |
| `synthesizing`     | Analyzing   | -                |
| `done`             | Complete    | -                |
| `error`            | Error       | -                |
| `progress`         | (ignored)   | -                |
| `debug`            | (ignored)   | -                |

---

## Integration

### In ClusterChatPanel.tsx:
```tsx
import { useAgentStream } from './useAgentStream';
import { StreamingProgressCard } from './chat/StreamingProgressCard';

// Hook usage
const { currentPhase, finalResponse, isStreaming } = useAgentStream(queryId);

// Render in chat
{isStreaming && currentPhase && (
    <StreamingProgressCard phase={currentPhase} />
)}

{finalResponse && (
    <div className="final-answer">{finalResponse}</div>
)}
```

---

## Benefits

1. **Clean UI** - Single card instead of 50 messages
2. **Readable** - 500ms throttle prevents scrolling too fast
3. **Transparent** - Shows exact commands being run
4. **Informative** - Human-readable summaries instead of raw output
5. **User Control** - Expand/collapse sections, show raw output on demand
6. **Professional** - Like GitHub Actions, VS Code tasks, or Linear

---

## Example Flow

**User asks:** "what is the status of customercluster"

**UI Shows:**

1. 🧠 Planning (1s)
   - "Creating investigation plan..."

2. 🔧 Executing (3s)
   - Current: `kubectl get customerclusters -A`
   - Commands:
     - ✓ `kubectl get customerclusters -A` → "Found 1 resource(s)"
     - ⏳ `kubectl describe customercluster taasvstst -n taasvstst`

3. 🧪 Analyzing (1s)
   - "Analyzing results..."
   - Commands:
     - ✓ `kubectl get customerclusters -A` → "Found 1 resource(s)"
     - ✓ `kubectl describe customercluster...` → "Retrieved full resource"

4. ✅ Complete
   - Final answer appears below progress card
