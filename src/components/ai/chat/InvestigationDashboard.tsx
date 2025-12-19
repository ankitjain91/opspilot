/**
 * InvestigationDashboard - Real-time investigation progress visualization
 * Shows hypotheses, evidence, coverage, and phase progress in a clean dashboard
 */

import React, { useMemo } from 'react';
import {
    Brain,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Target,
    Lightbulb,
    Activity,
    Layers,
    TrendingUp,
    Clock,
    Zap
} from 'lucide-react';

export interface Hypothesis {
    title: string;
    confidence?: number;
    status?: 'testing' | 'confirmed' | 'refuted';
    evidence?: string[];
}

export interface PhaseInfo {
    name: string;
    timestamp?: string;
    duration?: number;
}

export interface CoverageItem {
    area: string;
    checked: boolean;
}

export interface InvestigationDashboardProps {
    // Phase tracking
    phases: PhaseInfo[];
    currentPhase?: string;

    // Hypotheses
    hypotheses: Hypothesis[];

    // Coverage
    coverageGaps: string[];
    coverageItems?: CoverageItem[];

    // Progress
    iteration?: number;
    maxIterations?: number;
    confidence?: { level: string; score: number };

    // Hints
    hints: string[];

    // Goal status
    goalMet?: boolean;
    goalReason?: string;

    // Extended mode
    extendedMode?: {
        preferred_checks?: string[];
        prefer_mcp_tools?: boolean;
    };

    // Actions
    onExtend?: () => void;
    onApplyHint?: (hint: string) => void;

    className?: string;
}

export const InvestigationDashboard: React.FC<InvestigationDashboardProps> = ({
    phases,
    currentPhase,
    hypotheses,
    coverageGaps,
    coverageItems,
    iteration,
    maxIterations,
    confidence,
    hints,
    goalMet,
    goalReason,
    extendedMode,
    onExtend,
    onApplyHint,
    className = ''
}) => {
    // Memoize computed values
    const progressPercent = useMemo(() => {
        if (iteration && maxIterations) {
            return Math.round((iteration / maxIterations) * 100);
        }
        return 0;
    }, [iteration, maxIterations]);

    const confirmedHypotheses = useMemo(() =>
        hypotheses.filter(h => h.status === 'confirmed').length,
        [hypotheses]
    );

    const testingHypotheses = useMemo(() =>
        hypotheses.filter(h => h.status === 'testing' || !h.status).length,
        [hypotheses]
    );

    // Don't render if nothing to show
    const hasContent = phases.length > 0 ||
        hypotheses.length > 0 ||
        coverageGaps.length > 0 ||
        hints.length > 0 ||
        goalMet !== undefined ||
        extendedMode;

    if (!hasContent) return null;

    return (
        <div className={`bg-gradient-to-br from-[#0d1117] to-[#161b22] rounded-xl border border-cyan-500/20 overflow-hidden ${className}`}>
            {/* Header */}
            <div className="px-4 py-3 bg-cyan-500/5 border-b border-cyan-500/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-cyan-500/20">
                        <Brain size={14} className="text-cyan-400" />
                    </div>
                    <span className="text-xs font-bold text-cyan-300 uppercase tracking-wider">Investigation Dashboard</span>
                </div>

                {/* Progress indicator */}
                {iteration && maxIterations && (
                    <div className="flex items-center gap-2">
                        <div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all duration-500"
                                style={{ width: `${progressPercent}%` }}
                            />
                        </div>
                        <span className="text-[10px] font-mono text-zinc-400">
                            {iteration}/{maxIterations}
                        </span>
                    </div>
                )}
            </div>

            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Goal Status - Priority Display */}
                {goalMet !== undefined && (
                    <div className={`col-span-full p-3 rounded-lg border ${
                        goalMet
                            ? 'bg-emerald-500/10 border-emerald-500/30'
                            : 'bg-amber-500/10 border-amber-500/30'
                    }`}>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                {goalMet ? (
                                    <CheckCircle2 size={16} className="text-emerald-400" />
                                ) : (
                                    <AlertCircle size={16} className="text-amber-400" />
                                )}
                                <span className={`text-xs font-bold uppercase tracking-wider ${
                                    goalMet ? 'text-emerald-300' : 'text-amber-300'
                                }`}>
                                    Goal: {goalMet ? 'Achieved' : 'In Progress'}
                                </span>
                            </div>
                            {!goalMet && onExtend && (
                                <button
                                    onClick={onExtend}
                                    className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/40 text-violet-300 rounded-lg transition-all"
                                >
                                    Extend Investigation
                                </button>
                            )}
                        </div>
                        {goalReason && (
                            <p className="text-[11px] text-zinc-300 mt-2">{goalReason}</p>
                        )}
                    </div>
                )}

                {/* Phase Timeline */}
                {phases.length > 0 && (
                    <div className="bg-[#0a0e14] rounded-lg border border-zinc-800/50 p-3">
                        <div className="flex items-center gap-2 mb-3">
                            <Layers size={12} className="text-violet-400" />
                            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Phases</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {phases.map((phase, idx) => (
                                <span
                                    key={idx}
                                    className={`px-2 py-1 text-[10px] rounded-md border transition-all ${
                                        phase.name === currentPhase
                                            ? 'bg-violet-500/20 border-violet-500/40 text-violet-300 animate-pulse'
                                            : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400'
                                    }`}
                                >
                                    {phase.name}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Hypotheses */}
                {hypotheses.length > 0 && (
                    <div className="bg-[#0a0e14] rounded-lg border border-zinc-800/50 p-3">
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                                <Target size={12} className="text-cyan-400" />
                                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Hypotheses</span>
                            </div>
                            <div className="flex items-center gap-2 text-[9px]">
                                <span className="text-emerald-400">{confirmedHypotheses} confirmed</span>
                                <span className="text-zinc-600">•</span>
                                <span className="text-amber-400">{testingHypotheses} testing</span>
                            </div>
                        </div>
                        <ul className="space-y-2">
                            {hypotheses.slice(0, 4).map((h, i) => (
                                <li key={i} className="flex items-start gap-2">
                                    <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                                        h.status === 'confirmed' ? 'bg-emerald-500' :
                                        h.status === 'refuted' ? 'bg-red-500' :
                                        'bg-amber-500 animate-pulse'
                                    }`} />
                                    <div className="flex-1 min-w-0">
                                        <p className={`text-[11px] leading-relaxed ${
                                            h.status === 'refuted' ? 'text-zinc-500 line-through' : 'text-zinc-300'
                                        }`}>
                                            {h.title}
                                        </p>
                                        {h.confidence !== undefined && (
                                            <div className="flex items-center gap-1.5 mt-1">
                                                <div className="w-12 h-1 bg-zinc-800 rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full ${
                                                            h.confidence > 0.7 ? 'bg-emerald-500' :
                                                            h.confidence > 0.4 ? 'bg-amber-500' : 'bg-red-500'
                                                        }`}
                                                        style={{ width: `${h.confidence * 100}%` }}
                                                    />
                                                </div>
                                                <span className="text-[9px] text-zinc-500 font-mono">
                                                    {Math.round(h.confidence * 100)}%
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                        {hypotheses.length > 4 && (
                            <p className="text-[10px] text-zinc-500 mt-2">
                                +{hypotheses.length - 4} more hypotheses
                            </p>
                        )}
                    </div>
                )}

                {/* Coverage Gaps */}
                {coverageGaps.length > 0 && (
                    <div className="bg-[#0a0e14] rounded-lg border border-amber-500/20 p-3">
                        <div className="flex items-center gap-2 mb-3">
                            <AlertCircle size={12} className="text-amber-400" />
                            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Coverage Gaps</span>
                        </div>
                        <ul className="space-y-1.5">
                            {coverageGaps.map((gap, i) => (
                                <li key={i} className="flex items-center gap-2 text-[11px] text-amber-300">
                                    <span className="w-1 h-1 rounded-full bg-amber-500" />
                                    {gap}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Hints */}
                {hints.length > 0 && (
                    <div className="bg-[#0a0e14] rounded-lg border border-cyan-500/20 p-3">
                        <div className="flex items-center gap-2 mb-3">
                            <Lightbulb size={12} className="text-cyan-400" />
                            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Agent Hints</span>
                        </div>
                        <ul className="space-y-2">
                            {hints.slice(0, 3).map((hint, i) => (
                                <li key={i} className="group">
                                    <p className="text-[11px] text-cyan-300 leading-relaxed">{hint}</p>
                                    {onApplyHint && (
                                        <button
                                            onClick={() => onApplyHint(hint)}
                                            className="mt-1 text-[9px] text-cyan-500 hover:text-cyan-400 transition-colors opacity-0 group-hover:opacity-100"
                                        >
                                            Apply this hint →
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Extended Mode Indicator */}
                {extendedMode && (
                    <div className="bg-[#0a0e14] rounded-lg border border-violet-500/20 p-3">
                        <div className="flex items-center gap-2 mb-2">
                            <Zap size={12} className="text-violet-400" />
                            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Extended Mode</span>
                        </div>
                        {extendedMode.preferred_checks && extendedMode.preferred_checks.length > 0 && (
                            <p className="text-[11px] text-violet-300">
                                Prioritizing: {extendedMode.preferred_checks.join(', ')}
                            </p>
                        )}
                        {extendedMode.prefer_mcp_tools && (
                            <p className="text-[11px] text-violet-300 mt-1">
                                Using MCP tools for deeper analysis
                            </p>
                        )}
                    </div>
                )}

                {/* Confidence Meter */}
                {confidence && (
                    <div className="col-span-full bg-[#0a0e14] rounded-lg border border-zinc-800/50 p-3">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <TrendingUp size={12} className="text-emerald-400" />
                                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Confidence</span>
                            </div>
                            <span className={`text-xs font-bold ${
                                confidence.level === 'HIGH' ? 'text-emerald-400' :
                                confidence.level === 'MEDIUM' ? 'text-amber-400' : 'text-red-400'
                            }`}>
                                {confidence.level}
                            </span>
                        </div>
                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className={`h-full transition-all duration-500 ${
                                    confidence.level === 'HIGH' ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' :
                                    confidence.level === 'MEDIUM' ? 'bg-gradient-to-r from-amber-500 to-amber-400' :
                                    'bg-gradient-to-r from-red-500 to-red-400'
                                }`}
                                style={{ width: `${confidence.score}%` }}
                            />
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-1.5 text-right font-mono">
                            {confidence.score}% certainty
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default InvestigationDashboard;
