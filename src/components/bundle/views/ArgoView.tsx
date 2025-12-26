/**
 * ArgoView - ArgoCD Applications
 */

import { useState, useMemo } from 'react';
import {
    GitBranch, CheckCircle, XCircle, RefreshCw, AlertTriangle,
    Search, ExternalLink, Clock, ChevronDown
} from 'lucide-react';
import { useBundleContext } from '../BundleContext';

type SyncStatus = 'Synced' | 'OutOfSync' | 'Unknown';
type HealthStatus = 'Healthy' | 'Degraded' | 'Progressing' | 'Suspended' | 'Missing' | 'Unknown';

const SYNC_COLORS: Record<SyncStatus, string> = {
    Synced: 'bg-green-500/20 text-green-400 border-green-500/30',
    OutOfSync: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    Unknown: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'
};

const HEALTH_COLORS: Record<HealthStatus, string> = {
    Healthy: 'bg-green-500/20 text-green-400',
    Degraded: 'bg-red-500/20 text-red-400',
    Progressing: 'bg-blue-500/20 text-blue-400',
    Suspended: 'bg-yellow-500/20 text-yellow-400',
    Missing: 'bg-red-500/20 text-red-400',
    Unknown: 'bg-zinc-500/20 text-zinc-400'
};

const HEALTH_ICONS: Record<HealthStatus, any> = {
    Healthy: CheckCircle,
    Degraded: XCircle,
    Progressing: RefreshCw,
    Suspended: Clock,
    Missing: AlertTriangle,
    Unknown: AlertTriangle
};

function ArgoAppCard({ app }: { app: any }) {
    const [expanded, setExpanded] = useState(false);

    const name = app.metadata?.name || 'Unknown';
    const namespace = app.metadata?.namespace || 'argocd';
    const syncStatus: SyncStatus = app.status?.sync?.status || 'Unknown';
    const healthStatus: HealthStatus = app.status?.health?.status || 'Unknown';
    const source = app.spec?.source || {};
    const destination = app.spec?.destination || {};
    const conditions = app.status?.conditions || [];
    const resources = app.status?.resources || [];

    const HealthIcon = HEALTH_ICONS[healthStatus] || AlertTriangle;
    const syncColor = SYNC_COLORS[syncStatus] || SYNC_COLORS.Unknown;
    const healthColor = HEALTH_COLORS[healthStatus] || HEALTH_COLORS.Unknown;

    return (
        <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 overflow-hidden hover:border-zinc-700 transition-colors">
            <div
                className="p-4 cursor-pointer"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-start gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${healthColor}`}>
                        <HealthIcon size={20} className={healthStatus === 'Progressing' ? 'animate-spin' : ''} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-white">{name}</span>
                            <span className={`px-2 py-0.5 rounded text-xs border ${syncColor}`}>
                                {syncStatus}
                            </span>
                            <span className={`px-2 py-0.5 rounded text-xs ${healthColor}`}>
                                {healthStatus}
                            </span>
                        </div>
                        <div className="text-xs text-zinc-500 mt-1">
                            {namespace}
                        </div>
                        <div className="flex gap-4 mt-2 text-xs">
                            <div className="flex items-center gap-1 text-zinc-400">
                                <GitBranch size={12} />
                                <span className="truncate max-w-[150px]">{source.repoURL || 'N/A'}</span>
                            </div>
                            {source.targetRevision && (
                                <div className="text-zinc-500">
                                    rev: {source.targetRevision}
                                </div>
                            )}
                        </div>
                    </div>
                    <ChevronDown
                        size={16}
                        className={`text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                </div>
            </div>

            {expanded && (
                <div className="border-t border-zinc-800 p-4 space-y-4 bg-zinc-900/30">
                    {/* Source & Destination */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="p-3 rounded-lg bg-zinc-800/50">
                            <div className="text-[10px] uppercase text-zinc-500 mb-2">Source</div>
                            <div className="space-y-1 text-xs">
                                <div>
                                    <span className="text-zinc-500">Repo:</span>
                                    <span className="text-zinc-300 ml-1 break-all">{source.repoURL}</span>
                                </div>
                                <div>
                                    <span className="text-zinc-500">Path:</span>
                                    <span className="text-zinc-300 ml-1">{source.path || '/'}</span>
                                </div>
                                <div>
                                    <span className="text-zinc-500">Revision:</span>
                                    <span className="text-zinc-300 ml-1">{source.targetRevision || 'HEAD'}</span>
                                </div>
                            </div>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-800/50">
                            <div className="text-[10px] uppercase text-zinc-500 mb-2">Destination</div>
                            <div className="space-y-1 text-xs">
                                <div>
                                    <span className="text-zinc-500">Server:</span>
                                    <span className="text-zinc-300 ml-1 truncate">{destination.server || 'N/A'}</span>
                                </div>
                                <div>
                                    <span className="text-zinc-500">Namespace:</span>
                                    <span className="text-zinc-300 ml-1">{destination.namespace || 'default'}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Conditions */}
                    {conditions.length > 0 && (
                        <div>
                            <div className="text-[10px] uppercase text-zinc-500 mb-2">Conditions</div>
                            <div className="space-y-1">
                                {conditions.map((c: any, i: number) => (
                                    <div
                                        key={i}
                                        className={`p-2 rounded text-xs ${
                                            c.type === 'SyncError'
                                                ? 'bg-red-500/10 border border-red-500/20'
                                                : 'bg-zinc-800/50'
                                        }`}
                                    >
                                        <span className="font-medium text-zinc-300">{c.type}:</span>
                                        <span className="text-zinc-400 ml-1">{c.message}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Resources Summary */}
                    {resources.length > 0 && (
                        <div>
                            <div className="text-[10px] uppercase text-zinc-500 mb-2">
                                Resources ({resources.length})
                            </div>
                            <div className="grid grid-cols-4 gap-1">
                                {resources.slice(0, 12).map((r: any, i: number) => {
                                    const rHealth = r.health?.status || 'Unknown';
                                    const rHealthColor = HEALTH_COLORS[rHealth as HealthStatus] || HEALTH_COLORS.Unknown;
                                    return (
                                        <div
                                            key={i}
                                            className={`px-2 py-1 rounded text-[10px] ${rHealthColor}`}
                                            title={`${r.kind}/${r.name}`}
                                        >
                                            <span className="truncate block">{r.kind}</span>
                                        </div>
                                    );
                                })}
                                {resources.length > 12 && (
                                    <div className="px-2 py-1 rounded text-[10px] bg-zinc-800 text-zinc-500">
                                        +{resources.length - 12} more
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export function ArgoView() {
    const { argoApps } = useBundleContext();
    const [search, setSearch] = useState('');
    const [filterSync, setFilterSync] = useState<SyncStatus | 'all'>('all');
    const [filterHealth, setFilterHealth] = useState<HealthStatus | 'all'>('all');

    const filteredApps = useMemo(() => {
        return argoApps.filter(app => {
            if (search) {
                const q = search.toLowerCase();
                const name = app.metadata?.name?.toLowerCase() || '';
                const repo = app.spec?.source?.repoURL?.toLowerCase() || '';
                if (!name.includes(q) && !repo.includes(q)) return false;
            }
            if (filterSync !== 'all' && app.status?.sync?.status !== filterSync) return false;
            if (filterHealth !== 'all' && app.status?.health?.status !== filterHealth) return false;
            return true;
        });
    }, [argoApps, search, filterSync, filterHealth]);

    const stats = useMemo(() => ({
        total: argoApps.length,
        synced: argoApps.filter(a => a.status?.sync?.status === 'Synced').length,
        outOfSync: argoApps.filter(a => a.status?.sync?.status === 'OutOfSync').length,
        healthy: argoApps.filter(a => a.status?.health?.status === 'Healthy').length,
        degraded: argoApps.filter(a => a.status?.health?.status === 'Degraded').length
    }), [argoApps]);

    if (argoApps.length === 0) {
        return (
            <div className="p-6">
                <div className="text-center py-16 text-zinc-500">
                    <GitBranch size={48} className="mx-auto mb-4 opacity-30" />
                    <div className="text-lg font-medium text-zinc-400">No ArgoCD Applications</div>
                    <div className="text-sm mt-1">No ArgoCD applications found in this bundle</div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-white">ArgoCD Applications</h2>
                    <p className="text-xs text-zinc-500">
                        {stats.total} apps • {stats.synced} synced • {stats.healthy} healthy
                        {stats.degraded > 0 && ` • ${stats.degraded} degraded`}
                    </p>
                </div>
                <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search applications..."
                        className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500 w-64"
                    />
                </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Sync:</span>
                    {(['all', 'Synced', 'OutOfSync'] as (SyncStatus | 'all')[]).map(s => (
                        <button
                            key={s}
                            onClick={() => setFilterSync(s)}
                            className={`px-2 py-1 rounded text-xs transition-colors ${
                                filterSync === s
                                    ? s === 'Synced' ? 'bg-green-500/20 text-green-400'
                                    : s === 'OutOfSync' ? 'bg-yellow-500/20 text-yellow-400'
                                    : 'bg-purple-600 text-white'
                                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                            }`}
                        >
                            {s === 'all' ? 'All' : s}
                        </button>
                    ))}
                </div>
                <div className="h-4 w-px bg-zinc-700" />
                <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Health:</span>
                    {(['all', 'Healthy', 'Degraded', 'Progressing'] as (HealthStatus | 'all')[]).map(h => (
                        <button
                            key={h}
                            onClick={() => setFilterHealth(h)}
                            className={`px-2 py-1 rounded text-xs transition-colors ${
                                filterHealth === h
                                    ? h === 'Healthy' ? 'bg-green-500/20 text-green-400'
                                    : h === 'Degraded' ? 'bg-red-500/20 text-red-400'
                                    : h === 'Progressing' ? 'bg-blue-500/20 text-blue-400'
                                    : 'bg-purple-600 text-white'
                                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                            }`}
                        >
                            {h === 'all' ? 'All' : h}
                        </button>
                    ))}
                </div>
            </div>

            {/* Apps Grid */}
            <div className="grid grid-cols-2 gap-4">
                {filteredApps.map((app, i) => (
                    <ArgoAppCard key={app.metadata?.name || i} app={app} />
                ))}
            </div>

            {filteredApps.length === 0 && (
                <div className="text-center py-12 text-zinc-500">
                    <GitBranch size={32} className="mx-auto mb-2 opacity-50" />
                    No applications match your filters
                </div>
            )}
        </div>
    );
}
