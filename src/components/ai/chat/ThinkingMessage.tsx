
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
        <div className="relative pl-8 pb-3 group font-sans text-sm">
            {/* Timeline Dot with Pulse Effect */}
            <div className="absolute left-0 top-2 z-10">
                <div className={`w-3.5 h-3.5 rounded-full bg-violet-500 ring-4 ring-violet-500/10 shadow-[0_0_12px_rgba(139,92,246,0.4)] ${isLatest ? 'animate-pulse' : ''}`} />
                {isLatest && <div className="absolute top-0 left-0 w-3.5 h-3.5 rounded-full bg-violet-400 animate-ping opacity-75" />}
            </div>

            <div className="ml-3">
                <div
                    className={`
                        border rounded-2xl overflow-hidden transition-all duration-500 ease-out shadow-lg shadow-black/20
                        ${isExpanded
                            ? 'bg-gradient-to-br from-[#1a1a2e] to-[#13111c] border-violet-500/30'
                            : 'bg-white/5 border-white/5 hover:border-violet-500/20 hover:bg-white/[0.07]'
                        }
                    `}
                >
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="w-full flex items-center gap-4 px-4 py-3 text-left relative overflow-hidden group"
                    >
                        {/* Shimmer effect when collapsed */}
                        {!isExpanded && (
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1500" />
                        )}

                        <div className={`
                            shrink-0 p-2 rounded-lg transition-colors
                            ${isLatest ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-zinc-500 group-hover:text-violet-400'}
                        `}>
                            {isLatest ? <Cpu size={14} className="animate-spin-slow" /> : <BrainCircuit size={14} />}
                        </div>

                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                                <span className={`text-[10px] font-bold uppercase tracking-widest ${isLatest ? 'text-violet-400' : 'text-zinc-500'}`}>
                                    {isLatest ? 'Synthesizing Context' : 'Reasoning Chain'}
                                </span>
                                {isLatest && (
                                    <div className="flex gap-0.5 items-end h-3 pb-0.5">
                                        <div className="w-0.5 h-1.5 bg-violet-400 animate-[bounce_1s_infinite_0ms]" />
                                        <div className="w-0.5 h-2.5 bg-violet-400 animate-[bounce_1s_infinite_200ms]" />
                                        <div className="w-0.5 h-1.5 bg-violet-400 animate-[bounce_1s_infinite_400ms]" />
                                    </div>
                                )}
                            </div>

                            <h5 className="text-[13px] font-semibold text-zinc-200 truncate tracking-tight">
                                {isLatest ? 'Formulating next steps...' : cleanContent.split('\n')[0].slice(0, 60)}
                            </h5>
                            {!isExpanded && (
                                <p className="text-[11px] text-zinc-500 truncate mt-1 animate-in fade-in duration-500 italic">
                                    {cleanContent.replace(/\*\*/g, '').replace(/`/g, '').slice(0, 80)}{cleanContent.length > 80 && '...'}
                                </p>
                            )}
                        </div>

                        <ChevronDown
                            size={16}
                            className={`text-zinc-600 transition-transform duration-500 group-hover:text-violet-400 ${isExpanded ? 'rotate-180' : 'rotate-0'}`}
                        />
                    </button>

                    <div
                        className={`
                            transition-[max-height,opacity] duration-500 ease-in-out
                            ${isExpanded ? 'max-h-[1000px] opacity-100 border-t border-violet-500/10' : 'max-h-0 opacity-0 overflow-hidden'}
                        `}
                    >
                        <div className="p-5 relative">
                            {/* Decorative gradient for the content */}
                            <div className="absolute inset-0 bg-gradient-to-b from-violet-500/[0.02] to-transparent pointer-events-none" />

                            <div className="prose prose-invert prose-sm max-w-none text-[13px] text-zinc-300 leading-relaxed relative z-10">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        p: ({ children }) => <p className="mb-4 last:mb-0 leading-relaxed opacity-90">{children}</p>,
                                        strong: ({ children }) => <strong className="text-violet-300 font-bold border-b border-violet-500/30 pb-0.5">{children}</strong>,
                                        code: ({ children }) => <code className="text-[11px] bg-violet-500/10 px-1.5 py-0.5 rounded text-violet-200 font-mono border border-violet-500/20">{children}</code>,
                                        ul: ({ children }) => <ul className="list-disc ml-5 my-4 space-y-2 text-zinc-400">{children}</ul>,
                                        li: ({ children }) => <li className="pl-1">{children}</li>,
                                        blockquote: ({ children }) => <blockquote className="border-l-2 border-violet-500/30 pl-4 my-4 italic text-zinc-500">{children}</blockquote>,
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
