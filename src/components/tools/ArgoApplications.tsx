import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import {
    GitBranch, CheckCircle2, XCircle, Clock, AlertTriangle, AlertCircle,
    ExternalLink, RefreshCw, Loader2, Server, FolderGit2, GitCommit,
    Target, ArrowRightLeft, History, Layers, ChevronRight, X, Activity,
    Search, Filter, LayoutGrid, List, Box, Trash2
} from 'lucide-react';
import { LoadingScreen } from '../shared/LoadingScreen';
import { K8sObject } from '../../types/k8s';

interface ArgoApplicationsProps {
    currentContext?: string;
    onOpenResource?: (resource: K8sObject) => void;
}

interface ArgoAppDetails {
    // Basic
    name: string;
    namespace: string;
    project: string;

    // Health & Sync
    health: string;
    healthMessage?: string;
    sync: string;
    syncRevision?: string;

    // Source
    repoURL?: string;
    path?: string;
    targetRevision?: string;
    chart?: string;
    helm?: {
        valueFiles?: string[];
        values?: string;
    };

    // Destination
    destServer?: string;
    destNamespace?: string;

    // Status details
    operationState?: {
        phase?: string;
        message?: string;
        startedAt?: string;
        finishedAt?: string;
    };

    // Resources
    resourceCount?: number;
    syncedResources?: number;
    outOfSyncResources?: number;
    resources?: Array<{
        group?: string;
        version: string;
        kind: string;
        namespace?: string;
        name: string;
        status?: string;
        health?: string;
        requiresPruning?: boolean;
    }>;

    // Conditions
    conditions?: Array<{
        type: string;
        message: string;
        lastTransitionTime?: string;
    }>;

    // History
    history?: Array<{
        revision: string;
        deployedAt: string;
        id: number;
    }>;

    // Created
    createdAt?: string;

    // Keep reference to original K8sObject for navigation
    _original: K8sObject;
}

function parseArgoApp(app: K8sObject): ArgoAppDetails {
    const defaults: ArgoAppDetails = {
        name: app.name,
        namespace: app.namespace || 'argocd',
        project: 'default',
        health: 'Unknown',
        sync: 'Unknown',
        _original: app,
    };

    try {
        if (!app.raw_json) return defaults;
        const parsed = JSON.parse(app.raw_json);

        const spec = parsed?.spec || {};
        const status = parsed?.status || {};
        const metadata = parsed?.metadata || {};

        // Count resources by sync status
        const resources = status?.resources || [];
        const syncedResources = resources.filter((r: any) => r.status === 'Synced').length;
        const outOfSyncResources = resources.filter((r: any) => r.status === 'OutOfSync').length;

        return {
            name: app.name,
            namespace: app.namespace || metadata?.namespace || 'argocd',
            project: spec?.project || 'default',

            // Health & Sync
            health: status?.health?.status || 'Unknown',
            healthMessage: status?.health?.message,
            sync: status?.sync?.status || 'Unknown',
            syncRevision: status?.sync?.revision,

            // Source
            repoURL: spec?.source?.repoURL || spec?.sources?.[0]?.repoURL,
            path: spec?.source?.path || spec?.sources?.[0]?.path,
            targetRevision: spec?.source?.targetRevision || spec?.sources?.[0]?.targetRevision || 'HEAD',
            chart: spec?.source?.chart || spec?.sources?.[0]?.chart,
            helm: spec?.source?.helm || spec?.sources?.[0]?.helm,

            // Destination
            destServer: spec?.destination?.server || 'https://kubernetes.default.svc',
            destNamespace: spec?.destination?.namespace,

            // Operation State
            operationState: status?.operationState ? {
                phase: status.operationState.phase,
                message: status.operationState.message,
                startedAt: status.operationState.startedAt,
                finishedAt: status.operationState.finishedAt,
            } : undefined,

            // Resources
            resourceCount: resources.length,
            syncedResources,
            outOfSyncResources,
            resources: resources.map((r: any) => ({
                group: r.group || '',
                version: r.version || 'v1',
                kind: r.kind,
                namespace: r.namespace,
                name: r.name,
                status: r.status,
                health: r.health?.status,
                requiresPruning: r.requiresPruning,
            })),

            // Conditions
            conditions: status?.conditions?.map((c: any) => ({
                type: c.type,
                message: c.message,
                lastTransitionTime: c.lastTransitionTime,
            })),

            // History
            history: status?.history?.slice(-5).reverse().map((h: any) => ({
                revision: h.revision?.substring(0, 7) || 'unknown',
                deployedAt: h.deployedAt,
                id: h.id,
            })),

            // Created
            createdAt: metadata?.creationTimestamp,

            // Keep original for navigation
            _original: app,
        };
    } catch (e) {
        console.error('Failed to parse Argo app:', e);
        return defaults;
    }
}

function getHealthIcon(health: string) {
    switch (health) {
        case 'Healthy': return CheckCircle2;
        case 'Degraded': return XCircle;
        case 'Progressing': return Clock;
        case 'Suspended': return AlertTriangle;
        case 'Missing': return AlertCircle;
        default: return AlertCircle;
    }
}

function getHealthStyles(health: string) {
    switch (health) {
        case 'Healthy': return { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', glow: 'shadow-emerald-500/20' };
        case 'Degraded': return { color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30', glow: 'shadow-red-500/20' };
        case 'Progressing': return { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30', glow: 'shadow-blue-500/20' };
        case 'Suspended': return { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', glow: 'shadow-amber-500/20' };
        case 'Missing': return { color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/30', glow: 'shadow-purple-500/20' };
        default: return { color: 'text-zinc-400', bg: 'bg-zinc-500/10', border: 'border-zinc-500/30', glow: '' };
    }
}

function getSyncStyles(sync: string) {
    switch (sync) {
        case 'Synced': return { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' };
        case 'OutOfSync': return { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' };
        default: return { color: 'text-zinc-400', bg: 'bg-zinc-500/10', border: 'border-zinc-500/30' };
    }
}

function formatTimeAgo(dateStr?: string): string {
    if (!dateStr) return 'Unknown';
    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 30) return `${diffDays}d ago`;
        return date.toLocaleDateString();
    } catch {
        return 'Unknown';
    }
}

function extractRepoName(url?: string): string {
    if (!url) return 'Unknown';
    try {
        // Handle various git URL formats
        const match = url.match(/\/([^/]+?)(\.git)?$/);
        return match ? match[1] : url;
    } catch {
        return url;
    }
}

export function ArgoApplications({ currentContext, onOpenResource }: ArgoApplicationsProps) {
    const [selectedApp, setSelectedApp] = useState<ArgoAppDetails | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [filterHealth, setFilterHealth] = useState<string>('all');
    const [filterSync, setFilterSync] = useState<string>('all');

    const { data: apps, isLoading, refetch, isRefetching } = useQuery({
        queryKey: ["argo_applications_full", currentContext],
        queryFn: async () => {
            const result = await invoke<K8sObject[]>("list_resources", {
                req: {
                    group: "argoproj.io",
                    version: "v1alpha1",
                    kind: "Application",
                    namespace: null,
                    include_raw: true  // Request full raw_json
                }
            });
            return result.map(parseArgoApp);
        },
        staleTime: 15000,
        refetchInterval: 30000, // Auto-refresh every 30s
    });

    // Filter and search
    const filteredApps = useMemo(() => {
        if (!apps) return [];
        return apps.filter(app => {
            // Search filter
            if (searchQuery) {
                const query = searchQuery.toLowerCase();
                const matchesSearch =
                    app.name.toLowerCase().includes(query) ||
                    app.namespace.toLowerCase().includes(query) ||
                    app.project.toLowerCase().includes(query) ||
                    (app.repoURL?.toLowerCase().includes(query)) ||
                    (app.destNamespace?.toLowerCase().includes(query));
                if (!matchesSearch) return false;
            }
            // Health filter
            if (filterHealth !== 'all' && app.health !== filterHealth) return false;
            // Sync filter
            if (filterSync !== 'all' && app.sync !== filterSync) return false;
            return true;
        });
    }, [apps, searchQuery, filterHealth, filterSync]);

    // Stats
    const stats = useMemo(() => {
        if (!apps) return { total: 0, healthy: 0, degraded: 0, progressing: 0, synced: 0, outOfSync: 0 };
        return {
            total: apps.length,
            healthy: apps.filter(a => a.health === 'Healthy').length,
            degraded: apps.filter(a => a.health === 'Degraded').length,
            progressing: apps.filter(a => a.health === 'Progressing').length,
            synced: apps.filter(a => a.sync === 'Synced').length,
            outOfSync: apps.filter(a => a.sync === 'OutOfSync').length,
        };
    }, [apps]);

    if (isLoading) return <LoadingScreen message="Loading Argo CD Applications..." />;

    return (
        <div className="flex flex-col h-full bg-gradient-to-br from-[#0f0f12] to-[#1a1a1f] text-[#cccccc] relative overflow-hidden">
            {/* Header */}
            <div className="border-b border-white/5 bg-black/20 backdrop-blur-xl shrink-0">
                <div className="flex items-center justify-between px-6 py-4">
                    <div className="flex items-center gap-4">
                        <div className="p-2.5 bg-gradient-to-br from-orange-500/20 to-red-500/20 rounded-xl border border-orange-500/20">
                            <GitBranch size={22} className="text-orange-400" />
                        </div>
                        <div>
                            <h2 className="font-bold text-white text-lg">Argo CD Applications</h2>
                            <p className="text-xs text-zinc-500">GitOps continuous delivery for Kubernetes</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => refetch()}
                            disabled={isRefetching}
                            className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
                        >
                            {isRefetching ? (
                                <Loader2 size={14} className="animate-spin" />
                            ) : (
                                <RefreshCw size={14} />
                            )}
                            Refresh
                        </button>
                    </div>
                </div>

                {/* Stats Bar */}
                <div className="flex items-center gap-6 px-6 pb-4">
                    <div className="flex items-center gap-2">
                        <span className="text-2xl font-bold text-white">{stats.total}</span>
                        <span className="text-xs text-zinc-500 uppercase tracking-wider">Total</span>
                    </div>
                    <div className="h-8 w-px bg-white/10" />
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => setFilterHealth(filterHealth === 'Healthy' ? 'all' : 'Healthy')}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${filterHealth === 'Healthy' ? 'bg-emerald-500/20 ring-1 ring-emerald-500/50' : 'hover:bg-white/5'}`}
                        >
                            <CheckCircle2 size={12} className="text-emerald-400" />
                            <span className="text-emerald-400 font-medium">{stats.healthy}</span>
                            <span className="text-zinc-500">Healthy</span>
                        </button>
                        <button
                            onClick={() => setFilterHealth(filterHealth === 'Degraded' ? 'all' : 'Degraded')}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${filterHealth === 'Degraded' ? 'bg-red-500/20 ring-1 ring-red-500/50' : 'hover:bg-white/5'}`}
                        >
                            <XCircle size={12} className="text-red-400" />
                            <span className="text-red-400 font-medium">{stats.degraded}</span>
                            <span className="text-zinc-500">Degraded</span>
                        </button>
                        <button
                            onClick={() => setFilterHealth(filterHealth === 'Progressing' ? 'all' : 'Progressing')}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${filterHealth === 'Progressing' ? 'bg-blue-500/20 ring-1 ring-blue-500/50' : 'hover:bg-white/5'}`}
                        >
                            <Clock size={12} className="text-blue-400" />
                            <span className="text-blue-400 font-medium">{stats.progressing}</span>
                            <span className="text-zinc-500">Progressing</span>
                        </button>
                    </div>
                    <div className="h-8 w-px bg-white/10" />
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => setFilterSync(filterSync === 'Synced' ? 'all' : 'Synced')}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${filterSync === 'Synced' ? 'bg-emerald-500/20 ring-1 ring-emerald-500/50' : 'hover:bg-white/5'}`}
                        >
                            <ArrowRightLeft size={12} className="text-emerald-400" />
                            <span className="text-emerald-400 font-medium">{stats.synced}</span>
                            <span className="text-zinc-500">Synced</span>
                        </button>
                        <button
                            onClick={() => setFilterSync(filterSync === 'OutOfSync' ? 'all' : 'OutOfSync')}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${filterSync === 'OutOfSync' ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'hover:bg-white/5'}`}
                        >
                            <ArrowRightLeft size={12} className="text-amber-400" />
                            <span className="text-amber-400 font-medium">{stats.outOfSync}</span>
                            <span className="text-zinc-500">OutOfSync</span>
                        </button>
                    </div>
                </div>

                {/* Search & Filters */}
                <div className="flex items-center gap-3 px-6 pb-4">
                    <div className="relative flex-1 max-w-md">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Search applications..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-orange-500/50 focus:border-orange-500/50"
                        />
                    </div>
                    <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1">
                        <button
                            onClick={() => setViewMode('grid')}
                            className={`p-1.5 rounded transition-colors ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}
                        >
                            <LayoutGrid size={16} />
                        </button>
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}
                        >
                            <List size={16} />
                        </button>
                    </div>
                    {(filterHealth !== 'all' || filterSync !== 'all') && (
                        <button
                            onClick={() => { setFilterHealth('all'); setFilterSync('all'); }}
                            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <X size={12} />
                            Clear filters
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6">
                {filteredApps.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 text-[#858585]">
                        <GitBranch size={48} className="mb-4 opacity-20" />
                        <div className="text-lg font-medium mb-1">No applications found</div>
                        <p className="text-sm text-zinc-600">
                            {searchQuery || filterHealth !== 'all' || filterSync !== 'all'
                                ? 'Try adjusting your search or filters'
                                : 'No Argo CD applications in this cluster'}
                        </p>
                    </div>
                ) : viewMode === 'grid' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {filteredApps.map((app) => {
                            const healthStyles = getHealthStyles(app.health);
                            const syncStyles = getSyncStyles(app.sync);
                            const HealthIcon = getHealthIcon(app.health);

                            return (
                                <div
                                    key={`${app.namespace}/${app.name}`}
                                    onClick={() => setSelectedApp(app)}
                                    className={`group relative bg-gradient-to-br from-zinc-900/80 to-zinc-900/40 border ${healthStyles.border} rounded-xl p-4 hover:shadow-lg ${healthStyles.glow} transition-all cursor-pointer hover:scale-[1.02] hover:border-orange-500/50`}
                                >
                                    {/* Health indicator stripe */}
                                    <div className={`absolute top-0 left-0 right-0 h-1 rounded-t-xl ${healthStyles.bg}`} />

                                    {/* Header */}
                                    <div className="flex items-start justify-between mb-3">
                                        <div className="flex items-center gap-2.5">
                                            <div className={`p-1.5 rounded-lg ${healthStyles.bg}`}>
                                                <HealthIcon size={16} className={healthStyles.color} />
                                            </div>
                                            <div>
                                                <h3 className="font-bold text-white text-sm group-hover:text-orange-300 transition-colors">{app.name}</h3>
                                                <p className="text-[10px] text-zinc-500">{app.project}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <span className={`px-2 py-0.5 rounded text-[9px] font-bold border ${healthStyles.bg} ${healthStyles.border} ${healthStyles.color}`}>
                                                {app.health.toUpperCase()}
                                            </span>
                                            <span className={`px-2 py-0.5 rounded text-[9px] font-bold border ${syncStyles.bg} ${syncStyles.border} ${syncStyles.color}`}>
                                                {app.sync.toUpperCase()}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Source Info */}
                                    <div className="space-y-2 mb-3">
                                        <div className="flex items-center gap-2 text-xs">
                                            <FolderGit2 size={12} className="text-zinc-600 shrink-0" />
                                            <span className="text-zinc-400 truncate" title={app.repoURL}>{extractRepoName(app.repoURL)}</span>
                                        </div>
                                        {app.path && (
                                            <div className="flex items-center gap-2 text-xs">
                                                <Layers size={12} className="text-zinc-600 shrink-0" />
                                                <span className="text-zinc-500 truncate">{app.path}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2 text-xs">
                                            <GitCommit size={12} className="text-zinc-600 shrink-0" />
                                            <span className="text-zinc-500 font-mono">{app.targetRevision || 'HEAD'}</span>
                                            {app.syncRevision && (
                                                <span className="text-[10px] text-zinc-600 font-mono">@ {app.syncRevision.substring(0, 7)}</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Destination */}
                                    <div className="flex items-center gap-2 text-xs mb-3 pb-3 border-b border-white/5">
                                        <Target size={12} className="text-zinc-600 shrink-0" />
                                        <span className="text-zinc-500">{app.destNamespace || 'default'}</span>
                                        <ChevronRight size={10} className="text-zinc-700" />
                                        <span className="text-zinc-600 text-[10px] truncate" title={app.destServer}>
                                            {app.destServer?.includes('kubernetes.default') ? 'in-cluster' : app.destServer}
                                        </span>
                                    </div>

                                    {/* Resources & History */}
                                    <div className="flex items-center justify-between text-[10px]">
                                        <div className="flex items-center gap-3">
                                            {app.resourceCount !== undefined && (
                                                <span className="text-zinc-500">
                                                    <span className="text-zinc-300 font-medium">{app.resourceCount}</span> resources
                                                </span>
                                            )}
                                            {app.outOfSyncResources !== undefined && app.outOfSyncResources > 0 && (
                                                <span className="text-amber-400">
                                                    {app.outOfSyncResources} out of sync
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-zinc-600">{formatTimeAgo(app.createdAt)}</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    /* List View */
                    <div className="space-y-2">
                        {filteredApps.map((app) => {
                            const healthStyles = getHealthStyles(app.health);
                            const syncStyles = getSyncStyles(app.sync);
                            const HealthIcon = getHealthIcon(app.health);

                            return (
                                <div
                                    key={`${app.namespace}/${app.name}`}
                                    onClick={() => setSelectedApp(app)}
                                    className="group flex items-center gap-4 bg-zinc-900/50 border border-white/5 rounded-lg p-3 hover:border-orange-500/50 hover:bg-zinc-900/80 transition-all cursor-pointer"
                                >
                                    <div className={`p-2 rounded-lg ${healthStyles.bg}`}>
                                        <HealthIcon size={18} className={healthStyles.color} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-white text-sm group-hover:text-orange-300 transition-colors">{app.name}</span>
                                            <span className="text-[10px] text-zinc-600">in {app.project}</span>
                                        </div>
                                        <div className="flex items-center gap-3 text-xs text-zinc-500">
                                            <span className="flex items-center gap-1">
                                                <FolderGit2 size={10} />
                                                {extractRepoName(app.repoURL)}
                                            </span>
                                            {app.path && (
                                                <span className="flex items-center gap-1">
                                                    <Layers size={10} />
                                                    {app.path}
                                                </span>
                                            )}
                                            <span className="flex items-center gap-1">
                                                <Target size={10} />
                                                {app.destNamespace || 'default'}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className={`px-2 py-1 rounded text-[10px] font-bold border ${healthStyles.bg} ${healthStyles.border} ${healthStyles.color}`}>
                                            {app.health}
                                        </span>
                                        <span className={`px-2 py-1 rounded text-[10px] font-bold border ${syncStyles.bg} ${syncStyles.border} ${syncStyles.color}`}>
                                            {app.sync}
                                        </span>
                                        <span className="text-[10px] text-zinc-600 w-16 text-right">{formatTimeAgo(app.createdAt)}</span>
                                        <ChevronRight size={16} className="text-zinc-600 group-hover:text-orange-400 transition-colors" />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Detail Panel */}
            {selectedApp && (
                <>
                    <div
                        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 animate-in fade-in duration-200"
                        onClick={() => setSelectedApp(null)}
                    />
                    <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-gradient-to-br from-zinc-900 to-zinc-950 border-l border-white/10 z-50 flex flex-col animate-in slide-in-from-right duration-300">
                        {/* Panel Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-black/30">
                            <div className="flex items-center gap-3">
                                <div className={`p-2 rounded-lg ${getHealthStyles(selectedApp.health).bg}`}>
                                    {React.createElement(getHealthIcon(selectedApp.health), { size: 20, className: getHealthStyles(selectedApp.health).color })}
                                </div>
                                <div>
                                    <h3 className="font-bold text-white text-lg">{selectedApp.name}</h3>
                                    <p className="text-xs text-zinc-500">Project: {selectedApp.project}</p>
                                </div>
                            </div>
                            <button
                                onClick={() => setSelectedApp(null)}
                                className="p-2 text-zinc-500 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Panel Content */}
                        <div className="flex-1 overflow-auto p-6 space-y-6">
                            {/* Status Cards */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className={`p-4 rounded-xl border ${getHealthStyles(selectedApp.health).bg} ${getHealthStyles(selectedApp.health).border}`}>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Health</div>
                                    <div className={`text-lg font-bold ${getHealthStyles(selectedApp.health).color}`}>{selectedApp.health}</div>
                                    {selectedApp.healthMessage && (
                                        <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{selectedApp.healthMessage}</p>
                                    )}
                                </div>
                                <div className={`p-4 rounded-xl border ${getSyncStyles(selectedApp.sync).bg} ${getSyncStyles(selectedApp.sync).border}`}>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Sync Status</div>
                                    <div className={`text-lg font-bold ${getSyncStyles(selectedApp.sync).color}`}>{selectedApp.sync}</div>
                                    {selectedApp.syncRevision && (
                                        <p className="text-xs text-zinc-500 mt-1 font-mono">{selectedApp.syncRevision.substring(0, 12)}</p>
                                    )}
                                </div>
                            </div>

                            {/* Source */}
                            <div className="space-y-3">
                                <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                    <FolderGit2 size={14} />
                                    Source
                                </h4>
                                <div className="bg-white/5 rounded-xl p-4 space-y-2">
                                    <div className="flex items-start gap-3">
                                        <span className="text-[10px] text-zinc-600 w-16 shrink-0 uppercase">Repo</span>
                                        <a
                                            href={selectedApp.repoURL}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-sm text-cyan-400 hover:text-cyan-300 break-all flex items-center gap-1"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            {selectedApp.repoURL}
                                            <ExternalLink size={10} />
                                        </a>
                                    </div>
                                    {selectedApp.path && (
                                        <div className="flex items-start gap-3">
                                            <span className="text-[10px] text-zinc-600 w-16 shrink-0 uppercase">Path</span>
                                            <span className="text-sm text-zinc-300">{selectedApp.path}</span>
                                        </div>
                                    )}
                                    <div className="flex items-start gap-3">
                                        <span className="text-[10px] text-zinc-600 w-16 shrink-0 uppercase">Revision</span>
                                        <span className="text-sm text-zinc-300 font-mono">{selectedApp.targetRevision}</span>
                                    </div>
                                    {selectedApp.chart && (
                                        <div className="flex items-start gap-3">
                                            <span className="text-[10px] text-zinc-600 w-16 shrink-0 uppercase">Chart</span>
                                            <span className="text-sm text-zinc-300">{selectedApp.chart}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Destination */}
                            <div className="space-y-3">
                                <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                    <Target size={14} />
                                    Destination
                                </h4>
                                <div className="bg-white/5 rounded-xl p-4 space-y-2">
                                    <div className="flex items-start gap-3">
                                        <span className="text-[10px] text-zinc-600 w-16 shrink-0 uppercase">Server</span>
                                        <span className="text-sm text-zinc-300 break-all">{selectedApp.destServer}</span>
                                    </div>
                                    <div className="flex items-start gap-3">
                                        <span className="text-[10px] text-zinc-600 w-16 shrink-0 uppercase">Namespace</span>
                                        <span className="text-sm text-zinc-300">{selectedApp.destNamespace || 'default'}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Resources */}
                            {selectedApp.resourceCount !== undefined && selectedApp.resourceCount > 0 && (
                                <div className="space-y-3">
                                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                        <Layers size={14} />
                                        Resources
                                    </h4>
                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="bg-white/5 rounded-xl p-3 text-center">
                                            <div className="text-xl font-bold text-white">{selectedApp.resourceCount}</div>
                                            <div className="text-[10px] text-zinc-500 uppercase">Total</div>
                                        </div>
                                        <div className="bg-emerald-500/10 rounded-xl p-3 text-center border border-emerald-500/20">
                                            <div className="text-xl font-bold text-emerald-400">{selectedApp.syncedResources || 0}</div>
                                            <div className="text-[10px] text-zinc-500 uppercase">Synced</div>
                                        </div>
                                        <div className="bg-amber-500/10 rounded-xl p-3 text-center border border-amber-500/20">
                                            <div className="text-xl font-bold text-amber-400">{selectedApp.outOfSyncResources || 0}</div>
                                            <div className="text-[10px] text-zinc-500 uppercase">Out of Sync</div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Managed Resources - Clickable List */}
                            {selectedApp.resources && selectedApp.resources.length > 0 && (
                                <div className="space-y-3">
                                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                        <Box size={14} />
                                        Managed Resources ({selectedApp.resources.length})
                                    </h4>
                                    <div className="space-y-1 max-h-64 overflow-y-auto custom-scrollbar">
                                        {selectedApp.resources.map((res, idx) => {
                                            const resHealthStyles = res.health ? getHealthStyles(res.health) : getHealthStyles('Unknown');
                                            const resSyncStyles = res.status ? getSyncStyles(res.status) : getSyncStyles('Unknown');
                                            const ResHealthIcon = res.health ? getHealthIcon(res.health) : AlertCircle;

                                            return (
                                                <button
                                                    key={idx}
                                                    onClick={() => {
                                                        if (onOpenResource) {
                                                            // Create a K8sObject to navigate to
                                                            const k8sObj: K8sObject = {
                                                                id: `${res.namespace || ''}/${res.kind}/${res.name}`,
                                                                name: res.name,
                                                                namespace: res.namespace || '-',
                                                                kind: res.kind,
                                                                group: res.group || '',
                                                                version: res.version,
                                                                status: res.health || 'Unknown',
                                                                age: '',
                                                            };
                                                            onOpenResource(k8sObj);
                                                            setSelectedApp(null);
                                                        }
                                                    }}
                                                    className="w-full flex items-center gap-3 p-2.5 bg-white/5 hover:bg-white/10 rounded-lg transition-all group text-left"
                                                >
                                                    <div className={`p-1 rounded ${resHealthStyles.bg}`}>
                                                        <ResHealthIcon size={12} className={resHealthStyles.color} />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xs font-medium text-zinc-300 group-hover:text-orange-300 transition-colors truncate">
                                                                {res.name}
                                                            </span>
                                                            {res.requiresPruning && (
                                                                <Trash2 size={10} className="text-red-400 shrink-0" title="Requires Pruning" />
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                                                            <span>{res.kind}</span>
                                                            {res.namespace && <span>• {res.namespace}</span>}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-1.5 shrink-0">
                                                        {res.health && (
                                                            <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${resHealthStyles.bg} ${resHealthStyles.color}`}>
                                                                {res.health}
                                                            </span>
                                                        )}
                                                        {res.status && (
                                                            <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${resSyncStyles.bg} ${resSyncStyles.color}`}>
                                                                {res.status}
                                                            </span>
                                                        )}
                                                        <ChevronRight size={12} className="text-zinc-600 group-hover:text-orange-400" />
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Operation State */}
                            {selectedApp.operationState && (
                                <div className="space-y-3">
                                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                        <Activity size={14} />
                                        Last Operation
                                    </h4>
                                    <div className="bg-white/5 rounded-xl p-4 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm font-medium text-zinc-300">{selectedApp.operationState.phase}</span>
                                            {selectedApp.operationState.finishedAt && (
                                                <span className="text-[10px] text-zinc-500">{formatTimeAgo(selectedApp.operationState.finishedAt)}</span>
                                            )}
                                        </div>
                                        {selectedApp.operationState.message && (
                                            <p className="text-xs text-zinc-500">{selectedApp.operationState.message}</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* History */}
                            {selectedApp.history && selectedApp.history.length > 0 && (
                                <div className="space-y-3">
                                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                        <History size={14} />
                                        Deployment History
                                    </h4>
                                    <div className="space-y-2">
                                        {selectedApp.history.map((h, idx) => (
                                            <div key={h.id} className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
                                                <div className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-400">
                                                    {h.id}
                                                </div>
                                                <div className="flex-1">
                                                    <span className="text-xs font-mono text-zinc-300">{h.revision}</span>
                                                </div>
                                                <span className="text-[10px] text-zinc-500">{formatTimeAgo(h.deployedAt)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Conditions */}
                            {selectedApp.conditions && selectedApp.conditions.length > 0 && (
                                <div className="space-y-3">
                                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                        <AlertCircle size={14} />
                                        Conditions
                                    </h4>
                                    <div className="space-y-2">
                                        {selectedApp.conditions.map((c, idx) => (
                                            <div key={idx} className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                                                <div className="flex items-center justify-between mb-1">
                                                    <span className="text-xs font-medium text-amber-400">{c.type}</span>
                                                    {c.lastTransitionTime && (
                                                        <span className="text-[10px] text-zinc-500">{formatTimeAgo(c.lastTransitionTime)}</span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-zinc-400">{c.message}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Panel Footer */}
                        <div className="px-6 py-4 border-t border-white/10 bg-black/30">
                            <button
                                onClick={() => {
                                    if (onOpenResource && selectedApp._original) {
                                        onOpenResource(selectedApp._original);
                                        setSelectedApp(null);
                                    }
                                }}
                                className="w-full py-2.5 bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-500 hover:to-red-500 text-white font-medium rounded-lg transition-all flex items-center justify-center gap-2"
                            >
                                <ExternalLink size={14} />
                                View Full Details
                            </button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
