import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { Virtuoso } from "react-virtuoso";
import {
    AlertCircle,
    Activity,
    Layers,
    ChevronDown
} from 'lucide-react';

import Loading from '../../components/Loading';
import { StatusBadge } from '../shared/StatusBadge';
import { ResourceContextMenu } from '../shared/ResourceContextMenu';
import { DeleteConfirmationModal } from '../shared/DeleteConfirmationModal';

import { useResourceWatch } from '../../hooks/useResourceWatch';
import { useLiveAge, formatAge } from '../../utils/time';
import { NavResource, K8sObject, ResourceMetrics } from '../../types/k8s';

// Utility for formatting CPU in cores or millicores
const formatCpu = (nano: number | undefined) => {
    if (nano === undefined) return '-';
    if (nano >= 1_000_000_000) {
        return `${(nano / 1_000_000_000).toFixed(2)} cores`;
    }
    return `${(nano / 1_000_000).toFixed(0)}m`;
};

// Utility for formatting memory in KiB, MiB, GiB etc
const formatMemory = (bytes: number | undefined) => {
    if (bytes === undefined || bytes === 0) return '-';
    const k = 1024;
    const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

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
            return { status: 'Reconciling', reason: ready?.reason || 'Reconciling', message: ready.message };
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

// Standalone Resizer Component
const ColumnResizer = ({ width, minWidth, onResize, onResizeEnd }: {
    width: number;
    minWidth: number;
    onResize: (width: number) => void;
    onResizeEnd: () => void;
}) => {
    const [isResizing, setIsResizing] = useState(false);
    const startXRef = React.useRef<number>(0);
    const startWidthRef = React.useRef<number>(0);

    useEffect(() => {
        if (!isResizing) return;

        const onMouseMove = (e: MouseEvent) => {
            const deltaX = e.clientX - startXRef.current;
            const newWidth = Math.max(minWidth, startWidthRef.current + deltaX);
            onResize(newWidth);
        };

        const onMouseUp = () => {
            setIsResizing(false);
            onResizeEnd();
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        return () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [isResizing, minWidth, onResize, onResizeEnd]);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        startXRef.current = e.clientX;
        startWidthRef.current = width;
        setIsResizing(true);
    };

    return (
        <div
            className="w-1 hover:bg-cyan-500/50 cursor-col-resize absolute right-0 top-0 bottom-0 z-20 flex justify-center group touch-none"
            onMouseDown={handleMouseDown}
        >
            <div className={`w-0.5 h-full ${isResizing ? 'bg-cyan-500' : 'bg-transparent group-hover:bg-cyan-500/30'}`} />
        </div>
    );
};

// Standalone Header Component
const SortableHeader = ({
    col,
    index,
    isLast,
    sortConfig,
    onSort,
    onResize,
    onResizeEnd
}: {
    col: ColumnDef;
    index: number;
    isLast: boolean;
    sortConfig: { key: string; direction: 'asc' | 'desc' } | null;
    onSort: (key: string) => void;
    onResize: (width: number) => void;
    onResizeEnd: () => void;
}) => {
    const isActive = sortConfig?.key === col.sortKey;
    const direction = sortConfig?.direction;

    return (
        <div className={`relative flex items-center h-full px-3 border-r border-transparent ${col.id !== 'actions' ? 'border-zinc-800/50' : ''}`}>
            <div
                onClick={() => col.sortKey && onSort(col.sortKey)}
                className={`flex items-center gap-1 flex-1 truncate ${col.sortKey ? 'cursor-pointer hover:text-cyan-400 select-none' : ''}`}
            >
                <span className="truncate">{col.label}</span>
                {col.sortKey && (
                    <div className="flex flex-col">
                        <ChevronDown size={10} className={`-mb-1 ${isActive && direction === 'asc' ? 'text-cyan-400' : 'text-gray-700'}`} style={{ transform: 'rotate(180deg)' }} />
                        <ChevronDown size={10} className={`${isActive && direction === 'desc' ? 'text-cyan-400' : 'text-gray-700'}`} />
                    </div>
                )}
            </div>
            {!isLast && (
                <ColumnResizer
                    width={col.width}
                    minWidth={col.minWidth}
                    onResize={onResize}
                    onResizeEnd={onResizeEnd}
                />
            )}
        </div>
    );
};

// --- Column Definitions ---
type ColumnId = 'name' | 'namespace' | 'ready' | 'status' | 'restarts' | 'cpu' | 'memory' | 'node' | 'age' | 'sync' | 'type' | 'message' | 'count' | 'source' | 'involvedObject' | 'actions';

interface ColumnDef {
    id: ColumnId;
    label: string;
    width: number; // Initial width in pixels or 'fr' approximation
    minWidth: number;
    sortKey?: string;
}

const COLUMN_CONFIGS: Record<string, ColumnDef[]> = {
    'Pod': [
        { id: 'name', label: 'Name', width: 280, minWidth: 150, sortKey: 'name' },
        { id: 'namespace', label: 'Namespace', width: 180, minWidth: 100, sortKey: 'namespace' },
        { id: 'ready', label: 'Ready', width: 80, minWidth: 60, sortKey: 'ready' },
        { id: 'status', label: 'Status', width: 120, minWidth: 80, sortKey: 'status' },
        { id: 'restarts', label: 'Restarts', width: 80, minWidth: 60, sortKey: 'restarts' },
        { id: 'cpu', label: 'CPU', width: 80, minWidth: 60, sortKey: 'cpu' },
        { id: 'memory', label: 'Memory', width: 80, minWidth: 60, sortKey: 'memory' },
        { id: 'node', label: 'Node', width: 140, minWidth: 100, sortKey: 'node' },
        { id: 'age', label: 'Age', width: 80, minWidth: 60, sortKey: 'age' },
        { id: 'actions', label: '', width: 40, minWidth: 40 }
    ],
    'Node': [
        { id: 'name', label: 'Name', width: 280, minWidth: 150, sortKey: 'name' },
        { id: 'status', label: 'Status', width: 120, minWidth: 80, sortKey: 'status' },
        { id: 'cpu', label: 'CPU', width: 100, minWidth: 60, sortKey: 'cpu' },
        { id: 'memory', label: 'Memory', width: 100, minWidth: 60, sortKey: 'memory' },
        { id: 'age', label: 'Age', width: 100, minWidth: 60, sortKey: 'age' },
        { id: 'actions', label: '', width: 40, minWidth: 40 }
    ],
    'Event': [
        { id: 'type', label: 'Type', width: 80, minWidth: 60, sortKey: 'type' },
        { id: 'name', label: 'Reason', width: 200, minWidth: 100, sortKey: 'name' }, // Mapped to Reason
        { id: 'involvedObject', label: 'Involved Object', width: 200, minWidth: 140, sortKey: 'involvedObject' },
        { id: 'source', label: 'Source', width: 140, minWidth: 100, sortKey: 'source' },
        { id: 'message', label: 'Message', width: 450, minWidth: 200, sortKey: 'message' },
        { id: 'count', label: 'Count', width: 60, minWidth: 50, sortKey: 'count' },
        { id: 'age', label: 'Last Seen', width: 100, minWidth: 80, sortKey: 'age' },
        { id: 'actions', label: '', width: 40, minWidth: 40 }
    ],
    // Default for others
    'default': [
        { id: 'name', label: 'Name', width: 300, minWidth: 150, sortKey: 'name' },
        { id: 'namespace', label: 'Namespace', width: 200, minWidth: 100, sortKey: 'namespace' },
        { id: 'status', label: 'Status', width: 120, minWidth: 80, sortKey: 'status' },
        { id: 'age', label: 'Age', width: 100, minWidth: 60, sortKey: 'age' },
        { id: 'actions', label: '', width: 40, minWidth: 40 }
    ]
};

// Add IaC specific config
const IAC_CONFIG: ColumnDef[] = [
    { id: 'name', label: 'Name', width: 280, minWidth: 150, sortKey: 'name' },
    { id: 'namespace', label: 'Namespace', width: 180, minWidth: 100, sortKey: 'namespace' },
    { id: 'sync', label: 'Sync', width: 100, minWidth: 80, sortKey: 'sync' },
    { id: 'status', label: 'Status', width: 120, minWidth: 80, sortKey: 'status' },
    { id: 'age', label: 'Age', width: 100, minWidth: 60, sortKey: 'age' },
    { id: 'actions', label: '', width: 40, minWidth: 40 }
];


export function ResourceList({ resourceType, onSelect, namespaceFilter, searchQuery, currentContext }: ResourceListProps) {
    if (!resourceType || !resourceType.kind) {
        return <div className="h-full flex items-center justify-center"><Loading size={24} label="Loading" /></div>;
    }

    const qc = useQueryClient();
    const kindLower = (resourceType.kind || '').toLowerCase();
    const isPod = kindLower === 'pod';
    const isNode = kindLower === 'node';
    const _isIaC = isIaCResource(resourceType.group);
    const isEvent = kindLower === 'event';

    // --- Column State Management ---
    const getInitialColumns = (): ColumnDef[] => {
        let baseCols: ColumnDef[] = [];
        if (_isIaC) baseCols = JSON.parse(JSON.stringify(IAC_CONFIG));
        else if (isPod) baseCols = JSON.parse(JSON.stringify(COLUMN_CONFIGS['Pod']));
        else if (isNode) baseCols = JSON.parse(JSON.stringify(COLUMN_CONFIGS['Node']));
        else if (isEvent) baseCols = JSON.parse(JSON.stringify(COLUMN_CONFIGS['Event']));
        else baseCols = JSON.parse(JSON.stringify(COLUMN_CONFIGS['default']));

        // Enforce minimum width based on header label length
        // Approx 8px per char + 40px padding/icon
        return baseCols.map(col => {
            const minHeaderWidth = (col.label.length * 9) + 40;
            return {
                ...col,
                width: Math.max(col.width, minHeaderWidth),
                minWidth: Math.max(col.minWidth, minHeaderWidth)
            };
        });
    };

    const [columns, setColumns] = useState<ColumnDef[]>(getInitialColumns);

    // Load saved widths from localStorage
    useEffect(() => {
        const key = `col-widths-${resourceType.kind}`;
        const saved = localStorage.getItem(key);
        if (saved) {
            try {
                const savedWidths = JSON.parse(saved);
                const defaults = getInitialColumns();
                // Merge saved widths into default structure (handles schema changes)
                const merged = defaults.map(c => {
                    const found = savedWidths.find((s: ColumnDef) => s.id === c.id);
                    return found ? { ...c, width: found.width } : c;
                });
                setColumns(merged);
            } catch (e) {
                console.error("Failed to parse saved column widths", e);
                setColumns(getInitialColumns());
            }
        } else {
            setColumns(getInitialColumns());
        }
    }, [resourceType.kind]);

    // Save widths when they change
    const saveColumns = (cols: ColumnDef[]) => {
        const key = `col-widths-${resourceType.kind}`;
        localStorage.setItem(key, JSON.stringify(cols));
    };

    const handleResizeEnd = () => {
        saveColumns(columns);
    };

    // Callback for resizing specific column
    const handleColumnResize = (index: number, newWidth: number) => {
        setColumns(cols => {
            const newCols = [...cols];
            if (newCols[index].width !== newWidth) {
                newCols[index] = { ...newCols[index], width: newWidth };
                return newCols;
            }
            return cols;
        });
    };

    // --- Data Fetching ---
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
            // Note: For resources with finalizers (like Namespaces), this just initiates deletion
            // The resource may enter "Terminating" state before being fully removed
            (window as any).showToast?.(`${resourceKind} '${resourceName}' deletion initiated`, 'success');
            // Refetch immediately to show updated status (e.g., Terminating)
            refetch();
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

    const watchNamespace = namespaceFilter === "All Namespaces" ? null : namespaceFilter;
    const { isWatching, syncComplete } = useResourceWatch(resourceType, watchNamespace, currentContext, true);
    useLiveAge(1000);

    // Track document visibility for smart polling
    const [isDocumentVisible, setIsDocumentVisible] = useState(!document.hidden);
    useEffect(() => {
        const handleVisibilityChange = () => setIsDocumentVisible(!document.hidden);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, []);

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
        enabled: true,
        staleTime: 30000,
        gcTime: 1000 * 60 * 5,
        refetchInterval: false,
        refetchOnWindowFocus: false,
    });

    useEffect(() => {
        const handler = () => refetch();
        window.addEventListener("lenskiller:reload", handler);
        return () => window.removeEventListener("lenskiller:reload", handler);
    }, [refetch]);


    // Metrics polling: reduce frequency when watches are active or document hidden
    const metricsPollingInterval = !isDocumentVisible ? false : (isWatching ? 60000 : 30000);
    const { data: metricsData } = useQuery({
        queryKey: ["list_metrics", currentContext, resourceType.kind || "", namespaceFilter],
        queryFn: async () => {
            try {
                return await invoke<ResourceMetrics[]>("get_resource_metrics", {
                    kind: resourceType.kind,
                    namespace: isPod ? (namespaceFilter === "All Namespaces" ? null : namespaceFilter) : null
                });
            } catch (e: any) {
                if (!String(e).includes("404")) console.warn("Metrics not available:", e);
                return [];
            }
        },
        enabled: isPod || isNode,
        staleTime: isWatching ? 20000 : 10000, // Longer stale time when watching
        refetchInterval: metricsPollingInterval, // 60s when watching, 30s otherwise, disabled when hidden
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

            // Status filter from cockpit navigation (e.g., "Failed", "Pending", "NotReady")
            let statusMatch = true;
            if (resourceType.statusFilter) {
                const filter = resourceType.statusFilter.toLowerCase();
                const status = r.status?.toLowerCase() || '';

                // Handle special cases for different resource types
                if (filter === 'notready') {
                    // For nodes: status is "Ready" or "NotReady"
                    statusMatch = status !== 'ready';
                } else if (filter === 'unhealthy') {
                    // For deployments: check ready field or status
                    const [ready, desired] = (r.ready || '0/0').split('/').map(Number);
                    statusMatch = ready < desired || status === 'failed' || status === 'error';
                } else {
                    // Direct match for pods: Running, Pending, Failed, Unknown
                    statusMatch = status === filter || status.includes(filter);
                }
            }

            // Namespace filter from cockpit navigation
            const nsFilterMatch = !resourceType.namespaceFilter || r.namespace === resourceType.namespaceFilter;

            return nsMatch && searchMatch && statusMatch && nsFilterMatch;
        });

        if (sortConfig) {
            filtered = [...filtered].sort((a, b) => {
                let aVal: any = a[sortConfig.key as keyof K8sObject];
                let bVal: any = b[sortConfig.key as keyof K8sObject];

                if (sortConfig.key === 'age') {
                    aVal = new Date(a.age).getTime();
                    bVal = new Date(b.age).getTime();
                } else if (sortConfig.key === 'restarts') {
                    aVal = a.restarts ?? 0;
                    bVal = b.restarts ?? 0;
                } else if (sortConfig.key === 'ready') {
                    const [aReady, aTotal] = (a.ready || '0/0').split('/').map(Number);
                    const [bReady, bTotal] = (b.ready || '0/0').split('/').map(Number);
                    aVal = aTotal > 0 ? aReady / aTotal : 0;
                    bVal = bTotal > 0 ? bReady / bTotal : 0;
                } else if (sortConfig.key === 'cpu' || sortConfig.key === 'memory') {
                    const aNs = a.namespace === '-' ? '' : (a.namespace || '');
                    const bNs = b.namespace === '-' ? '' : (b.namespace || '');
                    const aMetrics = metricsMap.get(`${aNs}/${a.name}`);
                    const bMetrics = metricsMap.get(`${bNs}/${b.name}`);
                    aVal = sortConfig.key === 'cpu' ? (aMetrics?.cpu_nano ?? 0) : (aMetrics?.memory_bytes ?? 0);
                    bVal = sortConfig.key === 'cpu' ? (bMetrics?.cpu_nano ?? 0) : (bMetrics?.memory_bytes ?? 0);
                } else if (sortConfig.key === 'sync') {
                    const statusOrder = { 'Failed': 0, 'Reconciling': 1, 'Unknown': 2, 'Reconciled': 3 };
                    const aStatus = getIaCStatus(a.raw_json).status;
                    const bStatus = getIaCStatus(b.raw_json).status;
                    aVal = statusOrder[aStatus];
                    bVal = statusOrder[bStatus];
                }

                if (typeof aVal === 'string' && typeof bVal === 'string') {
                    return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
                }
                if (sortConfig.direction === 'asc') return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
            });
        }
        return filtered;
    }, [resources, namespaceFilter, searchQuery, sortConfig, metricsMap]);

    const handleSort = (key: string) => {
        setSortConfig(current => {
            if (!current || current.key !== key) return { key, direction: 'asc' };
            if (current.direction === 'asc') return { key, direction: 'desc' };
            return null;
        });
    };

    // Dynamic Grid Style
    const gridStyle = {
        display: 'grid',
        gridTemplateColumns: columns.map(c => `${c.width}px`).join(' '),
        gap: '0px'
    };






    if (!resources && !isListLoading && isError) return <div className="p-8 text-center text-red-400">Error: {error ? String(error) : 'Unknown error'}</div>;

    return (
        <div className="h-full flex flex-col bg-[#09090b]">
            {/* Header Status Bar */}
            <div className="flex items-center justify-between px-6 py-2 border-b border-white/5 bg-zinc-900/30 backdrop-blur-md text-xs sticky top-0 z-10 shrink-0">
                <div className="flex items-center gap-2 text-zinc-500">
                    <span className="uppercase tracking-wider font-semibold">{resourceType.kind}</span>
                    {isListLoading && !syncComplete ? (
                        <span className="flex items-center gap-1 text-cyan-400"><Loading size={12} label="Loading" /></span>
                    ) : isWatching ? (
                        <span className="flex items-center gap-1 text-emerald-400"><Activity size={12} /> Real-time</span>
                    ) : (
                        <span className={`flex items-center gap-1 ${isFetching ? 'text-cyan-400' : 'text-zinc-500'}`}>
                            <div className={`w-1.5 h-1.5 rounded-full ${isFetching ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-500'}`} />
                            {isFetching ? 'Updating...' : 'Polling'}
                        </span>
                    )}
                </div>
                <div className="text-[10px] text-zinc-600">
                    {filteredResources.length} items
                </div>
            </div>

            {/* Table Header */}
            <div
                className="bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm overflow-hidden"
                style={gridStyle}
            >
                {columns.map((col, idx) => (
                    <SortableHeader
                        key={col.id}
                        col={col}
                        index={idx}
                        isLast={idx === columns.length - 1}
                        sortConfig={sortConfig}
                        onSort={handleSort}
                        onResize={(w) => handleColumnResize(idx, w)}
                        onResizeEnd={handleResizeEnd}
                    />
                ))}
            </div>

            {/* List */}
            <div className="flex-1 overflow-auto">
                {isListLoading && !resources ? (
                    <div className="p-4 space-y-2">
                        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-10 bg-white/5 rounded animate-pulse" />)}
                    </div>
                ) : filteredResources.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-500">
                        <Layers size={32} className="opacity-40 text-zinc-400 mb-4" />
                        <p>No resources found</p>
                    </div>
                ) : (
                    <Virtuoso
                        style={{ height: "100%" }}
                        data={filteredResources}
                        itemContent={(_, obj) => {
                            const metricsNs = obj.namespace === '-' ? '' : (obj.namespace || '');
                            const metrics = metricsMap.get(`${metricsNs}/${obj.name}`);
                            const isResourceDeleting = deletingResources.has(obj.id);

                            // Determine cell content based on column
                            const renderCell = (col: ColumnDef) => {
                                switch (col.id) {
                                    case 'name':
                                        // For Events, show Reason. Fallback to name (UID) if reason missing.
                                        const reason = isEvent ? (obj.reason || obj.name) : obj.name;
                                        return <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={reason}>{reason}</div>;
                                    case 'namespace':
                                        return <div className="text-zinc-500 truncate" title={obj.namespace}>{obj.namespace}</div>;
                                    case 'ready':
                                        return <div className="text-cyan-400 font-mono text-xs font-semibold">{obj.ready || '0/0'}</div>;
                                    case 'status':
                                        return <StatusBadge status={obj.status} isDeleting={isResourceDeleting} />;
                                    case 'restarts':
                                        return <div className="text-yellow-400 font-mono text-xs font-semibold">{obj.restarts ?? 0}</div>;
                                    case 'cpu':
                                        return <div className="text-emerald-400 font-mono text-[10px] font-semibold">{formatCpu(metrics?.cpu_nano)}</div>;
                                    case 'memory':
                                        return <div className="text-orange-400 font-mono text-[10px] font-semibold">{formatMemory(metrics?.memory_bytes)}</div>;
                                    case 'node':
                                        return <div className="text-zinc-500 truncate text-xs" title={obj.node}>{obj.node || '-'}</div>;
                                    case 'age':
                                        return <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>;
                                    case 'sync':
                                        const iacStatus = getIaCStatus(obj.raw_json);
                                        return <IaCStatusBadge status={iacStatus.status} reason={iacStatus.reason} message={iacStatus.message} />;
                                    case 'type':
                                        return <div className={`${obj.type === 'Warning' ? 'text-red-400' : 'text-zinc-500'}`}>{obj.type || 'Normal'}</div>;
                                    case 'message':
                                        return <div className="text-zinc-500 truncate" title={obj.message}>{obj.message || '-'}</div>;
                                    case 'count':
                                        return <div className="text-zinc-500 font-mono text-xs">{obj.count || 1}</div>;
                                    case 'involvedObject':
                                        return <div className="text-indigo-400/80 truncate text-xs font-mono" title={obj.involved_object}>{obj.involved_object || '-'}</div>;
                                    case 'source':
                                        return <div className="text-zinc-600 truncate text-xs" title={obj.source_component}>{obj.source_component || '-'}</div>;
                                    case 'actions':
                                        return (
                                            <ResourceContextMenu
                                                resource={obj}
                                                onViewDetails={() => onSelect(obj)}
                                                onDelete={() => handleDeleteRequest(obj)}
                                                isPod={isPod}
                                                disabled={isResourceDeleting || obj.status === 'Terminating'}
                                            />
                                        );
                                    default:
                                        return null;
                                }
                            };

                            return (
                                <div
                                    onClick={() => onSelect(obj)}
                                    style={gridStyle}
                                    className={`
                                        gap-0 border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group text-sm min-h-[44px]
                                        ${isResourceDeleting || obj.status === 'Terminating' ? 'opacity-60' : ''}
                                    `}
                                >
                                    {columns.map(col => (
                                        <div key={col.id} className={`px-3 ${col.id === 'actions' ? '' : 'truncate overflow-hidden'}`}>
                                            {renderCell(col)}
                                        </div>
                                    ))}
                                </div>
                            );
                        }}
                    />
                )}
            </div>

            <DeleteConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => { setDeleteModalOpen(false); setResourceToDelete(null); }}
                onConfirm={handleDeleteConfirm}
                resourceName={resourceToDelete?.name || ''}
            />
        </div>
    );
}
