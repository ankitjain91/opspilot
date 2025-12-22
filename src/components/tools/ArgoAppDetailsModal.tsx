import React, { useState, useMemo, useEffect } from 'react';
import {
    CheckCircle2, XCircle, Clock, AlertTriangle, AlertCircle,
    ExternalLink, FolderGit2, GitCommit, Target, ArrowRightLeft,
    History, Layers, ChevronRight, X, Activity, Search, Box,
    ChevronDown, Package, FileCode, Shield, Network, Cpu,
    HardDrive, Database, Server, Settings, Workflow, GitBranch,
    RefreshCw, Save, Loader2, RotateCw, Code2
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { K8sObject } from '../../types/k8s';
import { useToast } from '../ui/Toast';
import { ArgoGraphTab } from './ArgoGraphTab';

// Types
interface ArgoAppDetails {
    name: string;
    namespace: string;
    project: string;
    health: string;
    healthMessage?: string;
    sync: string;
    syncRevision?: string;
    repoURL?: string;
    path?: string;
    targetRevision?: string;
    chart?: string;
    helm?: {
        valueFiles?: string[];
        values?: string;
    };
    destServer?: string;
    destNamespace?: string;
    operationState?: {
        phase?: string;
        message?: string;
        startedAt?: string;
        finishedAt?: string;
    };
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
    conditions?: Array<{
        type: string;
        message: string;
        lastTransitionTime?: string;
    }>;
    history?: Array<{
        revision: string;
        deployedAt: string;
        id: number;
    }>;
    createdAt?: string;
    _original: K8sObject;
}

interface ArgoAppDetailsModalProps {
    app: ArgoAppDetails;
    onClose: () => void;
    onOpenResource?: (resource: K8sObject) => void;
}

// Helper functions
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

function getHealthColor(health: string) {
    switch (health) {
        case 'Healthy': return 'text-emerald-400';
        case 'Degraded': return 'text-rose-400';
        case 'Progressing': return 'text-blue-400';
        case 'Suspended': return 'text-amber-400';
        case 'Missing': return 'text-purple-400';
        default: return 'text-zinc-400';
    }
}

function getHealthBg(health: string) {
    switch (health) {
        case 'Healthy': return 'bg-emerald-500/10 border-emerald-500/20';
        case 'Degraded': return 'bg-rose-500/10 border-rose-500/20';
        case 'Progressing': return 'bg-blue-500/10 border-blue-500/20';
        case 'Suspended': return 'bg-amber-500/10 border-amber-500/20';
        case 'Missing': return 'bg-purple-500/10 border-purple-500/20';
        default: return 'bg-zinc-500/10 border-zinc-500/20';
    }
}

function getSyncColor(sync: string) {
    switch (sync) {
        case 'Synced': return 'text-emerald-400';
        case 'OutOfSync': return 'text-amber-400';
        default: return 'text-zinc-400';
    }
}

function getSyncBg(sync: string) {
    switch (sync) {
        case 'Synced': return 'bg-emerald-500/10 border-emerald-500/20';
        case 'OutOfSync': return 'bg-amber-500/10 border-amber-500/20';
        default: return 'bg-zinc-500/10 border-zinc-500/20';
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

function getKindIcon(kind: string) {
    const kindLower = kind.toLowerCase();
    if (kindLower.includes('deployment')) return Package;
    if (kindLower.includes('replicaset')) return Layers;
    if (kindLower.includes('pod')) return Cpu;
    if (kindLower.includes('service')) return Network;
    if (kindLower.includes('configmap')) return FileCode;
    if (kindLower.includes('secret')) return Shield;
    if (kindLower.includes('ingress')) return Network;
    if (kindLower.includes('pvc') || kindLower.includes('persistentvolume')) return HardDrive;
    if (kindLower.includes('statefulset')) return Database;
    if (kindLower.includes('daemonset')) return Server;
    if (kindLower.includes('job') || kindLower.includes('cronjob')) return Clock;
    if (kindLower.includes('serviceaccount')) return Shield;
    if (kindLower.includes('role') || kindLower.includes('clusterrole')) return Shield;
    return Box;
}

// Resource hierarchy for tree building
const RESOURCE_HIERARCHY: Record<string, string[]> = {
    'Deployment': ['ReplicaSet'],
    'ReplicaSet': ['Pod'],
    'StatefulSet': ['Pod'],
    'DaemonSet': ['Pod'],
    'Job': ['Pod'],
    'CronJob': ['Job'],
};

// Build a resource tree structure
interface ResourceNode {
    resource: NonNullable<ArgoAppDetails['resources']>[0];
    children: ResourceNode[];
}

function buildResourceTree(resources: NonNullable<ArgoAppDetails['resources']>): ResourceNode[] {
    const resourceMap = new Map<string, NonNullable<ArgoAppDetails['resources']>[0]>();
    const children = new Map<string, Set<string>>();

    resources.forEach(r => {
        const key = `${r.kind}/${r.namespace || ''}/${r.name}`;
        resourceMap.set(key, r);
    });

    resources.forEach(r => {
        const expectedChildKinds = RESOURCE_HIERARCHY[r.kind];
        if (!expectedChildKinds) return;

        expectedChildKinds.forEach(childKind => {
            resources.filter(child => child.kind === childKind).forEach(child => {
                if (child.name.startsWith(r.name)) {
                    const parentKey = `${r.kind}/${r.namespace || ''}/${r.name}`;
                    const childKey = `${child.kind}/${child.namespace || ''}/${child.name}`;
                    if (!children.has(parentKey)) children.set(parentKey, new Set());
                    children.get(parentKey)!.add(childKey);
                }
            });
        });
    });

    const allChildren = new Set<string>();
    children.forEach(kids => kids.forEach(k => allChildren.add(k)));

    const rootResources = resources.filter(r => {
        const key = `${r.kind}/${r.namespace || ''}/${r.name}`;
        return !allChildren.has(key);
    });

    function buildNode(resource: NonNullable<ArgoAppDetails['resources']>[0]): ResourceNode {
        const key = `${resource.kind}/${resource.namespace || ''}/${resource.name}`;
        const childKeys = children.get(key) || new Set();
        const childResources = Array.from(childKeys)
            .map(k => resourceMap.get(k))
            .filter((r): r is NonNullable<ArgoAppDetails['resources']>[0] => r !== undefined);

        return {
            resource,
            children: childResources.map(buildNode)
        };
    }

    return rootResources.map(buildNode);
}

// Resource Tree Node Component
function ResourceTreeNode({
    node,
    depth,
    onOpenResource,
    onClose
}: {
    node: ResourceNode;
    depth: number;
    onOpenResource?: (resource: K8sObject) => void;
    onClose: () => void;
}) {
    const [expanded, setExpanded] = useState(depth < 2);
    const { resource, children } = node;
    const hasChildren = children.length > 0;

    const Icon = getKindIcon(resource.kind);
    const HealthIcon = resource.health ? getHealthIcon(resource.health) : null;
    const healthColor = resource.health ? getHealthColor(resource.health) : 'text-zinc-500';
    const syncColor = resource.status ? getSyncColor(resource.status) : 'text-zinc-500';

    return (
        <div>
            <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 group cursor-pointer transition-colors`}
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
                onClick={() => {
                    if (hasChildren) {
                        setExpanded(!expanded);
                    } else if (onOpenResource) {
                        const k8sObj: K8sObject = {
                            id: `${resource.namespace || ''}/${resource.kind}/${resource.name}`,
                            name: resource.name,
                            namespace: resource.namespace || '-',
                            kind: resource.kind,
                            group: resource.group || '',
                            version: resource.version,
                            status: resource.health || 'Unknown',
                            age: '',
                            raw_json: undefined
                        };
                        onOpenResource(k8sObj);
                        onClose();
                    }
                }}
            >
                {hasChildren ? (
                    <ChevronRight
                        size={12}
                        className={`text-zinc-600 transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}
                    />
                ) : (
                    <div className="w-3" />
                )}

                <div className={`p-1 rounded ${getHealthBg(resource.health || 'Unknown')}`}>
                    <Icon size={14} className={healthColor} />
                </div>

                <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-sm text-zinc-200 truncate group-hover:text-white transition-colors">
                        {resource.name}
                    </span>
                    <span className="text-xs text-zinc-600">{resource.kind}</span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                    {HealthIcon && (
                        <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${getHealthBg(resource.health!)}`}>
                            <HealthIcon size={10} className={healthColor} />
                            <span className={healthColor}>{resource.health}</span>
                        </div>
                    )}
                    {resource.status && resource.status !== 'Synced' && (
                        <div className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getSyncBg(resource.status)}`}>
                            <span className={syncColor}>{resource.status}</span>
                        </div>
                    )}
                    {resource.requiresPruning && (
                        <span className="px-1.5 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-bold">
                            PRUNE
                        </span>
                    )}
                </div>
            </div>

            {expanded && hasChildren && (
                <div>
                    {children.map((child, idx) => (
                        <ResourceTreeNode
                            key={`${child.resource.kind}/${child.resource.name}-${idx}`}
                            node={child}
                            depth={depth + 1}
                            onOpenResource={onOpenResource}
                            onClose={onClose}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

type ModalTab = 'map' | 'tree' | 'list' | 'history' | 'values' | 'source';

export function ArgoAppDetailsModal({ app, onClose, onOpenResource }: ArgoAppDetailsModalProps) {
    const { showToast } = useToast();
    const queryClient = useQueryClient();
    const [activeTab, setActiveTab] = useState<ModalTab>('map');
    const [resourceSearch, setResourceSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'issues'>('all');

    // Helm values editing
    const [editedValues, setEditedValues] = useState(app.helm?.values || '');
    const [valuesDirty, setValuesDirty] = useState(false);

    // Source editing
    const [editedRevision, setEditedRevision] = useState(app.targetRevision || '');
    const [editedChart, setEditedChart] = useState(app.chart || '');
    const [sourceDirty, setSourceDirty] = useState(false);

    // Sync dialog
    const [syncDialogOpen, setSyncDialogOpen] = useState(false);
    const [syncPrune, setSyncPrune] = useState(false);
    const [syncForce, setSyncForce] = useState(false);
    const [syncDryRun, setSyncDryRun] = useState(false);

    // Initialize values when app changes
    useEffect(() => {
        setEditedValues(app.helm?.values || '');
        setEditedRevision(app.targetRevision || '');
        setEditedChart(app.chart || '');
        setValuesDirty(false);
        setSourceDirty(false);
    }, [app]);

    // Mutations
    const patchValuesMutation = useMutation({
        mutationFn: async (values: string) => {
            await invoke('argo_patch_helm_values', {
                namespace: app.namespace,
                name: app.name,
                values
            });
        },
        onSuccess: () => {
            showToast('Helm values updated successfully', 'success');
            setValuesDirty(false);
            queryClient.invalidateQueries({ queryKey: ['argo_applications_full'] });
        },
        onError: (err: any) => {
            showToast(`Failed to update values: ${err}`, 'error');
        }
    });

    const patchSourceMutation = useMutation({
        mutationFn: async ({ targetRevision, chart }: { targetRevision?: string; chart?: string }) => {
            await invoke('argo_patch_source', {
                namespace: app.namespace,
                name: app.name,
                targetRevision: targetRevision || null,
                chart: chart || null,
                repoUrl: null
            });
        },
        onSuccess: () => {
            showToast('Source configuration updated successfully', 'success');
            setSourceDirty(false);
            queryClient.invalidateQueries({ queryKey: ['argo_applications_full'] });
        },
        onError: (err: any) => {
            showToast(`Failed to update source: ${err}`, 'error');
        }
    });

    const syncMutation = useMutation({
        mutationFn: async ({ prune, force, dryRun }: { prune: boolean; force: boolean; dryRun: boolean }) => {
            return await invoke<string>('argo_sync_application', {
                namespace: app.namespace,
                name: app.name,
                prune,
                force,
                dryRun
            });
        },
        onSuccess: (result) => {
            showToast(result, 'success');
            setSyncDialogOpen(false);
            queryClient.invalidateQueries({ queryKey: ['argo_applications_full'] });
        },
        onError: (err: any) => {
            showToast(`Sync failed: ${err}`, 'error');
        }
    });

    const refreshMutation = useMutation({
        mutationFn: async (hard: boolean) => {
            return await invoke<string>('argo_refresh_application', {
                namespace: app.namespace,
                name: app.name,
                hard
            });
        },
        onSuccess: (result) => {
            showToast(result, 'success');
            queryClient.invalidateQueries({ queryKey: ['argo_applications_full'] });
        },
        onError: (err: any) => {
            showToast(`Refresh failed: ${err}`, 'error');
        }
    });

    const HealthIcon = getHealthIcon(app.health);

    const resourceTree = useMemo(() => {
        if (!app.resources) return [];
        return buildResourceTree(app.resources);
    }, [app.resources]);

    const filteredResources = useMemo(() => {
        if (!app.resources) return [];
        return app.resources.filter(res => {
            if (resourceSearch) {
                const query = resourceSearch.toLowerCase();
                if (!res.name.toLowerCase().includes(query) &&
                    !res.kind.toLowerCase().includes(query)) {
                    return false;
                }
            }
            if (statusFilter === 'issues') {
                return res.status === 'OutOfSync' || res.health === 'Degraded' || res.health === 'Progressing';
            }
            return true;
        });
    }, [app.resources, resourceSearch, statusFilter]);

    const kindStats = useMemo(() => {
        if (!app.resources) return {};
        const stats: Record<string, { total: number; healthy: number; degraded: number }> = {};
        app.resources.forEach(r => {
            if (!stats[r.kind]) stats[r.kind] = { total: 0, healthy: 0, degraded: 0 };
            stats[r.kind].total++;
            if (r.health === 'Healthy') stats[r.kind].healthy++;
            if (r.health === 'Degraded') stats[r.kind].degraded++;
        });
        return stats;
    }, [app.resources]);

    const isHelmApp = !!(app.chart || app.helm);

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed inset-4 md:inset-8 lg:inset-12 z-50 flex items-center justify-center">
                <div
                    className="w-full h-full max-w-6xl max-h-[90vh] bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="shrink-0 border-b border-white/5 bg-black/30 p-5">
                        <div className="flex items-start justify-between">
                            <div className="flex items-start gap-4">
                                <div className={`p-3 rounded-xl border ${getHealthBg(app.health)}`}>
                                    <GitBranch size={24} className={getHealthColor(app.health)} />
                                </div>

                                <div>
                                    <div className="flex items-center gap-3 mb-1">
                                        <h2 className="text-xl font-bold text-white">{app.name}</h2>
                                        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${getHealthBg(app.health)}`}>
                                            <HealthIcon size={14} className={getHealthColor(app.health)} />
                                            <span className={`text-xs font-medium ${getHealthColor(app.health)}`}>{app.health}</span>
                                        </div>
                                        <div className={`px-2 py-1 rounded-lg border ${getSyncBg(app.sync)}`}>
                                            <span className={`text-xs font-medium ${getSyncColor(app.sync)}`}>{app.sync}</span>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-4 text-sm text-zinc-400">
                                        <span>Project: <span className="text-zinc-200">{app.project}</span></span>
                                        <span className="text-zinc-700">|</span>
                                        <span>Dest: <span className="text-zinc-200">{app.destNamespace || 'default'}</span></span>
                                        {app.repoURL && (
                                            <>
                                                <span className="text-zinc-700">|</span>
                                                <a
                                                    href={app.repoURL}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <FolderGit2 size={12} />
                                                    <span className="truncate max-w-[200px]">{app.path || 'repo'}</span>
                                                </a>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                {/* Quick Actions */}
                                <button
                                    onClick={() => refreshMutation.mutate(false)}
                                    disabled={refreshMutation.isPending}
                                    className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
                                    title="Refresh from Git"
                                >
                                    {refreshMutation.isPending ? (
                                        <Loader2 size={18} className="animate-spin" />
                                    ) : (
                                        <RotateCw size={18} />
                                    )}
                                </button>
                                <button
                                    onClick={onClose}
                                    className="p-2 text-zinc-500 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                        </div>

                        {/* Stats Row */}
                        <div className="flex items-center gap-6 mt-4 pt-4 border-t border-white/5">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl font-bold text-white">{app.resourceCount || 0}</span>
                                <span className="text-xs text-zinc-500 uppercase">Resources</span>
                            </div>
                            <div className="h-6 w-px bg-white/10" />
                            <div className="flex items-center gap-4">
                                <div className="flex items-center gap-1.5">
                                    <CheckCircle2 size={14} className="text-emerald-400" />
                                    <span className="text-sm text-emerald-400 font-medium">{app.syncedResources || 0}</span>
                                    <span className="text-xs text-zinc-500">synced</span>
                                </div>
                                {(app.outOfSyncResources || 0) > 0 && (
                                    <div className="flex items-center gap-1.5">
                                        <AlertTriangle size={14} className="text-amber-400" />
                                        <span className="text-sm text-amber-400 font-medium">{app.outOfSyncResources}</span>
                                        <span className="text-xs text-zinc-500">out of sync</span>
                                    </div>
                                )}
                            </div>
                            <div className="h-6 w-px bg-white/10" />
                            <div className="flex items-center gap-2 flex-wrap">
                                {Object.entries(kindStats).slice(0, 6).map(([kind, stats]) => (
                                    <div key={kind} className="flex items-center gap-1 px-2 py-1 bg-zinc-800/50 rounded text-xs">
                                        <span className="text-zinc-400">{kind}:</span>
                                        <span className="text-zinc-200">{stats.total}</span>
                                        {stats.degraded > 0 && (
                                            <span className="text-rose-400 ml-1">({stats.degraded}!)</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Tabs */}
                    <div className="shrink-0 flex items-center gap-1 px-5 py-2 border-b border-white/5 bg-black/20">
                        {[
                            { id: 'map' as const, label: 'Graph', icon: Network },
                            { id: 'tree' as const, label: 'Resource Tree', icon: Workflow },
                            { id: 'list' as const, label: 'List View', icon: Layers },
                            { id: 'history' as const, label: 'History', icon: History },
                            ...(isHelmApp ? [
                                { id: 'values' as const, label: 'Helm Values', icon: Code2 },
                                { id: 'source' as const, label: 'Source', icon: Settings },
                            ] : []),
                        ].map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id
                                        ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30'
                                        : 'text-zinc-400 hover:text-white hover:bg-white/5'
                                    }`}
                            >
                                <tab.icon size={16} />
                                {tab.label}
                                {tab.id === 'values' && valuesDirty && (
                                    <span className="w-2 h-2 bg-amber-400 rounded-full" />
                                )}
                            </button>
                        ))}

                        {(activeTab === 'tree' || activeTab === 'list') && (
                            <div className="ml-auto flex items-center gap-2">
                                <div className="relative">
                                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                                    <input
                                        type="text"
                                        placeholder="Search resources..."
                                        value={resourceSearch}
                                        onChange={(e) => setResourceSearch(e.target.value)}
                                        className="pl-9 pr-4 py-1.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-orange-500/50 w-48"
                                    />
                                </div>
                                <button
                                    onClick={() => setStatusFilter(statusFilter === 'all' ? 'issues' : 'all')}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${statusFilter === 'issues'
                                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                            : 'bg-white/5 text-zinc-400 border border-white/10 hover:text-white'
                                        }`}
                                >
                                    <AlertTriangle size={12} />
                                    {statusFilter === 'issues' ? 'Issues Only' : 'Show Issues'}
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-auto bg-[#0f0f12] relative">
                        {activeTab === 'map' && (
                            <ArgoGraphTab
                                app={app}
                                onOpenResource={(obj) => {
                                    if (onOpenResource) {
                                        onOpenResource(obj);
                                        onClose();
                                    }
                                }}
                            />
                        )}

                        {activeTab === 'tree' && (
                            <div className="p-4">
                                {resourceTree.length > 0 ? (
                                    <div className="space-y-0.5">
                                        {resourceTree
                                            .filter(node => {
                                                if (!resourceSearch && statusFilter === 'all') return true;
                                                const matchesSearch = !resourceSearch ||
                                                    node.resource.name.toLowerCase().includes(resourceSearch.toLowerCase()) ||
                                                    node.resource.kind.toLowerCase().includes(resourceSearch.toLowerCase());
                                                const matchesFilter = statusFilter === 'all' ||
                                                    node.resource.health === 'Degraded' ||
                                                    node.resource.health === 'Progressing' ||
                                                    node.resource.status === 'OutOfSync';
                                                return matchesSearch && (statusFilter === 'all' || matchesFilter);
                                            })
                                            .map((node, idx) => (
                                                <ResourceTreeNode
                                                    key={`${node.resource.kind}/${node.resource.name}-${idx}`}
                                                    node={node}
                                                    depth={0}
                                                    onOpenResource={onOpenResource}
                                                    onClose={onClose}
                                                />
                                            ))
                                        }
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center h-48 text-zinc-500">
                                        <div className="text-center">
                                            <Layers size={32} className="mx-auto mb-3 opacity-50" />
                                            <p>No resources in this application</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'list' && (
                            <div className="p-4">
                                <div className="grid grid-cols-1 gap-1">
                                    {filteredResources.map((res, idx) => {
                                        const Icon = getKindIcon(res.kind);
                                        const ResHealthIcon = res.health ? getHealthIcon(res.health) : null;

                                        return (
                                            <button
                                                key={idx}
                                                onClick={() => {
                                                    if (onOpenResource) {
                                                        const k8sObj: K8sObject = {
                                                            id: `${res.namespace || ''}/${res.kind}/${res.name}`,
                                                            name: res.name,
                                                            namespace: res.namespace || '-',
                                                            kind: res.kind,
                                                            group: res.group || '',
                                                            version: res.version,
                                                            status: res.health || 'Unknown',
                                                            age: '',
                                                            raw_json: undefined
                                                        };
                                                        onOpenResource(k8sObj);
                                                        onClose();
                                                    }
                                                }}
                                                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors text-left group"
                                            >
                                                <div className={`p-1.5 rounded ${getHealthBg(res.health || 'Unknown')}`}>
                                                    <Icon size={16} className={getHealthColor(res.health || 'Unknown')} />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-sm font-medium text-zinc-200 group-hover:text-white truncate">
                                                            {res.name}
                                                        </span>
                                                        <span className="text-xs text-zinc-600">{res.kind}</span>
                                                    </div>
                                                    {res.namespace && (
                                                        <span className="text-xs text-zinc-500">{res.namespace}</span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    {ResHealthIcon && (
                                                        <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs ${getHealthBg(res.health!)}`}>
                                                            <ResHealthIcon size={12} className={getHealthColor(res.health!)} />
                                                            <span className={getHealthColor(res.health!)}>{res.health}</span>
                                                        </div>
                                                    )}
                                                    {res.status && res.status !== 'Synced' && (
                                                        <div className={`px-2 py-0.5 rounded text-xs ${getSyncBg(res.status)}`}>
                                                            <span className={getSyncColor(res.status)}>{res.status}</span>
                                                        </div>
                                                    )}
                                                    <ChevronRight size={14} className="text-zinc-600 group-hover:text-orange-400" />
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>

                                {filteredResources.length === 0 && (
                                    <div className="flex items-center justify-center h-48 text-zinc-500">
                                        <div className="text-center">
                                            <Search size={24} className="mx-auto mb-3 opacity-50" />
                                            <p>No resources match your filter</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'history' && (
                            <div className="p-4">
                                {app.history && app.history.length > 0 ? (
                                    <div className="space-y-2">
                                        {app.history.map((h, idx) => (
                                            <div
                                                key={h.id}
                                                className={`flex items-center gap-4 p-4 rounded-xl border ${idx === 0
                                                        ? 'bg-orange-500/5 border-orange-500/20'
                                                        : 'bg-white/5 border-white/5'
                                                    }`}
                                            >
                                                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${idx === 0
                                                        ? 'bg-orange-500/20 text-orange-400'
                                                        : 'bg-zinc-800 text-zinc-400'
                                                    }`}>
                                                    {h.id}
                                                </div>
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <GitCommit size={14} className="text-zinc-500" />
                                                        <span className="text-sm font-mono text-zinc-200">{h.revision}</span>
                                                        {idx === 0 && (
                                                            <span className="px-2 py-0.5 bg-orange-500/20 text-orange-400 rounded text-[10px] font-bold">
                                                                CURRENT
                                                            </span>
                                                        )}
                                                    </div>
                                                    <span className="text-xs text-zinc-500">{formatTimeAgo(h.deployedAt)}</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center h-48 text-zinc-500">
                                        <div className="text-center">
                                            <History size={32} className="mx-auto mb-3 opacity-50" />
                                            <p>No deployment history available</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'values' && (
                            <div className="p-4 h-full flex flex-col">
                                <div className="flex items-center justify-between mb-4">
                                    <div>
                                        <h3 className="text-sm font-medium text-white">Helm Values Override</h3>
                                        <p className="text-xs text-zinc-500">Edit YAML values and apply changes to the application</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {valuesDirty && (
                                            <span className="text-xs text-amber-400">Unsaved changes</span>
                                        )}
                                        <button
                                            onClick={() => patchValuesMutation.mutate(editedValues)}
                                            disabled={!valuesDirty || patchValuesMutation.isPending}
                                            className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition-colors"
                                        >
                                            {patchValuesMutation.isPending ? (
                                                <Loader2 size={14} className="animate-spin" />
                                            ) : (
                                                <Save size={14} />
                                            )}
                                            Apply Values
                                        </button>
                                    </div>
                                </div>
                                <textarea
                                    value={editedValues}
                                    onChange={(e) => {
                                        setEditedValues(e.target.value);
                                        setValuesDirty(e.target.value !== (app.helm?.values || ''));
                                    }}
                                    className="flex-1 w-full bg-zinc-900 border border-white/10 rounded-lg p-4 font-mono text-sm text-zinc-200 resize-none focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                                    placeholder="# Enter Helm values in YAML format&#10;replicaCount: 2&#10;image:&#10;  tag: latest"
                                    spellCheck={false}
                                />
                            </div>
                        )}

                        {activeTab === 'source' && (
                            <div className="p-6">
                                <div className="max-w-xl space-y-6">
                                    <div>
                                        <h3 className="text-sm font-medium text-white mb-4">Source Configuration</h3>
                                        <p className="text-xs text-zinc-500 mb-6">Update the chart version or source settings for this application</p>
                                    </div>

                                    <div className="space-y-4">
                                        <div>
                                            <label className="block text-xs text-zinc-400 mb-1.5">Repository URL</label>
                                            <div className="px-4 py-2.5 bg-zinc-800/50 border border-white/5 rounded-lg text-sm text-zinc-300 truncate">
                                                {app.repoURL || 'Not set'}
                                            </div>
                                        </div>

                                        {app.chart && (
                                            <div>
                                                <label className="block text-xs text-zinc-400 mb-1.5">Chart Name</label>
                                                <input
                                                    type="text"
                                                    value={editedChart}
                                                    onChange={(e) => {
                                                        setEditedChart(e.target.value);
                                                        setSourceDirty(e.target.value !== app.chart || editedRevision !== app.targetRevision);
                                                    }}
                                                    className="w-full px-4 py-2.5 bg-zinc-900 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                                                />
                                            </div>
                                        )}

                                        <div>
                                            <label className="block text-xs text-zinc-400 mb-1.5">Target Revision / Version</label>
                                            <input
                                                type="text"
                                                value={editedRevision}
                                                onChange={(e) => {
                                                    setEditedRevision(e.target.value);
                                                    setSourceDirty(editedChart !== app.chart || e.target.value !== app.targetRevision);
                                                }}
                                                placeholder="e.g., 1.0.0, HEAD, main"
                                                className="w-full px-4 py-2.5 bg-zinc-900 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                                            />
                                            <p className="mt-1 text-xs text-zinc-600">Current: {app.targetRevision || 'HEAD'}</p>
                                        </div>

                                        {app.path && (
                                            <div>
                                                <label className="block text-xs text-zinc-400 mb-1.5">Path</label>
                                                <div className="px-4 py-2.5 bg-zinc-800/50 border border-white/5 rounded-lg text-sm text-zinc-300">
                                                    {app.path}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-3 pt-4 border-t border-white/5">
                                        {sourceDirty && (
                                            <span className="text-xs text-amber-400">Unsaved changes</span>
                                        )}
                                        <button
                                            onClick={() => patchSourceMutation.mutate({
                                                targetRevision: editedRevision !== app.targetRevision ? editedRevision : undefined,
                                                chart: editedChart !== app.chart ? editedChart : undefined
                                            })}
                                            disabled={!sourceDirty || patchSourceMutation.isPending}
                                            className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition-colors"
                                        >
                                            {patchSourceMutation.isPending ? (
                                                <Loader2 size={14} className="animate-spin" />
                                            ) : (
                                                <Save size={14} />
                                            )}
                                            Apply Changes
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="shrink-0 flex items-center justify-between px-5 py-4 border-t border-white/5 bg-black/30">
                        <span className="text-xs text-zinc-500">
                            Created {formatTimeAgo(app.createdAt)}
                        </span>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => setSyncDialogOpen(true)}
                                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-all flex items-center gap-2 text-sm"
                            >
                                <RefreshCw size={14} />
                                Sync
                            </button>
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-sm text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                            >
                                Close
                            </button>
                            <button
                                onClick={() => {
                                    if (onOpenResource && app._original) {
                                        onOpenResource(app._original);
                                        onClose();
                                    }
                                }}
                                className="px-4 py-2 bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-500 hover:to-red-500 text-white font-medium rounded-lg transition-all flex items-center gap-2 text-sm"
                            >
                                <ExternalLink size={14} />
                                View YAML
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Sync Dialog */}
            {syncDialogOpen && (
                <>
                    <div className="fixed inset-0 bg-black/50 z-[60]" onClick={() => setSyncDialogOpen(false)} />
                    <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-full max-w-md">
                        <div className="bg-zinc-900 border border-white/10 rounded-xl p-6 shadow-2xl">
                            <h3 className="text-lg font-bold text-white mb-4">Sync Application</h3>
                            <p className="text-sm text-zinc-400 mb-6">
                                Sync <span className="text-white font-medium">{app.name}</span> with its target state from Git.
                            </p>

                            <div className="space-y-3 mb-6">
                                <label className="flex items-center gap-3 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={syncPrune}
                                        onChange={(e) => setSyncPrune(e.target.checked)}
                                        className="w-4 h-4 rounded border-zinc-600 text-orange-500 focus:ring-orange-500 bg-zinc-800"
                                    />
                                    <div>
                                        <span className="text-sm text-white">Prune</span>
                                        <p className="text-xs text-zinc-500">Delete resources not defined in Git</p>
                                    </div>
                                </label>

                                <label className="flex items-center gap-3 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={syncForce}
                                        onChange={(e) => setSyncForce(e.target.checked)}
                                        className="w-4 h-4 rounded border-zinc-600 text-orange-500 focus:ring-orange-500 bg-zinc-800"
                                    />
                                    <div>
                                        <span className="text-sm text-white">Force</span>
                                        <p className="text-xs text-zinc-500">Force apply, replacing existing resources</p>
                                    </div>
                                </label>

                                <label className="flex items-center gap-3 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={syncDryRun}
                                        onChange={(e) => setSyncDryRun(e.target.checked)}
                                        className="w-4 h-4 rounded border-zinc-600 text-orange-500 focus:ring-orange-500 bg-zinc-800"
                                    />
                                    <div>
                                        <span className="text-sm text-white">Dry Run</span>
                                        <p className="text-xs text-zinc-500">Preview changes without applying</p>
                                    </div>
                                </label>
                            </div>

                            <div className="flex items-center gap-3 justify-end">
                                <button
                                    onClick={() => setSyncDialogOpen(false)}
                                    className="px-4 py-2 text-sm text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => syncMutation.mutate({ prune: syncPrune, force: syncForce, dryRun: syncDryRun })}
                                    disabled={syncMutation.isPending}
                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {syncMutation.isPending ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <RefreshCw size={14} />
                                    )}
                                    {syncDryRun ? 'Preview Sync' : 'Sync Now'}
                                </button>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </>
    );
}
