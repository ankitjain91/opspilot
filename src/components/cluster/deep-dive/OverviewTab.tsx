import React, { useState } from 'react';
import {
    Activity,
    Box,
    ChevronDown,
    ChevronRight,
    Clock,
    Server,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    Copy,
    List,
    Tag,
    Settings,
    Network,
    Sparkles
} from 'lucide-react';
import { K8sObject, ResourceMetrics, NavResource } from '../../../types/k8s';
import { StatusBadge } from '../../shared/StatusBadge';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { formatAge } from '../../../utils/time';
import { ObjectTree } from './ObjectTree';
import { MetricsChart } from './MetricsChart';
import { ResourceChainCard } from './ResourceChainCard';

// Helper for Copy Button
const CopyButton = ({ value, label }: { value: string, label?: string }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div
            className="flex items-center gap-2 group cursor-pointer hover:bg-white/5 px-2 py-1 rounded transition-colors"
            onClick={handleCopy}
            title="Click to copy"
        >
            <span className="text-zinc-400 text-xs font-medium min-w-[60px]">{label || 'Value'}:</span>
            <span className="text-zinc-200 text-sm font-mono truncate max-w-[200px]">{value}</span>
            <span className={`text-xs ml-auto transition-opacity ${copied ? 'text-emerald-400' : 'text-zinc-500 opacity-0 group-hover:opacity-100'}`}>
                {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
            </span>
        </div>
    );
};



interface OverviewTabProps {
    resource: K8sObject;
    fullObject: any;
    currentContext?: string;
    onViewLogs: () => void;
    onAnalyzeLogs?: (container: string) => void;
    onUpdate: (path: string[], value: any) => Promise<void>;
    onNavigateResource?: (kind: string, name: string, namespace: string, apiVersion?: string) => void;
}

export function OverviewTab({ resource, fullObject, currentContext, onViewLogs, onAnalyzeLogs, onUpdate, onNavigateResource }: OverviewTabProps) {
    const isPod = resource.kind.toLowerCase() === "pod";
    const isWorkload = ['deployment', 'statefulset', 'daemonset', 'replicaset', 'job'].includes(resource.kind.toLowerCase());

    const containers = isPod
        ? (fullObject?.spec?.containers || [])
        : (isWorkload ? (fullObject?.spec?.template?.spec?.containers || []) : []);

    // Auto-expand spec if there are no "smart" cards (like containers) to show
    const [specExpanded, setSpecExpanded] = useState((!isPod && !isWorkload) || containers.length === 0);
    // Auto-expand status for simple resources or if status looks brief
    const [statusExpanded, setStatusExpanded] = useState(!isPod && !isWorkload);

    const conditions = fullObject?.status?.conditions || [];
    const metadata = fullObject?.metadata || {};

    // Calculate Restarts from ContainerStatus
    const containerStatuses = fullObject?.status?.containerStatuses || [];
    const totalRestarts = containerStatuses.reduce((acc: number, cs: any) => acc + (cs.restartCount || 0), 0);

    return (
        <div className="flex flex-col gap-6 pb-20">

            {/* 1. METADATA (Top Section) */}
            <section id="metadata" className="space-y-3">
                <div className="flex items-center gap-2 text-zinc-400 px-1">
                    <Tag size={16} />
                    <h3 className="text-sm font-bold uppercase tracking-wide">Metadata</h3>
                </div>
                <div className="bg-[#18181b] border border-white/5 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                        <CopyButton label="Name" value={resource.name} />
                        <CopyButton label="Namespace" value={resource.namespace} />
                        <CopyButton label="UID" value={metadata.uid || '-'} />
                        <CopyButton label="Created" value={formatAge(resource.age)} />
                        {metadata.ownerReferences?.map((ref: any) => (
                            <CopyButton key={ref.uid} label="Controlled By" value={`${ref.kind}/${ref.name}`} />
                        ))}
                    </div>
                    <div className="space-y-4">
                        {metadata.labels && (
                            <div>
                                <div className="text-[10px] text-zinc-500 mb-2 font-medium">LABELS</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {Object.entries(metadata.labels).map(([k, v]) => (
                                        <div key={k} className="px-2 py-1 bg-black/40 border border-white/10 rounded text-[10px] text-zinc-300 font-mono break-all group hover:border-white/20 transition-colors">
                                            <span className="text-zinc-500">{k}=</span>
                                            <span className="text-zinc-200">{String(v)}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        {metadata.annotations && (
                            <div>
                                <div className="text-[10px] text-zinc-500 mb-2 font-medium">ANNOTATIONS</div>
                                <div className="max-h-[100px] overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-700 pr-2">
                                    <ObjectTree data={metadata.annotations} name="annotations" defaultOpen={false} />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </section>

            {/* 1.5 RESOURCE CHAIN (Relationships) */}
            <ResourceChainCard
                kind={resource.kind}
                name={resource.name}
                namespace={resource.namespace}
                currentContext={currentContext}
                onNavigate={onNavigateResource}
            />

            {/* 2. SPEC (Configuration) */}
            <section id="spec" className="space-y-4">
                <div className="flex items-center gap-2 text-zinc-400 px-1">
                    <Settings size={16} />
                    <h3 className="text-sm font-bold uppercase tracking-wide">Spec</h3>
                </div>

                {/* Containers Card (Pod & Workloads) */}
                {(isPod || isWorkload) && containers.length > 0 && (
                    <div className="bg-[#18181b] border border-white/5 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-4">
                            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Containers ({containers.length})</h4>
                        </div>
                        <div className="grid grid-cols-1 gap-3">
                            {containers.map((c: any) => {
                                const status = containerStatuses.find((cs: any) => cs.name === c.name);
                                const isReady = status?.ready;
                                const state = status?.state?.running ? 'Running' : status?.state?.waiting ? 'Waiting' : status?.state?.terminated ? 'Terminated' : 'Unknown';

                                return (
                                    <div key={c.name} className="bg-black/20 border border-white/5 rounded-lg p-3 flex flex-col gap-2 group hover:border-white/10 transition-colors">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <div className={`w-1.5 h-1.5 rounded-full ${isReady ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-red-500'}`} />
                                                <span className="font-semibold text-zinc-200 text-sm">{c.name}</span>
                                            </div>
                                            <div className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${state === 'Running' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                                                }`}>
                                                {state}
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                            <div className="space-y-1">
                                                <div className="text-zinc-500">Image</div>
                                                <div className="font-mono text-zinc-300 truncate" title={c.image}>{c.image}</div>
                                            </div>
                                            <div className="space-y-1">
                                                <div className="text-zinc-500">Ports</div>
                                                <div className="text-zinc-300">
                                                    {c.ports?.map((p: any) => `${p.containerPort}/${p.protocol}`).join(', ') || 'No ports'}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="pt-2 mt-auto border-t border-white/5 flex gap-2">
                                            {isPod && (
                                                <div className="flex-1 flex gap-2">
                                                    <button
                                                        onClick={onViewLogs}
                                                        className="flex-1 flex items-center justify-center gap-2 px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-[10px] font-medium text-zinc-300 transition-colors"
                                                    >
                                                        <List size={12} /> View Logs
                                                    </button>
                                                    <button
                                                        onClick={() => onAnalyzeLogs?.(c.name)}
                                                        className="flex-1 flex items-center justify-center gap-2 px-2 py-1 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/20 rounded text-[10px] font-medium transition-all"
                                                        title="Analyze logs with Claude AI"
                                                    >
                                                        <Sparkles size={11} className="text-purple-400" /> AI Analyze
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}



                {/* Full Spec Tree */}
                <div className="bg-[#18181b] border border-white/5 rounded-xl overflow-hidden">
                    <button
                        onClick={() => setSpecExpanded(!specExpanded)}
                        className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors group text-left"
                    >
                        <span className="text-xs font-semibold text-zinc-400 group-hover:text-zinc-200">Full Configuration (YAML)</span>
                        <ChevronRight size={14} className={`text-zinc-500 transition-transform ${specExpanded ? 'rotate-90' : ''}`} />
                    </button>
                    {specExpanded && (
                        <div className="p-3 border-t border-white/5 bg-[#0f0f12]">
                            <ObjectTree data={fullObject?.spec || {}} name="spec" expandAll={true} onEdit={onUpdate} />
                        </div>
                    )}
                </div>
            </section >

            {/* 3. STATUS (State & Metrics) */}
            < section id="status" className="space-y-4" >
                <div className="flex items-center gap-2 text-zinc-400 px-1">
                    <Activity size={16} />
                    <h3 className="text-sm font-bold uppercase tracking-wide">Status</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Vital Signs (Metrics) */}
                    {/* Vital Signs (Metrics) */}
                    {(isPod || resource.kind === 'Node') && (
                        <div className="space-y-3">
                            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">Real-time Metrics</h4>
                            <MetricsChart
                                resourceKind={resource.kind}
                                namespace={resource.namespace}
                                name={resource.name}
                                currentContext={currentContext} // Ensure context causes reset
                            />
                        </div>
                    )}

                    {/* Health Summary */}
                    <div className="space-y-3">
                        <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">State</h4>
                        <div className="bg-[#18181b] border border-white/5 rounded-xl p-4 flex flex-col gap-3">
                            <div className="flex items-center justify-between py-1 border-b border-white/5">
                                <span className="text-xs text-zinc-400">Phase</span>
                                <StatusBadge status={resource.status} />
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-white/5">
                                <span className="text-xs text-zinc-400">Restarts</span>
                                <span className={`text-xs font-mono font-bold ${totalRestarts > 0 ? 'text-yellow-400' : 'text-zinc-200'}`}>{totalRestarts}</span>
                            </div>
                            {isPod && (
                                <>
                                    <div className="flex items-center justify-between py-1 border-b border-white/5">
                                        <span className="text-xs text-zinc-400">Pod IP</span>
                                        <CopyButton label="" value={fullObject?.status?.podIP || '-'} />
                                    </div>
                                    <div className="flex items-center justify-between py-1">
                                        <span className="text-xs text-zinc-400">Node</span>
                                        <div className="text-right">
                                            <div className="text-xs text-zinc-200">{fullObject?.spec?.nodeName}</div>
                                            <div className="text-[10px] text-zinc-500">{fullObject?.status?.hostIP}</div>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* Conditions */}
                {
                    conditions.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">Conditions</h4>
                            <div className="bg-[#18181b] border border-white/5 rounded-xl overflow-hidden">
                                {conditions.map((cond: any, i: number) => (
                                    <div key={cond.type} className={`px-4 py-3 flex items-center justify-between ${i !== conditions.length - 1 ? 'border-b border-white/5' : ''}`}>
                                        <div className="flex items-center gap-3">
                                            <div className={`p-1 rounded-full ${cond.status === 'True' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                                {cond.status === 'True' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                                            </div>
                                            <span className="text-sm text-zinc-300 font-medium">{cond.type}</span>
                                        </div>
                                        <div className="flex flex-col items-end gap-0.5">
                                            <span className="text-xs text-zinc-500">{formatAge(cond.lastTransitionTime)} ago</span>
                                            {cond.message && <span className="text-[10px] text-zinc-600 max-w-[300px] truncate" title={cond.message}>{cond.message}</span>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )
                }

                {/* Full Status Tree */}
                <div className="bg-[#18181b] border border-white/5 rounded-xl overflow-hidden">
                    <button
                        onClick={() => setStatusExpanded(!statusExpanded)}
                        className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors group text-left"
                    >
                        <span className="text-xs font-semibold text-zinc-400 group-hover:text-zinc-200">Full Status Details (YAML)</span>
                        <ChevronRight size={14} className={`text-zinc-500 transition-transform ${statusExpanded ? 'rotate-90' : ''}`} />
                    </button>
                    {statusExpanded && (
                        <div className="p-3 border-t border-white/5 bg-[#0f0f12]">
                            <ObjectTree data={fullObject?.status || {}} name="status" expandAll={true} />
                        </div>
                    )}
                </div>
            </section >
        </div >
    );
}
