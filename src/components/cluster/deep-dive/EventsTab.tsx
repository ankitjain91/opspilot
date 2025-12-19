import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { K8sObject } from '../../../types/k8s';
import { AlertCircle, CheckCircle2, Clock, RefreshCw, Loader2, Calendar, X, Hash, Info, Activity, Layers } from 'lucide-react';
import { formatAge } from '../../../utils/time';

interface EventsTabProps {
    resource: K8sObject;
}

export function EventsTab({ resource }: EventsTabProps) {
    const [selectedEvent, setSelectedEvent] = useState<any | null>(null);

    const { data: events, isLoading, isRefetching, refetch } = useQuery({
        queryKey: ["events", resource.namespace, resource.name],
        queryFn: async () => invoke<any[]>("list_events", {
            namespace: resource.namespace,
            name: resource.name,
            uid: resource.id
        }),
        refetchInterval: 5000
    });

    if (isLoading) return <LoadingState />;

    if (!events || events.length === 0) return <EmptyState refetch={refetch} />;

    const sortedEvents = [...events].sort((a, b) =>
        new Date(b.lastTimestamp || b.eventTime || 0).getTime() -
        new Date(a.lastTimestamp || a.eventTime || 0).getTime()
    );

    return (
        <div className="h-full bg-[#0f0f12] flex flex-col relative overflow-hidden">
            {/* Toolbar */}
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-white/5 bg-black/20">
                <span className="text-xs font-medium text-zinc-400">{events.length} Events</span>
                <button
                    onClick={() => refetch()}
                    disabled={isRefetching}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded transition-colors disabled:opacity-50"
                >
                    <RefreshCw size={12} className={isRefetching ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {/* Table Header */}
            <div className="grid grid-cols-[40px_140px_1fr_120px_60px_100px] gap-4 px-4 py-2 border-b border-white/5 bg-black/20 text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                <div className="flex justify-center">Type</div>
                <div>Reason</div>
                <div>Message</div>
                <div>Source</div>
                <div>Count</div>
                <div className="text-right">Age</div>
            </div>

            {/* Table Body */}
            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                {sortedEvents.map((e: any, i: number) => {
                    const isWarning = e.type === 'Warning';
                    const timestamp = e.lastTimestamp || e.eventTime;

                    return (
                        <div
                            key={i}
                            onClick={() => setSelectedEvent(e)}
                            className={`grid grid-cols-[40px_140px_1fr_120px_60px_100px] gap-4 px-4 py-3 border-b border-white/5 items-center text-xs hover:bg-white/5 cursor-pointer transition-colors ${selectedEvent === e ? 'bg-white/5' : ''}`}
                        >
                            <div className="flex justify-center">
                                {isWarning ?
                                    <AlertCircle size={14} className="text-red-400" /> :
                                    <CheckCircle2 size={14} className="text-emerald-400/50" />
                                }
                            </div>
                            <div className={`font-medium ${isWarning ? 'text-red-300' : 'text-zinc-300'}`}>
                                {e.reason}
                            </div>
                            <div className="text-zinc-400 truncate" title={e.message}>
                                {e.message}
                            </div>
                            <div className="text-zinc-500 truncate" title={e.source?.component}>
                                {e.source?.component || '-'}
                            </div>
                            <div className="text-zinc-500 font-mono">
                                {e.count > 1 ? `×${e.count}` : '-'}
                            </div>
                            <div className="text-right text-zinc-500 text-[11px] font-mono">
                                {timestamp ? formatAge(timestamp) : '-'}
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Details Drawer */}
            {selectedEvent && (
                <>
                    {/* Backdrop */}
                    <div
                        className="absolute inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity"
                        onClick={() => setSelectedEvent(null)}
                    />

                    {/* Drawer */}
                    <div className="absolute inset-y-0 right-0 w-[500px] bg-[#1a1a1e] border-l border-white/10 shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-200">
                        {/* Drawer Header */}
                        <div className="p-4 border-b border-white/10 flex items-center justify-between bg-[#1f1f23]">
                            <div className="flex items-center gap-3">
                                {selectedEvent.type === 'Warning' ?
                                    <div className="p-2 rounded-lg bg-red-500/10 text-red-400"><AlertCircle size={18} /></div> :
                                    <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400"><CheckCircle2 size={18} /></div>
                                }
                                <div>
                                    <h3 className="font-bold text-zinc-100">{selectedEvent.reason}</h3>
                                    <p className="text-xs text-zinc-400 font-mono">{selectedEvent.metadata?.name}</p>
                                </div>
                            </div>
                            <button onClick={() => setSelectedEvent(null)} className="p-2 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-white transition-colors">
                                <X size={18} />
                            </button>
                        </div>

                        {/* Drawer Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">

                            {/* Message */}
                            <div className="bg-black/20 rounded-xl p-4 border border-white/5">
                                <h4 className="text-xs font-bold text-zinc-500 uppercase mb-2 flex items-center gap-2">
                                    <Info size={12} /> Message
                                </h4>
                                <p className="text-sm text-zinc-300 leading-relaxed font-mono whitespace-pre-wrap">
                                    {selectedEvent.message}
                                </p>
                            </div>

                            {/* Metadata Grid */}
                            <div className="grid grid-cols-2 gap-4">
                                <InfoItem icon={<Activity />} label="Type" value={selectedEvent.type} />
                                <InfoItem icon={<Hash />} label="Count" value={selectedEvent.count} />
                                <InfoItem icon={<Clock />} label="First Seen" value={selectedEvent.firstTimestamp ? formatAge(selectedEvent.firstTimestamp) : '-'} />
                                <InfoItem icon={<Clock />} label="Last Seen" value={selectedEvent.lastTimestamp ? formatAge(selectedEvent.lastTimestamp) : '-'} />
                                <InfoItem icon={<Layers />} label="Component" value={selectedEvent.source?.component} />
                                <InfoItem icon={<Layers />} label="Host" value={selectedEvent.source?.host} />
                            </div>

                            {/* Raw Object */}
                            <div className="space-y-2">
                                <h4 className="text-xs font-bold text-zinc-500 uppercase">Raw Event</h4>
                                <pre className="p-4 rounded-xl bg-black/40 border border-white/5 text-[10px] text-zinc-400 font-mono overflow-auto custom-scrollbar">
                                    {JSON.stringify(selectedEvent, null, 2)}
                                </pre>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

// Helpers
function InfoItem({ icon, label, value }: { icon: any, label: string, value: any }) {
    if (!value) return null;
    return (
        <div className="bg-white/5 rounded-lg p-3 border border-white/5">
            <div className="flex items-center gap-2 text-zinc-500 text-[10px] font-bold uppercase mb-1">
                {React.cloneElement(icon, { size: 10 })}
                {label}
            </div>
            <div className="text-xs text-zinc-300 font-medium truncate" title={String(value)}>
                {value}
            </div>
        </div>
    )
}

function LoadingState() {
    return (
        <div className="h-full flex items-center justify-center bg-[#0f0f12]">
            <div className="flex flex-col items-center gap-3 text-zinc-500">
                <Loader2 size={24} className="animate-spin text-cyan-500" />
                <span className="text-xs">Loading events...</span>
            </div>
        </div>
    );
}

function EmptyState({ refetch }: { refetch: () => void }) {
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
