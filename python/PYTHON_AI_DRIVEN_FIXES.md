# Python Agent AI-Driven Fixes - No More Hardcoding!

## Problem

The Python LangGraph agent was generating commands with placeholders like:
```bash
kubectl get events -n ns | grep taasvstst
#                     ^^^ PLACEHOLDER! Should be actual namespace
```

**Root Cause**: The AI didn't have enough context about what resources actually exist in the cluster.

## Solution: Feed the AI, Don't Hardcode Rules

Instead of hardcoding placeholder validation (which we just removed from TypeScript!), we:

1. **Extract resources** from command outputs
2. **Track discovered context** in agent state
3. **Inject context** into AI prompts
4. **Validate with helpful feedback** instead of silent blocking

## Changes Made

### 1. New Module: `context_builder.py` (200+ lines)

**Purpose**: Extract and manage discovered resources from kubectl outputs

**Key Functions**:

```python
def extract_resources_from_output(command: str, output: str) -> Dict[str, List[str]]:
    """
    Extract resource names, namespaces from kubectl output.

    Example:
        Input: kubectl get customercluster -A | grep taasvstst
        Output: taasvstst   taasvstst   ASFailed   9d

        Extracted: {
            "namespaces": ["taasvstst"],
            "customerclusters": ["taasvstst"]
        }
    """
```

```python
def build_discovered_context(discovered_resources: Dict) -> str:
    """
    Build human-readable context for AI prompts.

    Output:
        "DISCOVERED RESOURCES (use these actual names, NO placeholders):
          Namespaces: taasvstst, production, default
          customerclusters: taasvstst
          pods: api-server-123, nginx-456"
    """
```

```python
def validate_command_has_no_placeholders(command: str, discovered_resources: Dict) -> tuple[bool, str]:
    """
    AI-friendly validation with helpful suggestions.

    Instead of: "ERROR: Invalid placeholder"
    Returns: "Command contains placeholders: ['ns']

              Available namespaces: taasvstst, production, default
              Available customerclusters: taasvstst

              Run discovery command first if needed:
                kubectl get customercluster -A | grep <name>"
    """
```

### 2. Updated: `prompts_templates.py`

**Before**:
```python
WORKER_PROMPT = """
TASK: {plan}
CONTEXT: {kube_context}
LAST COMMAND: {last_command_info}

DO NOT REPEAT THESE COMMANDS (already executed):
{avoid_commands}
"""
```

**After**:
```python
WORKER_PROMPT = """
TASK: {plan}
CONTEXT: {kube_context}
LAST COMMAND: {last_command_info}

{discovered_context}  # <-- NEW! Actual resource names

DO NOT REPEAT THESE COMMANDS (already executed):
{avoid_commands}
"""
```

### 3. Updated: `nodes/worker.py`

**Added context building**:
```python
from ..context_builder import (
    build_discovered_context,
    extract_resources_from_output,
    merge_discovered_resources
)

# Build context from discovered resources
discovered_context_str = build_discovered_context(state.get('discovered_resources'))

prompt = WORKER_PROMPT.format(
    plan=plan,
    kube_context=state['kube_context'],
    last_command_info=last_cmd_str,
    avoid_commands=avoid_commands_str,
    discovered_context=discovered_context_str,  # <-- Feed the AI!
)
```

**Added resource extraction after execution**:
```python
# Extract discovered resources from output - FEED THE AI!
discovered_resources = extract_resources_from_output(command, raw_output)
merged_resources = merge_discovered_resources(
    state.get('discovered_resources'),
    discovered_resources
)

print(f"[agent-sidecar] 🔍 Discovered resources: {discovered_resources}", flush=True)

updated_state['discovered_resources'] = merged_resources
```

### 4. Updated: `nodes/verify.py`

**Added AI-friendly placeholder validation**:
```python
from ..context_builder import validate_command_has_no_placeholders

# AI-FRIENDLY PLACEHOLDER CHECK - give helpful feedback instead of just blocking
is_valid, error_message = validate_command_has_no_placeholders(
    command,
    state.get('discovered_resources')
)
if not is_valid:
    return {
        **state,
        'next_action': 'supervisor',
        'command_history': state['command_history'] + [{
            'command': command,
            'output': '',
            'error': f'PLACEHOLDER DETECTED: {error_message}'
        }],
    }
```

## How It Works Now

### Example: User asks "why is taasvstst in ASFailed status?"

**Step 1: First Command (Discovery)**
```
Supervisor: "Find the customercluster taasvstst"
Worker generates: kubectl get customercluster -A | grep taasvstst
```

**Execution extracts resources**:
```python
{
    "namespaces": ["taasvstst"],
    "customerclusters": ["taasvstst"]
}
```

**Step 2: Second Command (Deep Dive)**
Worker prompt now includes:
```
DISCOVERED RESOURCES (use these actual names, NO placeholders):
  Namespaces: taasvstst
  customerclusters: taasvstst

TASK: Get detailed status of customercluster taasvstst
```

Worker generates:
```bash
kubectl describe customercluster taasvstst -n taasvstst
#                                 ^^^^^^^^      ^^^^^^^^
#                                 ACTUAL NAME!  ACTUAL NAMESPACE!
```

✅ **NO PLACEHOLDERS!** The AI knows the actual names.

### Counter-Example: If AI Still Uses Placeholder

Worker tries to generate:
```bash
kubectl describe customercluster taasvstst -n ns
#                                             ^^
```

Verify node catches it:
```
PLACEHOLDER DETECTED: Command contains placeholders: ['ns']

Available namespaces: taasvstst

You MUST use actual resource names from discovered resources:
  Namespaces: taasvstst

If you don't have the namespace/name yet, your NEXT command should discover it with:
  kubectl get customercluster -A | grep taasvstst
```

Supervisor sees the error, tries again with correct namespace.

## Benefits

### ✅ No Hardcoding
- Zero hardcoded placeholder patterns
- Zero hardcoded resource name lists
- Zero hardcoded namespace mappings

### ✅ Self-Correcting
- AI gets helpful feedback, not cryptic errors
- Suggestions based on ACTUAL discovered resources
- Learns what's available in THIS cluster

### ✅ Context-Aware
- Tracks what's been discovered during the session
- Builds incrementally (doesn't forget previous discoveries)
- Cluster-specific (works with any resources)

### ✅ AI-Friendly Validation
- Validation helps the AI learn, not just blocks it
- Provides alternatives from discovered context
- Explains WHY something failed

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Supervisor: "Find failing customerclusters"           │
└───────────────────────┬─────────────────────────────────┘
                        │
                        v
┌─────────────────────────────────────────────────────────┐
│  Worker (with discovered context):                     │
│  - Namespaces: taasvstst, prod, dev                    │
│  - customerclusters: taasvstst, prod-cluster           │
│                                                         │
│  Generates: kubectl get customercluster -A | grep ASF  │
└───────────────────────┬─────────────────────────────────┘
                        │
                        v
┌─────────────────────────────────────────────────────────┐
│  Verify: Check for placeholders                        │
│  - Validates against discovered resources              │
│  - Provides helpful error if placeholder found         │
└───────────────────────┬─────────────────────────────────┘
                        │
                        v
┌─────────────────────────────────────────────────────────┐
│  Execute: kubectl get customercluster -A | grep ASF     │
│  Output: taasvstst   taasvstst   ASFailed   9d         │
└───────────────────────┬─────────────────────────────────┘
                        │
                        v
┌─────────────────────────────────────────────────────────┐
│  Extract Resources:                                     │
│  {                                                      │
│    "namespaces": ["taasvstst"],                        │
│    "customerclusters": ["taasvstst"]                   │
│  }                                                      │
│  → Merged into state.discovered_resources              │
└───────────────────────┬─────────────────────────────────┘
                        │
                        v
┌─────────────────────────────────────────────────────────┐
│  Reflect: "Found 1 failing cluster, need details"      │
└───────────────────────┬─────────────────────────────────┘
                        │
                        v
┌─────────────────────────────────────────────────────────┐
│  Worker (now with MORE context):                       │
│  - Namespaces: taasvstst                               │
│  - customerclusters: taasvstst                         │
│                                                         │
│  Generates: kubectl describe customercluster \         │
│             taasvstst -n taasvstst                     │
│             ^^^^^^^^      ^^^^^^^^                      │
│             USES ACTUAL NAMES!                         │
└─────────────────────────────────────────────────────────┘
```

## Testing

### Test Case 1: Discovery → Details
```bash
# User: "why is customercluster taasvstst failing?"

# Command 1 (Discovery)
kubectl get customercluster -A | grep taasvstst
# Extracts: namespaces=["taasvstst"], customerclusters=["taasvstst"]

# Command 2 (Details) - Uses discovered namespace!
kubectl describe customercluster taasvstst -n taasvstst

# Command 3 (Logs) - Uses discovered namespace!
kubectl logs -n taasvstst -l app=customercluster-operator --tail=100
```

### Test Case 2: Placeholder Detection
```python
# If AI tries:
command = "kubectl describe pod <pod-name> -n default"

# Validation catches it:
is_valid, error = validate_command_has_no_placeholders(command, discovered_resources)
# Returns:
# is_valid = False
# error = "Command contains placeholders: ['<pod-name>']
#          Available pods: api-server-123, nginx-456
#          Use actual pod names from discovered resources"
```

## Comparison

### Before (Hardcoded)
```python
# Hardcoded patterns
if '<' in command or '${' in command or '$(' in command:
    return "ERROR: Placeholder detected"
```

**Problems**:
- No helpful feedback
- No suggestions
- Doesn't learn from cluster state
- Just blocks without guidance

### After (AI-Driven)
```python
# Context-aware validation
discovered_context = build_discovered_context(state.discovered_resources)
is_valid, helpful_error = validate_command_has_no_placeholders(command, discovered_resources)

if not is_valid:
    return f"""PLACEHOLDER DETECTED: {helpful_error}

    Available resources:
    {discovered_context}

    Suggested next command:
      kubectl get <type> -A | grep <search>"""
```

**Benefits**:
- Helpful, actionable feedback
- Suggests actual resource names
- Explains HOW to fix it
- AI learns and self-corrects

## Summary

**The Fix**: Instead of hardcoding "don't use placeholders", we:

1. ✅ **Track what's been discovered** during investigation
2. ✅ **Feed actual resource names** to the AI in prompts
3. ✅ **Validate with helpful feedback** instead of cryptic errors
4. ✅ **Self-correcting loop** - AI learns from mistakes

**Result**: The AI now uses ACTUAL resource names because it KNOWS what exists in the cluster!

---

**Status**: ✅ IMPLEMENTED

The Python agent is now **truly AI-driven** with dynamic context awareness instead of hardcoded rules.
