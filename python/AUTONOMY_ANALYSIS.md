# Agent Autonomy Analysis & Improvement Plan

## Current State Assessment

### ✅ What's Already Strong:
1. **Comprehensive Prompts**: Supervisor rules mandate multi-method discovery (lines 97-110)
2. **Deep CRD Debugging**: State machine enforces controller discovery (lines 155-190)
3. **Shell Command Support**: Worker has ShellCommand tool with grep/pipe support
4. **Persistence Rules**: Agent instructed not to give up easily (lines 192-211)
5. **K8s Cheat Sheet**: Good multi-method patterns documented

### ❌ What's Blocking Autonomy:

#### 1. **Evidence Validator is Too Aggressive**
- **Problem**: Blocks worker before it can try commands
- **Location**: `agent_server/nodes/evidence_validator.py`
- **Issue**: Requires 3 methods minimum, but blocks on first api-resources attempt
- **Fix**: Let worker try at least 2-3 methods BEFORE blocking

#### 2. **Worker Prefers Structured Tools Over ShellCommand**
- **Problem**: LLM chooses `KubectlGet` over `ShellCommand` for grep operations
- **Why**: Structured tools (KubectlGet, KubectlDescribe) appear first in prompt
- **Result**: No pipes, no grep, limited discovery
- **Fix**: Reorder worker prompt to prioritize ShellCommand for discovery

#### 3. **Reflection Gives Up on "Not Found"**
- **Problem**: Lines 222-228 in reflect.py prevent ABORT on NotFound, but may not be strong enough
- **Issue**: Agent might conclude "doesn't exist" without exhaustive search
- **Fix**: Add stronger "MUST try ALL methods" enforcement

#### 4. **No Autonomous Loop Expansion**
- **Problem**: If discovery returns empty, agent stops
- **Expected**: Agent should automatically expand search (more namespaces, helm, etc.)
- **Fix**: Add heuristic in reflect node to auto-expand on empty results

##Detailed Improvement Plan

### Phase 1: Worker Prompt Restructuring (HIGH PRIORITY)

**Goal**: Make ShellCommand the default for discovery operations

**Changes**:
1. Move ShellCommand to position #1 in tools list
2. Add section: "FOR ALL DISCOVERY QUERIES, USE ShellCommand FIRST"
3. Add explicit examples:
   ```json
   // CORRECT for "list vclusters":
   {"tool": "shell_command", "command": "kubectl get pods,deploy,sts -A | grep -i vcluster"}

   // WRONG for "list vclusters":
   {"tool": "kubectl_api_resources"} // This alone is insufficient
   ```

### Phase 2: Evidence Validator Relaxation

**Goal**: Allow worker to try methods before blocking

**Changes**:
1. For discovery intent: Block only if methods_tried < 2 (not < 3)
2. Don't block on first command - let at least 2 commands execute
3. Add logging: "Attempted {methods_tried} methods: {list_of_methods}"

### Phase 3: Reflection Auto-Expansion

**Goal**: Autonomous investigation depth

**Changes** to `reflect.py`:
```python
# After empty/negative result from discovery
if directive == 'RETRY' and 'not found' in last_output.lower():
    methods_tried = count_discovery_methods(command_history)

    if methods_tried < 4:
        # Auto-generate next discovery method
        next_methods = get_untried_discovery_methods(command_history, query)
        reflection['next_command_hint'] = f"Try: {next_methods[0]}"
        reflection['thought'] = "Not found with current method. Trying alternative discovery."
    else:
        # After exhaustive search, can conclude "not found"
        reflection['directive'] = 'SOLVED'
        reflection['thought'] = "Exhausted all 4 discovery methods. Resource not found."
```

### Phase 4: Supervisor Discovery Enforcement

**Goal**: Supervisor validates discovery completeness

**Changes** to supervisor prompt:
- Add check: "If query is 'list/find X' and only api-resources was run, REJECT - force multi-method"
- Mandate: "Discovery queries MUST show evidence of: pods grep, svc grep, helm OR api-resources"

### Phase 5: Worker Examples Enhancement

**Goal**: Show LLM explicit multi-method patterns

**Add to worker prompt**:
```
MULTI-METHOD DISCOVERY PATTERN (USE THIS FOR ALL "list/find" QUERIES):

Step 1: Workload discovery
{"tool": "shell_command", "command": "kubectl get pods,deploy,sts -A | grep -i <RESOURCE>", "purpose": "Find workloads"}

Step 2: Network discovery
{"tool": "shell_command", "command": "kubectl get svc,ingress -A | grep -i <RESOURCE>", "purpose": "Find services"}

Step 3: Helm discovery
{"tool": "shell_command", "command": "helm list -A | grep -i <RESOURCE>", "purpose": "Find helm releases"}

Step 4: Only AFTER above - CRD check
{"tool": "kubectl_api_resources"}
```

### Phase 0: PIPELINE THINKING (MOST CRITICAL - USER IDENTIFIED)

**Problem**: Agent breaks tasks into too many atomic kubectl calls instead of using pipes
- ❌ Wrong: `kubectl get pods -A` → parse → filter → grep separately
- ✅ Right: `kubectl get pods -A | grep -i vcluster | awk '{print $1,$2}'` in ONE command

**Root Cause**: Worker thinks in "structured tool calls" not "bash pipelines"

**Solution**: Add "PIPELINE-FIRST THINKING" section to worker prompt:

```
═══════════════════════════════════════════════════════════════════════════════
🔥 **PIPELINE-FIRST THINKING** (READ THIS BEFORE MAKING ANY TOOL CALL)
═══════════════════════════════════════════════════════════════════════════════

**BEFORE choosing a tool, ask yourself:**
"Can I solve this with a SINGLE piped command instead of multiple tool calls?"

❌ **WRONG** (Multiple atomic operations):
Step 1: {"tool": "kubectl_get", "resource": "pods", "all_namespaces": true}
Step 2: Parse output
Step 3: Filter for "failing"
Step 4: Return results

✅ **CORRECT** (One filtered pipeline):
{"tool": "shell_command", "command": "kubectl get pods -A | grep -vE 'Running|Completed' | awk '{print $1,$2,$4}'", "purpose": "Find failing pods"}

**PIPELINE PATTERNS:**

1. **Discovery + Filter**:
   - Bad: Get all → filter later
   - Good: `kubectl get pods -A | grep -i <name>`

2. **Status Check + Parse**:
   - Bad: Get yaml → parse separately
   - Good: `kubectl get <type> <name> -n <ns> -o json | jq -r '.status.conditions[] | select(.status=="False") | .message'`

3. **Logs + Search**:
   - Bad: Get all logs → search separately
   - Good: `kubectl logs <pod> -n <ns> --tail=1000 | grep -i "error" | head -20`

4. **Count/Aggregate**:
   - Bad: Get list → count separately
   - Good: `kubectl get pods -A | grep -vE 'Running|Completed' | wc -l`

5. **Multi-Resource Discovery**:
   - Bad: Get pods, then get deploy, then get svc separately
   - Good: `kubectl get pods,deploy,svc -A | grep -i <term>`

**WHEN TO USE PIPELINES:**
- Any query with "list", "find", "count", "show"
- Any filtering operation (status, namespace, name pattern)
- Any log search or analysis
- Any data extraction (fields, conditions, errors)

**WHEN STRUCTURED TOOLS ARE OK:**
- Specific single resource: `kubectl describe pod X -n Y`
- Simple get without filters: `kubectl get nodes`
- Operations requiring specific flags: `kubectl logs --previous`
```

**Additional Changes Needed**:
1. Move ShellCommand to **#1** in tools list (before KubectlGet)
2. Add counter-examples showing inefficient multi-step approaches
3. Reward pipeline thinking in reflection node

## Priority Order:

1. **MOST CRITICAL**: Pipeline-First Thinking (Phase 0) ← USER-IDENTIFIED ISSUE
2. **CRITICAL**: Worker prompt restructuring (Phase 1)
3. **HIGH**: Reflection auto-expansion (Phase 3)
4. **MEDIUM**: Evidence validator relaxation (Phase 2)
5. **LOW**: Worker examples (Phase 5)

## Expected Outcomes:

✅ Agent tries ShellCommand with grep for ALL discovery queries
✅ Agent doesn't stop after api-resources returns nothing
✅ Agent autonomously expands search when initial results are empty
✅ Evidence validator allows worker to try 2-3 methods before blocking
✅ Deep, thorough investigation WITHOUT user intervention

## Test Cases After Implementation:

1. **"list vclusters"** → Should try pods grep, svc grep, helm BEFORE concluding
2. **"find argocd"** → Should find argocd via pods even if no CRD exists
3. **"why is customercluster X failing"** → Should climb to controller logs automatically
4. **"list customerclusters"** → Should preserve exact name, use multi-method discovery

