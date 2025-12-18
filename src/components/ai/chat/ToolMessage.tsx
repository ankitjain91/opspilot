
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
        <div className="relative pl-6 pb-2 group font-mono text-sm">
            {/* Timeline Line/Dot */}
            <div className={`absolute left-0 top-1 w-3 h-3 rounded-full ring-4 transition-all duration-500 
                ${isWarning ? 'bg-amber-500 ring-amber-500/20 shadow-[0_0_10px_rgba(245,158,11,0.5)]' : 'bg-cyan-500 ring-cyan-500/20 shadow-[0_0_10px_rgba(6,182,212,0.5)]'}
            `} />
            <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-cyan-500/30 to-transparent" />

            <div className="ml-2">
                <div
                    className={`
                        border rounded-lg overflow-hidden transition-all duration-300 ease-in-out
                        ${isExpanded ? 'bg-[#0d1117] border-cyan-500/30 shadow-lg shadow-cyan-900/10' : 'bg-[#0d1117]/50 border-white/5 hover:border-cyan-500/20 hover:bg-[#0d1117]'}
                    `}
                >
                    {/* Header / Summary */}
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-white/5 transition-colors"
                    >
                        <div className={`p-1 rounded-md ${isWarning ? 'bg-amber-500/10 text-amber-400' : 'bg-cyan-500/10 text-cyan-400'}`}>
                            {command ? <Terminal size={12} /> : <Command size={12} />}
                        </div>

                        <div className="flex-1 min-w-0 flex flex-col">
                            <span className="text-xs font-semibold text-cyan-300 truncate font-mono tracking-tight" title={command}>
                                {command ? `$ ${command.length > 50 ? command.slice(0, 50) + '...' : command}` : toolName === 'Tool Execution' ? 'Thinking...' : toolName}
                            </span>
                            {!isExpanded && (
                                <span className="text-[10px] text-zinc-400 truncate animate-in fade-in duration-300">
                                    {/* Strip markdown formatting for preview */}
                                    {content.replace(/\*\*/g, '').replace(/`/g, '').slice(0, 60)}{content.length > 60 && '...'}
                                </span>
                            )}
                        </div>

                        {/* Recipe Saved Badge */}
                        {isRecipeSaved && (
                            <div className="flex items-center gap-1 bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded text-[10px] font-bold tracking-wide uppercase border border-purple-500/30 animate-pulse">
                                <Sparkles size={10} />
                                Recipe Saved
                            </div>
                        )}

                        <div className="flex items-center gap-2 shrink-0">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold tracking-wider
                                ${isWarning ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}
                             `}>
                                {isWarning ? 'WARN' : 'DONE'}
                            </span>
                            <ChevronDown
                                size={12}
                                className={`text-zinc-500 transition-transform duration-300 ${isExpanded ? 'rotate-180' : 'rotate-0'}`}
                            />
                        </div>
                    </button>

                    {/* Content Body (Collapsible) */}
                    <div
                        className={`
                            overflow-hidden transition-[max-height,opacity] duration-300 ease-in-out
                            ${isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}
                        `}
                    >
                        <div className="px-3 pb-3 pt-0 overflow-x-auto text-xs">
                            <div className="h-px w-full bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent mb-2" />

                            {/* Command Label (if exists) */}
                            {command && (
                                <div className="mb-2">
                                    <div className="flex items-center gap-2 mb-1">
                                        <Terminal size={10} className="text-cyan-400" />
                                        <span className="text-[10px] font-semibold text-cyan-400 uppercase tracking-wider">Command</span>
                                    </div>
                                    <div className="font-mono text-[11px] bg-black/60 text-cyan-200 p-2 rounded border border-cyan-500/20">
                                        $ {command}
                                    </div>
                                </div>
                            )}

                            {/* Result Label */}
                            <div className="mb-1">
                                <div className="flex items-center gap-2">
                                    <CheckCircle2 size={10} className={isWarning ? "text-amber-400" : "text-emerald-400"} />
                                    <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                                        {isWarning ? 'Error Output' : 'Result'}
                                    </span>
                                </div>
                            </div>

                            {/* Use ReactMarkdown for better formatting */}
                            <div className="font-mono text-[11px] leading-relaxed text-zinc-300 p-2 rounded bg-black/40 shadow-inner border border-white/5">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        p: ({ children }) => <p className="my-1">{children}</p>,
                                        strong: ({ children }) => <strong className="text-white font-bold">{children}</strong>,
                                        code: ({ children }) => <code className="text-cyan-300">{children}</code>,
                                        pre: ({ children }) => <pre className="whitespace-pre-wrap">{children}</pre>,
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
    );
};
