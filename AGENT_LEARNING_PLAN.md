# Agent Learning Plan: Teaching K8s Investigation Patterns

## Overview

There are 4 main approaches to teach agents patterns, ordered by implementation complexity:

1. **Pattern Library** (Static) - Curated patterns in prompts
2. **RAG Knowledge Base** (Semi-dynamic) - Retrieve relevant patterns at runtime
3. **Investigation Recording** (Dynamic) - Learn from successful investigations
4. **Fine-tuning** (Offline) - Train model on K8s debugging data

---

## Approach 1: Pattern Library (Recommended First)

### Concept
Embed common K8s debugging patterns directly in the agent's prompt as structured examples.

### Implementation

```typescript
// src/components/ai/patterns.ts

export interface InvestigationPattern {
  id: string;
  name: string;
  triggers: string[];           // Keywords that activate this pattern
  symptoms: string[];           // What the user might report
  investigation_steps: Array<{
    tool: string;
    args?: string;
    look_for: string;           // What to look for in output
  }>;
  common_causes: Array<{
    cause: string;
    evidence: string[];         // What evidence confirms this
    fix: string;
  }>;
}

export const PATTERNS: InvestigationPattern[] = [
  {
    id: "crashloopbackoff",
    name: "CrashLoopBackOff Investigation",
    triggers: ["crash", "crashing", "restart", "CrashLoopBackOff", "not starting"],
    symptoms: ["Pod keeps restarting", "Container exit code non-zero", "App won't stay up"],
    investigation_steps: [
      { tool: "FIND_ISSUES", look_for: "CrashLoopBackOff, restarts > 3" },
      { tool: "GET_LOGS", args: "<namespace> <pod>", look_for: "Error messages, stack traces, exit codes" },
      { tool: "DESCRIBE", args: "pod <namespace> <pod>", look_for: "Exit code, Last State, Events" },
    ],
    common_causes: [
      {
        cause: "OOM Killed",
        evidence: ["Exit code 137", "OOMKilled: true", "memory limit exceeded"],
        fix: "Increase memory limits in pod spec or optimize application memory usage"
      },
      {
        cause: "Application Error",
        evidence: ["Exit code 1", "Exception in logs", "Error: ..."],
        fix: "Check application logs for the specific error and fix the code/config"
      },
      {
        cause: "Missing Dependencies",
        evidence: ["Connection refused", "ECONNREFUSED", "no such host"],
        fix: "Ensure dependent services (DB, Redis, etc.) are running and accessible"
      },
      {
        cause: "Bad Configuration",
        evidence: ["ConfigMap not found", "Secret not found", "env var missing"],
        fix: "Verify ConfigMaps/Secrets exist and are mounted correctly"
      }
    ]
  },
  {
    id: "pending_pod",
    name: "Pending Pod Investigation",
    triggers: ["pending", "not scheduled", "won't start", "stuck"],
    symptoms: ["Pod stuck in Pending", "Pod not running", "Scheduling failed"],
    investigation_steps: [
      { tool: "FIND_ISSUES", look_for: "Pending pods" },
      { tool: "DESCRIBE", args: "pod <namespace> <pod>", look_for: "Events section, conditions" },
      { tool: "RUN_KUBECTL", args: "get nodes -o wide", look_for: "Node status, resources" },
      { tool: "TOP_PODS", look_for: "Resource usage on nodes" },
    ],
    common_causes: [
      {
        cause: "Insufficient Resources",
        evidence: ["Insufficient cpu", "Insufficient memory", "0/3 nodes available"],
        fix: "Scale up cluster, reduce resource requests, or remove resource-heavy pods"
      },
      {
        cause: "Node Selector/Affinity Mismatch",
        evidence: ["node selector", "node affinity", "didn't match"],
        fix: "Update node labels or pod's nodeSelector/affinity rules"
      },
      {
        cause: "Taints and Tolerations",
        evidence: ["taint", "toleration", "untolerated taint"],
        fix: "Add tolerations to pod or remove taints from nodes"
      },
      {
        cause: "PVC Not Bound",
        evidence: ["persistentvolumeclaim", "not found", "unbound"],
        fix: "Create PV or StorageClass, check PVC status"
      }
    ]
  },
  {
    id: "service_not_working",
    name: "Service Connectivity Investigation",
    triggers: ["service", "can't connect", "connection refused", "timeout", "502", "503"],
    symptoms: ["Service not reachable", "Intermittent failures", "Connection timeouts"],
    investigation_steps: [
      { tool: "GET_ENDPOINTS", args: "<namespace> <service>", look_for: "Endpoint count, IPs" },
      { tool: "DESCRIBE", args: "service <namespace> <service>", look_for: "Selector, Ports, Type" },
      { tool: "RUN_KUBECTL", args: "get pods -n <namespace> -l <selector>", look_for: "Pod status, readiness" },
      { tool: "GET_EVENTS", args: "<namespace>", look_for: "Recent errors" },
    ],
    common_causes: [
      {
        cause: "No Endpoints",
        evidence: ["<none>", "0 endpoints", "no endpoints"],
        fix: "Check pod labels match service selector, ensure pods are Ready"
      },
      {
        cause: "Pods Not Ready",
        evidence: ["0/1 Ready", "Readiness probe failed"],
        fix: "Fix readiness probe or underlying application issue"
      },
      {
        cause: "Wrong Port",
        evidence: ["port mismatch", "targetPort", "containerPort"],
        fix: "Ensure service targetPort matches container port"
      },
      {
        cause: "Network Policy",
        evidence: ["NetworkPolicy", "denied", "blocked"],
        fix: "Update NetworkPolicy to allow traffic"
      }
    ]
  },
  {
    id: "high_resource_usage",
    name: "High Resource Usage Investigation",
    triggers: ["slow", "high cpu", "high memory", "resource", "throttling", "evicted"],
    symptoms: ["Application slow", "Pods evicted", "High latency"],
    investigation_steps: [
      { tool: "TOP_PODS", look_for: "CPU/Memory usage vs limits" },
      { tool: "CLUSTER_HEALTH", look_for: "Node resource pressure" },
      { tool: "RUN_KUBECTL", args: "top nodes", look_for: "Node utilization" },
      { tool: "GET_EVENTS", look_for: "Eviction, OOM, throttling" },
    ],
    common_causes: [
      {
        cause: "Memory Leak",
        evidence: ["Memory increasing over time", "OOMKilled", "memory > limit"],
        fix: "Profile application, fix memory leaks, increase limits temporarily"
      },
      {
        cause: "CPU Throttling",
        evidence: ["CPU > request", "throttled", "high latency"],
        fix: "Increase CPU limits or optimize application"
      },
      {
        cause: "Noisy Neighbor",
        evidence: ["Other pods high usage", "node pressure"],
        fix: "Use resource quotas, PodDisruptionBudgets, or dedicated nodes"
      }
    ]
  },
  {
    id: "image_pull_error",
    name: "Image Pull Error Investigation",
    triggers: ["ImagePullBackOff", "ErrImagePull", "image", "pull", "registry"],
    symptoms: ["Pod stuck in ImagePullBackOff", "Container not created"],
    investigation_steps: [
      { tool: "DESCRIBE", args: "pod <namespace> <pod>", look_for: "Events, image name" },
      { tool: "RUN_KUBECTL", args: "get secrets -n <namespace>", look_for: "imagePullSecrets" },
    ],
    common_causes: [
      {
        cause: "Image Not Found",
        evidence: ["not found", "manifest unknown", "404"],
        fix: "Verify image name and tag exist in registry"
      },
      {
        cause: "Authentication Failed",
        evidence: ["unauthorized", "authentication required", "403"],
        fix: "Create/update imagePullSecret with valid credentials"
      },
      {
        cause: "Registry Unreachable",
        evidence: ["timeout", "connection refused", "no route"],
        fix: "Check network connectivity to registry, DNS resolution"
      }
    ]
  }
];
```

### Integration with Agent

```typescript
// In langGraphAgent.ts - add pattern matching to prompt

function getRelevantPatterns(query: string): InvestigationPattern[] {
  const queryLower = query.toLowerCase();
  return PATTERNS.filter(p =>
    p.triggers.some(t => queryLower.includes(t.toLowerCase()))
  ).slice(0, 2); // Max 2 patterns to avoid prompt bloat
}

function formatPatternsForPrompt(patterns: InvestigationPattern[]): string {
  if (patterns.length === 0) return '';

  return `
## RELEVANT INVESTIGATION PATTERNS

${patterns.map(p => `
### ${p.name}
**Investigation Steps:**
${p.investigation_steps.map((s, i) => `${i + 1}. ${s.tool}${s.args ? ` ${s.args}` : ''} - Look for: ${s.look_for}`).join('\n')}

**Common Causes:**
${p.common_causes.map(c => `- **${c.cause}**: Evidence: ${c.evidence.join(', ')}`).join('\n')}
`).join('\n')}
`;
}
```

### Pros/Cons

| Pros | Cons |
|------|------|
| Simple to implement | Static, needs manual updates |
| No external dependencies | Limited to curated patterns |
| Predictable behavior | Takes prompt space |
| Works offline | Doesn't learn from new issues |

---

## Approach 2: RAG Knowledge Base

### Concept
Store patterns, docs, and past investigations in a vector database. Retrieve relevant context at query time.

### Architecture

```
User Query
    ↓
Embed query → Vector similarity search → Top-K patterns
    ↓
Inject patterns into prompt
    ↓
LLM generates response
```

### Implementation

```typescript
// Already have embeddings infrastructure in src-tauri/src/embeddings.rs

interface KnowledgeEntry {
  id: string;
  type: 'pattern' | 'solution' | 'doc' | 'investigation';
  title: string;
  content: string;
  tags: string[];
  embedding?: number[];  // Generated at index time
}

// Index patterns into knowledge base
async function indexPatterns() {
  for (const pattern of PATTERNS) {
    const content = `
      Problem: ${pattern.name}
      Symptoms: ${pattern.symptoms.join(', ')}
      Investigation: ${pattern.investigation_steps.map(s => s.tool).join(' → ')}
      Causes: ${pattern.common_causes.map(c => c.cause).join(', ')}
    `;

    await invoke('add_to_knowledge_base', {
      entry: {
        id: pattern.id,
        type: 'pattern',
        title: pattern.name,
        content,
        tags: pattern.triggers,
      }
    });
  }
}

// At query time
async function getRelevantKnowledge(query: string): Promise<string> {
  const results = await invoke('semantic_search_knowledge_base', {
    query,
    limit: 3,
  });

  return results.map(r => r.content).join('\n\n---\n\n');
}
```

### Pros/Cons

| Pros | Cons |
|------|------|
| Scales to many patterns | Requires embedding model |
| Semantic matching | More complex infrastructure |
| Can include docs, Stack Overflow, etc. | Retrieval quality varies |
| Dynamic updates | Needs good chunking strategy |

---

## Approach 3: Investigation Recording (Learn from Success)

### Concept
Record successful investigations and replay them as examples for similar future queries.

### Data Model

```typescript
interface InvestigationRecord {
  id: string;
  timestamp: string;
  query: string;                    // Original user question
  query_embedding: number[];        // For similarity search

  // Investigation trace
  steps: Array<{
    iteration: number;
    thought: string;
    tool: string;
    args?: string;
    result_summary: string;         // Compressed result
    useful: boolean;
  }>;

  // Outcome
  diagnosis: string;
  root_cause: string;
  confidence: 'high' | 'medium' | 'low';

  // Feedback
  user_rating?: 1 | 2 | 3 | 4 | 5;
  user_feedback?: string;
}

// Store in SQLite
CREATE TABLE investigations (
  id TEXT PRIMARY KEY,
  timestamp TEXT,
  query TEXT,
  query_embedding BLOB,
  steps_json TEXT,
  diagnosis TEXT,
  root_cause TEXT,
  confidence TEXT,
  user_rating INTEGER,
  user_feedback TEXT,
  cluster_context TEXT
);
```

### Recording Flow

```typescript
// After successful investigation
async function recordInvestigation(
  query: string,
  steps: AgentStep[],
  finalResponse: string,
  confidence: string
) {
  // Only record high-confidence investigations
  if (confidence !== 'high') return;

  // Generate embedding for similarity search
  const embedding = await invoke('generate_embedding', { text: query });

  // Compress steps (remove verbose outputs)
  const compressedSteps = steps.map(s => ({
    ...s,
    result_summary: s.output.slice(0, 200),
  }));

  await invoke('record_investigation', {
    query,
    embedding,
    steps: compressedSteps,
    diagnosis: extractDiagnosis(finalResponse),
    root_cause: extractRootCause(finalResponse),
    confidence,
  });
}
```

### Retrieval at Query Time

```typescript
async function getSimilarInvestigations(query: string): Promise<string> {
  const similar = await invoke('find_similar_investigations', {
    query,
    limit: 2,
    min_rating: 4,  // Only use well-rated investigations
  });

  if (similar.length === 0) return '';

  return `
## SIMILAR PAST INVESTIGATIONS

${similar.map(inv => `
**Query:** "${inv.query}"
**Steps:** ${inv.steps.map(s => s.tool).join(' → ')}
**Root Cause:** ${inv.root_cause}
**Diagnosis:** ${inv.diagnosis}
`).join('\n')}

Use these as reference, but investigate the current issue fresh.
`;
}
```

### Pros/Cons

| Pros | Cons |
|------|------|
| Learns from real usage | Needs usage data first |
| Personalized to your cluster | Cold start problem |
| Improves over time | May learn bad patterns |
| Captures edge cases | Storage requirements |

---

## Approach 4: Fine-tuning (Advanced)

### Concept
Fine-tune the base model on K8s debugging conversations.

### Data Sources

1. **Synthetic data**: Generate investigations using GPT-4/Claude
2. **Real investigations**: From approach 3's recordings
3. **Public data**: Stack Overflow K8s questions, GitHub issues

### Training Data Format

```jsonl
{"messages": [
  {"role": "system", "content": "You are a K8s SRE expert..."},
  {"role": "user", "content": "Why is my pod crashing?"},
  {"role": "assistant", "content": "{\"thought\": \"...\", \"action\": \"tool\", \"tool\": {\"name\": \"FIND_ISSUES\"}}"},
  {"role": "user", "content": "Observation: Pod web-app CrashLoopBackOff"},
  {"role": "assistant", "content": "{\"thought\": \"...\", \"action\": \"tool\", \"tool\": {\"name\": \"GET_LOGS\", \"args\": \"default web-app\"}}"},
  ...
]}
```

### Fine-tuning Script

```python
# scripts/finetune_agent.py
from unsloth import FastLanguageModel
import json

# Load base model
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen2.5-Coder-32B-Instruct",
    max_seq_length=8192,
    load_in_4bit=True,
)

# Apply LoRA
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    lora_alpha=16,
    lora_dropout=0,
)

# Load training data
with open("k8s_investigations.jsonl") as f:
    data = [json.loads(line) for line in f]

# Train
from trl import SFTTrainer
trainer = SFTTrainer(
    model=model,
    train_dataset=data,
    max_seq_length=8192,
    # ...
)
trainer.train()

# Export to Ollama
model.save_pretrained_gguf("k8s-agent", tokenizer, quantization_method="q4_k_m")
```

### Pros/Cons

| Pros | Cons |
|------|------|
| Best performance | Requires significant data |
| Patterns baked into weights | Training compute cost |
| Faster inference (no RAG) | Model becomes stale |
| Works fully offline | Need ML expertise |

---

## Recommended Implementation Order

### Phase 1: Pattern Library (Week 1)
- [ ] Create `patterns.ts` with 10-15 common patterns
- [ ] Add pattern matching to prompt builder
- [ ] Test with common queries

### Phase 2: RAG Enhancement (Week 2-3)
- [ ] Index patterns into existing embedding system
- [ ] Add K8s docs snippets
- [ ] Implement semantic search at query time

### Phase 3: Investigation Recording (Week 4-5)
- [ ] Add SQLite table for investigations
- [ ] Record high-confidence investigations
- [ ] Add user feedback mechanism
- [ ] Retrieve similar past investigations

### Phase 4: Fine-tuning (Future)
- [ ] Generate synthetic training data
- [ ] Export real investigations as training data
- [ ] Fine-tune on combined dataset
- [ ] A/B test against base model

---

## Quick Win: Enhanced Few-Shot Examples

The fastest improvement is expanding the few-shot examples in the prompt with more patterns:

```typescript
const ENHANCED_EXAMPLES = `
## EXAMPLE INVESTIGATIONS

### Example 1: CrashLoopBackOff
User: "My app keeps crashing"
Step 1: {"thought": "Need to find crashing pods", "action": "tool", "tool": {"name": "FIND_ISSUES"}}
Observation: [CRITICAL] Pod default/web-app: CrashLoopBackOff (15 restarts), Exit code: 137
Step 2: {"thought": "Exit code 137 is OOM. Check memory limits.", "action": "tool", "tool": {"name": "DESCRIBE", "args": "pod default web-app"}}
Observation: Limits: memory=256Mi, Last State: OOMKilled
Step 3: {"thought": "Confirmed OOM kill. Memory limit too low.", "action": "respond", "response": "## Root Cause: OOM Kill\\n\\nYour pod is being killed due to memory exhaustion.\\n\\n**Evidence:**\\n- Exit code 137 (SIGKILL from OOM killer)\\n- Memory limit: 256Mi\\n- Last state: OOMKilled\\n\\n**Fix:**\\n\\`\\`\\`yaml\\nresources:\\n  limits:\\n    memory: 512Mi  # Increase from 256Mi\\n\\`\\`\\`", "confidence": "high"}

### Example 2: Service No Endpoints
User: "My service returns 503"
Step 1: {"thought": "503 often means no healthy backends. Check endpoints.", "action": "tool", "tool": {"name": "GET_ENDPOINTS", "args": "default my-service"}}
Observation: No endpoints found for service my-service
Step 2: {"thought": "No endpoints! Check if pods exist with matching labels.", "action": "tool", "tool": {"name": "DESCRIBE", "args": "service default my-service"}}
Observation: Selector: app=myapp, Ports: 80/TCP
Step 3: {"thought": "Service selects app=myapp. Check pods with that label.", "action": "tool", "tool": {"name": "RUN_KUBECTL", "args": "get pods -l app=myapp"}}
Observation: No resources found
Step 4: {"thought": "No pods match the selector. That's the root cause.", "action": "respond", "response": "## Root Cause: No Matching Pods\\n\\nYour service has no endpoints because no pods match its selector.\\n\\n**Evidence:**\\n- Service selector: \\`app=myapp\\`\\n- Pods with label: 0\\n\\n**Fix:**\\nEnsure your Deployment has matching labels:\\n\\`\\`\\`yaml\\nmetadata:\\n  labels:\\n    app: myapp  # Must match service selector\\n\\`\\`\\`", "confidence": "high"}

### Example 3: Pending Pod
User: "Pod stuck in Pending"
Step 1: {"thought": "Need to find why pod won't schedule", "action": "tool", "tool": {"name": "DESCRIBE", "args": "pod default stuck-pod"}}
Observation: Events: 0/3 nodes available: insufficient cpu
Step 2: {"thought": "Not enough CPU on any node. Check node resources.", "action": "tool", "tool": {"name": "RUN_KUBECTL", "args": "top nodes"}}
Observation: node1: 95% CPU, node2: 92% CPU, node3: 88% CPU
Step 3: {"thought": "All nodes near capacity. Root cause is cluster resource exhaustion.", "action": "respond", "response": "## Root Cause: Insufficient Cluster Resources\\n\\n**Evidence:**\\n- Scheduler message: \\`0/3 nodes available: insufficient cpu\\`\\n- All nodes >85% CPU utilization\\n\\n**Fix Options:**\\n1. Scale up cluster (add nodes)\\n2. Reduce CPU requests on the pod\\n3. Delete or scale down other workloads", "confidence": "high"}
`;
```

This alone should significantly improve the agent's pattern recognition!
