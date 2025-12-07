
import { invoke } from '@tauri-apps/api/core';
import yaml from 'js-yaml';
import { ClusterHealthSummary, ClusterEventSummary, UnhealthyReport } from '../../types/ai';

export const VALID_TOOLS = ['CLUSTER_HEALTH', 'GET_EVENTS', 'LIST_ALL', 'DESCRIBE', 'GET_LOGS', 'TOP_PODS', 'FIND_ISSUES', 'SEARCH_KNOWLEDGE', 'GET_ENDPOINTS', 'GET_NAMESPACE', 'LIST_FINALIZERS', 'GET_CROSSPLANE', 'GET_ISTIO', 'GET_WEBHOOKS', 'GET_UIPATH', 'RUN_KUBECTL', 'GET_CAPI', 'GET_CASTAI', 'VCLUSTER_CMD', 'GET_UIPATH_CRD'];

// Common patterns that indicate the AI is confused about arguments
const BAD_ARG_PATTERNS = [
    /\b(retrieve|detailed|fetch|show|find)\b/i,  // Generic verbs used as names (NOT 'get' - valid in kubectl)
    /\b(the|to|from|for|with|and|or|in)\s/i,  // Prepositions followed by more text
    /\[.*?\]|<.*?>/,  // Placeholder brackets
    /^\s*$/,  // Empty
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

    // Skip validation for these tools - they handle their own args
    if (['SEARCH_KNOWLEDGE', 'RUN_KUBECTL', 'VCLUSTER_CMD', 'LIST_ALL'].includes(toolName)) return null;

    // For LIST_ALL, check if it's a valid kind
    if (toolName === 'LIST_ALL') {
        const kind = args.trim().toLowerCase();
        if (VALID_KINDS.includes(kind)) return null;
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

// Tool result cache to avoid redundant calls during investigation
interface CacheEntry {
    result: ToolResult;
    timestamp: number;
}
const toolCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30000; // 30 seconds

// Tools that should NOT be cached (always fresh)
const NO_CACHE_TOOLS = ['SEARCH_KNOWLEDGE', 'RUN_KUBECTL', 'VCLUSTER_CMD'];

// Clear expired cache entries periodically
function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, entry] of toolCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
            toolCache.delete(key);
        }
    }
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
            // Extract and normalize kind from args
            let kind = (toolArgs || '').split(/\s+/)[0];

            if (!kind || kind.includes('[') || kind.includes('<')) {
                toolResult = '⚠️ Usage: LIST_ALL <kind> (e.g. LIST_ALL Pod, LIST_ALL PVC)';
            } else {
                // Normalize common plural forms to singular (K8s API uses singular)
                const kindNormalized = normalizeKind(kind);
                kubectlCommand = `kubectl get ${kindNormalized.toLowerCase()} --all-namespaces`;
                const resources = await invoke<any[]>("list_all_resources", { kind: kindNormalized });
                if (resources.length === 0) {
                    toolResult = `No resources of kind '${kindNormalized}' found.`;
                } else {
                    const summary = resources.slice(0, 50).map(r => `- ${r.namespace}/${r.name}: ${r.status}`).join('\n');
                    toolResult = `## ${kindNormalized} List (${resources.length} total)\n${summary}${resources.length > 50 ? `\n... ${resources.length - 50} more` : ''}`;
                }
            }
        } else if (toolName === 'DESCRIBE') {
            const [kind, ns, name] = (toolArgs || '').split(/\s+/);
            if (!kind || !ns || !name) {
                toolResult = '⚠️ Usage: DESCRIBE <kind> <namespace> <name>';
            } else {
                kubectlCommand = `kubectl describe ${kind.toLowerCase()} -n ${ns} ${name}`;
                const details = await invoke<string>("get_resource_details", {
                    req: { group: kind === 'Deployment' ? 'apps' : '', version: 'v1', kind, namespace: ns },
                    name
                });
                // Backend returns YAML, parse it
                const parsed = yaml.load(details) as any;
                toolResult = `## ${kind}: ${ns}/${name}\n\`\`\`yaml\n${JSON.stringify(parsed, null, 2).slice(0, 2000)}\n\`\`\``;
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
                // Use semantic search with fastembed embeddings (falls back to keyword if needed)
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
            const cmd = toolArgs?.trim();
            if (!cmd) {
                toolResult = '⚠️ Usage: RUN_KUBECTL <kubectl command>\nExamples:\n- RUN_KUBECTL kubectl get pods -A | grep -i error\n- RUN_KUBECTL kubectl get events --sort-by=.lastTimestamp | head -20\n- RUN_KUBECTL kubectl get pods -o wide | awk \'{print $1, $7}\'';
            } else {
                // Ensure it starts with kubectl
                const fullCmd = cmd.startsWith('kubectl ') ? cmd : `kubectl ${cmd}`;
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
