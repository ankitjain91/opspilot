import React, { useState, useEffect } from 'react';
import { useSentinelContext } from './SentinelContext';
import { getAgentServerUrl } from '../../utils/config';
import {
    Activity,
    X,
    Shield,
    RefreshCw,
    CheckCircle2,
    AlertTriangle,
    Server,
    Terminal,
    Wifi
} from 'lucide-react';

export function ConnectionDoctor() {
    const [isOpen, setIsOpen] = useState(false);
    const { status, reconnect } = useSentinelContext();
    const [healthData, setHealthData] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(false);

    const fetchHealth = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`${getAgentServerUrl()}/health`);
            const data = await res.json();
            setHealthData(data);
        } catch (e) {
            setHealthData({ error: "Failed to reach Agent Server", details: String(e) });
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            fetchHealth();
            const interval = setInterval(fetchHealth, 5000);
            return () => clearInterval(interval);
        }
    }, [isOpen]);

    const getStatusColor = () => {
        if (status === 'connected') return 'text-emerald-400';
        if (status === 'connecting') return 'text-yellow-400';
        return 'text-red-400';
    };

    const getBadgeColor = () => {
        if (status === 'connected') return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
        if (status === 'connecting') return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
        return 'bg-red-500/20 text-red-400 border-red-500/30';
    };

    return (
        <>
            {/* Status Pill - Always Visible */}
            {/* Status Indicator - Minimalist Dot */}
            <div className="fixed bottom-1 left-1 z-50 group">
                <button
                    onClick={() => setIsOpen(true)}
                    className="relative flex items-center justify-center p-2 rounded-full transition-all hover:bg-zinc-800/50"
                    title={`System Status: ${status}`}
                >
                    {/* Status Dot */}
                    <div className={`
                        w-2.5 h-2.5 rounded-full shadow-lg transition-all duration-500
                        ${status === 'connected' ? 'bg-emerald-500/80 shadow-emerald-500/20 group-hover:scale-110' : ''}
                        ${status === 'connecting' ? 'bg-yellow-500 animate-pulse shadow-yellow-500/20' : ''}
                        ${status === 'error' ? 'bg-red-500 shadow-red-500/20' : ''}
                    `} />

                    {/* Subtle Pulse Ring for Error/Connecting */}
                    {status !== 'connected' && (
                        <div className={`absolute inset-0 rounded-full animate-ping opacity-20 ${status === 'error' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                    )}
                </button>
            </div>

            {/* Doctor Modal */}
            {isOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <div
                        className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
                        onClick={() => setIsOpen(false)}
                    />
                    <div className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">

                        {/* Header */}
                        <div className="flex items-center justify-between p-6 border-b border-zinc-800 bg-zinc-900/50">
                            <div className="flex items-center gap-3">
                                <div className={`p-2 rounded-lg ${status === 'connected' ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                                    <Shield className={getStatusColor()} size={24} />
                                </div>
                                <div>
                                    <h2 className="text-lg font-semibold text-zinc-100">Connection Doctor</h2>
                                    <p className="text-sm text-zinc-400">System Health & Diagnostics</p>
                                </div>
                            </div>
                            <button
                                onClick={() => setIsOpen(false)}
                                className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-zinc-100 transition-colors"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        {/* Body */}
                        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">

                            {/* Actions */}
                            <div className="flex gap-3">
                                <button
                                    onClick={() => {
                                        reconnect();
                                        fetchHealth();
                                    }}
                                    className="flex-1 flex items-center justify-center gap-2 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors font-medium text-sm"
                                >
                                    <RefreshCw size={16} />
                                    Force Reconnect
                                </button>
                                <button
                                    onClick={fetchHealth}
                                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors font-medium text-sm flex items-center gap-2"
                                >
                                    <Activity size={16} />
                                    Refresh Status
                                </button>
                            </div>

                            {/* Sentinel Status */}
                            <div className="space-y-3">
                                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                                    <Wifi size={14} /> Sentinel Connection
                                </h3>
                                <div className="grid grid-cols-2 gap-4">
                                    <StatusCard
                                        label="WebSocket Status"
                                        value={status.toUpperCase()}
                                        status={status === 'connected' ? 'success' : status === 'connecting' ? 'warning' : 'error'}
                                    />
                                    <StatusCard
                                        label="Agent URL"
                                        value={getAgentServerUrl()}
                                        status="neutral"
                                        mono
                                    />
                                </div>
                            </div>

                            {/* Claude Guardian Status */}
                            <div className="space-y-3">
                                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                                    <Terminal size={14} /> Claude Guardian
                                </h3>
                                {isLoading && !healthData ? (
                                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800 animate-pulse">
                                        Checking Agent status...
                                    </div>
                                ) : healthData?.claude ? (
                                    <div className="grid grid-cols-1 gap-3">
                                        <div className={`p-4 rounded-lg border ${healthData.claude.connected ? 'bg-emerald-950/30 border-emerald-900/50' : 'bg-red-950/30 border-red-900/50'}`}>
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="font-medium text-zinc-200">Claude CLI</span>
                                                {healthData.claude.connected ? (
                                                    <span className="flex items-center gap-1 text-emerald-400 text-sm"><CheckCircle2 size={14} /> Ready</span>
                                                ) : (
                                                    <span className="flex items-center gap-1 text-red-400 text-sm"><AlertTriangle size={14} /> Offline</span>
                                                )}
                                            </div>
                                            {healthData.claude.version && (
                                                <div className="text-xs text-zinc-500 font-mono mb-1">{healthData.claude.version}</div>
                                            )}
                                            {healthData.claude.error && (
                                                <div className="mt-2 p-2 bg-black/40 rounded text-xs text-red-300 font-mono border border-red-900/30">
                                                    {healthData.claude.error}
                                                </div>
                                            )}
                                            <div className="mt-2 text-[10px] text-zinc-600">
                                                Last Check: {healthData.claude.last_check ? new Date(healthData.claude.last_check * 1000).toLocaleTimeString() : 'Never'}
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800 text-zinc-500 text-sm">
                                        Agent Server unreachable or Guardian not active.
                                    </div>
                                )}
                            </div>

                            {/* Server Info */}
                            {healthData && (
                                <div className="space-y-3">
                                    <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                                        <Server size={14} /> Server Diagnostics
                                    </h3>
                                    <pre className="p-4 bg-black rounded-lg border border-zinc-800 text-xs text-zinc-400 font-mono overflow-auto max-h-40">
                                        {JSON.stringify(healthData, null, 2)}
                                    </pre>
                                </div>
                            )}

                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

function StatusCard({ label, value, status, mono }: { label: string, value: string, status: 'success' | 'warning' | 'error' | 'neutral', mono?: boolean }) {
    const colors = {
        success: 'bg-emerald-950/30 border-emerald-900/50 text-emerald-400',
        warning: 'bg-yellow-950/30 border-yellow-900/50 text-yellow-400',
        error: 'bg-red-950/30 border-red-900/50 text-red-400',
        neutral: 'bg-zinc-900 border-zinc-800 text-zinc-300'
    };

    return (
        <div className={`p-3 rounded-lg border ${colors[status]}`}>
            <div className="text-[10px] uppercase tracking-wider opacity-70 mb-1">{label}</div>
            <div className={`font-medium truncate ${mono ? 'font-mono text-xs' : 'text-sm'}`} title={value}>
                {value}
            </div>
        </div>
    );
}
