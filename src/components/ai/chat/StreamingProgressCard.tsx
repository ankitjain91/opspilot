/**
 * StreamingProgressCard - Clean, informative progress UI for agent investigations
 *
 * Shows current phase with command transparency:
 * 🤔 Planning → 🔧 Executing → 🧪 Analyzing → ✅ Complete
 *
 * Includes expandable command log with result summaries
 */

import React, { useState } from 'react';
import { Loader2, CheckCircle2, Brain, Wrench, FlaskConical, Search, ChevronDown, Terminal, AlertCircle, CheckCircle } from 'lucide-react';

export interface CommandExecution {
    command: string;
    summary?: string; // Human-readable summary: "Found 3 failing pods"
    status: 'running' | 'success' | 'error';
    output?: string; // Raw output (for expand/details)
    timestamp: number;
}

export interface AgentPhase {
    phase: 'planning' | 'executing' | 'analyzing' | 'complete' | 'error';
    message: string;
    currentStep?: string; // e.g., "Running kubectl get pods"
    stepsCompleted?: number;
    totalSteps?: number;
    commandHistory?: CommandExecution[]; // Commands executed so far
    suggestions?: string[]; // Next-step suggestions (shown on complete)
}

interface StreamingProgressCardProps {
    phase: AgentPhase;
    className?: string;
}

export const StreamingProgressCard: React.FC<StreamingProgressCardProps> = ({ phase, className = '' }) => {
    const [showCommands, setShowCommands] = useState(true); // Auto-expand to show transparency

    const getPhaseConfig = (phaseName: string) => {
        switch (phaseName) {
            case 'planning':
                return {
                    icon: Brain,
                    color: 'violet',
                    bgClass: 'bg-violet-500/10',
                    borderClass: 'border-violet-500/30',
                    textClass: 'text-violet-400',
                    label: 'Planning'
                };
            case 'executing':
                return {
                    icon: Wrench,
                    color: 'blue',
                    bgClass: 'bg-blue-500/10',
                    borderClass: 'border-blue-500/30',
                    textClass: 'text-blue-400',
                    label: 'Executing'
                };
            case 'analyzing':
                return {
                    icon: FlaskConical,
                    color: 'amber',
                    bgClass: 'bg-amber-500/10',
                    borderClass: 'border-amber-500/30',
                    textClass: 'text-amber-400',
                    label: 'Analyzing'
                };
            case 'complete':
                return {
                    icon: CheckCircle2,
                    color: 'emerald',
                    bgClass: 'bg-emerald-500/10',
                    borderClass: 'border-emerald-500/30',
                    textClass: 'text-emerald-400',
                    label: 'Complete'
                };
            case 'error':
                return {
                    icon: CheckCircle2,
                    color: 'red',
                    bgClass: 'bg-red-500/10',
                    borderClass: 'border-red-500/30',
                    textClass: 'text-red-400',
                    label: 'Error'
                };
            default:
                return {
                    icon: Search,
                    color: 'gray',
                    bgClass: 'bg-gray-500/10',
                    borderClass: 'border-gray-500/30',
                    textClass: 'text-gray-400',
                    label: 'Working'
                };
        }
    };

    const config = getPhaseConfig(phase.phase);
    const Icon = config.icon;
    const isActive = phase.phase !== 'complete' && phase.phase !== 'error';

    return (
        <div className={`
            border rounded-lg p-4
            ${config.bgClass} ${config.borderClass}
            transition-all duration-300
            ${className}
        `}>
            <div className="flex items-start gap-3">
                {/* Phase Icon */}
                <div className={`
                    mt-0.5 flex-shrink-0
                    ${isActive ? 'animate-pulse' : ''}
                `}>
                    {isActive ? (
                        <Loader2 size={20} className={`${config.textClass} animate-spin`} />
                    ) : (
                        <Icon size={20} className={config.textClass} />
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    {/* Phase Label */}
                    <div className="flex items-center gap-2 mb-1">
                        <span className={`text-sm font-semibold ${config.textClass}`}>
                            {config.label}
                        </span>
                        {phase.stepsCompleted !== undefined && phase.totalSteps !== undefined && (
                            <span className="text-xs text-zinc-500">
                                {phase.stepsCompleted}/{phase.totalSteps}
                            </span>
                        )}
                    </div>

                    {/* Main Message */}
                    <p className="text-sm text-zinc-300 mb-2">
                        {phase.message}
                    </p>

                    {/* Current Step (if executing) */}
                    {phase.currentStep && isActive && (
                        <div className="text-xs font-mono text-zinc-500 bg-zinc-900/50 rounded px-2 py-1 mt-2">
                            {phase.currentStep}
                        </div>
                    )}

                    {/* Progress Bar (if steps are defined) */}
                    {phase.stepsCompleted !== undefined && phase.totalSteps !== undefined && phase.totalSteps > 0 && (
                        <div className="mt-3 w-full bg-zinc-800 rounded-full h-1.5">
                            <div
                                className={`h-1.5 rounded-full transition-all duration-500 ${config.bgClass.replace('/10', '/50')}`}
                                style={{ width: `${(phase.stepsCompleted / phase.totalSteps) * 100}%` }}
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* Command Log Section (Expandable) */}
            {phase.commandHistory && phase.commandHistory.length > 0 && (
                <div className="mt-3 border-t border-zinc-800 pt-3">
                    <button
                        onClick={() => setShowCommands(!showCommands)}
                        className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-300 transition-colors mb-2 w-full"
                    >
                        <Terminal size={12} />
                        <span>Commands Executed ({phase.commandHistory.length})</span>
                        <ChevronDown
                            size={12}
                            className={`ml-auto transition-transform ${showCommands ? 'rotate-180' : ''}`}
                        />
                    </button>

                    {showCommands && (
                        <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
                            {phase.commandHistory.map((cmd, idx) => (
                                <CommandExecutionItem key={idx} execution={cmd} />
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Suggestions Section (shown on complete) */}
            {phase.suggestions && phase.suggestions.length > 0 && phase.phase === 'complete' && (
                <div className="mt-3 border-t border-zinc-800 pt-3">
                    <div className="text-xs text-zinc-400 mb-2 flex items-center gap-2">
                        <Search size={12} />
                        <span>Suggested next steps:</span>
                    </div>
                    <div className="space-y-1">
                        {phase.suggestions.map((suggestion, idx) => (
                            <div key={idx} className="text-xs text-zinc-300 bg-zinc-900/50 rounded px-2 py-1.5 border border-zinc-800">
                                {suggestion}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// Sub-component for individual command execution
const CommandExecutionItem: React.FC<{ execution: CommandExecution }> = ({ execution }) => {
    const [showRawOutput, setShowRawOutput] = useState(false);

    const getStatusIcon = () => {
        switch (execution.status) {
            case 'running':
                return <Loader2 size={14} className="text-blue-400 animate-spin" />;
            case 'success':
                return <CheckCircle size={14} className="text-emerald-400" />;
            case 'error':
                return <AlertCircle size={14} className="text-red-400" />;
        }
    };

    return (
        <div className={`
            rounded border p-2 text-xs
            ${execution.status === 'running' ? 'bg-blue-500/5 border-blue-500/20' :
                execution.status === 'success' ? 'bg-emerald-500/5 border-emerald-500/20' :
                    'bg-red-500/5 border-red-500/20'}
        `}>
            {/* Command + Status */}
            <div className="flex items-start gap-2 mb-1">
                {getStatusIcon()}
                <code className="flex-1 text-zinc-300 font-mono text-[11px] break-all">
                    {execution.command}
                </code>
            </div>

            {/* Summary (human-readable result) */}
            {execution.summary && (
                <div className="text-zinc-400 ml-5 mt-1">
                    {execution.summary}
                </div>
            )}

            {/* Toggle raw output */}
            {execution.output && execution.status !== 'running' && (
                <div className="ml-5 mt-2">
                    <button
                        onClick={() => setShowRawOutput(!showRawOutput)}
                        className="text-[10px] text-zinc-500 hover:text-zinc-400 flex items-center gap-1"
                    >
                        <ChevronDown
                            size={10}
                            className={`transition-transform ${showRawOutput ? 'rotate-180' : ''}`}
                        />
                        {showRawOutput ? 'Hide' : 'Show'} raw output
                    </button>
                    {showRawOutput && (
                        <pre className="mt-1 p-2 bg-zinc-900 rounded text-[10px] text-zinc-400 overflow-x-auto max-h-32 custom-scrollbar">
                            {execution.output}
                        </pre>
                    )}
                </div>
            )}
        </div>
    );
};
