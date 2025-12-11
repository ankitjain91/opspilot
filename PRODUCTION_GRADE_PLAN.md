# Production-Grade AI Agent Plan for Defense Companies

## Executive Summary

This document outlines a comprehensive plan to make the K8s IDE's AI agent production-ready for defense companies. The current implementation has fundamental issues with prompt engineering, tool calling, and reliability that prevent it from working well with capable models like Llama 3.3 70B and Qwen 2.5 32B Coder.

## Phase 1: Fix Core Agent Architecture (Critical)

### 1.1 Implement Structured Output with JSON Mode

**Problem:** Modelfiles expect JSON output, but code expects `EXECUTE:/RESPOND:` format.

**Solution:** Align code with Modelfile expectations using JSON mode.

```typescript
// New structured output format
interface AgentResponse {
  thought: string;           // Chain-of-thought reasoning
  action: 'tool' | 'respond';
  tool?: {
    name: string;            // CLUSTER_HEALTH, RUN_KUBECTL, etc.
    args?: string;
  };
  response?: string;         // Final response to user
  confidence?: 'high' | 'medium' | 'low';
}
```

**Implementation:**
- Update `langGraphAgent.ts` to expect and parse JSON responses
- Add JSON schema validation with retry on malformed output
- Use Ollama's `format: "json"` parameter for guaranteed JSON

### 1.2 Implement Native Tool Calling

**Problem:** Both Llama 3.3 and Qwen 2.5 support native function calling, but we use regex.

**Solution:** Use OpenAI-compatible tool calling API.

```typescript
// Tool definition for Ollama/OpenAI
const tools = [
  {
    type: "function",
    function: {
      name: "run_kubectl",
      description: "Execute a read-only kubectl command",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The kubectl command to run (without 'kubectl' prefix)"
          }
        },
        required: ["command"]
      }
    }
  },
  // ... other tools
];
```

**Benefits:**
- Reliable tool extraction (no regex)
- Model understands tool semantics
- Parallel tool calls support

### 1.3 Implement Proper ReAct Pattern

**Problem:** Current loop is too simple - 5 iterations max, no reasoning structure.

**Solution:** Implement full ReAct pattern with scratchpad.

```typescript
const REACT_PROMPT = `You are a Kubernetes SRE expert investigating an issue.

## INVESTIGATION PROTOCOL
1. **Thought**: Analyze what you know and what you need to find out
2. **Action**: Execute ONE tool to gather evidence
3. **Observation**: Review the tool output
4. **Repeat**: Continue until confident in diagnosis

## AVAILABLE TOOLS
${toolDescriptions}

## CURRENT INVESTIGATION
Query: ${query}
Context: ${kubeContext}

## INVESTIGATION LOG
${scratchpad}

## YOUR TURN
Provide your next step as JSON:
{
  "thought": "Your reasoning about what to investigate next...",
  "action": "tool" | "respond",
  "tool": {"name": "TOOL_NAME", "args": "arguments"},  // if action is "tool"
  "response": "Final answer with diagnosis..."          // if action is "respond"
}`;
```

### 1.4 Add Few-Shot Examples

**Problem:** Large models need examples to understand expected output format.

**Solution:** Include 2-3 examples in the prompt.

```typescript
const FEW_SHOT_EXAMPLES = `
## EXAMPLE 1: Pod CrashLoopBackOff
User: "Why is my app crashing?"
{"thought": "User reports app crashing. First, I need to find pods that aren't running normally.", "action": "tool", "tool": {"name": "FIND_ISSUES", "args": ""}}
Observation: Found 2 pods in CrashLoopBackOff: web-app-xyz in namespace production
{"thought": "Found crashing pods. Need to check logs to understand the crash reason.", "action": "tool", "tool": {"name": "GET_LOGS", "args": "production web-app-xyz"}}
Observation: Error: cannot connect to database at db.internal:5432
{"thought": "The pod is crashing because it cannot connect to the database. I should verify the database service exists.", "action": "tool", "tool": {"name": "GET_ENDPOINTS", "args": "production db"}}
Observation: No endpoints found for service db
{"thought": "Root cause identified: The database service has no endpoints, meaning no database pods are ready.", "action": "respond", "response": "**Root Cause:** Your app is crashing because it cannot connect to the database.\\n\\n**Evidence:**\\n- Pod web-app-xyz logs show: 'cannot connect to database at db.internal:5432'\\n- Service 'db' has no endpoints (no healthy database pods)\\n\\n**Fix:** Check the database deployment in namespace 'production' - pods may be failing or not scheduled."}

## EXAMPLE 2: High Memory Usage
...
`;
```

## Phase 2: Reliability & Error Handling

### 2.1 Implement Retry with Exponential Backoff

```typescript
async function callLLMWithRetry(
  prompt: string,
  maxRetries: number = 3
): Promise<AgentResponse> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await callLLM(prompt);
      const parsed = parseAndValidateJSON(response);
      return parsed;
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      // Exponential backoff: 1s, 2s, 4s
      await sleep(Math.pow(2, attempt) * 1000);

      // If JSON parse error, add hint to prompt
      if (error instanceof JSONParseError) {
        prompt += "\n\nIMPORTANT: Your previous response was not valid JSON. Please ensure your response is a single valid JSON object.";
      }
    }
  }
}
```

### 2.2 Implement Semantic Context Compression

**Problem:** Middle truncation loses important evidence.

**Solution:** Summarize older context semantically.

```typescript
function compressToolHistory(history: ToolOutcome[]): string {
  if (history.length <= 3) {
    return formatFullHistory(history);
  }

  // Keep first 2 (initial discovery) and last 2 (recent findings)
  const important = [...history.slice(0, 2), ...history.slice(-2)];

  // Summarize middle
  const middle = history.slice(2, -2);
  const summary = middle.map(t =>
    `- ${t.tool}: ${t.useful ? 'Found evidence' : 'No findings'}`
  ).join('\n');

  return `
## Initial Discovery
${formatHistory(history.slice(0, 2))}

## Investigation Summary (${middle.length} tools)
${summary}

## Recent Findings
${formatHistory(history.slice(-2))}
`;
}
```

### 2.3 Implement Output Validation

```typescript
import Ajv from 'ajv';

const agentResponseSchema = {
  type: 'object',
  properties: {
    thought: { type: 'string', minLength: 10 },
    action: { enum: ['tool', 'respond'] },
    tool: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        args: { type: 'string' }
      }
    },
    response: { type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'] }
  },
  required: ['thought', 'action'],
  if: { properties: { action: { const: 'tool' } } },
  then: { required: ['tool'] },
  else: { required: ['response'] }
};

function validateAgentResponse(json: unknown): AgentResponse {
  const ajv = new Ajv();
  const validate = ajv.compile(agentResponseSchema);

  if (!validate(json)) {
    throw new ValidationError(validate.errors);
  }

  return json as AgentResponse;
}
```

## Phase 3: Streaming & UX

### 3.1 Implement LLM Response Streaming

**Problem:** 30-60 second waits with no feedback.

**Solution:** Stream tokens as they arrive.

```rust
// In ai_local.rs
#[tauri::command]
pub async fn call_llm_streaming(
    config: LLMConfig,
    prompt: String,
    system_prompt: Option<String>,
    window: tauri::Window,
) -> Result<String, String> {
    let stream_id = uuid::Uuid::new_v4().to_string();

    // Emit start event
    window.emit("llm-stream", LLMStreamEvent {
        stream_id: stream_id.clone(),
        event_type: "start".to_string(),
        content: "".to_string(),
    }).ok();

    // ... setup request with stream: true ...

    let mut full_response = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        // Parse SSE chunk
        let text = parse_sse_chunk(&chunk)?;
        full_response.push_str(&text);

        // Emit chunk event
        window.emit("llm-stream", LLMStreamEvent {
            stream_id: stream_id.clone(),
            event_type: "chunk".to_string(),
            content: text,
        }).ok();
    }

    // Emit done event
    window.emit("llm-stream", LLMStreamEvent {
        stream_id: stream_id.clone(),
        event_type: "done".to_string(),
        content: "".to_string(),
    }).ok();

    Ok(full_response)
}
```

### 3.2 Implement Progress Indicators

```typescript
// Show investigation progress in UI
interface InvestigationProgress {
  phase: 'discovery' | 'analysis' | 'diagnosis' | 'synthesis';
  iteration: number;
  maxIterations: number;
  currentTool?: string;
  evidenceFound: number;
  hypothesis?: string;
}

// Update UI during investigation
onProgress?.({
  phase: 'analysis',
  iteration: 3,
  maxIterations: 10,
  currentTool: 'GET_LOGS',
  evidenceFound: 2,
  hypothesis: 'Possible OOM issue based on exit code 137'
});
```

## Phase 4: Defense-Grade Security

### 4.1 Audit Logging

```typescript
interface AuditLog {
  timestamp: string;
  session_id: string;
  user_id?: string;
  action: 'llm_call' | 'tool_execution' | 'command_blocked';
  input: string;
  output: string;
  model: string;
  duration_ms: number;
  cluster_context: string;
  ip_address?: string;
}

async function auditLog(log: AuditLog): Promise<void> {
  // Write to secure append-only log
  await invoke('append_audit_log', { log });

  // Also emit to SIEM if configured
  if (siemEndpoint) {
    await fetch(siemEndpoint, {
      method: 'POST',
      body: JSON.stringify(log),
    });
  }
}
```

### 4.2 Prompt Injection Protection

```typescript
const DANGEROUS_PATTERNS = [
  /ignore (previous|all|above) instructions/i,
  /you are now/i,
  /new system prompt/i,
  /disregard your training/i,
  /pretend you are/i,
  /\[\[SYSTEM\]\]/i,
  /<\|.*?\|>/,  // Token manipulation attempts
];

function sanitizeUserInput(input: string): { safe: boolean; sanitized: string; reason?: string } {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) {
      return {
        safe: false,
        sanitized: input.replace(pattern, '[REDACTED]'),
        reason: 'Potential prompt injection detected'
      };
    }
  }

  // Length limit
  if (input.length > 10000) {
    return {
      safe: false,
      sanitized: input.slice(0, 10000),
      reason: 'Input too long'
    };
  }

  return { safe: true, sanitized: input };
}
```

### 4.3 Response Filtering

```typescript
const SECRET_PATTERNS = [
  /(?:password|secret|token|api[_-]?key)\s*[:=]\s*[^\s]+/gi,
  /-----BEGIN [A-Z]+ PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/,  // JWT tokens
  /AKIA[0-9A-Z]{16}/,  // AWS Access Keys
  /[a-zA-Z0-9+/]{40,}/,  // Base64 secrets
];

function filterSecrets(output: string): string {
  let filtered = output;
  for (const pattern of SECRET_PATTERNS) {
    filtered = filtered.replace(pattern, '[REDACTED]');
  }
  return filtered;
}
```

### 4.4 Rate Limiting

```typescript
class RateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }> = new Map();

  constructor(
    private maxTokens: number = 10,
    private refillRate: number = 1,  // tokens per second
    private refillInterval: number = 1000
  ) {}

  async acquire(key: string): Promise<boolean> {
    const bucket = this.buckets.get(key) || { tokens: this.maxTokens, lastRefill: Date.now() };

    // Refill tokens
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.refillInterval) * this.refillRate;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    if (bucket.tokens > 0) {
      bucket.tokens--;
      this.buckets.set(key, bucket);
      return true;
    }

    return false;
  }
}
```

## Phase 5: Model-Specific Optimizations

### 5.1 Llama 3.3 70B Configuration

```typescript
const LLAMA_3_3_CONFIG = {
  // Use native tool calling
  tools: KUBERNETES_TOOLS,
  tool_choice: 'auto',

  // Optimal parameters
  temperature: 0.1,  // Low for consistency
  top_p: 0.9,
  max_tokens: 4096,

  // Important: Use chat template
  prompt_format: 'llama3',  // Uses <|start_header_id|> format

  // Stop sequences
  stop: ['<|eot_id|>', '<|start_header_id|>user'],
};
```

### 5.2 Qwen 2.5 32B Coder Configuration

```typescript
const QWEN_2_5_CONFIG = {
  // Qwen excels at structured output
  response_format: { type: 'json_object' },

  // Optimal parameters
  temperature: 0.0,  // Maximum determinism
  top_p: 0.9,
  max_tokens: 8192,  // Qwen handles long outputs well

  // Stop sequences
  stop: ['<|endoftext|>', '<|im_end|>'],

  // Qwen-specific: repetition penalty helps
  repeat_penalty: 1.1,
};
```

### 5.3 Dynamic Prompt Adjustment

```typescript
function getModelSpecificPrompt(model: string, basePrompt: string): string {
  if (model.includes('llama')) {
    return `${basePrompt}

IMPORTANT FOR LLAMA:
- Use the provided tools via function calling
- Be concise in your reasoning
- Always include confidence level`;
  }

  if (model.includes('qwen')) {
    return `${basePrompt}

IMPORTANT FOR QWEN:
- Output MUST be valid JSON
- Include detailed technical analysis
- Use code blocks for kubectl commands`;
  }

  return basePrompt;
}
```

## Phase 6: Testing & Validation

### 6.1 Agent Evaluation Framework

```typescript
interface TestCase {
  query: string;
  expectedTools: string[];
  expectedDiagnosis: string[];
  maxIterations: number;
  timeout: number;
}

const TEST_CASES: TestCase[] = [
  {
    query: "Why is my pod crashing?",
    expectedTools: ['FIND_ISSUES', 'GET_LOGS', 'DESCRIBE'],
    expectedDiagnosis: ['crash', 'error', 'exit code'],
    maxIterations: 5,
    timeout: 60000
  },
  {
    query: "Check cluster health",
    expectedTools: ['CLUSTER_HEALTH'],
    expectedDiagnosis: ['nodes', 'pods', 'deployments'],
    maxIterations: 2,
    timeout: 30000
  },
  // ... more test cases
];

async function evaluateAgent(testCases: TestCase[]): Promise<EvaluationReport> {
  const results: TestResult[] = [];

  for (const testCase of testCases) {
    const result = await runAgentWithTimeout(testCase.query, testCase.timeout);

    results.push({
      query: testCase.query,
      passed: evaluateResult(result, testCase),
      toolsUsed: result.toolHistory.map(t => t.tool),
      iterations: result.iterations,
      duration: result.duration,
    });
  }

  return generateReport(results);
}
```

### 6.2 Prompt Regression Testing

```typescript
// Store golden responses for regression testing
interface GoldenResponse {
  prompt: string;
  model: string;
  expectedOutput: AgentResponse;
  tolerance: number;  // Similarity threshold
}

async function testPromptRegression(goldens: GoldenResponse[]): Promise<RegressionReport> {
  const failures: RegressionFailure[] = [];

  for (const golden of goldens) {
    const actual = await callLLM(golden.prompt, golden.model);
    const similarity = calculateSimilarity(actual, golden.expectedOutput);

    if (similarity < golden.tolerance) {
      failures.push({
        prompt: golden.prompt,
        expected: golden.expectedOutput,
        actual,
        similarity
      });
    }
  }

  return { passed: failures.length === 0, failures };
}
```

## Implementation Priorities

### Week 1-2: Critical Fixes
1. Fix prompt/code mismatch - align to JSON output
2. Implement JSON validation with retry
3. Add few-shot examples
4. Fix context compression

### Week 3-4: Reliability
5. Implement streaming
6. Add proper error handling with backoff
7. Fix cache race conditions
8. Add progress indicators

### Week 5-6: Security
9. Implement audit logging
10. Add prompt injection protection
11. Add response filtering
12. Implement rate limiting

### Week 7-8: Polish
13. Model-specific optimizations
14. Evaluation framework
15. Regression testing
16. Documentation

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Tool extraction accuracy | ~60% | >95% |
| Investigation completion rate | ~40% | >90% |
| Average iterations to solution | 5+ (max) | 3-4 |
| User satisfaction (diagnosis quality) | Unknown | >80% |
| Response time (p95) | 60s+ | <30s |
| Audit log coverage | 0% | 100% |
