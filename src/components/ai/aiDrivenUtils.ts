/**
 * AI-Driven Utilities - No Hardcoding!
 *
 * This module uses LLM reasoning to replace hardcoded patterns with intelligent,
 * context-aware decision making.
 */

import { invoke } from '@tauri-apps/api/core';
import { ToolOutcome } from './types';

// =============================================================================
// AI-DRIVEN ALTERNATIVE SUGGESTION
// =============================================================================

/**
 * Use the LLM to suggest alternative approaches when a tool fails
 * Instead of hardcoded TOOL_ALTERNATIVES dictionary
 */
export async function getAIDrivenAlternatives(
    failedTool: string,
    failedArgs: string | undefined,
    errorMessage: string,
    clusterContext: string,
    llmEndpoint: string,
    llmModel: string
): Promise<string[]> {
    const prompt = `You are a Kubernetes troubleshooting expert. A tool just failed:

FAILED TOOL: ${failedTool}
ARGUMENTS: ${failedArgs || 'none'}
ERROR: ${errorMessage}

CLUSTER CONTEXT:
${clusterContext}

Based on this failure, suggest 3-5 alternative investigation approaches.
Consider:
1. What information were we trying to gather?
2. What alternative tools could provide similar insights?
3. What's the broader investigation strategy?

Respond ONLY with a JSON array of tool suggestions, each as a string in format "TOOL_NAME args":
["TOOL1 arg1 arg2", "TOOL2 arg1", ...]

Focus on discovering actual resource names if the error was about placeholders.`;

    try {
        // Use existing call_llm command from ai_local module
        const response = await invoke<any>('call_llm', {
            provider: 'custom', // Generic provider
            endpoint: llmEndpoint,
            model: llmModel,
            messages: [{
                role: 'user',
                content: prompt
            }],
            temperature: 0.3
        });

        // Response is { content: string }
        const content = response.content || response;

        // Try to parse JSON from response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const suggestions = JSON.parse(jsonMatch[0]);
            if (Array.isArray(suggestions)) {
                return suggestions.slice(0, 5);
            }
        }

        return [];
    } catch (e) {
        console.error('[AI Alternatives] LLM call failed:', e);
        // Minimal fallback - just generic discovery tools
        return ['FIND_ISSUES', 'CLUSTER_HEALTH', 'LIST_ALL Pod'];
    }
}

// =============================================================================
// AI-DRIVEN COMMAND GENERATION
// =============================================================================

/**
 * Use LLM to generate investigation commands based on context
 * Instead of hardcoded pattern matching in generateFallbackCommands
 */
export async function generateAIDrivenCommands(
    investigationContext: string,
    clusterState: string,
    llmEndpoint: string,
    llmModel: string
): Promise<Array<{ command: string; purpose: string }>> {
    const prompt = `You are a Kubernetes expert. Generate kubectl commands for this investigation:

INVESTIGATION GOAL:
${investigationContext}

CURRENT CLUSTER STATE:
${clusterState}

Generate 3-6 kubectl commands that would help investigate this issue.
For each command, explain its purpose.

Respond ONLY with JSON array:
[
  {"command": "kubectl get pods -A --field-selector=status.phase!=Running", "purpose": "Find unhealthy pods"},
  ...
]`;

    try {
        const response = await invoke<any>('call_llm', {
            provider: 'custom',
            endpoint: llmEndpoint,
            model: llmModel,
            messages: [{
                role: 'user',
                content: prompt
            }],
            temperature: 0.3
        });

        const content = response.content || response;

        // Try to parse JSON array from response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const commands = JSON.parse(jsonMatch[0]);
            if (Array.isArray(commands)) {
                return commands.slice(0, 8);
            }
        }

        return [];
    } catch (e) {
        console.error('[AI Commands] LLM call failed:', e);
        // Minimal fallback
        return [
            { command: 'kubectl get pods -A --field-selector=status.phase!=Running', purpose: 'Find unhealthy pods' },
            { command: 'kubectl get events -A --sort-by=.lastTimestamp | tail -20', purpose: 'Recent events' }
        ];
    }
}

// =============================================================================
// AI-DRIVEN ERROR RECOVERY
// =============================================================================

/**
 * Ask the LLM how to recover from a specific error
 */
export async function getAIRecoveryStrategy(
    error: string,
    attemptedApproaches: string[],
    goalContext: string,
    llmEndpoint: string,
    llmModel: string
): Promise<{ nextSteps: string[]; reasoning: string }> {
    const prompt = `You are a Kubernetes troubleshooting expert helping with error recovery.

GOAL: ${goalContext}

ERROR ENCOUNTERED:
${error}

ALREADY TRIED (don't repeat these):
${attemptedApproaches.map((a, i) => `${i + 1}. ${a}`).join('\n')}

What should we try next? Provide:
1. Clear reasoning about why previous approaches failed
2. 2-4 new approaches to try

Respond with JSON:
{
  "reasoning": "explanation of what went wrong and why",
  "nextSteps": ["approach 1", "approach 2", ...]
}`;

    try {
        const response = await invoke<any>('call_llm', {
            provider: 'custom',
            endpoint: llmEndpoint,
            model: llmModel,
            messages: [{
                role: 'user',
                content: prompt
            }],
            temperature: 0.4
        });

        const content = response.content || response;

        // Try to parse JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const strategy = JSON.parse(jsonMatch[0]);
            return {
                reasoning: strategy.reasoning || 'No reasoning provided',
                nextSteps: Array.isArray(strategy.nextSteps) ? strategy.nextSteps : []
            };
        }

        return {
            reasoning: 'Could not parse recovery strategy',
            nextSteps: ['Try listing resources to discover actual names', 'Check cluster health overview']
        };
    } catch (e) {
        console.error('[AI Recovery] LLM call failed:', e);
        return {
            reasoning: 'LLM unavailable for recovery strategy',
            nextSteps: ['Try listing resources to discover actual names', 'Check cluster health overview']
        };
    }
}

// =============================================================================
// AI-DRIVEN CLUSTER DISCOVERY
// =============================================================================

/**
 * Dynamically discover cluster capabilities and configuration
 * Instead of assuming cluster setup
 */
export async function discoverClusterCapabilities(): Promise<{
    installedOperators: string[];
    availableCRDs: string[];
    specialNamespaces: string[];
    clusterType: string;
}> {
    try {
        // Discover CRDs
        const crds = await invoke<string>('run_kubectl_command', {
            command: 'kubectl get crd -o jsonpath=\'{.items[*].metadata.name}\''
        });

        const crdList = crds.split(' ').filter(Boolean);

        // Identify operators from CRDs
        const operators: Set<string> = new Set();
        for (const crd of crdList) {
            if (crd.includes('crossplane')) operators.add('crossplane');
            if (crd.includes('istio')) operators.add('istio');
            if (crd.includes('cert-manager')) operators.add('cert-manager');
            if (crd.includes('prometheus')) operators.add('prometheus');
            if (crd.includes('argo')) operators.add('argocd');
            if (crd.includes('flux')) operators.add('flux');
            if (crd.includes('uipath')) operators.add('uipath');
            if (crd.includes('cluster.x-k8s')) operators.add('cluster-api');
            if (crd.includes('castai')) operators.add('cast-ai');
        }

        // Discover special namespaces
        const namespaces = await invoke<string>('run_kubectl_command', {
            command: 'kubectl get ns -o jsonpath=\'{.items[*].metadata.name}\''
        });

        const nsList = namespaces.split(' ').filter(Boolean);
        const specialNs = nsList.filter(ns =>
            ns.includes('system') ||
            ns.includes('operator') ||
            ns.includes('istio') ||
            ns.includes('uipath') ||
            ns.includes('monitoring')
        );

        // Detect cluster type
        let clusterType = 'standard';
        if (operators.has('uipath')) clusterType = 'uipath-automation';
        else if (operators.has('cluster-api')) clusterType = 'managed-multi-cluster';
        else if (operators.has('istio')) clusterType = 'service-mesh';
        else if (operators.has('crossplane')) clusterType = 'infrastructure-control-plane';

        return {
            installedOperators: Array.from(operators),
            availableCRDs: crdList,
            specialNamespaces: specialNs,
            clusterType
        };

    } catch (e) {
        console.error('[Cluster Discovery] Failed:', e);
        return {
            installedOperators: [],
            availableCRDs: [],
            specialNamespaces: [],
            clusterType: 'unknown'
        };
    }
}

// =============================================================================
// AI-DRIVEN INVESTIGATION PLANNING
// =============================================================================

/**
 * Use LLM to create an investigation plan based on cluster state
 */
export async function createAIInvestigationPlan(
    userGoal: string,
    clusterCapabilities: Awaited<ReturnType<typeof discoverClusterCapabilities>>,
    llmEndpoint: string,
    llmModel: string
): Promise<Array<{ step: number; action: string; reasoning: string }>> {
    const prompt = `You are a Kubernetes expert creating an investigation plan.

USER GOAL: ${userGoal}

CLUSTER PROFILE:
- Type: ${clusterCapabilities.clusterType}
- Installed Operators: ${clusterCapabilities.installedOperators.join(', ') || 'None detected'}
- Special Namespaces: ${clusterCapabilities.specialNamespaces.join(', ') || 'Standard only'}
- Available CRDs: ${clusterCapabilities.availableCRDs.length} custom resources

Create a step-by-step investigation plan (4-8 steps) that:
1. Starts with broad health checks
2. Narrows down to specific problem areas
3. Uses appropriate tools for this cluster type
4. Considers installed operators and CRDs

Respond with JSON:
[
  {"step": 1, "action": "Check cluster health", "reasoning": "Get overview before diving deep"},
  {"step": 2, "action": "TOOL: FIND_ISSUES", "reasoning": "Discover unhealthy resources"},
  ...
]`;

    try {
        const response = await invoke<any>('call_llm', {
            provider: 'custom',
            endpoint: llmEndpoint,
            model: llmModel,
            messages: [{
                role: 'user',
                content: prompt
            }],
            temperature: 0.3
        });

        const content = response.content || response;

        // Try to parse JSON array from response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const plan = JSON.parse(jsonMatch[0]);
            if (Array.isArray(plan)) {
                return plan.slice(0, 10);
            }
        }

        return [];
    } catch (e) {
        console.error('[AI Plan] LLM call failed:', e);
        // Minimal fallback plan
        return [
            { step: 1, action: 'TOOL: CLUSTER_HEALTH', reasoning: 'Get cluster overview' },
            { step: 2, action: 'TOOL: FIND_ISSUES', reasoning: 'Identify problems' },
            { step: 3, action: 'TOOL: GET_EVENTS', reasoning: 'Check recent events' }
        ];
    }
}

// =============================================================================
// AI-DRIVEN TOOL ARGUMENT CORRECTION
// =============================================================================

/**
 * Use LLM to fix invalid tool arguments intelligently
 */
export async function aiCorrectToolArgs(
    toolName: string,
    invalidArgs: string,
    errorMessage: string,
    availableResources: string,
    llmEndpoint: string,
    llmModel: string
): Promise<{ corrected: boolean; newArgs: string; explanation: string }> {
    const prompt = `Fix invalid kubectl tool arguments.

TOOL: ${toolName}
INVALID ARGS: ${invalidArgs}
ERROR: ${errorMessage}

AVAILABLE RESOURCES IN CLUSTER:
${availableResources}

Provide corrected arguments using ACTUAL resource names from the list above.
If no exact match, suggest the closest match or a discovery command.

Respond with JSON:
{
  "corrected": true/false,
  "newArgs": "corrected arguments",
  "explanation": "why this correction makes sense"
}`;

    try {
        const response = await invoke<any>('call_llm', {
            provider: 'custom',
            endpoint: llmEndpoint,
            model: llmModel,
            messages: [{
                role: 'user',
                content: prompt
            }],
            temperature: 0.2
        });

        const content = response.content || response;

        // Try to parse JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const correction = JSON.parse(jsonMatch[0]);
            return {
                corrected: correction.corrected || false,
                newArgs: correction.newArgs || invalidArgs,
                explanation: correction.explanation || 'No explanation'
            };
        }

        return {
            corrected: false,
            newArgs: invalidArgs,
            explanation: 'Could not parse correction'
        };
    } catch (e) {
        console.error('[AI Correct Args] LLM call failed:', e);
        return {
            corrected: false,
            newArgs: invalidArgs,
            explanation: 'LLM unavailable for correction'
        };
    }
}

// =============================================================================
// LEARNING FROM INVESTIGATION OUTCOMES
// =============================================================================

/**
 * Store successful investigation patterns for future use
 */
export async function recordSuccessfulInvestigation(
    goal: string,
    toolSequence: ToolOutcome[],
    solution: string,
    clusterType: string
): Promise<void> {
    const learningRecord = {
        timestamp: new Date().toISOString(),
        cluster_type: clusterType,
        investigation_goal: goal,
        successful_path: toolSequence.map(t => ({
            tool: t.tool,
            args: t.args,
            outcome: t.status,
            useful: t.useful
        })),
        solution: solution,
        pattern_hash: hashInvestigationPattern(toolSequence)
    };

    try {
        // Store in local knowledge base for future RAG
        await invoke('store_investigation_pattern', { pattern: learningRecord });
        console.log('[Learning] Recorded successful investigation pattern');
    } catch (e) {
        console.error('[Learning] Failed to store pattern:', e);
    }
}

/**
 * Retrieve similar successful investigations from history
 */
export async function findSimilarInvestigations(
    currentGoal: string,
    clusterType: string
): Promise<Array<{ similarity: number; toolSequence: string[]; solution: string }>> {
    try {
        const similar = await invoke<any[]>('find_similar_investigations', {
            goal: currentGoal,
            clusterType: clusterType,
            limit: 3
        });

        return similar.map(inv => ({
            similarity: inv.similarity_score || 0,
            toolSequence: inv.tool_sequence || [],
            solution: inv.solution || ''
        }));
    } catch (e) {
        console.error('[Learning] Failed to find similar investigations:', e);
        return [];
    }
}

// =============================================================================
// HELPERS
// =============================================================================

function hashInvestigationPattern(sequence: ToolOutcome[]): string {
    // Create a simple hash of the tool sequence for pattern matching
    const pattern = sequence
        .filter(t => t.useful)
        .map(t => `${t.tool}:${t.status}`)
        .join('->');

    // Simple string hash (for pattern matching, not crypto)
    let hash = 0;
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
}

/**
 * Build cluster context string for LLM prompts
 */
export async function buildClusterContextString(): Promise<string> {
    try {
        const health = await invoke<any>('get_cluster_health_summary');
        const capabilities = await discoverClusterCapabilities();

        return `Cluster Health:
- Nodes: ${health.ready_nodes}/${health.total_nodes} ready
- Pods: ${health.running_pods}/${health.total_pods} running (${health.failed_pods} failed)
- Cluster Type: ${capabilities.clusterType}
- Installed Operators: ${capabilities.installedOperators.join(', ') || 'None'}
${health.critical_issues?.length > 0 ? `\n- Critical Issues: ${health.critical_issues.length}` : ''}`;
    } catch (e) {
        return 'Cluster context unavailable';
    }
}
