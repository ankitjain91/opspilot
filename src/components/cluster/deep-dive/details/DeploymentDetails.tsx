
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { Package } from 'lucide-react';
import { CollapsibleSection } from '../shared';

interface DeploymentDetailsProps {
    fullObject: any;
    currentContext?: string;
}

export function DeploymentDetails({ fullObject, currentContext }: DeploymentDetailsProps) {
    const spec = fullObject?.spec || {};
    const status = fullObject?.status || {};
    const metadata = fullObject?.metadata || {};

    const replicas = spec.replicas ?? 1;
    const strategy = spec.strategy?.type || 'RollingUpdate';
    const rollingUpdate = spec.strategy?.rollingUpdate;
    const selector = spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ') : '-';
    const tplContainers = spec.template?.spec?.containers || [];
    const initContainers = spec.template?.spec?.initContainers || [];
    const namespace = fullObject?.metadata?.namespace;
    const deploymentName = fullObject?.metadata?.name;
    const matchLabels = spec.selector?.matchLabels || {};
    const qc = useQueryClient();
    const [isScaling, setIsScaling] = useState(false);

    const handleScale = async (newReplicas: number) => {
        if (newReplicas < 0 || !namespace || !deploymentName) return;
        setIsScaling(true);
        try {
            await invoke("scale_deployment", { namespace, name: deploymentName, replicas: newReplicas });
            // Refresh the resource details
            await qc.invalidateQueries({ queryKey: ["resource_details"] });
            await qc.invalidateQueries({ queryKey: ["deployment_pods"] });
            if ((window as any).showToast) {
                (window as any).showToast(`Scaled to ${newReplicas} replicas`, 'success');
            }
        } catch (err) {
            if ((window as any).showToast) {
                (window as any).showToast(`Scale failed: ${err}`, 'error');
            }
        } finally {
            setIsScaling(false);
        }
    };

    // Fetch pods matching the deployment's selector
    const { data: managedPods } = useQuery({
        queryKey: ["deployment_pods", currentContext, namespace, JSON.stringify(matchLabels)],
        queryFn: async () => {
            if (!namespace || Object.keys(matchLabels).length === 0) return [];
            try {
                const allPods = await invoke<any[]>("list_resources", {
                    req: { group: "", version: "v1", kind: "Pod", namespace }
                });
                // Filter pods that match all selector labels
                return allPods.filter((pod: any) => {
                    const podLabels = pod.labels || {};
                    return Object.entries(matchLabels).every(([key, val]) => podLabels[key] === val);
                });
            } catch { return []; }
        },
        staleTime: 10000,
        refetchInterval: 15000,
    });

    // Status info
    const readyReplicas = status.readyReplicas || 0;
    const availableReplicas = status.availableReplicas || 0;
    const updatedReplicas = status.updatedReplicas || 0;
    const unavailableReplicas = status.unavailableReplicas || 0;
    const conditions = status.conditions || [];

    // Determine rollout status
    // Note: unavailableReplicas is only present in the API response when there are unavailable pods
    const hasUnavailableField = status.unavailableReplicas !== undefined;

    const getRolloutStatus = () => {
        // Primary check: if ready and available match desired and no unavailable field, it's complete
        if (readyReplicas >= replicas && availableReplicas >= replicas && !hasUnavailableField) {
            return { status: 'Complete', color: 'text-green-400', bg: 'bg-green-500/20' };
        }
        // Then check various in-progress states
        if (hasUnavailableField && unavailableReplicas > 0) return { status: 'Progressing', color: 'text-yellow-400', bg: 'bg-yellow-500/20' };
        if (updatedReplicas < replicas) return { status: 'Updating', color: 'text-blue-400', bg: 'bg-blue-500/20' };
        if (readyReplicas < replicas || availableReplicas < replicas) return { status: 'Scaling', color: 'text-orange-400', bg: 'bg-orange-500/20' };
        // Fallback to complete
        return { status: 'Complete', color: 'text-green-400', bg: 'bg-green-500/20' };
    };
    const rolloutStatus = getRolloutStatus();

    // Calculate resource totals
    const parseCpu = (cpu: string) => {
        if (cpu.endsWith('m')) return parseInt(cpu) / 1000;
        return parseFloat(cpu);
    };
    const parseMemory = (mem: string) => {
        const num = parseFloat(mem);
        if (mem.endsWith('Ki')) return num * 1024;
        if (mem.endsWith('Mi')) return num * 1024 * 1024;
        if (mem.endsWith('Gi')) return num * 1024 * 1024 * 1024;
        if (mem.endsWith('Ti')) return num * 1024 * 1024 * 1024 * 1024;
        return num;
    };
    const formatMemory = (bytes: number) => {
        if (bytes === 0) return '-';
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ki`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} Mi`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} Gi`;
    };

    const getResourceTotals = () => {
        let cpuRequest = 0, cpuLimit = 0, memRequest = 0, memLimit = 0;
        tplContainers.forEach((c: any) => {
            const req = c.resources?.requests || {};
            const lim = c.resources?.limits || {};
            if (req.cpu) cpuRequest += parseCpu(req.cpu);
            if (lim.cpu) cpuLimit += parseCpu(lim.cpu);
            if (req.memory) memRequest += parseMemory(req.memory);
            if (lim.memory) memLimit += parseMemory(lim.memory);
        });
        return { cpuRequest, cpuLimit, memRequest, memLimit };
    };
    const resources = getResourceTotals();

    return (
        <CollapsibleSection title="Deployment Spec" icon={<Package size={14} />}>
            <div className="space-y-4 text-xs">
                {/* Rollout Status */}
                <div className="flex flex-wrap gap-3">
                    <div className="px-2 py-1 bg-zinc-900/80 rounded-lg border border-zinc-800/80">
                        <span className="text-zinc-500">Rollout: </span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] ${rolloutStatus.bg} ${rolloutStatus.color}`}>{rolloutStatus.status}</span>
                    </div>
                    <div className="px-2 py-1 bg-zinc-900/80 rounded-lg border border-zinc-800/80">
                        <span className="text-zinc-500">Strategy: </span>
                        <span className="font-mono text-zinc-200">{strategy}</span>
                        {rollingUpdate && (
                            <span className="text-zinc-600 ml-1">
                                (max surge: {rollingUpdate.maxSurge || '25%'}, max unavail: {rollingUpdate.maxUnavailable || '25%'})
                            </span>
                        )}
                    </div>
                </div>

                {/* Replica Status */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-2">Replica Status</h4>
                    <div className="grid grid-cols-4 gap-2">
                        {/* Editable Desired Replicas */}
                        <div className="p-2 bg-zinc-900/80 border border-purple-500/30 rounded-lg text-center relative group">
                            <div className="flex items-center justify-center gap-1">
                                <button
                                    onClick={() => handleScale(replicas - 1)}
                                    disabled={isScaling || replicas <= 0}
                                    className="w-5 h-5 rounded bg-zinc-800 hover:bg-purple-600/50 text-zinc-300 text-xs flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    title="Scale down"
                                >
                                    −
                                </button>
                                <div className={`text-lg font-mono text-purple-400 min-w-[24px] ${isScaling ? 'animate-pulse' : ''}`}>
                                    {isScaling ? '...' : replicas}
                                </div>
                                <button
                                    onClick={() => handleScale(replicas + 1)}
                                    disabled={isScaling}
                                    className="w-5 h-5 rounded bg-zinc-800 hover:bg-purple-600/50 text-zinc-300 text-xs flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    title="Scale up"
                                >
                                    +
                                </button>
                            </div>
                            <div className="text-[9px] text-purple-400/70">Desired</div>
                        </div>
                        <div className="p-2 bg-zinc-900/80 border border-zinc-800/80 rounded-lg text-center">
                            <div className={`text-lg font-mono ${readyReplicas === replicas ? 'text-green-400' : 'text-yellow-400'}`}>{readyReplicas}</div>
                            <div className="text-[9px] text-zinc-600">Ready</div>
                        </div>
                        <div className="p-2 bg-zinc-900/80 border border-zinc-800/80 rounded-lg text-center">
                            <div className={`text-lg font-mono ${updatedReplicas === replicas ? 'text-green-400' : 'text-blue-400'}`}>{updatedReplicas}</div>
                            <div className="text-[9px] text-zinc-600">Updated</div>
                        </div>
                        <div className="p-2 bg-zinc-900/80 border border-zinc-800/80 rounded-lg text-center">
                            <div className={`text-lg font-mono ${availableReplicas === replicas ? 'text-green-400' : 'text-orange-400'}`}>{availableReplicas}</div>
                            <div className="text-[9px] text-zinc-600">Available</div>
                        </div>
                    </div>
                    {/* Progress bar */}
                    <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                            className={`h-full transition-all ${readyReplicas === replicas ? 'bg-green-500' : 'bg-yellow-500'}`}
                            style={{ width: `${(readyReplicas / replicas) * 100}%` }}
                        />
                    </div>
                </div>

                {/* Conditions */}
                {conditions.length > 0 && (
                    <div>
                        <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-2">Conditions</h4>
                        <div className="flex flex-wrap gap-2">
                            {conditions.map((cond: any, i: number) => {
                                const isTrue = cond.status === 'True';
                                return (
                                    <div key={i} className="px-2 py-1 bg-zinc-900/80 border border-zinc-800/80 rounded-lg flex items-center gap-1.5" title={cond.message || cond.reason}>
                                        <span className={`w-1.5 h-1.5 rounded-full ${isTrue ? 'bg-green-500' : 'bg-red-500'}`} />
                                        <span className="text-[10px] text-zinc-200">{cond.type}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Resource Totals (per replica) */}
                {(resources.cpuRequest > 0 || resources.memRequest > 0) && (
                    <div>
                        <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-2">Resources Per Replica</h4>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="p-2 bg-zinc-900/80 border border-zinc-800/80 rounded-lg">
                                <div className="text-[9px] text-zinc-600 mb-1">CPU</div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-zinc-500">Request:</span>
                                    <span className="font-mono text-cyan-400">{resources.cpuRequest > 0 ? `${(resources.cpuRequest * 1000).toFixed(0)}m` : '-'}</span>
                                </div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-zinc-500">Limit:</span>
                                    <span className="font-mono text-orange-400">{resources.cpuLimit > 0 ? `${(resources.cpuLimit * 1000).toFixed(0)}m` : '-'}</span>
                                </div>
                            </div>
                            <div className="p-2 bg-zinc-900/80 border border-zinc-800/80 rounded-lg">
                                <div className="text-[9px] text-zinc-600 mb-1">Memory</div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-zinc-500">Request:</span>
                                    <span className="font-mono text-cyan-400">{formatMemory(resources.memRequest)}</span>
                                </div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-zinc-500">Limit:</span>
                                    <span className="font-mono text-orange-400">{formatMemory(resources.memLimit)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Selector */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Selector</h4>
                    <div className="flex flex-wrap gap-1">
                        {spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => (
                            <span key={k} className="px-1.5 py-0.5 bg-zinc-900/80 border border-zinc-800/80 rounded-lg text-[10px] font-mono text-zinc-200">{k}={String(v)}</span>
                        )) : <span className="text-zinc-500 italic">None</span>}
                    </div>
                </div>

                {/* Template Containers */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Containers ({tplContainers.length})</h4>
                    <div className="space-y-1.5">
                        {tplContainers.map((c: any, i: number) => (
                            <div key={i} className="px-2 py-1.5 bg-zinc-900/80 border border-zinc-800/80 rounded-lg">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-[10px] text-zinc-200 font-bold">{c.name}</span>
                                    <div className="flex items-center gap-1">
                                        {c.ports?.map((p: any, pi: number) => (
                                            <span key={pi} className="px-1 py-0.5 bg-zinc-800 rounded text-[9px] text-zinc-500">{p.containerPort}/{p.protocol || 'TCP'}</span>
                                        ))}
                                    </div>
                                </div>
                                <div className="text-[9px] text-zinc-600 truncate mt-0.5" title={c.image}>{c.image}</div>
                            </div>
                        ))}
                        {tplContainers.length === 0 && <span className="text-zinc-500 italic">No containers</span>}
                    </div>
                </div>

                {/* Init Containers */}
                {initContainers.length > 0 && (
                    <div>
                        <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Init Containers ({initContainers.length})</h4>
                        <div className="flex flex-wrap gap-1.5">
                            {initContainers.map((c: any, i: number) => (
                                <span key={i} className="px-1.5 py-0.5 bg-zinc-900/80 border border-zinc-800/80 rounded-lg text-[10px] font-mono text-purple-400" title={c.image}>{c.name}</span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Managed Pods */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold mb-2">Managed Pods ({managedPods?.length || 0})</h4>
                    {managedPods && managedPods.length > 0 ? (
                        <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                            {managedPods.map((pod: any) => {
                                const podStatus = pod.status || 'Unknown';
                                const isRunning = podStatus === 'Running';
                                const isPending = podStatus === 'Pending' || podStatus === 'ContainerCreating';
                                const isFailed = podStatus === 'Failed' || podStatus === 'Error' || podStatus === 'CrashLoopBackOff';
                                const isTerminating = podStatus === 'Terminating';
                                const restarts = pod.restarts || 0;
                                const age = pod.age || '-';
                                return (
                                    <div key={pod.name} className="px-2 py-1.5 bg-zinc-900/80 border border-zinc-800/80 rounded-lg flex items-center justify-between gap-2 hover:border-zinc-700 transition-colors">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-green-500' : isPending ? 'bg-yellow-500' : isFailed ? 'bg-red-500' : isTerminating ? 'bg-orange-500' : 'bg-zinc-500'}`} />
                                            <span className="font-mono text-[10px] text-zinc-200 truncate" title={pod.name}>{pod.name}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <span className={`px-1.5 py-0.5 rounded text-[9px] ${isRunning ? 'bg-green-500/20 text-green-400' : isPending ? 'bg-yellow-500/20 text-yellow-400' : isFailed ? 'bg-red-500/20 text-red-400' : isTerminating ? 'bg-orange-500/20 text-orange-400' : 'bg-zinc-800 text-zinc-500'}`}>{podStatus}</span>
                                            {restarts > 0 && (
                                                <span className={`px-1 py-0.5 rounded text-[9px] ${restarts > 5 ? 'bg-red-500/20 text-red-400' : restarts > 2 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-zinc-800 text-zinc-500'}`}>↻{restarts}</span>
                                            )}
                                            <span className="text-[9px] text-zinc-600">{age}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="text-zinc-500 italic text-[11px] py-2">No pods found matching selector</div>
                    )}
                </div>
            </div>
        </CollapsibleSection>
    );
}
