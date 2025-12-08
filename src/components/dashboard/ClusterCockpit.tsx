import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
    Activity, AlertCircle, Box, Check, Cpu, FolderOpen, HardDrive, Layers,
    Loader2, LogOut as LogOutIcon, Network, Package, PieChart, Plug,
    RefreshCw, Server, Sparkles, X, Zap, Info, ChevronDown, ChevronUp, HelpCircle
} from "lucide-react";
import {
    BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
    PieChart as RechartsPieChart, Pie, Cell, Legend
} from 'recharts';
import { NavResource, NavGroup } from '../../types/k8s';
import { ClusterCockpitData, NodeHealth, DeploymentHealth, NamespaceUsage } from '../../types/cockpit';
import { COLORS, SpeedometerGauge, VerticalMeter, GradientProgress, Gauge, StatusIndicator } from './CockpitGauge';

// Ollama Setup Instructions Component
interface OllamaStatus {
    ollama_running: boolean;
    model_available: boolean;
    model_name: string;
    available_models: string[];
    error: string | null;
    models?: string[];
    current_model?: string;
    gpu_available?: boolean;
    active_model_info?: any;
}

interface InstallStep {
    label: string;
    command?: string;
    link?: string;
}

interface PlatformConfig {
    name: string;
    icon: string;
    installSteps: InstallStep[];
    startCommand: string;
    pullCommand: string;
}

// Cluster Cockpit Dashboard - Airplane cockpit style view
export function ClusterCockpit({ onNavigate: _onNavigate, currentContext }: { onNavigate: (res: NavResource) => void, navStructure?: NavGroup[], currentContext?: string }) {
    const qc = useQueryClient();
    const [connectingVcluster, setConnectingVcluster] = useState<string | null>(null);
    const [connectCancelled, setConnectCancelled] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<string>("");
    const [isDisconnecting, setIsDisconnecting] = useState(false);
    const [isInvestigating, setIsInvestigating] = useState(false);
    const [investigationResult, setInvestigationResult] = useState<string | null>(null);
    const [showInfoPanel, setShowInfoPanel] = useState(false);

    // Detect if we're inside a vcluster (context name starts with "vcluster_")
    const isInsideVcluster = currentContext?.startsWith('vcluster_') || false;

    const { data: cockpit, isLoading, isError, error, refetch } = useQuery({
        queryKey: ["cluster_cockpit", currentContext],
        queryFn: async () => await invoke<ClusterCockpitData>("get_cluster_cockpit"),
        staleTime: 30000, // Increased to 30s to avoid refetch while initial_data is fresh
        refetchInterval: 60000, // Increased to 60s - cockpit data doesn't change that fast
    });

    // Fetch vclusters for this cluster - only on host clusters, not inside vclusters
    const { data: vclusters, isLoading: vclustersLoading } = useQuery({
        queryKey: ["vclusters", currentContext],
        queryFn: async () => {
            try {
                const vclusterResult = await invoke<string>("list_vclusters");
                if (!vclusterResult || vclusterResult === "null" || vclusterResult.trim() === "") {
                    return [];
                }
                const vclusterList = JSON.parse(vclusterResult);
                if (!Array.isArray(vclusterList)) return [];
                return vclusterList.map((vc: any) => ({
                    id: `vcluster-${vc.Name}-${vc.Namespace}`,
                    name: vc.Name,
                    namespace: vc.Namespace,
                    status: vc.Status || 'Unknown',
                    version: vc.Version || '',
                    connected: vc.Connected || false,
                }));
            } catch {
                return [];
            }
        },
        staleTime: 1000 * 60 * 2, // 2 minutes - vclusters don't change often
        // Only fetch vclusters when on host cluster, not inside a vcluster
        enabled: !!currentContext && !isInsideVcluster,
    });

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    };

    const formatCpu = (milli: number) => {
        if (milli >= 1000) return `${(milli / 1000).toFixed(1)} cores`;
        return `${milli}m`;
    };

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center bg-[#09090b]">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-12 h-12 text-cyan-400 animate-spin" />
                    <span className="text-zinc-400">Loading cluster cockpit...</span>
                </div>
            </div>
        );
    }

    if (isError || !cockpit) {
        return (
            <div className="h-full flex flex-col items-center justify-center bg-[#09090b] p-8">
                <AlertCircle className="w-16 h-16 text-red-400 mb-4" />
                <h2 className="text-xl font-bold text-white mb-2">Failed to load cockpit</h2>
                <p className="text-zinc-400 mb-4">{String(error)}</p>
                <button onClick={() => refetch()} className="px-4 py-2 bg-cyan-500 hover:bg-cyan-600 rounded text-white">
                    Retry
                </button>
            </div>
        );
    }

    // Prepare chart data
    const podStatusData = [
        { name: 'Running', value: cockpit.pod_status.running, color: COLORS.running },
        { name: 'Pending', value: cockpit.pod_status.pending, color: COLORS.pending },
        { name: 'Succeeded', value: cockpit.pod_status.succeeded, color: COLORS.succeeded },
        { name: 'Failed', value: cockpit.pod_status.failed, color: COLORS.failed },
        { name: 'Unknown', value: cockpit.pod_status.unknown, color: COLORS.unknown },
    ].filter(d => d.value > 0);

    const nodeBarData = cockpit.nodes.slice(0, 8).map((node: NodeHealth) => ({
        name: node.name.length > 20 ? node.name.slice(-20) : node.name,
        cpu: node.cpu_capacity > 0 ? Math.round((node.cpu_usage / node.cpu_capacity) * 100) : 0,
        memory: node.memory_capacity > 0 ? Math.round((node.memory_usage / node.memory_capacity) * 100) : 0,
    }));

    const namespaceData = cockpit.top_namespaces.slice(0, 8).map((ns: NamespaceUsage) => ({
        name: ns.name.length > 15 ? ns.name.slice(0, 15) + '...' : ns.name,
        pods: ns.pod_count,
    }));

    // Calculate health metrics
    const healthMetrics = (() => {
        const nodeHealthPct = cockpit.total_nodes > 0 ? (cockpit.healthy_nodes / cockpit.total_nodes) * 100 : 100;
        const podRunningPct = cockpit.total_pods > 0 ? (cockpit.pod_status.running / cockpit.total_pods) * 100 : 100;
        const deploymentHealthPct = cockpit.total_deployments > 0
            ? ((cockpit.total_deployments - cockpit.unhealthy_deployments.length) / cockpit.total_deployments) * 100
            : 100;
        const cpuPct = cockpit.total_cpu_allocatable > 0 ? (cockpit.total_cpu_usage / cockpit.total_cpu_allocatable) * 100 : 0;
        const memPct = cockpit.total_memory_allocatable > 0 ? (cockpit.total_memory_usage / cockpit.total_memory_allocatable) * 100 : 0;

        // Resource health: penalize if over 90%
        const cpuHealth = cpuPct > 90 ? 50 : cpuPct > 75 ? 75 : 100;
        const memHealth = memPct > 90 ? 50 : memPct > 75 ? 75 : 100;

        // Overall health score (weighted average)
        const healthScore = Math.round(
            (nodeHealthPct * 0.25) +
            (podRunningPct * 0.25) +
            (deploymentHealthPct * 0.2) +
            (cpuHealth * 0.15) +
            (memHealth * 0.15)
        );

        const failedPods = cockpit.pod_status.failed;
        const pendingPods = cockpit.pod_status.pending;
        const crashingPods = cockpit.pod_status.unknown; // Often indicates crash loops
        const unhealthyNodes = cockpit.total_nodes - cockpit.healthy_nodes;

        return {
            healthScore,
            nodeHealthPct,
            podRunningPct,
            deploymentHealthPct,
            cpuPct,
            memPct,
            failedPods,
            pendingPods,
            crashingPods,
            unhealthyNodes,
            unhealthyDeployments: cockpit.unhealthy_deployments.length,
        };
    })();

    const getHealthStatus = (score: number) => {
        if (score >= 90) return { label: 'Excellent', color: 'text-green-400', bg: 'bg-green-500', border: 'border-green-500/30' };
        if (score >= 75) return { label: 'Good', color: 'text-cyan-400', bg: 'bg-cyan-500', border: 'border-cyan-500/30' };
        if (score >= 50) return { label: 'Degraded', color: 'text-yellow-400', bg: 'bg-yellow-500', border: 'border-yellow-500/30' };
        return { label: 'Critical', color: 'text-red-400', bg: 'bg-red-500', border: 'border-red-500/30' };
    };

    const healthStatus = getHealthStatus(healthMetrics.healthScore);

    // Disconnect from vcluster and switch to host cluster
    const handleDisconnectVcluster = async () => {
        setIsDisconnecting(true);
        try {
            const result = await invoke<string>("disconnect_vcluster");
            console.log("disconnect_vcluster result:", result);

            // Check if we got a host context to switch to
            if (result.startsWith("HOST_CONTEXT:")) {
                const hostContext = result.replace("HOST_CONTEXT:", "");
                console.log("Switching to host context:", hostContext);

                // Clear all caches
                await invoke("clear_all_caches");
                qc.clear();

                // The backend already set the context, just need to refresh the UI
                await qc.invalidateQueries({ queryKey: ["current_context"] });
                await qc.invalidateQueries({ queryKey: ["cluster_cockpit"] });
                await qc.invalidateQueries({ queryKey: ["cluster_stats"] });
                await qc.invalidateQueries({ queryKey: ["initial_cluster_data"] });
                await qc.invalidateQueries({ queryKey: ["discovery"] });
                await qc.invalidateQueries({ queryKey: ["namespaces"] });
                await qc.invalidateQueries({ queryKey: ["vclusters"] });

                if ((window as any).showToast) {
                    (window as any).showToast(`Disconnected from vcluster. Switched to host cluster: ${hostContext}`, 'success');
                }
            } else {
                // Just refresh
                qc.clear();
                await qc.invalidateQueries({ queryKey: ["current_context"] });
                if ((window as any).showToast) {
                    (window as any).showToast('Disconnected from vcluster', 'success');
                }
            }
        } catch (err) {
            console.error("Failed to disconnect from vcluster:", err);
            if ((window as any).showToast) {
                (window as any).showToast(`Failed to disconnect: ${err}`, 'error');
            }
        } finally {
            setIsDisconnecting(false);
        }
    };

    // AI Investigate Cluster Issues
    const investigateClusterIssues = async () => {
        if (!cockpit) return;
        setIsInvestigating(true);
        setInvestigationResult(null);
        try {
            // Build a summary of issues
            const issues: string[] = [];
            if (healthMetrics.unhealthyNodes > 0) issues.push(`${healthMetrics.unhealthyNodes} node(s) not ready`);
            if (healthMetrics.failedPods > 0) issues.push(`${healthMetrics.failedPods} pod(s) failed`);
            if (healthMetrics.pendingPods > 0) issues.push(`${healthMetrics.pendingPods} pod(s) pending`);
            if (healthMetrics.crashingPods > 0) issues.push(`${healthMetrics.crashingPods} pod(s) in unknown state`);
            if (healthMetrics.unhealthyDeployments > 0) issues.push(`${healthMetrics.unhealthyDeployments} deployment(s) degraded`);
            if (healthMetrics.cpuPct > 80) issues.push(`CPU at ${healthMetrics.cpuPct.toFixed(0)}%`);
            if (healthMetrics.memPct > 80) issues.push(`Memory at ${healthMetrics.memPct.toFixed(0)}%`);

            const unhealthyDeploysList = cockpit.unhealthy_deployments?.slice(0, 5).map((d: DeploymentHealth) =>
                `- ${d.namespace}/${d.name}: ${d.ready}/${d.desired} ready`
            ).join('\n') || '';

            const unhealthyNodesList = cockpit.nodes?.filter((n: NodeHealth) => n.status !== 'Ready').slice(0, 5).map((n: NodeHealth) =>
                `- ${n.name}: ${n.status}`
            ).join('\n') || '';

            const context = `
Cluster Health Score: ${healthMetrics.healthScore}/100
Issues Detected: ${issues.join(', ')}

${unhealthyNodesList ? `Unhealthy Nodes:\n${unhealthyNodesList}` : ''}
${unhealthyDeploysList ? `Unhealthy Deployments:\n${unhealthyDeploysList}` : ''}

Node Status: ${cockpit.healthy_nodes}/${cockpit.total_nodes} ready
Pod Status: ${cockpit.pod_status.running} running, ${cockpit.pod_status.pending} pending, ${cockpit.pod_status.failed} failed
CPU: ${healthMetrics.cpuPct.toFixed(1)}% used
Memory: ${healthMetrics.memPct.toFixed(1)}% used
`;
            const answer = await invoke<string>("call_local_llm", {
                prompt: `Analyze this Kubernetes cluster status and provide:\n1. Priority assessment of the issues\n2. Likely root causes\n3. Recommended actions to resolve\n\n${context}`,
                systemPrompt: "You are a Kubernetes SRE expert. Provide a concise, prioritized analysis of cluster issues with actionable recommendations. Focus on the most critical problems first.",
            });
            setInvestigationResult(answer);
        } catch (err) {
            setInvestigationResult(`Error: ${err}`);
        } finally {
            setIsInvestigating(false);
        }
    };

    // Parse vcluster name from context (format: vcluster_<name>_<namespace>_<host>)
    const getVclusterInfo = () => {
        if (!isInsideVcluster || !currentContext) return null;
        const parts = currentContext.split('_');
        if (parts.length >= 4) {
            return {
                name: parts[1],
                namespace: parts[2],
                hostContext: parts.slice(3).join('_')
            };
        }
        return null;
    };
    const vclusterInfo = getVclusterInfo();

    return (
        <div className="h-full overflow-y-auto bg-[#09090b] p-6">
            {/* vcluster Banner - Show when inside a vcluster */}
            {isInsideVcluster && vclusterInfo && (
                <div className="mb-4 bg-gradient-to-r from-purple-900/30 via-purple-800/20 to-purple-900/30 rounded-xl p-4 border border-purple-500/30 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-purple-500/20">
                            <Box className="w-5 h-5 text-purple-400" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-purple-200">Virtual Cluster</span>
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                    {vclusterInfo.name}
                                </span>
                            </div>
                            <div className="text-xs text-purple-400/70 mt-0.5">
                                Running in namespace <span className="text-purple-300">{vclusterInfo.namespace}</span> on <span className="text-purple-300">{vclusterInfo.hostContext}</span>
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={handleDisconnectVcluster}
                        disabled={isDisconnecting}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/40 hover:border-purple-500/60 text-purple-200 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isDisconnecting ? (
                            <>
                                <Loader2 size={14} className="animate-spin" />
                                Disconnecting...
                            </>
                        ) : (
                            <>
                                <LogOutIcon size={14} />
                                Return to Host Cluster
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                        <Activity className="w-7 h-7 text-cyan-400" />
                        Cluster Cockpit
                    </h1>
                    <p className="text-zinc-400 mt-1">
                        Real-time cluster health and resource monitoring
                        {!cockpit.metrics_available && (
                            <span className="ml-2 text-amber-400 text-xs font-medium">
                                (Resource usage estimated from pod requests - metrics-server not available)
                            </span>
                        )}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {!cockpit.metrics_available && (
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/30">
                            <AlertCircle size={14} className="text-yellow-500" />
                            <span className="text-xs text-yellow-400">Estimated</span>
                        </div>
                    )}
                    <StatusIndicator status={cockpit.critical_count > 0 ? 'critical' : 'healthy'} count={cockpit.critical_count} label="Critical" />
                    <StatusIndicator status={cockpit.warning_count > 0 ? 'warning' : 'healthy'} count={cockpit.warning_count} label="Warnings" />
                    <button
                        onClick={() => setShowInfoPanel(!showInfoPanel)}
                        className={`p-2 rounded-lg transition-colors ${showInfoPanel ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white'}`}
                        title="How metrics are calculated"
                    >
                        <HelpCircle size={18} />
                    </button>
                    <button onClick={() => refetch()} className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors">
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            {/* Info Panel - How Metrics Are Calculated */}
            {showInfoPanel && (
                <div className="mb-6 bg-gradient-to-r from-blue-950/50 via-indigo-950/30 to-blue-950/50 rounded-xl border border-blue-500/20 overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-3 bg-blue-900/20 border-b border-blue-500/20">
                        <div className="flex items-center gap-2">
                            <Info size={16} className="text-blue-400" />
                            <span className="text-sm font-semibold text-blue-200">How Metrics Are Calculated</span>
                        </div>
                        <button onClick={() => setShowInfoPanel(false)} className="text-blue-400 hover:text-blue-200">
                            <X size={16} />
                        </button>
                    </div>
                    <div className="p-5 grid grid-cols-2 gap-6">
                        {/* Health Score */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-blue-300 uppercase tracking-wider flex items-center gap-2">
                                <Activity size={12} />
                                Overall Health Score
                            </h4>
                            <div className="text-xs text-zinc-400 space-y-2">
                                <p>The health score (0-100) is a weighted average of:</p>
                                <ul className="space-y-1 ml-4">
                                    <li className="flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
                                        <span><strong className="text-blue-300">25%</strong> - Node health (Ready nodes / Total nodes)</span>
                                    </li>
                                    <li className="flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                        <span><strong className="text-emerald-300">25%</strong> - Pod health (Running pods / Total pods)</span>
                                    </li>
                                    <li className="flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400"></span>
                                        <span><strong className="text-purple-300">20%</strong> - Deployment health (Healthy / Total)</span>
                                    </li>
                                    <li className="flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400"></span>
                                        <span><strong className="text-cyan-300">15%</strong> - CPU pressure (penalized if &gt;75%)</span>
                                    </li>
                                    <li className="flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400"></span>
                                        <span><strong className="text-violet-300">15%</strong> - Memory pressure (penalized if &gt;75%)</span>
                                    </li>
                                </ul>
                            </div>
                        </div>

                        {/* Resource Utilization */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-2">
                                <Cpu size={12} />
                                Resource Utilization
                            </h4>
                            <div className="text-xs text-zinc-400 space-y-2">
                                <p>CPU and Memory percentages show:</p>
                                <ul className="space-y-1 ml-4">
                                    <li className="flex items-start gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 mt-1.5"></span>
                                        <span><strong className="text-cyan-300">Used</strong> = Sum of actual usage from metrics-server (or pod requests if unavailable)</span>
                                    </li>
                                    <li className="flex items-start gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5"></span>
                                        <span><strong className="text-emerald-300">Allocatable</strong> = Node capacity minus system reserved (kubelet, OS)</span>
                                    </li>
                                </ul>
                                <div className="mt-3 p-2 bg-zinc-900/50 rounded border border-zinc-700/50">
                                    <p className="text-[10px] text-zinc-500">
                                        <strong className="text-zinc-400">Color coding:</strong> Green (0-74%), Yellow (75-89%), Red (90%+)
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Status Thresholds */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-2">
                                <Check size={12} />
                                Status Thresholds
                            </h4>
                            <div className="text-xs text-zinc-400 space-y-1">
                                <div className="flex items-center gap-3">
                                    <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[10px]">Excellent</span>
                                    <span>Health score 90-100</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 text-[10px]">Good</span>
                                    <span>Health score 75-89</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-[10px]">Degraded</span>
                                    <span>Health score 50-74</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px]">Critical</span>
                                    <span>Health score below 50</span>
                                </div>
                            </div>
                        </div>

                        {/* Data Sources */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-2">
                                <Server size={12} />
                                Data Sources
                            </h4>
                            <div className="text-xs text-zinc-400 space-y-2">
                                <div className="flex items-start gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5"></span>
                                    <span><strong className="text-emerald-300">With metrics-server:</strong> Real-time CPU/memory from node and pod metrics APIs</span>
                                </div>
                                <div className="flex items-start gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5"></span>
                                    <span><strong className="text-amber-300">Without metrics-server:</strong> Estimated from pod resource requests (less accurate)</span>
                                </div>
                                <div className="mt-2 p-2 bg-amber-900/20 rounded border border-amber-500/20">
                                    <p className="text-[10px] text-amber-400">
                                        Install metrics-server for accurate real-time metrics: <code className="bg-black/30 px-1 rounded">kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml</code>
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Cluster Health Summary */}
            <div className="bg-gradient-to-r from-zinc-900 via-zinc-900/80 to-zinc-950 rounded-xl p-5 border border-zinc-800 mb-6">
                <div className="flex items-start gap-6">
                    {/* Health Score Circle */}
                    <div className="flex flex-col items-center">
                        <div className={`relative w-28 h-28 rounded-full border-4 ${healthStatus.border} flex items-center justify-center`}
                            style={{ background: `conic-gradient(${healthStatus.bg.replace('bg-', '')} ${healthMetrics.healthScore * 3.6}deg, #27272a ${healthMetrics.healthScore * 3.6}deg)` }}>
                            <div className="absolute inset-2 bg-zinc-900 rounded-full flex flex-col items-center justify-center">
                                <span className={`text-3xl font-bold ${healthStatus.color}`}>{healthMetrics.healthScore}</span>
                                <span className="text-[10px] text-zinc-400 uppercase font-medium">Health</span>
                            </div>
                        </div>
                        <div className={`mt-2 px-3 py-1 rounded-full text-xs font-medium ${healthStatus.bg}/20 ${healthStatus.color}`}>
                            {healthStatus.label}
                        </div>
                    </div>

                    {/* Health Breakdown */}
                    <div className="flex-1 grid grid-cols-5 gap-4">
                        {/* Nodes Health */}
                        <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                            <div className="flex items-center gap-2 mb-2">
                                <Server size={14} className="text-blue-400" />
                                <span className="text-xs text-zinc-400">Nodes</span>
                            </div>
                            <div className="text-xl font-bold text-white">{cockpit.healthy_nodes}<span className="text-zinc-500 text-sm">/{cockpit.total_nodes}</span></div>
                            <div className="mt-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${healthMetrics.nodeHealthPct === 100 ? 'bg-green-500' : healthMetrics.nodeHealthPct >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                    style={{ width: `${healthMetrics.nodeHealthPct}%` }} />
                            </div>
                            <div className="text-[10px] mt-1">
                                {healthMetrics.unhealthyNodes > 0 ? <span className="text-red-400 font-medium">{healthMetrics.unhealthyNodes} not ready</span> : <span className="text-emerald-400">All ready</span>}
                            </div>
                        </div>

                        {/* Pods Health */}
                        <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                            <div className="flex items-center gap-2 mb-2">
                                <Layers size={14} className="text-green-400" />
                                <span className="text-xs text-zinc-400">Pods</span>
                            </div>
                            <div className="text-xl font-bold text-white">{cockpit.pod_status.running}<span className="text-zinc-500 text-sm">/{cockpit.total_pods}</span></div>
                            <div className="mt-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${healthMetrics.podRunningPct >= 95 ? 'bg-green-500' : healthMetrics.podRunningPct >= 80 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                    style={{ width: `${healthMetrics.podRunningPct}%` }} />
                            </div>
                            <div className="text-[10px] mt-1 flex gap-2">
                                {healthMetrics.pendingPods > 0 && <span className="text-amber-400 font-medium">{healthMetrics.pendingPods} pending</span>}
                                {healthMetrics.failedPods > 0 && <span className="text-red-400 font-medium">{healthMetrics.failedPods} failed</span>}
                                {healthMetrics.pendingPods === 0 && healthMetrics.failedPods === 0 && <span className="text-emerald-400">All running</span>}
                            </div>
                        </div>

                        {/* Deployments Health */}
                        <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                            <div className="flex items-center gap-2 mb-2">
                                <Package size={14} className="text-purple-400" />
                                <span className="text-xs text-zinc-400">Deployments</span>
                            </div>
                            <div className="text-xl font-bold text-white">{cockpit.total_deployments - healthMetrics.unhealthyDeployments}<span className="text-zinc-500 text-sm">/{cockpit.total_deployments}</span></div>
                            <div className="mt-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${healthMetrics.deploymentHealthPct === 100 ? 'bg-green-500' : healthMetrics.deploymentHealthPct >= 80 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                    style={{ width: `${healthMetrics.deploymentHealthPct}%` }} />
                            </div>
                            <div className="text-[10px] mt-1">
                                {healthMetrics.unhealthyDeployments > 0 ? <span className="text-amber-400 font-medium">{healthMetrics.unhealthyDeployments} degraded</span> : <span className="text-emerald-400">All healthy</span>}
                            </div>
                        </div>

                        {/* CPU Pressure */}
                        <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                            <div className="flex items-center gap-2 mb-2">
                                <Cpu size={14} className="text-cyan-400" />
                                <span className="text-xs text-zinc-400">CPU Pressure</span>
                            </div>
                            <div className={`text-xl font-bold ${healthMetrics.cpuPct > 90 ? 'text-red-400' : healthMetrics.cpuPct > 75 ? 'text-yellow-400' : 'text-white'}`}>
                                {healthMetrics.cpuPct.toFixed(0)}%
                            </div>
                            <div className="mt-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${healthMetrics.cpuPct > 90 ? 'bg-red-500' : healthMetrics.cpuPct > 75 ? 'bg-yellow-500' : 'bg-cyan-500'}`}
                                    style={{ width: `${Math.min(healthMetrics.cpuPct, 100)}%` }} />
                            </div>
                            <div className="text-[10px] mt-1">
                                {healthMetrics.cpuPct > 90 ? <span className="text-red-400 font-medium">Critical load</span> :
                                    healthMetrics.cpuPct > 75 ? <span className="text-amber-400 font-medium">High load</span> :
                                        <span className="text-emerald-400">Normal</span>}
                            </div>
                        </div>

                        {/* Memory Pressure */}
                        <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                            <div className="flex items-center gap-2 mb-2">
                                <HardDrive size={14} className="text-purple-400" />
                                <span className="text-xs text-zinc-400">Memory Pressure</span>
                            </div>
                            <div className={`text-xl font-bold ${healthMetrics.memPct > 90 ? 'text-red-400' : healthMetrics.memPct > 75 ? 'text-yellow-400' : 'text-white'}`}>
                                {healthMetrics.memPct.toFixed(0)}%
                            </div>
                            <div className="mt-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${healthMetrics.memPct > 90 ? 'bg-red-500' : healthMetrics.memPct > 75 ? 'bg-yellow-500' : 'bg-purple-500'}`}
                                    style={{ width: `${Math.min(healthMetrics.memPct, 100)}%` }} />
                            </div>
                            <div className="text-[10px] mt-1">
                                {healthMetrics.memPct > 90 ? <span className="text-red-400 font-medium">Critical usage</span> :
                                    healthMetrics.memPct > 75 ? <span className="text-amber-400 font-medium">High usage</span> :
                                        <span className="text-emerald-400">Normal</span>}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Issues Summary - only show if there are issues */}
                {(cockpit.critical_count > 0 || cockpit.warning_count > 0 || healthMetrics.failedPods > 0 || healthMetrics.pendingPods > 0 || healthMetrics.unhealthyNodes > 0) && (
                    <div className="mt-4 pt-4 border-t border-zinc-700/50">
                        <div className="flex items-center gap-2 mb-3">
                            <AlertCircle size={14} className="text-yellow-400" />
                            <span className="text-xs font-medium text-zinc-300">Active Issues</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {healthMetrics.unhealthyNodes > 0 && (
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30">
                                    <Server size={12} className="text-red-400" />
                                    <span className="text-xs text-red-300">{healthMetrics.unhealthyNodes} node{healthMetrics.unhealthyNodes > 1 ? 's' : ''} not ready</span>
                                </div>
                            )}
                            {healthMetrics.failedPods > 0 && (
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30">
                                    <Layers size={12} className="text-red-400" />
                                    <span className="text-xs text-red-300">{healthMetrics.failedPods} pod{healthMetrics.failedPods > 1 ? 's' : ''} failed</span>
                                </div>
                            )}
                            {healthMetrics.pendingPods > 0 && (
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-yellow-500/10 border border-yellow-500/30">
                                    <Layers size={12} className="text-yellow-400" />
                                    <span className="text-xs text-yellow-300">{healthMetrics.pendingPods} pod{healthMetrics.pendingPods > 1 ? 's' : ''} pending</span>
                                </div>
                            )}
                            {healthMetrics.crashingPods > 0 && (
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-orange-500/10 border border-orange-500/30">
                                    <Layers size={12} className="text-orange-400" />
                                    <span className="text-xs text-orange-300">{healthMetrics.crashingPods} pod{healthMetrics.crashingPods > 1 ? 's' : ''} unknown state</span>
                                </div>
                            )}
                            {healthMetrics.unhealthyDeployments > 0 && (
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-yellow-500/10 border border-yellow-500/30">
                                    <Package size={12} className="text-yellow-400" />
                                    <span className="text-xs text-yellow-300">{healthMetrics.unhealthyDeployments} deployment{healthMetrics.unhealthyDeployments > 1 ? 's' : ''} degraded</span>
                                </div>
                            )}
                            {healthMetrics.cpuPct > 90 && (
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30">
                                    <Cpu size={12} className="text-red-400" />
                                    <span className="text-xs text-red-300">CPU at {healthMetrics.cpuPct.toFixed(0)}% - critical</span>
                                </div>
                            )}
                            {healthMetrics.memPct > 90 && (
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30">
                                    <HardDrive size={12} className="text-red-400" />
                                    <span className="text-xs text-red-300">Memory at {healthMetrics.memPct.toFixed(0)}% - critical</span>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* All Clear Message */}
                {cockpit.critical_count === 0 && cockpit.warning_count === 0 && healthMetrics.failedPods === 0 && healthMetrics.pendingPods === 0 && healthMetrics.unhealthyNodes === 0 && healthMetrics.unhealthyDeployments === 0 && (
                    <div className="mt-4 pt-4 border-t border-zinc-700/50">
                        <div className="flex items-center gap-2">
                            <Check size={14} className="text-green-400" />
                            <span className="text-xs text-green-400">All systems operational - no active issues detected</span>
                        </div>
                    </div>
                )}
            </div>
            {/* Main Speedometer Gauges Row */}
            <div className="grid grid-cols-2 gap-6 mb-6">
                {/* CPU Speedometer */}
                <div className="bg-gradient-to-br from-zinc-900 via-zinc-900/50 to-zinc-950 rounded-xl p-6 border border-zinc-800">
                    <div className="flex items-center gap-2 mb-4">
                        <Cpu className="w-5 h-5 text-cyan-400" />
                        <div>
                            <h3 className="text-sm font-semibold text-white">CPU Utilization</h3>
                            <p className="text-[10px] text-zinc-400">Total CPU usage across all nodes vs allocatable capacity</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <SpeedometerGauge
                            value={cockpit.total_cpu_usage}
                            max={cockpit.total_cpu_allocatable}
                            label="CPU UTILIZATION"
                            color={COLORS.cpu}
                            unit={formatCpu(cockpit.total_cpu_usage)}
                            size={180}
                        />
                        <div className="flex-1 space-y-3">
                            <GradientProgress value={cockpit.total_cpu_usage} max={cockpit.total_cpu_allocatable} label="Used by workloads" sublabel={`${formatCpu(cockpit.total_cpu_usage)} of ${formatCpu(cockpit.total_cpu_allocatable)} allocatable`} />
                            <GradientProgress value={cockpit.total_cpu_capacity - cockpit.total_cpu_allocatable} max={cockpit.total_cpu_capacity} label="Reserved by system" sublabel={`${formatCpu(cockpit.total_cpu_capacity - cockpit.total_cpu_allocatable)} for kubelet, OS`} />
                            <div className="pt-2 border-t border-zinc-800 grid grid-cols-2 gap-4 text-xs">
                                <div>
                                    <span className="text-zinc-400 text-[11px]">Allocatable</span>
                                    <div className="text-cyan-400 font-mono font-semibold">{formatCpu(cockpit.total_cpu_allocatable)}</div>
                                    <span className="text-[10px] text-zinc-500">for pods</span>
                                </div>
                                <div>
                                    <span className="text-zinc-400 text-[11px]">Available</span>
                                    <div className="text-emerald-400 font-mono font-semibold">{formatCpu(Math.max(0, cockpit.total_cpu_allocatable - cockpit.total_cpu_usage))}</div>
                                    <span className="text-[10px] text-zinc-500">free capacity</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Memory Speedometer */}
                <div className="bg-gradient-to-br from-zinc-900 via-zinc-900/50 to-zinc-950 rounded-xl p-6 border border-zinc-800">
                    <div className="flex items-center gap-2 mb-4">
                        <HardDrive className="w-5 h-5 text-purple-400" />
                        <div>
                            <h3 className="text-sm font-semibold text-white">Memory Utilization</h3>
                            <p className="text-[10px] text-zinc-400">Total RAM usage across all nodes vs allocatable capacity</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <SpeedometerGauge
                            value={cockpit.total_memory_usage}
                            max={cockpit.total_memory_allocatable}
                            label="MEMORY UTILIZATION"
                            color={COLORS.memory}
                            unit={formatBytes(cockpit.total_memory_usage)}
                            size={180}
                        />
                        <div className="flex-1 space-y-3">
                            <GradientProgress value={cockpit.total_memory_usage} max={cockpit.total_memory_allocatable} label="Used by workloads" sublabel={`${formatBytes(cockpit.total_memory_usage)} of ${formatBytes(cockpit.total_memory_allocatable)} allocatable`} />
                            <GradientProgress value={cockpit.total_memory_capacity - cockpit.total_memory_allocatable} max={cockpit.total_memory_capacity} label="Reserved by system" sublabel={`${formatBytes(cockpit.total_memory_capacity - cockpit.total_memory_allocatable)} for kubelet, OS`} />
                            <div className="pt-2 border-t border-zinc-800 grid grid-cols-2 gap-4 text-xs">
                                <div>
                                    <span className="text-zinc-400 text-[11px]">Allocatable</span>
                                    <div className="text-purple-400 font-mono font-semibold">{formatBytes(cockpit.total_memory_allocatable)}</div>
                                    <span className="text-[10px] text-zinc-500">for pods</span>
                                </div>
                                <div>
                                    <span className="text-zinc-400 text-[11px]">Available</span>
                                    <div className="text-emerald-400 font-mono font-semibold">{formatBytes(Math.max(0, cockpit.total_memory_allocatable - cockpit.total_memory_usage))}</div>
                                    <span className="text-[10px] text-zinc-500">free capacity</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Vertical Meters Row */}
            <div className="bg-gradient-to-r from-zinc-900/80 to-zinc-950/80 rounded-xl p-6 border border-zinc-800 mb-6">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-yellow-400" />
                        <div>
                            <h3 className="text-sm font-semibold text-white">Cluster Capacity Overview</h3>
                            <p className="text-[10px] text-zinc-400">Quick view of resource utilization and health status</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] text-zinc-400">
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500"></span> Healthy (0-74%)</span>
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500"></span> Warning (75-89%)</span>
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500"></span> Critical (90%+)</span>
                    </div>
                </div>
                <div className="flex justify-around items-end">
                    {/* Resource Utilization Meters */}
                    <div className="flex flex-col items-center">
                        <VerticalMeter value={cockpit.total_cpu_usage} max={cockpit.total_cpu_allocatable} label="CPU" color={COLORS.cpu} icon={Cpu} />
                        <span className="text-[10px] text-zinc-500 mt-1">processor usage</span>
                    </div>
                    <div className="flex flex-col items-center">
                        <VerticalMeter value={cockpit.total_memory_usage} max={cockpit.total_memory_allocatable} label="Memory" color={COLORS.memory} icon={HardDrive} />
                        <span className="text-[10px] text-zinc-500 mt-1">RAM usage</span>
                    </div>
                    <div className="flex flex-col items-center">
                        <VerticalMeter value={cockpit.total_pods} max={cockpit.total_pods_capacity} label="Pods" color={COLORS.running} icon={Layers} />
                        <span className="text-[10px] text-zinc-500 mt-1">pod slots used</span>
                    </div>
                    <div className="flex flex-col items-center">
                        <VerticalMeter
                            value={cockpit.healthy_nodes}
                            max={cockpit.total_nodes || 1}
                            label="Healthy"
                            color={COLORS.healthy}
                            icon={Check}
                            positiveMetric={true}
                        />
                        <span className="text-[10px] text-zinc-500 mt-1">
                            {cockpit.total_nodes > 0 && cockpit.healthy_nodes === cockpit.total_nodes
                                ? 'All nodes ready'
                                : `${cockpit.healthy_nodes}/${cockpit.total_nodes} ready`}
                        </span>
                    </div>

                    {/* Divider */}
                    <div className="w-px h-32 bg-zinc-700 mx-2"></div>

                    {/* Ring gauges for health metrics */}
                    <div className="flex flex-col items-center gap-2">
                        <div className="relative">
                            <Gauge value={cockpit.healthy_nodes} max={cockpit.total_nodes} label="Nodes" color={COLORS.healthy} size={100} />
                        </div>
                        <div className="text-[10px] text-zinc-300 font-medium">{cockpit.healthy_nodes}/{cockpit.total_nodes} healthy</div>
                        <span className="text-[10px] text-zinc-500">Ready status</span>
                    </div>

                    <div className="flex flex-col items-center gap-2">
                        <div className="relative">
                            <Gauge value={cockpit.pod_status.running} max={cockpit.total_pods} label="Running" color={COLORS.running} size={100} />
                        </div>
                        <div className="text-[10px] text-zinc-300 font-medium">{cockpit.pod_status.running}/{cockpit.total_pods} running</div>
                        <span className="text-[10px] text-zinc-500">Active pods</span>
                    </div>

                    <div className="flex flex-col items-center gap-2">
                        <div className="relative">
                            <Gauge value={cockpit.total_deployments - (cockpit.warning_count || 0)} max={cockpit.total_deployments} label="Healthy" color={COLORS.healthy} size={100} />
                        </div>
                        <div className="text-[10px] text-zinc-300 font-medium">{cockpit.total_deployments} deployments</div>
                        <span className="text-[10px] text-zinc-500">Fully available</span>
                    </div>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <Activity className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-sm font-semibold text-white">Resource Summary</h3>
                    <span className="text-[10px] text-zinc-400">Cluster resource overview and capacity</span>
                </div>
                <div className="grid grid-cols-5 gap-4 mb-4">
                    {[
                        { label: 'Nodes', value: cockpit.total_nodes, icon: Server, color: 'text-blue-400', desc: `${cockpit.healthy_nodes} healthy`, highlight: cockpit.healthy_nodes < cockpit.total_nodes },
                        { label: 'Pods', value: cockpit.total_pods, icon: Layers, color: 'text-emerald-400', desc: `${cockpit.pod_status.running} running`, highlight: cockpit.pod_status.running < cockpit.total_pods },
                        { label: 'Deployments', value: cockpit.total_deployments, icon: Package, color: 'text-purple-400', desc: `${cockpit.unhealthy_deployments.length} unhealthy`, highlight: cockpit.unhealthy_deployments.length > 0 },
                        { label: 'Services', value: cockpit.total_services, icon: Network, color: 'text-orange-400', desc: 'Network endpoints', highlight: false },
                        { label: 'Namespaces', value: cockpit.total_namespaces, icon: FolderOpen, color: 'text-amber-400', desc: 'Logical partitions', highlight: false },
                    ].map((stat, i) => (
                        <div key={i} className={`bg-zinc-900/50 rounded-lg p-4 border transition-colors ${stat.highlight ? 'border-amber-500/40 hover:border-amber-500/60' : 'border-zinc-800 hover:border-zinc-600'}`}>
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="text-xs text-zinc-400 uppercase tracking-wider font-medium">{stat.label}</div>
                                    <div className={`text-2xl font-bold ${stat.color} mt-1`}>{stat.value}</div>
                                    <div className={`text-[10px] mt-0.5 ${stat.highlight ? 'text-amber-400' : 'text-zinc-500'}`}>{stat.desc}</div>
                                </div>
                                <stat.icon className={`w-8 h-8 ${stat.color} opacity-60`} />
                            </div>
                        </div>
                    ))}
                </div>
                {/* Additional Resource Stats Row */}
                <div className="grid grid-cols-4 gap-4">
                    <div className="bg-gradient-to-br from-cyan-950/30 to-zinc-900/50 rounded-lg p-4 border border-cyan-900/30">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs text-zinc-400 uppercase tracking-wider font-medium">Total CPU</div>
                                <div className="text-xl font-bold text-cyan-400 mt-1 font-mono">{formatCpu(cockpit.total_cpu_capacity)}</div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">{formatCpu(cockpit.total_cpu_allocatable)} allocatable</div>
                            </div>
                            <Cpu className="w-7 h-7 text-cyan-400 opacity-60" />
                        </div>
                        <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className="h-full bg-cyan-500 rounded-full transition-all" style={{ width: `${(cockpit.total_cpu_usage / cockpit.total_cpu_allocatable) * 100}%` }} />
                        </div>
                    </div>
                    <div className="bg-gradient-to-br from-purple-950/30 to-zinc-900/50 rounded-lg p-4 border border-purple-900/30">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs text-zinc-400 uppercase tracking-wider font-medium">Total Memory</div>
                                <div className="text-xl font-bold text-purple-400 mt-1 font-mono">{formatBytes(cockpit.total_memory_capacity)}</div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">{formatBytes(cockpit.total_memory_allocatable)} allocatable</div>
                            </div>
                            <HardDrive className="w-7 h-7 text-purple-400 opacity-60" />
                        </div>
                        <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className="h-full bg-purple-500 rounded-full transition-all" style={{ width: `${(cockpit.total_memory_usage / cockpit.total_memory_allocatable) * 100}%` }} />
                        </div>
                    </div>
                    <div className="bg-gradient-to-br from-emerald-950/30 to-zinc-900/50 rounded-lg p-4 border border-emerald-900/30">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs text-zinc-400 uppercase tracking-wider font-medium">Pod Capacity</div>
                                <div className="text-xl font-bold text-emerald-400 mt-1 font-mono">{cockpit.total_pods_capacity}</div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">{cockpit.total_pods_capacity - cockpit.total_pods} slots free</div>
                            </div>
                            <Layers className="w-7 h-7 text-emerald-400 opacity-60" />
                        </div>
                        <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${(cockpit.total_pods / cockpit.total_pods_capacity) * 100}%` }} />
                        </div>
                    </div>
                    <div className={`bg-gradient-to-br ${cockpit.critical_count > 0 ? 'from-red-950/40' : cockpit.warning_count > 0 ? 'from-amber-950/40' : 'from-emerald-950/30'} to-zinc-900/50 rounded-lg p-4 border ${cockpit.critical_count > 0 ? 'border-red-900/40' : cockpit.warning_count > 0 ? 'border-amber-900/30' : 'border-emerald-900/30'}`}>
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs text-zinc-400 uppercase tracking-wider font-medium">Cluster Health</div>
                                <div className={`text-xl font-bold mt-1 ${cockpit.critical_count > 0 ? 'text-red-400' : cockpit.warning_count > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                    {cockpit.critical_count > 0 ? 'Critical' : cockpit.warning_count > 0 ? 'Warning' : 'Healthy'}
                                </div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">
                                    {cockpit.critical_count > 0 ? `${cockpit.critical_count} critical issues` : cockpit.warning_count > 0 ? `${cockpit.warning_count} warnings` : 'All systems operational'}
                                </div>
                            </div>
                            {cockpit.critical_count > 0 ? (
                                <AlertCircle className="w-7 h-7 text-red-400 opacity-80 animate-pulse" />
                            ) : cockpit.warning_count > 0 ? (
                                <AlertCircle className="w-7 h-7 text-amber-400 opacity-70" />
                            ) : (
                                <Check className="w-7 h-7 text-emerald-400 opacity-60" />
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Charts Row */}
            <div className="grid grid-cols-3 gap-6 mb-6">
                {/* Pod Status Pie Chart */}
                <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
                    <div className="mb-4">
                        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            <PieChart className="w-4 h-4 text-cyan-400" />
                            Pod Status Distribution
                        </h3>
                        <p className="text-[10px] text-zinc-400 mt-1">Breakdown of pod lifecycle states</p>
                    </div>
                    <div className="h-[180px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <RechartsPieChart>
                                <Pie
                                    data={podStatusData}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={45}
                                    outerRadius={70}
                                    paddingAngle={2}
                                    dataKey="value"
                                >
                                    {podStatusData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.color} />
                                    ))}
                                </Pie>
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px' }}
                                    labelStyle={{ color: '#fff' }}
                                    itemStyle={{ color: '#e4e4e7' }}
                                    formatter={(value: number, name: string) => [<span style={{ color: '#e4e4e7' }}>{value} pods</span>, name]}
                                />
                                <Legend
                                    verticalAlign="bottom"
                                    height={36}
                                    formatter={(value) => <span className="text-xs text-zinc-400">{value}</span>}
                                />
                            </RechartsPieChart>
                        </ResponsiveContainer>
                    </div>
                    <div className="mt-2 pt-2 border-t border-zinc-800 text-[10px] text-zinc-400 grid grid-cols-2 gap-1">
                        <span><span className="text-emerald-400 font-medium">Running</span> = actively executing</span>
                        <span><span className="text-amber-400 font-medium">Pending</span> = waiting to start</span>
                        <span><span className="text-cyan-400 font-medium">Succeeded</span> = completed ok</span>
                        <span><span className="text-red-400 font-medium">Failed</span> = exited with error</span>
                    </div>
                </div>

                {/* Node Resource Usage Bar Chart */}
                <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
                    <div className="mb-4">
                        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            <Server className="w-4 h-4 text-cyan-400" />
                            Node Resource Usage
                        </h3>
                        <p className="text-[10px] text-zinc-400 mt-1">CPU and memory utilization per node</p>
                    </div>
                    <div className="h-[180px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={nodeBarData} layout="vertical">
                                <XAxis type="number" domain={[0, 100]} tick={{ fill: '#71717a', fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
                                <YAxis type="category" dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} width={80} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px' }}
                                    labelStyle={{ color: '#fff' }}
                                    itemStyle={{ color: '#e4e4e7' }}
                                    formatter={(value: number, name: string) => [<span style={{ color: '#e4e4e7' }}>{value}%</span>, name]}
                                />
                                <Legend formatter={(value) => <span className="text-xs text-zinc-400">{value}</span>} />
                                <Bar dataKey="cpu" fill={COLORS.cpu} name="CPU %" radius={[0, 4, 4, 0]} />
                                <Bar dataKey="memory" fill={COLORS.memory} name="Memory %" radius={[0, 4, 4, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                    <div className="mt-2 pt-2 border-t border-zinc-800 flex items-center justify-between text-[10px] text-zinc-400">
                        <span><span className="inline-block w-2 h-2 rounded-full bg-cyan-500 mr-1.5"></span>CPU: processor cores</span>
                        <span><span className="inline-block w-2 h-2 rounded-full bg-purple-500 mr-1.5"></span>Memory: RAM usage</span>
                    </div>
                </div>

                {/* Top Namespaces */}
                <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
                    <div className="mb-4">
                        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            <FolderOpen className="w-4 h-4 text-cyan-400" />
                            Top Namespaces
                        </h3>
                        <p className="text-[10px] text-zinc-400 mt-1">Namespaces with most pods deployed</p>
                    </div>
                    <div className="h-[180px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={namespaceData}>
                                <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
                                <YAxis tick={{ fill: '#71717a', fontSize: 10 }} label={{ value: 'Pods', angle: -90, position: 'insideLeft', fill: '#52525b', fontSize: 10 }} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px' }}
                                    labelStyle={{ color: '#fff' }}
                                    itemStyle={{ color: '#e4e4e7' }}
                                    formatter={(value: number) => [<span style={{ color: '#e4e4e7' }}>{value} pods</span>, 'Pod count']}
                                />
                                <Bar dataKey="pods" fill={COLORS.running} radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                    <div className="mt-2 pt-2 border-t border-zinc-800 text-[10px] text-zinc-400">
                        Namespaces group related workloads and isolate resources
                    </div>
                </div>
            </div>

            {/* Bottom Row - Nodes Table and Unhealthy Deployments */}
            <div className="grid grid-cols-2 gap-6">
                {/* Nodes Health Table */}
                <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
                    <div className="mb-4">
                        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            <Server className="w-4 h-4 text-cyan-400" />
                            Nodes Health ({cockpit.nodes.length})
                        </h3>
                        <p className="text-[10px] text-zinc-400 mt-1">Individual node status and resource consumption</p>
                    </div>
                    <div className="overflow-auto max-h-[280px]">
                        <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-zinc-900">
                                <tr className="text-zinc-500 uppercase">
                                    <th className="text-left py-2 px-2" title="Node hostname">Node</th>
                                    <th className="text-center py-2 px-2" title="Ready = accepting pods">Status</th>
                                    <th className="text-right py-2 px-2" title="CPU utilization percentage">CPU %</th>
                                    <th className="text-right py-2 px-2" title="Memory utilization percentage">Mem %</th>
                                    <th className="text-right py-2 px-2" title="Running/Capacity pods">Pods</th>
                                </tr>
                            </thead>
                            <tbody>
                                {cockpit.nodes.map((node: NodeHealth, i: number) => {
                                    const cpuPct = node.cpu_capacity > 0 ? (node.cpu_usage / node.cpu_capacity) * 100 : 0;
                                    const memPct = node.memory_capacity > 0 ? (node.memory_usage / node.memory_capacity) * 100 : 0;
                                    return (
                                        <tr key={i} className="border-t border-zinc-800 hover:bg-zinc-800/50">
                                            <td className="py-2 px-2 font-mono text-zinc-300 truncate max-w-[150px]" title={node.name}>
                                                {node.name.length > 25 ? '...' + node.name.slice(-22) : node.name}
                                            </td>
                                            <td className="py-2 px-2 text-center">
                                                <span className={`px-2 py-0.5 rounded text-[10px] ${node.status === 'Ready' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                                                    }`}>{node.status}</span>
                                            </td>
                                            <td className="py-2 px-2 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                                        <div className={`h-full rounded-full ${cpuPct > 90 ? 'bg-red-500' : cpuPct > 75 ? 'bg-yellow-500' : 'bg-cyan-500'}`} style={{ width: `${cpuPct}%` }} />
                                                    </div>
                                                    <span className="text-zinc-400 w-10 text-right">{cpuPct.toFixed(0)}%</span>
                                                </div>
                                            </td>
                                            <td className="py-2 px-2 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                                        <div className={`h-full rounded-full ${memPct > 90 ? 'bg-red-500' : memPct > 75 ? 'bg-yellow-500' : 'bg-purple-500'}`} style={{ width: `${memPct}%` }} />
                                                    </div>
                                                    <span className="text-zinc-400 w-10 text-right">{memPct.toFixed(0)}%</span>
                                                </div>
                                            </td>
                                            <td className="py-2 px-2 text-right text-zinc-400">
                                                {node.pods_running}/{node.pods_capacity}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Unhealthy Deployments */}
                <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
                    <div className="mb-4">
                        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-amber-400" />
                            Unhealthy Deployments ({cockpit.unhealthy_deployments.length})
                        </h3>
                        <p className="text-[10px] text-zinc-400 mt-1">Deployments with missing or unavailable replicas</p>
                    </div>
                    {cockpit.unhealthy_deployments.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-[240px] text-zinc-400">
                            <Check className="w-12 h-12 text-emerald-400 mb-2" />
                            <span className="text-sm font-medium text-zinc-300">All deployments healthy</span>
                            <span className="text-[10px] text-zinc-500 mt-1">No replica mismatches detected</span>
                        </div>
                    ) : (
                        <div className="overflow-auto max-h-[280px]">
                            <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-zinc-900">
                                    <tr className="text-zinc-500 uppercase">
                                        <th className="text-left py-2 px-2" title="Deployment name">Deployment</th>
                                        <th className="text-left py-2 px-2" title="Kubernetes namespace">Namespace</th>
                                        <th className="text-center py-2 px-2" title="Ready/Desired pods">Ready</th>
                                        <th className="text-center py-2 px-2" title="Available/Desired pods">Available</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {cockpit.unhealthy_deployments.map((dep: DeploymentHealth, i: number) => (
                                        <tr key={i} className="border-t border-zinc-800 hover:bg-zinc-800/50">
                                            <td className="py-2 px-2 font-mono text-zinc-300 truncate max-w-[150px]" title={dep.name}>{dep.name}</td>
                                            <td className="py-2 px-2 text-zinc-500 truncate max-w-[100px]">{dep.namespace}</td>
                                            <td className="py-2 px-2 text-center">
                                                <span className={`${dep.ready < dep.desired ? 'text-yellow-400' : 'text-green-400'}`}>
                                                    {dep.ready}/{dep.desired}
                                                </span>
                                            </td>
                                            <td className="py-2 px-2 text-center">
                                                <span className={`${dep.available < dep.desired ? 'text-red-400' : 'text-green-400'}`}>
                                                    {dep.available}/{dep.desired}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {/* Virtual Clusters Section - only show on host clusters, not inside vclusters */}
            {!isInsideVcluster && vclusters && vclusters.length > 0 && (
                <div className="mt-6 bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
                    <div className="mb-4">
                        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            <Box className="w-4 h-4 text-purple-400" />
                            Virtual Clusters ({vclusters.length})
                        </h3>
                        <p className="text-[10px] text-zinc-400 mt-1">Lightweight isolated Kubernetes clusters running in this host cluster</p>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                        {vclusters.map((vc: any) => (
                            <div
                                key={vc.id}
                                className="bg-zinc-800/50 rounded-lg p-4 border border-zinc-700 hover:border-purple-500/50 transition-all group"
                            >
                                <div className="flex items-start justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <Box className="w-5 h-5 text-purple-400" />
                                        <div>
                                            <div className="font-medium text-white text-sm">{vc.name}</div>
                                            <div className="text-xs text-zinc-500">{vc.namespace}</div>
                                        </div>
                                    </div>
                                    <span className={`text-xs px-2 py-0.5 rounded ${vc.status === 'Running' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                                        {vc.status}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between text-xs text-zinc-500 mb-3">
                                    <span>v{vc.version}</span>
                                    {vc.connected && <span className="text-cyan-400">Connected</span>}
                                </div>
                                {connectingVcluster === vc.id ? (
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2 px-3 py-2.5 rounded-md bg-purple-900/50 border border-purple-500/30">
                                            <Loader2 size={14} className="animate-spin text-purple-400" />
                                            <span className="text-xs text-purple-200 flex-1">{connectionStatus || "Initializing..."}</span>
                                        </div>
                                        <button
                                            onClick={() => {
                                                setConnectCancelled(true);
                                                setConnectingVcluster(null);
                                                setConnectionStatus("");
                                                if ((window as any).showToast) {
                                                    (window as any).showToast('Connection cancelled', 'info');
                                                }
                                            }}
                                            className="w-full px-3 py-1.5 rounded-md bg-zinc-700/50 hover:bg-zinc-600/50 text-zinc-300 text-xs font-medium transition-all flex items-center justify-center gap-1.5"
                                        >
                                            <X size={12} />
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={async () => {
                                            const vcId = vc.id;
                                            setConnectingVcluster(vcId);
                                            setConnectCancelled(false);
                                            setConnectionStatus("Disconnecting from current vcluster...");
                                            try {
                                                // First disconnect from any existing vcluster
                                                try {
                                                    await Promise.race([
                                                        invoke("disconnect_vcluster"),
                                                        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
                                                    ]);
                                                } catch (e) {
                                                    // Ignore - might not be connected to a vcluster
                                                }

                                                setConnectionStatus("Starting vcluster proxy...");

                                                // Simulate progress updates
                                                const statusUpdates = [
                                                    { delay: 500, msg: "Starting vcluster proxy..." },
                                                    { delay: 2000, msg: "Waiting for proxy to initialize..." },
                                                    { delay: 4000, msg: "Configuring kubeconfig..." },
                                                    { delay: 6000, msg: "Verifying API connection..." },
                                                    { delay: 10000, msg: "Establishing secure tunnel..." },
                                                ];

                                                const timeoutIds: ReturnType<typeof setTimeout>[] = [];
                                                statusUpdates.forEach(({ delay, msg }) => {
                                                    const id = setTimeout(() => {
                                                        if (!connectCancelled) setConnectionStatus(msg);
                                                    }, delay);
                                                    timeoutIds.push(id);
                                                });

                                                await invoke("connect_vcluster", { name: vc.name, namespace: vc.namespace });

                                                // Clear timeouts
                                                timeoutIds.forEach(id => clearTimeout(id));

                                                // Check if cancelled while waiting
                                                if (connectCancelled) {
                                                    return;
                                                }
                                                setConnectionStatus("Connected! Loading cluster...");
                                                if ((window as any).showToast) {
                                                    (window as any).showToast(`Connected to vcluster '${vc.name}'`, 'success');
                                                }
                                                // Clear all cached data from host cluster before switching context
                                                qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "current_context" });
                                                // Now invalidate current_context to trigger refetch with new vcluster context
                                                qc.invalidateQueries({ queryKey: ["current_context"] });
                                            } catch (err) {
                                                if (!connectCancelled) {
                                                    console.error('vcluster connect error:', err);
                                                    setConnectionStatus("");
                                                    if ((window as any).showToast) {
                                                        (window as any).showToast(`Failed to connect: ${err}`, 'error');
                                                    }
                                                }
                                            } finally {
                                                setConnectingVcluster(null);
                                                setConnectionStatus("");
                                            }
                                        }}
                                        disabled={connectingVcluster !== null}
                                        className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-white text-xs font-medium transition-all ${connectingVcluster !== null
                                            ? 'bg-purple-800/50 cursor-not-allowed'
                                            : 'bg-purple-600/80 hover:bg-purple-500'
                                            }`}
                                    >
                                        <Plug size={14} />
                                        Connect
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {!isInsideVcluster && vclustersLoading && (
                <div className="mt-6 bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
                    <div className="flex items-center gap-2 text-zinc-400">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm">Detecting virtual clusters...</span>
                    </div>
                </div>
            )}
        </div>
    );
}
