
import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Calculator, CheckCircle2, Clock, Loader2, Terminal } from 'lucide-react';
import { ToolMessage } from './ToolMessage';
import { ThinkingMessage } from './ThinkingMessage';

interface Message {
    role: string;
    content: string;
    command?: string;
    toolName?: string;
    isActivity?: boolean;
    [key: string]: any;
}

interface InvestigationTimelineProps {
    steps: Message[];
    isActive: boolean;
}

export const InvestigationTimeline: React.FC<InvestigationTimelineProps> = ({ steps, isActive }) => {
    // Default to expanded if active, collapsed if done.
    const [isExpanded, setIsExpanded] = useState(isActive);

    // Auto-collapse when it transitions from active to not active
    useEffect(() => {
        if (!isActive) {
            setIsExpanded(false);
        } else {
            setIsExpanded(true);
        }
    }, [isActive]);

    if (!steps || steps.length === 0) return null;

    const toolCount = steps.filter(s => s.role === 'tool').length;
    const thoughtCount = steps.filter(s => s.role === 'assistant').length;

    return (
        <div className="pl-6 pb-4">
            <div className="relative">
                {/* Timeline connection from User Message above (vertical line) */}
                <div className="absolute left-[-16px] top-0 bottom-0 w-0.5 bg-zinc-800" />

                {/* Main Timeline Card */}
                <div className={`
                    border rounded-2xl transition-all duration-500 overflow-hidden
                    ${isExpanded
                        ? 'bg-[#1a1a2e]/60 backdrop-blur-md border-violet-500/30'
                        : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-violet-500/20 shadow-lg'}
                 `}>
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="w-full flex items-center gap-4 px-5 py-4 text-left group"
                    >
                        {/* Status Icon */}
                        <div className="relative shrink-0">
                            {isActive && (
                                <div className="absolute inset-0 bg-violet-400 blur-md rounded-full animate-pulse opacity-50" />
                            )}
                            <div className={`
                                relative w-8 h-8 rounded-xl flex items-center justify-center border transition-all duration-300
                                ${isActive
                                    ? 'bg-violet-500/20 border-violet-500/40 text-violet-400'
                                    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                }
                             `}>
                                {isActive ? (
                                    <div className="flex gap-0.5 items-end h-3 pb-0.5">
                                        <div className="w-0.5 h-1.5 bg-violet-400 animate-[bounce_1s_infinite_0ms]" />
                                        <div className="w-0.5 h-2.5 bg-violet-400 animate-[bounce_1s_infinite_200ms]" />
                                        <div className="w-0.5 h-1.5 bg-violet-400 animate-[bounce_1s_infinite_400ms]" />
                                    </div>
                                ) : (
                                    <CheckCircle2 size={16} />
                                )}
                            </div>
                        </div>

                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className={`text-sm font-bold tracking-tight ${isActive ? 'text-violet-200' : 'text-zinc-200'}`}>
                                    {isActive ? 'Active Investigation' : 'Investigation Complete'}
                                </span>
                                <span className="text-[10px] bg-white/5 text-zinc-400 px-2 py-0.5 rounded-full border border-white/10 font-mono">
                                    {steps.length} {steps.length === 1 ? 'step' : 'steps'}
                                </span>
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-[11px] font-medium">
                                <span className="flex items-center gap-1.5 text-zinc-500">
                                    {isActive ? (
                                        <>
                                            <Loader2 size={12} className="animate-spin text-violet-400/60" />
                                            Analyzing signals...
                                        </>
                                    ) : (
                                        <>
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                            Signals verified
                                        </>
                                    )}
                                </span>
                                <span className="text-zinc-800">•</span>
                                <span className="text-zinc-500 flex items-center gap-1.5">
                                    <Terminal size={12} className="opacity-50" />
                                    {toolCount} tool usage{toolCount !== 1 ? 's' : ''}
                                </span>
                            </div>
                        </div>

                        <ChevronDown
                            size={18}
                            className={`text-zinc-600 transition-transform duration-500 group-hover:text-violet-400 ${isExpanded ? 'rotate-180' : 'rotate-0'}`}
                        />
                    </button>

                    <div className={`
                        transition-[max-height,opacity] duration-500 ease-in-out
                        ${isExpanded ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0 overflow-hidden'}
                    `}>
                        <div className="px-4 pb-5 pt-0 space-y-3 max-h-[600px] overflow-y-auto custom-scrollbar relative">
                            {/* Inner Timeline Divider */}
                            <div className="w-full h-px bg-gradient-to-r from-transparent via-white/10 to-transparent mb-5" />

                            {/* Vertical line through items */}
                            <div className="absolute left-[39px] top-6 bottom-10 w-px bg-gradient-to-b from-white/10 via-white/10 to-transparent" />

                            {steps.map((msg, idx) => (
                                <div key={idx} className="relative z-10">
                                    {msg.role === 'tool' ? (
                                        <ToolMessage
                                            command={msg.command}
                                            toolName={msg.toolName}
                                            content={msg.content}
                                            isLatest={idx === steps.length - 1 && isActive}
                                        />
                                    ) : (
                                        <ThinkingMessage
                                            content={msg.content}
                                            isLatest={idx === steps.length - 1 && isActive}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
