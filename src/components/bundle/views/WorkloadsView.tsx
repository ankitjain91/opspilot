/**
 * WorkloadsView - Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs
 */

import { useState, useMemo } from 'react';
import {
    Box, Server, Database, Layers, Clock, RefreshCw,
    CheckCircle, XCircle, AlertTriangle, Search, Filter
} from 'lucide-react';
import { useBundleContext } from '../BundleContext';
import { BundleResource } from '../types';

type WorkloadType = 'all' | 'pods' | 'deployments' | 'statefulsets' | 'daemonsets' | 'jobs' | 'cronjobs';

const STATUS_COLORS: Record<string, string> = {
    Running: 'bg-green-500/20 text-green-400 border-green-500/30',
    Succeeded: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    Pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    Failed: 'bg-red-500/20 text-red-400 border-red-500/30',
    CrashLoopBackOff: 'bg-red-500/20 text-red-400 border-red-500/30',
    ImagePullBackOff: 'bg-red-500/20 text-red-400 border-red-500/30',
    Error: 'bg-red-500/20 text-red-400 border-red-500/30',
    Unknown: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'
};

const WORKLOAD_ICONS: Record<string, any> = {
    Pod: Box,
    Deployment: Server,
    StatefulSet: Database,
    DaemonSet: Layers,
    Job: Clock,
    CronJob: RefreshCw
};

function StatusBadge({ status }: { status: string | null }) {
    const s = status || 'Unknown';
    const colorClass = STATUS_COLORS[s] || STATUS_COLORS.Unknown;
    return (
        <span className={`px-2 py-0.5 rounded text-xs border ${colorClass}`}>
            {s}
        </span>
    );
}

function WorkloadCard({ resource, onClick }: { resource: BundleResource; onClick: () => void }) {
    const Icon = WORKLOAD_ICONS[resource.kind] || Box;
    const isFailing = ['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff'].includes(resource.status_phase || '');

    return (
        <div
            onClick={onClick}
            className={`p-3 rounded-lg border cursor-pointer transition-all hover:border-purple-500/50 ${
                isFailing ? 'bg-red-500/5 border-red-500/30' : 'bg-zinc-900/50 border-zinc-800'
            }`}
        >
            <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded flex items-center justify-center ${
                    isFailing ? 'bg-red-500/20' : 'bg-purple-500/20'
                }`}>
                    <Icon size={16} className={isFailing ? 'text-red-400' : 'text-purple-400'} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{resource.name}</span>
                        <StatusBadge status={resource.status_phase} />
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                        {resource.kind} • {resource.namespace || 'cluster'}
                    </div>
                    {resource.conditions.length > 0 && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                            {resource.conditions.slice(0, 3).map((c, i) => (
                                <span
                                    key={i}
                                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                                        c.status === 'True'
                                            ? 'bg-green-500/10 text-green-400'
                                            : 'bg-zinc-800 text-zinc-500'
                                    }`}
                                >
                                    {c.condition_type}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export function WorkloadsView() {
    const { resources, selectedNamespace, setSelectedResource } = useBundleContext();
    const [search, setSearch] = useState('');
    const [workloadType, setWorkloadType] = useState<WorkloadType>('all');
    const [showOnlyFailing, setShowOnlyFailing] = useState(false);

    const workloads = useMemo(() => {
        const result: BundleResource[] = [];
        const kinds = workloadType === 'all'
            ? ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']
            : [workloadType === 'pods' ? 'Pod' :
               workloadType === 'deployments' ? 'Deployment' :
               workloadType === 'statefulsets' ? 'StatefulSet' :
               workloadType === 'daemonsets' ? 'DaemonSet' :
               workloadType === 'jobs' ? 'Job' : 'CronJob'];

        Object.values(resources).forEach(resList => {
            resList.forEach(r => {
                if (kinds.includes(r.kind)) {
                    if (selectedNamespace && r.namespace !== selectedNamespace) return;
                    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return;
                    if (showOnlyFailing) {
                        const failing = ['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff'].includes(r.status_phase || '');
                        if (!failing) return;
                    }
                    result.push(r);
                }
            });
        });

        return result.sort((a, b) => {
            const aFailing = ['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff'].includes(a.status_phase || '');
            const bFailing = ['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff'].includes(b.status_phase || '');
            if (aFailing && !bFailing) return -1;
            if (!aFailing && bFailing) return 1;
            return a.name.localeCompare(b.name);
        });
    }, [resources, selectedNamespace, search, workloadType, showOnlyFailing]);

    const stats = useMemo(() => {
        const counts: Record<string, { total: number; failing: number }> = {
            Pod: { total: 0, failing: 0 },
            Deployment: { total: 0, failing: 0 },
            StatefulSet: { total: 0, failing: 0 },
            DaemonSet: { total: 0, failing: 0 },
            Job: { total: 0, failing: 0 },
            CronJob: { total: 0, failing: 0 }
        };

        Object.values(resources).forEach(resList => {
            resList.forEach(r => {
                if (counts[r.kind]) {
                    if (selectedNamespace && r.namespace !== selectedNamespace) return;
                    counts[r.kind].total++;
                    const failing = ['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff'].includes(r.status_phase || '');
                    if (failing) counts[r.kind].failing++;
                }
            });
        });

        return counts;
    }, [resources, selectedNamespace]);

    const workloadTypes: { key: WorkloadType; label: string; kind: string }[] = [
        { key: 'all', label: 'All', kind: '' },
        { key: 'pods', label: 'Pods', kind: 'Pod' },
        { key: 'deployments', label: 'Deployments', kind: 'Deployment' },
        { key: 'statefulsets', label: 'StatefulSets', kind: 'StatefulSet' },
        { key: 'daemonsets', label: 'DaemonSets', kind: 'DaemonSet' },
        { key: 'jobs', label: 'Jobs', kind: 'Job' },
        { key: 'cronjobs', label: 'CronJobs', kind: 'CronJob' }
    ];

    return (
        <div className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-white">Workloads</h2>
                    <p className="text-xs text-zinc-500">
                        {selectedNamespace ? `Namespace: ${selectedNamespace}` : 'All namespaces'} • {workloads.length} items
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setShowOnlyFailing(!showOnlyFailing)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                            showOnlyFailing
                                ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600'
                        }`}
                    >
                        <AlertTriangle size={12} />
                        Failing Only
                    </button>
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search workloads..."
                            className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500 w-64"
                        />
                    </div>
                </div>
            </div>

            {/* Type Filter Tabs */}
            <div className="flex gap-2 flex-wrap">
                {workloadTypes.map(({ key, label, kind }) => {
                    const stat = kind ? stats[kind] : null;
                    return (
                        <button
                            key={key}
                            onClick={() => setWorkloadType(key)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 ${
                                workloadType === key
                                    ? 'bg-purple-600 text-white'
                                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                            }`}
                        >
                            {label}
                            {stat && (
                                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                    stat.failing > 0 ? 'bg-red-500/30 text-red-300' : 'bg-zinc-700 text-zinc-400'
                                }`}>
                                    {stat.total}{stat.failing > 0 && ` (${stat.failing}⚠)`}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Workload Grid */}
            <div className="grid grid-cols-2 gap-3">
                {workloads.map(resource => (
                    <WorkloadCard
                        key={`${resource.kind}-${resource.namespace}-${resource.name}`}
                        resource={resource}
                        onClick={() => setSelectedResource(resource)}
                    />
                ))}
            </div>

            {workloads.length === 0 && (
                <div className="text-center py-12 text-zinc-500">
                    <Box size={32} className="mx-auto mb-2 opacity-50" />
                    No workloads match your filters
                </div>
            )}
        </div>
    );
}
