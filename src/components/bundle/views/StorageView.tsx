/**
 * StorageView - Storage Classes, PVs, PVCs
 */

import { useState, useMemo } from 'react';
import { HardDrive, Database, Folder, Search, CheckCircle, XCircle, Clock } from 'lucide-react';
import { useBundleContext } from '../BundleContext';

type StorageTab = 'classes' | 'pvs' | 'pvcs';

const STATUS_COLORS: Record<string, string> = {
    Bound: 'bg-green-500/20 text-green-400 border-green-500/30',
    Available: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    Released: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    Pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    Failed: 'bg-red-500/20 text-red-400 border-red-500/30',
    Lost: 'bg-red-500/20 text-red-400 border-red-500/30'
};

function StatusBadge({ status }: { status: string }) {
    const colorClass = STATUS_COLORS[status] || 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30';
    return (
        <span className={`px-2 py-0.5 rounded text-xs border ${colorClass}`}>
            {status}
        </span>
    );
}

function StorageClassCard({ sc }: { sc: any }) {
    const isDefault = sc.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';

    return (
        <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 hover:border-zinc-700 transition-colors">
            <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                    <Database size={20} className="text-purple-400" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{sc.metadata?.name}</span>
                        {isDefault && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                                default
                            </span>
                        )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">
                        Provisioner: {sc.provisioner}
                    </div>
                    <div className="flex gap-2 mt-2 flex-wrap">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                            Reclaim: {sc.reclaimPolicy || 'Delete'}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                            Binding: {sc.volumeBindingMode || 'Immediate'}
                        </span>
                        {sc.allowVolumeExpansion && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                                Expandable
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function PVCard({ pv }: { pv: any }) {
    const status = pv.status?.phase || 'Unknown';
    const capacity = pv.spec?.capacity?.storage || 'N/A';
    const accessModes = pv.spec?.accessModes?.join(', ') || 'N/A';
    const storageClass = pv.spec?.storageClassName || 'N/A';
    const claimRef = pv.spec?.claimRef;

    return (
        <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 hover:border-zinc-700 transition-colors">
            <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                    <HardDrive size={20} className="text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{pv.metadata?.name}</span>
                        <StatusBadge status={status} />
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs">
                        <div>
                            <span className="text-zinc-500">Capacity:</span>
                            <span className="text-zinc-300 ml-1">{capacity}</span>
                        </div>
                        <div>
                            <span className="text-zinc-500">Access:</span>
                            <span className="text-zinc-300 ml-1">{accessModes}</span>
                        </div>
                        <div>
                            <span className="text-zinc-500">Class:</span>
                            <span className="text-zinc-300 ml-1">{storageClass}</span>
                        </div>
                        {claimRef && (
                            <div>
                                <span className="text-zinc-500">Claim:</span>
                                <span className="text-zinc-300 ml-1">
                                    {claimRef.namespace}/{claimRef.name}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function PVCCard({ pvc }: { pvc: any }) {
    const status = pvc.status?.phase || 'Unknown';
    const capacity = pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || 'N/A';
    const accessModes = pvc.spec?.accessModes?.join(', ') || 'N/A';
    const storageClass = pvc.spec?.storageClassName || 'N/A';
    const volumeName = pvc.spec?.volumeName || 'N/A';

    return (
        <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4 hover:border-zinc-700 transition-colors">
            <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    status === 'Bound' ? 'bg-green-500/20' : 'bg-yellow-500/20'
                }`}>
                    <Folder size={20} className={status === 'Bound' ? 'text-green-400' : 'text-yellow-400'} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{pvc.metadata?.name}</span>
                        <StatusBadge status={status} />
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                        {pvc.metadata?.namespace}
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs">
                        <div>
                            <span className="text-zinc-500">Capacity:</span>
                            <span className="text-zinc-300 ml-1">{capacity}</span>
                        </div>
                        <div>
                            <span className="text-zinc-500">Access:</span>
                            <span className="text-zinc-300 ml-1">{accessModes}</span>
                        </div>
                        <div>
                            <span className="text-zinc-500">Class:</span>
                            <span className="text-zinc-300 ml-1">{storageClass}</span>
                        </div>
                        <div>
                            <span className="text-zinc-500">Volume:</span>
                            <span className="text-zinc-300 ml-1 truncate">{volumeName}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function StorageView() {
    const { resources, storageClasses, pvs, selectedNamespace } = useBundleContext();
    const [tab, setTab] = useState<StorageTab>('classes');
    const [search, setSearch] = useState('');

    const pvcs = useMemo(() => {
        const result: any[] = [];
        Object.values(resources).forEach(resList => {
            resList.forEach(r => {
                if (r.kind === 'PersistentVolumeClaim') {
                    if (selectedNamespace && r.namespace !== selectedNamespace) return;
                    result.push(r);
                }
            });
        });
        return result;
    }, [resources, selectedNamespace]);

    const filteredClasses = useMemo(() => {
        if (!search) return storageClasses;
        const q = search.toLowerCase();
        return storageClasses.filter((sc: any) =>
            sc.metadata?.name?.toLowerCase().includes(q) ||
            sc.provisioner?.toLowerCase().includes(q)
        );
    }, [storageClasses, search]);

    const filteredPVs = useMemo(() => {
        if (!search) return pvs;
        const q = search.toLowerCase();
        return pvs.filter((pv: any) =>
            pv.metadata?.name?.toLowerCase().includes(q) ||
            pv.spec?.storageClassName?.toLowerCase().includes(q)
        );
    }, [pvs, search]);

    const filteredPVCs = useMemo(() => {
        if (!search) return pvcs;
        const q = search.toLowerCase();
        return pvcs.filter((pvc: any) =>
            pvc.name?.toLowerCase().includes(q) ||
            pvc.namespace?.toLowerCase().includes(q)
        );
    }, [pvcs, search]);

    const stats = useMemo(() => ({
        classes: storageClasses.length,
        pvs: pvs.length,
        pvcs: pvcs.length,
        boundPVCs: pvcs.filter((p: any) => p.status_phase === 'Bound').length,
        pendingPVCs: pvcs.filter((p: any) => p.status_phase === 'Pending').length
    }), [storageClasses, pvs, pvcs]);

    return (
        <div className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-white">Storage</h2>
                    <p className="text-xs text-zinc-500">
                        {stats.classes} classes • {stats.pvs} volumes • {stats.pvcs} claims
                        {stats.pendingPVCs > 0 && ` (${stats.pendingPVCs} pending)`}
                    </p>
                </div>
                <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search storage..."
                        className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500 w-64"
                    />
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2">
                {([
                    { key: 'classes', label: 'Storage Classes', count: stats.classes },
                    { key: 'pvs', label: 'Persistent Volumes', count: stats.pvs },
                    { key: 'pvcs', label: 'Volume Claims', count: stats.pvcs }
                ] as { key: StorageTab; label: string; count: number }[]).map(({ key, label, count }) => (
                    <button
                        key={key}
                        onClick={() => setTab(key)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                            tab === key
                                ? 'bg-purple-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                        }`}
                    >
                        {label}
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                            tab === key ? 'bg-purple-500' : 'bg-zinc-700'
                        }`}>
                            {count}
                        </span>
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className="grid grid-cols-2 gap-4">
                {tab === 'classes' && filteredClasses.map((sc: any, i: number) => (
                    <StorageClassCard key={sc.metadata?.name || i} sc={sc} />
                ))}
                {tab === 'pvs' && filteredPVs.map((pv: any, i: number) => (
                    <PVCard key={pv.metadata?.name || i} pv={pv} />
                ))}
                {tab === 'pvcs' && filteredPVCs.map((pvc: any, i: number) => (
                    <PVCCard key={`${pvc.namespace}-${pvc.name}` || i} pvc={pvc} />
                ))}
            </div>

            {((tab === 'classes' && filteredClasses.length === 0) ||
              (tab === 'pvs' && filteredPVs.length === 0) ||
              (tab === 'pvcs' && filteredPVCs.length === 0)) && (
                <div className="text-center py-12 text-zinc-500">
                    <HardDrive size={32} className="mx-auto mb-2 opacity-50" />
                    No storage resources found
                </div>
            )}
        </div>
    );
}
