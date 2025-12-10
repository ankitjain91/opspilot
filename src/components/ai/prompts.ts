import { ClusterHealthSummary } from '../../types/ai';
import { InvestigationState, ConfidenceAssessment, calculateConfidence, formatHypothesesForPrompt, compressToolHistorySemantic } from './types';
import { Playbook, formatPlaybookGuidance, matchPlaybook, extractSymptoms } from './playbooks';

/**
 * LLAMA 3.1 8B LOCAL OPTIMIZED PROMPTS - V2
 *
 * RADICAL SIMPLIFICATION for 8B parameter models:
 * 1. REDUCED COMPLEXITY: 5 core tools instead of 12, ~10 instructions instead of 60
 * 2. POSITIVE INSTRUCTIONS: "Always do X" instead of "Never do Y" (8B handles better)
 * 3. SINGLE PATTERN: All examples follow same discovery flow (LIST → DESCRIBE → LOGS)
 * 4. EXPLICIT VOCABULARY: No symbolic compression, full words only
 * 5. STATE MACHINE: Guided investigation with limited choices at each step
 * 6. REDUCED CONTEXT: 8k window, last result only, no deep history
 * 7. FORMAT ENFORCEMENT: Template-based responses, post-processing validation
 * 8. DETERMINISTIC FALLBACKS: Rule-based tool selection for critical paths
 */

// =============================================================================
// CORE TOOLS FOR 8B MODELS (Reduced from 12 to 5)
// =============================================================================

export const LLAMA_CORE_TOOLS = ['FIND_ISSUES', 'LIST_ALL', 'DESCRIBE', 'GET_LOGS', 'RUN_KUBECTL'] as const;

// Map complex tools to simple equivalents for 8B
export const TOOL_MAPPING: Record<string, { replacement: string; args?: string }> = {
  'GET_CROSSPLANE': { replacement: 'RUN_KUBECTL', args: 'kubectl get managed,composite,claim -A' },
  'GET_ISTIO': { replacement: 'RUN_KUBECTL', args: 'kubectl get gateway,virtualservice,destinationrule -A' },
  'GET_WEBHOOKS': { replacement: 'RUN_KUBECTL', args: 'kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations' },
  'GET_UIPATH': { replacement: 'LIST_ALL', args: 'Pod' },
  'GET_CAPI': { replacement: 'RUN_KUBECTL', args: 'kubectl get clusters.cluster.x-k8s.io,machines -A' },
  'GET_CASTAI': { replacement: 'RUN_KUBECTL', args: 'kubectl get autoscalers.castai.upbound.io -A' },
  'TOP_PODS': { replacement: 'RUN_KUBECTL', args: 'kubectl top pods -A' },
  'GET_EVENTS': { replacement: 'RUN_KUBECTL', args: 'kubectl get events -A --sort-by=.lastTimestamp' },
  'DEEP_INSPECT': { replacement: 'DESCRIBE' }, // Will need manual conversion with args
};

// =============================================================================
// LLAMA 3.1 8B OPTIMIZED SYSTEM PROMPT (Simplified)
// =============================================================================

export const LLAMA_OPTIMIZED_SYSTEM = `You are a Kubernetes tool executor.

RULES:
1. Output ONLY tool calls, no explanations
2. Format: TOOL: NAME arguments
3. Always use real names from previous outputs

TOOLS (5 core tools - memorize these):
- FIND_ISSUES: Scan cluster for problems (no arguments)
- LIST_ALL Kind: List resources. Example: LIST_ALL Pod
- DESCRIBE Kind Namespace Name: Get resource details
- GET_LOGS Namespace PodName: Get pod logs
- RUN_KUBECTL command: Run kubectl command with grep/filters

DISCOVERY PATTERN (always follow):
Step 1: Unknown names? → TOOL: LIST_ALL Pod
Step 2: Got names? → TOOL: DESCRIBE Pod namespace podname
Step 3: Need logs? → TOOL: GET_LOGS namespace podname

SPECIAL CASES (use RUN_KUBECTL with grep):
Crossplane: TOOL: RUN_KUBECTL kubectl get crds | grep crossplane
Istio: TOOL: RUN_KUBECTL kubectl get pods -n istio-system
Custom resources: TOOL: RUN_KUBECTL kubectl get crds | grep <name>

EXAMPLES (all follow same pattern):
User: "Check payments pod"
TOOL: LIST_ALL Pod

User: "Why is database crashing?"
TOOL: FIND_ISSUES

User: "Find Crossplane resources"
TOOL: RUN_KUBECTL kubectl get crds | grep crossplane

User: "Show Istio gateways"
TOOL: RUN_KUBECTL kubectl get gateway,virtualservice -A

User: "Logs for web-app in prod"
TOOL: LIST_ALL Pod

REMEMBER: For custom resources (Crossplane, Istio, etc), use RUN_KUBECTL with grep. Start with discovery.
`;

// Backward compatibility - map to optimized prompt
export const QUICK_MODE_SYSTEM_PROMPT = LLAMA_OPTIMIZED_SYSTEM;

// =============================================================================
// INVESTIGATION STATE MACHINE (Guides 8B through steps)
// =============================================================================

export type InvestigationStep = 'DISCOVERY' | 'INSPECT' | 'DIAGNOSE' | 'RESOLVE';

export interface StepConfig {
  allowedTools: string[];
  nextState: InvestigationStep | 'DONE';
  guidance: string;
}

export const INVESTIGATION_STATE_MACHINE: Record<InvestigationStep, StepConfig> = {
  DISCOVERY: {
    allowedTools: ['FIND_ISSUES', 'LIST_ALL'],
    nextState: 'INSPECT',
    guidance: 'Find the resource name first. Use: TOOL: LIST_ALL Pod or TOOL: FIND_ISSUES'
  },
  INSPECT: {
    allowedTools: ['DESCRIBE', 'LIST_ALL'],
    nextState: 'DIAGNOSE',
    guidance: 'Get resource details. Use: TOOL: DESCRIBE Pod namespace name'
  },
  DIAGNOSE: {
    allowedTools: ['GET_LOGS', 'RUN_KUBECTL'],
    nextState: 'RESOLVE',
    guidance: 'Check logs or events. Use: TOOL: GET_LOGS namespace podname'
  },
  RESOLVE: {
    allowedTools: ['RUN_KUBECTL', 'FIND_ISSUES'],
    nextState: 'DONE',
    guidance: 'Find root cause or solution'
  }
};

// =============================================================================
// CONTEXT PROMPT (Explicit vocabulary for 8B)
// =============================================================================

export const getContextPrompt = (healthSummary: ClusterHealthSummary) => `
CLUSTER STATUS:

Nodes:
- Total: ${healthSummary.total_nodes}
- Not Ready: ${healthSummary.not_ready_nodes.length}

Pods:
- Running: ${healthSummary.running_pods}
- Pending: ${healthSummary.pending_pods}
- Failed: ${healthSummary.failed_pods}

Resources:
- CPU Usage: ${healthSummary.cluster_cpu_percent.toFixed(0)}%
- Memory Usage: ${healthSummary.cluster_memory_percent.toFixed(0)}%

${healthSummary.critical_issues.length > 0 ? `CRITICAL ISSUES (showing top 3):
${healthSummary.critical_issues.slice(0, 3).map(i => `- ${i.resource_kind} in namespace ${i.namespace}, name ${i.resource_name}
  Issue: ${i.message}`).join('\n')}` : 'No critical issues detected.'}

${healthSummary.crashloop_pods.length > 0 ? `CRASHING PODS (showing top 3):
${healthSummary.crashloop_pods.slice(0, 3).map(p => `- Pod ${p.name} in namespace ${p.namespace}
  Restarts: ${p.restart_count}
  Reason: ${p.reason}`).join('\n')}` : 'No crash loops detected.'}

COMMON EXIT CODES:
- Code 0: Success
- Code 1: Application error - check logs
- Code 137: Out of Memory - increase memory limits
`;

// =============================================================================
// SYSTEM PROMPT (Simplified for 8B - backward compatible)
// =============================================================================

export const SYSTEM_PROMPT = LLAMA_OPTIMIZED_SYSTEM;

// =============================================================================
// CLAUDE CODE / TERMINAL PROMPT
// =============================================================================

export const CLAUDE_CODE_SYSTEM_PROMPT = `You are a Kubernetes SRE expert with terminal access.

### GUIDELINES
- **Explore**: Use 'kubectl get' and 'describe'.
- **Reason**: Analyze error messages deeply.
- **Safety**: READ-ONLY. No delete/apply.

### FORMAT
**Analysis**: [Brief analysis]
**Next Step**: [What you are going to do]
[Command to run]
`;

// =============================================================================
// ITERATIVE PROMPT (Continuation) - Simplified for 8B
// =============================================================================

export const ITERATIVE_SYSTEM_PROMPT = `You are a Kubernetes tool executor.

If last tool failed:
- "NotFound" error → Use: TOOL: LIST_ALL Pod
- "Empty" result → Try different resource: TOOL: FIND_ISSUES
- Still stuck → Use: TOOL: RUN_KUBECTL kubectl get pods -A

Always use real names from previous output.

OUTPUT FORMAT:
TOOL: NAME arguments
`;

// =============================================================================
// AUTONOMOUS INVESTIGATION PROMPT - Simplified for 8B
// =============================================================================

export const AUTONOMOUS_INVESTIGATION_PROMPT = `You are investigating a Kubernetes issue.

If you need more information:
TOOL: NAME arguments

When you know the answer:
ANSWER: [Direct answer]

ROOT CAUSE: [Technical reason]
`;

// =============================================================================
// DYNAMIC PROMPT BUILDERS
// =============================================================================

export function buildInvestigationPrompt(
  userQuery: string,
  state: InvestigationState,
  toolResults: string[],
  failedToolsContext: string,
  playbookGuidance: string,
): string {
  const stepsRemaining = state.maxIterations - state.iteration;
  const currentStep: InvestigationStep = (state as any).currentStep || 'DISCOVERY';
  const stepConfig = INVESTIGATION_STATE_MACHINE[currentStep];

  // Only include the LAST tool result to save context
  const lastResult = toolResults.length > 0 ? toolResults[toolResults.length - 1] : 'No previous results';

  // Compress history into one-line summary
  const historySummary = `Tools used so far: ${state.toolHistory.map(t => t.tool).join(' → ')}`;

  return `USER QUESTION: "${userQuery}"

INVESTIGATION PROGRESS:
${historySummary}
Steps remaining: ${stepsRemaining}

LAST TOOL OUTPUT:
${lastResult.slice(0, 1500)}
${lastResult.length > 1500 ? '... (truncated)' : ''}

${failedToolsContext ? `FAILED ATTEMPTS (do not retry):
${failedToolsContext}
` : ''}

CURRENT STEP: ${currentStep}
Allowed tools: ${stepConfig.allowedTools.join(', ')}
Guidance: ${stepConfig.guidance}

OUTPUT FORMAT:
TOOL: NAME arguments
`;
}

export function buildPlanPrompt(
  userQuery: string,
  healthSummary: ClusterHealthSummary,
  kbResults: string,
  playbookGuidance: string
): string {
  const context = getContextPrompt(healthSummary);
  return `USER REQUEST: "${userQuery}"

${context}

Create 3-step plan:
1. TOOL: FIND_ISSUES
2. TOOL: LIST_ALL Pod
3. TOOL: DESCRIBE Pod namespace name
`;
}

export function buildReflectionPrompt(
  userQuery: string,
  state: InvestigationState,
  toolResults: Array<{ toolName: string; content: string; timestamp?: number }>
): string {
  const lastResult = toolResults.length > 0 ? toolResults[toolResults.length - 1].content : 'None';

  return `You are investigating: "${userQuery}"

Last tool output:
${lastResult.slice(0, 800)}

Suggest next tool to get unstuck:
TOOL: NAME arguments
`;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getPlaybookGuidanceForQuery(
  userQuery: string,
  healthSummary: ClusterHealthSummary
): { guidance: string; playbook: Playbook | null } {
  const symptoms = extractSymptoms({
    crashloop_pods: healthSummary.crashloop_pods,
    unhealthy_deployments: healthSummary.unhealthy_deployments,
    critical_issues: healthSummary.critical_issues,
    warnings: healthSummary.warnings,
    pending_pods: healthSummary.pending_pods,
    failed_pods: healthSummary.failed_pods,
    not_ready_nodes: healthSummary.not_ready_nodes,
  });

  const playbook = matchPlaybook(userQuery, symptoms);
  if (playbook) {
    return { guidance: formatPlaybookGuidance(playbook), playbook };
  }
  return { guidance: '', playbook: null };
}

export function formatConfidenceDisplay(assessment: ConfidenceAssessment): string {
  const emoji = assessment.level === 'HIGH' ? '✅' :
    assessment.level === 'MEDIUM' ? '🔶' : '🔴';

  return `${emoji} **Confidence: ${assessment.level}** (${assessment.score}/100)
${assessment.explanation}`;
}

export function generateInvestigationSummary(state: InvestigationState): string {
  const confidence = calculateConfidence(state);
  const usefulTools = state.toolHistory.filter(t => t.useful).length;
  const failedTools = state.toolHistory.filter(t => t.status === 'error').length;
  const totalTime = Math.round((Date.now() - state.startTime) / 1000);
  const toolsUsed = [...new Set(state.toolHistory.map(t => t.tool))];

  return `
---
### Investigation Summary
- Duration: ${totalTime}s
- Iterations: ${state.iteration}/${state.maxIterations}
- Tools: ${state.toolHistory.length} (${usefulTools} useful, ${failedTools} failed)
- Confidence: ${confidence.level} (${confidence.score}/100)
- Used: ${toolsUsed.join(', ')}
---
`;
}

export function buildInitialAutonomousPrompt(
  userQuery: string,
  healthSummary: ClusterHealthSummary,
  preExecutedResults: string,
  kbResults: string,
  suggestedTools: string[],
  playbookGuidance: string,
): string {
  const context = getContextPrompt(healthSummary);

  return `USER REQUEST: "${userQuery}"

${context}

${preExecutedResults ? `PRE-CHECK RESULTS:
${preExecutedResults}
` : ''}

${playbookGuidance ? `GUIDANCE: ${playbookGuidance}
` : ''}

INSTRUCTIONS:
Start with discovery. Use FIND_ISSUES or LIST_ALL Pod.

OUTPUT FORMAT:
TOOL: NAME arguments
`;
}

// =============================================================================
// LLAMA 8B OPTIMIZATION HELPERS
// =============================================================================

/**
 * Enforce format from LLM response - extracts tool call even if buried in text
 */
export function enforceFormat(llmResponse: string): string {
  // Try to extract tool call with various patterns
  const patterns = [
    /TOOL:\s*(\w+)\s*(.*)/i,
    /^(\w+)\s+(.*)/m, // Just "TOOLNAME args" without TOOL: prefix
    /use\s+(\w+)\s+(.*)/i, // "use TOOLNAME args"
  ];

  for (const pattern of patterns) {
    const match = llmResponse.match(pattern);
    if (match) {
      const toolName = match[1].toUpperCase();
      const args = (match[2] || '').trim();

      // Validate it's a real tool
      if (LLAMA_CORE_TOOLS.includes(toolName as any) || Object.keys(TOOL_MAPPING).includes(toolName)) {
        return `TOOL: ${toolName} ${args}`.trim();
      }
    }
  }

  // Fallback: scan for any core tool name mentioned
  for (const tool of LLAMA_CORE_TOOLS) {
    if (llmResponse.toUpperCase().includes(tool)) {
      return `TOOL: ${tool}`;
    }
  }

  // Last resort: default to discovery
  return 'TOOL: FIND_ISSUES';
}

/**
 * Deterministic tool selection based on query keywords (no LLM needed)
 * Returns the exact TOOL command to use for common queries
 */
export function selectToolDeterministic(query: string, clusterHealth?: ClusterHealthSummary): string | null {
  const q = query.toLowerCase();

  // Rule-based selection - VERY SPECIFIC queries get deterministic commands

  // Crossplane-specific
  if (q.includes('crossplane')) {
    if (q.includes('install') || q.includes('version')) {
      return 'TOOL: RUN_KUBECTL kubectl get providers.pkg.crossplane.io -A';
    }
    if (q.includes('composite') || q.includes('claim')) {
      return 'TOOL: RUN_KUBECTL kubectl get composite,claim -A';
    }
    if (q.includes('managed')) {
      return 'TOOL: RUN_KUBECTL kubectl get managed -A';
    }
    // Generic crossplane query - find CRDs first
    return 'TOOL: RUN_KUBECTL kubectl get crds | grep -E "crossplane|composite|claim|managed"';
  }

  // Istio-specific
  if (q.includes('istio')) {
    if (q.includes('gateway')) {
      return 'TOOL: RUN_KUBECTL kubectl get gateway,virtualservice -A';
    }
    if (q.includes('mesh') || q.includes('sidecar')) {
      return 'TOOL: RUN_KUBECTL kubectl get pods -A -l istio-injection=enabled';
    }
    return 'TOOL: RUN_KUBECTL kubectl get pods -n istio-system';
  }

  // Crash/failure detection
  if (q.includes('crash') || q.includes('restart') || q.includes('fail')) {
    return 'TOOL: FIND_ISSUES';
  }

  // Logs - need pod name first
  if (q.includes('log') && !q.match(/\w+\/\w+/)) { // No namespace/pod pattern
    return 'TOOL: FIND_ISSUES'; // Will show failing pods
  }

  // Secrets
  if (q.includes('secret')) {
    return 'TOOL: LIST_ALL Secret';
  }

  // Deployments
  if (q.includes('deployment') || q.includes('deploy')) {
    return 'TOOL: LIST_ALL Deployment';
  }

  // Services
  if (q.includes('service') || q.includes('svc')) {
    return 'TOOL: LIST_ALL Service';
  }

  // Pods
  if (q.includes('pod') || q.includes('container')) {
    return 'TOOL: LIST_ALL Pod';
  }

  // Nodes
  if (q.includes('node')) {
    return 'TOOL: RUN_KUBECTL kubectl get nodes -o wide';
  }

  // Events
  if (q.includes('event')) {
    return 'TOOL: RUN_KUBECTL kubectl get events -A --sort-by=.lastTimestamp | tail -50';
  }

  // CRDs
  if (q.includes('crd') || q.includes('customresourcedefinition')) {
    // If asking for specific CRD, grep for it
    const match = q.match(/crd.*?(\w+)/);
    if (match && match[1]) {
      return `TOOL: RUN_KUBECTL kubectl get crds | grep -i ${match[1]}`;
    }
    return 'TOOL: RUN_KUBECTL kubectl get crds';
  }

  // Check cluster health for automatic detection
  if (clusterHealth) {
    if (clusterHealth.failed_pods > 0 || clusterHealth.crashloop_pods.length > 0) {
      return 'TOOL: FIND_ISSUES';
    }
  }

  // Return null to let LLM decide for non-obvious queries
  return null;
}

/**
 * Map complex tool to simple equivalent
 */
export function mapToolToSimple(toolName: string, toolArgs?: string): { tool: string; args: string } {
  const mapping = TOOL_MAPPING[toolName];

  if (mapping) {
    return {
      tool: mapping.replacement,
      args: mapping.args || toolArgs || ''
    };
  }

  return { tool: toolName, args: toolArgs || '' };
}

/**
 * Get next investigation step based on current state
 */
export function getNextInvestigationStep(
  currentStep: InvestigationStep,
  lastToolResult: string
): InvestigationStep | 'DONE' {
  const stepConfig = INVESTIGATION_STATE_MACHINE[currentStep];

  // Simple heuristics to advance or stay
  if (lastToolResult.includes('No') || lastToolResult.includes('not found')) {
    // Stay at current step if we didn't find anything useful
    return currentStep;
  }

  // Advance to next step
  return stepConfig.nextState;
}