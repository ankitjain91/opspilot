/**
 * NodesView - Kubernetes nodes with details and conditions
 */

import { useState, useMemo } from 'react';
import {
    Server, Cpu, HardDrive, Box, CheckCircle, XCircle,
    AlertTriangle, Search, ChevronDown, Activity
} from 'lucide-react';
import { useBundleContext } from '../BundleContext';
import { BundleNodeInfo, NodeCondition } from '../types';

function parseResourceValue(value: string): number {
    if (!value) return 0;
    if (value.endsWith('Ki')) return parseInt(value) / 1024 / 1024;
    if (value.endsWith('Mi')) return parseInt(value) / 1024;
    if (value.endsWith('Gi')) return parseInt(value);
    if (value.endsWith('m')) return parseInt(value) / 1000;
    return parseInt(value);
}

function formatMemory(value: string): string {
    if (!value) return 'N/A';
    const gi = parseResourceValue(value);
    return `${gi.toFixed(1)} Gi`;
}

function ConditionBadge({ condition }: { condition: NodeCondition }) {
    const isOk = condition.status === 'True' && condition.condition_type === 'Ready' ||
                 condition.status === 'False' && condition.condition_type !== 'Ready';

    return (
        <div
            className={`px-2 py-1 rounded text-xs flex items-center gap-1.5 ${
                isOk
                    ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}
            title={condition.message || condition.reason || ''}
        >
            {isOk ? <CheckCircle size={10} /> : <XCircle size={10} />}
            {condition.condition_type}
        </div>
    );
}

function ResourceBar({ used, total, label, color }: {
    used: number;
    total: number;
    label: string;
    color: string;
}) {
    const percentage = total > 0 ? Math.min(100, (used / total) * 100) : 0;

    return (
        <div className="space-y-1">
            <div className="flex justify-between text-xs">
                <span className="text-zinc-500">{label}</span>
                <span className="text-zinc-400">
                    {used.toFixed(1)} / {total.toFixed(1)}
                </span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all ${color}`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
        </div>
    );
}

function NodeCard({ node }: { node: BundleNodeInfo }) {
    const [expanded, setExpanded] = useState(false);

    const isReady = node.conditions.some(c => c.condition_type === 'Ready' && c.status === 'True');
    const hasIssues = node.conditions.some(c =>
        (c.condition_type !== 'Ready' && c.status === 'True') ||
        (c.condition_type === 'Ready' && c.status !== 'True')
    );

    const cpuCap = parseResourceValue(node.cpu_capacity);
    const cpuAlloc = parseResourceValue(node.cpu_allocatable);
    const memCap = parseResourceValue(node.memory_capacity);
    const memAlloc = parseResourceValue(node.memory_allocatable);
    const podsCap = parseInt(node.pods_capacity) || 0;
    const podsAlloc = parseInt(node.pods_allocatable) || 0;

    return (
        <div className={`bg-zinc-900/50 rounded-xl border overflow-hidden transition-colors ${
            !isReady ? 'border-red-500/30' : hasIssues ? 'border-yellow-500/30' : 'border-zinc-800 hover:border-zinc-700'
        }`}>
            <div
                className="p-4 cursor-pointer"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-start gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        !isReady ? 'bg-red-500/20' : hasIssues ? 'bg-yellow-500/20' : 'bg-purple-500/20'
                    }`}>
                        <Server size={20} className={
                            !isReady ? 'text-red-400' : hasIssues ? 'text-yellow-400' : 'text-purple-400'
                        } />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-white">{node.name}</span>
                            {!isReady && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-400">
                                    Not Ready
                                </span>
                            )}
                            {node.roles.map(role => (
                                <span
                                    key={role}
                                    className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-400"
                                >
                                    {role}
                                </span>
                            ))}
                        </div>
                        <div className="text-xs text-zinc-500 mt-1 flex items-center gap-3">
                            <span>{node.kubelet_version}</span>
                            {node.internal_ip && <span>{node.internal_ip}</span>}
                        </div>
                        <div className="grid grid-cols-3 gap-3 mt-3">
                            <div className="flex items-center gap-2 text-xs">
                                <Cpu size={12} className="text-blue-400" />
                                <span className="text-zinc-400">{cpuAlloc} / {cpuCap} cores</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <HardDrive size={12} className="text-green-400" />
                                <span className="text-zinc-400">{formatMemory(node.memory_allocatable)}</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <Box size={12} className="text-purple-400" />
                                <span className="text-zinc-400">{podsAlloc} / {podsCap} pods</span>
                            </div>
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
                    {/* Conditions */}
                    <div>
                        <div className="text-[10px] uppercase text-zinc-500 mb-2">Conditions</div>
                        <div className="flex gap-2 flex-wrap">
                            {node.conditions.map((c, i) => (
                                <ConditionBadge key={i} condition={c} />
                            ))}
                        </div>
                    </div>

                    {/* Resources */}
                    <div>
                        <div className="text-[10px] uppercase text-zinc-500 mb-2">Resources (Allocatable / Capacity)</div>
                        <div className="grid grid-cols-3 gap-4">
                            <ResourceBar
                                used={cpuAlloc}
                                total={cpuCap}
                                label="CPU (cores)"
                                color="bg-blue-500"
                            />
                            <ResourceBar
                                used={memAlloc}
                                total={memCap}
                                label="Memory (Gi)"
                                color="bg-green-500"
                            />
                            <ResourceBar
                                used={podsAlloc}
                                total={podsCap}
                                label="Pods"
                                color="bg-purple-500"
                            />
                        </div>
                    </div>

                    {/* System Info */}
                    <div>
                        <div className="text-[10px] uppercase text-zinc-500 mb-2">System Info</div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                                <span className="text-zinc-500">OS Image:</span>
                                <span className="text-zinc-300 ml-1">{node.os_image || 'N/A'}</span>
                            </div>
                            <div>
                                <span className="text-zinc-500">Kernel:</span>
                                <span className="text-zinc-300 ml-1">{node.kernel_version || 'N/A'}</span>
                            </div>
                            <div>
                                <span className="text-zinc-500">Container Runtime:</span>
                                <span className="text-zinc-300 ml-1">{node.container_runtime || 'N/A'}</span>
                            </div>
                            <div>
                                <span className="text-zinc-500">Hostname:</span>
                                <span className="text-zinc-300 ml-1">{node.hostname || 'N/A'}</span>
                            </div>
                        </div>
                    </div>

                    {/* Labels */}
                    {Object.keys(node.labels).length > 0 && (
                        <div>
                            <div className="text-[10px] uppercase text-zinc-500 mb-2">Labels</div>
                            <div className="flex gap-1 flex-wrap max-h-24 overflow-auto">
                                {Object.entries(node.labels).slice(0, 20).map(([k, v]) => (
                                    <span
                                        key={k}
                                        className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-400"
                                        title={`${k}=${v}`}
                                    >
                                        {k.split('/').pop()}: {v.length > 20 ? v.slice(0, 20) + '...' : v}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export function NodesView() {
    const { nodes } = useBundleContext();
    const [search, setSearch] = useState('');
    const [showOnlyIssues, setShowOnlyIssues] = useState(false);

    const filteredNodes = useMemo(() => {
        return nodes.filter(node => {
            if (search) {
                const q = search.toLowerCase();
                if (!node.name.toLowerCase().includes(q) &&
                    !node.internal_ip?.toLowerCase().includes(q)) {
                    return false;
                }
            }
            if (showOnlyIssues) {
                const hasIssue = node.conditions.some(c =>
                    (c.condition_type !== 'Ready' && c.status === 'True') ||
                    (c.condition_type === 'Ready' && c.status !== 'True')
                );
                if (!hasIssue) return false;
            }
            return true;
        });
    }, [nodes, search, showOnlyIssues]);

    const stats = useMemo(() => {
        const ready = nodes.filter(n =>
            n.conditions.some(c => c.condition_type === 'Ready' && c.status === 'True')
        ).length;
        const issues = nodes.filter(n =>
            n.conditions.some(c =>
                (c.condition_type !== 'Ready' && c.status === 'True') ||
                (c.condition_type === 'Ready' && c.status !== 'True')
            )
        ).length;
        const totalCpu = nodes.reduce((acc, n) => acc + parseResourceValue(n.cpu_capacity), 0);
        const totalMem = nodes.reduce((acc, n) => acc + parseResourceValue(n.memory_capacity), 0);

        return { total: nodes.length, ready, issues, totalCpu, totalMem };
    }, [nodes]);

    return (
        <div className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-white">Nodes</h2>
                    <p className="text-xs text-zinc-500">
                        {stats.total} nodes • {stats.ready} ready • {stats.totalCpu} total CPU • {stats.totalMem.toFixed(0)} Gi total memory
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setShowOnlyIssues(!showOnlyIssues)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                            showOnlyIssues
                                ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                                : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600'
                        }`}
                    >
                        <AlertTriangle size={12} />
                        Issues Only ({stats.issues})
                    </button>
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search nodes..."
                            className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500 w-64"
                        />
                    </div>
                </div>
            </div>

            {/* Nodes List */}
            <div className="space-y-4">
                {filteredNodes.map(node => (
                    <NodeCard key={node.name} node={node} />
                ))}
            </div>

            {filteredNodes.length === 0 && (
                <div className="text-center py-12 text-zinc-500">
                    <Server size={32} className="mx-auto mb-2 opacity-50" />
                    No nodes match your filters
                </div>
            )}
        </div>
    );
}
