import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { K8sObject } from '../../../types/k8s';

interface EventsTabProps {
    resource: K8sObject;
}

export function EventsTab({ resource }: EventsTabProps) {
    const { data: events, isLoading } = useQuery({
        queryKey: ["events", resource.namespace, resource.name],
        queryFn: async () => invoke<any[]>("list_events", {
            namespace: resource.namespace,
            fieldSelector: `involvedObject.name=${resource.name},involvedObject.kind=${resource.kind}`
        }),
        refetchInterval: 5000
    });

    if (isLoading) return <div className="p-4 text-xs text-zinc-500 animate-pulse">Loading events...</div>;
    if (!events || events.length === 0) return <div className="p-4 text-xs text-zinc-600 italic">No events found.</div>;

    return (
        <div className="h-full bg-[#0f0f12] overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-zinc-800">
            <div className="space-y-2">
                {events.sort((a, b) => new Date(b.lastTimestamp || b.eventTime).getTime() - new Date(a.lastTimestamp || a.eventTime).getTime()).map((e: any, i: number) => {
                    const isWarning = e.type === 'Warning';
                    return (
                        <div key={i} className={`p-3 rounded-lg border text-xs ${isWarning ? 'bg-red-500/5 border-red-500/20' : 'bg-zinc-800/20 border-white/5'}`}>
                            <div className="flex items-center justify-between mb-1">
                                <span className={`font-semibold ${isWarning ? 'text-red-400' : 'text-zinc-300'}`}>{e.reason}</span>
                                <span className="text-[10px] text-zinc-500">{e.lastTimestamp ? new Date(e.lastTimestamp).toLocaleTimeString() : ''}</span>
                            </div>
                            <div className="text-zinc-400 leading-relaxed font-mono text-[11px] mb-2">{e.message}</div>
                            <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                                <span className="px-1.5 py-0.5 rounded bg-black/20 border border-white/5">{e.source?.component}</span>
                                {e.count > 1 && <span className="px-1.5 py-0.5 rounded bg-black/20 border border-white/5">x{e.count}</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
