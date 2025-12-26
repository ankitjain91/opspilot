import React, { useState, useMemo } from 'react';
import {
    Search, Filter, Box, Layers, Server,
    ArrowRight, Activity, Database, Shield,
    FileText, Component, CheckCircle, AlertTriangle,
    XCircle, Clock
} from 'lucide-react';
import type { BundleResource } from './types';

interface BundleResourceExplorerProps {
    allResources: Map<string, BundleResource[]>;
    onResourceClick?: (resource: BundleResource) => void;
}

export function BundleResourceExplorer({ allResources, onResourceClick }: BundleResourceExplorerProps) {
    const [search, setSearch] = useState('');
    const [filterNamespace, setFilterNamespace] = useState<string>('ALL');
    const [filterKind, setFilterKind] = useState<string>('ALL');

    // Flatten resources
    const resourceList = useMemo(() => {
        const list: BundleResource[] = [];
        allResources.forEach((resources) => list.push(...resources));
        return list;
    }, [allResources]);

    // Unique Kinds and Namespaces for filters
    const namespaces = useMemo(() => Array.from(new Set(resourceList.map(r => r.namespace || 'Cluster'))).sort(), [resourceList]);
    const kinds = useMemo(() => Array.from(new Set(resourceList.map(r => r.kind))).sort(), [resourceList]);

    const filteredResources = useMemo(() => {
        return resourceList.filter(r => {
            if (filterNamespace !== 'ALL' && (r.namespace || 'Cluster') !== filterNamespace) return false;
            if (filterKind !== 'ALL' && r.kind !== filterKind) return false;
            if (search) {
                const q = search.toLowerCase();
                return r.name.toLowerCase().includes(q);
            }
            return true;
        });
    }, [resourceList, filterNamespace, filterKind, search]);

    return (
        <div className="h-full flex flex-col bg-zinc-900/30 rounded-xl overflow-hidden border border-white/5">
            {/* Toolbar */}
            <div className="p-4 border-b border-white/10 flex items-center gap-4 bg-white/5 backdrop-blur-sm">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-2.5 text-zinc-500" size={14} />
                    <input
                        type="text"
                        placeholder="Search resources..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-zinc-950 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                    />
                </div>

                <div className="flex items-center gap-2">
                    <Filter size={14} className="text-zinc-500" />
                    <select
                        className="bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none"
                        value={filterNamespace}
                        onChange={(e) => setFilterNamespace(e.target.value)}
                    >
                        <option value="ALL">All Namespaces</option>
                        {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                    </select>

                    <select
                        className="bg-zinc-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none"
                        value={filterKind}
                        onChange={(e) => setFilterKind(e.target.value)}
                    >
                        <option value="ALL">All Kinds</option>
                        {kinds.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                </div>

                <div className="flex-1 text-right text-xs text-zinc-500">
                    Showing {filteredResources.length} of {resourceList.length} resources
                </div>
            </div>

            {/* Table Header */}
            <div className="grid grid-cols-12 gap-4 px-6 py-3 bg-white/5 text-xs font-medium text-zinc-400 border-b border-white/5">
                <div className="col-span-1">Kind</div>
                <div className="col-span-4">Name</div>
                <div className="col-span-3">Namespace</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2">Age</div>
            </div>

            {/* Table Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {filteredResources.map((r, i) => (
                    <div
                        key={`${r.kind}-${r.namespace}-${r.name}-${i}`}
                        onClick={() => onResourceClick?.(r)}
                        className="grid grid-cols-12 gap-4 px-6 py-3 border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer group text-sm"
                    >
                        <div className="col-span-1 flex items-center">
                            <KindIcon kind={r.kind} />
                        </div>
                        <div className="col-span-4 font-mono text-zinc-300 truncate group-hover:text-purple-300 transition-colors" title={r.name}>
                            {r.name}
                        </div>
                        <div className="col-span-3 text-zinc-400 truncate">
                            {r.namespace || '-'}
                        </div>
                        <div className="col-span-2">
                            <StatusBadge status={r.status_phase || r.conditions?.[0]?.status || 'Unknown'} />
                        </div>
                        <div className="col-span-2 text-zinc-500 text-xs flex items-center gap-1">
                            {/* Placeholder age since we might not have creationTimestamp parsed in simple struct */}
                            <Clock size={12} /> -
                        </div>
                    </div>
                ))}

                {filteredResources.length === 0 && (
                    <div className="p-12 text-center text-zinc-500">
                        No resources found matching your filters.
                    </div>
                )}
            </div>
        </div>
    );
}

// Helpers

function KindIcon({ kind }: { kind: string }) {
    let Icon = Box;
    let color = 'text-zinc-500';

    switch (kind) {
        case 'Deployment': Icon = Layers; color = 'text-blue-400'; break;
        case 'Pod': Icon = Box; color = 'text-purple-400'; break;
        case 'Service': Icon = Server; color = 'text-amber-400'; break;
        case 'Ingress': Icon = ArrowRight; color = 'text-pink-400'; break;
        case 'ConfigMap': Icon = FileText; color = 'text-orange-400'; break;
        case 'Secret': Icon = Shield; color = 'text-red-400'; break;
        case 'StatefulSet': Icon = Database; color = 'text-cyan-400'; break;
        case 'DaemonSet': Icon = Component; color = 'text-teal-400'; break;
    }

    return (
        <div className="flex items-center gap-2" title={kind}>
            <Icon size={16} className={color} />
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const s = status.toLowerCase();
    let color = 'bg-zinc-800 text-zinc-400 border-zinc-700';
    let Icon = Activity;

    if (s === 'running' || s === 'completed' || s === 'ready' || s === 'true') {
        color = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
        Icon = CheckCircle;
    } else if (s.includes('fail') || s.includes('error') || s.includes('crash') || s.includes('backoff')) {
        color = 'bg-red-500/10 text-red-400 border-red-500/20';
        Icon = XCircle;
    } else if (s === 'pending' || s === 'containercreating') {
        color = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
        Icon = AlertTriangle;
    }

    return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs border ${color}`}>
            <Icon size={10} />
            <span className="capitalize">{status}</span>
        </span>
    );
}
