import React, { useState, useEffect, useMemo } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { Virtuoso } from "react-virtuoso";
import {
    AlertCircle,
    Activity,
    Layers,
    ChevronDown
} from 'lucide-react';

import Loading from '../../components/Loading'; // Will need to fix this import path if Loading is moved
import { StatusBadge } from '../shared/StatusBadge';
import { ResourceContextMenu } from '../shared/ResourceContextMenu';
import { DeleteConfirmationModal } from '../shared/DeleteConfirmationModal';

import { useResourceWatch } from '../../hooks/useResourceWatch';
import { useLiveAge, formatAge } from '../../utils/time';
import { NavResource, K8sObject, ResourceMetrics } from '../../types/k8s';

// Helper to detect IaC resources (Crossplane, Terraform, etc.)
const isIaCResource = (group: string): boolean => {
    if (!group) return false;
    const lowerGroup = group.toLowerCase();
    return (
        lowerGroup.includes('crossplane.io') ||
        lowerGroup.includes('upbound.io') ||
        lowerGroup.includes('tf.upbound.io') ||
        lowerGroup.includes('infra.contrib.fluxcd.io') ||
        lowerGroup.includes('hashicorp.com')
    );
};

// Helper to get IaC reconciliation status from conditions
const getIaCStatus = (rawJson: string): { status: 'Reconciling' | 'Reconciled' | 'Failed' | 'Unknown'; reason?: string; message?: string } => {
    try {
        const obj = JSON.parse(rawJson);
        const conditions = obj?.status?.conditions || [];

        // Check for Synced condition (Crossplane pattern)
        const synced = conditions.find((c: any) => c.type === 'Synced');
        const ready = conditions.find((c: any) => c.type === 'Ready');

        // Priority: Failed > Reconciling > Reconciled

        // Check for failures first
        if (synced?.status === 'False') {
            return { status: 'Failed', reason: synced.reason, message: synced.message };
        }
        if (ready?.status === 'False') {
            return { status: 'Failed', reason: ready.reason, message: ready.message };
        }

        // Check for reconciled - Ready=True with success indicators
        if (ready?.status === 'True') {
            // ASO uses 'Succeeded', Crossplane uses 'Available'
            if (ready.reason === 'Succeeded' || ready.reason === 'Available' || !ready.reason) {
                return { status: 'Reconciled', reason: ready.reason };
            }
        }
        if (synced?.status === 'True' && ready?.status === 'True') {
            return { status: 'Reconciled' };
        }

        // Check for reconciling - various in-progress states
        const reconcilingReasons = [
            'Creating', 'Pending', 'Unavailable', 'Deleting',
            'AzureResourceReconciling', 'Reconciling', 'Provisioning',
            'LastAsyncOperation', 'InProgress', 'Updating'
        ];
        if (ready?.reason && reconcilingReasons.some(r => ready.reason.includes(r))) {
            return { status: 'Reconciling', reason: ready.reason, message: ready.message };
        }
        // Also check if status is Unknown (common ASO pattern during reconciliation)
        if (ready?.status === 'Unknown') {
            return { status: 'Reconciling', reason: ready.reason || 'Reconciling', message: ready.message };
        }

        // If we have conditions but can't determine status
        if (conditions.length > 0) {
            // Default to showing the Ready reason if available
            return { status: 'Unknown', reason: ready?.reason };
        }

        return { status: 'Unknown' };
    } catch {
        return { status: 'Unknown' };
    }
};

// IaC Status Badge component
const IaCStatusBadge = ({ status, reason, message }: { status: 'Reconciling' | 'Reconciled' | 'Failed' | 'Unknown'; reason?: string; message?: string }) => {
    const styles = {
        Reconciling: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
        Reconciled: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
        Failed: 'bg-red-500/15 text-red-400 border-red-500/30',
        Unknown: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
    };

    const icons = {
        Reconciling: '↻',
        Reconciled: '✓',
        Failed: '✗',
        Unknown: '?'
    };

    const tooltip = reason ? `${reason}${message ? `: ${message}` : ''}` : status;

    return (
        <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${styles[status]}`}
            title={tooltip}
        >
            <span className={status === 'Reconciling' ? 'animate-spin' : ''}>{icons[status]}</span>
            {status}
        </span>
    );
};

interface ResourceListProps {
    resourceType: NavResource;
    onSelect: (obj: K8sObject) => void;
    namespaceFilter: string;
    searchQuery: string;
    currentContext?: string;
}

export function ResourceList({ resourceType, onSelect, namespaceFilter, searchQuery, currentContext }: ResourceListProps) {
    // Defensive guard: ensure resourceType is valid
    if (!resourceType || !resourceType.kind) {
        return <div className="h-full flex items-center justify-center"><Loading size={24} label="Loading" /></div>;
    }

    const qc = useQueryClient();

    // Delete modal state
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [resourceToDelete, setResourceToDelete] = useState<K8sObject | null>(null);
    const [deletingResources, setDeletingResources] = useState<Set<string>>(new Set());
    const [isDeleting, setIsDeleting] = useState(false);

    const handleDeleteRequest = (resource: K8sObject) => {
        setResourceToDelete(resource);
        setDeleteModalOpen(true);
    };

    const handleDeleteConfirm = async () => {
        if (!resourceToDelete) return;
        const resourceId = resourceToDelete.id;
        const resourceName = resourceToDelete.name;
        const resourceKind = resourceType.kind;

        setIsDeleting(true);
        setDeletingResources(prev => new Set(prev).add(resourceId));
        setDeleteModalOpen(false);

        // Show immediate feedback that deletion is in progress
        (window as any).showToast?.(`Deleting ${resourceKind} '${resourceName}'...`, 'info');

        try {
            await invoke("delete_resource", {
                req: {
                    group: resourceType.group,
                    version: resourceType.version,
                    kind: resourceType.kind,
                    namespace: resourceToDelete.namespace === '-' ? null : resourceToDelete.namespace
                },
                name: resourceToDelete.name
            });
            // Show success feedback
            (window as any).showToast?.(`${resourceKind} '${resourceName}' deleted successfully`, 'success');
            // Trigger an immediate refetch to show the Terminating status
            setTimeout(() => refetch(), 500);
        } catch (err) {
            (window as any).showToast?.(`Failed to delete ${resourceKind} '${resourceName}': ${err}`, 'error');
            setDeletingResources(prev => {
                const newSet = new Set(prev);
                newSet.delete(resourceId);
                return newSet;
            });
        }
        setIsDeleting(false);
        setResourceToDelete(null);
    };

    // Enable real-time watching via Kubernetes watch API
    const watchNamespace = namespaceFilter === "All Namespaces" ? null : namespaceFilter;
    const { isWatching, syncComplete } = useResourceWatch(resourceType, watchNamespace, currentContext, true);

    // Live age ticker - updates every second for real-time age display
    useLiveAge(1000);

    const { data: resources, isLoading: isListLoading, isError, error, isFetching, refetch } = useQuery({
        queryKey: ["list_resources", currentContext, resourceType.group || "", resourceType.version || "", resourceType.kind || "", namespaceFilter],
        queryFn: async () => await invoke<K8sObject[]>("list_resources", {
            req: {
                group: resourceType.group,
                version: resourceType.version,
                kind: resourceType.kind,
                namespace: namespaceFilter === "All Namespaces" ? null : namespaceFilter
            }
        }),
        staleTime: isWatching ? Infinity : 10000, // Don't consider stale if watching
        gcTime: 1000 * 60 * 5, // Keep in cache for 5 minutes
        refetchInterval: isWatching ? false : 30000, // Disable polling when watching
        refetchOnWindowFocus: false,
    });

    // Listen for global reloads and refetch
    useEffect(() => {
        const handler = () => {
            refetch();
        };
        window.addEventListener("lenskiller:reload", handler);
        return () => window.removeEventListener("lenskiller:reload", handler);
    }, [refetch]);

    const kindLower = (resourceType.kind || '').toLowerCase();
    const isPod = kindLower === 'pod';
    const isNode = kindLower === 'node';
    const isIaC = isIaCResource(resourceType.group);

    // Fetch metrics for pods and nodes
    const { data: metricsData } = useQuery({
        queryKey: ["list_metrics", currentContext, resourceType.kind || "", namespaceFilter],
        queryFn: async () => {
            try {
                return await invoke<ResourceMetrics[]>("get_resource_metrics", {
                    kind: resourceType.kind,
                    namespace: isPod ? (namespaceFilter === "All Namespaces" ? null : namespaceFilter) : null
                });
            } catch (e) {
                console.warn("Metrics not available:", e);
                return [];
            }
        },
        enabled: isPod || isNode,
        staleTime: 10000,
        refetchInterval: 30000,
    });

    const metricsMap = useMemo(() => {
        const map = new Map<string, ResourceMetrics>();
        if (metricsData) {
            metricsData.forEach(m => map.set(`${m.namespace || ''}/${m.name}`, m));
        }
        return map;
    }, [metricsData]);

    const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

    const filteredResources = useMemo(() => {
        if (!resources) return [];
        let filtered = resources.filter(r => {
            const nsMatch = namespaceFilter === "All Namespaces" || r.namespace === namespaceFilter;
            const searchMatch = !searchQuery || r.name.toLowerCase().includes(searchQuery.toLowerCase());
            return nsMatch && searchMatch;
        });

        // Apply sorting
        if (sortConfig) {
            filtered = [...filtered].sort((a, b) => {
                let aVal: any = a[sortConfig.key as keyof K8sObject];
                let bVal: any = b[sortConfig.key as keyof K8sObject];

                // Special handling for different data types
                if (sortConfig.key === 'age') {
                    aVal = new Date(a.age).getTime();
                    bVal = new Date(b.age).getTime();
                } else if (sortConfig.key === 'restarts') {
                    aVal = a.restarts ?? 0;
                    bVal = b.restarts ?? 0;
                } else if (sortConfig.key === 'ready') {
                    // Parse ready string like "1/1" to compare
                    const [aReady, aTotal] = (a.ready || '0/0').split('/').map(Number);
                    const [bReady, bTotal] = (b.ready || '0/0').split('/').map(Number);
                    aVal = aTotal > 0 ? aReady / aTotal : 0;
                    bVal = bTotal > 0 ? bReady / bTotal : 0;
                } else if (sortConfig.key === 'cpu' || sortConfig.key === 'memory') {
                    // For nodes, namespace is "-" in resource list but "" in metrics
                    const aNs = a.namespace === '-' ? '' : (a.namespace || '');
                    const bNs = b.namespace === '-' ? '' : (b.namespace || '');
                    const aMetrics = metricsMap.get(`${aNs}/${a.name}`);
                    const bMetrics = metricsMap.get(`${bNs}/${b.name}`);
                    aVal = sortConfig.key === 'cpu' ? (aMetrics?.cpu_nano ?? 0) : (aMetrics?.memory_bytes ?? 0);
                    bVal = sortConfig.key === 'cpu' ? (bMetrics?.cpu_nano ?? 0) : (bMetrics?.memory_bytes ?? 0);
                } else if (sortConfig.key === 'sync') {
                    // Sort IaC sync status: Failed first, then Reconciling, then Unknown, then Reconciled
                    const statusOrder = { 'Failed': 0, 'Reconciling': 1, 'Unknown': 2, 'Reconciled': 3 };
                    const aStatus = getIaCStatus(a.raw_json).status;
                    const bStatus = getIaCStatus(b.raw_json).status;
                    aVal = statusOrder[aStatus];
                    bVal = statusOrder[bStatus];
                }

                // String comparison for text fields
                if (typeof aVal === 'string' && typeof bVal === 'string') {
                    return sortConfig.direction === 'asc'
                        ? aVal.localeCompare(bVal)
                        : bVal.localeCompare(aVal);
                }

                // Numeric comparison
                if (sortConfig.direction === 'asc') {
                    return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                } else {
                    return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
                }
            });
        }

        return filtered;
    }, [resources, namespaceFilter, searchQuery, sortConfig, metricsMap]);

    const handleSort = (key: string) => {
        setSortConfig(current => {
            if (!current || current.key !== key) {
                return { key, direction: 'asc' };
            }
            if (current.direction === 'asc') {
                return { key, direction: 'desc' };
            }
            return null; // Reset sorting
        });
    };

    const SortableHeader = ({ label, sortKey }: { label: string; sortKey: string }) => {
        const isActive = sortConfig?.key === sortKey;
        const direction = sortConfig?.direction;
        return (
            <div
                onClick={() => handleSort(sortKey)}
                className="flex items-center gap-1 cursor-pointer hover:text-cyan-400 transition-all select-none"
            >
                <span>{label}</span>
                <div className="flex flex-col">
                    <ChevronDown
                        size={10}
                        className={`-mb-1 ${isActive && direction === 'asc' ? 'text-cyan-400' : 'text-gray-700'}`}
                        style={{ transform: 'rotate(180deg)' }}
                    />
                    <ChevronDown
                        size={10}
                        className={`${isActive && direction === 'desc' ? 'text-cyan-400' : 'text-gray-700'}`}
                    />
                </div>
            </div>
        );
    };

    // Show loading state
    // Guard: don't render anything until resources are loaded
    if (!resources) {
        return <Loading fullScreen size={32} />;
    }

    // Show error ONLY if we have no data at all
    if (!resources) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-center">
                <div className="bg-red-500/10 p-8 rounded-xl border border-red-500/30 max-w-md backdrop-blur-sm shadow-lg shadow-red-500/10">
                    <AlertCircle size={40} className="text-red-400 mx-auto mb-4" />
                    <h3 className="text-base font-bold text-white mb-2">No Data Available</h3>
                    <p className="text-gray-400 text-sm">
                        {isError ? `Error: ${error}` : "Loading resources..."}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-[#09090b]">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-white/5 bg-zinc-900/30 backdrop-blur-md text-xs sticky top-0 z-10">
                <div className="flex items-center gap-2 text-zinc-500">
                    <span className="uppercase tracking-wider font-semibold">{resourceType.kind}</span>
                    {isListLoading && !syncComplete ? (
                        <span className="flex items-center gap-1 text-cyan-400">
                            <Loading size={12} label="Loading" />
                        </span>
                    ) : isError ? (
                        <span className="flex items-center gap-1 text-red-400">
                            <AlertCircle size={12} /> Failed
                        </span>
                    ) : isWatching ? (
                        <span className="flex items-center gap-1 text-emerald-400" title="Real-time updates via Kubernetes watch API">
                            <div className="relative">
                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                <div className="absolute inset-0 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping opacity-75" />
                            </div>
                            <Activity size={12} className="ml-0.5" />
                            Real-time
                        </span>
                    ) : (
                        <span className={`flex items-center gap-1 ${isFetching ? 'text-cyan-400' : 'text-zinc-500'}`}>
                            <div className={`w-1.5 h-1.5 rounded-full ${isFetching ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-500'}`} />
                            {isFetching ? 'Updating...' : 'Polling'}
                        </span>
                    )}
                </div>
            </div>
            {isPod ? (
                <div className="grid grid-cols-[2fr_1.5fr_0.8fr_0.7fr_0.8fr_0.8fr_0.8fr_1.2fr_1fr_40px] gap-3 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
                    <SortableHeader label="Name" sortKey="name" />
                    <SortableHeader label="Namespace" sortKey="namespace" />
                    <SortableHeader label="Ready" sortKey="ready" />
                    <SortableHeader label="Status" sortKey="status" />
                    <SortableHeader label="Restarts" sortKey="restarts" />
                    <SortableHeader label="CPU" sortKey="cpu" />
                    <SortableHeader label="Memory" sortKey="memory" />
                    <SortableHeader label="Node" sortKey="node" />
                    <SortableHeader label="Age" sortKey="age" />
                    <div />
                </div>
            ) : isNode ? (
                <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_40px] gap-4 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
                    <SortableHeader label="Name" sortKey="name" />
                    <SortableHeader label="Status" sortKey="status" />
                    <SortableHeader label="CPU" sortKey="cpu" />
                    <SortableHeader label="Memory" sortKey="memory" />
                    <SortableHeader label="Age" sortKey="age" />
                    <div />
                </div>
            ) : isIaC ? (
                <div className="grid grid-cols-[2fr_1.5fr_1fr_1fr_1fr_40px] gap-4 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
                    <SortableHeader label="Name" sortKey="name" />
                    <SortableHeader label="Namespace" sortKey="namespace" />
                    <SortableHeader label="Sync" sortKey="sync" />
                    <SortableHeader label="Status" sortKey="status" />
                    <SortableHeader label="Age" sortKey="age" />
                    <div />
                </div>
            ) : (
                <div className="grid grid-cols-[2fr_1.5fr_1fr_1fr_40px] gap-4 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
                    <SortableHeader label="Name" sortKey="name" />
                    <SortableHeader label="Namespace" sortKey="namespace" />
                    <SortableHeader label="Status" sortKey="status" />
                    <SortableHeader label="Age" sortKey="age" />
                    <div />
                </div>
            )}

            {/* List */}
            <div className="flex-1">
                {isListLoading ? (
                    <div className="p-4 space-y-2">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="h-10 bg-white/5 rounded animate-pulse" />
                        ))}
                    </div>
                ) : filteredResources.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-500">
                        <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4 border border-white/10">
                            <Layers size={32} className="opacity-40 text-zinc-400" />
                        </div>
                        <p className="text-base font-medium text-zinc-300">No resources found</p>
                        <p className="text-sm opacity-60 mt-2">
                            {searchQuery ? `No matches for "${searchQuery}"` : `There are no ${resourceType.kind}s in ${namespaceFilter}`}
                        </p>
                    </div>
                ) : (
                    <Virtuoso
                        style={{ height: "100%" }}
                        data={filteredResources}
                        itemContent={(_, obj) => {
                            // For nodes, namespace is "-" in resource list but "" in metrics
                            const metricsNs = obj.namespace === '-' ? '' : (obj.namespace || '');
                            const metrics = metricsMap.get(`${metricsNs}/${obj.name}`);
                            const isResourceDeleting = deletingResources.has(obj.id);
                            return isPod ? (
                                <div
                                    onClick={() => onSelect(obj)}
                                    className={`grid grid-cols-[2fr_1.5fr_0.8fr_0.7fr_0.8fr_0.8fr_0.8fr_1.2fr_1fr_40px] gap-3 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group ${isResourceDeleting || obj.status === 'Terminating' ? 'opacity-60' : ''}`}
                                >
                                    <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                                    <div className="text-zinc-500 truncate" title={obj.namespace}>{obj.namespace}</div>
                                    <div className="text-cyan-400 font-mono text-xs font-semibold">{obj.ready || '0/0'}</div>
                                    <div><StatusBadge status={obj.status} isDeleting={isResourceDeleting} /></div>
                                    <div className="text-yellow-400 font-mono text-xs font-semibold">{obj.restarts ?? 0}</div>
                                    <div className="text-emerald-400 font-mono text-xs font-semibold">{metrics?.cpu || '-'}</div>
                                    <div className="text-orange-400 font-mono text-xs font-semibold">{metrics?.memory || '-'}</div>
                                    <div className="text-zinc-500 truncate text-xs" title={obj.node}>{obj.node || '-'}</div>
                                    <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                                    <ResourceContextMenu
                                        resource={obj}
                                        onViewDetails={() => onSelect(obj)}
                                        onDelete={() => handleDeleteRequest(obj)}
                                        isPod={true}
                                        disabled={isResourceDeleting || obj.status === 'Terminating'}
                                    />
                                </div>
                            ) : isNode ? (
                                <div
                                    onClick={() => onSelect(obj)}
                                    className={`grid grid-cols-[2fr_1fr_1fr_1fr_1fr_40px] gap-4 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group ${isResourceDeleting || obj.status === 'Terminating' ? 'opacity-60' : ''}`}
                                >
                                    <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                                    <div><StatusBadge status={obj.status} isDeleting={isResourceDeleting} /></div>
                                    <div className="text-emerald-400 font-mono text-xs font-semibold">{metrics?.cpu || '-'}</div>
                                    <div className="text-orange-400 font-mono text-xs font-semibold">{metrics?.memory || '-'}</div>
                                    <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                                    <ResourceContextMenu
                                        resource={obj}
                                        onViewDetails={() => onSelect(obj)}
                                        onDelete={() => handleDeleteRequest(obj)}
                                        disabled={isResourceDeleting || obj.status === 'Terminating'}
                                    />
                                </div>
                            ) : isIaC ? (
                                (() => {
                                    const iacStatus = getIaCStatus(obj.raw_json);
                                    return (
                                        <div
                                            onClick={() => onSelect(obj)}
                                            className={`grid grid-cols-[2fr_1.5fr_1fr_1fr_1fr_40px] gap-4 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group ${isResourceDeleting || obj.status === 'Terminating' ? 'opacity-60' : ''}`}
                                        >
                                            <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                                            <div className="text-zinc-500 truncate" title={obj.namespace}>{obj.namespace}</div>
                                            <div><IaCStatusBadge status={iacStatus.status} reason={iacStatus.reason} message={iacStatus.message} /></div>
                                            <div><StatusBadge status={obj.status} isDeleting={isResourceDeleting} /></div>
                                            <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                                            <ResourceContextMenu
                                                resource={obj}
                                                onViewDetails={() => onSelect(obj)}
                                                onDelete={() => handleDeleteRequest(obj)}
                                                disabled={isResourceDeleting || obj.status === 'Terminating'}
                                            />
                                        </div>
                                    );
                                })()
                            ) : (
                                <div
                                    onClick={() => onSelect(obj)}
                                    className={`grid grid-cols-[2fr_1.5fr_1fr_1fr_40px] gap-4 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group ${isResourceDeleting || obj.status === 'Terminating' ? 'opacity-60' : ''}`}
                                >
                                    <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                                    <div className="text-zinc-500 truncate" title={obj.namespace}>{obj.namespace}</div>
                                    <div><StatusBadge status={obj.status} isDeleting={isResourceDeleting} /></div>
                                    <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                                    <ResourceContextMenu
                                        resource={obj}
                                        onViewDetails={() => onSelect(obj)}
                                        onDelete={() => handleDeleteRequest(obj)}
                                        disabled={isResourceDeleting || obj.status === 'Terminating'}
                                    />
                                </div>
                            );
                        }}
                    />
                )}
            </div>

            {/* Delete Confirmation Modal */}
            <DeleteConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => { setDeleteModalOpen(false); setResourceToDelete(null); }}
                onConfirm={handleDeleteConfirm}
                resourceName={resourceToDelete?.name || ''}
            />
        </div>
    );
}
