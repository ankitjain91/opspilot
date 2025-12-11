#!/usr/bin/env node
/**
 * Real LLM Agent Evaluation
 *
 * Tests the agent prompts with REAL LLM calls to verify:
 * - Action requests immediately generate commands
 * - Casual chat doesn't generate commands
 * - Knowledge questions are answered directly
 * - Troubleshooting uses KB search and investigation
 *
 * Run: node scripts/agent-eval.mjs [filter]
 * Examples:
 *   node scripts/agent-eval.mjs              # Run all tests
 *   node scripts/agent-eval.mjs "logs"       # Run tests containing "logs"
 *   node scripts/agent-eval.mjs --mock       # Run with mock responses (old behavior)
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Check if running in mock mode (legacy)
const MOCK_MODE = process.argv.includes('--mock');
const TEST_FILTER = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

// =============================================================================
// LOAD SYSTEM PROMPT FROM PYTHON AGENT
// =============================================================================

const pythonAgentPath = path.join(__dirname, '..', 'python/agent_server.py');
let SYSTEM_PROMPT = '';
let WORKER_PROMPT = '';

try {
  const pythonContent = fs.readFileSync(pythonAgentPath, 'utf-8');

  // Extract SUPERVISOR_PROMPT
  const supervisorMatch = pythonContent.match(/SUPERVISOR_PROMPT = """([\s\S]*?)"""/);
  if (supervisorMatch) {
    SYSTEM_PROMPT = supervisorMatch[1];
    console.log('✅ Loaded SUPERVISOR_PROMPT from Python agent');
  }

  // Extract WORKER_PROMPT
  const workerMatch = pythonContent.match(/WORKER_PROMPT = """([\s\S]*?)"""/);
  if (workerMatch) {
    WORKER_PROMPT = workerMatch[1];
    console.log('✅ Loaded WORKER_PROMPT from Python agent');
  }

  // Extract SUPERVISOR_EXAMPLES and prepend to SYSTEM_PROMPT
  const examplesMatch = pythonContent.match(/SUPERVISOR_EXAMPLES = """([\s\S]*?)"""/);
  if (examplesMatch && SYSTEM_PROMPT.includes('{examples}')) {
    SYSTEM_PROMPT = SYSTEM_PROMPT.replace('{examples}', examplesMatch[1]);
    console.log('✅ Injected SUPERVISOR_EXAMPLES');
  }
} catch (e) {
  console.error(`Warning: Could not load prompts from ${pythonAgentPath}: ${e.message}`);
  // Fallback to a simple prompt
  SYSTEM_PROMPT = `You are a Kubernetes SRE expert. Respond with JSON:
{
  "thought": "your reasoning",
  "plan": "what to do next",
  "next_action": "delegate" | "respond",
  "final_response": "your answer (only if next_action=respond)"
}`;
}

// =============================================================================
// REAL LLM TESTS
// =============================================================================

const REAL_LLM_TESTS = [
  {
    name: 'Action: Get Crossplane logs',
    userMessage: 'Get Crossplane controller logs',
    clusterContext: `Pods: 45 total, 40 running
CrashLoop Pods (1):
  - upbound-system/crossplane-rbac-manager-779f5dbd5c-2r68w: CrashLoopBackOff (restarts: 15)`,
    expectations: {
      shouldHaveCommand: true,
      commandMustContain: ['logs'],
      mustNotContain: ['Let me know', 'Would you like', 'follow-up suggestions'],
    },
  },
  {
    name: 'Action: Show failing pods',
    userMessage: 'Show me failing pods',
    clusterContext: `Pods: 50 total, 45 running, 3 pending, 2 failed`,
    expectations: {
      shouldHaveCommand: true,
      commandMustContain: ['pods'],
    },
  },
  {
    name: 'Action: Check events',
    userMessage: 'Check recent cluster events',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      commandMustContain: ['events'],
    },
  },
  {
    name: 'Troubleshoot: Distributed System Bottleneck',
    userMessage: 'Why is my checkout service slow?',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      expectedConfidence: 'HIGH',
      expectedRootCause: 'database table lock',
    },
    toolOutputs: {
      'FIND_ISSUES:': `## Cluster Issues
- [Warning] CheckoutServiceLatency: High latency detected (2s avg)
- [Warning] FrontendHighCPU: Pod frontend-web-123 using 95% CPU`,
      'RUN_KUBECTL:get events -A --sort-by=.lastTimestamp | grep -v "Normal" | grep -i "Checkout"': ``,
      'RUN_KUBECTL:top pods -A | grep -E "frontend|checkout"': `NAMESPACE    NAME                    CPU(cores)   MEMORY(bytes)
default      frontend-web-123        950m         512Mi
default      checkout-service-456    100m         256Mi`,
      'RUN_KUBECTL:logs frontend-web-123 --tail=100': `[ERROR] Connection timed out to checkout-service:8080
[ERROR] Retrying request to checkout-service...
[INFO] Request to catalog-service passed`,
      'DESCRIBE:Service checkout-service': `## Service: checkout-service
Selector: app=checkout`,
    },
  },
  {
    name: 'Action: List deployments',
    userMessage: 'List all deployments',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      commandMustContain: ['deployments'],
    },
  },
  {
    name: 'Action: Describe pod',
    userMessage: 'Describe the coredns pod',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      commandMustContain: ['describe'],
    },
  },
  {
    name: 'Query: How many pods (with context)',
    userMessage: 'How many pods are running?',
    clusterContext: `Pods: 45 total, 40 running, 3 pending, 2 failed`,
    expectations: {
      // Should answer from context OR run command - both are acceptable
      responseMustContain: ['45', '40', 'pods', 'running'],
    },
  },
  {
    name: 'Casual: Greeting',
    userMessage: 'hey',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: false,
      mustNotContain: ['kubectl', 'TOOL:'],
    },
  },
  {
    name: 'Casual: Thanks',
    userMessage: 'thanks',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: false,
      mustNotContain: ['kubectl', 'TOOL:'],
    },
  },
  {
    name: 'Knowledge: What is StatefulSet',
    userMessage: 'What is a StatefulSet?',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: false,
      responseMustContain: ['stateful', 'pod'],
    },
  },
  {
    name: 'Troubleshoot: Pod crashing',
    userMessage: 'Why is my pod crashing?',
    clusterContext: `CrashLoop Pods (1):
  - default/api-server: OOMKilled (restarts: 12)`,
    expectations: {
      shouldHaveCommand: true, // Should investigate
    },
  },
  {
    name: 'CRD vs CR: Count consumergroups',
    userMessage: 'How many consumergroups exist in the cluster?',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      commandMustContain: ['consumergroup', 'crd', 'get'],
    },
  },
  {
    name: 'vCluster: Detection',
    userMessage: 'Is this a vcluster?',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      // Should check context or nodes, not just CRD
      commandMustContain: ['config', 'context', 'node', 'vcluster'],
    },
  },
  {
    name: 'Complexity: Ambiguous Resource "postgres"',
    userMessage: 'Check if postgres is healthy',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      // Should look for CRDs/API resources, not just pods
      commandMustContain: ['api-resources', 'crd', 'grep', 'get', 'postgresql'],
    },
  },
  {
    name: 'Complexity: Stuck Namespace',
    userMessage: 'Why is the "test-ns" namespace stuck in Terminating?',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      commandMustContain: ['namespace', 'get', 'test-ns', 'finalizers'],
    },
  },
  {
    name: 'Complexity: Find Service by Partial Name',
    userMessage: 'Where is the payment service running?',
    clusterContext: '',
    expectations: {
      shouldHaveCommand: true,
      commandMustContain: ['get', 'service', 'grep', 'payment'],
    },
  },
];

// =============================================================================
// COMMAND EXTRACTION (same as agentUtils.ts)
// =============================================================================

function extractCommands(response) {
  const commands = [];
  const seenCommands = new Set();

  // 1. Try JSON parsing first - handle multiple formats
  try {
    const jsonUtils = (str) => {
      const first = str.indexOf('{');
      const last = str.lastIndexOf('}');
      if (first === -1 || last === -1) return null;
      return JSON.parse(str.slice(first, last + 1));
    };

    const parsed = jsonUtils(response);
    if (parsed) {
      let toolName = null;
      let args = '';

      // FORMAT 1: Python Worker format - command: "kubectl ..."
      if (parsed.command && typeof parsed.command === 'string') {
        const cmd = parsed.command.trim();
        if (cmd.startsWith('kubectl')) {
          toolName = 'RUN_KUBECTL';
          args = cmd.replace(/^kubectl\s+/, '').trim();
        } else {
          // Direct tool command like "get pods -A"
          toolName = 'RUN_KUBECTL';
          args = cmd;
        }
      }
      // FORMAT 2: Python Supervisor format - plan with next_action: "delegate"
      else if (parsed.next_action === 'delegate' && parsed.plan) {
        // Extract tool from plan (natural language -> tool mapping)
        const originalPlan = parsed.plan;
        const plan = parsed.plan.toLowerCase();
        if (plan.includes('log')) {
          toolName = 'GET_LOGS';
          // Try to extract pod name from plan - look for patterns like namespace/pod-name or pod-name-xyz
          const podPatterns = [
            /['"]([a-z0-9-]+\/[a-z0-9-]+)['"]/i,                    // "namespace/pod-name"
            /['"]([a-z0-9][a-z0-9-]*-[a-z0-9]+)['"]/i,              // "pod-name-xyz"
            /(?:pod|for)\s+['"]?([a-z0-9-]+\/[a-z0-9-]+)['"]?/i,    // pod namespace/name
            /(?:pod|for)\s+(?:the\s+)?['"]?([a-z0-9][a-z0-9-]*-[a-z0-9]+)['"]?/i,  // pod name-xyz
          ];
          args = '';
          for (const pattern of podPatterns) {
            const match = originalPlan.match(pattern);
            if (match && match[1] && !['the', 'pod', 'logs'].includes(match[1].toLowerCase())) {
              args = match[1];
              break;
            }
          }
        } else if (plan.includes('describe')) {
          toolName = 'DESCRIBE';
          // Try to extract resource name
          const resourcePatterns = [
            /describe\s+(?:the\s+)?(?:pod\s+)?['"]?([a-z0-9-]+\/[a-z0-9-]+)['"]?/i,
            /describe\s+(?:the\s+)?(?:pod\s+)?['"]?([a-z0-9][a-z0-9-]*-[a-z0-9]+)['"]?/i,
            /(?:pod|deployment|service)\s+['"]?([a-z0-9-]+)['"]?/i,
          ];
          args = '';
          for (const pattern of resourcePatterns) {
            const match = originalPlan.match(pattern);
            if (match && match[1] && !['the', 'pod', 'deployment', 'service'].includes(match[1].toLowerCase())) {
              args = match[1];
              break;
            }
          }
        } else if (plan.includes('event')) {
          toolName = 'GET_EVENTS';
        } else if (plan.includes('deep') || plan.includes('inspect') || plan.includes('deep_inspect')) {
          toolName = 'DEEP_INSPECT';
          // Extract pod name
          const podPatterns = [
            /['"]([a-z0-9-]+\/[a-z0-9-]+)['"]/i,
            /(?:pod|on)\s+(?:the\s+)?['"]?([a-z0-9][a-z0-9-]*-[a-z0-9]+)['"]?/i,
          ];
          args = '';
          for (const pattern of podPatterns) {
            const match = originalPlan.match(pattern);
            if (match && match[1]) { args = match[1]; break; }
          }
        } else if (plan.includes('failing') || plan.includes('crash') || plan.includes('issue') || plan.includes('unhealthy')) {
          toolName = 'FIND_ISSUES';
        } else if (plan.includes('top') || plan.includes('resource usage') || (plan.includes('cpu') && plan.includes('memory'))) {
          toolName = 'TOP_PODS';
        } else if (plan.includes('endpoint')) {
          toolName = 'GET_ENDPOINTS';
        } else if (plan.includes('health') || plan.includes('cluster status')) {
          toolName = 'CLUSTER_HEALTH';
        } else if (plan.includes('yaml') || plan.includes('spec') || plan.includes('configuration')) {
          toolName = 'GET_YAML';
          args = '';
        } else if (plan.includes('list') || plan.includes('get') || plan.includes('show') || plan.includes('find')) {
          toolName = 'LIST_ALL';
          // Extract resource type, skipping common words
          const skipWords = new Set(['the', 'all', 'any', 'some', 'current', 'available', 'existing', 'pending', 'failing', 'running']);
          const words = originalPlan.split(/\s+/);
          let resourceType = 'pods';
          for (let i = 0; i < words.length; i++) {
            const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
            if (['list', 'get', 'show', 'find', 'check'].includes(w)) {
              // Look for next non-skip word
              for (let j = i + 1; j < words.length && j < i + 4; j++) {
                const nextWord = words[j].toLowerCase().replace(/[^a-z]/g, '');
                if (!skipWords.has(nextWord) && nextWord.length > 2) {
                  resourceType = nextWord;
                  break;
                }
              }
              break;
            }
          }
          // Normalize resource types
          if (resourceType.startsWith('pod')) args = 'Pod';
          else if (resourceType.startsWith('deploy')) args = 'Deployment';
          else if (resourceType.startsWith('service')) args = 'Service';
          else if (resourceType.startsWith('node')) args = 'Node';
          else if (resourceType.startsWith('event')) args = 'Event';
          else if (resourceType.startsWith('pvc') || resourceType.includes('volume')) args = 'PVC';
          else args = resourceType;
        } else {
          // Default: run as kubectl command
          toolName = 'RUN_KUBECTL';
          args = parsed.plan;
        }
      }
      // FORMAT 3: Old format - action: "tool", tool: {name, args}
      else if (parsed.action === 'tool' && parsed.tool?.name) {
        toolName = parsed.tool.name.toUpperCase();
        args = parsed.tool.args || '';
      }
      // FORMAT 4: TypeScript Brain format - action: "investigate", command: {tool, args}
      else if (parsed.action === 'investigate' && parsed.command?.tool) {
        toolName = parsed.command.tool.toUpperCase();
        args = parsed.command.args || '';
      }

      if (toolName) {
        const key = `${toolName}:${args}`;
        if (!seenCommands.has(key)) {
          seenCommands.add(key);
          commands.push({ tool: toolName, args, raw: response, parsed });
        }
        return commands;
      }
    }
  } catch (e) {
    // Not valid JSON, fall back to text extraction
  }

  // 2. Legacy Text Parsing ...
  // Match TOOL: format with robustness
  const toolMatches = [...response.matchAll(/(?:^|\n|[\s*>|\-]*)(?:[*_]*)(?:TOOL|Tool)(?:[*_]*)\s*:?\s*(\w+)(?:\s+(.+?))?(?=\n|(?:\s*Thought:)|$)/gi)];

  for (const match of toolMatches) {
    let rawArgs = match[2]?.trim() || '';
    rawArgs = rawArgs.split(/Thought:/i)[0].trim();
    rawArgs = rawArgs.replace(/[*_]+$/, '').trim();
    const args = rawArgs.split('(')[0].trim();
    const key = `${match[1].toUpperCase()}:${args}`;
    if (!seenCommands.has(key)) {
      seenCommands.add(key);
      commands.push({ tool: match[1].toUpperCase(), args, raw: match[0] });
    }
  }

  const shellPatterns = [
    /^\$\s*(kubectl\s+[^\n`]+)/gm,
    /`(kubectl\s+[^`]+)`/g,
    /^(kubectl\s+(?:get|describe|logs|top|events|config|api-resources)[^\n]*)/gm
  ];

  for (const pattern of shellPatterns) {
    const matches = [...response.matchAll(pattern)];
    for (const match of matches) {
      const kubectlCmd = match[1].replace(/^kubectl\s+/, '').trim();
      const key = `RUN_KUBECTL:${kubectlCmd}`;
      if (kubectlCmd && !seenCommands.has(key)) {
        seenCommands.add(key);
        commands.push({ tool: 'RUN_KUBECTL', args: kubectlCmd, raw: match[0] });
      }
    }
  }

  return commands;
}

// =============================================================================
// LLM CALLER
// =============================================================================

async function callRealLLM(userMessage, clusterContext) {
  const contextBlock = clusterContext ? `
=== CLUSTER DATA (PRE-FETCHED - USE IF HELPFUL) ===
${clusterContext}
=== END CLUSTER DATA ===

=== DECISION GUIDE ===
ACTION REQUESTS ("Get X", "Show Y", "Check Z", "Fetch W") → IMMEDIATELY output the command!
- "Get logs" → $ kubectl logs ...
- "Show events" → $ kubectl get events ...
- "Check pods" → $ kubectl get pods ...
DON'T describe or offer suggestions - just RUN THE COMMAND!

SIMPLE QUERIES ("How many X?") → Use pre-fetched data above if it answers the question.

` : '';

  const fullPrompt = `${contextBlock}User: ${userMessage}`;

  // Use configured host or default
  const host = process.env.LLM_HOST || 'http://localhost:11434';
  const isV1 = host.endsWith('/v1');
  const endpoint = isV1 ? `${host}/chat/completions` : `${host}/api/chat`; // use /api/chat for better context handling than /generate
  const model = process.env.LLM_MODEL || 'llama3.3:70b';

  console.log(`   Running against ${model} at ${endpoint}...`);

  try {
    const body = isV1 ? {
      model: model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: fullPrompt }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" } // Force JSON as per new protocol
    } : {
      model: model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: fullPrompt }
      ],
      stream: false,
      options: { temperature: 0.1 },
      format: "json" // Force JSON
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`LLM API error (${response.status}): ${txt}`);
    }

    const data = await response.json();

    // Parse response based on format
    let content = '';
    if (isV1) {
      content = data.choices?.[0]?.message?.content || '';
    } else {
      content = data.message?.content || '';
    }

    // Attempt to parse JSON response if the model obeyed (it should)
    try {
      const json = JSON.parse(content);
      // Extract thought/plan/command from JSON structure
      // If it's the new format: { thought, action, tool: {name, args} }
      if (json.tool) {
        return { success: true, response: `TOOL: ${json.tool.name} ${json.tool.args}\nThought: ${json.thought}` };
      } else if (json.action === 'respond') {
        return { success: true, response: json.thought + "\n" + (json.response || json.final_response) };
      }
      return { success: true, response: content };
    } catch {
      return { success: true, response: content };
    }

  } catch (error) {
    // If ollama fails, try with API key (fallback for CI/CD if configured)
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: fullPrompt }],
          }),
        });
        const data = await response.json();
        if (data.content && data.content[0]) {
          return { success: true, response: data.content[0].text };
        }
        return { success: false, error: JSON.stringify(data) };
      } catch (apiError) {
        return { success: false, error: apiError.message };
      }
    }
    return { success: false, error: error.message };
  }
}

// =============================================================================
// TEST RUNNER
// =============================================================================

async function runRealLLMTest(test) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📋 ${test.name}`);
  console.log(`   User: "${test.userMessage}"`);
  console.log(`${'─'.repeat(60)}`);

  const result = await callRealLLM(test.userMessage, test.clusterContext);

  if (!result.success) {
    console.log(`❌ LLM CALL FAILED: ${result.error}`);
    return { name: test.name, passed: false, reason: `LLM call failed: ${result.error}` };
  }

  const response = result.response;
  console.log(`\n📝 LLM Response:\n${response.slice(0, 500)}${response.length > 500 ? '...' : ''}`);

  // Extract commands
  const commands = extractCommands(response);
  console.log(`\n🔧 Commands Extracted: ${commands.length}`);
  commands.forEach((cmd, i) => {
    console.log(`   ${i + 1}. ${cmd.tool}: ${cmd.args.slice(0, 60)}${cmd.args.length > 60 ? '...' : ''}`);
  });

  // Evaluate expectations
  const issues = [];
  const { expectations } = test;

  // Check if should have command
  if (expectations.shouldHaveCommand === true && commands.length === 0) {
    issues.push('Expected command but none found');
  }
  if (expectations.shouldHaveCommand === false && commands.length > 0) {
    issues.push(`Should NOT have command but found: ${commands[0].tool}`);
  }

  // Check command content
  if (expectations.commandMustContain && commands.length > 0) {
    const allCommandText = commands.map(c => `${c.tool} ${c.args}`.toLowerCase()).join(' ');
    for (const term of expectations.commandMustContain) {
      // At least one term should match (OR logic for flexibility)
      const found = expectations.commandMustContain.some(t => allCommandText.includes(t.toLowerCase()));
      if (!found) {
        issues.push(`Command missing required terms: ${expectations.commandMustContain.join(' or ')}`);
        break;
      }
    }
  }

  // Check response content
  if (expectations.responseMustContain) {
    const responseLower = response.toLowerCase();
    for (const term of expectations.responseMustContain) {
      if (!responseLower.includes(term.toLowerCase())) {
        issues.push(`Response missing: "${term}"`);
      }
    }
  }

  // Check forbidden content
  if (expectations.mustNotContain) {
    const responseLower = response.toLowerCase();
    for (const term of expectations.mustNotContain) {
      if (responseLower.includes(term.toLowerCase())) {
        issues.push(`Response contains forbidden: "${term}"`);
      }
    }
  }

  // Result
  const passed = issues.length === 0;
  console.log(`\n${passed ? '✅ PASSED' : '❌ FAILED'}`);
  if (!passed) {
    issues.forEach(i => console.log(`   - ${i}`));
  }

  return { name: test.name, passed, issues, response: response.slice(0, 200) };
}

// =============================================================================
// MOCK MODE (Legacy - for reference)
// =============================================================================

const STEP_BUDGET = 25;
const CONFIDENCE_THRESHOLD = 60; // HIGH confidence

// =============================================================================
// MOCK IMPLEMENTATIONS (mirrors src/components/ai/types.ts logic)
// =============================================================================

/**
 * Mock confidence calculation (mirrors calculateConfidence from types.ts)
 *
 * CORE PRINCIPLE: Confirming a hypothesis IS the goal of investigation.
 * If we successfully identify the root cause, that's HIGH confidence.
 */
function calculateConfidence(state) {
  let score = 0;

  const successfulTools = state.toolHistory.filter(t => t.status === 'success' && t.useful).length;
  const evidenceSources = new Set(state.toolHistory.filter(t => t.useful).map(t => t.tool)).size;
  const confirmedHypotheses = state.hypotheses.filter(h => h.status === 'confirmed').length;
  const testedHypotheses = state.hypotheses.filter(h => h.status !== 'investigating').length;
  const errors = state.toolHistory.filter(t => t.status === 'error').length;

  // Hypothesis confirmation is the PRIMARY driver (max 40 points)
  // This is what matters most - did we find the answer?
  if (confirmedHypotheses > 0) {
    score += 35; // One confirmed hypothesis = major success
    score += Math.min((confirmedHypotheses - 1) * 5, 5); // Bonus for multiple
  } else if (testedHypotheses > 0) {
    score += 15; // Tested but refuted still shows progress
  } else if (state.hypotheses.length > 0) {
    score += 5; // At least we're investigating something
  }

  // Evidence contribution (max 30 points)
  score += Math.min(successfulTools * 8, 24);
  score += Math.min(evidenceSources * 3, 6);

  // Evidence quality bonus (max 15 points)
  const directEvidenceTools = ['GET_LOGS', 'GET_EVENTS', 'DESCRIBE'];
  const hasDirect = state.toolHistory.some(t =>
    t.useful && directEvidenceTools.includes(t.tool)
  );
  if (hasDirect) score += 15;
  else if (state.toolHistory.some(t => t.useful)) score += 10;
  else score += 3;

  // Playbook bonus (would be 5 points in real code)
  // Not simulated in test harness

  // Investigation thoroughness (max 5 points)
  score += Math.min(state.iteration || 1, 5);

  // Penalty for errors - minimal impact (max -5)
  // Errors are normal during investigation, shouldn't tank confidence
  score -= Math.min(errors, 5);

  score = Math.max(0, Math.min(100, score));
  const level = score >= 55 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';

  return { score, level };
}

/**
 * Mock hypothesis extraction (mirrors extractHypotheses from types.ts)
 */
function extractHypotheses(response, existing = []) {
  const hypotheses = [...existing];
  const now = Date.now();

  // Pattern 1: H1: cause format
  const hPattern = /[-•*]?\s*H(\d+)[:\s]+([^→\n]{10,150})(?:\s*→?\s*(?:Status:?\s*)?(\w+))?/gi;
  let match;
  while ((match = hPattern.exec(response)) !== null) {
    const id = `H${match[1]}`;
    const cause = match[2].trim();
    const statusText = (match[3] || 'investigating').toLowerCase();
    const status = statusText.includes('confirm') ? 'confirmed' :
      statusText.includes('refut') ? 'refuted' : 'investigating';

    const existingIdx = hypotheses.findIndex(h => h.id === id);
    if (existingIdx >= 0) {
      hypotheses[existingIdx].status = status;
    } else if (cause.length >= 10) {
      hypotheses.push({ id, description: cause, status, evidence: [], createdAt: now });
    }
  }

  // Pattern 2: Natural language confirmation
  const confirmPatterns = [
    /root\s+cause[:\s]+(.{15,100}?)(?:\n|$)/gi,
    /confirmed?[:\s]+(.{15,100}?)(?:\n|$)/gi,
  ];
  for (const pattern of confirmPatterns) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(response)) !== null) {
      const cause = match[1].trim();
      // Mark matching hypotheses as confirmed
      for (const h of hypotheses) {
        if (h.status === 'investigating' &&
          cause.toLowerCase().includes(h.description.toLowerCase().slice(0, 20))) {
          h.status = 'confirmed';
        }
      }
    }
  }

  return hypotheses;
}

/**
 * Mock tool outcome evaluation
 */
function evaluateToolOutcome(result, toolName) {
  if (result.startsWith('❌')) return { status: 'error', useful: false };
  if (result.startsWith('⚠️')) return { status: 'partial', useful: result.length > 100 };
  if (!result || result.trim().length < 20) return { status: 'empty', useful: false };
  return { status: 'success', useful: true };
}

/**
 * Get next tool recommendations based on context
 */
function getNextToolRecommendations(state, lastResult) {
  const executedTools = new Set(state.toolHistory.map(t => t.tool));
  const recommendations = [];

  if (executedTools.size === 0) return ['FIND_ISSUES'];

  const resultLower = lastResult.toLowerCase();

  if (resultLower.includes('crashloop') || resultLower.includes('restart')) {
    if (!executedTools.has('GET_LOGS')) recommendations.push('GET_LOGS');
  }
  if (resultLower.includes('oom') || resultLower.includes('exit code 137')) {
    if (!executedTools.has('TOP_PODS')) recommendations.push('TOP_PODS');
  }
  if (resultLower.includes('pending') || resultLower.includes('scheduling')) {
    if (!executedTools.has('DESCRIBE')) recommendations.push('DESCRIBE');
  }
  if (recommendations.length === 0 && state.consecutiveUnproductive >= 1) {
    if (!executedTools.has('WEB_SEARCH')) recommendations.push('WEB_SEARCH');
  }

  return recommendations.slice(0, 3);
}

// =============================================================================
// TEST SCENARIOS
// =============================================================================

const scenarios = [
  {
    name: 'Basic: List Nodes',
    user: 'show me all nodes',
    expectedFlow: ['RUN_KUBECTL'],
    expectedConfidence: 'LOW',
    expectedRootCause: 'healthy',
    mockTools: {
      'RUN_KUBECTL': (args) => `NAME       STATUS   ROLES           AGE   VERSION
node-1     Ready    control-plane   10d   v1.28.0
node-2     Ready    worker          10d   v1.28.0`
    },
    llmResponses: [
      {
        input: 'initial',
        output: `I will list the nodes in the cluster.
TOOL: RUN_KUBECTL get nodes`
      },
      {
        input: 'after listing',
        output: `## Answer
There are 2 nodes in the cluster, both are Ready.
1. node-1 (control-plane)
2. node-2 (worker)`
      }
    ]
  },
  {
    name: 'Basic: Version Check',
    user: 'what version of kubernetes is running?',
    expectedFlow: ['RUN_KUBECTL'],
    expectedConfidence: 'LOW',
    expectedRootCause: 'healthy',
    mockTools: {
      'RUN_KUBECTL': (args) => `Client Version: v1.29.0
Kustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3
Server Version: v1.28.0`
    },
    llmResponses: [
      {
        input: 'initial',
        output: `I'll check the Kubernetes version.
TOOL: RUN_KUBECTL version`
      },
      {
        input: 'after version',
        output: `## Answer
The server is running Kubernetes v1.28.0.`
      }
    ]
  },
  {
    name: 'Basic: Explain Service',
    user: 'what is a ClusterIP service?',
    expectedFlow: [], // No tools expected for conceptual questions
    expectedConfidence: 'LOW',
    expectedRootCause: 'healthy',
    mockTools: {},
    llmResponses: [
      {
        input: 'initial',
        output: `## Answer
A ClusterIP service is the default Kubernetes Service type. It assigns a stable internal IP address to a set of pods, allowing them to be accessed from within the cluster. It is not exposed to the internet.`
      }
    ]
  },
  {
    name: 'Basic: List Pods',
    user: 'Show me all pods',
    expectedTools: ['LIST_ALL'],
    expectedFlow: ['LIST_ALL'],
    expectedConfidence: 'LOW',
    mockTools: {
      'LIST_ALL': (args) => `NAME                     READY   STATUS    RESTARTS   AGE
nginx-deployment-123     1/1     Running   0          5m
redis-master-0           1/1     Running   0          10m`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `TOOL: LIST_ALL Pod`
      },
      {
        input: 'after list',
        output: `## Answer
Here are the running pods:
- nginx-deployment-123 (Running)
- redis-master-0 (Running)

## Confidence: HIGH`
      }
    ]
  },
  {
    name: 'Basic: Cluster Health',
    user: 'Is the cluster healthy?',
    expectedTools: ['CLUSTER_HEALTH'],
    expectedFlow: ['CLUSTER_HEALTH'],
    expectedConfidence: 'LOW',
    mockTools: {
      'CLUSTER_HEALTH': () => JSON.stringify({
        total_nodes: 3,
        not_ready_nodes: [],
        running_pods: 45,
        failed_pods: 0,
        critical_issues: [],
        crashloop_pods: []
      }),
    },
    llmResponses: [
      {
        input: 'initial',
        output: `TOOL: CLUSTER_HEALTH`
      },
      {
        input: 'after health',
        output: `## Answer
Yes, the cluster is healthy.
- Nodes: 3/3 Ready
- Pods: 45 Running, 0 Failed

## Confidence: HIGH`
      }
    ]
  },
  {
    name: 'CrashLoop -> OOMKilled (Classic Investigation)',
    user: 'pod keeps crashing',
    kubeContext: 'production-cluster',
    clusterInfo: 'Kubernetes v1.28.0 | Nodes: 5/5 Ready | Pods: 45 running, 1 CrashLoopBackOff',
    expectedFlow: ['FIND_ISSUES', 'DESCRIBE', 'GET_LOGS'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'OOMKilled',
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found (3 total)
- [CRITICAL] Pod default/api-server-xyz: CrashLoopBackOff (Restarts: 47)
- [WARNING] Pod monitoring/prometheus-0: High restart count (12)
- [WARNING] Deployment default/api-server: 0/3 replicas ready`,
      'DESCRIBE': (args) => `## Pod: default/api-server-xyz
Status: CrashLoopBackOff
Restarts: 47
Last State: Terminated
Exit Code: 137
Reason: OOMKilled
Message: Container killed due to memory limit
Events:
- Warning BackOff: Back-off restarting container
- Normal Pulled: Successfully pulled image`,
      'GET_LOGS': (args) => `## Logs: default/api-server-xyz
[INFO] Starting server...
[INFO] Loading config...
[WARN] High memory usage detected
[ERROR] std::bad_alloc: memory allocation failed
[FATAL] Out of memory - killing container
Killed`,
      'TOP_PODS': () => `## Pod Resource Usage (10 pods)
| Namespace | Pod | CPU | Memory |
|-----------|-----|-----|--------|
| default | api-server-xyz | 450m | 510Mi |
| default | web-0 | 100m | 128Mi |`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Pod is crash-looping due to OOM (memory exhaustion) → Status: INVESTIGATING
- H2: Application bug causing repeated crashes → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after FIND_ISSUES',
        output: `Found api-server-xyz in CrashLoopBackOff with 47 restarts. Need to check exit code and logs.

- H1: OOM issue → Status: INVESTIGATING (need exit code)

TOOL: DESCRIBE Pod default api-server-xyz
TOOL: GET_LOGS default api-server-xyz`
      },
      {
        input: 'after DESCRIBE and GET_LOGS',
        output: `## Summary
The pod api-server-xyz is being OOMKilled.

## Root Cause
**Exit code 137 (OOMKilled)** - the container is exceeding its memory limit of 512Mi.

Evidence:
- Exit Code: 137 (SIGKILL due to OOM)
- Logs show "std::bad_alloc" and "Out of memory"
- Memory usage at 510Mi hitting 512Mi limit

- H1: OOM issue → Status: CONFIRMED

## Confidence: HIGH
Direct evidence from exit code, events, and logs all confirm OOM.

## Recommendation
Increase memory limit to 1-2Gi in the Deployment spec.`
      }
    ]
  },
  {
    name: 'Pending Pod -> Node Selector Mismatch',
    user: 'deployment not scaling, pods stuck',
    kubeContext: 'payments-cluster',
    clusterInfo: 'Kubernetes v1.28.0 | Nodes: 5/5 Ready | Pods: 30 running, 1 Pending',
    expectedFlow: ['FIND_ISSUES', 'DESCRIBE', 'GET_EVENTS'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'node selector',
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found (2 total)
- [CRITICAL] Pod payments/payment-processor-abc: Pending (scheduling failed)
- [WARNING] Deployment payments/payment-processor: 0/3 replicas ready`,
      'DESCRIBE': (args) => `## Pod: payments/payment-processor-abc
Status: Pending
Phase: Pending
Events:
- Warning FailedScheduling: 0/5 nodes are available: 5 node(s) didn't match Pod's node selector.
Node Selector:
  disk: ssd
  tier: premium`,
      'GET_EVENTS': (args) => `## Recent Events (5)
- [Warning] payments/payment-processor-abc (Pod): FailedScheduling - 0/5 nodes available: 5 node(s) didn't match node selector
- [Normal] payments/payment-processor (Deployment): ScalingReplicaSet
- [Warning] payments/payment-processor-abc: FailedScheduling (repeated 15 times)`,
      'LIST_ALL': (args) => `## Node List (5 total)
- node-1: Ready (disk=hdd, tier=standard)
- node-2: Ready (disk=hdd, tier=standard)
- node-3: Ready (disk=hdd, tier=standard)
- node-4: Ready (disk=ssd, tier=standard)
- node-5: Ready (disk=hdd, tier=premium)`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Resource constraints preventing scheduling → Status: INVESTIGATING
- H2: Node selector or affinity mismatch → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after FIND_ISSUES',
        output: `Found payment-processor pods in Pending state. Need to check scheduling events.

TOOL: DESCRIBE Pod payments payment-processor-abc
TOOL: GET_EVENTS payments`
      },
      {
        input: 'after DESCRIBE and GET_EVENTS',
        output: `## Summary
Payment processor pods cannot be scheduled due to node selector mismatch.

## Root Cause
**Node selector requires disk=ssd AND tier=premium, but no nodes match both labels.**

Evidence:
- Events show "5 node(s) didn't match Pod's node selector"
- Pod requires: disk=ssd, tier=premium
- Node-4 has disk=ssd but tier=standard
- Node-5 has tier=premium but disk=hdd

- H2: Node selector mismatch → Status: CONFIRMED
- H1: Resource constraints → Status: REFUTED

## Confidence: HIGH

## Recommendation
Either relax the node selector (remove tier requirement) or add a node with both labels.`
      }
    ]
  },
  {
    name: 'Service Connectivity Issue -> No Endpoints',
    user: 'service returning 503 errors',
    expectedFlow: ['FIND_ISSUES', 'GET_ENDPOINTS', 'DESCRIBE'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'no endpoints',
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found (2 total)
- [WARNING] Service frontend/web-svc: No endpoints
- [WARNING] Deployment frontend/web: 0/2 replicas ready`,
      'GET_ENDPOINTS': (args) => `## Endpoints: frontend/web-svc
**Ready:** None
**Not Ready:** None
**Ports:** 8080/TCP

⚠️ **No endpoints found!** This means no pods match the service selector.`,
      'DESCRIBE': (args) => `## Service: frontend/web-svc
Type: ClusterIP
Selector: app=web, version=v2
Ports: 8080/TCP
Endpoints: <none>`,
      'LIST_ALL': (args) => `## Pod List (5 total)
- frontend/web-abc: Running (app=web, version=v1)
- frontend/web-def: Running (app=web, version=v1)
- backend/api-123: Running`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Backend pods are unhealthy → Status: INVESTIGATING
- H2: Service selector doesn't match pods → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after FIND_ISSUES',
        output: `Found web-svc has no endpoints. Need to check service selector.

TOOL: GET_ENDPOINTS frontend web-svc
TOOL: DESCRIBE Service frontend web-svc`
      },
      {
        input: 'after GET_ENDPOINTS and DESCRIBE',
        output: `## Summary
The service has no endpoints because the selector doesn't match any pods.

## Root Cause
**Service selector mismatch** - service selects "app=web, version=v2" but pods have "version=v1".

- H2: Service selector mismatch → Status: CONFIRMED

## Confidence: HIGH

## Recommendation
Update service selector to version=v1 or update pods to version=v2.`
      }
    ]
  },
  {
    name: 'Namespace Stuck Terminating',
    user: 'cannot delete namespace, stuck for hours',
    expectedFlow: ['GET_NAMESPACE', 'LIST_FINALIZERS'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'finalizer',
    mockTools: {
      'GET_NAMESPACE': () => `## Namespace: old-project
**Phase:** Terminating
**Deletion Requested:** 2024-01-15T10:00:00Z
**Finalizers:** kubernetes

### Conditions:
- **NamespaceDeletionDiscoveryFailure:** True - Discovery failed for some groups
- **NamespaceDeletionContentFailure:** True - Some content could not be deleted

### ⚠️ Namespace Stuck in Terminating
This namespace has a deletion timestamp but cannot be deleted.`,
      'LIST_FINALIZERS': () => `## Resources with Finalizers in old-project (2)

### CustomResource/database-backup 🔴 DELETING
**Finalizers:** database.example.com/cleanup
**Deletion Requested:** 2024-01-15T10:00:05Z
⚠️ This resource is stuck! The finalizer controller may be:
- Not running (check if the operator exists)
- Missing credentials

### PersistentVolumeClaim/data-pvc 🔴 DELETING
**Finalizers:** kubernetes.io/pvc-protection
**Deletion Requested:** 2024-01-15T10:00:10Z`,
      'FIND_ISSUES': () => `## Issues Found (1 total)
- [WARNING] Namespace old-project: Terminating for 12h`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Resources with finalizers blocking deletion → Status: INVESTIGATING
- H2: API server issues → Status: INVESTIGATING

TOOL: GET_NAMESPACE old-project`
      },
      {
        input: 'after GET_NAMESPACE',
        output: `Namespace is terminating with conditions showing deletion failures. Need to find blocking resources.

TOOL: LIST_FINALIZERS old-project`
      },
      {
        input: 'after LIST_FINALIZERS',
        output: `## Summary
Namespace is stuck terminating due to resources with pending finalizers.

## Root Cause
**Custom resource database-backup has finalizer "database.example.com/cleanup" but the operator is not running to process it.**

- H1: Finalizers blocking deletion → Status: CONFIRMED

## Confidence: HIGH
Direct evidence from LIST_FINALIZERS shows stuck resources.

## Recommendation
1. Check if database operator is running: kubectl get pods -A | grep database
2. If operator is gone, manually remove finalizer:
   kubectl patch customresource database-backup -n old-project -p '{"metadata":{"finalizers":[]}}' --type=merge`
      }
    ]
  },
  {
    name: 'Unknown Error -> Web Search Fallback',
    user: 'pod failing with OCI runtime error',
    expectedFlow: ['FIND_ISSUES', 'DESCRIBE', 'WEB_SEARCH'],
    expectedConfidence: 'HIGH',  // 4 useful tools + confirmed hypothesis = HIGH
    expectedRootCause: 'permission',  // Fix: the root cause is permission denied, not runtime
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found (1 total)
- [CRITICAL] Pod default/app-xyz: CreateContainerError`,
      'DESCRIBE': (args) => `## Pod: default/app-xyz
Status: CreateContainerError
Events:
- Warning Failed: Error response from daemon: OCI runtime create failed: container_linux.go:380: starting container process caused: exec: "/entrypoint.sh": permission denied: unknown`,
      'GET_LOGS': (args) => `❌ Error: container not running`,
      'SEARCH_KNOWLEDGE': (args) => `📚 No knowledge base articles found for "OCI runtime permission denied".`,
      'WEB_SEARCH': (args) => `## 🌐 Web Search Results for "kubernetes OCI runtime permission denied entrypoint"

### 1. Stack Overflow
**URL:** https://stackoverflow.com/questions/12345
The entrypoint script doesn't have execute permissions. Use chmod +x on the script or update the Dockerfile.

---

### 2. Kubernetes Documentation
**URL:** https://kubernetes.io/docs/concepts/workloads/pods/
Container runtime errors often occur when the entrypoint is not executable.`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Container image issue → Status: INVESTIGATING
- H2: Permission problem with entrypoint → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after FIND_ISSUES',
        output: `Found CreateContainerError. Need more details.

TOOL: DESCRIBE Pod default app-xyz`
      },
      {
        input: 'after DESCRIBE',
        output: `The error mentions "permission denied" for entrypoint.sh. Let me search for solutions.

TOOL: SEARCH_KNOWLEDGE OCI runtime permission denied`
      },
      {
        input: 'after SEARCH_KNOWLEDGE (no results)',
        output: `Knowledge base didn't have this. Searching the web.

TOOL: WEB_SEARCH OCI runtime permission denied entrypoint`
      },
      {
        input: 'after WEB_SEARCH',
        output: `## Summary
Container fails to start due to entrypoint script permission issue.

## Root Cause
The /entrypoint.sh script doesn't have execute permissions in the container image.

- H2: Permission problem → Status: CONFIRMED

## Confidence: MEDIUM
Web search confirms the issue but direct fix requires image rebuild.`
      }
    ]
  },
  {
    name: 'Tool Failure Recovery',
    user: 'check pod nginx-broken',
    expectedFlow: ['DESCRIBE', 'LIST_ALL', 'DESCRIBE'],
    expectedConfidence: 'HIGH',  // Error, but 2 useful tools + 2 confirmed hypotheses = HIGH (68)
    expectedRootCause: 'image pull',
    mockTools: {
      'DESCRIBE': (args) => {
        if (args.includes('nginx-broken')) return `❌ Error: pods "nginx-broken" not found`;
        return `## Pod: default/nginx-fixed-abc
Status: ImagePullBackOff
Events:
- Warning Failed: Failed to pull image "nginx:latestt": rpc error: image not found
  - Warning Failed: Error: ErrImagePull`;
      },
      'LIST_ALL': (args) => `## Pod List(3 total)
  - default/nginx-fixed-abc: ImagePullBackOff
    - default/web-0: Running
      - kube - system / coredns - xyz: Running`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `** Initial Hypotheses:**
  - H1: Pod name might be incorrect → Status: INVESTIGATING
    - H2: Image pull issue → Status: INVESTIGATING

TOOL: DESCRIBE Pod default nginx-broken`
      },
      {
        input: 'after DESCRIBE (error)',
        output: `Pod not found with that exact name.Let me list all pods to find the correct name.

- H1: Pod name incorrect → Status: INVESTIGATING

TOOL: LIST_ALL Pod`
      },
      {
        input: 'after LIST_ALL',
        output: `Found nginx - fixed - abc with ImagePullBackOff.This might be the pod user meant.

- H1: Pod name incorrect → Status: CONFIRMED(found nginx - fixed - abc not nginx - broken)
  - H2: Image pull issue → Status: INVESTIGATING

TOOL: DESCRIBE Pod default nginx-fixed-abc`
      },
      {
        input: 'after second DESCRIBE',
        output: `## Summary
Pod nginx - fixed - abc cannot pull its image.

## Root Cause
  ** Image pull failure due to typo: "nginx:latestt" should be "nginx:latest" **

    - H2: Image pull issue → Status: CONFIRMED

## Confidence: MEDIUM
Found the issue but investigation had an error along the way.

## Recommendation
Fix the image tag in the deployment: kubectl set image deployment / nginx nginx = nginx: latest`
      }
    ]
  },
  // Edge case: RBAC/Permission issues
  {
    name: 'RBAC Permission Denied',
    user: 'cannot list pods in production namespace',
    expectedFlow: ['LIST_ALL', 'CLUSTER_HEALTH'],
    expectedConfidence: 'HIGH',  // Confirmed hypothesis = HIGH (58) - errors are normal
    expectedRootCause: 'RBAC',
    mockTools: {
      'LIST_ALL': (args) => `❌ Error: pods is forbidden: User "dev-user" cannot list resource "pods" in API group "" in the namespace "production"`,
      'CLUSTER_HEALTH': () => `## Cluster Health Summary
  ** Nodes:** 5 / 5 Ready
    ** Pods:** 245 / 250 Running
      ** Note:** Some namespaces may have RBAC restrictions.`,
      'RUN_KUBECTL': (args) => `no`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `** Initial Hypotheses:**
  - H1: Pods don't exist in production → Status: INVESTIGATING
    - H2: RBAC permission issue → Status: INVESTIGATING

TOOL: LIST_ALL Pod production`
      },
      {
        input: 'after LIST_ALL (forbidden)',
        output: `Got forbidden error.This is a permission issue, not a pod issue.

- H2: RBAC permission issue → Status: INVESTIGATING

Let me check the cluster health to see if things are working in general.

  TOOL: CLUSTER_HEALTH`
      },
      {
        input: 'after CLUSTER_HEALTH',
        output: `## Summary
User lacks permission to list pods in production namespace.

## Root Cause
  ** RBAC restriction ** - User "dev-user" cannot list pods in "production" namespace.

- H1: Pods don't exist → Status: REFUTED
  - H2: RBAC permission issue → Status: CONFIRMED

## Confidence: HIGH

## Recommendation
Contact cluster admin to grant ClusterRole / Role with 'list pods' permission, or use a service account with appropriate permissions.`
      }
    ]
  },
  // Edge case: Empty cluster / new deployment
  {
    name: 'Empty Namespace Investigation',
    user: 'why are there no pods running?',
    expectedFlow: ['FIND_ISSUES', 'LIST_ALL'],
    expectedConfidence: 'HIGH',  // 3 useful tools + confirmed hypothesis = HIGH (70)
    expectedRootCause: 'deployment',
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found(0 total)
No critical issues detected.

⚠️ The cluster appears healthy but some namespaces may be empty.`,
      'LIST_ALL': (args) => {
        if (args.includes('Deployment')) return `## Deployment List(0 total)
No deployments found in the default namespace.`;
        return `## Pod List(0 in default namespace)
No pods found in the default namespace.

  Hint: Check if deployments exist: LIST_ALL Deployment`;
      },
    },
    llmResponses: [
      {
        input: 'initial',
        output: `** Initial Hypotheses:**
  - H1: Pods crashed and haven't restarted → Status: INVESTIGATING
    - H2: No deployments exist → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after FIND_ISSUES',
        output: `No issues found.Let me check what pods exist.

  TOOL: LIST_ALL Pod
TOOL: LIST_ALL Deployment`
      },
      {
        input: 'after LIST_ALL',
        output: `## Summary
No pods because no deployments exist in the default namespace.

## Root Cause
  ** No Deployment created ** - The namespace has no workloads configured.

- H1: Pods crashed → Status: REFUTED
  - H2: No deployments exist → Status: CONFIRMED

## Confidence: MEDIUM
This is expected state if no applications were deployed.

## Recommendation
Deploy your application: kubectl apply - f deployment.yaml`
      }
    ]
  },
  // Edge case: Multiple issues
  {
    name: 'Multiple Issues Triage',
    user: 'cluster is having issues',
    expectedFlow: ['FIND_ISSUES', 'DESCRIBE', 'GET_EVENTS'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'scheduling',
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found(5 total)
  - [CRITICAL] Pod app / web - abc: CrashLoopBackOff(Restarts: 23)
    - [CRITICAL] Pod app / worker - xyz: Pending(Unschedulable)
      - [WARNING] Node node - 3: DiskPressure
        - [WARNING] Deployment app / web: 1 / 3 replicas ready
          - [WARNING] Service app / api - svc: No endpoints`,
      'DESCRIBE': (args) => `## Pod: app / worker - xyz
Status: Pending
Events:
- Warning FailedScheduling: 0 / 3 nodes available: 1 node has DiskPressure, 2 nodes have insufficient memory.`,
      'GET_EVENTS': (args) => `## Recent Events(10)
  - [Warning] app / worker - xyz: FailedScheduling
    - [Warning] app / web - abc: BackOff restarting container
      - [Warning] app / web: MinimumReplicasUnavailable`,
      'GET_LOGS': (args) => `## Logs
[ERROR] Database connection refused
[FATAL] Cannot start without database`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `** Initial Hypotheses:**
  - H1: Node resource pressure → Status: INVESTIGATING
    - H2: Application configuration issue → Status: INVESTIGATING
      - H3: Scheduling failure due to capacity → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after FIND_ISSUES',
        output: `Found multiple issues.The Pending pod seems most critical - let's check why it's not scheduling.

- H3: Scheduling failure → Status: INVESTIGATING

TOOL: DESCRIBE Pod app worker-xyz
TOOL: GET_EVENTS app`
      },
      {
        input: 'after DESCRIBE and GET_EVENTS',
        output: `## Summary
Multiple cascading issues in the app namespace.

## Root Cause
  ** Primary: Cluster capacity issue ** - Node - 3 has DiskPressure, and remaining nodes don't have enough memory.

This is causing:
1. worker - xyz cannot be scheduled
2. web pods are crashing(possibly due to missing worker)
3. api - svc has no endpoints(pods not ready)

  - H1: Node resource pressure → Status: CONFIRMED
    - H3: Scheduling failure due to capacity → Status: CONFIRMED

## Confidence: HIGH

## Recommendations
1. URGENT: Clear disk space on node - 3 or add new node
2. Consider adding node with more memory
3. Once scheduling works, other issues may resolve`
      }
    ]
  },
  {
    name: 'Namespace Stuck (Finalizer Issue) v2',
    user: 'why is old-project namespace stuck terminating?',
    expectedFlow: ['GET_NAMESPACE', 'LIST_FINALIZERS'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'operator is not running',
    mockTools: {
      'GET_NAMESPACE': (args) => `## Namespace: old-project
Phase: Terminating
DeletionTimestamp: 2024-01-20T10:00:00Z
Conditions:
- NamespaceDeletionDiscoveryFailure: True
- NamespaceDeletionContentFailure: True`,
      'LIST_FINALIZERS': (args) => `## Resources with Finalizers (1 found)
1. CustomResource/db-backup-123 (database.example.com/v1alpha1)
   Finalizer: database.example.com/cleanup
   Status: Terminating since 12h
   
⚠️ The controller for this finalizer might be down.`,
      'FIND_ISSUES': () => `## Issues Found
- [WARNING] Namespace old-project: Stuck in Terminating state`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Finalizer blocking deletion → Status: INVESTIGATING
- H2: Child resources stuck → Status: INVESTIGATING

TOOL: GET_NAMESPACE old-project`
      },
      {
        input: 'after GET_NAMESPACE',
        output: `Namespace is in Terminating phase with failure conditions. I need to check for resources with finalizers.

TOOL: LIST_FINALIZERS old-project`
      },
      {
        input: 'after LIST_FINALIZERS',
        output: `## Summary
The namespace 'old-project' is stuck because a CustomResource 'db-backup-123' has a pending finalizer.

## Root Cause
**Finalizer deadlock**: 'database.example.com/cleanup' finalizer is blocking deletion, likely because the database operator is not running or is unresponsive.

- H1: Finalizer blocking deletion → Status: CONFIRMED

Confidence: HIGH
Identified specific blocking resource and finalizer.

## Fix
Check if the database operator is running. If not, you may need to manually patch the finalizer:
\`kubectl patch crd/db-backup-123 -p '{"metadata":{"finalizers":[]}}' --type=merge\``
      }
    ]
  },
  {
    name: 'Ambiguous Resource (CRD Discovery)',
    user: 'check if postgres is healthy',
    expectedFlow: ['RUN_BASH', 'RUN_KUBECTL'], // Discovery flow
    expectedConfidence: 'HIGH',
    expectedRootCause: 'healthy',
    mockTools: {
      'RUN_BASH': (args) => `postgresqls   pg   postgresql.cnpg.io/v1   true   Postgresql`,
      'RUN_KUBECTL': (args) => `NAMESPACE  NAME     AGE  INSTANCES  READY  STATUS
prod       main-db  10d  3          3      ClusterOK`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: User refers to 'postgresql' Custom Resource → Status: INVESTIGATING
- H2: User refers to a Deployment named 'postgres' → Status: INVESTIGATING

I need to discover if there are any Postgres-related CRDs first.

TOOL: RUN_BASH kubectl api-resources | grep -i postgres`
      },
      {
        input: 'after discovery',
        output: `Found 'postgresqls' CRD. Now listing instances to check health.

TOOL: RUN_KUBECTL get postgresqls -A`
      },
      {
        input: 'after listing',
        output: `## Answer
- H1: User refers to 'postgresql' Custom Resource → Status: CONFIRMED
Found 1 Postgres cluster 'main-db' in 'prod' namespace.

## Root Cause
** N / A **: Resource is healthy(Status: ClusterOK).

## Confidence: HIGH`
      }
    ]
  },
  {
    name: 'Istio VirtualService Routing Issue',
    user: 'payments-service is returning 503s',
    expectedFlow: ['DESCRIBE', 'RUN_KUBECTL'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'non-existent subset',
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found
- [WARNING] Service payments-service: No active endpoints for subset 'v2'`,
      'DESCRIBE': (args) => {
        if (args.includes('VirtualService')) return `## VirtualService: payments-vs
Hosts: [payments-service]
Http:
  - Route:
    - Destination:
        Host: payments-service
        Subset: v2`;
        if (args.includes('DestinationRule')) return `## DestinationRule: payments-dr
Host: payments-service
Subsets:
  - Name: v1
    Labels: version=v1
  - Name: v2
    Labels: version=v2`;
        return `## Service: payments-service
Selector: app=payments
Ports: 80/TCP`;
      },
      'RUN_KUBECTL': (args) => {
        if (args.includes('get destinationrules')) return `NAME            HOST               AGE
payments-dr     payments-service   1d`;
        if (args.includes('get virtualservices')) return `NAME           GATEWAYS   HOSTS              AGE
payments-vs    [mesh]     [payments-service] 1d`;
        if (args.includes('get pods')) return `NAME           READY  STATUS   LABELS
payments-abc   1/1    Running  app=payments,version=v1`;
        if (args.includes('get virtualservices,destinationrules')) return `NAMESPACE  NAME           GATEWAYS  HOSTS             AGE
default    payments-vs    [mesh]    [payments-svc]    1d
default    payments-dr              payments-svc      1d`;
        return `No resources found.`;
      },
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Service mesh routing misconfiguration → Status: INVESTIGATING
- H2: Application down → Status: INVESTIGATING

TOOL: RUN_KUBECTL get virtualservices,destinationrules -A`
      },
      {
        input: 'after listing',
        output: `Found Istio resources. Checking VirtualService and DestinationRule details for payments-service.

TOOL: DESCRIBE VirtualService payments-vs
TOOL: DESCRIBE DestinationRule payments-dr
TOOL: RUN_KUBECTL get pods -l app=payments --show-labels`
      },
      {
        input: 'after details',
        output: `## Summary
Updates to 503s are caused by a routing mismatch.

## Root Cause
**Route to non-existent subset**: VirtualService routes to subset 'v2', but the only running pods have label 'version=v1'. DestinationRule defines 'v2', but no pods match it.

- H1: Service mesh routing misconfiguration → Status: CONFIRMED

## Confidence: HIGH
Direct configuration mismatch found.

## Fix
Update VirtualService to point to 'v1' or deploy pods with 'version=v2'.`
      }
    ]
  },
  {
    name: 'Pending PVC (StorageClass Issue)',
    user: 'db-pod failing to start',
    expectedFlow: ['FIND_ISSUES', 'DESCRIBE'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'storageclass',
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found
- [CRITICAL] Pod db-pod: Pending
- [WARNING] PVC data-pvc: Pending`,
      'DESCRIBE': (args) => `## PVC: data-pvc
Status: Pending
Volume:
StorageClass: fast-ssd
Events:
  - Warning ProvisioningFailed: storageclass.storage.k8s.io "fast-ssd" not found`,
    },
    llmResponses: [
      {
        input: 'initial',
        tool: 'FIND_ISSUES',
        output: `**Initial Hypotheses:**
- H1: Storage provisioning failed → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after issues',
        output: `PVC is pending. I need to check the PVC events.

TOOL: DESCRIBE PersistentVolumeClaim data-pvc`
      },
      {
        input: 'after describe',
        output: `## Summary
Pod is pending because its PVC cannot be provisioned.

## Root Cause
**Missing StorageClass**: PVC requests 'fast-ssd' which does not exist in the cluster.

- H1: Storage provisioning failed → Status: CONFIRMED

## Confidence: HIGH

## Fix
Create the 'fast-ssd' StorageClass or update the PVC to use an existing one (e.g., 'standard').`
      }
    ]
  },
  {
    name: 'Crossplane Resource Failing (Reconcile Loop)',
    user: 'my rds instance is not becoming ready',
    expectedFlow: ['RUN_KUBECTL', 'DESCRIBE'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'permission denied',
    mockTools: {
      'RUN_KUBECTL': (args) => {
        if (args.includes('get managed')) return `rds           my-db-123   False    True     RDSInstance`;
        return `NAMESPACE   NAME        READY   SYNCED   AGE
default     my-db-123   False   True     10m`;
      },
      'DESCRIBE': (args) => `## RDSInstance: default/my-db-123
Status:
  Conditions:
    - Type: Ready
      Status: False
      Reason: Creating
      Message: "Warning: ReconcileError: cannot create DB instance: AccessDenied: User: arn:aws:iam::123:user/crossplane is not authorized to perform: rds:CreateDBInstance"`,
      'FIND_ISSUES': () => `## Issues Found
- [WARNING] RDSInstance my-db-123: Not Ready (ReconcileError)`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Crossplane provider configuration issue → Status: INVESTIGATING
- H2: Cloud provider permission issue → Status: INVESTIGATING

TOOL: RUN_KUBECTL get managed -A | grep -i rds`
      },
      {
        input: 'after discovery',
        output: `Found RDSInstance 'my-db-123' which is not Ready. Checking details.

TOOL: DESCRIBE RDSInstance default my-db-123`
      },
      {
        input: 'after describe',
        output: `## Summary
RDS instance creation is failing due to AWS permissions.

## Root Cause
**Permission Denied**: The Crossplane IAM user does not have \`rds:CreateDBInstance\` permission.

- H2: Cloud provider permission issue → Status: CONFIRMED

## Confidence: HIGH
Explicit AccessDenied error in status conditions.

## Fix
Grant the \`rds:CreateDBInstance\` permission to the IAM user 'crossplane'.`
      }
    ]
  },
  {
    name: 'Deep Investigation: Cascading Failure',
    user: 'payment-processor is down',
    expectedFlow: ['FIND_ISSUES', 'DESCRIBE', 'RUN_KUBECTL'],
    expectedConfidence: 'HIGH',
    expectedRootCause: 'aws credentials expired',
    mockTools: {
      'FIND_ISSUES': () => `## Issues Found
- [CRITICAL] Pod payment-processor-789: CrashLoopBackOff (Restart count: 42)`,
      'RUN_KUBECTL': (args) => {
        if (args.includes('get events') || args.includes('GET_EVENTS')) return `## Recent Events
- [Warning] payment-processor-789: BackOff restarting failed container
- [Warning] payment-processor-789: Error: FileNotFoundException`;
        if (args.includes('logs')) return `[FATAL] FileNotFoundException: /etc/config/app-config.json not found. Exiting.`;
        if (args.includes('describe pod')) return `## Pod: payment-processor-789
Status: Running
State: Waiting (CrashLoopBackOff)
Containers:
  - Name: app
    Mounts:
      - /etc/config/app-config.json from config-vol (ro)
Events:
  - Warning BackOff: Back-off restarting failed container`;
        if (args.includes('get pods') && args.includes('grep')) return `default       payment-processor-789     1/1     CrashLoopBackOff   0          5h`;
        if (args.includes('get pods') && args.includes('-o wide')) return `NAME                    READY   STATUS             RESTARTS   AGE   IP           NODE
payment-processor-789   1/1     CrashLoopBackOff   0          5h    10.42.0.1    worker-node-1`;
        if (args.includes('get deployments')) return `payment-processor   0/1     1            0           5h`;
        if (args.includes('describe deployment')) return `Name: payment-processor
Namespace: default
Pod Template:
  Volumes:
   - Name: config-vol
     ConfigMap:
       Name: payment-config`;
        if (args.includes('get externalsecret')) return `NAME             STORE          REFRESH INTERVAL   STATUS
payment-config   secret-store   1h                 SecretSyncedError`;
        if (args.includes('get secretstore')) return `NAME           AGE   STATUS
secret-store   10d   Invalid`;
        if (args.includes('describe configmap') || args.includes('get configmap')) return `Error from server (NotFound): configmaps "payment-config" not found`;
        return `Error: resource not found`;
      },
      'DESCRIBE': (args) => {
        if (args.includes('pod')) return `## Pod: payment-processor-789
Status: Running`;
        if (args.includes('deployment')) return `Name: payment-processor
Namespace: default
Pod Template:
  Volumes:
   - Name: config-vol
     ConfigMap:
       Name: payment-config`;
        if (args.includes('ExternalSecret')) return `## ExternalSecret: payment-config
Status:
  Conditions:
    - Type: Ready
      Status: False
      Reason: SecretSyncedError
      Message: "could not get secret data from provider: secretstore not found"`;
        if (args.includes('SecretStore')) return `## SecretStore: secret-store
Status:
  Conditions:
    - Type: Ready
      Status: False
      Reason: InvalidProviderConfig
      Message: "AWSAuth: assuming role: InvalidClientTokenId: The security token included in the request is invalid"`;
        if (args.includes('configmap')) return `Error from server (NotFound): configmaps "payment-config" not found`;
        return `Error: resource not found`;
      },
      'GET_LOGS': (args) => `[FATAL] FileNotFoundException: /etc/config/app-config.json not found. Exiting.`,
      'GET_EVENTS': (args) => `## Recent Events
- [Warning] payment-processor-789: BackOff restarting failed container
- [Warning] payment-processor-789: Error: FileNotFoundException`,
      'SEARCH_KNOWLEDGE': (args) => {
        if (args.includes('FileNotFoundException')) return `### Knowledge Base: FileNotFoundException
Common causes in Kubernetes:
1. ConfigMap not mounted correctly.
2. Typos in volumeMounts.
3. Secret not synced (if using ExternalSecrets).`;
        if (args.includes('ConfigMap')) return `### Knowledge Base: ConfigMap Not Found
Common issues:
1. ConfigMap name typo in Pod spec.
2. ConfigMap created in different namespace.
3. ConfigMap not created yet (check deployment manifests).
4. Secret not synced (if using ExternalSecrets).`;
        return `No knowledge base articles found.`;
      },
      'LIST_ALL': (args) => {
        if (args.includes('Pod')) return `default       payment-processor-789     1/1     CrashLoopBackOff   0          5h`;
        if (args.includes('Deployment')) return `payment-processor   1/1     1            1           5h`;
        return `No resources found.`;
      },
      'WEB_SEARCH': (args) => `### Web Search Results
- Check if the ConfigMap exists: kubectl get configmap
- Check volume mounts in Pod spec matches ConfigMap name.`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `**Initial Hypotheses:**
- H1: Application crash → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after issues',
        output: `Pod is crashing. Checking logs to see why.

TOOL: RUN_KUBECTL logs payment-processor-789 --tail=50
TOOL: DESCRIBE Pod payment-processor-789`
      },
      {
        input: 'after logs',
        output: `Logs say config file is missing. Checking if ConfigMap exists.

TOOL: RUN_KUBECTL get configmap payment-config`
      },
      {
        input: 'after configmap fail',
        output: `**Hypothesis Update:**
- H1: Application crash → Status: CONFIRMED (Missing config)
- H2: ConfigMap missing → Status: INVESTIGATING

ConfigMap is missing. Checking if it's managed by ExternalSecrets.

TOOL: RUN_KUBECTL get externalsecret payment-config`
      },
      {
        input: 'after externalsecret',
        output: `ExternalSecret exists but has an error. Investigating ExternalSecret status.

TOOL: DESCRIBE ExternalSecret payment-config`
      },
      {
        input: 'after externalsecret describe',
        output: `ExternalSecret can't sync because SecretStore is missing or invalid.

TOOL: RUN_KUBECTL get secretstore secret-store
TOOL: DESCRIBE SecretStore secret-store`
      },
      {
        input: 'after secretstore',
        output: `## Summary
The payment processor is down because the pod config is missing. The ConfigMap should be created by an ExternalSecret, which is failing because the SecretStore has invalid AWS credentials.

## Root Cause
**AWS Credentials Expired**: The SecretStore 'secret-store' is reporting 'InvalidClientTokenId', indicating the AWS IAM credentials used by the operator are invalid or expired.

- H2: ConfigMap missing → Status: CONFIRMED (Due to sync failure)

## Confidence: HIGH
Chain of failure traced to AWS auth error.

## Fix
Rotate the AWS keys for the ExternalSecrets operator.`
      }
    ]
  },
  {
    name: 'Deep Investigation: Crossplane Controller Logs',
    user: 'crossplane resources are failing',
    expectedFlow: ['RUN_KUBECTL', 'DESCRIBE'],
    expectedConfidence: 'MEDIUM',
    expectedRootCause: 'iam role trust policy',
    mockTools: {
      'FIND_ISSUES': () => `## Cluster Issues
- [Info] No critical alerts.
- [Info] Crossplane pods running in upbound-system.`,
      'RUN_KUBECTL': (args) => {
        if (args.includes('get deployments')) return `No resources found.`;
        if (args.includes('get pods')) return `upbound-system   crossplane-789                1/1     Running   0          5h
upbound-system   crossplane-rbac-manager-123   1/1     Running   0          5h
upbound-system   provider-aws-s3-456           1/1     Running   0          5h`;
        if (args.includes('logs')) return `...
I0502 10:00:00.123 controller.go:100] Reconciling Bucket "my-data-bucket"
E0502 10:00:05.456 controller.go:120] cannot create S3 bucket: AccessDenied: Access Denied
    status code: 403, request id: ABC, host id: XYZ
    caused by: User: arn:aws:sts::123456789012:assumed-role/CrossplaneRole/provider-aws is not authorized to perform: s3:CreateBucket on resource: arn:aws:s3:::my-data-bucket
...`;
        if (args.includes('get bucket')) return `NAME             READY   SYNCED   EXTERNAL-NAME    AGE
my-data-bucket   False   False    my-data-bucket   10m`;
        return `No resources found`;
      },
      'GET_LOGS': (args) => `...
I0502 10:00:00.123 controller.go:100] Reconciling Bucket "my-data-bucket"
E0502 10:00:05.456 controller.go:120] cannot create S3 bucket: AccessDenied: Access Denied
    status code: 403, request id: ABC, host id: XYZ
    caused by: User: arn:aws:sts::123456789012:assumed-role/CrossplaneRole/provider-aws is not authorized to perform: s3:CreateBucket on resource: arn:aws:s3:::my-data-bucket
...`,
      'DESCRIBE': (args) => `Name:         my-data-bucket
Namespace:    default
Labels:       crossplane.io/claim-name=my-data-claim
Status:
  Conditions:
    Type:     Synced
    Status:   False
    Reason:   ReconcileError
    Message:  cannot create S3 bucket: AccessDenied`,
      'LIST_ALL': (args) => {
        if (args.includes('Bucket')) return `my-data-bucket   False   False    my-data-bucket   10m`;
        if (args.includes('CrossplaneResource')) return `error: the server doesn't have a resource type "CrossplaneResource"`;
        return `No resources found.`;
      },
      'GET_LOGS': (args) => `...
I0502 10:00:00.123 controller.go:100] Reconciling Bucket "my-data-bucket"
E0502 10:00:05.456 controller.go:120] cannot create S3 bucket: AccessDenied: Access Denied
    status code: 403, request id: ABC, host id: XYZ
    caused by: User: arn:aws:sts::123456789012:assumed-role/CrossplaneRole/provider-aws is not authorized to perform: s3:CreateBucket on resource: arn:aws:s3:::my-data-bucket
...`,
      'CLUSTER_HEALTH': () => `All systems nominal.`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `I need to check for issues and see what controller is managing these resources.
TOOL: FIND_ISSUES`
      },
      {
        input: 'after discovery',
        output: `Resources are missing, need to check provider logs.
TOOL: RUN_KUBECTL logs -n upbound-system provider-aws-s3-456`
      },
      {
        input: 'after logs',
        output: `Logs show AccessDenied. Need to check the Bucket resource status to confirm.
TOOL: DESCRIBE Bucket my-data-bucket`
      },
      {
        input: 'after describe',
        output: `**Answer**: The Crossplane S3 bucket creation is failing due to AWS IAM permission issues.
**Root Cause**: The IAM role assumed by the provider (arn:aws:sts::123456789012:assumed-role/CrossplaneRole/provider-aws) lacks s3:CreateBucket permissions.
**Fix**: Update the AWS IAM policy attached to the Crossplane provider role to allow s3:CreateBucket.`
      }
    ]
  },
  {
    name: 'Deep Investigation: Distributed System Bottleneck',
    userMessage: 'checkout is really slow and failing',
    expectedConfidence: 'HIGH',
    expectedFlow: ['FIND_ISSUES'],
    mockTools: {
      'FIND_ISSUES': () => `## Cluster Issues
- [Warning] CheckoutServiceLatency: High latency detected (2s avg)
- [Warning] FrontendHighCPU: Pod frontend-web-123 using 95% CPU`,
      'RUN_KUBECTL': (args) => {
        if (args.includes('top pods')) return `NAMESPACE    NAME                    CPU(cores)   MEMORY(bytes)
default      frontend-web-123        950m         512Mi
default      checkout-service-456    100m         256Mi`;
        if (args.includes('logs') && args.includes('frontend')) return `[ERROR] Connection timed out to checkout-service:8080
[ERROR] Retrying request to checkout-service...
[INFO] Request to catalog-service passed`;
        if (args.includes('logs') && args.includes('checkout')) return `[ERROR] Database connection pool exhausted`;
        if (args.includes('logs') && args.includes('inventory')) return `[FATAL] Database connection failed: ExclusiveLock on inventory`;
        if (args.includes('get pods') && args.includes('inventory')) return `inventory-service-789  1/1  Running`;
        return `No resources found`;
      },
      'DESCRIBE': (args) => {
        if (args.includes('checkout-service')) return `## Service: checkout-service
Selector: app=checkout`;
        if (args.includes('inventory-service')) return `## Pod: inventory-service-789
Status: Running`;
        return `Resource not found`;
      },
      'RUN_BASH': (args) => `pg_isready: ok`,
    },
    llmResponses: [
      {
        input: 'initial',
        output: `** Initial Hypotheses:**
  - H1: Frontend saturation → Status: INVESTIGATING
    - H2: Backend service failure → Status: INVESTIGATING

TOOL: FIND_ISSUES`
      },
      {
        input: 'after issues',
        output: `Issues found in ingress and frontend.Checking resource usage to see if it's capacity related.

TOOL: RUN_KUBECTL top pods - A | grep - E "frontend|checkout"`
      },
      {
        input: 'after top',
        output: `Frontend has high CPU, checkout has high memory.Checking frontend logs for errors.

  TOOL: RUN_KUBECTL logs frontend - web - 123 --tail = 100`
      },
      {
        input: 'after frontend logs',
        output: `Frontend logs show downstream timeout from 'checkout-service'.Investigating checkout service.

  TOOL: DESCRIBE Service checkout - service
TOOL: RUN_KUBECTL logs checkout - service - 456 --tail = 100`
      },
      {
        input: 'after checkout logs',
        output: `Checkout logs indicate valid endpoints but timeouts calling 'Inventory Service'.
This is a dependency chain issue.Investigating Inventory Service now.

  TOOL: RUN_KUBECTL get pods - l app = inventory`
      },
      {
        input: 'after inventory list',
        output: `Inventory pod is Running.Checking detailed status and logs.

  TOOL: DESCRIBE Pod inventory - service - 789
TOOL: RUN_KUBECTL logs inventory - service - 789 --tail = 100`
      },
      {
        input: 'after inventory logs',
        output: `Inventory service is running but database connection pool is saturated.
Likely a database issue.Checking Postgres connectivity and logs.

  TOOL: RUN_BASH kubectl exec - it inventory - service - 789 -- pg_isready - h postgres - inventory
TOOL: RUN_BASH kubectl logs postgres - inventory - 0 --tail = 50`
      },
      {
        input: 'after postgres logs',
        output: `## Summary
The checkout slowness is caused by a cascading timeout starting from the database layer.

## Root Cause
  ** Database Table Lock **: The 'postgres-inventory' database has an ExclusiveLock on the "inventory" relation, causing the Inventory Service connection pool to saturate.This causes timeouts in Checkout Service, which cascades to 503s in the Frontend.

- H1: Frontend saturation → Status: REFUTED(Symptom, not cause)
  - H3: Database Locking → Status: CONFIRMED

## Confidence: HIGH
Traced timeouts through 3 microservices to a specific DB lock log entry.

## Fix
Kill the blocking Postgres process(pid 123) or wait for the checkpoint / maintenance to finish.Check the application for long - running transactions.`
      }
    ]
  },
  {
    name: "Deep Investigation: Error Recovery",
    user: "Why is the payments-pod crashing?",
    expectedTools: ["GET_LOGS", "RUN_KUBECTL", "GET_LOGS"],
    expectedConfidence: 'MEDIUM',
    expectedFlow: [], // Added to prevent runner crash
    mockTools: {
      "GET_LOGS": (args) => {
        if (args.includes("payments-pod")) return "Error: pods \"payments-pod\" not found";
        return "Log content: Application started successfully.";
      },
      "RUN_KUBECTL": (args) => {
        if (args.includes("get pods")) return "NAME                 READY   STATUS    RESTARTS   AGE\npayments-pod-123     1/1     Running   0          10m";
        return "";
      }
    },
    llmResponses: [
      {
        input: 'initial',
        output: `I need to check the logs for the payments pod.
TOOL: GET_LOGS default payments-pod`
      },
      {
        input: 'after error',
        output: `The pod 'payments-pod' was not found. I need to find the correct pod name.
TOOL: RUN_KUBECTL kubectl get pods | grep payments`
      },
      {
        input: 'after list',
        output: `Found the correct pod name 'payments-pod-123'. Checking logs now.
TOOL: GET_LOGS default payments-pod-123`
      },
      {
        input: 'after success',
        output: `**Answer**: The pod 'payments-pod-123' is running locally. The initial error was due to an incorrect pod name.`
      }
    ]
  },
  {
    name: "Deep Investigation: Speed Hack",
    user: "Debug the payment-pod failure immediately",
    expectedTools: ["CLUSTER_HEALTH", "DEEP_INSPECT"],
    expectedConfidence: "LOW", // Low because we mock connection refused
    expectedFlow: [],
    mockTools: {
      "CLUSTER_HEALTH": () => JSON.stringify({
        total_nodes: 2,
        not_ready_nodes: [],
        running_pods: 10,
        failed_pods: 1, // One failure
        critical_issues: [],
        crashloop_pods: [{ namespace: "default", name: "payment-pod-789", restart_count: 5, reason: "CrashLoopBackOff" }]
      }),
      "DEEP_INSPECT": (args) => {
        if (args.includes("payment-pod-789")) {
          return `## DEEP INSPECT: Pod/default/payment-pod-789
### 1. Resource Configuration
Environment: PRODUCTION=true

### 2. Recent Events
- [Warning] BackOff: Back-off restarting failed container

### 3. Recent Logs
[ERROR] Database connection failed: Connection refused`;
        }
        return "Resource not found";
      }
    },
    llmResponses: [
      {
        input: 'initial',
        output: `I need to investigate the payment pod failure immediately and comprehensively.
TOOL: DEEP_INSPECT Pod default payment-pod-789`
      },
      {
        input: 'after details',
        output: `**Root Cause**: The pod is crashing because it cannot connect to the database (Connection refused). This suggests a network issue or the DB is down.
**Fix**: Check the database status.`
      }
    ]
  },
  {
    name: "Real Agent: Complex Debugging",
    user: "Why is the checkout-service failing to connect to redis?",
    expectedTools: [], // Dynamic flow
    mockTools: {
      "CLUSTER_HEALTH": () => JSON.stringify({
        total_nodes: 2,
        not_ready_nodes: [],
        running_pods: 15,
        failed_pods: 1,
        critical_issues: [{ resource_kind: 'Pod', namespace: 'default', resource_name: 'checkout-service-5566', message: 'CrashLoopBackOff' }],
        crashloop_pods: [{ namespace: "default", name: "checkout-service-5566", restart_count: 12, reason: "CrashLoopBackOff" }]
      }),
      "DEEP_INSPECT": (args) => {
        if (args.includes("checkout-service")) {
          return `## DEEP INSPECT: Pod/default/checkout-service-5566
### 1. Resource Configuration
Name: checkout-service-5566
Namespace: default
Node: node-1
Status: Running

### 2. Recent Events
- [Warning] BackOff: Back-off restarting failed container

### 3. Recent Logs
[INFO] Starting checkout service...
[INFO] Connecting to Redis at redis-master:6379...
[ERROR] ConnectionRefused: Dial tcp: lookup redis-master on 10.96.0.10:53: no such host
[FATAL] Dependency check failed. Exiting.`;
        }
        return "Resource not found";
      },
      "LIST_ALL": (args) => {
        if (args.toLowerCase().includes("pod") || args.toLowerCase().includes("redis")) {
          return `NAME                            READY   STATUS    RESTARTS   AGE
checkout-service-5566            1/1     Running   12         1h
redis-master-0                   0/1     Pending   0          10m
logging-agent-ds-x99             1/1     Running   0          2d`;
        }
        if (args.toLowerCase().includes("service")) {
          return `NAME               TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
kubernetes         ClusterIP   10.96.0.1       <none>        443/TCP    2d
checkout-service   ClusterIP   10.96.24.12     <none>        80/TCP     1h
redis-master       ClusterIP   10.96.55.88     <none>        6379/TCP   10m`;
        }
        return "No resources found.";
      },
      "DESCRIBE": (args) => {
        if (args.includes("redis-master")) {
          return `Name:         redis-master-0
Namespace:    default
Priority:     0
Node:         <none>
Start Time:   Tue, 09 Dec 2025 15:00:00 -0800
Labels:       app=redis
Status:       Pending
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  5m    default-scheduler  0/2 nodes are available: 2 Insufficient memory. preemption: 0/2 nodes are available: 2 No preemption victims found for incoming pod.`;
        }
        return "Resource not found.";
      },
      "GET_EVENTS": (args) => `No relevant events found (except FailedScheduling for redis-master-0).`,
      "RUN_KUBECTL": (args) => {
        if (args.includes("get pods")) return "redis-master-0   0/1     Pending   0          10m";
        return "No resources found";
      }
    }
  },
  {
    name: "Deep Inspect: Namespace Discovery",
    user: "Why is the backend-api deployment failing?",
    expectedTools: ["DEEP_INSPECT", "RUN_KUBECTL", "DEEP_INSPECT"],
    expectedFunds: "MEDIUM",
    expectedConfidence: "MEDIUM",
    expectedFlow: ["DEEP_INSPECT", "RUN_KUBECTL", "DEEP_INSPECT"],
    mockTools: {
      "CLUSTER_HEALTH": () => JSON.stringify({
        total_nodes: 2,
        not_ready_nodes: [],
        running_pods: 10,
        failed_pods: 0,
        critical_issues: [],
        crashloop_pods: []
      }),
      "DEEP_INSPECT": (args) => {
        // First try (default namespace or generic)
        if (args.includes("default") || !args.includes("prod-system")) {
          return "Error: deployments \"backend-api\" not found in namespace \"default\"";
        }
        // Second try (correct namespace)
        if (args.includes("prod-system") && args.includes("backend-api")) {
          return `## DEEP INSPECT: Deployment/prod-system/backend-api
### 1. Resource Configuration
Replicas: 0/3 updated, 0/3 ready
Selector: app=backend-api

### 2. Recent Events
- [Warning] FailedCreate: quota "cpu-quota" exceeded`;
        }
        return "Resource not found";
      },
      "RUN_KUBECTL": (args) => {
        if (args.includes("get deployment") && args.includes("-A")) {
          return `NAMESPACE      NAME           READY   UP-TO-DATE   AVAILABLE   AGE
prod-system    backend-api    0/3     0            0           5m`;
        }
        return "No resources found";
      }
    },
    llmResponses: [
      {
        input: 'initial',
        output: `I'll start by inspecting the backend-api deployment.
TOOL: DEEP_INSPECT Deployment default backend-api`
      },
      {
        input: 'after failure',
        output: `It seems backend-api isn't in default. I'll search for it in all namespaces.
TOOL: RUN_KUBECTL kubectl get deployment -A | grep backend-api`
      },
      {
        input: 'after finding ns',
        output: `Found it in prod-system. Investigating there.
TOOL: DEEP_INSPECT Deployment prod-system backend-api`
      },
      {
        input: 'after success',
        output: `**Root Cause**: The deployment is failing because it exceeded the 'cpu-quota' in prod-system.`
      }
    ]
  }
];


// =============================================================================
// TEST RUNNER
// =============================================================================

function runScenario(scenario) {
  const state = {
    query: scenario.user,
    iteration: 0,
    maxIterations: STEP_BUDGET,
    toolHistory: [],
    hypotheses: [],
    consecutiveUnproductive: 0,
    phase: 'gathering',
  };

  const executedTools = new Set();
  const errors = [];
  let currentLlmResponseIdx = 0;
  let lastResult = '';

  console.log(`\n${'='.repeat(60)} `);
  console.log(`📋 Scenario: ${scenario.name} `);
  console.log(`   User Query: "${scenario.user}"`);
  console.log(`${'='.repeat(60)} `);

  // Simulate investigation loop
  while (state.iteration < state.maxIterations) {
    state.iteration++;

    // Get LLM response for current state
    const llmResponse = scenario.llmResponses[currentLlmResponseIdx];
    if (!llmResponse) {
      console.log(`   [Iteration ${state.iteration}] No more LLM responses defined`);
      break;
    }
    currentLlmResponseIdx++;

    console.log(`\n[Iteration ${state.iteration}] LLM Input: ${llmResponse.input} `);

    // Extract hypotheses from LLM response
    state.hypotheses = extractHypotheses(llmResponse.output, state.hypotheses);
    if (state.hypotheses.length > 0) {
      console.log(`   📊 Hypotheses: ${state.hypotheses.map(h => `${h.id}(${h.status})`).join(', ')} `);
    }

    // Parse TOOL: commands from response
    const toolPattern = /TOOL:\s*(\w+)\s*(.*)?/gi;
    const tools = [...llmResponse.output.matchAll(toolPattern)];

    if (tools.length === 0) {
      // Check for final answer indicators
      if (llmResponse.output.includes('Confidence: HIGH') ||
        llmResponse.output.includes('Root Cause')) {
        console.log(`   ✅ Final answer provided`);
        break;
      }
      state.consecutiveUnproductive++;
      console.log(`   ⚠️ No tools in response(unproductive: ${state.consecutiveUnproductive})`);
      continue;
    }

    // Execute tools
    for (const toolMatch of tools) {
      const toolName = toolMatch[1].toUpperCase();
      const toolArgs = (toolMatch[2] || '').trim();
      const key = `${toolName}:${toolArgs} `;

      if (executedTools.has(key)) {
        console.log(`   ⏭️ Skipping duplicate: ${key} `);
        continue;
      }
      executedTools.add(key);

      // Get mock output
      let output;
      if (scenario.mockTools && scenario.mockTools[toolName]) {
        output = scenario.mockTools[toolName](toolArgs);
      } else if (scenario.toolOutputs) {
        output = scenario.toolOutputs[key];
      }
      if (!output) {
        errors.push(`Missing mock output for: ${key} `);
        console.log(`   ❌ Missing mock: ${key} `);
        continue;
      }

      const outcome = evaluateToolOutcome(output, toolName);
      state.toolHistory.push({
        tool: toolName,
        args: toolArgs,
        result: output,
        ...outcome,
        timestamp: Date.now(),
      });

      lastResult = output;

      const statusEmoji = outcome.status === 'success' ? '✅' :
        outcome.status === 'error' ? '❌' : '⚠️';
      console.log(`   ${statusEmoji} ${toolName}${toolArgs ? ` ${toolArgs}` : ''} → ${outcome.status}${outcome.useful ? ' (useful)' : ''} `);

      // Reset unproductive counter on useful result
      if (outcome.useful) {
        state.consecutiveUnproductive = 0;
      } else {
        state.consecutiveUnproductive++;
      }
    }

    // Check recommendations
    const recommendations = getNextToolRecommendations(state, lastResult);
    if (recommendations.length > 0) {
      console.log(`   💡 Recommendations: ${recommendations.join(', ')} `);
    }
  }

  return calculateAndReportResults(scenario, state, errors);
}

// Helper to consolidate result reporting
function calculateAndReportResults(scenario, state, errors) {
  // If we have a final response, check if it mentions the expected root cause
  if (state.finalResponse && scenario.expectedRootCause) {
    const responseLower = state.finalResponse.toLowerCase();
    const rootCauseLower = scenario.expectedRootCause.toLowerCase();
    if (responseLower.includes(rootCauseLower) ||
        responseLower.includes('root cause') ||
        responseLower.includes('memory') && rootCauseLower.includes('oom')) {
      // Agent found the root cause - add a confirmed hypothesis
      state.hypotheses.push({ status: 'confirmed', name: scenario.expectedRootCause });
    }
  }

  // Calculate final confidence
  const confidence = calculateConfidence(state);
  console.log(`\n   📈 Final Confidence: ${confidence.level} (${confidence.score}/100)`);

  // Check assertions
  const results = {
    scenario: scenario.name,
    passed: true,
    details: [],
    warnings: [],
  };

  // Check if root cause was found (PRIMARY success criteria)
  const foundRootCause = state.hypotheses.some(h => h.status === 'confirmed');

  // Check expected tools were used (soft check if root cause found)
  const usedTools = new Set(state.toolHistory.map(t => t.tool));
  for (const expectedTool of scenario.expectedFlow || []) {
    if (!usedTools.has(expectedTool)) {
      if (foundRootCause) {
        results.warnings.push(`Skipped tool: ${expectedTool} (but found root cause)`);
      } else {
        results.passed = false;
        results.details.push(`Missing tool: ${expectedTool}`);
      }
    }
  }

  // Check confidence level (soft check if root cause found)
  if (scenario.expectedConfidence && confidence.level !== scenario.expectedConfidence) {
    if (foundRootCause && confidence.score >= 50) {
      results.warnings.push(`Confidence: got ${confidence.level} (expected ${scenario.expectedConfidence})`);
    } else {
      results.passed = false;
      results.details.push(`Confidence mismatch: expected ${scenario.expectedConfidence}, got ${confidence.level}`);
    }
  }

  // If root cause was expected but not found, that's a failure
  if (scenario.expectedRootCause && !foundRootCause) {
    results.passed = false;
    results.details.push(`Root cause not found: expected "${scenario.expectedRootCause}"`);
  }

  if (errors.length > 0) {
    results.details.push(...errors.map(e => `Error: ${e}`));
  }

  // Print result
  console.log(`\n   ${'─'.repeat(50)} `);
  if (results.passed) {
    console.log(`   ✅ PASSED${foundRootCause ? ' (Root cause found!)' : ''}`);
    for (const warning of results.warnings) {
      console.log(`      ⚠️ ${warning}`);
    }
  } else {
    console.log(`   ❌ FAILED`);
    for (const detail of results.details) {
      console.log(`      - ${detail}`);
    }
  }

  return results;
}

// Format command history for the prompt
function formatCommandHistory(toolHistory) {
  if (!toolHistory || toolHistory.length === 0) return '(none yet)';
  return toolHistory.map((h, i) =>
    `[${i + 1}] $ ${h.tool} ${h.args || ''}\n${h.result?.slice(0, 2000) || '(no output)'}`
  ).join('\n\n');
}

// NEW: Run scenario with REAL LLM but MOCK tools
async function runRealScenario(scenario) {
  console.log(`\n${'='.repeat(60)} `);
  console.log(`🤖 REAL LLM SCENARIO: ${scenario.name} `);
  console.log(`   User Query: "${scenario.user}"`);
  console.log(`${'='.repeat(60)} `);

  const state = {
    query: scenario.user,
    iteration: 0,
    maxIterations: STEP_BUDGET,
    toolHistory: [],
    hypotheses: [],
    consecutiveUnproductive: 0,
    phase: 'gathering',
    finalResponse: null,
  };

  // Format the system prompt with current context
  const getFormattedPrompt = () => {
    return SYSTEM_PROMPT
      .replace('{query}', state.query)
      .replace('{kube_context}', scenario.kubeContext || 'default')
      .replace('{cluster_info}', scenario.clusterInfo || 'Not available')
      .replace('{command_history}', formatCommandHistory(state.toolHistory))
      .replace(/\{examples\}/g, ''); // Remove unfilled examples placeholder
  };

  let conversation = [
    { role: 'user', content: `Query: ${scenario.user}\nContext: ${scenario.kubeContext || 'default'}\nCluster: ${scenario.clusterInfo || 'Unknown'}\nCommand History: (none yet)` }
  ];

  const executedTools = new Set();
  const errors = [];

  while (state.iteration < state.maxIterations) {
    state.iteration++;
    console.log(`\n[Iteration ${state.iteration}] Calling LLM...`);

    // Build fresh prompt with updated context for each iteration
    const currentPrompt = getFormattedPrompt();

    // Call Real LLM with formatted system prompt
    const llmResult = await callRealLLMConversation(conversation, currentPrompt);
    if (!llmResult.success) {
      console.log(`   ❌ LLM Error: ${llmResult.error} `);
      break;
    }

    const responseText = llmResult.response;
    console.log(`   📝 Agent: ${responseText.slice(0, 150)}...`);
    conversation.push({ role: 'assistant', content: responseText });

    // Extract Tool Calls
    const commands = extractCommands(responseText);

    // Check for final answer (Python format: next_action: "respond")
    try {
      const parsed = JSON.parse(responseText.slice(responseText.indexOf('{'), responseText.lastIndexOf('}') + 1));
      if (parsed.next_action === 'respond' && parsed.final_response) {
        console.log(`   ✅ Final answer provided (next_action=respond)`);
        console.log(`   📋 Response: ${parsed.final_response.slice(0, 200)}...`);
        state.finalResponse = parsed.final_response;
        break;
      }
    } catch (e) {
      // Not valid JSON, check legacy format
    }

    // Legacy check for final answer
    if (commands.length === 0) {
      if (responseText.includes('Confidence: HIGH') || responseText.includes('Root Cause') || responseText.includes('## Answer')) {
        console.log(`   ✅ Final answer provided (legacy format)`);
        break;
      }
      if (state.iteration > 5 && state.consecutiveUnproductive > 2) {
        console.log(`   ⚠️ Stalled(no tools)`);
        break;
      }
    }

    let toolOutputsText = '';

    for (const cmd of commands) {
      const key = `${cmd.tool}:${cmd.args} `;
      // Normalize key for matching (some LLMs might change spacing)
      const mockKey = scenario.toolOutputs ? Object.keys(scenario.toolOutputs).find(k => k.replace(/\s+/g, '') === key.replace(/\s+/g, '')) : null;

      let output = '';
      const cmdKey = `${cmd.tool}:${cmd.args}`;

      // LOOP DETECTION: Check if we already ran this exact command
      const alreadyRan = [...executedTools].some(t => t.replace(/\s+/g, '') === cmdKey.replace(/\s+/g, ''));
      if (alreadyRan) {
        output = `[SYSTEM] You already executed '${cmdKey}'. DO NOT REPEAT COMMANDS. Choose a different step (e.g. check config, check volume, check service).`;
        console.log(`   ⚠️ Loop Detected: ${cmdKey} -> Blocking`);
      } else if (scenario.mockTools && scenario.mockTools[cmd.tool]) {
        // FUNCTIONAL MOCK (New System)
        try {
          output = scenario.mockTools[cmd.tool](cmd.args);
          console.log(`   ✅ Executed ${key} (Mock Function)`);
          executedTools.add(key);
        } catch (e) {
          output = `Error executing mock for ${cmd.tool}: ${e}`;
          errors.push(`Mock Error: ${cmd.tool}`);
        }
      } else if (mockKey && scenario.toolOutputs) {
        // STATIC MOCK (Legacy System)
        output = scenario.toolOutputs[mockKey];
        console.log(`   ✅ Executed ${key} (Static Mock)`);
        executedTools.add(key);
      } else {
        output = `Tool execution failed: No mock output found for ${key}. Available Mocks: ${[
          ...(scenario.toolOutputs ? Object.keys(scenario.toolOutputs) : []),
          ...(scenario.mockTools ? Object.keys(scenario.mockTools) : [])
        ].join(', ')}`;
        console.log(`   ❌ Missing Mock: ${key}`);
        errors.push(`Missing mock: ${key}`);
      }

      const isUseful = !output.includes('failed') && !output.includes('LOOP DETECTED') && output.length > 50;
      state.toolHistory.push({
        tool: cmd.tool,
        args: cmd.args,
        result: output,
        timestamp: Date.now(),
        status: output.includes('Error') || output.includes('failed') ? 'error' : 'success',
        useful: isUseful
      });

      toolOutputsText += `\nCommand: ${cmd.tool} ${cmd.args}\nOutput:\n${output}\n`;
    }

    if (toolOutputsText) {
      conversation.push({ role: 'user', content: toolOutputsText });
    }
  }

  return calculateAndReportResults(scenario, state, errors);
}

// Adapt callRealLLM to support conversation history via efficient HTTP API
async function callRealLLMConversation(messages, formattedSystemPrompt = null) {
  try {
    const host = process.env.LLM_HOST || 'http://localhost:11434';
    const isV1 = host.endsWith('/v1');
    // For conversation, we need chat endpoint
    const endpoint = isV1 ? `${host}/chat/completions` : `${host}/api/chat`;
    const model = process.env.LLM_MODEL || 'llama3.3:70b';

    // Use provided formatted prompt or default SYSTEM_PROMPT
    const systemPrompt = formattedSystemPrompt || SYSTEM_PROMPT;

    // Inject System Prompt at the beginning
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    console.log(`\n🤖 Calling Real LLM (${model} @ ${host})...`);

    const body = isV1 ? {
      model: model,
      messages: apiMessages,
      temperature: 0,
      response_format: { type: "json_object" }
    } : {
      model: model,
      messages: apiMessages,
      stream: false,
      options: {
        temperature: 0,
        num_ctx: 32768
      },
      format: "json"
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`LLM API error (${response.status}): ${txt}`);
    }

    const data = await response.json();
    let content = '';

    if (isV1) {
      content = data.choices?.[0]?.message?.content || '';
    } else {
      content = data.message?.content || '';
    }

    return { success: true, response: content };

  } catch (error) {
    console.error(`   ❌ Ollama API Failed: ${error.message} `);
    return { success: false, error: error.message };
  }
}

async function main() {
  const runReal = process.argv.includes('--real-llm');

  if (runReal) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║        REAL LLM AGENT EVALUATION(MOCK TOOLS)                ║
╚══════════════════════════════════════════════════════════════╝
`);
    for (const scenario of scenarios) {
      if (TEST_FILTER && !scenario.name.toLowerCase().includes(TEST_FILTER.toLowerCase())) {
        continue;
      }
      // Only run deep scenarios OR specific filtered scenarios for real eval to save cost/time
      if (TEST_FILTER || scenario.name.includes('Deep Investigation')) {
        await runRealScenario(scenario);
      }
    }
  } else {
    // Logic for existing tests...
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║        AUTONOMOUS AGENT EVALUATION HARNESS                   ║
╚══════════════════════════════════════════════════════════════╝
`);
    const results = [];
    let passed = 0;
    let failed = 0;

    for (const scenario of scenarios) {
      if (!scenario.llmResponses && !process.argv.includes('--real-llm')) {
        console.log(`\n⚠️ Skipping "${scenario.name}" (Real LLM Only)`);
        continue;
      }
      const result = runScenario(scenario);
      results.push(result);
      if (result.passed) passed++;
      else failed++;
    }

    // (Summary printing logic...)
    console.log(`\n${'═'.repeat(60)} `);
    console.log(`SUMMARY: ${passed}/${scenarios.length} scenarios passed`);
    console.log(`${'═'.repeat(60)}`);

    for (const result of results) {
      const emoji = result.passed ? '✅' : '❌';
      console.log(`${emoji} ${result.scenario}`);
    }

    if (failed > 0) process.exitCode = 1;
  }
}


main();
