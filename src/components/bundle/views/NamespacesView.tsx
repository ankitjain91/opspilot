/**
 * NamespacesView - Detailed namespace breakdown
 */

import { useState, useMemo } from 'react';
import { Layers, Box, Server, Database, Settings, ChevronRight, Search } from 'lucide-react';
import { useBundleContext } from '../BundleContext';

export function NamespacesView() {
    const { namespaces, setSelectedNamespace, setActiveView } = useBundleContext();
    const [search, setSearch] = useState('');
    const [expandedNs, setExpandedNs] = useState<string | null>(null);

    const filteredNamespaces = useMemo(() => {
        if (!search) return namespaces;
        const q = search.toLowerCase();
        return namespaces.filter(ns => ns.name.toLowerCase().includes(q));
    }, [namespaces, search]);

    const getResourceIcon = (type: string) => {
        switch (type.toLowerCase()) {
            case 'pods': return Box;
            case 'deployments': return Server;
            case 'services': return Settings;
            case 'statefulsets': return Database;
            default: return Layers;
        }
    };

    const handleNamespaceClick = (nsName: string) => {
        setSelectedNamespace(nsName);
        setActiveView('workloads');
    };

    return (
        <div className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-white">Namespaces</h2>
                    <p className="text-xs text-zinc-500">{namespaces.length} namespaces found</p>
                </div>
                <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Filter namespaces..."
                        className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500 w-64"
                    />
                </div>
            </div>

            {/* Namespace Cards */}
            <div className="grid grid-cols-2 gap-4">
                {filteredNamespaces.map(ns => {
                    const isExpanded = expandedNs === ns.name;
                    const resourceTypes = Object.entries(ns.resourceCounts || {})
                        .sort((a, b) => b[1] - a[1]);

                    return (
                        <div
                            key={ns.name}
                            className="bg-zinc-900/50 rounded-xl border border-zinc-800 overflow-hidden hover:border-zinc-700 transition-colors"
                        >
                            {/* Header */}
                            <div
                                className="p-4 flex items-center gap-3 cursor-pointer"
                                onClick={() => setExpandedNs(isExpanded ? null : ns.name)}
                            >
                                <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                                    <Layers size={20} className="text-purple-400" />
                                </div>
                                <div className="flex-1">
                                    <div className="text-sm font-medium text-white">{ns.name}</div>
                                    <div className="text-xs text-zinc-500">
                                        {ns.totalResources} resources
                                    </div>
                                </div>
                                <ChevronRight
                                    size={16}
                                    className={`text-zinc-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                                />
                            </div>

                            {/* Quick Stats */}
                            <div className="px-4 pb-4 flex gap-2 flex-wrap">
                                {resourceTypes.slice(0, 4).map(([type, count]) => {
                                    const Icon = getResourceIcon(type);
                                    return (
                                        <div key={type} className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 text-xs">
                                            <Icon size={12} className="text-zinc-400" />
                                            <span className="text-zinc-300">{count}</span>
                                            <span className="text-zinc-500">{type}</span>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Expanded Details */}
                            {isExpanded && (
                                <div className="border-t border-zinc-800 p-4 bg-zinc-900/30">
                                    <div className="text-xs font-medium text-zinc-400 mb-2">All Resource Types</div>
                                    <div className="grid grid-cols-3 gap-2">
                                        {resourceTypes.map(([type, count]) => (
                                            <div key={type} className="flex items-center justify-between p-2 rounded bg-zinc-800/50">
                                                <span className="text-xs text-zinc-300 capitalize">{type}</span>
                                                <span className="text-xs font-medium text-white">{count}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <button
                                        onClick={() => handleNamespaceClick(ns.name)}
                                        className="mt-3 w-full py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium transition-colors"
                                    >
                                        View Workloads
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {filteredNamespaces.length === 0 && (
                <div className="text-center py-12 text-zinc-500">
                    No namespaces match your search
                </div>
            )}
        </div>
    );
}
