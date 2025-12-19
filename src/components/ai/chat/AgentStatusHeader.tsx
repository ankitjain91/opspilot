
import React from 'react';
import { Loader2, Activity, Zap, Search, Terminal, Database, Shield } from 'lucide-react';

interface AgentStatusHeaderProps {
    activity: string;
    phase?: string;
    progress?: number;
    provider?: string;
    className?: string;
}

export const AgentStatusHeader: React.FC<AgentStatusHeaderProps> = ({
    activity,
    phase,
    progress,
    provider,
    className = ""
}) => {
    if (!activity && !phase) return null;

    const getIcon = (act: string) => {
        const lower = act.toLowerCase();
        if (lower.includes('scanning') || lower.includes('searching') || lower.includes('finding')) return <Search size={14} className="text-cyan-400" />;
        if (lower.includes('executing') || lower.includes('running')) return <Terminal size={14} className="text-emerald-400" />;
        if (lower.includes('analyzing') || lower.includes('thinking')) return <Activity size={14} className="text-violet-400" />;
        if (lower.includes('fetching') || lower.includes('loading')) return <Database size={14} className="text-blue-400" />;
        if (lower.includes('security') || lower.includes('verifying')) return <Shield size={14} className="text-amber-400" />;
        return <Zap size={14} className="text-violet-400" />;
    };

    return (
        <div className={`
            flex flex-col gap-2 p-3 bg-white/5 border border-white/10 rounded-xl overflow-hidden relative group transition-all duration-500
            ${className}
        `}>
            {/* Background Grain/Texture */}
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] bg-repeat" />

            <div className="flex items-center justify-between relative z-10">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="relative shrink-0">
                        <div className="absolute inset-0 bg-violet-500/20 blur-md rounded-full animate-pulse" />
                        <div className="relative p-1.5 rounded-lg bg-white/5 border border-white/10 shadow-inner">
                            {getIcon(activity)}
                        </div>
                    </div>

                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold text-violet-400 uppercase tracking-widest flex items-center gap-1.5">
                                <span className="relative flex h-1.5 w-1.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-violet-500"></span>
                                </span>
                                {phase || 'Processing'}
                            </span>
                        </div>
                        <h4 className="text-sm font-semibold text-white/90 truncate leading-tight mt-0.5">
                            {activity}...
                        </h4>
                    </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                    <Loader2 size={16} className="text-violet-500 animate-spin opacity-50" />
                </div>
            </div>

            {/* Progress Bar (if provided) */}
            {typeof progress === 'number' && (
                <div className="relative h-1 w-full bg-white/5 rounded-full overflow-hidden mt-1">
                    <div
                        className="absolute inset-0 bg-gradient-to-r from-violet-600 via-fuchsia-500 to-violet-600 bg-[length:200%_100%] animate-[shimmer_2s_infinite_linear]"
                        style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                    />
                </div>
            )}
        </div>
    );
};
