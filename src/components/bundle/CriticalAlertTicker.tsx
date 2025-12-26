import React, { useEffect, useState } from 'react';
import { AlertCircle, ChevronRight, AlertTriangle } from 'lucide-react';
import type { BundleAlert } from './types';

interface CriticalAlertTickerProps {
    alerts: BundleAlert[];
    onAlertClick?: (alert: BundleAlert) => void;
}

export function CriticalAlertTicker({ alerts, onAlertClick }: CriticalAlertTickerProps) {
    const [currentIndex, setCurrentIndex] = useState(0);
    const criticalAlerts = alerts.filter(a => a.severity === 'critical');

    useEffect(() => {
        if (criticalAlerts.length <= 1) return;

        const interval = setInterval(() => {
            setCurrentIndex((prev) => (prev + 1) % criticalAlerts.length);
        }, 5000); // Rotate every 5 seconds

        return () => clearInterval(interval);
    }, [criticalAlerts.length]);

    if (criticalAlerts.length === 0) return null;

    const currentAlert = criticalAlerts[currentIndex];

    return (
        <div className="w-full bg-red-500/10 border-y border-red-500/20 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-xs font-bold uppercase tracking-wide shrink-0 animate-pulse">
                        <AlertTriangle size={12} />
                        <span>Critical Issues ({criticalAlerts.length})</span>
                    </div>

                    <div className="flex-1 truncate relative h-6">
                        <div
                            key={currentIndex}
                            className="absolute inset-0 flex items-center text-sm text-red-200 animate-in slide-in-from-bottom-2 fade-in duration-300"
                        >
                            <span className="font-semibold mr-2">[{currentAlert.labels['namespace'] || 'cluster'}]:</span>
                            <span className="truncate">{currentAlert.name} - {currentAlert.message}</span>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-2 pl-4 border-l border-red-500/20 shrink-0">
                    <div className="flex gap-1">
                        {criticalAlerts.map((_, i) => (
                            <button
                                key={i}
                                onClick={() => setCurrentIndex(i)}
                                className={`w-1.5 h-1.5 rounded-full transition-all ${i === currentIndex ? 'bg-red-400 w-3' : 'bg-red-500/30 hover:bg-red-500/50'
                                    }`}
                            />
                        ))}
                    </div>
                    {onAlertClick && (
                        <button
                            onClick={() => onAlertClick(currentAlert)}
                            className="p-1 text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        >
                            <ChevronRight size={16} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
