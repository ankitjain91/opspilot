
import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Calculator, CheckCircle2, Clock, Loader2 } from 'lucide-react';
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
                    border rounded-xl transition-all duration-300 overflow-hidden
                    ${isExpanded ? 'bg-zinc-900/50 border-zinc-700 shadow-md' : 'bg-zinc-900/30 border-zinc-800/50 hover:bg-zinc-900/50 hover:border-zinc-700'}
                 `}>
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left group"
                    >
                        {/* Status Icon */}
                        <div className={`
                            w-6 h-6 rounded-full flex items-center justify-center shrink-0 border
                            ${isActive
                                ? 'bg-violet-500/20 border-violet-500/50 text-violet-400 animate-pulse'
                                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                            }
                         `}>
                            {isActive ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                        </div>

                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className={`text-sm font-medium ${isActive ? 'text-violet-200' : 'text-zinc-300'}`}>
                                    {isActive ? 'Investigation in progress...' : 'Investigation Complete'}
                                </span>
                                <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-full border border-zinc-700">
                                    {steps.length} steps
                                </span>
                            </div>
                            <div className="flex items-center gap-3 mt-0.5 text-[11px] text-zinc-500">
                                <span className="flex items-center gap-1">
                                    <Clock size={10} />
                                    {/* Placeholder for duration if we tracked it */}
                                    Processing
                                </span>
                                <span>•</span>
                                <span>{toolCount} tools used</span>
                            </div>
                        </div>

                        <ChevronDown
                            size={16}
                            className={`text-zinc-500 transition-transform duration-300 ${isExpanded ? 'rotate-180' : 'rotate-0'}`}
                        />
                    </button>

                    <div className={`
                        transition-[max-height,opacity] duration-500 ease-in-out
                        ${isExpanded ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'}
                    `}>
                        <div className="px-3 pb-3 pt-0 space-y-2 max-h-[500px] overflow-y-auto custom-scrollbar">
                            {/* Inner Timeline Divider */}
                            <div className="w-full h-px bg-zinc-800/50 mb-3" />

                            {steps.map((msg, idx) => (
                                <div key={idx} className="relative">
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
