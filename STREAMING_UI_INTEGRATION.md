# Streaming UI Integration Plan

## ✅ Phase 1: Fixed Tooltip Positioning
**Status: COMPLETE**

- Changed Brain Model tooltip from `bottom-full` → `top-full` (positions below)
- Changed Executor Model tooltip from `bottom-full` → `top-full`
- Increased z-index from `z-50` → `z-[9999]`
- Added `pointer-events-none` to prevent blocking clicks
- Added `shadow-lg` for better visibility

## ✅ Phase 2: Integrate Streaming Progress UI
**Status: COMPLETE**

### Components Created:
1. ✅ `StreamingProgressCard.tsx` - Clean progress card with command transparency
2. ✅ `useAgentStream.ts` - Smart SSE hook with throttling
3. ✅ `STREAMING_UI_DESIGN.md` - Visual documentation

### Integration Steps:

#### ✅ Step 1: Update AgentPhase interface to include suggestions
- File: `src/components/ai/chat/StreamingProgressCard.tsx`
- ✅ Added `suggestions?: string[]` field (already present)

#### ✅ Step 2: Wire up StreamingProgressCard in ClusterChatPanel
- File: `src/components/ai/ClusterChatPanel.tsx`
- ✅ Imported `StreamingProgressCard`, `AgentPhase`, `CommandExecution` types
- ✅ Added `streamingPhase` state and `commandHistoryRef`
- ✅ Updated callbacks to populate streaming phase:
  - `onProgress`: Updates phase based on message content
  - `onStep`: Tracks commands and generates summaries
  - `onPlanUpdate`: Updates progress with step counts
- ✅ Replaced InvestigationTimeline with StreamingProgressCard for active investigations
- ✅ Kept InvestigationTimeline for historical completed investigations
- ✅ Added `generateCommandSummary` helper function
- ✅ Set phase to 'complete' when investigation finishes
- ✅ Set phase to 'error' on exceptions

#### Step 3: Backend Event Emission (Not Required)
- The integration works with existing SSE events from agentOrchestrator
- Backend already emits command execution events via SCOUT steps
- Command summaries are generated client-side from output

### Current Backend Events (from server.py):
```python
# Events currently emitted:
- 'progress' - Generic progress (WILL BE FILTERED OUT)
- 'planning' - Supervisor planning
- 'executing' - Command execution (NEEDS command/summary)
- 'reflection' - Reflection analysis
- 'done' - Investigation complete (includes suggested_next_steps)
- 'error' - Error occurred
```

### Needed Backend Changes:
1. Add `command` field to 'executing' events
2. Add `summary` field to command completion events
3. Emit 'command_start' and 'command_complete' events

## Phase 3: Test & Iterate
**Status: READY FOR TESTING**

Integration is complete. Ready to test:
1. ✅ Build successful with no compilation errors
2. ⏳ Test with existing backend in live environment
3. ⏳ Verify command transparency (should see kubectl commands with summaries)
4. ⏳ Verify summaries are readable ("Found X resource(s)" etc.)
5. ⏳ Verify progress phases update correctly (Planning → Executing → Analyzing → Complete)
6. ⏳ Verify error handling shows error phase
7. ⏳ Verify streaming phase clears after 3 seconds on completion

## Phase 4: Backend Summary Enhancement
**Status: PENDING**

Improve backend to emit better summaries:
- Parse kubectl output to extract meaningful data
- Generate human-readable summaries
- Include in SSE events
