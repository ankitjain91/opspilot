/**
 * EventsView - Kubernetes events with filtering and grouping
 */

import { useState, useMemo } from 'react';
import { AlertTriangle, Info, Search, Clock, Filter, ChevronDown } from 'lucide-react';
import { useBundleContext } from '../BundleContext';
import { BundleEvent } from '../types';

type EventFilter = 'all' | 'Warning' | 'Normal';
type GroupBy = 'none' | 'reason' | 'namespace' | 'object';

function EventCard({ event }: { event: BundleEvent }) {
    const [expanded, setExpanded] = useState(false);
    const isWarning = event.event_type === 'Warning';

    return (
        <div
            className={`rounded-lg border overflow-hidden ${
                isWarning
                    ? 'bg-yellow-500/5 border-yellow-500/20'
                    : 'bg-zinc-900/50 border-zinc-800'
            }`}
        >
            <div
                className="p-3 cursor-pointer hover:bg-zinc-800/30 transition-colors"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-start gap-3">
                    <div className={`w-6 h-6 rounded flex items-center justify-center mt-0.5 ${
                        isWarning ? 'bg-yellow-500/20' : 'bg-blue-500/20'
                    }`}>
                        {isWarning ? (
                            <AlertTriangle size={12} className="text-yellow-400" />
                        ) : (
                            <Info size={12} className="text-blue-400" />
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                                isWarning ? 'bg-yellow-500/20 text-yellow-400' : 'bg-blue-500/20 text-blue-400'
                            }`}>
                                {event.reason}
                            </span>
                            <span className="text-xs text-zinc-500">{event.namespace}</span>
                            {event.count > 1 && (
                                <span className="text-xs text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded">
                                    ×{event.count}
                                </span>
                            )}
                        </div>
                        <div className="text-sm text-zinc-300 mt-1 line-clamp-2">
                            {event.message}
                        </div>
                        <div className="text-[10px] text-zinc-600 mt-1 flex items-center gap-2">
                            <span>{event.involved_object_kind}/{event.involved_object_name}</span>
                            {event.last_timestamp && (
                                <>
                                    <span>•</span>
                                    <span className="flex items-center gap-1">
                                        <Clock size={10} />
                                        {new Date(event.last_timestamp).toLocaleString()}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                    <ChevronDown
                        size={14}
                        className={`text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                </div>
            </div>

            {expanded && (
                <div className="px-3 pb-3 pt-0 border-t border-zinc-800/50">
                    <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                        <div>
                            <span className="text-zinc-500">Object:</span>
                            <span className="text-zinc-300 ml-2">
                                {event.involved_object_kind}/{event.involved_object_name}
                            </span>
                        </div>
                        <div>
                            <span className="text-zinc-500">Namespace:</span>
                            <span className="text-zinc-300 ml-2">{event.namespace}</span>
                        </div>
                        <div>
                            <span className="text-zinc-500">First Seen:</span>
                            <span className="text-zinc-300 ml-2">
                                {event.first_timestamp ? new Date(event.first_timestamp).toLocaleString() : 'N/A'}
                            </span>
                        </div>
                        <div>
                            <span className="text-zinc-500">Last Seen:</span>
                            <span className="text-zinc-300 ml-2">
                                {event.last_timestamp ? new Date(event.last_timestamp).toLocaleString() : 'N/A'}
                            </span>
                        </div>
                        <div className="col-span-2">
                            <span className="text-zinc-500">Count:</span>
                            <span className="text-zinc-300 ml-2">{event.count}</span>
                        </div>
                    </div>
                    <div className="mt-2 p-2 bg-zinc-900 rounded text-xs text-zinc-300 font-mono">
                        {event.message}
                    </div>
                </div>
            )}
        </div>
    );
}

export function EventsView() {
    const { events, selectedNamespace } = useBundleContext();
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<EventFilter>('all');
    const [groupBy, setGroupBy] = useState<GroupBy>('none');

    const filteredEvents = useMemo(() => {
        let result = events;

        if (selectedNamespace) {
            result = result.filter(e => e.namespace === selectedNamespace);
        }

        if (filter !== 'all') {
            result = result.filter(e => e.event_type === filter);
        }

        if (search) {
            const q = search.toLowerCase();
            result = result.filter(e =>
                e.message.toLowerCase().includes(q) ||
                e.reason.toLowerCase().includes(q) ||
                e.involved_object_name.toLowerCase().includes(q)
            );
        }

        return result.sort((a, b) => {
            const aTime = a.last_timestamp ? new Date(a.last_timestamp).getTime() : 0;
            const bTime = b.last_timestamp ? new Date(b.last_timestamp).getTime() : 0;
            return bTime - aTime;
        });
    }, [events, selectedNamespace, filter, search]);

    const groupedEvents = useMemo(() => {
        if (groupBy === 'none') return null;

        const groups: Record<string, BundleEvent[]> = {};
        filteredEvents.forEach(e => {
            const key = groupBy === 'reason' ? e.reason
                : groupBy === 'namespace' ? e.namespace
                : `${e.involved_object_kind}/${e.involved_object_name}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(e);
        });

        return Object.entries(groups)
            .sort((a, b) => b[1].length - a[1].length);
    }, [filteredEvents, groupBy]);

    const stats = useMemo(() => ({
        total: filteredEvents.length,
        warnings: filteredEvents.filter(e => e.event_type === 'Warning').length,
        normal: filteredEvents.filter(e => e.event_type === 'Normal').length
    }), [filteredEvents]);

    return (
        <div className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-white">Events</h2>
                    <p className="text-xs text-zinc-500">
                        {stats.total} events • {stats.warnings} warnings • {stats.normal} normal
                    </p>
                </div>
                <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search events..."
                        className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500 w-64"
                    />
                </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-4">
                <div className="flex gap-1">
                    {(['all', 'Warning', 'Normal'] as EventFilter[]).map(f => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                filter === f
                                    ? f === 'Warning'
                                        ? 'bg-yellow-500/20 text-yellow-400'
                                        : f === 'Normal'
                                        ? 'bg-blue-500/20 text-blue-400'
                                        : 'bg-purple-600 text-white'
                                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                            }`}
                        >
                            {f === 'all' ? 'All' : f}
                            {f === 'Warning' && ` (${stats.warnings})`}
                            {f === 'Normal' && ` (${stats.normal})`}
                        </button>
                    ))}
                </div>

                <div className="h-4 w-px bg-zinc-700" />

                <div className="flex items-center gap-2">
                    <Filter size={12} className="text-zinc-500" />
                    <span className="text-xs text-zinc-500">Group by:</span>
                    <select
                        value={groupBy}
                        onChange={e => setGroupBy(e.target.value as GroupBy)}
                        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-500"
                    >
                        <option value="none">None</option>
                        <option value="reason">Reason</option>
                        <option value="namespace">Namespace</option>
                        <option value="object">Object</option>
                    </select>
                </div>
            </div>

            {/* Events List */}
            <div className="space-y-2 max-h-[calc(100vh-280px)] overflow-auto">
                {groupedEvents ? (
                    groupedEvents.map(([group, events]) => (
                        <div key={group} className="space-y-2">
                            <div className="sticky top-0 bg-zinc-950/90 backdrop-blur py-1 px-2 rounded flex items-center gap-2">
                                <span className="text-xs font-medium text-zinc-300">{group}</span>
                                <span className="text-[10px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded">
                                    {events.length}
                                </span>
                            </div>
                            {events.map((event, i) => (
                                <EventCard key={`${event.name}-${i}`} event={event} />
                            ))}
                        </div>
                    ))
                ) : (
                    filteredEvents.map((event, i) => (
                        <EventCard key={`${event.name}-${i}`} event={event} />
                    ))
                )}
            </div>

            {filteredEvents.length === 0 && (
                <div className="text-center py-12 text-zinc-500">
                    <Info size={32} className="mx-auto mb-2 opacity-50" />
                    No events match your filters
                </div>
            )}
        </div>
    );
}
