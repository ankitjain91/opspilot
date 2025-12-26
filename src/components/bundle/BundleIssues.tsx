import React, { useState, useMemo } from 'react';
import {
    AlertCircle, AlertTriangle, Search, Filter,
    ChevronRight, X, CheckCircle, Info,
    ArrowRight, Terminal, Activity, FileText,
    Shield, Clock, Tag
} from 'lucide-react';
import { DetectedIssue, BundleEvent, BundleResource } from './types';

interface BundleIssuesProps {
    issues: DetectedIssue[];
    allResources: Map<string, BundleResource[]>;
    events: BundleEvent[];
}

export function BundleIssues({ issues, allResources, events }: BundleIssuesProps) {
    const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
    const [filterSeverity, setFilterSeverity] = useState<('critical' | 'warning' | 'info')[]>(['critical', 'warning']);
    const [search, setSearch] = useState('');
    const [filterNamespace, setFilterNamespace] = useState<string>('ALL');

    // Derived Filters
    const namespaces = useMemo(() => {
        const set = new Set<string>();
        issues.forEach(i => set.add(i.namespace));
        return Array.from(set).sort();
    }, [issues]);

    const filteredIssues = useMemo(() => {
        return issues.filter(issue => {
            if (!filterSeverity.includes(issue.severity)) return false;
            if (filterNamespace !== 'ALL' && issue.namespace !== filterNamespace) return false;
            if (search) {
                const q = search.toLowerCase();
                return (
                    issue.title.toLowerCase().includes(q) ||
                    issue.description.toLowerCase().includes(q) ||
                    issue.affectedResource.toLowerCase().includes(q)
                );
            }
            return true;
        });
    }, [issues, filterSeverity, filterNamespace, search]);

    const activeIssue = useMemo(() =>
        issues.find(i => i.id === selectedIssueId) || filteredIssues[0] || null
        , [selectedIssueId, filteredIssues, issues]);

    // Update selected issue if current selection disappears from filter
    React.useEffect(() => {
        if (activeIssue && !filteredIssues.find(i => i.id === activeIssue.id)) {
            setSelectedIssueId(filteredIssues[0]?.id || null);
        } else if (!selectedIssueId && filteredIssues.length > 0) {
            setSelectedIssueId(filteredIssues[0].id);
        }
    }, [filteredIssues, activeIssue, selectedIssueId]);

    if (issues.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500">
                <CheckCircle size={48} className="text-emerald-500 mb-4" />
                <h3 className="text-xl font-medium text-white">No Issues Detected</h3>
                <p>Your cluster appears to be healthy.</p>
            </div>
        );
    }

    return (
        <div className="flex h-full bg-zinc-950/50 backdrop-blur-sm border border-white/10 rounded-xl overflow-hidden shadow-2xl">

            {/* LEFT PANEL: Issue List */}
            <div className="w-[400px] flex flex-col border-r border-white/10 bg-zinc-900/50">
                {/* Search & Filter Header */}
                <div className="p-4 border-b border-white/10 space-y-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-2.5 text-zinc-500" size={14} />
                        <input
                            type="text"
                            placeholder="Search issues..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full bg-zinc-950 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50 transition-colors"
                        />
                    </div>

                    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                        <FilterButton
                            label="Critical"
                            active={filterSeverity.includes('critical')}
                            onClick={() => toggleFilter('critical', filterSeverity, setFilterSeverity)}
                            count={issues.filter(i => i.severity === 'critical').length}
                            activeColor="bg-red-500/20 text-red-400 border-red-500/30"
                        />
                        <FilterButton
                            label="Warning"
                            active={filterSeverity.includes('warning')}
                            onClick={() => toggleFilter('warning', filterSeverity, setFilterSeverity)}
                            count={issues.filter(i => i.severity === 'warning').length}
                            activeColor="bg-amber-500/20 text-amber-400 border-amber-500/30"
                        />
                        <select
                            className="bg-zinc-950 border border-white/10 rounded-md px-2 py-1 text-xs text-zinc-400 focus:outline-none"
                            value={filterNamespace}
                            onChange={(e) => setFilterNamespace(e.target.value)}
                        >
                            <option value="ALL">All NS</option>
                            {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
                        </select>
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {filteredIssues.map((issue) => (
                        <div
                            key={issue.id}
                            onClick={() => setSelectedIssueId(issue.id)}
                            className={`p-4 border-b border-white/5 cursor-pointer transition-all hover:bg-white/5 ${activeIssue?.id === issue.id ? 'bg-white/10 border-l-2 border-l-purple-500' : 'border-l-2 border-l-transparent'
                                }`}
                        >
                            <div className="flex items-start gap-3">
                                {issue.severity === 'critical' ? (
                                    <AlertCircle className="shrink-0 text-red-500 mt-0.5" size={16} />
                                ) : (
                                    <AlertTriangle className="shrink-0 text-amber-500 mt-0.5" size={16} />
                                )}
                                <div className="min-w-0 flex-1">
                                    <h4 className={`text-sm font-medium truncate ${activeIssue?.id === issue.id ? 'text-white' : 'text-zinc-300'
                                        }`}>
                                        {issue.title}
                                    </h4>
                                    <p className="text-xs text-zinc-500 mt-1 line-clamp-2">
                                        {issue.description}
                                    </p>
                                    <div className="flex items-center gap-2 mt-2">
                                        <Badge text={issue.namespace} />
                                        <Badge text={issue.resourceKind} />
                                    </div>
                                </div>
                                <span className="text-[10px] text-zinc-600 whitespace-nowrap">
                                    {/* Issue Age Placeholder */}
                                    Just now
                                </span>
                            </div>
                        </div>
                    ))}
                    {filteredIssues.length === 0 && (
                        <div className="p-8 text-center text-zinc-500 text-sm">
                            No issues match your filters.
                        </div>
                    )}
                </div>
            </div>

            {/* RIGHT PANEL: Details */}
            <div className="flex-1 flex flex-col bg-zinc-950/30 min-w-0">
                {activeIssue ? (
                    <>
                        {/* Header */}
                        <div className="p-6 border-b border-white/10 bg-zinc-900/50 backdrop-blur sticky top-0 z-10">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <div className="flex items-center gap-3 mb-2">
                                        <SeverityBadge severity={activeIssue.severity} />
                                        <span className="text-xs font-mono text-zinc-500">{activeIssue.id}</span>
                                    </div>
                                    <h2 className="text-xl font-bold text-white leading-tight">
                                        {activeIssue.title}
                                    </h2>
                                </div>
                                {/* Actions */}
                                <div className="flex gap-2">
                                    <button className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-zinc-300 text-xs font-medium rounded-lg border border-white/10 transition-colors">
                                        Share
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-8">

                            {/* Section: Description */}
                            <section>
                                <h3 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
                                    <Info size={16} /> What Happened
                                </h3>
                                <div className="bg-zinc-900/50 border border-white/5 rounded-lg p-4 text-zinc-300 text-sm leading-relaxed">
                                    {activeIssue.description}
                                    <div className="mt-4 flex gap-4 text-xs">
                                        <div className="flex flex-col">
                                            <span className="text-zinc-500">Namespace</span>
                                            <span className="font-mono text-white">{activeIssue.namespace}</span>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-zinc-500">Resource</span>
                                            <span className="font-mono text-white">{activeIssue.affectedResource}</span>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-zinc-500">Kind</span>
                                            <span className="font-mono text-white">{activeIssue.resourceKind}</span>
                                        </div>
                                    </div>
                                </div>
                            </section>

                            {/* Section: Root Cause */}
                            {activeIssue.rootCause && (
                                <section>
                                    <h3 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
                                        <Search size={16} /> Possible Root Cause
                                    </h3>
                                    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 font-mono text-xs text-red-200 overflow-x-auto">
                                        {activeIssue.rootCause}
                                    </div>
                                </section>
                            )}

                            {/* Section: Suggestions */}
                            {activeIssue.suggestions.length > 0 && (
                                <section>
                                    <h3 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
                                        <Shield size={16} /> Remediation Suggestions
                                    </h3>
                                    <ul className="space-y-2">
                                        {activeIssue.suggestions.map((suggestion, idx) => (
                                            <li key={idx} className="flex items-start gap-3 bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-3 text-sm text-emerald-100/80">
                                                <CheckCircle className="shrink-0 text-emerald-500 mt-0.5" size={16} />
                                                <span>{suggestion}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}

                            {/* Section: Related Events */}
                            {activeIssue.relatedEvents.length > 0 && (
                                <section>
                                    <h3 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
                                        <Activity size={16} /> Related Events
                                    </h3>
                                    <div className="border border-white/5 rounded-lg overflow-hidden">
                                        <table className="w-full text-left text-xs">
                                            <thead className="bg-white/5 text-zinc-400 font-medium">
                                                <tr>
                                                    <th className="p-3">Type</th>
                                                    <th className="p-3">Reason</th>
                                                    <th className="p-3">Message</th>
                                                    <th className="p-3 text-right">Count</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-white/5">
                                                {activeIssue.relatedEvents.map((evt, i) => (
                                                    <tr key={i} className="hover:bg-white/5">
                                                        <td className="p-3">
                                                            <span className={evt.event_type === 'Warning' ? 'text-amber-400' : 'text-zinc-300'}>
                                                                {evt.event_type}
                                                            </span>
                                                        </td>
                                                        <td className="p-3 font-mono text-zinc-300">{evt.reason}</td>
                                                        <td className="p-3 text-zinc-400 max-w-xs truncate" title={evt.message}>{evt.message}</td>
                                                        <td className="p-3 text-right font-mono text-zinc-500">{evt.count}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </section>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-zinc-500">
                        <FileText size={48} className="mb-4 opacity-50" />
                        <p>Select an issue to view details</p>
                    </div>
                )}
            </div>
        </div>
    );
}

// Helpers

function FilterButton({ label, active, onClick, count, activeColor }: any) {
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${active
                    ? activeColor
                    : 'bg-zinc-900 border-white/10 text-zinc-500 hover:text-zinc-300'
                }`}
        >
            {label}
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${active ? 'bg-black/20' : 'bg-white/10'}`}>
                {count}
            </span>
        </button>
    );
}

function Badge({ text }: { text: string }) {
    return (
        <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/5 text-[10px] text-zinc-400 font-mono">
            {text}
        </span>
    );
}

function SeverityBadge({ severity }: { severity: string }) {
    if (severity === 'critical') {
        return (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold bg-red-500/10 text-red-500 border border-red-500/20 uppercase tracking-wider">
                <AlertCircle size={12} /> Critical
            </span>
        );
    }
    return (
        <span className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20 uppercase tracking-wider">
            <AlertTriangle size={12} /> Warning
        </span>
    );
}

function toggleFilter(val: any, current: any[], set: any) {
    if (current.includes(val)) {
        if (current.length > 1) set(current.filter(x => x !== val)); // Prevent unselecting all
    } else {
        set([...current, val]);
    }
}
