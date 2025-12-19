
import React, { useState, useEffect } from 'react';
import { ChevronDown, Terminal, CheckCircle2, AlertTriangle, Command, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PythonCodeBlock } from './PythonCodeBlock';

interface ToolMessageProps {
    toolName?: string;
    command?: string;
    content: string;
    isLatest?: boolean;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({ toolName, command, content, isLatest }) => {
    // Check if it's a Python command
    const isPython = command?.trim().startsWith("python:");
    const pythonCode = isPython ? command?.replace(/^python:\s*/, '') : '';

    // Auto-collapse after 3 seconds if not an error/warning
    const [isExpanded, setIsExpanded] = useState(true);
    const isWarning = content.startsWith('⚠️') || content.includes('Error') || content.includes('Failed');
    const isRecipeSaved = content.includes('saved to library') && content.includes('Recipe');

    useEffect(() => {
        // If it's a warning or recipe saved, keep it open. Otherwise auto-collapse after a delay.
        if (isWarning || isRecipeSaved) return;

        const timer = setTimeout(() => {
            setIsExpanded(false);
        }, 2500); // 2.5s delay to let user glimpse the output

        return () => clearTimeout(timer);
    }, [isWarning, content]);

    // --- 10x Python Handler ---
    // If this is a Python command, we use the specialized PythonCodeBlock renderer
    // This provides syntax highlighting and a cleaner "Notebook" style look
    if (isPython && pythonCode) {
        return <PythonCodeBlock code={pythonCode} output={content} isExecuting={content === ''} />;
    }

    return (
        <div className="relative pl-8 pb-3 group font-sans text-sm">
            {/* Timeline Dot with Glow */}
            <div className="absolute left-0 top-2 z-10">
                <div className={`w-3.5 h-3.5 rounded-full ring-4 transition-all duration-500 
                    ${isWarning
                        ? 'bg-rose-500 ring-rose-500/10 shadow-[0_0_12px_rgba(244,63,94,0.4)]'
                        : 'bg-emerald-500 ring-emerald-500/10 shadow-[0_0_12px_rgba(16,185,129,0.4)]'}
                `} />
                {isLatest && (
                    <div className={`absolute top-0 left-0 w-3.5 h-3.5 rounded-full animate-ping opacity-75 ${isWarning ? 'bg-rose-400' : 'bg-emerald-400'}`} />
                )}
            </div>

            <div className="ml-3">
                <div
                    className={`
                        border rounded-xl overflow-hidden transition-all duration-500 ease-in-out shadow-lg shadow-black/20
                        ${isExpanded
                            ? 'bg-[#0d1117] border-white/10'
                            : 'bg-white/5 border-white/5 hover:border-white/10 hover:bg-white/[0.07]'}
                    `}
                >
                    {/* Header / Summary */}
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="w-full flex items-center gap-4 px-4 py-3 text-left transition-colors relative group"
                    >
                        <div className={`
                            shrink-0 p-2 rounded-lg transition-colors
                            ${isWarning
                                ? 'bg-rose-500/10 text-rose-400 group-hover:bg-rose-500/20'
                                : 'bg-white/5 text-zinc-400 group-hover:bg-white/10 group-hover:text-emerald-400'}
                        `}>
                            {command ? <Terminal size={14} /> : <Command size={14} />}
                        </div>

                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                                    {toolName === 'Tool Execution' ? 'System Action' : toolName || 'Action'}
                                </span>
                                {isRecipeSaved && (
                                    <span className="flex items-center gap-1 bg-violet-500/15 text-violet-300 px-2 py-0.5 rounded-full text-[9px] font-bold tracking-tight border border-violet-500/20">
                                        <Sparkles size={10} />
                                        Recipe Saved
                                    </span>
                                )}
                            </div>
                            <h5 className="text-[13px] font-mono font-semibold text-zinc-200 truncate tracking-tight transition-colors group-hover:text-white">
                                {command ? `$ ${command}` : 'Executing logic...'}
                            </h5>
                            {!isExpanded && (
                                <p className="text-[11px] text-zinc-500 truncate mt-1 animate-in fade-in duration-500 italic">
                                    {content.replace(/\*\*/g, '').replace(/`/g, '').slice(0, 80)}{content.length > 80 && '...'}
                                </p>
                            )}
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                            <div className={`
                                px-2 py-0.5 rounded text-[9px] font-bold tracking-wider border
                                ${isWarning
                                    ? 'bg-rose-500/10 border-rose-500/20 text-rose-400 uppercase'
                                    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 uppercase'}
                             `}>
                                {isWarning ? 'Error' : 'Success'}
                            </div>
                            <ChevronDown
                                size={16}
                                className={`text-zinc-600 transition-transform duration-500 group-hover:text-zinc-400 ${isExpanded ? 'rotate-180' : 'rotate-0'}`}
                            />
                        </div>
                    </button>

                    {/* Content Body (Collapsible) */}
                    <div
                        className={`
                            overflow-hidden transition-[max-height,opacity] duration-500 ease-in-out
                            ${isExpanded ? 'max-h-[800px] opacity-100 border-t border-white/5' : 'max-h-0 opacity-0'}
                        `}
                    >
                        <div className="p-4 overflow-x-auto text-[13px]">
                            {/* Command Detail (if exists) */}
                            {command && (
                                <div className="mb-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className="w-1 h-3 bg-violet-500 rounded-full" />
                                        <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Command Payload</span>
                                    </div>
                                    <div className="font-mono text-[12px] bg-black/60 text-zinc-200 p-3 rounded-xl border border-white/5 shadow-inner">
                                        <span className="text-emerald-400 mr-2 opacity-70">#</span>
                                        {command}
                                    </div>
                                </div>
                            )}

                            {/* Result Detail */}
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <div className={`w-1 h-3 rounded-full ${isWarning ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                                    <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">
                                        {isWarning ? 'Error Output' : 'Output Stream'}
                                    </span>
                                </div>

                                <div className="font-mono text-[12px] leading-relaxed text-zinc-300 p-4 rounded-xl bg-black/40 border border-white/5 shadow-inner relative group">
                                    {/* Shimmer on hover */}
                                    <div className="absolute inset-0 bg-gradient-to-br from-white/[0.01] to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        components={{
                                            p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed opacity-90">{children}</p>,
                                            strong: ({ children }) => <strong className="text-white font-bold">{children}</strong>,
                                            code: ({ children }) => <code className="text-emerald-400 bg-emerald-400/5 px-1 rounded">{children}</code>,
                                            pre: ({ children }) => <pre className="whitespace-pre-wrap font-mono my-2">{children}</pre>,
                                        }}
                                    >
                                        {content}
                                    </ReactMarkdown>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
