/**
 * Investigation Playbooks for Autonomous Agent
 *
 * These playbooks encode expert knowledge about debugging common
 * Kubernetes issues, providing structured investigation paths.
 */

import { Playbook as PlaybookType } from './types';

// Re-export Playbook type for convenience
export type Playbook = PlaybookType;

// =============================================================================
// TOOL ALTERNATIVES - What to try when a tool fails
// =============================================================================

export const TOOL_ALTERNATIVES: Record<string, string[]> = {
    'GET_LOGS': [
        'GET_EVENTS',           // Events often show crash reasons
        'DESCRIBE',             // Pod details including last state
        'RUN_KUBECTL get pod -o yaml',  // Full pod spec with status
    ],
    'DESCRIBE': [
        'LIST_ALL',             // Discover resources first
        'GET_EVENTS',           // Events for the namespace
        'RUN_KUBECTL get -o wide',  // Brief status
    ],
    'GET_EVENTS': [
        'DESCRIBE',             // Resource-specific events in describe
        'GET_LOGS',             // Application-level errors
        'CLUSTER_HEALTH',       // Cluster-wide issues
    ],
    'TOP_PODS': [
        'DESCRIBE',             // Check resource limits
        'GET_EVENTS',           // Resource pressure events
        'RUN_KUBECTL top nodes',  // Node-level metrics
        'CLUSTER_HEALTH',       // Overall resource usage
    ],
    'GET_ENDPOINTS': [
        'DESCRIBE Service',     // Check selector
        'LIST_ALL Pod',         // See what pods exist
        'GET_EVENTS',           // Endpoint controller events
    ],
    'LIST_FINALIZERS': [
        'GET_NAMESPACE',        // Namespace status
        'DESCRIBE',             // Resource details
        'RUN_KUBECTL get all',  // List all resources
    ],
    'GET_CROSSPLANE': [
        'RUN_KUBECTL get providers.pkg.crossplane.io',
        'RUN_KUBECTL get managed -A',
        'GET_EVENTS',
    ],
    'GET_ISTIO': [
        'RUN_KUBECTL get pods -n istio-system',
        'RUN_KUBECTL get gateway,virtualservice -A',
        'GET_EVENTS istio-system',
    ],
};

/** Get alternative tools when one fails */
export function getAlternatives(toolName: string, failedArgs?: string): string[] {
    const alternatives = TOOL_ALTERNATIVES[toolName] || [];

    // Add generic discovery tools if not already present
    const genericAlternatives = ['FIND_ISSUES', 'LIST_ALL', 'CLUSTER_HEALTH'];
    for (const generic of genericAlternatives) {
        if (!alternatives.includes(generic) && generic !== toolName) {
            alternatives.push(generic);
        }
    }

    return alternatives.slice(0, 4);
}

/** Generate helpful guidance when a tool fails */
export function getFailureGuidance(toolName: string, args: string | undefined, error: string): string {
    const alternatives = getAlternatives(toolName, args);

    const specificGuidance: Record<string, string> = {
        'DESCRIBE': `To describe a resource, first discover actual names:
→ Run: TOOL: LIST_ALL ${args?.split(' ')[0] || 'Pod'} to find valid resources
→ Then: TOOL: DESCRIBE <kind> <namespace> <actual-name>`,

        'GET_LOGS': `To get logs, first find actual pod names:
→ Run: TOOL: FIND_ISSUES to see unhealthy pods
→ Or: TOOL: LIST_ALL Pod to see all pods
→ Then: TOOL: GET_LOGS <namespace> <actual-pod-name>`,

        'GET_EVENTS': `To get events:
→ Run: TOOL: GET_EVENTS (no args) to see cluster-wide events
→ Or: TOOL: GET_EVENTS <namespace> for namespace events`,

        'GET_ENDPOINTS': `To check service endpoints:
→ First: TOOL: LIST_ALL Service to find service names
→ Then: TOOL: GET_ENDPOINTS <namespace> <service-name>
→ Or: TOOL: DESCRIBE Service <namespace> <name> to see selector`,
    };

    const guidance = specificGuidance[toolName] || '';
    const alternativesList = alternatives.map(a => `TOOL: ${a}`).join(', ');

    return `${error}

${guidance}

Alternative approaches: ${alternativesList}`;
}

// =============================================================================
// INVESTIGATION PLAYBOOKS
// =============================================================================

export const PLAYBOOKS: Record<string, Playbook> = {
    // -------------------------------------------------------------------------
    // POD NOT RUNNING
    // -------------------------------------------------------------------------
    podNotRunning: {
        name: 'Pod Not Running Investigation',
        symptoms: [
            'Pending', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull',
            'ContainerCreating', 'Init:', 'PodInitializing', 'Error',
            'crashloop', 'crashing', 'not starting', 'pod stuck',
        ],
        steps: [
            { tool: 'FIND_ISSUES', purpose: 'Survey all cluster problems to find affected pods' },
            { tool: 'DESCRIBE', target: 'Pod', purpose: 'Check pod status, events, and container states', dynamicArgs: true },
            { tool: 'GET_EVENTS', purpose: 'Look for scheduling, image pull, or resource events', dynamicArgs: true },
            { tool: 'GET_LOGS', args: '--previous', purpose: 'Check previous container logs for crash reason', dynamicArgs: true },
            { tool: 'TOP_PODS', purpose: 'Check resource pressure on the cluster' },
            { tool: 'SEARCH_KNOWLEDGE', args: 'crashloop oom exit code', purpose: 'Find similar issues in knowledge base' },
        ],
        commonCauses: [
            'Insufficient CPU or memory resources',
            'Image pull issues (wrong image name, missing registry credentials)',
            'Node selector or affinity rules not matching any nodes',
            'PersistentVolumeClaim not bound',
            'Init container failing',
            'Liveness/readiness probe configuration issues',
            'Application crash (check logs for stack trace)',
            'OOMKilled - container exceeding memory limit',
        ],
        priority: 10,
    },

    // -------------------------------------------------------------------------
    // SERVICE NOT WORKING
    // -------------------------------------------------------------------------
    serviceNotWorking: {
        name: 'Service Connectivity Investigation',
        symptoms: [
            'no endpoints', 'connection refused', '503', '504', 'timeout',
            'service not working', 'cannot connect', 'cannot reach',
            'service unreachable', 'no route', 'network issue',
        ],
        steps: [
            { tool: 'GET_ENDPOINTS', purpose: 'Check if service has healthy endpoints', dynamicArgs: true },
            { tool: 'DESCRIBE', target: 'Service', purpose: 'Verify selector matches pods', dynamicArgs: true },
            { tool: 'LIST_ALL', args: 'Pod', purpose: 'Find pods that should match selector' },
            { tool: 'DESCRIBE', target: 'Pod', purpose: 'Check pod readiness', dynamicArgs: true },
            { tool: 'GET_EVENTS', purpose: 'Look for endpoint controller events', dynamicArgs: true },
        ],
        commonCauses: [
            'Selector mismatch between service and pods',
            'Pods not ready (failing readiness probes)',
            'No pods matching selector in the namespace',
            'Wrong port configuration in service or pods',
            'NetworkPolicy blocking traffic',
            'Pod labels changed after service creation',
        ],
        priority: 9,
    },

    // -------------------------------------------------------------------------
    // RESOURCE STUCK IN TERMINATING
    // -------------------------------------------------------------------------
    terminatingStuck: {
        name: 'Terminating Resource Investigation',
        symptoms: [
            'Terminating', 'stuck', 'finalizer', 'cannot delete',
            'deletion stuck', 'namespace terminating', 'won\'t delete',
        ],
        steps: [
            { tool: 'GET_NAMESPACE', purpose: 'Check namespace status and conditions', dynamicArgs: true },
            { tool: 'LIST_FINALIZERS', purpose: 'Find resources with finalizers blocking deletion', dynamicArgs: true },
            { tool: 'DESCRIBE', target: 'Namespace', purpose: 'Get namespace details', dynamicArgs: true },
            { tool: 'GET_EVENTS', purpose: 'Look for controller errors', dynamicArgs: true },
            { tool: 'SEARCH_KNOWLEDGE', args: 'finalizer stuck deletion', purpose: 'Find remediation steps' },
        ],
        commonCauses: [
            'Finalizer controller not running',
            'Controller missing required credentials or permissions',
            'External resource (cloud) cannot be deleted',
            'Webhook preventing deletion',
            'CRD controller crashed or was removed',
            'Circular dependencies between resources',
        ],
        priority: 8,
    },

    // -------------------------------------------------------------------------
    // DEPLOYMENT ISSUES
    // -------------------------------------------------------------------------
    deploymentIssues: {
        name: 'Deployment Investigation',
        symptoms: [
            'deployment not ready', 'replicas not matching', 'scaling issue',
            'rollout stuck', 'deployment failing', 'pods not created',
            'desired replicas', 'available replicas',
        ],
        steps: [
            { tool: 'LIST_ALL', args: 'Deployment', purpose: 'List all deployments and their status' },
            { tool: 'DESCRIBE', target: 'Deployment', purpose: 'Check deployment conditions and events', dynamicArgs: true },
            { tool: 'LIST_ALL', args: 'ReplicaSet', purpose: 'Check ReplicaSet status' },
            { tool: 'LIST_ALL', args: 'Pod', purpose: 'Check pod status for this deployment' },
            { tool: 'GET_EVENTS', purpose: 'Look for deployment controller events', dynamicArgs: true },
        ],
        commonCauses: [
            'Insufficient cluster resources for new pods',
            'Image pull failures',
            'Container startup failures',
            'PodDisruptionBudget blocking rollout',
            'Readiness probe failing',
            'ResourceQuota exceeded',
        ],
        priority: 8,
    },

    // -------------------------------------------------------------------------
    // STORAGE ISSUES
    // -------------------------------------------------------------------------
    storageIssues: {
        name: 'Storage Investigation',
        symptoms: [
            'pvc pending', 'volume not bound', 'mount failed', 'storage issue',
            'cannot mount', 'disk full', 'PersistentVolumeClaim',
        ],
        steps: [
            { tool: 'LIST_ALL', args: 'PersistentVolumeClaim', purpose: 'List all PVCs and their status' },
            { tool: 'LIST_ALL', args: 'PersistentVolume', purpose: 'List available PVs' },
            { tool: 'DESCRIBE', target: 'PersistentVolumeClaim', purpose: 'Check PVC details', dynamicArgs: true },
            { tool: 'GET_EVENTS', purpose: 'Look for storage provisioner events', dynamicArgs: true },
            { tool: 'DESCRIBE', target: 'Pod', purpose: 'Check pod volume mount status', dynamicArgs: true },
        ],
        commonCauses: [
            'No matching PersistentVolume available',
            'StorageClass not configured or missing',
            'Storage provisioner not running',
            'Insufficient storage quota',
            'Volume already bound to another claim',
            'Access mode mismatch',
            'Node affinity preventing scheduling to node with volume',
        ],
        priority: 7,
    },

    // -------------------------------------------------------------------------
    // NODE ISSUES
    // -------------------------------------------------------------------------
    nodeIssues: {
        name: 'Node Investigation',
        symptoms: [
            'node not ready', 'node pressure', 'node cordoned', 'scheduling failed',
            'insufficient', 'taint', 'node unreachable', 'kubelet',
        ],
        steps: [
            { tool: 'CLUSTER_HEALTH', purpose: 'Get overall cluster and node status' },
            { tool: 'LIST_ALL', args: 'Node', purpose: 'List all nodes and their status' },
            { tool: 'DESCRIBE', target: 'Node', purpose: 'Check node conditions and capacity', dynamicArgs: true },
            { tool: 'GET_EVENTS', purpose: 'Look for node controller events' },
            { tool: 'TOP_PODS', purpose: 'Check resource usage across nodes' },
        ],
        commonCauses: [
            'Node disk pressure (ephemeral storage full)',
            'Node memory pressure',
            'Node PID pressure',
            'Kubelet not running or unhealthy',
            'Network connectivity issues',
            'Node cordoned for maintenance',
            'Taints preventing scheduling',
        ],
        priority: 9,
    },

    // -------------------------------------------------------------------------
    // CROSSPLANE / INFRASTRUCTURE
    // -------------------------------------------------------------------------
    crossplaneIssues: {
        name: 'Crossplane Investigation',
        symptoms: [
            'crossplane', 'provider', 'managed resource', 'composition',
            'claim not ready', 'infrastructure', 'cloud resource',
        ],
        steps: [
            { tool: 'GET_CROSSPLANE', purpose: 'Check Crossplane providers and managed resources' },
            { tool: 'RUN_KUBECTL', args: 'get providers.pkg.crossplane.io', purpose: 'List provider status' },
            { tool: 'RUN_KUBECTL', args: 'get managed -A', purpose: 'List all managed resources' },
            { tool: 'GET_EVENTS', args: 'crossplane-system', purpose: 'Check Crossplane events' },
            { tool: 'DESCRIBE', target: 'Provider', purpose: 'Check provider health', dynamicArgs: true },
        ],
        commonCauses: [
            'Provider credentials expired or invalid',
            'Provider not installed or healthy',
            'Cloud API rate limiting',
            'Resource already exists in cloud',
            'Insufficient cloud permissions',
            'Composition error',
        ],
        priority: 6,
    },

    // -------------------------------------------------------------------------
    // ISTIO / SERVICE MESH
    // -------------------------------------------------------------------------
    istioIssues: {
        name: 'Istio Investigation',
        symptoms: [
            'istio', 'sidecar', 'envoy', 'gateway', 'virtual service',
            'mesh', 'mtls', 'destination rule',
        ],
        steps: [
            { tool: 'GET_ISTIO', purpose: 'Check Istio status' },
            { tool: 'LIST_ALL', args: 'Pod', purpose: 'Check istio-system pods' },
            { tool: 'GET_EVENTS', args: 'istio-system', purpose: 'Check Istio events' },
            { tool: 'RUN_KUBECTL', args: 'get gateway,virtualservice -A', purpose: 'List Istio resources' },
            { tool: 'DESCRIBE', target: 'Pod', purpose: 'Check sidecar injection', dynamicArgs: true },
        ],
        commonCauses: [
            'Sidecar not injected (missing label)',
            'Istiod not running',
            'Gateway misconfiguration',
            'VirtualService routing error',
            'mTLS policy mismatch',
            'Certificate issues',
        ],
        priority: 6,
    },

    // -------------------------------------------------------------------------
    // UIPATH / VCLUSTER
    // -------------------------------------------------------------------------
    uipathIssues: {
        name: 'UiPath Investigation',
        symptoms: [
            'uipath', 'automation suite', 'customercluster', 'managementcluster',
            'vcluster', 'tenant', 'asfailed',
        ],
        steps: [
            { tool: 'GET_UIPATH_CRD', purpose: 'Check CustomerCluster and ManagementCluster status' },
            { tool: 'GET_UIPATH', purpose: 'Check UiPath pods' },
            { tool: 'LIST_ALL', args: 'Pod', purpose: 'List pods in uipath namespace' },
            { tool: 'GET_EVENTS', purpose: 'Check events in uipath namespaces' },
            { tool: 'VCLUSTER_CMD', purpose: 'Run commands inside vCluster', dynamicArgs: true },
        ],
        commonCauses: [
            'Automation Suite installation in progress',
            'Infrastructure provisioning failure',
            'vCluster not ready',
            'Certificate issues',
            'Resource constraints',
            'Dependency failure',
        ],
        priority: 7,
    },

    // -------------------------------------------------------------------------
    // GENERAL HEALTH CHECK
    // -------------------------------------------------------------------------
    generalHealth: {
        name: 'General Cluster Health',
        symptoms: [
            'health', 'status', 'overview', 'check', 'diagnose',
            'what\'s wrong', 'issues', 'problems',
        ],
        steps: [
            { tool: 'CLUSTER_HEALTH', purpose: 'Get overall cluster health summary' },
            { tool: 'FIND_ISSUES', purpose: 'Scan for all problems in the cluster' },
            { tool: 'GET_EVENTS', purpose: 'Get recent warning events' },
            { tool: 'LIST_ALL', args: 'Pod', purpose: 'Check pod status across cluster' },
            { tool: 'TOP_PODS', purpose: 'Check resource usage' },
        ],
        commonCauses: [
            'Resource exhaustion',
            'Application errors',
            'Configuration issues',
            'Networking problems',
            'External dependency failures',
        ],
        priority: 1, // Low priority - use as fallback
    },
};

// =============================================================================
// PLAYBOOK MATCHING
// =============================================================================

/**
 * Find the most relevant playbook for given symptoms
 */
export function matchPlaybook(
    userQuery: string,
    clusterSymptoms: string[]
): Playbook | null {
    const normalize = (text: string) => text.toLowerCase().trim();
    const queryLower = normalize(userQuery);
    const queryTokens = queryLower.split(/[^a-z0-9+/.-]+/).filter(t => t.length > 2);
    const clusterTokens = clusterSymptoms.map(s => normalize(s));

    const symptomMatches = (symptom: string): number => {
        const s = normalize(symptom);
        if (!s) return 0;

        // Strong match: direct cluster symptom overlap
        if (clusterTokens.some(c => c === s || c.includes(s) || s.includes(c))) return 4;

        // Medium: exact phrase appears in query
        if (queryLower.includes(s)) return 3;

        // Light: token overlap
        if (queryTokens.some(t => (t.length > 3 && (s.includes(t) || t.includes(s))))) return 2;

        return 0;
    };

    let bestMatch: Playbook | null = null;
    let bestScore = 0;

    for (const [name, playbook] of Object.entries(PLAYBOOKS)) {
        let score = 0;

        for (const symptom of playbook.symptoms) {
            score += symptomMatches(symptom);
        }

        // Apply priority weight
        score = score * (playbook.priority / 10);

        if (score > bestScore) {
            bestScore = score;
            bestMatch = playbook;
        }
    }

    // Require a meaningful match; otherwise, skip playbook guidance
    const MIN_SCORE = 3;
    if (bestScore < MIN_SCORE) return null;

    return bestMatch;
}

/**
 * Extract symptoms from cluster health summary
 */
export function extractSymptoms(healthSummary: {
    crashloop_pods: any[];
    unhealthy_deployments: any[];
    critical_issues: any[];
    warnings: any[];
    pending_pods: number;
    failed_pods: number;
    not_ready_nodes: string[];
}): string[] {
    const symptoms: string[] = [];

    if (healthSummary.crashloop_pods.length > 0) {
        symptoms.push('CrashLoopBackOff');
        symptoms.push('crashing');
    }

    if (healthSummary.pending_pods > 0) {
        symptoms.push('Pending');
        symptoms.push('scheduling');
    }

    if (healthSummary.failed_pods > 0) {
        symptoms.push('Failed');
        symptoms.push('Error');
    }

    if (healthSummary.not_ready_nodes.length > 0) {
        symptoms.push('node not ready');
    }

    if (healthSummary.unhealthy_deployments.length > 0) {
        symptoms.push('deployment not ready');
    }

    // Extract symptoms from critical issues
    for (const issue of healthSummary.critical_issues.slice(0, 10)) {
        if (issue.message) {
            const msg = issue.message.toLowerCase();
            if (msg.includes('imagepull')) symptoms.push('ImagePullBackOff');
            if (msg.includes('oom')) symptoms.push('OOMKilled');
            if (msg.includes('pending')) symptoms.push('Pending');
            if (msg.includes('terminating')) symptoms.push('Terminating');
        }
    }

    return [...new Set(symptoms)]; // Deduplicate
}

/**
 * Format playbook as guidance for the AI
 */
export function formatPlaybookGuidance(playbook: Playbook, currentStep: number = 0): string {
    const stepsList = playbook.steps
        .map((step, i) => {
            const marker = i === currentStep ? '→' : ' ';
            const args = step.args ? ` ${step.args}` : '';
            const dynamic = step.dynamicArgs ? ' (use actual names from previous results)' : '';
            return `${marker} ${i + 1}. TOOL: ${step.tool}${args}${dynamic} - ${step.purpose}`;
        })
        .join('\n');

    const causesList = playbook.commonCauses
        .slice(0, 5)
        .map(c => `  • ${c}`)
        .join('\n');

    return `
=== INVESTIGATION PLAYBOOK: ${playbook.name} ===

Steps to follow:
${stepsList}

Common root causes for this issue:
${causesList}

=== END PLAYBOOK ===
`;
}
