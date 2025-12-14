
import React, { useState, useEffect } from 'react';
import { ChevronDown, BrainCircuit, Sparkles, Cpu } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ThinkingMessageProps {
    content: string;
    isLatest?: boolean;
}

export const ThinkingMessage: React.FC<ThinkingMessageProps> = ({ content, isLatest }) => {
    // If it's the latest message, default to OPEN. 
    // If it's old history, default to COLLAPSED.
    const [isExpanded, setIsExpanded] = useState(!!isLatest);

    // Clean up content tags for display
    const cleanContent = content
        .replace(/🧠 (Thinking|Supervisor):\s*/g, '')
        .replace(/\*🔄 Investigating\.\.\.\*|\*🔄 Continuing investigation.*\*$/gm, '')
        .replace(/^PLANNING:\s*/gm, '')  // Remove repeated PLANNING: prefixes
        .replace(/^ANALYZING:\s*/gm, '')  // Remove repeated ANALYZING: prefixes
        .trim();

    // Auto-collapse when it stops being the latest message (i.e., process finished)
    useEffect(() => {
        if (!isLatest) {
            const timer = setTimeout(() => setIsExpanded(false), 1000);
            return () => clearTimeout(timer);
        } else {
            setIsExpanded(true);
        }
    }, [isLatest]);

    return (
        <div className="relative pl-6 pb-2">
            {/* Timeline Dot with Pulse Effect */}
            <div className="absolute left-0 top-1">
                <div className={`w-3 h-3 rounded-full bg-violet-500 ring-4 ring-violet-500/20 shadow-[0_0_15px_rgba(139,92,246,0.5)] ${isLatest ? 'animate-pulse' : ''}`} />
                {isLatest && <div className="absolute top-0 left-0 w-3 h-3 rounded-full bg-violet-400 animate-ping opacity-75" />}
            </div>

            {/* Timeline Line */}
            <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-violet-500/30 to-transparent" />

            <div className="ml-2">
                <div
                    className={`
                        border rounded-xl overflow-hidden transition-all duration-500 ease-out
                        ${isExpanded
                            ? 'bg-gradient-to-br from-[#1a1a2e] to-[#13111c] border-violet-500/30 shadow-lg shadow-violet-900/20'
                            : 'bg-white/5 border-white/5 hover:border-violet-500/30 hover:bg-white/10'
                        }
                    `}
                >
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="w-full flex items-center gap-3 px-3 py-2 text-left relative overflow-hidden group"
                    >
                        {/* Shimmer effect when collapsed */}
                        {!isExpanded && (
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
                        )}

                        <div className={`p-1.5 rounded-lg ${isLatest ? 'bg-violet-500/20 text-violet-300' : 'bg-zinc-800 text-zinc-500'}`}>
                            {isLatest ? <Cpu size={14} className="animate-pulse" /> : <BrainCircuit size={14} />}
                        </div>

                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-violet-200 tracking-wide uppercase">
                                    {isLatest ? 'Processing Context' : 'Reasoning Chain'}
                                </span>
                                {isLatest && (
                                    <div className="flex gap-0.5 items-end h-3 pb-0.5">
                                        <div className="w-0.5 h-1.5 bg-violet-400 animate-[bounce_1s_infinite_0ms]" />
                                        <div className="w-0.5 h-1.5 bg-violet-400 animate-[bounce_1s_infinite_200ms]" />
                                        <div className="w-0.5 h-1.5 bg-violet-400 animate-[bounce_1s_infinite_400ms]" />
                                    </div>
                                )}
                            </div>

                            {!isExpanded && (
                                <p className="text-[10px] text-zinc-400 truncate mt-0.5 font-medium">
                                    {/* Strip markdown formatting for preview */}
                                    {cleanContent.replace(/\*\*/g, '').replace(/`/g, '').slice(0, 50)}...
                                </p>
                            )}
                        </div>

                        <ChevronDown
                            size={14}
                            className={`text-violet-400/50 transition-transform duration-300 ${isExpanded ? 'rotate-180' : 'rotate-0'}`}
                        />
                    </button>

                    <div
                        className={`
                            transition-[max-height,opacity] duration-500 ease-in-out
                            ${isExpanded ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'}
                        `}
                    >
                        <div className="px-4 pb-4 pt-1">
                            {/* Decorative Divider */}
                            <div className="h-px w-full bg-gradient-to-r from-transparent via-violet-500/30 to-transparent mb-3" />

                            <div className="prose prose-invert prose-sm max-w-none text-xs text-zinc-300/90 leading-relaxed font-sans">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                                        strong: ({ children }) => <strong className="text-violet-300 font-semibold">{children}</strong>,
                                        code: ({ children }) => <code className="text-[10px] bg-violet-900/30 px-1 py-0.5 rounded text-violet-200 font-mono border border-violet-500/20">{children}</code>,
                                        ul: ({ children }) => <ul className="list-disc ml-4 my-2 space-y-1 text-zinc-400">{children}</ul>,
                                        li: ({ children }) => <li>{children}</li>
                                    }}
                                >
                                    {cleanContent}
                                </ReactMarkdown>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
