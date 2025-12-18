import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { K8sObject } from '../../../types/k8s';
import { AlertCircle, CheckCircle2, Clock, RefreshCw, Loader2, Calendar } from 'lucide-react';
import { formatAge } from '../../../utils/time';

interface EventsTabProps {
    resource: K8sObject;
}

export function EventsTab({ resource }: EventsTabProps) {
    const { data: events, isLoading, isRefetching, refetch } = useQuery({
        queryKey: ["events", resource.namespace, resource.name],
        queryFn: async () => invoke<any[]>("list_events", {
            namespace: resource.namespace,
            name: resource.name,
            uid: resource.id
        }),
        refetchInterval: 5000
    });

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center bg-[#0f0f12]">
                <div className="flex flex-col items-center gap-3 text-zinc-500">
                    <Loader2 size={24} className="animate-spin text-cyan-500" />
                    <span className="text-xs">Loading events...</span>
                </div>
            </div>
        );
    }

    if (!events || events.length === 0) {
        return (
            <div className="h-full flex items-center justify-center bg-[#0f0f12]">
                <div className="flex flex-col items-center gap-3 text-zinc-600">
                    <Calendar size={32} className="opacity-30" />
                    <span className="text-sm">No events found for this resource</span>
                    <button
                        onClick={() => refetch()}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors text-zinc-400 hover:text-zinc-200"
                    >
                        <RefreshCw size={12} />
                        Refresh
                    </button>
                </div>
            </div>
        );
    }

    const sortedEvents = [...events].sort((a, b) =>
        new Date(b.lastTimestamp || b.eventTime || 0).getTime() -
        new Date(a.lastTimestamp || a.eventTime || 0).getTime()
    );

    const warningCount = events.filter(e => e.type === 'Warning').length;
    const normalCount = events.filter(e => e.type !== 'Warning').length;

    return (
        <div className="h-full bg-[#0f0f12] flex flex-col">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/5 bg-black/20">
                <div className="flex items-center gap-4">
                    <h3 className="text-sm font-semibold text-zinc-300">Events</h3>
                    <div className="flex items-center gap-3 text-xs">
                        {warningCount > 0 && (
                            <span className="flex items-center gap-1.5 text-red-400">
                                <AlertCircle size={12} />
                                {warningCount} Warning{warningCount !== 1 ? 's' : ''}
                            </span>
                        )}
                        {normalCount > 0 && (
                            <span className="flex items-center gap-1.5 text-zinc-500">
                                <CheckCircle2 size={12} />
                                {normalCount} Normal
                            </span>
                        )}
                    </div>
                </div>
                <button
                    onClick={() => refetch()}
                    disabled={isRefetching}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded transition-colors disabled:opacity-50"
                >
                    <RefreshCw size={12} className={isRefetching ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {/* Events List */}
            <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-zinc-800">
                <div className="space-y-3">
                    {sortedEvents.map((e: any, i: number) => {
                        const isWarning = e.type === 'Warning';
                        const timestamp = e.lastTimestamp || e.eventTime;

                        return (
                            <div
                                key={i}
                                className={`p-4 rounded-xl border transition-colors hover:border-opacity-50 ${
                                    isWarning
                                        ? 'bg-gradient-to-r from-red-500/10 to-transparent border-red-500/20 hover:border-red-500/40'
                                        : 'bg-gradient-to-r from-zinc-800/30 to-transparent border-white/5 hover:border-white/10'
                                }`}
                            >
                                <div className="flex items-start justify-between gap-4 mb-2">
                                    <div className="flex items-center gap-2">
                                        {isWarning ? (
                                            <AlertCircle size={16} className="text-red-400 shrink-0" />
                                        ) : (
                                            <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                                        )}
                                        <span className={`font-semibold text-sm ${isWarning ? 'text-red-300' : 'text-zinc-200'}`}>
                                            {e.reason}
                                        </span>
                                        {e.count > 1 && (
                                            <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-black/30 text-zinc-400 border border-white/10">
                                                ×{e.count}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 shrink-0">
                                        <Clock size={10} />
                                        {timestamp ? formatAge(timestamp) : 'Unknown'}
                                    </div>
                                </div>

                                <div className="text-zinc-400 text-xs leading-relaxed font-mono pl-6 mb-3 whitespace-pre-wrap break-words">
                                    {e.message}
                                </div>

                                <div className="flex items-center gap-2 pl-6 text-[10px]">
                                    {e.source?.component && (
                                        <span className="px-2 py-0.5 rounded-full bg-black/30 border border-white/5 text-zinc-500">
                                            {e.source.component}
                                        </span>
                                    )}
                                    {e.source?.host && (
                                        <span className="px-2 py-0.5 rounded-full bg-black/30 border border-white/5 text-zinc-600">
                                            {e.source.host}
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
