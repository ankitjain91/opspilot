# Self-Learning Local AI System Design

## 🎯 Goal
Make k8s-cli model smarter over time through local learning, WITHOUT sending data to external APIs, while running entirely on your M4 Pro.

---

## 🧠 Core Concept: "Memory + Reflection + Feedback Loop"

Since we can't fine-tune the model itself locally (requires massive compute), we implement **external memory systems** that the model can access.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    User Query                                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  1. RETRIEVAL: Check if we've seen similar query before     │
│     - Semantic search in local vector DB                    │
│     - Find past successful investigations                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  2. CONTEXT INJECTION: Add learned knowledge to prompt      │
│     - "You solved similar issue before: <solution>"         │
│     - "Common pattern: <pattern>"                           │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  3. EXECUTION: Model uses context + current data            │
│     - Enhanced prompt = better decisions                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  4. FEEDBACK: Did it work?                                   │
│     - User confirms solution                                │
│     - OR: Automatic success detection                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  5. LEARNING: Store successful pattern                      │
│     - Save query → investigation → solution mapping         │
│     - Update confidence scores                              │
│     - Extract reusable patterns                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 💾 Storage Layers

### **1. Investigation Memory (SQLite)**
Store every investigation with outcomes:

```sql
CREATE TABLE investigations (
    id INTEGER PRIMARY KEY,
    query TEXT NOT NULL,
    query_embedding BLOB, -- Vector for semantic search
    steps TEXT, -- JSON array of tools used
    solution TEXT,
    success BOOLEAN,
    confidence_score REAL,
    cluster_context TEXT, -- Which cluster/namespace
    timestamp DATETIME,
    user_feedback TEXT, -- thumbs up/down/comment
    reuse_count INTEGER DEFAULT 0 -- How many times pattern reused
);

CREATE TABLE learned_patterns (
    id INTEGER PRIMARY KEY,
    pattern_type TEXT, -- 'crashloop', 'oom', 'networking', etc
    symptoms TEXT, -- JSON: error messages, exit codes
    investigation_steps TEXT, -- JSON: optimal tool sequence
    solution_template TEXT,
    success_rate REAL,
    last_used DATETIME,
    confidence REAL
);

CREATE TABLE tool_effectiveness (
    tool_name TEXT,
    query_pattern TEXT,
    success_rate REAL,
    avg_steps_to_solution INTEGER,
    last_updated DATETIME,
    PRIMARY KEY (tool_name, query_pattern)
);
```

### **2. Vector Database (ChromaDB or similar)**
For semantic similarity search:

```typescript
// Embed user query
const queryEmbedding = await embedText(userQuery);

// Find similar past investigations
const similar = await vectorDB.query({
    embedding: queryEmbedding,
    n_results: 5,
    where: { success: true } // Only successful ones
});

// Inject into prompt
const context = similar.map(inv =>
    `Similar issue: "${inv.query}" → Solution: ${inv.solution}`
).join('\n');
```

### **3. Pattern Library (JSON files)**
Extracted knowledge as simple rules:

```json
{
  "patterns": [
    {
      "id": "crashloop-oom",
      "symptoms": ["exit code 137", "OOMKilled", "memory"],
      "investigation_sequence": [
        "FIND_ISSUES",
        "DESCRIBE Pod namespace podname",
        "CHECK memory limits vs usage"
      ],
      "solution_template": "Increase memory limit from {current} to {recommended}",
      "confidence": 0.95,
      "learned_from": 15 // investigations
    },
    {
      "id": "crossplane-not-ready",
      "symptoms": ["crossplane", "not ready", "provider"],
      "investigation_sequence": [
        "RUN_KUBECTL kubectl get providers.pkg.crossplane.io -A",
        "DESCRIBE Provider namespace name",
        "GET_LOGS namespace provider-pod"
      ],
      "solution_template": "Check provider credentials in secret {secret_name}",
      "confidence": 0.88,
      "learned_from": 7
    }
  ]
}
```

---

## 🔄 Self-Learning Loop

### **Phase 1: Passive Learning (Automatic)**

```typescript
async function recordInvestigation(
    query: string,
    toolsUsed: string[],
    solution: string,
    success: boolean
) {
    // 1. Embed query for semantic search
    const embedding = await generateEmbedding(query);

    // 2. Store in database
    await db.run(`
        INSERT INTO investigations
        (query, query_embedding, steps, solution, success, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [query, embedding, JSON.stringify(toolsUsed), solution, success, Date.now()]);

    // 3. Extract patterns if successful
    if (success) {
        await extractPatterns(query, toolsUsed, solution);
    }

    // 4. Update tool effectiveness
    await updateToolStats(toolsUsed, success);
}
```

### **Phase 2: Pattern Extraction**

```typescript
async function extractPatterns(
    query: string,
    toolsUsed: string[],
    solution: string
) {
    // Find similar past investigations
    const similar = await findSimilarInvestigations(query, 5);

    if (similar.length >= 3) {
        // Check if they share common steps
        const commonSteps = findCommonSequence(
            similar.map(inv => inv.steps)
        );

        if (commonSteps.length >= 2) {
            // Extract symptoms
            const symptoms = extractSymptoms(query, solution);

            // Create/update pattern
            await db.run(`
                INSERT OR REPLACE INTO learned_patterns
                (pattern_type, symptoms, investigation_steps,
                 solution_template, success_rate, confidence)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                classifyPattern(query),
                JSON.stringify(symptoms),
                JSON.stringify(commonSteps),
                generalizeSolution(solution),
                calculateSuccessRate(similar),
                0.8 // Initial confidence
            ]);
        }
    }
}
```

### **Phase 3: Context Injection**

```typescript
async function enhancePromptWithLearning(
    userQuery: string,
    systemPrompt: string
): Promise<string> {
    // 1. Semantic search for similar past investigations
    const similarCases = await findSimilarInvestigations(userQuery, 3);

    // 2. Check for matching patterns
    const matchingPatterns = await findMatchingPatterns(userQuery);

    // 3. Get tool effectiveness data
    const toolStats = await getToolStats(userQuery);

    // 4. Build enhanced context
    let enhancedPrompt = systemPrompt;

    if (similarCases.length > 0) {
        enhancedPrompt += `\n\nLEARNED EXPERIENCE:
You've solved similar issues before:
${similarCases.map((c, i) => `${i+1}. Query: "${c.query}"
   Solution: ${c.solution}
   Tools used: ${c.steps.join(' → ')}`).join('\n\n')}

Apply these patterns if relevant.`;
    }

    if (matchingPatterns.length > 0) {
        const bestPattern = matchingPatterns[0];
        enhancedPrompt += `\n\nRECOMMENDED PATTERN (${bestPattern.confidence * 100}% confidence):
Symptoms detected: ${bestPattern.symptoms.join(', ')}
Investigation sequence: ${bestPattern.investigation_steps.join(' → ')}
Expected solution type: ${bestPattern.solution_template}`;
    }

    if (toolStats.length > 0) {
        enhancedPrompt += `\n\nTOOL EFFECTIVENESS FOR THIS TYPE OF QUERY:
${toolStats.map(t => `- ${t.tool_name}: ${t.success_rate * 100}% success rate`).join('\n')}`;
    }

    return enhancedPrompt;
}
```

### **Phase 4: Feedback Loop**

```typescript
// User feedback (thumbs up/down)
async function recordFeedback(
    investigationId: number,
    helpful: boolean,
    comment?: string
) {
    await db.run(`
        UPDATE investigations
        SET success = ?, user_feedback = ?
        WHERE id = ?
    `, [helpful, comment, investigationId]);

    // Adjust pattern confidence
    if (!helpful) {
        await decreasePatternConfidence(investigationId);
    } else {
        await increasePatternConfidence(investigationId);
    }
}

// Automatic success detection
function detectSuccess(investigation: Investigation): boolean {
    const lastStep = investigation.steps[investigation.steps.length - 1];

    // Heuristics
    return (
        investigation.solution.includes('Root Cause') &&
        !investigation.solution.includes('unknown') &&
        investigation.iterations < 8 && // Efficient
        !investigation.hadErrors
    );
}
```

---

## 🚀 Implementation Plan

### **Week 1: Foundation**
1. ✅ Add SQLite database schema
2. ✅ Implement investigation recording
3. ✅ Add embedding generation (using local model)
4. ✅ Create vector similarity search

### **Week 2: Pattern Extraction**
1. ✅ Pattern detection algorithm
2. ✅ Symptom extraction from queries
3. ✅ Solution generalization
4. ✅ Confidence scoring

### **Week 3: Context Injection**
1. ✅ Enhance prompt builder
2. ✅ Add learned patterns to system prompt
3. ✅ Tool effectiveness tracking
4. ✅ A/B testing (with vs without learning)

### **Week 4: Feedback & Refinement**
1. ✅ User feedback UI (thumbs up/down)
2. ✅ Automatic success detection
3. ✅ Pattern confidence adjustment
4. ✅ Export/import learned knowledge

---

## 🧪 Example: How Learning Works

### **Initial Investigation (No Learning)**
```
User: "Pod is crashing with exit code 137"
Model: TOOL: LIST_ALL Pod
Model: TOOL: DESCRIBE Pod default pod-123
Model: TOOL: GET_LOGS default pod-123
Model: Solution: Exit code 137 = OOMKilled. Increase memory.
Steps: 3 tools, 45 seconds
```

### **After Learning (10 similar cases)**
```
User: "Pod is crashing with exit code 137"
Enhanced Prompt:
  "You've solved 10 similar OOMKilled issues.
   Pattern: exit code 137 → DESCRIBE pod → check memory limits
   Recommended solution: Increase memory from current to 2x usage"

Model: TOOL: DESCRIBE Pod default pod-123 (directly)
Model: Solution: OOMKilled. Current: 128Mi, Usage: 200Mi.
       Increase to 256Mi.
Steps: 1 tool, 8 seconds ✅ 5x faster
```

---

## 🔐 Privacy & Security

**All learning happens locally:**
- ✅ No data sent to external APIs
- ✅ SQLite database stored locally
- ✅ Embeddings generated by local model
- ✅ Patterns stored as JSON files
- ✅ User controls what gets saved (opt-in feedback)

**Export/Import:**
```bash
# Export learned knowledge (sanitized)
./export-knowledge.sh > my-k8s-patterns.json

# Share with team (no sensitive data)
# Import on another machine
./import-knowledge.sh my-k8s-patterns.json
```

---

## 🎓 Advanced Techniques

### **1. Continuous Learning via Background Process**

```typescript
// Run nightly
async function consolidateKnowledge() {
    // Find investigations with similar outcomes
    const clusters = await clusterSimilarInvestigations();

    // Extract meta-patterns
    for (const cluster of clusters) {
        if (cluster.size >= 5 && cluster.avgConfidence > 0.8) {
            await createMetaPattern(cluster);
        }
    }

    // Prune low-confidence patterns
    await db.run(`
        DELETE FROM learned_patterns
        WHERE confidence < 0.3 AND last_used < datetime('now', '-30 days')
    `);
}
```

### **2. Cluster-Specific Learning**

```typescript
// Different patterns for different environments
const patterns = await db.all(`
    SELECT * FROM learned_patterns
    WHERE cluster_context LIKE ? OR cluster_context IS NULL
    ORDER BY confidence DESC
`, [`%${currentCluster}%`]);
```

### **3. Tool Sequence Optimization**

```typescript
// Learn optimal tool order
const sequences = await analyzeToolSequences();
// Result: "For OOM issues, DESCRIBE before GET_LOGS is 2x faster"

// Inject into prompt
enhancedPrompt += `\nOPTIMIZATION: For memory issues, use DESCRIBE first to check limits.`;
```

### **4. Embeddings from Local Model**

```typescript
// Use Qwen 2.5 itself to generate embeddings
async function generateEmbedding(text: string): Promise<number[]> {
    const response = await invoke('call_llm', {
        config: { provider: 'ollama', model: 'k8s-cli' },
        prompt: `Generate a numerical embedding for: "${text}"`,
        systemPrompt: 'Output only comma-separated numbers representing semantic meaning.'
    });

    return response.split(',').map(Number);
}

// Or use dedicated embedding model (faster)
// ollama pull nomic-embed-text
```

---

## 📊 Metrics to Track

```typescript
interface LearningMetrics {
    total_investigations: number;
    successful_patterns: number;
    avg_steps_before_learning: number;
    avg_steps_after_learning: number;
    pattern_reuse_rate: number;
    user_satisfaction_rate: number;
    knowledge_coverage: number; // % of queries with patterns
}

// Display in UI
const metrics = await calculateLearningMetrics();
console.log(`Learning effectiveness: ${metrics.avg_steps_after_learning / metrics.avg_steps_before_learning * 100}% reduction in steps`);
```

---

## 🎯 Expected Improvements

| Metric | Without Learning | With Learning (after 100 investigations) |
|--------|------------------|------------------------------------------|
| Avg steps to solution | 6 | 3 |
| Success rate | 80% | 92% |
| Avg time to solution | 45s | 18s |
| User satisfaction | 75% | 90% |
| Repeated query speed | 45s | 5s |

---

## 🛠️ Implementation Code Skeleton

```typescript
// src/components/ai/learning.ts

import Database from 'better-sqlite3';

export class LocalLearningSystem {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.initSchema();
    }

    async recordInvestigation(inv: Investigation) {
        // Store investigation
        // Extract patterns if successful
        // Update tool effectiveness
    }

    async enhancePrompt(query: string, basePrompt: string): Promise<string> {
        // Find similar cases
        // Find matching patterns
        // Get tool stats
        // Build enhanced prompt
    }

    async provideFeedback(invId: number, helpful: boolean) {
        // Update success flag
        // Adjust pattern confidence
    }

    async exportKnowledge(): Promise<string> {
        // Export patterns as JSON
    }

    async importKnowledge(json: string) {
        // Import patterns from JSON
    }
}

// Usage in ClusterChatPanel.tsx
const learningSystem = new LocalLearningSystem('./learning.db');

// Before investigation
const enhancedPrompt = await learningSystem.enhancePrompt(
    userQuery,
    LLAMA_OPTIMIZED_SYSTEM
);

// After investigation
await learningSystem.recordInvestigation({
    query: userQuery,
    steps: toolsUsed,
    solution: finalAnswer,
    success: userFeedback
});
```

---

## 🚀 Quick Start Implementation

```bash
# 1. Install dependencies
npm install better-sqlite3 chromadb

# 2. Create learning database
sqlite3 learning.db < schema.sql

# 3. Add learning system to app
# (See implementation code above)

# 4. Test
# - Run 5-10 investigations
# - Ask similar question
# - Should see "LEARNED EXPERIENCE" in prompt
# - Should be faster
```

---

## 🎓 Key Insight

**You can't change the model's weights locally, but you CAN:**
1. ✅ Give it better context (learned patterns)
2. ✅ Guide it with proven strategies
3. ✅ Skip unnecessary exploration
4. ✅ Provide domain-specific knowledge

**This is essentially "Retrieval Augmented Generation (RAG)" + "Pattern Learning"**

The model stays the same, but gets smarter through external memory! 🧠

---

## 📚 Further Reading

- [RAG (Retrieval Augmented Generation)](https://arxiv.org/abs/2005.11401)
- [In-Context Learning](https://arxiv.org/abs/2301.00234)
- [Local Vector Databases](https://www.trychroma.com/)
- [Embedding Models](https://github.com/nomic-ai/nomic)

---

**Last updated:** 2024-12-09
**Status:** Design Complete - Ready for Implementation
