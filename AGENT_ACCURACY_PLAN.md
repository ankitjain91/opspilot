# Agent Accuracy Improvement Plan

## Current Setup
- **Brain Model**: 70B (llama3.3:70b) - for supervisor, reflect, verify
- **Coder Model**: 32B (qwen2.5-coder:32b) - for worker node (kubectl generation)

## Analysis Summary

After reviewing the agent architecture in `python/agent_server.py`, I've identified the following issues and improvements needed to make the agents "ironclad accurate".

---

## Critical Issues Identified

### 1. Model Capability Mismatch
**Problem**: The 70B brain model is used for EVERYTHING except command generation. This is wasteful and slow.

**Current Flow**:
- Supervisor (70B) → Worker (32B) → Verify (70B) → Execute → Reflect (70B)
- 3 calls to 70B per iteration = SLOW

**Fix**: Use 32B for verify (simple rule checking), reserve 70B for complex reasoning only.

### 2. Prompt Overload for Small Models
**Problem**: The SUPERVISOR_PROMPT is ~1700 tokens of instructions. For a 70B model with limited context window efficiency, this can overwhelm the reasoning.

**Symptoms**:
- Model ignores later instructions
- Model doesn't follow JSON format correctly
- Model loops instead of responding

**Fix**: Restructure prompts with PRIORITY sections and move less critical rules to examples.

### 3. Worker Prompt Lacks Concrete Patterns
**Problem**: WORKER_PROMPT tells what NOT to do but lacks strong positive patterns for common cases.

**Current**: "DO NOT use placeholders like `<pod-name>`"
**Better**: Show exact examples of good vs bad commands.

### 4. Reflect Node Too Aggressive
**Problem**: REFLECT_PROMPT says "BE AGGRESSIVE" but then marks things as solved too early.

**Symptoms**:
- Lists pods and says "SOLVED" when user asked to debug
- Sees OOMKilled but doesn't explain memory limit fix

### 5. Few-Shot Example Selection Issues
**Problem**: `select_examples()` uses keyword matching which can miss semantic similarity.

**Example**: User asks "why is my database slow" but examples are keyed on "postgres", "mysql", "performance".

### 6. Command Loop Detection Weak
**Problem**: Only checks exact string match on last 5 commands.

```python
recent_commands = [cmd.get("command", "").strip() for cmd in history[-5:]]
if command_text.strip() in recent_commands:
    # blocked
```

**Issue**: `kubectl get pods` vs `kubectl get pods ` (trailing space) bypasses detection.

### 7. No Output Truncation Strategy
**Problem**: Large outputs (thousands of pods) overwhelm the context.

**Fix**: Smart truncation that keeps headers + problematic rows.

---

## Improvement Plan

### Phase 1: Prompt Engineering (High Impact, Low Risk)

#### 1.1 Restructure SUPERVISOR_PROMPT with Priority Levels

```
PRIORITY 1 (ALWAYS):
- JSON format compliance
- RESPOND if answer is known
- NAMESPACE discovery before commands

PRIORITY 2 (IMPORTANT):
- KB context usage
- Root cause identification
- Stop-when-found logic

PRIORITY 3 (GUIDELINES):
- Efficiency batching
- Clarifying questions
```

#### 1.2 Add Explicit JSON Examples to Worker
Add 3-5 concrete examples showing:
- Good: `{"thought": "...", "command": "kubectl get pods -n web"}`
- Bad: `{"thought": "...", "command": "kubectl get pods -n $NS"}`

#### 1.3 Strengthen Reflect Decision Tree
Replace free-form reasoning with structured decision:
```
IF output contains root cause pattern THEN found_solution=true
ELSE IF output is empty/error THEN found_solution=false, hint="check namespace"
ELSE IF output is list and query was "list" THEN found_solution=true
ELSE found_solution=false, explain what's missing
```

### Phase 2: Model Configuration Optimization

#### 2.1 Temperature Settings
- Supervisor: 0.3 (balanced creativity for planning)
- Worker: 0.1 (deterministic command generation)
- Reflect: 0.2 (consistent assessment)
- Verify: 0.0 (rule-based, no creativity)

#### 2.2 Context Window Management
- Limit command history to 3 most recent
- Truncate outputs to 2000 chars with smart selection
- Use summary for older history

### Phase 3: Logic Improvements

#### 3.1 Better Command Deduplication
```python
def normalize_command(cmd: str) -> str:
    """Normalize for comparison"""
    cmd = cmd.strip()
    cmd = re.sub(r'\s+', ' ', cmd)  # collapse whitespace
    cmd = re.sub(r'--tail=\d+', '--tail=N', cmd)  # normalize tail
    return cmd

def is_duplicate(new_cmd, history):
    normalized = normalize_command(new_cmd)
    for h in history[-5:]:
        if normalize_command(h.get('command', '')) == normalized:
            return True
    return False
```

#### 3.2 Output Truncation with Intelligence
```python
def smart_truncate(output: str, max_chars: int = 3000) -> str:
    """Keep header + problematic rows"""
    lines = output.split('\n')
    if len('\n'.join(lines)) <= max_chars:
        return output

    header = lines[0] if lines else ''
    problem_keywords = ['Error', 'Failed', 'CrashLoop', 'OOM', 'Pending', '0/']

    important = [header]
    normal = []

    for line in lines[1:]:
        if any(kw in line for kw in problem_keywords):
            important.append(line)
        else:
            normal.append(line)

    result = '\n'.join(important)
    remaining = max_chars - len(result)

    if remaining > 100 and normal:
        result += f"\n... ({len(normal)} healthy resources omitted) ..."

    return result
```

#### 3.3 Query Classification in Supervisor
Add explicit classification at the start:
```python
QUERY_TYPE = classify_query(query)  # list, debug, explain, discover

if QUERY_TYPE == 'explain':
    # Skip kubectl, respond directly
elif QUERY_TYPE == 'list':
    # One command, then respond
elif QUERY_TYPE == 'debug':
    # Full investigation flow
```

### Phase 4: Few-Shot Example Improvements

#### 4.1 Add Negative Examples
Show what NOT to do:
```
BAD EXAMPLE (DO NOT DO THIS):
User: "List pods"
Brain: {"next_action": "delegate", "plan": "Get pods then describe them"}
WHY BAD: User asked to list, not debug. Should respond after get.

GOOD EXAMPLE:
User: "List pods"
Brain: {"next_action": "delegate", "plan": "Get pods and respond"}
```

#### 4.2 Add 70B-Specific Formatting
Larger models benefit from structured thinking:
```
<thinking>
1. What did user ask? [list/debug/explain]
2. What do I know? [from history]
3. What do I need? [next command or ready to respond]
</thinking>
<action>
{"thought": "...", "plan": "...", "next_action": "..."}
</action>
```

### Phase 5: Verification & Testing

#### 5.1 Add Unit Tests for Prompts
```python
def test_supervisor_list_query():
    """Supervisor should respond after one list command"""
    state = {
        'query': 'List pods in namespace web',
        'command_history': [
            {'command': 'kubectl get pods -n web', 'output': 'NAME\nweb-1\nweb-2'}
        ]
    }
    result = supervisor_node(state)
    assert result['next_action'] == 'respond'
```

#### 5.2 Evaluation Dataset
Create 20 test cases covering:
- Simple listing (5 cases)
- Explanation queries (3 cases)
- CrashLoopBackOff debugging (3 cases)
- OOMKilled diagnosis (2 cases)
- Crossplane/CRD discovery (3 cases)
- Namespace discovery (2 cases)
- Ambiguous queries (2 cases)

---

## Implementation Order

1. **Immediate** (can do now):
   - Add temperature configuration
   - Improve command deduplication
   - Add output truncation

2. **Short-term** (1-2 days):
   - Restructure SUPERVISOR_PROMPT with priorities
   - Add negative examples to few-shot
   - Improve REFLECT decision logic

3. **Medium-term** (3-5 days):
   - Create evaluation dataset
   - Add unit tests for critical paths
   - Tune example selection algorithm

---

## Specific Code Changes

### File: `python/agent_server.py`

#### Change 1: Add temperature to LLM calls
```python
# Line ~218
async def call_llm(prompt: str, model: str, temperature: float = 0.3) -> str:
    ...
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "temperature": temperature,  # ADD THIS
        "options": {
            "num_ctx": 8192,
            "temperature": temperature  # AND THIS
        }
    }
```

#### Change 2: Smarter output truncation
```python
# Add before supervisor_node
def smart_truncate_output(output: str, max_chars: int = 3000) -> str:
    # Implementation above
```

#### Change 3: Normalize command comparison
```python
# Add to worker_node
def normalize_command(cmd: str) -> str:
    # Implementation above
```

#### Change 4: Restructure SUPERVISOR_PROMPT (abbreviated)
```python
SUPERVISOR_PROMPT = """You are an Expert Kubernetes Assistant.

=== PRIORITY 1: ALWAYS FOLLOW ===
1. OUTPUT VALID JSON with keys: thought, plan, next_action, final_response
2. If you have the answer from command_history, set next_action="respond"
3. NEVER guess namespace. Use `kubectl get <type> -A | grep <name>` first.

=== PRIORITY 2: TASK HANDLING ===
- LISTING: One kubectl get, then respond
- EXPLAIN: No kubectl, respond immediately
- DEBUG: Logs → Describe → Events → Root Cause

=== YOUR CONTEXT ===
KB Context: {kb_context}
Query: {query}
History: {command_history}

=== OUTPUT FORMAT ===
{{"thought": "...", "plan": "...", "next_action": "delegate|respond", "final_response": "..."}}
"""
```

---

## Expected Outcomes

After implementing these changes:

1. **Accuracy**: 90%+ correct responses on test dataset
2. **Efficiency**: Average 2.5 iterations per query (down from 4+)
3. **Speed**: 40% faster due to fewer 70B calls
4. **Reliability**: No more JSON parse failures
5. **User Experience**: Clear, actionable answers with evidence

---

## Questions for User

Before implementing, I need clarification on:

1. What specific queries are failing? (Examples help tune prompts)
2. Are you seeing JSON parse errors or wrong answers?
3. Is the issue with listing, debugging, or explanation queries?
4. Do you want me to implement Phase 1 first (prompt engineering) or all phases?
