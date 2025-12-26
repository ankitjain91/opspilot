/**
 * CRDsView - Custom Resource Definitions viewer
 */

import { useState, useMemo } from 'react';
import { Puzzle, Search, ChevronDown, ChevronRight, ExternalLink, Tag } from 'lucide-react';
import { useBundleContext } from '../BundleContext';

interface CRDInfo {
    name: string;
    group: string;
    version: string;
    kind: string;
    scope: string;
    categories: string[];
    shortNames: string[];
    raw: any;
}

function CRDCard({ crd, onSelect }: { crd: CRDInfo; onSelect: () => void }) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 overflow-hidden hover:border-zinc-700 transition-colors">
            <div
                className="p-4 cursor-pointer"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                        <Puzzle size={20} className="text-indigo-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-white">{crd.kind}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                crd.scope === 'Namespaced'
                                    ? 'bg-blue-500/20 text-blue-400'
                                    : 'bg-purple-500/20 text-purple-400'
                            }`}>
                                {crd.scope}
                            </span>
                        </div>
                        <div className="text-xs text-zinc-500 mt-1 font-mono truncate">
                            {crd.group}/{crd.version}
                        </div>
                        {crd.shortNames.length > 0 && (
                            <div className="flex gap-1 mt-2 flex-wrap">
                                {crd.shortNames.map(sn => (
                                    <span
                                        key={sn}
                                        className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-400"
                                    >
                                        {sn}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                    <ChevronDown
                        size={16}
                        className={`text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                </div>
            </div>

            {expanded && (
                <div className="border-t border-zinc-800 p-4 bg-zinc-900/30 space-y-3">
                    <div>
                        <div className="text-[10px] uppercase text-zinc-500 mb-1">Full Name</div>
                        <div className="text-xs text-zinc-300 font-mono break-all">{crd.name}</div>
                    </div>

                    {crd.categories.length > 0 && (
                        <div>
                            <div className="text-[10px] uppercase text-zinc-500 mb-1">Categories</div>
                            <div className="flex gap-1 flex-wrap">
                                {crd.categories.map(cat => (
                                    <span
                                        key={cat}
                                        className="px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300"
                                    >
                                        {cat}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onSelect();
                        }}
                        className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors"
                    >
                        View Full Definition
                    </button>
                </div>
            )}
        </div>
    );
}

export function CRDsView() {
    const { crds, setSelectedResource } = useBundleContext();
    const [search, setSearch] = useState('');
    const [groupFilter, setGroupFilter] = useState<string>('all');

    const parsedCRDs = useMemo(() => {
        return crds.map((crd: any): CRDInfo => {
            const spec = crd.spec || {};
            const names = spec.names || {};
            const group = spec.group || '';
            const versions = spec.versions || [];
            const version = versions[0]?.name || spec.version || '';

            return {
                name: crd.metadata?.name || '',
                group,
                version,
                kind: names.kind || '',
                scope: spec.scope || 'Unknown',
                categories: names.categories || [],
                shortNames: names.shortNames || [],
                raw: crd
            };
        }).sort((a, b) => a.kind.localeCompare(b.kind));
    }, [crds]);

    const groups = useMemo(() => {
        const uniqueGroups = new Set(parsedCRDs.map(c => c.group));
        return ['all', ...Array.from(uniqueGroups).sort()];
    }, [parsedCRDs]);

    const filteredCRDs = useMemo(() => {
        return parsedCRDs.filter(crd => {
            if (groupFilter !== 'all' && crd.group !== groupFilter) return false;
            if (search) {
                const q = search.toLowerCase();
                return crd.name.toLowerCase().includes(q) ||
                       crd.kind.toLowerCase().includes(q) ||
                       crd.group.toLowerCase().includes(q) ||
                       crd.shortNames.some(sn => sn.toLowerCase().includes(q));
            }
            return true;
        });
    }, [parsedCRDs, search, groupFilter]);

    const stats = useMemo(() => {
        const byScope = {
            namespaced: parsedCRDs.filter(c => c.scope === 'Namespaced').length,
            cluster: parsedCRDs.filter(c => c.scope === 'Cluster').length
        };
        return { total: parsedCRDs.length, ...byScope };
    }, [parsedCRDs]);

    if (crds.length === 0) {
        return (
            <div className="p-6">
                <div className="text-center py-16 text-zinc-500">
                    <Puzzle size={48} className="mx-auto mb-4 opacity-30" />
                    <div className="text-lg font-medium text-zinc-400">No CRDs Found</div>
                    <div className="text-sm mt-1">No Custom Resource Definitions in this bundle</div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-white">Custom Resource Definitions</h2>
                    <p className="text-xs text-zinc-500">
                        {stats.total} CRDs • {stats.namespaced} namespaced • {stats.cluster} cluster-scoped
                    </p>
                </div>
                <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search CRDs..."
                        className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500 w-64"
                    />
                </div>
            </div>

            {/* Group Filter */}
            <div className="flex gap-2 flex-wrap">
                {groups.slice(0, 10).map(group => (
                    <button
                        key={group}
                        onClick={() => setGroupFilter(group)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            groupFilter === group
                                ? 'bg-indigo-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                        }`}
                    >
                        {group === 'all' ? 'All Groups' : group.split('.')[0]}
                    </button>
                ))}
                {groups.length > 10 && (
                    <select
                        value={groupFilter}
                        onChange={e => setGroupFilter(e.target.value)}
                        className="px-3 py-1.5 rounded-lg text-xs bg-zinc-800 text-zinc-400 border border-zinc-700 focus:outline-none"
                    >
                        {groups.map(g => (
                            <option key={g} value={g}>{g === 'all' ? 'All Groups' : g}</option>
                        ))}
                    </select>
                )}
            </div>

            {/* CRD Grid */}
            <div className="grid grid-cols-2 gap-4">
                {filteredCRDs.map(crd => (
                    <CRDCard
                        key={crd.name}
                        crd={crd}
                        onSelect={() => {
                            // Create a pseudo-resource for the detail panel
                            setSelectedResource({
                                api_version: `${crd.group}/${crd.version}`,
                                kind: 'CustomResourceDefinition',
                                name: crd.name,
                                namespace: null,
                                labels: {},
                                status_phase: null,
                                conditions: [],
                                file_path: crd.raw.file_path || ''
                            });
                        }}
                    />
                ))}
            </div>

            {filteredCRDs.length === 0 && (
                <div className="text-center py-12 text-zinc-500">
                    <Puzzle size={32} className="mx-auto mb-2 opacity-50" />
                    No CRDs match your filters
                </div>
            )}
        </div>
    );
}
