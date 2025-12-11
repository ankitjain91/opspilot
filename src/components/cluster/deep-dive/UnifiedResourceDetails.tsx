import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    Activity, Box, Network,
    CheckCircle2, AlertCircle, RefreshCw,
    Search, Tag, Settings,
    Loader2, Info, ArrowUp, ArrowDown, Play, Gauge, RotateCcw,
    ChevronUp, ChevronDown, ChevronsUp, ChevronsDown,
    LayoutDashboard, ScrollText
} from 'lucide-react';
import { MetricsChart } from './MetricsChart';
import { ObjectTree } from './ObjectTree';
import { ConfigMapDetails } from './ConfigMapDetails';
import { SecretDetails } from './SecretDetails';
import { LogsTab } from './LogsTab';
import { useToast } from '../../ui/Toast';
import { K8sObject } from '../../../types/k8s';

// --- Shared Types & Helpers ---

const getStatusColor = (status?: string) => {
    switch (status) {
        case 'Running': return 'bg-emerald-500';
        case 'Pending': return 'bg-yellow-500';
        case 'Failed': return 'bg-red-500';
        case 'Succeeded': return 'bg-cyan-500';
        default: return 'bg-zinc-500';
    }
};

const findMatches = (data: any, term: string, prefix = ''): string[] => {
    if (!data || !term) return [];
    let matches: string[] = [];
    const lowerTerm = term.toLowerCase();

    if (typeof data === 'object' && data !== null) {
        // Handle Date
        if (data instanceof Date) {
            if (data.toISOString().toLowerCase().includes(lowerTerm)) {
                matches.push(prefix);
            }
            return matches;
        }

        if (Array.isArray(data)) {
            data.forEach((item, index) => {
                matches = matches.concat(findMatches(item, term, `${prefix ? prefix + '.' : ''}${index}`));
            });
        } else {
            Object.keys(data).forEach(key => {
                const path = prefix ? `${prefix}.${key}` : key;
                // Match Key
                if (key.toLowerCase().includes(lowerTerm)) {
                    matches.push(path);
                }
                // Match Value (Recurse)
                matches = matches.concat(findMatches(data[key], term, path));
            });
        }
    } else {
        // Primitive
        if (String(data).toLowerCase().includes(lowerTerm)) {
            matches.push(prefix);
        }
    }
    return matches;
};

// Highlight helper for custom non-tree views (Labels)
const Highlight = ({ text, term, isActive }: { text: string, term?: string, isActive?: boolean }) => {
    if (!term || !text.toLowerCase().includes(term.toLowerCase())) {
        return <span>{text}</span>;
    }

    const parts = text.split(new RegExp(`(${term})`, 'gi'));
    return (
        <span>
            {parts.map((part, i) =>
                part.toLowerCase() === term.toLowerCase() ? (
                    <span key={i} className={`${isActive ? 'bg-yellow-500 text-black' : 'bg-yellow-500/30 text-yellow-200'} rounded-[1px] px-0.5`}>{part}</span>
                ) : (
                    <span key={i}>{part}</span>
                )
            )}
        </span>
    );
};

// --- Main Component ---

interface UnifiedDetailsProps {
    resource: K8sObject;
    fullObject: any;
    currentContext?: string;
    loading: boolean;
}

export function UnifiedResourceDetails({ resource, fullObject, currentContext, loading }: UnifiedDetailsProps) {
    const [activeContainer, setActiveContainer] = useState<string>('');
    const [searchTerm, setSearchTerm] = useState("");
    const [expandAll, setExpandAll] = useState<boolean>(false);
    const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(-1);
    const [optimisticReplicas, setOptimisticReplicas] = useState<number | null>(null);
    const [activeTab, setActiveTab] = useState<'overview' | 'logs'>('overview');
    const containerRef = useRef<string>(''); // Ref to track active container for logs without re-rendering everything

    // Data Extraction (Move up to ensure hooks run)
    const spec = fullObject?.spec || {};
    const status = fullObject?.status || {};
    const metadata = fullObject?.metadata || {};

    // Pod Specifics
    const containers = spec.containers || [];
    const initContainers = spec.initContainers || [];
    const allContainers = useMemo(() => [...containers, ...initContainers], [containers, initContainers]);

    // Sync optimistic replicas with real spec when spec changes
    useEffect(() => {
        if (spec.replicas !== undefined) {
            setOptimisticReplicas(spec.replicas);
        }
    }, [spec.replicas]);

    // Auto-select first container (Move up to ensure hooks run)
    useEffect(() => {
        if (allContainers.length > 0 && !activeContainer) {
            setActiveContainer(allContainers[0].name);
            containerRef.current = allContainers[0].name;
        }
    }, [allContainers, activeContainer]);

    // Search Logic
    const matchingPaths = useMemo(() => {
        if (!searchTerm) return [];
        // Search fullObject to get comprehensive paths
        // We use fullObject so paths are relative to root (metadata..., spec..., status...)
        return findMatches(fullObject, searchTerm);
    }, [fullObject, searchTerm]);

    const matchingPathsSet = useMemo(() => new Set(matchingPaths), [matchingPaths]);

    useEffect(() => {
        if (matchingPaths.length > 0) {
            setCurrentMatchIndex(0);
        } else {
            setCurrentMatchIndex(-1);
        }
    }, [matchingPaths.length]);

    const nextMatch = () => {
        if (matchingPaths.length === 0) return;
        setCurrentMatchIndex(prev => (prev + 1) % matchingPaths.length);
    };

    const prevMatch = () => {
        if (matchingPaths.length === 0) return;
        setCurrentMatchIndex(prev => (prev - 1 + matchingPaths.length) % matchingPaths.length);
    };

    const activePath = currentMatchIndex >= 0 ? matchingPaths[currentMatchIndex] : null;

    // Routing Logic for Specialized Views
    const kind = resource.kind.toLowerCase();

    // ConfigMap
    if (kind === 'configmap' && !loading) {
        return <ConfigMapDetails resource={resource} fullObject={fullObject} />;
    }

    // Secret
    if (kind === 'secret' && !loading) {
        return <SecretDetails resource={resource} fullObject={fullObject} />;
    }

    // Workload Actions Logic
    const kindLower = kind.toLowerCase();
    const canRestart = kindLower === 'deployment' || kindLower === 'statefulset' || kindLower === 'daemonset';
    const canScale = kindLower === 'deployment' || kindLower === 'statefulset';
    const isWorkload = canRestart; // Restore for legacy compatibility/safety

    // Legacy support (ensure kind is lowercased for checks above if not already)
    // Actually 'kind' variable from line 164 is already lowercased.

    const [isRestarting, setIsRestarting] = useState(false);

    // ...

    // Toast hook
    const { showToast, dismissToast } = useToast();

    const handleScale = async (limit: number) => {
        // Default to 1 if undefined (Kubernetes default)
        const current = spec.replicas ?? 1;
        const newReplicas = Math.max(0, current + limit);

        const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;

        const toastId = showToast(`Scaling to ${newReplicas} replicas...`, 'loading', 0); // 0 = indefinite

        try {
            setOptimisticReplicas(newReplicas);

            const patchPayload = {
                apiVersion: apiVersion,
                kind: resource.kind,
                spec: { replicas: newReplicas }
            };

            await invoke("patch_resource", {
                namespace: resource.namespace,
                kind: resource.kind,
                name: resource.name,
                apiVersion: apiVersion,
                patchData: patchPayload
            });

            dismissToast(toastId);
            showToast(`Scaled to ${newReplicas} replicas`, 'success');

        } catch (e) {
            console.error("Scale failed", e);
            dismissToast(toastId);
            showToast(`Scale failed: ${String(e)}`, 'error', 5000);
            setOptimisticReplicas(spec.replicas); // Revert
        }
    };

    const handleRestart = async () => {
        setIsRestarting(true);
        const toastId = showToast('Initiating rollout restart...', 'loading', 0); // Persistent

        try {
            const now = new Date().toISOString();
            const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;

            const patchPayload = {
                apiVersion: apiVersion,
                kind: resource.kind,
                spec: {
                    template: {
                        metadata: {
                            annotations: { "kubectl.kubernetes.io/restartedAt": now }
                        }
                    }
                }
            };

            await invoke("patch_resource", {
                namespace: resource.namespace,
                kind: resource.kind,
                name: resource.name,
                apiVersion: apiVersion,
                patchData: patchPayload
            });

            dismissToast(toastId);
            setIsRestarting(false);
            showToast('Restart initiated successfully', 'success');

        } catch (e) {
            console.error("Restart failed", e);
            dismissToast(toastId);
            showToast(`Restart failed: ${String(e)}`, 'error', 5000);
            setIsRestarting(false);
        }
    };



    // Generic Patch Handler for ObjectTree
    const handlePatch = async (path: string[], value: any) => {
        // Construct nested patch object
        const patch: any = {};
        let current = patch;
        for (let i = 0; i < path.length - 1; i++) {
            current[path[i]] = {};
            current = current[path[i]];
        }
        current[path[path.length - 1]] = value;

        try {
            // Construct proper apiVersion
            const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;

            await invoke("patch_resource", {
                namespace: resource.namespace,
                kind: resource.kind,
                name: resource.name,
                apiVersion: apiVersion,
                patchData: patch
            });
            showToast('Property updated successfully', 'success');
        } catch (e) {
            console.error("Patch failed", e);
            showToast(`Patch failed: ${String(e)}`, 'error');
        }
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center space-y-4 flex-col text-zinc-500">
                <Loader2 size={32} className="animate-spin text-cyan-500" />
                <span className="text-xs tracking-widest uppercase">Loading Resources...</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-[#0f0f12]">
            {/* Top Stats Bar - Quick Insight */}
            <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-px bg-white/5 border-b border-white/5">
                <div className="p-3 bg-[#0f0f12]">
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">Status</div>
                    <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${getStatusColor(resource.status)}`} />
                        <span className="text-sm font-semibold text-white">{resource.status || 'Unknown'}</span>
                    </div>
                </div>
                <div className="p-3 bg-[#0f0f12]">
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">Namespace</div>
                    <div className="text-sm font-mono text-zinc-300">{resource.namespace}</div>
                </div>
                <div className="p-3 bg-[#0f0f12]">
                    {canScale ? (
                        <>
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">Replicas</div>
                            <div className="flex items-center gap-3">
                                <span className="text-sm font-bold text-white">
                                    {status.readyReplicas || 0}/{optimisticReplicas ?? spec.replicas ?? 0}
                                </span>
                                <div className="flex items-center bg-white/5 rounded border border-white/10">
                                    <button onClick={() => handleScale(-1)} className="p-1 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors" title="Scale Down">
                                        <ArrowDown size={14} />
                                    </button>
                                    <div className="w-px h-3 bg-white/10" />
                                    <button onClick={() => handleScale(1)} className="p-1 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors" title="Scale Up">
                                        <ArrowUp size={14} />
                                    </button>
                                </div>
                            </div>
                        </>
                    ) : kind === 'pod' ? (
                        <div className="h-full flex items-center">
                            <div className="flex bg-black/40 p-1 rounded-lg border border-white/10">
                                <button
                                    onClick={() => setActiveTab('overview')}
                                    className={`flex items-center gap-2 px-3 py-1 rounded-md text-xs font-medium transition-all ${activeTab === 'overview' ? 'bg-cyan-500/10 text-cyan-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                                >
                                    <LayoutDashboard size={14} />
                                    Overview
                                </button>
                                <button
                                    onClick={() => setActiveTab('logs')}
                                    className={`flex items-center gap-2 px-3 py-1 rounded-md text-xs font-medium transition-all ${activeTab === 'logs' ? 'bg-cyan-500/10 text-cyan-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                                >
                                    <ScrollText size={14} />
                                    Logs
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold mb-1">Created</div>
                            <div className="text-sm font-mono text-zinc-300">
                                {metadata.creationTimestamp ? new Date(metadata.creationTimestamp).toLocaleDateString() : '-'}
                            </div>
                        </>
                    )}
                </div>

                {/* Actions & Search */}
                <div className="p-2 bg-[#0f0f12] flex items-center gap-2 min-w-[400px]">
                    {canRestart && (
                        <button
                            onClick={handleRestart}
                            disabled={isRestarting}
                            className="flex items-center gap-1.5 px-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-medium text-zinc-300 hover:text-white transition-colors h-[30px] disabled:opacity-50"
                            title="Rollout Restart"
                        >
                            <RotateCcw size={12} className={isRestarting ? "animate-spin" : ""} />
                            {isRestarting ? "Restarting..." : "Restart"}
                        </button>
                    )}

                    {activeTab === 'overview' && (
                        <div className="relative flex-1 flex items-center gap-2">
                            <div className="relative flex-1">
                                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
                                <input
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    placeholder="Search..."
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            if (e.shiftKey) prevMatch();
                                            else nextMatch();
                                        }
                                    }}
                                    className="w-full bg-black/20 border border-white/10 rounded-lg pl-7 pr-16 h-[30px] text-xs text-zinc-200 focus:outline-none focus:border-cyan-500/50 transition-all placeholder:text-zinc-600"
                                />
                                {searchTerm && matchingPaths.length > 0 && (
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 font-mono">
                                        {currentMatchIndex + 1}/{matchingPaths.length}
                                    </span>
                                )}
                                {searchTerm && matchingPaths.length === 0 && (
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-red-500/50 font-mono">
                                        0/0
                                    </span>
                                )}
                            </div>

                            <div className="flex items-center gap-px bg-white/5 rounded-lg border border-white/10 overflow-hidden">
                                <button
                                    onClick={prevMatch}
                                    disabled={matchingPaths.length === 0}
                                    className="w-[26px] h-[30px] flex items-center justify-center hover:bg-white/10 text-zinc-400 disabled:opacity-30 disabled:hover:bg-transparent"
                                >
                                    <ChevronUp size={14} />
                                </button>
                                <div className="w-px h-3 bg-white/10" />
                                <button
                                    onClick={nextMatch}
                                    disabled={matchingPaths.length === 0}
                                    className="w-[26px] h-[30px] flex items-center justify-center hover:bg-white/10 text-zinc-400 disabled:opacity-30 disabled:hover:bg-transparent"
                                >
                                    <ChevronDown size={14} />
                                </button>
                            </div>

                            <button
                                onClick={() => setExpandAll(!expandAll)}
                                className={`w-[30px] h-[30px] flex items-center justify-center hover:bg-white/10 border border-white/10 rounded-lg transition-colors ${expandAll ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' : 'bg-white/5 text-zinc-400'}`}
                                title={expandAll ? "Collapse All" : "Expand All"}
                            >
                                {expandAll ? <ChevronsDown size={14} /> : <ChevronsUp size={14} />}
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Main Content */}
            {activeTab === 'logs' ? (
                <div className="flex-1 overflow-hidden">
                    <LogsTab resource={resource} fullObject={fullObject} />
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto bg-[#0f0f12] p-4 scrollbar-thin scrollbar-thumb-zinc-800">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-7xl mx-auto">
                        {/* Overview Content */}

                        {/* Left Column: Context, Metrics, Metadata */}
                        <div className="flex flex-col gap-6">

                            {/* Metrics */}
                            {(kind === 'pod' || kind === 'node') && (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 text-zinc-300 mb-1">
                                        <Activity size={16} />
                                        <h3 className="text-sm font-bold uppercase tracking-wide">Metrics</h3>
                                    </div>
                                    {/* Use explicit height to prevent crushing, but allow growth */}
                                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3">
                                        <MetricsChart
                                            resourceKind={resource.kind}
                                            namespace={resource.namespace}
                                            name={resource.name}
                                            currentContext={currentContext}
                                            variant="default"
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Containers / Pod Info */}
                            {kind === 'pod' && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between text-zinc-300 mb-1">
                                        <div className="flex items-center gap-2">
                                            <Box size={16} />
                                            <h3 className="text-sm font-bold uppercase tracking-wide">Containers</h3>
                                        </div>
                                        <span className="text-xs bg-white/10 px-2 py-0.5 rounded-full font-bold">{allContainers.length}</span>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        {allContainers.map((c: any) => {
                                            const cStatus = (status.containerStatuses || []).find((s: any) => s.name === c.name)
                                                || (status.initContainerStatuses || []).find((s: any) => s.name === c.name);
                                            const isInit = initContainers.includes(c);

                                            return (
                                                <div key={c.name} className="p-3 rounded-xl border border-white/5 bg-[#18181b] overflow-hidden">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <div className={`w-1.5 h-1.5 rounded-full ${cStatus?.ready ? 'bg-emerald-500' : 'bg-red-500'}`} />
                                                        <span className="text-sm font-medium text-white truncate" title={c.name}>{c.name}</span>
                                                        {isInit && <span className="text-[9px] bg-purple-500/20 text-purple-400 px-1.5 rounded">INIT</span>}
                                                    </div>
                                                    <div className="text-[10px] font-mono text-zinc-500 bg-black/40 rounded px-1.5 py-1 truncate mb-2" title={c.image}>
                                                        {c.image}
                                                    </div>
                                                    <div className="flex flex-wrap gap-2 text-[10px]">
                                                        {cStatus?.restartCount > 0 && (
                                                            <div className="flex items-center gap-1 text-orange-400">
                                                                <RefreshCw size={10} /> {cStatus.restartCount}
                                                            </div>
                                                        )}
                                                        {c.ports && (
                                                            <div className="flex items-center gap-1 text-zinc-400">
                                                                <Network size={10} /> {c.ports.length} ports
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Metadata */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-zinc-300 mb-1">
                                    <Tag size={16} />
                                    <h3 className="text-sm font-bold uppercase tracking-wide">Metadata</h3>
                                </div>
                                <div className="bg-white/5 rounded-xl border border-white/5 p-4 space-y-5">
                                    {metadata.labels && (
                                        <div>
                                            <div className="text-[10px] text-zinc-500 mb-2 font-medium">LABELS</div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {Object.entries(metadata.labels).map(([k, v]) => {
                                                    // Always show all labels, just highlight
                                                    // Construct path for this label to match global search
                                                    const labelPath = `metadata.labels.${k}`;
                                                    const isActive = activePath === labelPath;
                                                    const ref = isActive ? (el: HTMLDivElement) => el?.scrollIntoView({ behavior: 'smooth', block: 'center' }) : undefined;

                                                    return (
                                                        <div key={k} ref={ref} className={`px-2 py-1 bg-black/40 border ${isActive ? 'border-yellow-500/50 bg-yellow-500/10' : 'border-white/10'} rounded text-[10px] text-zinc-300 font-mono break-all transition-colors`}>
                                                            <span className="text-zinc-500">
                                                                <Highlight text={k} term={searchTerm} isActive={isActive} />=
                                                            </span>
                                                            <Highlight text={String(v)} term={searchTerm} isActive={isActive} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    <div className="pt-2 border-t border-white/5">
                                        <div className="text-[10px] text-zinc-500 mb-2 font-medium">DETAILS</div>
                                        <ObjectTree
                                            data={{ ...metadata, labels: undefined, managedFields: undefined, annotations: undefined }}
                                            searchTerm={searchTerm}
                                            matchPaths={matchingPathsSet}
                                            activePath={activePath}
                                            expandAll={expandAll}
                                            path={['metadata']} // Prefix paths with 'metadata'
                                        />
                                    </div>

                                    {metadata.annotations && (
                                        <div className="pt-2 border-t border-white/5">
                                            <div className="text-[10px] text-zinc-500 mb-2 font-medium">ANNOTATIONS</div>
                                            <ObjectTree
                                                data={metadata.annotations}
                                                name="annotations"
                                                path={['metadata']} // Result path: metadata.annotations...
                                                searchTerm={searchTerm}
                                                matchPaths={matchingPathsSet}
                                                activePath={activePath}
                                                defaultOpen={false}
                                                expandAll={expandAll}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Conditions */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-zinc-300 mb-1">
                                    <CheckCircle2 size={16} />
                                    <h3 className="text-sm font-bold uppercase tracking-wide">Conditions</h3>
                                </div>
                                <div className="grid grid-cols-1 gap-2">
                                    {(status.conditions || []).map((c: any, i: number) => {
                                        const isTrue = c.status === 'True';
                                        return (
                                            <div key={i} className={`flex items-start gap-3 p-3 rounded-lg border ${isTrue ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                                                {isTrue ? <CheckCircle2 size={14} className="text-emerald-500 mt-0.5" /> : <AlertCircle size={14} className="text-red-500 mt-0.5" />}
                                                <div>
                                                    <div className={`text-xs font-medium ${isTrue ? 'text-emerald-400' : 'text-red-400'}`}>{c.type}</div>
                                                    <div className="text-[10px] text-zinc-400 mt-1 space-y-0.5">
                                                        {c.reason && <div>Reason: {c.reason}</div>}
                                                        {c.message && <div className="leading-tight">{c.message}</div>}
                                                        <div className="text-zinc-600">{String(c.lastTransitionTime)}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        {/* Right Column: Spec & Status Trees */}
                        <div className="flex flex-col gap-6">
                            {/* Configuration (Spec) */}
                            <div className="space-y-3">
                                <div className="flex items-center justify-between text-zinc-400">
                                    <div className="flex items-center gap-2">
                                        <Settings size={16} />
                                        <h3 className="text-sm font-bold uppercase tracking-wide">Configuration</h3>
                                    </div>
                                    <div className="text-[9px] bg-white/5 px-2 py-0.5 rounded text-zinc-500">
                                        Click values to edit
                                    </div>
                                </div>
                                <div className="bg-[#0f0f12] rounded-xl border border-white/5 p-3 overflow-hidden min-h-[200px] relative">
                                    <ObjectTree
                                        data={spec}
                                        searchTerm={searchTerm}
                                        name="spec"
                                        onEdit={handlePatch}
                                        matchPaths={matchingPathsSet}
                                        activePath={activePath}
                                        expandAll={expandAll}
                                    />
                                </div>
                            </div>

                            {/* Status Details */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-zinc-400">
                                    <Info size={14} />
                                    <h3 className="text-sm font-bold uppercase tracking-wide">Status Details</h3>
                                </div>
                                <div className="bg-[#0f0f12] rounded-xl border border-white/5 p-3 overflow-hidden">
                                    <ObjectTree
                                        data={status}
                                        searchTerm={searchTerm}
                                        name="status"
                                        defaultOpen={true}
                                        matchPaths={matchingPathsSet}
                                        activePath={activePath}
                                        expandAll={expandAll}
                                    />
                                </div>
                            </div>
                        </div>

                    </div>
                </div>
            )}
        </div>
    );
}
