# Plan: Fully Autonomous AI Investigation Agent

## Executive Summary

Transform the current AI investigation agent into a **fully autonomous, resilient system** that doesn't give up easily, has proper guardrails, and conducts thorough investigations without user hand-holding.

---

## Current State Analysis

### What Works Well
1. **Strong prompt engineering** - Multi-layered system prompts with K8s expertise
2. **Read-only enforcement** - Mutating commands blocked at 3 levels
3. **Intelligent tool routing** - Pre-execution of best tool
4. **Duplicate prevention** - Tracks executed tools across iterations

### Critical Weaknesses (Why Agent "Gives Up")

| Issue | Impact | Priority |
|-------|--------|----------|
| **Weak consecutive error tracking** | Resets on ANY success, even empty lists | P0 |
| **No request timeout** | Can hang indefinitely | P0 |
| **Tool failures hidden from LLM** | Agent repeats same failing approach | P0 |
| **Max 6 iterations hard limit** | Gives up too early on complex issues | P1 |
| **No alternative tool suggestions** | Dead end = complete stop | P1 |
| **Lossy history compression** | Loses critical error info | P1 |
| **No confidence scoring** | User can't tell if agent is guessing | P2 |
| **Placeholder detection gaps** | Misses curly braces, quotes | P2 |

---

## Implementation Plan

### Phase 1: Core Resilience (P0 - Critical)

#### 1.1 Smart Error Tracking & Recovery

**Problem**: Current error tracking resets on ANY successful tool, even if it returns empty/useless data.

**Solution**: Implement **semantic success tracking**:

```typescript
// New types
interface ToolOutcome {
  tool: string;
  args: string;
  result: string;
  status: 'success' | 'error' | 'empty' | 'partial';
  useful: boolean;  // Did this actually help the investigation?
}

// Enhanced tracking
const investigationState = {
  toolHistory: ToolOutcome[];
  consecutiveUnproductive: number;  // Not just errors - empty results too
  hypotheses: string[];              // What we're trying to prove/disprove
  evidenceFor: Map<string, string[]>;
  evidenceAgainst: Map<string, string[]>;
};

// New logic
function evaluateToolOutcome(result: string, toolName: string): ToolOutcome['status'] {
  if (result.startsWith('❌')) return 'error';
  if (result.startsWith('⚠️')) return 'partial';

  // Check for "successful but useless" results
  const emptyPatterns = [
    /no (pods?|events?|resources?) found/i,
    /^(none|empty|n\/a|\[\])$/i,
    /0 items/i,
  ];

  if (emptyPatterns.some(p => p.test(result))) return 'empty';
  return 'success';
}
```

#### 1.2 Request-Level Timeout with Graceful Degradation

**Problem**: No timeout = investigation can hang forever.

**Solution**: Implement **tiered timeout system**:

```typescript
const TIMEOUT_CONFIG = {
  TOOL_EXECUTION: 30_000,      // 30s per tool
  ITERATION: 60_000,           // 60s per iteration
  TOTAL_INVESTIGATION: 180_000, // 3 minutes total
  LLM_CALL: 45_000,            // 45s per LLM call
};

// Wrap investigation with timeout + fallback
async function investigateWithTimeout(message: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_CONFIG.TOTAL_INVESTIGATION);

  try {
    return await investigate(message, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      // Graceful degradation - return what we have
      return generatePartialAnswer(investigationState);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

#### 1.3 Tool Failure Feedback Loop

**Problem**: LLM doesn't see why tools failed, so it keeps trying the same thing.

**Solution**: **Include structured failure info in LLM context**:

```typescript
// Pass failures to LLM with context
const failedToolsContext = failedTools.map(f => `
  ❌ ${f.tool}(${f.args}): ${f.reason}
  💡 Alternatives: ${suggestAlternatives(f.tool, f.args)}
`).join('\n');

const analysisPrompt = `
## Tool Execution History
### Successful Tools
${successfulTools}

### Failed Approaches (DO NOT RETRY THESE)
${failedToolsContext}

### Suggested Next Steps
${generateNextSteps(investigationState)}
`;
```

---

### Phase 2: Intelligent Persistence (P1 - High)

#### 2.1 Dynamic Iteration Budget

**Problem**: Hard limit of 6 iterations doesn't account for investigation complexity.

**Solution**: **Adaptive iteration budget based on progress**:

```typescript
const ITERATION_CONFIG = {
  BASE_ITERATIONS: 6,
  MAX_ITERATIONS: 12,
  BONUS_TRIGGERS: {
    newHypothesis: 2,      // Found new angle to investigate
    partialEvidence: 1,    // Found partial evidence
    newResourceType: 1,    // Started investigating new resource type
  },
};

function calculateRemainingBudget(state: InvestigationState): number {
  let budget = ITERATION_CONFIG.BASE_ITERATIONS - state.iterationCount;

  // Grant bonus iterations for productive investigation
  if (state.lastIterationFoundNewHypothesis) {
    budget += ITERATION_CONFIG.BONUS_TRIGGERS.newHypothesis;
  }

  // Cap at max
  return Math.min(budget, ITERATION_CONFIG.MAX_ITERATIONS - state.iterationCount);
}
```

#### 2.2 Alternative Tool Suggestions

**Problem**: When a tool fails, agent has no guidance on what to try instead.

**Solution**: **Tool fallback chains**:

```typescript
const TOOL_ALTERNATIVES: Record<string, string[]> = {
  'GET_LOGS': ['GET_EVENTS', 'DESCRIBE', 'RUN_KUBECTL get pod -o yaml'],
  'DESCRIBE': ['LIST_ALL', 'GET_EVENTS', 'RUN_KUBECTL get -o wide'],
  'GET_EVENTS': ['DESCRIBE', 'GET_LOGS', 'CLUSTER_HEALTH'],
  'TOP_PODS': ['DESCRIBE', 'GET_EVENTS', 'RUN_KUBECTL top nodes'],
  'GET_ENDPOINTS': ['DESCRIBE Service', 'GET_EVENTS', 'RUN_KUBECTL get ep'],
};

const INVESTIGATION_PATHS: Record<string, string[]> = {
  'CrashLoopBackOff': [
    'GET_LOGS ns pod --previous',
    'DESCRIBE Pod ns pod',
    'GET_EVENTS ns',
    'SEARCH_KNOWLEDGE crashloop oom exit code',
  ],
  'Pending': [
    'DESCRIBE Pod ns pod',
    'GET_EVENTS ns',
    'TOP_PODS',
    'CLUSTER_HEALTH',
  ],
  'ImagePullBackOff': [
    'DESCRIBE Pod ns pod',
    'GET_EVENTS ns',
    'RUN_KUBECTL get secrets',
    'SEARCH_KNOWLEDGE image pull secret registry',
  ],
  // ... more patterns
};
```

#### 2.3 Semantic History Compression

**Problem**: Current compression loses error details after 200 chars.

**Solution**: **Priority-based compression**:

```typescript
function compressToolHistorySemantic(
  results: ToolResult[],
  keepDetailedCount: number = 4
): string {
  const prioritized = results.map(r => ({
    ...r,
    priority: calculatePriority(r),
  })).sort((a, b) => b.priority - a.priority);

  // Keep highest priority results detailed
  const detailed = prioritized.slice(0, keepDetailedCount);
  const summarized = prioritized.slice(keepDetailedCount);

  return [
    '### Key Evidence (Full Detail)',
    ...detailed.map(r => formatDetailed(r)),
    '',
    '### Supporting Evidence (Summary)',
    ...summarized.map(r => formatSummary(r, 300)),  // 300 chars for summaries
  ].join('\n');
}

function calculatePriority(result: ToolResult): number {
  let priority = 0;

  // Error indicators = high priority
  if (/error|fail|crash|oom|killed|backoff/i.test(result.content)) {
    priority += 50;
  }

  // Events and logs = high priority
  if (result.toolName === 'GET_LOGS' || result.toolName === 'GET_EVENTS') {
    priority += 30;
  }

  // Recent = higher priority
  priority += (results.length - result.index) * 5;

  return priority;
}
```

---

### Phase 3: Investigation Intelligence (P1 - High)

#### 3.1 Hypothesis-Driven Investigation

**Problem**: Agent investigates randomly without clear hypotheses.

**Solution**: **Structured hypothesis tracking**:

```typescript
interface Hypothesis {
  id: string;
  description: string;
  likelihood: 'high' | 'medium' | 'low';
  evidenceFor: string[];
  evidenceAgainst: string[];
  toolsToValidate: string[];
  status: 'investigating' | 'confirmed' | 'refuted' | 'inconclusive';
}

// Add to system prompt
const HYPOTHESIS_PROMPT = `
## Investigation Framework

When investigating, maintain hypotheses:

1. **Generate Hypotheses** (2-4 likely causes)
   - Based on symptoms and cluster state
   - Ordered by likelihood

2. **Gather Evidence**
   - For each hypothesis, identify validating/refuting evidence
   - Run tools to collect evidence

3. **Update Confidence**
   - Mark hypotheses as confirmed/refuted based on evidence
   - Generate new hypotheses if all refuted

4. **Report Format**
   \`\`\`
   ### Hypotheses

   #### H1: [Description] - [STATUS]
   - Likelihood: HIGH/MEDIUM/LOW
   - Evidence FOR: [list]
   - Evidence AGAINST: [list]
   - Next tools: [if investigating]
   \`\`\`
`;
```

#### 3.2 Pattern-Based Investigation Playbooks

**Problem**: Agent doesn't follow established debugging patterns.

**Solution**: **Inject relevant playbooks based on detected symptoms**:

```typescript
const PLAYBOOKS = {
  podNotRunning: {
    symptoms: ['Pending', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull'],
    steps: [
      { tool: 'DESCRIBE', target: 'Pod', purpose: 'Check pod status and events' },
      { tool: 'GET_EVENTS', purpose: 'Look for scheduling/resource events' },
      { tool: 'GET_LOGS', args: '--previous', purpose: 'Check previous container logs' },
      { tool: 'TOP_PODS', purpose: 'Check resource pressure' },
      { tool: 'SEARCH_KNOWLEDGE', args: 'symptom keywords', purpose: 'Find similar issues' },
    ],
    commonCauses: [
      'Insufficient resources (CPU/memory)',
      'Image pull issues (wrong image, no credentials)',
      'Node selector/affinity mismatch',
      'PVC not bound',
      'Init container failure',
    ],
  },
  serviceNotWorking: {
    symptoms: ['no endpoints', 'connection refused', '503', '504'],
    steps: [
      { tool: 'GET_ENDPOINTS', purpose: 'Check if service has endpoints' },
      { tool: 'DESCRIBE', target: 'Service', purpose: 'Verify selector matches pods' },
      { tool: 'LIST_ALL', target: 'Pod', purpose: 'Find pods matching selector' },
      { tool: 'DESCRIBE', target: 'Pod', purpose: 'Check pod readiness' },
      { tool: 'GET_EVENTS', purpose: 'Look for endpoint controller events' },
    ],
    commonCauses: [
      'Selector mismatch between service and pods',
      'Pods not ready (failing readiness probes)',
      'No pods matching selector',
      'Wrong port configuration',
    ],
  },
  // ... more playbooks
};

function getRelevantPlaybook(symptoms: string[]): Playbook | null {
  for (const [name, playbook] of Object.entries(PLAYBOOKS)) {
    const matchScore = playbook.symptoms.filter(s =>
      symptoms.some(symptom => symptom.toLowerCase().includes(s.toLowerCase()))
    ).length;

    if (matchScore >= 1) {
      return { name, ...playbook, matchScore };
    }
  }
  return null;
}
```

---

### Phase 4: User Transparency (P2 - Medium)

#### 4.1 Confidence Scoring System

**Problem**: User can't tell if agent is confident or guessing.

**Solution**: **Explicit confidence calculation and display**:

```typescript
interface ConfidenceAssessment {
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;  // 0-100
  factors: {
    evidenceCount: number;
    evidenceQuality: 'direct' | 'indirect' | 'circumstantial';
    hypothesesTested: number;
    confirmedHypotheses: number;
    toolsExecuted: number;
    errorsEncountered: number;
  };
  explanation: string;
}

function calculateConfidence(state: InvestigationState): ConfidenceAssessment {
  const factors = {
    evidenceCount: state.evidenceFor.size + state.evidenceAgainst.size,
    evidenceQuality: assessEvidenceQuality(state),
    hypothesesTested: state.hypotheses.filter(h => h.status !== 'investigating').length,
    confirmedHypotheses: state.hypotheses.filter(h => h.status === 'confirmed').length,
    toolsExecuted: state.toolHistory.length,
    errorsEncountered: state.toolHistory.filter(t => t.status === 'error').length,
  };

  let score = 0;

  // Evidence contribution (max 40 points)
  score += Math.min(factors.evidenceCount * 10, 40);

  // Hypothesis confirmation (max 30 points)
  if (factors.confirmedHypotheses > 0) {
    score += 30;
  } else if (factors.hypothesesTested > 0) {
    score += 15;
  }

  // Tool execution thoroughness (max 20 points)
  score += Math.min(factors.toolsExecuted * 4, 20);

  // Penalty for errors
  score -= factors.errorsEncountered * 5;

  return {
    level: score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW',
    score: Math.max(0, Math.min(100, score)),
    factors,
    explanation: generateConfidenceExplanation(factors, score),
  };
}
```

#### 4.2 Investigation Progress Visualization

**Problem**: User doesn't know what agent is doing or how far along it is.

**Solution**: **Detailed progress updates**:

```typescript
interface InvestigationProgress {
  phase: 'gathering' | 'analyzing' | 'confirming' | 'concluding';
  iteration: number;
  maxIterations: number;
  toolsRun: number;
  hypothesesActive: number;
  confidence: ConfidenceAssessment;
  currentAction: string;
  timeElapsed: number;
  estimatedTimeRemaining: number;
}

// Update activity with rich context
setCurrentActivity({
  text: `🔍 Investigating (${progress.iteration}/${progress.maxIterations})`,
  details: `
    Phase: ${progress.phase}
    Confidence: ${progress.confidence.level} (${progress.confidence.score}%)
    Tools executed: ${progress.toolsRun}
    Active hypotheses: ${progress.hypothesesActive}
    Current: ${progress.currentAction}
  `,
});
```

---

### Phase 5: Guardrails & Safety (P2 - Medium)

#### 5.1 Enhanced Placeholder Detection

**Problem**: Current regex misses curly braces, quotes, partial matches.

**Solution**: **Comprehensive pattern matching**:

```typescript
const PLACEHOLDER_PATTERNS = [
  /\[[\w\s-]+\]/,           // [pod-name]
  /<[\w\s-]+>/,             // <pod-name>
  /\{[\w\s-]+\}/,           // {pod-name}
  /\{\{[\w\s-]+\}\}/,       // {{pod-name}}
  /\$\{[\w\s-]+\}/,         // ${pod-name}
  /"[\w\s-]+-name"/i,       // "pod-name"
  /'[\w\s-]+-name'/i,       // 'pod-name'
  /\.\.\./,                 // ...
  /xxx+/i,                  // xxx
  /example/i,               // example
  /your-/i,                 // your-pod
  /my-/i,                   // my-deployment
  /sample-/i,               // sample-app
  /test-(?!runner)/i,       // test- (but not test-runner which could be real)
];

function containsPlaceholder(text: string): boolean {
  return PLACEHOLDER_PATTERNS.some(p => p.test(text));
}

function getPlaceholderGuidance(toolName: string, invalidArgs: string): string {
  const guidance = {
    'DESCRIBE': `
      To describe a specific resource, first discover actual names:
      → TOOL: LIST_ALL ${extractResourceKind(invalidArgs)}
      → Then use: TOOL: DESCRIBE ${extractResourceKind(invalidArgs)} <namespace> <actual-name>
    `,
    'GET_LOGS': `
      To get logs, first find actual pod names:
      → TOOL: FIND_ISSUES (shows unhealthy pods)
      → TOOL: LIST_ALL Pod
      → Then use: TOOL: GET_LOGS <namespace> <actual-pod-name>
    `,
    // ... more guidance
  };

  return guidance[toolName] || 'Run LIST_ALL to discover actual resource names.';
}
```

#### 5.2 Rate Limiting & Circuit Breaker

**Problem**: No protection against rapid tool execution or repeated failures.

**Solution**: **Circuit breaker pattern**:

```typescript
interface CircuitBreaker {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailure: number;
  resetTimeout: number;
}

const toolCircuitBreakers = new Map<string, CircuitBreaker>();

async function executeWithCircuitBreaker(
  toolName: string,
  executor: () => Promise<ToolResult>
): Promise<ToolResult> {
  const breaker = toolCircuitBreakers.get(toolName) || createBreaker();

  if (breaker.state === 'open') {
    // Check if we should try again
    if (Date.now() - breaker.lastFailure > breaker.resetTimeout) {
      breaker.state = 'half-open';
    } else {
      return {
        result: `⚠️ Tool ${toolName} temporarily disabled due to repeated failures. Will retry in ${remainingTime}s.`,
        command: 'Circuit breaker open',
      };
    }
  }

  try {
    const result = await executor();

    if (result.result.startsWith('❌')) {
      breaker.failureCount++;
      breaker.lastFailure = Date.now();

      if (breaker.failureCount >= 3) {
        breaker.state = 'open';
      }
    } else {
      // Reset on success
      breaker.failureCount = 0;
      breaker.state = 'closed';
    }

    return result;
  } catch (err) {
    breaker.failureCount++;
    breaker.lastFailure = Date.now();
    throw err;
  }
}
```

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src/components/ai/tools.ts` | Add circuit breaker, enhanced validation, alternative suggestions |
| `src/components/ai/prompts.ts` | Add hypothesis framework, playbook injection, confidence prompts |
| `src/components/ai/ClusterChatPanel.tsx` | New investigation loop with timeouts, state tracking, progress |
| `src/components/ai/types.ts` (NEW) | TypeScript interfaces for investigation state |
| `src/components/ai/investigationState.ts` (NEW) | State management for investigations |
| `src/components/ai/playbooks.ts` (NEW) | Investigation playbooks for common issues |
| `knowledge/autonomous-playbook.json` | Enhanced playbook with investigation patterns |

---

## Success Criteria

### Quantitative
- [ ] Investigation completes within 3 minutes (timeout enforcement)
- [ ] Agent uses 8+ tools on average for complex issues (thoroughness)
- [ ] Consecutive error threshold reduces investigation waste by 50%
- [ ] Confidence score correlates with actual root cause accuracy

### Qualitative
- [ ] Agent doesn't ask "should I continue?" ever
- [ ] Agent provides clear hypothesis-based reasoning
- [ ] User understands what agent is doing via progress updates
- [ ] Agent suggests next steps when it can't find root cause
- [ ] No more "dead end" with no useful output

---

## Implementation Order

1. **Phase 1.1**: Smart error tracking (foundation for everything else)
2. **Phase 1.3**: Tool failure feedback loop (stops repeated failures)
3. **Phase 1.2**: Request timeout (prevents hangs)
4. **Phase 2.2**: Alternative tool suggestions (enables recovery)
5. **Phase 3.2**: Playbook injection (guided investigation)
6. **Phase 2.1**: Dynamic iteration budget (adaptive persistence)
7. **Phase 3.1**: Hypothesis tracking (structured reasoning)
8. **Phase 2.3**: Semantic compression (better context)
9. **Phase 4.1-4.2**: Confidence & progress (user transparency)
10. **Phase 5.1-5.2**: Enhanced guardrails (safety)

---

## Estimated Effort

| Phase | Complexity | Files | Est. Lines Changed |
|-------|------------|-------|-------------------|
| Phase 1 (Core Resilience) | High | 3 | ~400 |
| Phase 2 (Persistence) | Medium | 3 | ~300 |
| Phase 3 (Intelligence) | High | 4 | ~500 |
| Phase 4 (Transparency) | Low | 2 | ~150 |
| Phase 5 (Guardrails) | Medium | 2 | ~200 |

**Total: ~1,550 lines of code changes**
