import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    CheckCircle2, RefreshCw, Loader2,
    ChevronDown, ChevronRight, Search, Layers,
    AlertTriangle, XCircle, Clock, Filter,
    Zap, ExternalLink, Info
} from 'lucide-react';
import { getAgentServerUrl } from '../../utils/config';
import { createLogger } from '../../utils/logger';

const log = createLogger('CustomResourceHealth');

// Types
interface CRInstance {
    name: string;
    namespace: string;
    kind: string;
    group: string;
    version: string;
    status: 'Healthy' | 'Degraded' | 'Progressing' | 'Unknown';
    message: string;
}

interface CRDSummary {
    name: string;
    group: string;
    kind: string;
    version: string;
    total: number;
    healthy: number;
    degraded: number;
    progressing: number;
    unknown: number;
    instances: CRInstance[];
}

interface GroupSummary {
    group: string;
    label: string;
    color: string;
    icon: string;
    crds: CRDSummary[];
    totalInstances: number;
    healthyInstances: number;
    degradedInstances: number;
}

interface DashboardData {
    status: 'complete' | 'scanning' | 'discovering' | 'starting' | 'empty' | 'error';
    phase?: string;
    currentCRD?: string;
    groups: GroupSummary[];
    totalCRDs: number;
    scannedCRDs: number;
    totalInstances: number;
    healthyInstances: number;
    degradedInstances: number;
    progressingInstances: number;
    error?: string;
}

// Status helpers
const getStatusIcon = (status: string) => {
    switch (status) {
        case 'Healthy': return CheckCircle2;
        case 'Degraded': return XCircle;
        case 'Progressing': return Clock;
        default: return AlertTriangle;
    }
};

const getStatusColor = (status: string) => {
    switch (status) {
        case 'Healthy': return 'text-emerald-400';
        case 'Degraded': return 'text-rose-400';
        case 'Progressing': return 'text-amber-400';
        default: return 'text-zinc-400';
    }
};

const getStatusBg = (status: string) => {
    switch (status) {
        case 'Healthy': return 'bg-emerald-500/10 border-emerald-500/20';
        case 'Degraded': return 'bg-rose-500/10 border-rose-500/20';
        case 'Progressing': return 'bg-amber-500/10 border-amber-500/20';
        default: return 'bg-zinc-500/10 border-zinc-500/20';
    }
};

// Mini health indicator dots
function HealthDots({ healthy, degraded, progressing, unknown }: { healthy: number; degraded: number; progressing: number; unknown: number }) {
    const total = healthy + degraded + progressing + unknown;
    if (total === 0) return null;

    return (
        <div className="flex items-center gap-0.5">
            {degraded > 0 && <div className="w-2 h-2 rounded-full bg-rose-500" title={`${degraded} degraded`} />}
            {progressing > 0 && <div className="w-2 h-2 rounded-full bg-amber-500" title={`${progressing} progressing`} />}
            {healthy > 0 && <div className="w-2 h-2 rounded-full bg-emerald-500" title={`${healthy} healthy`} />}
            {unknown > 0 && <div className="w-2 h-2 rounded-full bg-zinc-500" title={`${unknown} unknown`} />}
        </div>
    );
}

// Main component
export function CustomResourceHealth({
    currentContext,
    onOpenResource,
    onAutoInvestigate
}: {
    currentContext: string;
    onOpenResource?: (kind: string, name: string, namespace: string, apiVersion?: string) => void;
    onAutoInvestigate?: (prompt: string) => void;
}) {
    const [data, setData] = useState<DashboardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [expandedCRDs, setExpandedCRDs] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'issues'>('all');

    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const currentContextRef = useRef(currentContext);

    // Fetch data
    const fetchData = useCallback(async (forceRefresh = false) => {
        if (currentContextRef.current !== currentContext) return;

        try {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            abortControllerRef.current = new AbortController();

            const url = `${getAgentServerUrl()}/custom-resource-health?kube_context=${encodeURIComponent(currentContext)}${forceRefresh ? '&force_refresh=true' : ''}`;

            const res = await fetch(url, {
                signal: abortControllerRef.current.signal,
                headers: { 'Accept': 'application/json' },
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const json: DashboardData = await res.json();

            if (currentContextRef.current === currentContext) {
                setData(json);
                setError(null);
                setLoading(false);

                const isScanning = ['scanning', 'discovering', 'starting'].includes(json.status);

                if (isScanning && !pollIntervalRef.current) {
                    pollIntervalRef.current = setInterval(() => fetchData(false), 1500);
                } else if (!isScanning && pollIntervalRef.current) {
                    clearInterval(pollIntervalRef.current);
                    pollIntervalRef.current = null;
                }

                // Auto-expand groups with issues
                if (json.status === 'complete' && json.groups) {
                    const groupsWithIssues = json.groups
                        .filter(g => g.degradedInstances > 0)
                        .map(g => g.group);
                    if (groupsWithIssues.length > 0 && groupsWithIssues.length <= 5) {
                        setExpandedGroups(new Set(groupsWithIssues));
                    }
                }
            }
        } catch (e: any) {
            if (e.name === 'AbortError') return;
            if (currentContextRef.current === currentContext) {
                setError(e.message || 'Failed to fetch');
                setLoading(false);
            }
        }
    }, [currentContext]);

    // Context change effect
    useEffect(() => {
        currentContextRef.current = currentContext;
        setData(null);
        setError(null);
        setLoading(true);
        setExpandedGroups(new Set());
        setExpandedCRDs(new Set());

        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }

        fetchData(false);

        return () => {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, [currentContext, fetchData]);

    // Toggle handlers
    const toggleGroup = (group: string) => {
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(group)) next.delete(group);
            else next.add(group);
            return next;
        });
    };

    const toggleCRD = (crdName: string) => {
        setExpandedCRDs(prev => {
            const next = new Set(prev);
            if (next.has(crdName)) next.delete(crdName);
            else next.add(crdName);
            return next;
        });
    };

    // Filter groups
    const filteredGroups = useMemo(() => {
        if (!data?.groups) return [];

        return data.groups
            .map(group => {
                let crds = group.crds;

                if (searchQuery) {
                    const q = searchQuery.toLowerCase();
                    crds = crds.filter(crd =>
                        crd.kind.toLowerCase().includes(q) ||
                        crd.group.toLowerCase().includes(q) ||
                        crd.instances.some(i => i.name.toLowerCase().includes(q))
                    );
                }

                if (statusFilter === 'issues') {
                    crds = crds.filter(crd => crd.degraded > 0 || crd.progressing > 0);
                }

                return { ...group, crds };
            })
            .filter(group => group.crds.length > 0);
    }, [data, searchQuery, statusFilter]);

    // State calculations
    const isScanning = data && ['scanning', 'discovering', 'starting'].includes(data.status);
    const hasData = data && data.groups && data.groups.length > 0;
    const isInitialLoad = loading && !data;
    const issueCount = data ? data.degradedInstances + data.progressingInstances : 0;

    // Error state
    if (error && !data) {
        return (
            <div className="h-full flex items-center justify-center">
                <div className="text-center max-w-sm">
                    <div className="w-12 h-12 rounded-full bg-rose-500/10 flex items-center justify-center mx-auto mb-4">
                        <XCircle className="text-rose-400" size={24} />
                    </div>
                    <h3 className="text-lg font-medium text-zinc-200 mb-2">Failed to load</h3>
                    <p className="text-sm text-zinc-500 mb-4">{error}</p>
                    <button
                        onClick={() => { setLoading(true); setError(null); fetchData(true); }}
                        className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-zinc-300 transition-colors"
                    >
                        <RefreshCw size={14} className="inline mr-2" />
                        Try Again
                    </button>
                </div>
            </div>
        );
    }

    // Scanning Overlay Component
    const ScanningOverlay = () => {
        if (!isScanning) return null;

        const progressPercent = data?.totalCRDs ? (data.scannedCRDs / data.totalCRDs) * 100 : 0;

        return (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-8 transition-all duration-500">
                <div className="w-full max-w-lg bg-zinc-900/90 border border-white/10 rounded-2xl shadow-2xl p-8 backdrop-blur-xl relative overflow-hidden">
                    {/* Background Glow */}
                    <div className="absolute top-0 right-0 w-64 h-64 bg-purple-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                    <div className="absolute bottom-0 left-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2 pointer-events-none" />

                    {/* Header */}
                    <div className="text-center mb-8 relative z-10">
                        <div className="inline-flex items-center justify-center p-3 mb-4 rounded-xl bg-gradient-to-br from-purple-500/20 to-indigo-500/20 border border-purple-500/20 shadow-lg shadow-purple-900/20">
                            <Loader2 size={32} className="animate-spin text-purple-400" />
                        </div>
                        <h2 className="text-2xl font-bold text-white mb-2 tracking-tight">System Scan in Progress</h2>
                        <p className="text-zinc-400">Analyzing cluster topology and custom capabilities...</p>
                    </div>

                    {/* Progress Stats */}
                    <div className="space-y-6 relative z-10">
                        {/* Current Action */}
                        <div className="bg-black/40 rounded-lg p-4 border border-white/5">
                            <div className="flex justify-between text-sm mb-2">
                                <span className="text-zinc-500">Currently Checking:</span>
                                <span className="text-purple-300 font-mono animate-pulse">
                                    {data?.currentCRD || "Initializing..."}
                                </span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-zinc-500">Progress:</span>
                                <span className="text-zinc-300 font-medium">
                                    {data?.scannedCRDs || 0} <span className="text-zinc-600">/</span> {data?.totalCRDs || '?'}
                                </span>
                            </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="relative">
                            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-purple-500 via-fuchsia-500 to-indigo-500 transition-all duration-300 relative"
                                    style={{ width: `${progressPercent}%` }}
                                >
                                    {/* Shimmer Effect */}
                                    <div className="absolute inset-0 bg-white/20 w-full animate-[shimmer_2s_infinite]"
                                        style={{ backgroundImage: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)' }}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Live Findings Pill */}
                        {(data?.degradedInstances || 0) > 0 && (
                            <div className="flex items-center gap-3 px-4 py-3 bg-rose-500/10 border border-rose-500/20 rounded-lg animate-in fade-in slide-in-from-bottom-2 duration-500">
                                <AlertTriangle size={18} className="text-rose-400 shrink-0" />
                                <div className="flex-1">
                                    <span className="text-rose-200 font-medium">Found Issues</span>
                                    <p className="text-xs text-rose-400/80">
                                        Detected {data?.degradedInstances} unhealthy resources so far...
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Expert Tip */}
                        <div className="flex gap-3 px-4 py-3 bg-indigo-500/5 border border-indigo-500/10 rounded-lg">
                            <Info size={16} className="text-indigo-400 shrink-0 mt-0.5" />
                            <div className="space-y-1">
                                <p className="text-xs font-semibold text-indigo-300">Why does this take a moment?</p>
                                <p className="text-xs text-indigo-200/60 leading-relaxed">
                                    We are building a live knowledge graph of every custom extension in your cluster. This happens only once per session to enable instant semantic search later.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="h-full flex flex-col bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 relative">
            <ScanningOverlay />

            {/* Header Bar */}
            <div className="shrink-0 border-b border-white/5 bg-black/20">
                <div className="flex items-center justify-between px-6 py-4">
                    <div className="flex items-center gap-4">
                        <div className="p-2.5 bg-gradient-to-br from-purple-500/20 to-indigo-500/20 rounded-xl border border-purple-500/20">
                            <Layers size={20} className="text-purple-400" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-white">Custom Resources</h2>
                            <p className="text-xs text-zinc-500">CRD health across your cluster</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        {/* Stats Pills */}
                        {data && !isInitialLoad && (
                            <div className="flex items-center gap-2 mr-2">
                                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-800/50 rounded-lg text-xs">
                                    <span className="text-zinc-400">{data.totalCRDs}</span>
                                    <span className="text-zinc-600">CRDs</span>
                                </div>
                                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-800/50 rounded-lg text-xs">
                                    <span className="text-emerald-400">{data.healthyInstances}</span>
                                    <span className="text-zinc-600">healthy</span>
                                </div>
                                {issueCount > 0 && (
                                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-rose-500/10 border border-rose-500/20 rounded-lg text-xs">
                                        <span className="text-rose-400">{issueCount}</span>
                                        <span className="text-rose-400/70">issues</span>
                                    </div>
                                )}
                            </div>
                        )}

                        <button
                            onClick={() => fetchData(true)}
                            disabled={isScanning || isInitialLoad}
                            className="p-2 hover:bg-white/5 rounded-lg text-zinc-400 hover:text-white disabled:opacity-50 transition-colors"
                            title="Refresh"
                        >
                            <RefreshCw size={16} className={isScanning || isInitialLoad ? 'animate-spin' : ''} />
                        </button>
                    </div>
                </div>

                {/* Search & Filters */}
                {(hasData || isScanning) && (
                    <div className="flex items-center gap-3 px-6 pb-4">
                        <div className="relative flex-1 max-w-md">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                            <input
                                type="text"
                                placeholder="Search CRDs or resources..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                            />
                        </div>
                        <button
                            onClick={() => setStatusFilter(statusFilter === 'all' ? 'issues' : 'all')}
                            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all ${statusFilter === 'issues'
                                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                : 'bg-white/5 text-zinc-400 border border-white/10 hover:text-white hover:bg-white/10'
                                }`}
                        >
                            <Filter size={12} />
                            {statusFilter === 'issues' ? 'Showing Issues' : 'Show Issues'}
                        </button>
                    </div>
                )}

                {/* Scanning Progress */}
                {/* REMOVED: Old scanning progress bar in header, replaced by ScanningOverlay */}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto">
                {/* Initial Loading */}
                {isInitialLoad && !isScanning && (
                    <div className="flex items-center justify-center h-64">
                        <Loader2 size={24} className="animate-spin text-purple-400" />
                    </div>
                )}

                {/* Groups List - Compact Tree View */}
                {filteredGroups.length > 0 && (
                    <div className="p-4 space-y-1">
                        {filteredGroups.map(group => {
                            const isGroupExpanded = expandedGroups.has(group.group);
                            const hasIssues = group.degradedInstances > 0;

                            return (
                                <div key={group.group} className="select-none">
                                    {/* Group Header */}
                                    <button
                                        onClick={() => toggleGroup(group.group)}
                                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${hasIssues ? 'hover:bg-rose-500/5' : 'hover:bg-white/5'
                                            }`}
                                    >
                                        <ChevronRight
                                            size={14}
                                            className={`text-zinc-600 transition-transform ${isGroupExpanded ? 'rotate-90' : ''}`}
                                        />
                                        <span className="text-base">{group.icon}</span>
                                        <span className="font-medium text-zinc-200 flex-1">{group.label}</span>
                                        <span className="text-xs text-zinc-600 mr-2">{group.crds.length} types</span>
                                        <HealthDots
                                            healthy={group.healthyInstances}
                                            degraded={group.degradedInstances}
                                            progressing={0}
                                            unknown={0}
                                        />
                                        <span className="text-xs text-zinc-500 ml-2 tabular-nums">{group.totalInstances}</span>
                                    </button>

                                    {/* CRDs within group */}
                                    {isGroupExpanded && (
                                        <div className="ml-4 pl-4 border-l border-zinc-800/50 space-y-0.5 mt-1">
                                            {group.crds.map(crd => {
                                                const isCRDExpanded = expandedCRDs.has(crd.name);
                                                const crdHasIssues = crd.degraded > 0;

                                                return (
                                                    <div key={crd.name}>
                                                        {/* CRD Row */}
                                                        <button
                                                            onClick={() => toggleCRD(crd.name)}
                                                            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-left text-sm transition-colors ${crdHasIssues ? 'hover:bg-rose-500/5' : 'hover:bg-white/5'
                                                                }`}
                                                        >
                                                            <ChevronRight
                                                                size={12}
                                                                className={`text-zinc-700 transition-transform ${isCRDExpanded ? 'rotate-90' : ''}`}
                                                            />
                                                            <span className="text-zinc-300">{crd.kind}</span>
                                                            <span className="text-xs text-zinc-600 truncate flex-1">{crd.group}</span>
                                                            <HealthDots
                                                                healthy={crd.healthy}
                                                                degraded={crd.degraded}
                                                                progressing={crd.progressing}
                                                                unknown={crd.unknown}
                                                            />
                                                            <span className="text-xs text-zinc-600 tabular-nums">{crd.total}</span>
                                                        </button>

                                                        {/* Instances */}
                                                        {isCRDExpanded && crd.instances.length > 0 && (
                                                            <div className="ml-6 pl-4 border-l border-zinc-800/30 py-1 space-y-0.5">
                                                                {crd.instances.slice(0, 50).map((inst) => {
                                                                    const StatusIcon = getStatusIcon(inst.status);
                                                                    return (
                                                                        <div
                                                                            key={`${inst.namespace}/${inst.name}`}
                                                                            className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 group text-xs"
                                                                        >
                                                                            <StatusIcon size={12} className={getStatusColor(inst.status)} />
                                                                            <span
                                                                                className="text-zinc-400 hover:text-white cursor-pointer truncate flex-1"
                                                                                onClick={() => onOpenResource?.(inst.kind, inst.name, inst.namespace, `${inst.group}/${inst.version}`)}
                                                                            >
                                                                                {inst.name}
                                                                            </span>
                                                                            <span className="text-zinc-700 truncate max-w-[120px]">{inst.namespace || 'cluster'}</span>
                                                                            {inst.status === 'Degraded' && onAutoInvestigate && (
                                                                                <button
                                                                                    onClick={(e) => {
                                                                                        e.stopPropagation();
                                                                                        onAutoInvestigate(`Investigate unhealthy ${inst.kind} "${inst.name}" in namespace "${inst.namespace}". Error: ${inst.message}`);
                                                                                    }}
                                                                                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-rose-500/20 rounded text-rose-400 transition-all"
                                                                                    title="Investigate"
                                                                                >
                                                                                    <Zap size={10} />
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })}
                                                                {crd.instances.length > 50 && (
                                                                    <div className="text-xs text-zinc-600 px-2 py-1">
                                                                        +{crd.instances.length - 50} more
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Empty States */}
                {data?.status === 'complete' && !hasData && (
                    <div className="flex items-center justify-center h-64">
                        <div className="text-center">
                            <Layers size={32} className="text-zinc-700 mx-auto mb-3" />
                            <p className="text-zinc-400">No Custom Resources</p>
                            <p className="text-xs text-zinc-600 mt-1">This cluster has no custom CRDs installed</p>
                        </div>
                    </div>
                )}

                {filteredGroups.length === 0 && hasData && (searchQuery || statusFilter === 'issues') && (
                    <div className="flex items-center justify-center h-64">
                        <div className="text-center">
                            <Search size={24} className="text-zinc-700 mx-auto mb-3" />
                            <p className="text-zinc-400">No matches</p>
                            {statusFilter === 'issues' && (
                                <p className="text-xs text-emerald-500 mt-1">All resources are healthy!</p>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
