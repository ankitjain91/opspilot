import React, { useMemo } from 'react';
import { AlertCircle, Info, AlertTriangle } from 'lucide-react';
import type { BundleEvent } from './types';

interface BundleTimelineProps {
    events: BundleEvent[];
}

export function BundleTimeline({ events }: BundleTimelineProps) {
    // 1. Process events into a timeline format
    // Filter for warnings and errors only for the high-level timeline, or use all if few
    const processedEvents = useMemo(() => {
        // Parse dates and filter out invalid ones
        const validEvents = events
            .map(e => ({
                ...e,
                timestamp: e.last_timestamp ? new Date(e.last_timestamp).getTime() : 0
            }))
            .filter(e => e.timestamp > 0)
            .sort((a, b) => a.timestamp - b.timestamp);

        if (validEvents.length === 0) return [];

        const start = validEvents[0].timestamp;
        const end = validEvents[validEvents.length - 1].timestamp;
        const duration = end - start || 1000; // Avoid divide by zero

        // Group very close events to avoid clutter
        return validEvents.map(e => ({
            ...e,
            position: ((e.timestamp - start) / duration) * 100
        }));
    }, [events]);

    if (processedEvents.length === 0) {
        return (
            <div className="h-32 flex items-center justify-center text-zinc-500 text-sm border border-white/10 rounded-lg bg-zinc-900/50">
                No timeline data available
            </div>
        );
    }

    return (
        <div className="relative h-40 w-full bg-zinc-900/30 rounded-lg border border-white/10 p-4 flex flex-col justify-center">
            <h3 className="text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wide">Event Timeline</h3>

            <div className="relative w-full h-12 flex items-center">
                {/* Base Line */}
                <div className="absolute left-0 right-0 h-0.5 bg-zinc-700 rounded sticky top-1/2" />

                {/* Event Markers */}
                {processedEvents.map((event, i) => (
                    <div
                        key={i}
                        className="absolute top-1/2 transform -translate-y-1/2 -translate-x-1/2 group z-10"
                        style={{ left: `${event.position}%` }}
                    >
                        {/* Marker Dot */}
                        <div
                            className={`w-3 h-3 rounded-full border-2 cursor-pointer transition-transform hover:scale-150 ${event.event_type === 'Warning'
                                    ? 'bg-amber-500 border-amber-900'
                                    : 'bg-blue-500 border-blue-900'
                                }`}
                        />

                        {/* Hover Card */}
                        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 p-3 bg-zinc-900 border border-white/10 rounded-lg shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                            <div className="flex items-start gap-2">
                                {event.event_type === 'Warning'
                                    ? <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
                                    : <Info size={14} className="text-blue-500 mt-0.5 shrink-0" />
                                }
                                <div className="min-w-0">
                                    <p className="text-xs font-bold text-white truncate">{event.reason}</p>
                                    <p className="text-[10px] text-zinc-400 truncate">{event.involved_object_kind}/{event.involved_object_name}</p>
                                    <p className="text-[10px] text-zinc-500 mt-1 line-clamp-2">{event.message}</p>
                                    <p className="text-[10px] text-zinc-600 mt-1">
                                        {new Date(event.timestamp).toLocaleTimeString()}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Connecting Line for hover */}
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 w-0.5 h-2 bg-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                ))}
            </div>

            {/* Time Labels */}
            <div className="flex justify-between text-[10px] text-zinc-500 mt-2">
                <span>{new Date(processedEvents[0].timestamp).toLocaleString()}</span>
                <span>{new Date(processedEvents[processedEvents.length - 1].timestamp).toLocaleString()}</span>
            </div>
        </div>
    );
}
