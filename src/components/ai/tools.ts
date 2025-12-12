
import { invoke } from '@tauri-apps/api/core';
import yaml from 'js-yaml';
import { ClusterHealthSummary, ClusterEventSummary, UnhealthyReport } from '../../types/ai';
import { ToolOutcome, ToolOutcomeStatus, evaluateToolOutcome, categorizeError, getRecoverySuggestions, ErrorCategory } from './types';


export const VALID_TOOLS = ['CLUSTER_HEALTH', 'GET_EVENTS', 'LIST_ALL', 'DESCRIBE', 'GET_LOGS', 'TOP_PODS', 'FIND_ISSUES', 'SEARCH_KNOWLEDGE', 'GET_ENDPOINTS', 'GET_NAMESPACE', 'LIST_FINALIZERS', 'GET_CROSSPLANE', 'GET_ISTIO', 'GET_WEBHOOKS', 'GET_UIPATH', 'RUN_KUBECTL', 'GET_CAPI', 'GET_CASTAI', 'VCLUSTER_CMD', 'GET_UIPATH_CRD', 'WEB_SEARCH', 'RUN_BASH', 'READ_FILE', 'FETCH_URL', 'SUGGEST_COMMANDS', 'DEEP_INSPECT', 'LIST_CRDS', 'GET_RESOURCE', 'GET_YAML'];

// =============================================================================
// ENHANCED PLACEHOLDER DETECTION
// =============================================================================

// Comprehensive placeholder patterns - catches more edge cases
const PLACEHOLDER_PATTERNS = [
    /\[[\w\s-]+\]/,           // [pod-name]
    /<[\w\s-]+>/,             // <pod-name>
    /\{[\w\s-]+\}/,           // {pod-name}
    /\{\{[\w\s-]+\}\}/,       // {{pod-name}}
    /\$\{[\w\s-]+\}/,         // ${pod-name}
    /\.\.\./,                 // ...
    /xxx+/i,                  // xxx
    /\bexample\b/i,           // example
    /\byour-/i,               // your-pod
    /\bmy-(?!sql)/i,          // my-deployment (but not mysql)
    /\bsample-/i,             // sample-app
    /\btest-(?!runner|suite|framework)/i,  // test- (but not test-runner which could be real)
    /"[\w\s-]+-name"/i,       // "pod-name" in quotes
    /'[\w\s-]+-name'/i,       // 'pod-name' in quotes
];

/** Check if text contains placeholder patterns */
export function containsPlaceholder(text: string): boolean {
    return PLACEHOLDER_PATTERNS.some(p => p.test(text));
}

// Common patterns that indicate the AI is confused about arguments
const BAD_ARG_PATTERNS = [
    /\b(retrieve|detailed|fetch|show|find)\b/i,  // Generic verbs used as names (NOT 'get' - valid in kubectl)
    /\b(the|to|from|for|with|and|or|in)\s/i,  // Prepositions followed by more text
    /\[.*?\]|<.*?>/,  // Placeholder brackets
    /^\s*$/,  // Empty
    /\{.*?\}/,  // Curly brace placeholders
    /\$\{.*?\}/,  // Variable placeholders
];

// Valid resource kinds that should NOT be rejected
const VALID_KINDS = ['pod', 'pods', 'deployment', 'deployments', 'service', 'services', 'node', 'nodes',
    'configmap', 'configmaps', 'secret', 'secrets', 'namespace', 'namespaces', 'ingress', 'ingresses',
    'statefulset', 'statefulsets', 'daemonset', 'daemonsets', 'job', 'jobs', 'cronjob', 'cronjobs',
    'pvc', 'persistentvolumeclaim', 'pv', 'persistentvolume', 'replicaset', 'replicasets'];

/**
 * Validate tool arguments - returns error message if invalid, null if OK
 */
export function validateToolArgs(toolName: string, args: string | undefined): string | null {
    if (!args) return null;

    // Skip validation for MCP tools and special tools
    if (isMcpTool(toolName) || ['SEARCH_KNOWLEDGE', 'RUN_KUBECTL', 'VCLUSTER_CMD', 'LIST_ALL'].includes(toolName)) return null;

    // Strict validation for DEEP_INSPECT to prevent placeholders
    if (toolName === 'DEEP_INSPECT') {
        if (containsPlaceholder(args)) {
            return `❌ Invalid format: Arguments contain placeholders like <...>. You MUST use real names.
Usage: DEEP_INSPECT <kind> <namespace> <name>
Example: DEEP_INSPECT Pod default my-pod-123
Step 1: Use 'RUN_KUBECTL kubectl get <kind> -A' to find the name.
Step 2: Use DEEP_INSPECT with the ACTUAL name.`;
        }
    }

    // For LIST_ALL, check if it's a valid kind
    if (toolName === 'LIST_ALL') {
        const kind = (args || '').trim().toLowerCase();
        if (!kind) {
            return `❌ ERROR: Missing argument. Usage: LIST_ALL [kind] (e.g. LIST_ALL Pod, LIST_ALL Service). Use 'kubectl api-resources' to find exact kind names.`;
        }
        if (VALID_KINDS.includes(kind)) return null;

        // Allow common CRDs but warn about unknown ones
        if (kind.includes('crossplane') || kind.includes('istio') || kind.includes('prometheus')) return null;

        return null; // Let other kinds pass, but we might want to be stricter later
    }

    for (const pattern of BAD_ARG_PATTERNS) {
        if (pattern.test(args)) {
            return `❌ Invalid argument "${args}" - appears to contain placeholder text. Use FIND_ISSUES or LIST_ALL first to discover actual resource names.`;
        }
    }
    return null;
}

export interface ToolResult {
    result: string;
    command: string;
}

// Web search result interface
interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

// Tool result cache to avoid redundant calls during investigation
interface CacheEntry {
    result: ToolResult;
    timestamp: number;
}
const toolCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30000; // 30 seconds

// Tools that should NOT be cached (always fresh)
const NO_CACHE_TOOLS = ['SEARCH_KNOWLEDGE', 'RUN_KUBECTL', 'VCLUSTER_CMD'];

// Mutating kubectl verbs that must be rejected in read-only mode
const MUTATING_KUBECTL_PATTERNS = [
    /\b(apply|patch|replace|delete|edit|scale|annotate|label|cordon|uncordon|drain|taint|untaint)\b/i,
    /\bcreate\b/i,
    /\brollout\s+(restart|undo)\b/i,
    /\bexpose\b/i,
    /\bexec\b/i,         // Blocks kubectl exec (arbitrary command execution in pods)
    /\bcp\b/i,           // Blocks kubectl cp (file transfer to/from pods)
    /\battach\b/i,       // Blocks kubectl attach (attach to running container)
    /\bport-forward\b/i, // Blocks kubectl port-forward (could be used for tunneling)
    /\bset\b/i,          // Blocks kubectl set (image, env, resources, etc.)
    /\brun\b/i,          // Blocks kubectl run (creates new pods)
];

// Clear expired cache entries periodically
function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, entry] of toolCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
            toolCache.delete(key);
        }
    }
}

// MCP Tool Handling
interface McpToolDef {
    name: string;
    server: string;
    original_name: string;
    input_schema: any;
    description?: string;
}

let mcpTools: Map<string, McpToolDef> = new Map();

export function registerMcpTools(tools: any[]) {
    mcpTools.clear();
    for (const t of tools) {
        if (t.name) {
            mcpTools.set(t.name, t);
        }
    }
    console.log(`[MCP] Registered ${mcpTools.size} tools`);
}

export function isMcpTool(name: string): boolean {
    return mcpTools.has(name);
}

export function listRegisteredMcpTools(): McpToolDef[] {
    return Array.from(mcpTools.values());
}

export function isValidTool(name: string): boolean {
    return VALID_TOOLS.includes(name) || isMcpTool(name);
}

// Export for testing/debugging
export function clearToolCache() {
    toolCache.clear();
}


export async function executeTool(toolName: string, toolArgs: string | undefined): Promise<ToolResult> {
    // Check cache first (for cacheable tools)
    const cacheKey = `${toolName}:${toolArgs || ''}`;
    if (!NO_CACHE_TOOLS.includes(toolName)) {
        const cached = toolCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            console.log(`[Cache HIT] ${toolName}`);
            return { ...cached.result, command: cached.result.command + ' (cached)' };
        }
    }

    let toolResult = '';
    let kubectlCommand = '';

    try {
        // Pre-validate arguments to catch bad patterns early
        const validationError = validateToolArgs(toolName, toolArgs);
        if (validationError) {
            return { result: validationError, command: 'Validation failed' };
        }

        // Enforce read-only guardrails for RUN_KUBECTL
        if (toolName === 'RUN_KUBECTL' && toolArgs) {
            const lower = toolArgs.toLowerCase();
            const isMutating = MUTATING_KUBECTL_PATTERNS.some(p => p.test(lower));
            if (isMutating) {
                return {
                    result: '❌ Rejected: RUN_KUBECTL may only execute read-only commands. Mutating verbs detected. Use DESCRIBE/GET/LOGS instead.',
                    command: 'Blocked mutating kubectl command',
                };
            }
        }

        if (isMcpTool(toolName)) {
            const toolDef = mcpTools.get(toolName);
            if (toolDef) {
                kubectlCommand = `mcp:${toolDef.server} ${toolDef.original_name} ${toolArgs || ''}`;
                let args: any = {};
                try {
                    if (toolArgs) {
                        // Try to parse as JSON first
                        if (toolArgs.trim().startsWith('{')) {
                            args = JSON.parse(toolArgs.trim());
                        } else {
                            // If simple string, map to the first property in schema
                            const props = toolDef.input_schema?.properties || {};
                            const keys = Object.keys(props);
                            if (keys.length > 0) {
                                args = { [keys[0]]: toolArgs.trim() };
                            }
                        }
                    }
                } catch (e) {
                    // If JSON parse fails, try to map to single prop
                    const props = toolDef.input_schema?.properties || {};
                    const keys = Object.keys(props);
                    if (keys.length > 0) {
                        args = { [keys[0]]: toolArgs?.trim() || "" };
                    }
                }

                const res = await invoke("call_mcp_tool", {
                    serverName: toolDef.server,
                    toolName: toolDef.original_name,
                    args
                });

                // Handle MCP response content
                // Expected: { content: [ { type: 'text', text: '...' }, ... ], isError: boolean }
                let output = "";
                if (typeof res === 'object' && res !== null) {
                    const anyRes = res as any;
                    if (anyRes.content && Array.isArray(anyRes.content)) {
                        output = anyRes.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
                    } else {
                        output = JSON.stringify(res, null, 2);
                    }

                    if (anyRes.isError) {
                        output = "❌ MCP Error:\n" + output;
                    }
                } else {
                    output = String(res);
                }

                toolResult = `## ${toolDef.original_name} Output\n${output}`;

                const result: ToolResult = { result: toolResult, command: kubectlCommand };
                return result;
            }
        }

        if (toolName === 'CLUSTER_HEALTH') {
            kubectlCommand = 'kubectl get nodes,pods --all-namespaces';
            const health = await invoke<ClusterHealthSummary>("get_cluster_health_summary");
            toolResult = `## Cluster Health Summary
      **Nodes:** ${health.ready_nodes}/${health.total_nodes} ready
      **Pods:** ${health.running_pods}/${health.total_pods} running (${health.pending_pods} pending, ${health.failed_pods} failed)
      **Deployments:** ${health.healthy_deployments}/${health.total_deployments} healthy
      **Resources:** CPU ${health.cluster_cpu_percent.toFixed(1)}%, Memory ${health.cluster_memory_percent.toFixed(1)}%
      ${health.critical_issues.length > 0 ? `\n**Critical Issues:** ${health.critical_issues.length}` : ''}
      ${health.warnings.length > 0 ? `\n**Warnings:** ${health.warnings.length}` : ''}`;
        } else if (toolName === 'GET_EVENTS') {
            const namespace = toolArgs || undefined;
            kubectlCommand = namespace ? `kubectl get events -n ${namespace}` : 'kubectl get events --all-namespaces';
            const events = await invoke<ClusterEventSummary[]>("get_cluster_events_summary", { namespace, limit: 100 });
            if (events.length === 0) {
                toolResult = 'No warning events found.';
            } else {
                toolResult = `## Recent Events (${events.length})\n${events.slice(0, 50).map(e =>
                    `- [${e.event_type}] ${e.namespace}/${e.name} (${e.kind}): ${e.reason} - ${e.message}${e.count > 1 ? ` (×${e.count})` : ''} ${e.last_seen ? `(${e.last_seen})` : ''}`
                ).join('\n')}`;
            }
        } else if (toolName === 'LIST_ALL' || toolName === 'LIST_PODS') {
            // Universal LIST_ALL - works with ANY resource type via kubectl
            if (!toolArgs) {
                return {
                    result: `❌ ERROR: Missing argument. Usage: LIST_ALL <kind> [flags]

Examples:
- LIST_ALL Pod
- LIST_ALL Deployment
- LIST_ALL Service
- LIST_ALL XRDatabase.crossplane.io
- LIST_ALL providers.pkg.crossplane.io
- LIST_ALL machines.cluster.x-k8s.io

To discover available resource types:
- RUN_KUBECTL kubectl api-resources
- RUN_KUBECTL kubectl api-resources | grep -i crossplane`,
                    command: 'LIST_ALL (missing args)'
                };
            }

            // Parse kind and optional flags
            const parts = toolArgs.trim().split(/\s+/);
            const kind = parts[0];
            const extraFlags = parts.slice(1).join(' ');

            kubectlCommand = `kubectl get ${kind} -A ${extraFlags} -o wide`;

            try {
                // Use kubectl directly - it handles any GVK including CRDs
                const output = await invoke<string>("run_kubectl_command", {
                    command: `kubectl get ${kind} -A ${extraFlags} -o wide 2>&1`
                });

                if (!output || output.includes('No resources found') || output.includes('error:')) {
                    // Try without -A for cluster-scoped resources
                    const clusterOutput = await invoke<string>("run_kubectl_command", {
                        command: `kubectl get ${kind} ${extraFlags} -o wide 2>&1`
                    }).catch(() => '');

                    if (clusterOutput && !clusterOutput.includes('error:')) {
                        toolResult = `## ${kind} (cluster-scoped)\n\`\`\`\n${clusterOutput}\n\`\`\``;
                    } else {
                        toolResult = `No ${kind} resources found.\n\nIf this is a CRD, verify it exists:\n\`kubectl api-resources | grep -i ${kind.split('.')[0]}\``;
                    }
                } else {
                    // Count resources
                    const lines = output.trim().split('\n');
                    const count = lines.length > 1 ? lines.length - 1 : 0; // Subtract header
                    toolResult = `## ${kind} List (${count} resources)\n\`\`\`\n${output}\n\`\`\``;
                }
            } catch (e) {
                toolResult = `❌ Error listing ${kind}: ${e}\n\nCheck if the resource type exists:\n\`kubectl api-resources | grep -i ${kind.split('.')[0]}\``;
            }
        } else if (toolName === 'DESCRIBE') {
            // Universal DESCRIBE - works with ANY resource type via kubectl
            const parts = (toolArgs || '').split(/\s+/);
            if (parts.length < 2) {
                toolResult = `⚠️ Usage: DESCRIBE <kind> <namespace> <name>
Or for cluster-scoped: DESCRIBE <kind> <name>

Examples:
- DESCRIBE Pod default nginx-abc
- DESCRIBE Deployment production api-server
- DESCRIBE Node worker-1
- DESCRIBE ClusterRole admin
- DESCRIBE XRDatabase.crossplane.io default my-db`;
            } else {
                // Handle both namespaced and cluster-scoped resources
                const kind = parts[0];
                let ns: string | null = null;
                let name: string;

                if (parts.length >= 3) {
                    ns = parts[1];
                    name = parts[2];
                } else {
                    // Cluster-scoped or namespace is the name
                    name = parts[1];
                }

                // Use kubectl describe directly - it handles GVK resolution automatically
                const nsFlag = ns ? `-n ${ns}` : '';
                kubectlCommand = `kubectl describe ${kind.toLowerCase()} ${nsFlag} ${name}`;

                try {
                    const output = await invoke<string>("run_kubectl_command", { command: kubectlCommand });
                    toolResult = `## ${kind}: ${ns ? ns + '/' : ''}${name}\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\``;
                } catch (e) {
                    // Fallback: try with full GVK if kubectl failed
                    toolResult = `❌ Resource not found or invalid kind: ${e}\n\nTry:\n- LIST_ALL ${kind} to find resources\n- Check the exact kind name with: RUN_KUBECTL kubectl api-resources | grep -i ${kind}`;
                }
            }
        } else if (toolName === 'DEEP_INSPECT') {
            // Universal DEEP_INSPECT - works with ANY resource type
            // Runs Describe + Logs (if pod/workload) + Events in parallel
            const parts = (toolArgs || '').split(/\s+/);
            if (parts.length < 2) {
                toolResult = `⚠️ Usage: DEEP_INSPECT <kind> <namespace> <name>
Or for cluster-scoped: DEEP_INSPECT <kind> <name>

Examples:
- DEEP_INSPECT Pod default nginx-abc
- DEEP_INSPECT Deployment production api-server
- DEEP_INSPECT XRDatabase.crossplane.io default my-db
- DEEP_INSPECT Node worker-1`;
            } else {
                const kind = parts[0];
                let ns: string | null = null;
                let name: string;

                if (parts.length >= 3) {
                    ns = parts[1];
                    name = parts[2];
                } else {
                    name = parts[1];
                }

                const nsFlag = ns ? `-n ${ns}` : '';
                kubectlCommand = `kubectl describe ${kind.toLowerCase()} ${nsFlag} ${name}`;

                // 1. Describe via kubectl (handles any GVK)
                const describePromise = invoke<string>("run_kubectl_command", {
                    command: `kubectl describe ${kind.toLowerCase()} ${nsFlag} ${name}`
                }).then(output => {
                    // Clean up verbose fields for LLM context
                    return output
                        .replace(/Managed Fields:[\s\S]*?(?=\n[A-Z]|\n$)/g, '')
                        .replace(/Last Applied Configuration:[\s\S]*?(?=\n[A-Z]|\n$)/g, '')
                        .slice(0, 4000);
                }).catch(e => `Error describing ${kind}: ${e}`);

                // 2. Logs (only for pod-like resources)
                const podLikeKinds = ['pod', 'deployment', 'replicaset', 'daemonset', 'statefulset', 'job'];
                const logsPromise = podLikeKinds.includes(kind.toLowerCase())
                    ? invoke<string>("run_kubectl_command", {
                        command: `kubectl logs ${nsFlag} ${name} --tail=100 2>&1 || echo "(No logs available)"`
                    }).catch(() => '(No logs available)')
                    : Promise.resolve(`(${kind} is not a workload - no logs)`);

                // 3. Events for this specific resource
                const eventsPromise = invoke<string>("run_kubectl_command", {
                    command: `kubectl get events ${nsFlag} --field-selector=involvedObject.name=${name} --sort-by=.lastTimestamp 2>&1 | tail -20`
                }).catch(() => 'No events found');

                const [desc, logs, events] = await Promise.all([describePromise, logsPromise, eventsPromise]);

                toolResult = `## DEEP INSPECT: ${kind} ${ns ? ns + '/' : ''}${name}

### 1. Resource Description
\`\`\`
${desc}
\`\`\`

### 2. Recent Events
\`\`\`
${events}
\`\`\`

### 3. Recent Logs
\`\`\`
${(logs as string).slice(-2000)}
\`\`\``;
            }
        } else if (toolName === 'GET_LOGS') {
            const parts = (toolArgs || '').split(/\s+/);
            const [ns, pod, container] = parts;
            if (!ns || !pod || ns.includes('[') || pod.includes('<')) {
                toolResult = '⚠️ Usage: GET_LOGS <namespace> <pod> [container] (NO PLACEHOLDERS)';
            } else {
                kubectlCommand = container ? `kubectl logs -n ${ns} ${pod} -c ${container}` : `kubectl logs -n ${ns} ${pod}`;
                const logs = await invoke<string>("get_pod_logs", { namespace: ns, name: pod, container: container || null, lines: 100 });
                toolResult = `## Logs: ${ns}/${pod}${container ? ` (${container})` : ''}\n\`\`\`\n${logs.slice(-2000)}\n\`\`\``;
            }
        } else if (toolName === 'TOP_PODS') {
            const topNs = toolArgs || undefined;
            kubectlCommand = topNs ? `kubectl top pods -n ${topNs}` : 'kubectl top pods --all-namespaces';
            try {
                const metrics = await invoke<any[]>("get_pod_metrics", { namespace: topNs || null });
                if (metrics.length === 0) {
                    toolResult = '⚠️ No pod metrics available. Ensure metrics-server is installed and running.';
                } else {
                    const sorted = metrics.sort((a, b) => (b.cpu_millicores || 0) - (a.cpu_millicores || 0));
                    toolResult = `## Pod Resource Usage (${metrics.length} pods)\n| Namespace | Pod | CPU | Memory |\n|-----------|-----|-----|--------|\n${sorted.slice(0, 30).map(m =>
                        `| ${m.namespace} | ${m.name} | ${m.cpu_millicores || 0}m | ${m.memory_mib || 0}Mi |`
                    ).join('\n')}`;
                }
            } catch {
                toolResult = '⚠️ Metrics API not available. Install metrics-server: kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml';
            }
        } else if (toolName === 'FIND_ISSUES') {
            kubectlCommand = 'custom-health-check';
            const report = await invoke<UnhealthyReport>("find_unhealthy_resources");
            if (report.issues.length === 0) {
                toolResult = '✅ No issues found in the cluster.';
            } else {
                const issues = report.issues.slice(0, 50);
                toolResult = `## Issues Found (${report.issues.length} total, showing ${issues.length})\n${issues.map(i =>
                    `- [${i.severity.toUpperCase()}] ${i.resource_kind} ${i.namespace}/${i.resource_name}: ${i.message}`
                ).join('\n')}${report.issues.length > 50 ? `\n... ${report.issues.length - 50} more issues` : ''}`;
            }
        } else if (toolName === 'SEARCH_KNOWLEDGE') {
            const query = toolArgs || '';
            if (!query) {
                toolResult = '⚠️ Usage: SEARCH_KNOWLEDGE <query>';
            } else {
                kubectlCommand = `knowledge-base search "${query}"`;
                interface KBResult {
                    file: string;
                    content: string;
                    score: number;
                    tags: string[];
                    category: string;
                    quick_fix?: string;
                    recommended_tools?: string[];
                }
                // Search knowledge base (uses keyword matching in Rust, or semantic search via Python agent)
                const results = await invoke<KBResult[]>("semantic_search_knowledge_base", { query });
                if (results.length === 0) {
                    toolResult = `📚 No knowledge base articles found for "${query}".`;
                } else {
                    toolResult = `## 📚 Knowledge Base Results for "${query}" (${results.length} matches)\n\n${results.map(r => {
                        const tagsStr = r.tags.length > 0 ? `\n**Tags:** ${r.tags.join(', ')}` : '';
                        const quickFix = r.quick_fix ? `\n\n⚡ **QUICK FIX:** ${r.quick_fix}` : '';
                        const recTools = r.recommended_tools ? `\n\n🔧 **Recommended Tools:** ${r.recommended_tools.join(', ')}` : '';
                        return `### ${r.file}\n**Category:** ${r.category} | **Relevance:** ${r.score.toFixed(1)}${tagsStr}${quickFix}${recTools}\n\n${r.content}`;
                    }).join('\n\n---\n\n')}`;
                }
            }
        } else if (toolName === 'GET_ENDPOINTS') {
            const [ns, svc] = (toolArgs || '').split(/\s+/);
            if (!ns || !svc) {
                toolResult = '⚠️ Usage: GET_ENDPOINTS <namespace> <service>';
            } else {
                kubectlCommand = `kubectl get endpoints -n ${ns} ${svc} -o yaml`;
                try {
                    const details = await invoke<string>("get_resource_details", {
                        req: { group: "", version: "v1", kind: "Endpoints", namespace: ns },
                        name: svc
                    });
                    // Backend returns YAML, parse it
                    const parsed = yaml.load(details) as any;
                    const subsets = parsed.subsets || [];
                    if (subsets.length === 0) {
                        toolResult = `## Endpoints: ${ns}/${svc}\n⚠️ **No endpoints found!** This means no pods match the service selector.\n\nCheck:\n- Service selector matches pod labels\n- Pods are in Running state\n- Pods pass readiness probes`;
                    } else {
                        const addresses = subsets.flatMap((s: any) => (s.addresses || []).map((a: any) => `${a.ip} (${a.targetRef?.name || 'unknown'})`));
                        const notReady = subsets.flatMap((s: any) => (s.notReadyAddresses || []).map((a: any) => `${a.ip} (${a.targetRef?.name || 'unknown'})`));
                        const ports = subsets.flatMap((s: any) => (s.ports || []).map((p: any) => `${p.port}/${p.protocol}`));
                        toolResult = `## Endpoints: ${ns}/${svc}\n**Ready:** ${addresses.length > 0 ? addresses.join(', ') : 'None'}\n**Not Ready:** ${notReady.length > 0 ? notReady.join(', ') : 'None'}\n**Ports:** ${ports.join(', ') || 'None'}`;
                    }
                } catch {
                    toolResult = `⚠️ Endpoints not found for service ${ns}/${svc}. Check if the service exists.`;
                }
            }
        } else if (toolName === 'GET_NAMESPACE') {
            const nsName = toolArgs?.trim();
            if (!nsName) {
                toolResult = '⚠️ Usage: GET_NAMESPACE <namespace-name>';
            } else {
                kubectlCommand = `kubectl get namespace ${nsName} -o yaml`;
                try {
                    const details = await invoke<string>("get_resource_details", {
                        req: { group: "", version: "v1", kind: "Namespace", namespace: null },
                        name: nsName
                    });
                    // Backend returns YAML, parse it
                    const parsed = yaml.load(details) as any;
                    const phase = parsed.status?.phase || 'Unknown';
                    const conditions = parsed.status?.conditions || [];
                    const finalizers = parsed.spec?.finalizers || [];
                    const deletionTimestamp = parsed.metadata?.deletionTimestamp;

                    let result = `## Namespace: ${nsName}\n**Phase:** ${phase}`;
                    if (deletionTimestamp) {
                        result += `\n**Deletion Requested:** ${deletionTimestamp}`;
                    }
                    if (finalizers.length > 0) {
                        result += `\n**Finalizers:** ${finalizers.join(', ')}`;
                    }
                    if (conditions.length > 0) {
                        result += `\n\n### Conditions:\n`;
                        for (const c of conditions) {
                            result += `- **${c.type}:** ${c.status} - ${c.reason}\n  ${c.message}\n`;
                        }
                    }
                    if (phase === 'Terminating') {
                        result += `\n\n### ⚠️ Namespace Stuck in Terminating\nThis namespace has a deletion timestamp but cannot be deleted. Check:\n1. Resources with finalizers blocking deletion\n2. Use LIST_FINALIZERS ${nsName} to find stuck resources`;
                    }
                    toolResult = result;
                } catch (e) {
                    toolResult = `⚠️ Namespace "${nsName}" not found or error: ${e}`;
                }
            }
        } else if (toolName === 'LIST_FINALIZERS') {
            const nsName = toolArgs?.trim();
            if (!nsName) {
                toolResult = '⚠️ Usage: LIST_FINALIZERS <namespace>';
            } else {
                kubectlCommand = `kubectl api-resources --verbs=list -o name | xargs -n 1 kubectl get -n ${nsName} --show-kind --ignore-not-found -o jsonpath='{range .items[?(@.metadata.finalizers)]}{.kind}/{.metadata.name}: {.metadata.finalizers}{"\\n"}{end}'`;
                try {
                    // Get resources with finalizers in this namespace
                    const resources = await invoke<any[]>("list_resources_with_finalizers", { namespace: nsName });
                    if (resources.length === 0) {
                        toolResult = `## Finalizers in ${nsName}\n✅ No resources with finalizers found.`;
                    } else {
                        let result = `## Resources with Finalizers in ${nsName} (${resources.length})\n`;
                        for (const r of resources) {
                            const hasDeletionTs = r.deletion_timestamp ? '🔴 DELETING' : '';
                            result += `\n### ${r.kind}/${r.name} ${hasDeletionTs}\n`;
                            result += `**Finalizers:** ${r.finalizers.join(', ')}\n`;
                            if (r.deletion_timestamp) {
                                result += `**Deletion Requested:** ${r.deletion_timestamp}\n`;
                                result += `⚠️ This resource is stuck! The finalizer controller may be:\n`;
                                result += `- Not running (check if the operator/controller exists)\n`;
                                result += `- Missing credentials (check secrets referenced by the controller)\n`;
                                result += `- Unable to reach external service (Azure, AWS, etc.)\n`;
                            }
                        }
                        toolResult = result;
                    }
                } catch (e) {
                    toolResult = `❌ Error listing finalizers: ${e}`;
                }
            }
        } else if (toolName === 'GET_CROSSPLANE') {
            kubectlCommand = 'kubectl get managed,composite,claim -A';
            try {
                // Get Crossplane providers
                const providers = await invoke<any[]>("list_all_resources", { kind: "Provider" }).catch(() => []);
                // Get managed resources
                const managed = await invoke<any[]>("list_all_resources", { kind: "Managed" }).catch(() => []);

                let result = `## Crossplane Status\n`;

                if (providers.length > 0) {
                    result += `\n### Providers (${providers.length})\n`;
                    for (const p of providers.slice(0, 10)) {
                        result += `- ${p.name}: ${p.status}\n`;
                    }
                } else {
                    result += `\n⚠️ No Crossplane providers found. Crossplane may not be installed.\n`;
                }

                if (managed.length > 0) {
                    result += `\n### Managed Resources (${managed.length})\n`;
                    const unhealthy = managed.filter(m => m.status !== 'Ready' && m.status !== 'True');
                    if (unhealthy.length > 0) {
                        result += `⚠️ ${unhealthy.length} unhealthy:\n`;
                        for (const m of unhealthy.slice(0, 10)) {
                            result += `- ${m.namespace || 'cluster'}/${m.name}: ${m.status}\n`;
                        }
                    } else {
                        result += `✅ All managed resources healthy\n`;
                    }
                }
                toolResult = result;
            } catch (e) {
                toolResult = `❌ Error checking Crossplane: ${e}. Crossplane may not be installed.`;
            }
        } else if (toolName === 'GET_ISTIO') {
            kubectlCommand = 'kubectl get gateway,virtualservice,destinationrule -A';
            try {
                // Get Istio resources
                const gateways = await invoke<any[]>("list_all_resources", { kind: "Gateway" }).catch(() => []);
                const virtualServices = await invoke<any[]>("list_all_resources", { kind: "VirtualService" }).catch(() => []);
                const istioPods = await invoke<any[]>("list_all_resources", { kind: "Pod" }).catch(() => []);
                const istioSystemPods = istioPods.filter(p => p.namespace === 'istio-system');

                let result = `## Istio Status\n`;

                if (istioSystemPods.length > 0) {
                    const unhealthy = istioSystemPods.filter(p => p.status !== 'Running');
                    result += `\n### Istio System Pods (${istioSystemPods.length})\n`;
                    if (unhealthy.length > 0) {
                        result += `⚠️ ${unhealthy.length} unhealthy pods:\n`;
                        for (const p of unhealthy) {
                            result += `- ${p.name}: ${p.status}\n`;
                        }
                    } else {
                        result += `✅ All istio-system pods healthy\n`;
                    }
                } else {
                    result += `\n⚠️ No pods in istio-system. Istio may not be installed.\n`;
                }

                if (gateways.length > 0) {
                    result += `\n### Gateways (${gateways.length})\n`;
                    for (const g of gateways.slice(0, 5)) {
                        result += `- ${g.namespace}/${g.name}\n`;
                    }
                }

                if (virtualServices.length > 0) {
                    result += `\n### VirtualServices (${virtualServices.length})\n`;
                    for (const vs of virtualServices.slice(0, 5)) {
                        result += `- ${vs.namespace}/${vs.name}\n`;
                    }
                }

                toolResult = result;
            } catch (e) {
                toolResult = `❌ Error checking Istio: ${e}`;
            }
        } else if (toolName === 'GET_WEBHOOKS') {
            kubectlCommand = 'kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations';
            try {
                const validating = await invoke<any[]>("list_all_resources", { kind: "ValidatingWebhookConfiguration" }).catch(() => []);
                const mutating = await invoke<any[]>("list_all_resources", { kind: "MutatingWebhookConfiguration" }).catch(() => []);

                let result = `## Admission Webhooks\n`;
                result += `\n### Validating Webhooks (${validating.length})\n`;
                for (const w of validating.slice(0, 10)) {
                    result += `- ${w.name}\n`;
                }

                result += `\n### Mutating Webhooks (${mutating.length})\n`;
                for (const w of mutating.slice(0, 10)) {
                    result += `- ${w.name}\n`;
                }

                if (validating.length + mutating.length === 0) {
                    result += `\n⚠️ No admission webhooks found.\n`;
                }
                toolResult = result;
            } catch (e) {
                toolResult = `❌ Error checking webhooks: ${e}`;
            }
        } else if (toolName === 'GET_UIPATH') {
            const namespace = toolArgs?.trim() || 'uipath';
            kubectlCommand = `kubectl get pods -n ${namespace}`;
            try {
                const pods = await invoke<any[]>("list_all_resources", { kind: "Pod" }).catch(() => []);
                const uipathPods = pods.filter(p =>
                    p.namespace === namespace ||
                    p.namespace === 'automation-suite' ||
                    p.namespace?.includes('uipath')
                );

                let result = `## UiPath Automation Suite Status\n`;

                if (uipathPods.length === 0) {
                    result += `\n⚠️ No UiPath pods found in ${namespace} namespace.\n`;
                    result += `Try: GET_UIPATH uipath-infra or GET_UIPATH automation-suite\n`;
                } else {
                    const byStatus: Record<string, any[]> = {};
                    for (const p of uipathPods) {
                        if (!byStatus[p.status]) byStatus[p.status] = [];
                        byStatus[p.status].push(p);
                    }

                    result += `\n### Pods by Status (${uipathPods.length} total)\n`;
                    for (const [status, pods] of Object.entries(byStatus)) {
                        const emoji = status === 'Running' ? '✅' : '⚠️';
                        result += `${emoji} **${status}:** ${pods.length}\n`;
                        if (status !== 'Running') {
                            for (const p of pods.slice(0, 5)) {
                                result += `  - ${p.name}\n`;
                            }
                        }
                    }
                }
                toolResult = result;
            } catch (e) {
                toolResult = `❌ Error checking UiPath: ${e}`;
            }
        } else if (toolName === 'RUN_KUBECTL') {
            // Power tool: run arbitrary kubectl command with bash piping
            let cmd = toolArgs?.trim();
            if (!cmd) {
                toolResult = '⚠️ Usage: RUN_KUBECTL <kubectl command>\nExamples:\n- RUN_KUBECTL kubectl get pods -A | grep -i error\n- RUN_KUBECTL kubectl get events --sort-by=.lastTimestamp | head -20\n- RUN_KUBECTL kubectl get pods -o wide | awk \'{print $1, $7}\'';
            } else {
                // Fix: Strip potential markdown code blocks or brackets if the AI hallucinates them
                cmd = cmd.replace(/^`+|`+$/g, '').replace(/^\[|\]$/g, '').trim();

                // Ensure it starts with kubectl
                const fullCmd = cmd.startsWith('kubectl ') ? cmd : `kubectl ${cmd}`;

                // Guard: Prevent "group/version/kind" syntax (2 slashes) in 'get' commands which causes kubectl error
                // Example failure: kubectl get crossplane.io/v1alpha1/Composites
                if (/\bget\b/.test(fullCmd)) {
                    const invalidArgs = fullCmd.match(/\s([^\s/]+\/[^\s/]+\/[^\s/]+)/);
                    if (invalidArgs) {
                        return {
                            result: `❌ Syntax Error: Invalid resource format "${invalidArgs[1]}".\nkubectl get does NOT support "group/version/kind" format (too many slashes).\n\nCORRECT FORMAT: kubectl get <kind>.<group>\n\nexample:\n❌ kubectl get crossplane.io/v1alpha1/Composites\n✅ kubectl get Composites.crossplane.io`,
                            command: fullCmd
                        };
                    }
                }

                kubectlCommand = fullCmd;
                try {
                    const output = await invoke<string>("run_kubectl_command", { command: fullCmd });
                    toolResult = `## kubectl Output\n\`\`\`\n${fullCmd}\n\`\`\`\n\n\`\`\`\n${output}\n\`\`\``;
                } catch (e) {
                    toolResult = `❌ Command failed: ${e}`;
                }
            }
        } else if (toolName === 'GET_CAPI') {
            kubectlCommand = 'kubectl get clusters.cluster.x-k8s.io,machines,machinedeployments -A';
            try {
                const output = await invoke<string>("run_kubectl_command", {
                    command: "kubectl get clusters.cluster.x-k8s.io,machines.cluster.x-k8s.io,machinedeployments.cluster.x-k8s.io -A 2>/dev/null || echo 'Cluster API not installed'"
                });
                toolResult = `## Cluster API (CAPI) Status\n\`\`\`\n${output}\n\`\`\``;
            } catch (e) {
                toolResult = `❌ Error checking CAPI: ${e}`;
            }
        } else if (toolName === 'GET_CASTAI') {
            kubectlCommand = 'kubectl get autoscalers.castai.upbound.io,nodeconfigurations.castai.upbound.io -A';
            try {
                const output = await invoke<string>("run_kubectl_command", {
                    command: "kubectl get autoscalers.castai.upbound.io,nodeconfigurations.castai.upbound.io,rebalancingjobs.castai.upbound.io,hibernationschedules.castai.upbound.io -A 2>/dev/null || echo 'CAST AI not installed'"
                });
                toolResult = `## CAST AI Status\n\`\`\`\n${output}\n\`\`\``;
            } catch (e) {
                toolResult = `❌ Error checking CAST AI: ${e}`;
            }
        } else if (toolName === 'VCLUSTER_CMD') {
            // Run kubectl inside a vCluster
            const args = toolArgs?.trim() || '';
            const parts = args.split(/\s+/);
            if (parts.length < 3) {
                toolResult = '⚠️ Usage: VCLUSTER_CMD <namespace> <vcluster-name> <kubectl command>\nExample: VCLUSTER_CMD estest management-cluster get pods -A';
            } else {
                const ns = parts[0];
                const vcName = parts[1];
                const kubectlArgs = parts.slice(2).join(' ');
                const cmdWithPrefix = kubectlArgs.startsWith('kubectl ') ? kubectlArgs : `kubectl ${kubectlArgs}`;
                kubectlCommand = `vcluster connect ${vcName} -n ${ns} -- ${cmdWithPrefix}`;
                try {
                    const output = await invoke<string>("run_kubectl_command", {
                        command: `vcluster connect ${vcName} -n ${ns} -- ${cmdWithPrefix}`
                    });
                    toolResult = `## vCluster ${ns}/${vcName} Output\n\`\`\`\n${output}\n\`\`\``;
                } catch (e) {
                    toolResult = `❌ vCluster command failed: ${e}`;
                }
            }
        } else if (toolName === 'GET_UIPATH_CRD') {
            kubectlCommand = 'kubectl get customerclusters.dedicated.uipath.com,managementclusters.dedicated.uipath.com -A';
            try {
                const output = await invoke<string>("run_kubectl_command", {
                    command: "kubectl get customerclusters.dedicated.uipath.com,managementclusters.dedicated.uipath.com -A 2>/dev/null || echo 'UiPath CRDs not found'"
                });
                toolResult = `## UiPath Custom Resources\n\`\`\`\n${output}\n\`\`\`\n\n**States:** ASFailed=AS failed, InfraInProgress=provisioning, ManagementClusterReady=ready`;
            } catch (e) {
                toolResult = `❌ Error checking UiPath CRDs: ${e}`;
            }
        } else if (toolName === 'WEB_SEARCH') {
            // Web search tool for looking up Kubernetes issues, docs, Stack Overflow, etc.
            const query = toolArgs?.trim();
            if (!query) {
                toolResult = '⚠️ Usage: WEB_SEARCH <search query>\nExamples:\n- WEB_SEARCH kubernetes pod crashloopbackoff exit code 137\n- WEB_SEARCH istio gateway 503 service unavailable';
            } else {
                kubectlCommand = `web-search "${query}"`;
                try {
                    const results = await invoke<WebSearchResult[]>("web_search", { query });
                    if (results.length === 0) {
                        toolResult = `🔍 No web results found for "${query}".`;
                    } else {
                        toolResult = `## 🌐 Web Search Results for "${query}"\n\n${results.slice(0, 5).map((r, i) =>
                            `### ${i + 1}. ${r.title}\n**URL:** ${r.url}\n${r.snippet}\n`
                        ).join('\n---\n\n')}`;
                    }
                } catch (e) {
                    // Fallback: search via knowledge base if web search fails
                    toolResult = `⚠️ Web search unavailable (${e}). Try SEARCH_KNOWLEDGE "${query}" instead.`;
                }
            }
        } else if (toolName === 'RUN_BASH') {
            // Safe bash command execution (read-only, allowlisted commands)
            const cmd = toolArgs?.trim();
            if (!cmd) {
                toolResult = '⚠️ Usage: RUN_BASH <command>\nExamples:\n- RUN_BASH kubectl get pods -A | grep -i error\n- RUN_BASH helm list -A\n- RUN_BASH jq ".items[].metadata.name" pods.json';
            } else {
                kubectlCommand = `bash: ${cmd}`;
                try {
                    const output = await invoke<string>("run_safe_bash", { command: cmd });
                    toolResult = `## 🖥️ Bash Output\n\`\`\`\n${cmd}\n\`\`\`\n\n\`\`\`\n${output}\n\`\`\``;
                } catch (e) {
                    toolResult = `❌ Bash command failed: ${e}`;
                }
            }
        } else if (toolName === 'READ_FILE') {
            // Read local file (YAML manifests, configs, etc.)
            const filePath = toolArgs?.trim();
            if (!filePath) {
                toolResult = '⚠️ Usage: READ_FILE <path>\nExamples:\n- READ_FILE ./deployment.yaml\n- READ_FILE /etc/kubernetes/manifests/kube-apiserver.yaml';
            } else {
                kubectlCommand = `read: ${filePath}`;
                try {
                    const content = await invoke<string>("read_local_file", { path: filePath });
                    // Detect file type for syntax highlighting
                    const ext = filePath.split('.').pop()?.toLowerCase() || '';
                    const lang = ['yaml', 'yml'].includes(ext) ? 'yaml' :
                        ['json'].includes(ext) ? 'json' :
                            ['sh', 'bash'].includes(ext) ? 'bash' : '';
                    toolResult = `## 📄 File: ${filePath}\n\`\`\`${lang}\n${content}\n\`\`\``;
                } catch (e) {
                    toolResult = `❌ Cannot read file: ${e}`;
                }
            }
        } else if (toolName === 'FETCH_URL') {
            // Fetch content from URL (documentation, APIs, etc.)
            const url = toolArgs?.trim();
            if (!url) {
                toolResult = '⚠️ Usage: FETCH_URL <url>\nExamples:\n- FETCH_URL https://kubernetes.io/docs/concepts/workloads/pods/\n- FETCH_URL https://raw.githubusercontent.com/kubernetes/examples/master/guestbook/all-in-one/guestbook-all-in-one.yaml';
            } else {
                kubectlCommand = `fetch: ${url}`;
                try {
                    const content = await invoke<string>("fetch_url_content", { url });
                    // Detect content type
                    const isYaml = url.endsWith('.yaml') || url.endsWith('.yml');
                    const isJson = url.endsWith('.json');
                    const lang = isYaml ? 'yaml' : isJson ? 'json' : '';
                    toolResult = `## 🌐 Fetched: ${url}\n\`\`\`${lang}\n${content}\n\`\`\``;
                } catch (e) {
                    toolResult = `❌ Cannot fetch URL: ${e}`;
                }
            }
        } else if (toolName === 'SUGGEST_COMMANDS') {
            // AI-powered command generation - uses LLM to generate investigation commands
            const context = toolArgs?.trim();
            if (!context) {
                toolResult = '⚠️ Usage: SUGGEST_COMMANDS <issue description or context>\nExamples:\n- SUGGEST_COMMANDS pod crashloop in monitoring namespace\n- SUGGEST_COMMANDS investigate slow api response times\n- SUGGEST_COMMANDS check network connectivity between services';
            } else {
                kubectlCommand = `ai-suggest: ${context}`;
                try {
                    const suggestions = await invoke<string[]>("generate_investigation_commands", { context });
                    if (suggestions.length === 0) {
                        toolResult = `🔍 No specific commands suggested for: "${context}". Try using FIND_ISSUES or GET_EVENTS to gather more context.`;
                    } else {
                        toolResult = `## 🤖 AI-Generated Investigation Commands

Based on: "${context}"

The following kubectl commands are suggested for investigation:

${suggestions.map((cmd, i) => `### ${i + 1}. ${cmd.split('|')[0].trim()}
\`\`\`bash
${cmd.split('|')[1]?.trim() || cmd}
\`\`\`
${cmd.split('|')[2] ? `*Purpose: ${cmd.split('|')[2].trim()}*` : ''}
`).join('\n')}

💡 **To execute any command**, use:
\`TOOL: RUN_KUBECTL <command>\` or \`TOOL: RUN_BASH <command>\``;
                    }
                } catch (e) {
                    // Fallback: provide generic suggestions based on context keywords
                    const suggestions = generateFallbackCommands(context);
                    toolResult = `## 🔧 Suggested Investigation Commands

Based on: "${context}"

${suggestions.map((cmd, i) => `${i + 1}. \`${cmd}\``).join('\n')}

💡 Use \`TOOL: RUN_KUBECTL <command>\` to execute.`;
                }
            }
        } else if (toolName === 'LIST_CRDS') {
            // Discover available CRDs and API resources
            const filter = toolArgs?.trim() || '';
            kubectlCommand = `kubectl api-resources ${filter ? `| grep -i ${filter}` : ''}`;

            try {
                let output: string;
                if (filter) {
                    // Filter by keyword (e.g., "crossplane", "istio", "cert-manager")
                    output = await invoke<string>("run_kubectl_command", {
                        command: `kubectl api-resources --verbs=list -o wide 2>&1 | grep -iE "${filter}"`
                    });
                } else {
                    // Show all API resources grouped by API group
                    output = await invoke<string>("run_kubectl_command", {
                        command: `kubectl api-resources --verbs=list -o wide 2>&1 | head -100`
                    });
                }

                if (!output.trim()) {
                    toolResult = `No API resources found matching "${filter}".\n\nTry broader terms like:\n- crossplane, istio, cert-manager\n- argo, flux, keda\n- cluster, machine, provider`;
                } else {
                    toolResult = `## Available API Resources ${filter ? `(matching: ${filter})` : ''}\n\`\`\`\n${output}\n\`\`\`\n\nUse these with LIST_ALL <kind> or DESCRIBE <kind> <ns> <name>`;
                }
            } catch (e) {
                toolResult = `❌ Error listing API resources: ${e}`;
            }

        } else if (toolName === 'GET_RESOURCE') {
            // Universal GET with fuzzy/regex matching
            // Syntax: GET_RESOURCE <kind> [namespace] [name-pattern]
            const parts = (toolArgs || '').split(/\s+/);
            if (parts.length < 1 || !parts[0]) {
                toolResult = `⚠️ Usage: GET_RESOURCE <kind> [namespace] [name-pattern]

Examples:
- GET_RESOURCE Pod default web.*     (regex match)
- GET_RESOURCE Deployment -A api     (all namespaces, name contains 'api')
- GET_RESOURCE Service kube-system   (all services in kube-system)
- GET_RESOURCE Node .*worker.*       (nodes matching 'worker')

The name-pattern supports:
- Exact: my-pod-abc
- Contains: api (matches api-server, backend-api, etc.)
- Regex: web-.* (matches web-frontend, web-backend, etc.)`;
            } else {
                const kind = parts[0];
                let ns = '';
                let pattern = '';

                if (parts.length === 2) {
                    // Could be namespace or pattern
                    if (parts[1] === '-A' || parts[1].includes('.') || parts[1].includes('*')) {
                        ns = '-A';
                        pattern = parts[1] === '-A' ? '' : parts[1];
                    } else {
                        ns = `-n ${parts[1]}`;
                    }
                } else if (parts.length >= 3) {
                    ns = parts[1] === '-A' ? '-A' : `-n ${parts[1]}`;
                    pattern = parts[2];
                }

                // Use kubectl with grep for pattern matching
                const grepPart = pattern ? `| grep -iE "${pattern}"` : '';
                kubectlCommand = `kubectl get ${kind} ${ns} -o wide ${grepPart}`;

                try {
                    const output = await invoke<string>("run_kubectl_command", {
                        command: `kubectl get ${kind} ${ns || '-A'} -o wide 2>&1 ${grepPart}`
                    });

                    if (!output.trim() || output.includes('No resources found')) {
                        // If nothing found with pattern, show all and suggest
                        const allResources = await invoke<string>("run_kubectl_command", {
                            command: `kubectl get ${kind} ${ns || '-A'} --no-headers -o custom-columns=':metadata.namespace,:metadata.name' 2>&1 | head -20`
                        }).catch(() => '');

                        toolResult = `No ${kind} found matching pattern "${pattern}".\n\n**Available ${kind}s:**\n\`\`\`\n${allResources || 'None found'}\n\`\`\``;
                    } else {
                        const lines = output.trim().split('\n');
                        const count = lines.length > 1 ? lines.length - 1 : 0;
                        toolResult = `## ${kind} ${pattern ? `(matching: ${pattern})` : ''} - ${count} found\n\`\`\`\n${output}\n\`\`\``;
                    }
                } catch (e) {
                    toolResult = `❌ Error: ${e}`;
                }
            }

        } else if (toolName === 'GET_YAML') {
            // Get resource as YAML (useful for seeing full spec)
            const parts = (toolArgs || '').split(/\s+/);
            if (parts.length < 2) {
                toolResult = `⚠️ Usage: GET_YAML <kind> [namespace] <name>

Examples:
- GET_YAML Pod default nginx-abc
- GET_YAML Deployment production api-server
- GET_YAML ClusterRole admin
- GET_YAML XRDatabase.crossplane.io default my-db`;
            } else {
                const kind = parts[0];
                let ns = '';
                let name = '';

                if (parts.length === 2) {
                    name = parts[1];
                } else {
                    ns = `-n ${parts[1]}`;
                    name = parts[2];
                }

                kubectlCommand = `kubectl get ${kind} ${ns} ${name} -o yaml`;

                try {
                    const output = await invoke<string>("run_kubectl_command", {
                        command: `kubectl get ${kind} ${ns} ${name} -o yaml 2>&1`
                    });

                    // Clean up verbose fields
                    const cleanedOutput = output
                        .replace(/managedFields:[\s\S]*?(?=\n\w)/g, '')
                        .replace(/kubectl\.kubernetes\.io\/last-applied-configuration:[\s\S]*?(?=\n\s{2}\w)/g, '')
                        .slice(0, 6000);

                    toolResult = `## ${kind} ${ns} ${name} (YAML)\n\`\`\`yaml\n${cleanedOutput}\n\`\`\``;
                } catch (e) {
                    toolResult = `❌ Resource not found: ${e}`;
                }
            }

        } else {
            // Only if called with unknown tool
            toolResult = `⚠️ Invalid tool: ${toolName}. Valid tools: ${VALID_TOOLS.join(', ')}`;
        }
    } catch (err) {
        toolResult = `❌ Tool error: ${err}`;
    }

    // Store in cache (for successful, cacheable results)
    const result: ToolResult = { result: toolResult, command: kubectlCommand };
    if (!NO_CACHE_TOOLS.includes(toolName) && !toolResult.startsWith('❌') && !toolResult.startsWith('⚠️')) {
        toolCache.set(cacheKey, { result, timestamp: Date.now() });
        cleanExpiredCache(); // Cleanup old entries
    }

    return result;
}

// Normalize Kubernetes resource kind - handle plurals and case
const normalizeKind = (kind: string): string => {
    // Common plural to singular mappings
    const pluralMap: Record<string, string> = {
        'pods': 'Pod',
        'services': 'Service',
        'deployments': 'Deployment',
        'replicasets': 'ReplicaSet',
        'statefulsets': 'StatefulSet',
        'daemonsets': 'DaemonSet',
        'jobs': 'Job',
        'cronjobs': 'CronJob',
        'configmaps': 'ConfigMap',
        'secrets': 'Secret',
        'persistentvolumeclaims': 'PersistentVolumeClaim',
        'persistentvolumes': 'PersistentVolume',
        'pvcs': 'PersistentVolumeClaim',
        'pvs': 'PersistentVolume',
        'nodes': 'Node',
        'namespaces': 'Namespace',
        'ingresses': 'Ingress',
        'endpoints': 'Endpoints',
        'events': 'Event',
        'serviceaccounts': 'ServiceAccount',
        'roles': 'Role',
        'rolebindings': 'RoleBinding',
        'clusterroles': 'ClusterRole',
        'clusterrolebindings': 'ClusterRoleBinding',
        'networkpolicies': 'NetworkPolicy',
        'horizontalpodautoscalers': 'HorizontalPodAutoscaler',
        'hpas': 'HorizontalPodAutoscaler',
    };

    const lower = kind.toLowerCase();

    // Check plural map first
    if (pluralMap[lower]) {
        return pluralMap[lower];
    }

    // Handle common abbreviations
    const abbrevMap: Record<string, string> = {
        'svc': 'Service',
        'deploy': 'Deployment',
        'rs': 'ReplicaSet',
        'sts': 'StatefulSet',
        'ds': 'DaemonSet',
        'cm': 'ConfigMap',
        'pvc': 'PersistentVolumeClaim',
        'pv': 'PersistentVolume',
        'ns': 'Namespace',
        'ing': 'Ingress',
        'ep': 'Endpoints',
        'sa': 'ServiceAccount',
        'hpa': 'HorizontalPodAutoscaler',
        'netpol': 'NetworkPolicy',
    };

    if (abbrevMap[lower]) {
        return abbrevMap[lower];
    }

    // Capitalize first letter for standard kinds
    return kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
};

// Helper to sanitize tool arguments - remove markdown formatting
export const sanitizeToolArgs = (args: string | undefined): string | undefined => {
    if (!args) return args;
    return args
        .replace(/\*\*/g, '')  // Remove bold **
        .replace(/\*/g, '')    // Remove italic *
        .replace(/`/g, '')     // Remove code backticks
        .replace(/_/g, ' ')    // Replace underscores with spaces
        .replace(/\s+/g, ' ')  // Normalize whitespace
        .trim();
};

// =============================================================================
// ENHANCED TOOL EXECUTION WITH OUTCOME TRACKING
// =============================================================================

export interface ExecuteToolWithTrackingResult {
    result: ToolResult;
    outcome: ToolOutcome;
    errorCategory?: ErrorCategory;
    recoverySuggestions?: string[];
}

/**
 * Execute a tool and return both the result and outcome tracking info.
 * This is used by the autonomous investigation loop.
 */
export async function executeToolWithTracking(
    toolName: string,
    toolArgs: string | undefined
): Promise<ExecuteToolWithTrackingResult> {
    const startTime = Date.now();

    // Execute the tool
    const result = await executeTool(toolName, toolArgs);

    // Evaluate the outcome
    const { status, useful } = evaluateToolOutcome(result.result, toolName);

    // Build outcome record
    const outcome: ToolOutcome = {
        tool: toolName,
        args: toolArgs,
        result: result.result,
        status,
        timestamp: startTime,
        useful,
    };

    let errorCategory: ErrorCategory | undefined;
    let recoverySuggestions: string[] | undefined;

    // If error, categorize and include alternatives
    if (status === 'error' || status === 'empty') {
        outcome.alternatives = getAlternatives(toolName, toolArgs);
        outcome.errorMessage = result.result.split('\n')[0]; // First line of error

        // Categorize the error for better recovery
        errorCategory = categorizeError(result.result);
        recoverySuggestions = getRecoverySuggestions(errorCategory, toolName);
    }

    return { result, outcome, errorCategory, recoverySuggestions };
}

/**
 * Execute multiple tools in parallel with concurrency limit
 */
export async function executeToolsBatch(
    tools: Array<{ toolName: string; args: string | undefined }>,
    maxConcurrency: number = 3
): Promise<ExecuteToolWithTrackingResult[]> {
    const results: ExecuteToolWithTrackingResult[] = [];

    // Process in batches to limit concurrency
    for (let i = 0; i < tools.length; i += maxConcurrency) {
        const batch = tools.slice(i, i + maxConcurrency);
        const batchResults = await Promise.all(
            batch.map(tool => executeToolWithTracking(tool.toolName, tool.args))
        );
        results.push(...batchResults);
    }

    return results;
}

/**
 * Get specific guidance for placeholder errors
 */
export function getPlaceholderGuidance(toolName: string, invalidArgs: string): string {
    const resourceKind = invalidArgs.split(/\s+/)[0] || 'Pod';

    const guidance: Record<string, string> = {
        'DESCRIBE': `To describe a specific resource, first discover actual names:
→ TOOL: LIST_ALL ${resourceKind}
→ Then use: TOOL: DESCRIBE ${resourceKind} <namespace> <actual-name>`,

        'GET_LOGS': `To get logs, first find actual pod names:
→ TOOL: FIND_ISSUES (shows unhealthy pods)
→ TOOL: LIST_ALL Pod
→ Then use: TOOL: GET_LOGS <namespace> <actual-pod-name>`,

        'GET_ENDPOINTS': `To check service endpoints, first find service names:
→ TOOL: LIST_ALL Service
→ Then use: TOOL: GET_ENDPOINTS <namespace> <actual-service-name>`,

        'GET_NAMESPACE': `To check namespace status:
→ TOOL: CLUSTER_HEALTH (shows namespaces with issues)
→ Then use: TOOL: GET_NAMESPACE <actual-namespace-name>`,

        'LIST_FINALIZERS': `To find stuck finalizers:
→ TOOL: FIND_ISSUES (shows terminating resources)
→ Then use: TOOL: LIST_FINALIZERS <actual-namespace-name>`,

        'VCLUSTER_CMD': `To run commands in a vCluster, first find vCluster names:
→ TOOL: GET_UIPATH_CRD (shows CustomerClusters)
→ Then use: TOOL: VCLUSTER_CMD <namespace> <vcluster-name> <kubectl command>`,
    };

    return guidance[toolName] || `Run TOOL: LIST_ALL ${resourceKind} to discover actual resource names first.`;
}

/**
 * Format failed tools context for LLM feedback loop
 */
export function formatFailedToolsContext(failedOutcomes: ToolOutcome[]): string {
    if (failedOutcomes.length === 0) return '';

    const entries = failedOutcomes.map(o => {
        const alternatives = o.alternatives?.slice(0, 3).join(', ') || 'FIND_ISSUES, LIST_ALL';
        return `❌ ${o.tool}(${o.args || 'no args'}): ${o.errorMessage || 'Failed'}
   💡 Alternatives: ${alternatives}`;
    });

    return `
=== FAILED APPROACHES (DO NOT RETRY) ===
${entries.join('\n\n')}
=== END FAILED APPROACHES ===
`;
}

/**
 * Check if a tool+args combination should be auto-corrected
 * Returns the corrected args or null if no correction possible
 */
export function autoCorrectToolArgs(
    toolName: string,
    toolArgs: string | undefined
): { corrected: boolean; newArgs: string | undefined; message?: string } {
    if (!toolArgs) return { corrected: false, newArgs: toolArgs };

    // Check for placeholder patterns
    if (!containsPlaceholder(toolArgs)) {
        return { corrected: false, newArgs: toolArgs };
    }

    // Tools that can work without args (list all)
    const listTools = ['GET_EVENTS', 'TOP_PODS', 'FIND_ISSUES', 'CLUSTER_HEALTH'];
    if (listTools.includes(toolName)) {
        return {
            corrected: true,
            newArgs: undefined,
            message: 'Cleared placeholder args - will list all',
        };
    }

    // LIST_ALL - keep just the resource kind
    if (toolName === 'LIST_ALL') {
        const parts = toolArgs.split(/\s+/);
        const kind = parts[0];
        // Check if kind itself is a placeholder
        if (containsPlaceholder(kind)) {
            return {
                corrected: true,
                newArgs: 'Pod', // Default to Pod
                message: 'Defaulted to listing Pods',
            };
        }
        return {
            corrected: true,
            newArgs: kind,
            message: `Cleared placeholder - listing all ${kind}`,
        };
    }

    // Can't auto-correct - requires actual names
    return {
        corrected: false,
        newArgs: toolArgs,
        message: getPlaceholderGuidance(toolName, toolArgs),
    };
}

// =============================================================================
// FALLBACK COMMAND GENERATION (when LLM backend unavailable)
// =============================================================================

/**
 * Generate fallback investigation commands based on context keywords
 * Used when LLM-based command generation fails
 */
function generateFallbackCommands(context: string): string[] {
    const lower = context.toLowerCase();
    const commands: string[] = [];

    // Crash/restart related
    if (lower.includes('crash') || lower.includes('restart') || lower.includes('loop') || lower.includes('backoff')) {
        commands.push('kubectl get pods -A --field-selector=status.phase!=Running');
        commands.push('kubectl get events -A --sort-by=.lastTimestamp | grep -iE "kill|oom|crash|backoff" | tail -20');
        commands.push('kubectl get pods -A -o json | jq \'.items[] | select(.status.containerStatuses[]?.restartCount > 3) | {name:.metadata.name, ns:.metadata.namespace, restarts:.status.containerStatuses[].restartCount}\'');
    }

    // Memory/OOM related
    if (lower.includes('memory') || lower.includes('oom') || lower.includes('137')) {
        commands.push('kubectl top pods -A --sort-by=memory | head -20');
        commands.push('kubectl get events -A | grep -i oom');
        commands.push('kubectl get pods -A -o json | jq \'.items[] | select(.status.containerStatuses[]?.lastState.terminated.exitCode == 137) | .metadata.name\'');
    }

    // CPU/throttling related
    if (lower.includes('cpu') || lower.includes('throttl') || lower.includes('slow')) {
        commands.push('kubectl top pods -A --sort-by=cpu | head -20');
        commands.push('kubectl get pods -A -o json | jq \'.items[] | {name:.metadata.name, ns:.metadata.namespace, cpu:.spec.containers[].resources.limits.cpu}\'');
    }

    // Pending pods
    if (lower.includes('pending') || lower.includes('schedule') || lower.includes('unschedulable')) {
        commands.push('kubectl get pods -A --field-selector=status.phase=Pending');
        commands.push('kubectl get events -A | grep -iE "insufficient|unschedulable|taint|affinity"');
        commands.push('kubectl describe nodes | grep -A5 "Allocated resources"');
    }

    // Network/connectivity
    if (lower.includes('network') || lower.includes('connect') || lower.includes('dns') || lower.includes('service')) {
        commands.push('kubectl get endpoints -A | grep -v "none"');
        commands.push('kubectl get networkpolicies -A');
        commands.push('kubectl get svc -A -o wide');
    }

    // Storage/volume
    if (lower.includes('storage') || lower.includes('volume') || lower.includes('pvc') || lower.includes('mount')) {
        commands.push('kubectl get pvc -A');
        commands.push('kubectl get pv');
        commands.push('kubectl get events -A | grep -iE "volume|mount|attach"');
    }

    // Node issues
    if (lower.includes('node') || lower.includes('kubelet') || lower.includes('ready')) {
        commands.push('kubectl get nodes -o wide');
        commands.push('kubectl describe nodes | grep -A10 "Conditions:"');
        commands.push('kubectl top nodes');
    }

    // Deployment/scaling
    if (lower.includes('deploy') || lower.includes('replica') || lower.includes('scale')) {
        commands.push('kubectl get deployments -A');
        commands.push('kubectl get rs -A | grep -v "0         0         0"');
        commands.push('kubectl get hpa -A');
    }

    // Secrets/config
    if (lower.includes('secret') || lower.includes('config') || lower.includes('env')) {
        commands.push('kubectl get secrets -A --field-selector=type=Opaque | head -20');
        commands.push('kubectl get configmaps -A | head -20');
    }

    // Generic investigation if no specific patterns matched
    if (commands.length === 0) {
        commands.push('kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded');
        commands.push('kubectl get events -A --sort-by=.lastTimestamp | grep -iE "error|fail|warn" | tail -30');
        commands.push('kubectl top pods -A | head -15');
        commands.push('kubectl get nodes -o wide');
    }

    return commands.slice(0, 6); // Return at most 6 commands
}

// =============================================================================
// TOOL ALTERNATIVES - What to try when a tool fails
// =============================================================================

const TOOL_ALTERNATIVES: Record<string, string[]> = {
    'GET_LOGS': [
        'GET_EVENTS',
        'DESCRIBE',
        'RUN_KUBECTL get pod -o yaml',
    ],
    'DESCRIBE': [
        'LIST_ALL',
        'GET_EVENTS',
        'RUN_KUBECTL get -o wide',
    ],
    'GET_EVENTS': [
        'DESCRIBE',
        'GET_LOGS',
        'CLUSTER_HEALTH',
    ],
    'TOP_PODS': [
        'DESCRIBE',
        'GET_EVENTS',
        'RUN_KUBECTL top nodes',
        'CLUSTER_HEALTH',
    ],
    'GET_ENDPOINTS': [
        'DESCRIBE Service',
        'LIST_ALL Pod',
        'GET_EVENTS',
    ],
    'LIST_FINALIZERS': [
        'GET_NAMESPACE',
        'DESCRIBE',
        'RUN_KUBECTL get all',
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
