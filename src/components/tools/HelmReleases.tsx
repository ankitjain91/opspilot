import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import {
    Package, CheckCircle2, XCircle, Clock, AlertTriangle, AlertCircle,
    ExternalLink, RefreshCw, Loader2, FileText, Settings, Code,
    Trash2, ChevronRight, X, History, Search, LayoutGrid, List,
    Info, Tag, Calendar, GitCommit
} from 'lucide-react';
import { LoadingScreen } from '../shared/LoadingScreen';
import { HelmRelease } from '../../types/k8s';
import { formatHelmTimeAgo } from '../../utils/format';

interface HelmReleasesProps {
    currentContext?: string;
}

interface HelmReleaseDetails {
    info: {
        status: string;
        first_deployed: string;
        last_deployed: string;
        deleted: string;
        description: string;
        notes: string;
    };
    manifest: string;
    values: any;
}

function getStatusStyles(status: string) {
    const s = status.toLowerCase();
    if (s === 'deployed') return { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', glow: 'shadow-emerald-500/20' };
    if (s === 'pending-install' || s === 'pending-upgrade' || s === 'pending-rollback') return { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30', glow: 'shadow-blue-500/20' };
    if (s === 'failed') return { color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30', glow: 'shadow-red-500/20' };
    if (s === 'superseded') return { color: 'text-zinc-400', bg: 'bg-zinc-500/10', border: 'border-zinc-500/30', glow: '' };
    if (s === 'uninstalling') return { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', glow: 'shadow-amber-500/20' };
    return { color: 'text-zinc-400', bg: 'bg-zinc-500/10', border: 'border-zinc-500/30', glow: '' };
}

function getStatusIcon(status: string) {
    const s = status.toLowerCase();
    if (s === 'deployed') return CheckCircle2;
    if (s === 'pending-install' || s === 'pending-upgrade' || s === 'pending-rollback') return Clock;
    if (s === 'failed') return XCircle;
    if (s === 'superseded') return History;
    if (s === 'uninstalling') return AlertTriangle;
    return AlertCircle;
}

function formatTimeAgo(dateStr?: string): string {
    return formatHelmTimeAgo(dateStr);
}

function parseChartInfo(chart: string) {
    // Parse chart string like "nginx-17.3.2" or "prometheus-25.8.0"
    const match = chart.match(/^(.+)-(\d+\.\d+\.\d+.*)$/);
    if (match) {
        return { name: match[1], version: match[2] };
    }
    return { name: chart, version: '' };
}

export function HelmReleases({ currentContext }: HelmReleasesProps) {
    const qc = useQueryClient();
    const [selectedRelease, setSelectedRelease] = useState<HelmRelease | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [filterStatus, setFilterStatus] = useState<string>('all');
    const [detailTab, setDetailTab] = useState<'info' | 'values' | 'manifest'>('info');

    const { data: releases, isLoading, refetch, isRefetching } = useQuery({
        queryKey: ["helm_releases", currentContext],
        queryFn: async () => await invoke<HelmRelease[]>("helm_list"),
        staleTime: 15000,
        refetchInterval: 30000,
    });

    // Fetch details when a release is selected
    const { data: releaseDetails, isLoading: detailsLoading } = useQuery({
        queryKey: ["helm_details", selectedRelease?.namespace, selectedRelease?.name],
        queryFn: async () => {
            if (!selectedRelease) return null;
            return await invoke<HelmReleaseDetails>("helm_get_details", {
                namespace: selectedRelease.namespace,
                name: selectedRelease.name
            });
        },
        enabled: !!selectedRelease,
    });

    const uninstallMutation = useMutation({
        mutationFn: async (r: HelmRelease) => {
            await invoke("helm_uninstall", { namespace: r.namespace, name: r.name });
            return r;
        },
        onSuccess: (r) => {
            qc.invalidateQueries({ queryKey: ["helm_releases"] });
            setSelectedRelease(null);
            (window as any).showToast?.(`Uninstalled ${r.name}`, 'success');
        },
        onError: (err, r) => {
            (window as any).showToast?.(`Failed to uninstall ${r.name}: ${err}`, 'error');
        }
    });

    const handleUninstall = (r: HelmRelease, e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (confirm(`Are you sure you want to uninstall "${r.name}" from namespace "${r.namespace}"?\n\nThis action cannot be undone.`)) {
            uninstallMutation.mutate(r);
        }
    };

    // Filter and search
    const filteredReleases = useMemo(() => {
        if (!releases) return [];
        return releases.filter(r => {
            // Search filter
            if (searchQuery) {
                const query = searchQuery.toLowerCase();
                const matchesSearch =
                    r.name.toLowerCase().includes(query) ||
                    r.namespace.toLowerCase().includes(query) ||
                    r.chart.toLowerCase().includes(query);
                if (!matchesSearch) return false;
            }
            // Status filter
            if (filterStatus !== 'all' && r.status.toLowerCase() !== filterStatus.toLowerCase()) return false;
            return true;
        });
    }, [releases, searchQuery, filterStatus]);

    // Stats
    const stats = useMemo(() => {
        if (!releases) return { total: 0, deployed: 0, failed: 0, pending: 0 };
        return {
            total: releases.length,
            deployed: releases.filter(r => r.status.toLowerCase() === 'deployed').length,
            failed: releases.filter(r => r.status.toLowerCase() === 'failed').length,
            pending: releases.filter(r => r.status.toLowerCase().includes('pending')).length,
        };
    }, [releases]);

    if (isLoading) return <LoadingScreen message="Loading Helm Releases..." />;

    return (
        <div className="flex flex-col h-full bg-gradient-to-br from-[#0f0f12] to-[#1a1a1f] text-[#cccccc] relative overflow-hidden">
            {/* Header */}
            <div className="border-b border-white/5 bg-black/20 backdrop-blur-xl shrink-0">
                <div className="flex items-center justify-between px-6 py-4">
                    <div className="flex items-center gap-4">
                        <div className="p-2.5 bg-gradient-to-br from-purple-500/20 to-pink-500/20 rounded-xl border border-purple-500/20">
                            <Package size={22} className="text-purple-400" />
                        </div>
                        <div>
                            <h2 className="font-bold text-white text-lg">Helm Releases</h2>
                            <p className="text-xs text-zinc-500">Package manager for Kubernetes</p>
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
                            onClick={() => setFilterStatus(filterStatus === 'deployed' ? 'all' : 'deployed')}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${filterStatus === 'deployed' ? 'bg-emerald-500/20 ring-1 ring-emerald-500/50' : 'hover:bg-white/5'}`}
                        >
                            <CheckCircle2 size={12} className="text-emerald-400" />
                            <span className="text-emerald-400 font-medium">{stats.deployed}</span>
                            <span className="text-zinc-500">Deployed</span>
                        </button>
                        <button
                            onClick={() => setFilterStatus(filterStatus === 'failed' ? 'all' : 'failed')}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${filterStatus === 'failed' ? 'bg-red-500/20 ring-1 ring-red-500/50' : 'hover:bg-white/5'}`}
                        >
                            <XCircle size={12} className="text-red-400" />
                            <span className="text-red-400 font-medium">{stats.failed}</span>
                            <span className="text-zinc-500">Failed</span>
                        </button>
                        {stats.pending > 0 && (
                            <button
                                onClick={() => setFilterStatus(filterStatus === 'pending' ? 'all' : 'pending')}
                                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all ${filterStatus === 'pending' ? 'bg-blue-500/20 ring-1 ring-blue-500/50' : 'hover:bg-white/5'}`}
                            >
                                <Clock size={12} className="text-blue-400" />
                                <span className="text-blue-400 font-medium">{stats.pending}</span>
                                <span className="text-zinc-500">Pending</span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Search & Filters */}
                <div className="flex items-center gap-3 px-6 pb-4">
                    <div className="relative flex-1 max-w-md">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Search releases..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-purple-500/50 focus:border-purple-500/50"
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
                    {filterStatus !== 'all' && (
                        <button
                            onClick={() => setFilterStatus('all')}
                            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <X size={12} />
                            Clear filter
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6">
                {filteredReleases.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 text-[#858585]">
                        <Package size={48} className="mb-4 opacity-20" />
                        <div className="text-lg font-medium mb-1">No releases found</div>
                        <p className="text-sm text-zinc-600">
                            {searchQuery || filterStatus !== 'all'
                                ? 'Try adjusting your search or filters'
                                : 'No Helm releases in this cluster'}
                        </p>
                    </div>
                ) : viewMode === 'grid' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {filteredReleases.map((r) => {
                            const statusStyles = getStatusStyles(r.status);
                            const StatusIcon = getStatusIcon(r.status);
                            const chartInfo = parseChartInfo(r.chart);

                            return (
                                <div
                                    key={`${r.namespace}/${r.name}`}
                                    onClick={() => setSelectedRelease(r)}
                                    className={`group relative bg-gradient-to-br from-zinc-900/80 to-zinc-900/40 border ${statusStyles.border} rounded-xl p-4 hover:shadow-lg ${statusStyles.glow} transition-all cursor-pointer hover:scale-[1.02] hover:border-purple-500/50`}
                                >
                                    {/* Status indicator stripe */}
                                    <div className={`absolute top-0 left-0 right-0 h-1 rounded-t-xl ${statusStyles.bg}`} />

                                    {/* Header */}
                                    <div className="flex items-start justify-between mb-3">
                                        <div className="flex items-center gap-2.5">
                                            <div className={`p-1.5 rounded-lg ${statusStyles.bg}`}>
                                                <StatusIcon size={16} className={statusStyles.color} />
                                            </div>
                                            <div>
                                                <h3 className="font-bold text-white text-sm group-hover:text-purple-300 transition-colors">{r.name}</h3>
                                                <p className="text-[10px] text-zinc-500">{r.namespace}</p>
                                            </div>
                                        </div>
                                        <span className={`px-2 py-0.5 rounded text-[9px] font-bold border ${statusStyles.bg} ${statusStyles.border} ${statusStyles.color}`}>
                                            {r.status.toUpperCase()}
                                        </span>
                                    </div>

                                    {/* Chart Info */}
                                    <div className="space-y-2 mb-3">
                                        <div className="flex items-center gap-2 text-xs">
                                            <Package size={12} className="text-zinc-600 shrink-0" />
                                            <span className="text-zinc-400 truncate">{chartInfo.name}</span>
                                            {chartInfo.version && (
                                                <span className="text-[10px] text-zinc-600 font-mono">v{chartInfo.version}</span>
                                            )}
                                        </div>
                                        {r.app_version && (
                                            <div className="flex items-center gap-2 text-xs">
                                                <Tag size={12} className="text-zinc-600 shrink-0" />
                                                <span className="text-zinc-500">App: {r.app_version}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2 text-xs">
                                            <GitCommit size={12} className="text-zinc-600 shrink-0" />
                                            <span className="text-zinc-500 font-mono">Revision {r.revision}</span>
                                        </div>
                                    </div>

                                    {/* Footer */}
                                    <div className="flex items-center justify-between text-[10px] pt-3 border-t border-white/5">
                                        <div className="flex items-center gap-1.5 text-zinc-600">
                                            <Calendar size={10} />
                                            <span>{formatTimeAgo(r.updated)}</span>
                                        </div>
                                        <button
                                            onClick={(e) => handleUninstall(r, e)}
                                            className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-all opacity-0 group-hover:opacity-100"
                                            title="Uninstall"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    /* List View */
                    <div className="space-y-2">
                        {filteredReleases.map((r) => {
                            const statusStyles = getStatusStyles(r.status);
                            const StatusIcon = getStatusIcon(r.status);
                            const chartInfo = parseChartInfo(r.chart);

                            return (
                                <div
                                    key={`${r.namespace}/${r.name}`}
                                    onClick={() => setSelectedRelease(r)}
                                    className="group flex items-center gap-4 bg-zinc-900/50 border border-white/5 rounded-lg p-3 hover:border-purple-500/50 hover:bg-zinc-900/80 transition-all cursor-pointer"
                                >
                                    <div className={`p-2 rounded-lg ${statusStyles.bg}`}>
                                        <StatusIcon size={18} className={statusStyles.color} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-white text-sm group-hover:text-purple-300 transition-colors">{r.name}</span>
                                            <span className="text-[10px] text-zinc-600">in {r.namespace}</span>
                                        </div>
                                        <div className="flex items-center gap-3 text-xs text-zinc-500">
                                            <span className="flex items-center gap-1">
                                                <Package size={10} />
                                                {chartInfo.name}
                                            </span>
                                            {chartInfo.version && (
                                                <span className="font-mono text-[10px]">v{chartInfo.version}</span>
                                            )}
                                            <span className="flex items-center gap-1">
                                                <GitCommit size={10} />
                                                Rev {r.revision}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className={`px-2 py-1 rounded text-[10px] font-bold border ${statusStyles.bg} ${statusStyles.border} ${statusStyles.color}`}>
                                            {r.status}
                                        </span>
                                        <span className="text-[10px] text-zinc-600 w-16 text-right">{formatTimeAgo(r.updated)}</span>
                                        <button
                                            onClick={(e) => handleUninstall(r, e)}
                                            className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-all opacity-0 group-hover:opacity-100"
                                            title="Uninstall"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                        <ChevronRight size={16} className="text-zinc-600 group-hover:text-purple-400 transition-colors" />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Detail Panel */}
            {selectedRelease && (
                <>
                    <div
                        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 animate-in fade-in duration-200"
                        onClick={() => setSelectedRelease(null)}
                    />
                    <div className="fixed right-0 top-0 bottom-0 w-full max-w-2xl bg-gradient-to-br from-zinc-900 to-zinc-950 border-l border-white/10 z-50 flex flex-col animate-in slide-in-from-right duration-300">
                        {/* Panel Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-black/30">
                            <div className="flex items-center gap-3">
                                <div className={`p-2 rounded-lg ${getStatusStyles(selectedRelease.status).bg}`}>
                                    {React.createElement(getStatusIcon(selectedRelease.status), { size: 20, className: getStatusStyles(selectedRelease.status).color })}
                                </div>
                                <div>
                                    <h3 className="font-bold text-white text-lg">{selectedRelease.name}</h3>
                                    <p className="text-xs text-zinc-500">Namespace: {selectedRelease.namespace}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => handleUninstall(selectedRelease)}
                                    disabled={uninstallMutation.isPending}
                                    className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {uninstallMutation.isPending ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <Trash2 size={14} />
                                    )}
                                    Uninstall
                                </button>
                                <button
                                    onClick={() => setSelectedRelease(null)}
                                    className="p-2 text-zinc-500 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    <X size={18} />
                                </button>
                            </div>
                        </div>

                        {/* Tabs */}
                        <div className="flex border-b border-white/10 bg-black/20 px-4">
                            <button
                                onClick={() => setDetailTab('info')}
                                className={`px-4 py-3 text-sm font-medium transition-colors relative ${detailTab === 'info' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                            >
                                <div className="flex items-center gap-2">
                                    <Info size={14} />
                                    <span>Overview</span>
                                </div>
                                {detailTab === 'info' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500" />}
                            </button>
                            <button
                                onClick={() => setDetailTab('values')}
                                className={`px-4 py-3 text-sm font-medium transition-colors relative ${detailTab === 'values' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                            >
                                <div className="flex items-center gap-2">
                                    <Settings size={14} />
                                    <span>Values</span>
                                </div>
                                {detailTab === 'values' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500" />}
                            </button>
                            <button
                                onClick={() => setDetailTab('manifest')}
                                className={`px-4 py-3 text-sm font-medium transition-colors relative ${detailTab === 'manifest' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                            >
                                <div className="flex items-center gap-2">
                                    <FileText size={14} />
                                    <span>Manifest</span>
                                </div>
                                {detailTab === 'manifest' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500" />}
                            </button>
                        </div>

                        {/* Panel Content */}
                        <div className="flex-1 overflow-auto p-6">
                            {detailsLoading ? (
                                <div className="flex items-center justify-center h-32">
                                    <Loader2 size={24} className="animate-spin text-purple-400" />
                                </div>
                            ) : detailTab === 'info' ? (
                                <div className="space-y-6">
                                    {/* Status Cards */}
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className={`p-4 rounded-xl border ${getStatusStyles(selectedRelease.status).bg} ${getStatusStyles(selectedRelease.status).border}`}>
                                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Status</div>
                                            <div className={`text-lg font-bold ${getStatusStyles(selectedRelease.status).color}`}>{selectedRelease.status}</div>
                                        </div>
                                        <div className="p-4 rounded-xl border bg-white/5 border-white/10">
                                            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Revision</div>
                                            <div className="text-lg font-bold text-white">{selectedRelease.revision}</div>
                                        </div>
                                    </div>

                                    {/* Chart Info */}
                                    <div className="space-y-3">
                                        <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                            <Package size={14} />
                                            Chart Information
                                        </h4>
                                        <div className="bg-white/5 rounded-xl p-4 space-y-2">
                                            <div className="flex items-start gap-3">
                                                <span className="text-[10px] text-zinc-600 w-20 shrink-0 uppercase">Chart</span>
                                                <span className="text-sm text-zinc-300">{selectedRelease.chart}</span>
                                            </div>
                                            {selectedRelease.app_version && (
                                                <div className="flex items-start gap-3">
                                                    <span className="text-[10px] text-zinc-600 w-20 shrink-0 uppercase">App Version</span>
                                                    <span className="text-sm text-zinc-300">{selectedRelease.app_version}</span>
                                                </div>
                                            )}
                                            <div className="flex items-start gap-3">
                                                <span className="text-[10px] text-zinc-600 w-20 shrink-0 uppercase">Namespace</span>
                                                <span className="text-sm text-zinc-300">{selectedRelease.namespace}</span>
                                            </div>
                                            <div className="flex items-start gap-3">
                                                <span className="text-[10px] text-zinc-600 w-20 shrink-0 uppercase">Updated</span>
                                                <span className="text-sm text-zinc-300">{selectedRelease.updated}</span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Deployment Info */}
                                    {releaseDetails?.info && (
                                        <div className="space-y-3">
                                            <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                                <History size={14} />
                                                Deployment Details
                                            </h4>
                                            <div className="bg-white/5 rounded-xl p-4 space-y-2">
                                                {releaseDetails.info.first_deployed && (
                                                    <div className="flex items-start gap-3">
                                                        <span className="text-[10px] text-zinc-600 w-20 shrink-0 uppercase">First Deploy</span>
                                                        <span className="text-sm text-zinc-300">{releaseDetails.info.first_deployed}</span>
                                                    </div>
                                                )}
                                                {releaseDetails.info.last_deployed && (
                                                    <div className="flex items-start gap-3">
                                                        <span className="text-[10px] text-zinc-600 w-20 shrink-0 uppercase">Last Deploy</span>
                                                        <span className="text-sm text-zinc-300">{releaseDetails.info.last_deployed}</span>
                                                    </div>
                                                )}
                                                {releaseDetails.info.description && (
                                                    <div className="flex items-start gap-3">
                                                        <span className="text-[10px] text-zinc-600 w-20 shrink-0 uppercase">Description</span>
                                                        <span className="text-sm text-zinc-300">{releaseDetails.info.description}</span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Helm Notes */}
                                    {releaseDetails?.info?.notes && (
                                        <div className="space-y-3">
                                            <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                                <FileText size={14} />
                                                Helm Notes
                                            </h4>
                                            <pre className="p-4 bg-zinc-900/80 rounded-xl border border-purple-500/20 text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto max-h-64">
                                                {releaseDetails.info.notes}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            ) : detailTab === 'values' ? (
                                <div className="space-y-4">
                                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                        <Settings size={14} />
                                        User Supplied Values
                                    </h4>
                                    <pre className="p-4 bg-zinc-900/80 rounded-xl border border-white/10 text-xs text-emerald-400 font-mono overflow-auto max-h-[calc(100vh-300px)]">
                                        {releaseDetails?.values ? JSON.stringify(releaseDetails.values, null, 2) : 'No custom values'}
                                    </pre>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                                        <Code size={14} />
                                        Rendered Manifest
                                    </h4>
                                    <pre className="p-4 bg-zinc-900/80 rounded-xl border border-white/10 text-[10px] text-zinc-400 font-mono overflow-auto max-h-[calc(100vh-300px)] leading-tight">
                                        {releaseDetails?.manifest || 'No manifest data available'}
                                    </pre>
                                </div>
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
