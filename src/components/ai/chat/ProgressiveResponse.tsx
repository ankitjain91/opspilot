/**
 * ProgressiveResponse - Streams investigation chunks in real-time
 *
 * Shows response sections progressively as they're discovered:
 * - Initial assessment
 * - Hypotheses as they're tested
 * - Evidence as collected
 * - Final synthesis
 *
 * This creates a much better UX than waiting for the full response.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    Brain,
    CheckCircle2,
    AlertTriangle,
    Lightbulb,
    Search,
    Target,
    FileText,
    Sparkles,
    ChevronDown,
    ChevronRight
} from 'lucide-react';

// Types for progressive chunks
export type ChunkType =
    | 'assessment'      // Initial assessment
    | 'hypothesis'      // Hypothesis being tested
    | 'evidence'        // Evidence collected
    | 'command'         // Command executed
    | 'insight'         // Intermediate insight
    | 'section'         // Named section
    | 'progress'        // Progress update
    | 'synthesis'       // Final synthesis
    | 'conclusion';     // Final conclusion

export interface ResponseChunk {
    type: ChunkType;
    id: string;
    content: string;
    title?: string;
    metadata?: {
        confidence?: number;
        status?: 'testing' | 'confirmed' | 'refuted';
        command?: string;
        output?: string;
        timestamp?: number;
    };
}

interface ProgressiveResponseProps {
    chunks: ResponseChunk[];
    isStreaming?: boolean;
    className?: string;
}

// Chunk renderer based on type
const ChunkRenderer: React.FC<{ chunk: ResponseChunk; isLatest: boolean }> = ({ chunk, isLatest }) => {
    const [isExpanded, setIsExpanded] = useState(true);

    // Auto-collapse older command chunks
    useEffect(() => {
        if (chunk.type === 'command' && !isLatest) {
            const timer = setTimeout(() => setIsExpanded(false), 2000);
            return () => clearTimeout(timer);
        }
    }, [chunk.type, isLatest]);

    const getIcon = () => {
        switch (chunk.type) {
            case 'assessment':
                return <Search size={14} className="text-violet-400" />;
            case 'hypothesis':
                return <Target size={14} className="text-amber-400" />;
            case 'evidence':
                return <FileText size={14} className="text-cyan-400" />;
            case 'command':
                return <div className="w-3 h-3 rounded-full bg-emerald-500" />;
            case 'insight':
                return <Lightbulb size={14} className="text-yellow-400" />;
            case 'synthesis':
                return <Brain size={14} className="text-violet-400" />;
            case 'conclusion':
                return <CheckCircle2 size={14} className="text-emerald-400" />;
            default:
                return <Sparkles size={14} className="text-zinc-400" />;
        }
    };

    const getBorderColor = () => {
        switch (chunk.type) {
            case 'assessment':
                return 'border-violet-500/30';
            case 'hypothesis':
                return chunk.metadata?.status === 'confirmed' ? 'border-emerald-500/30' :
                    chunk.metadata?.status === 'refuted' ? 'border-red-500/30' :
                        'border-amber-500/30';
            case 'evidence':
                return 'border-cyan-500/30';
            case 'command':
                return 'border-emerald-500/30';
            case 'synthesis':
            case 'conclusion':
                return 'border-violet-500/30';
            default:
                return 'border-zinc-700/50';
        }
    };

    const getHeaderBg = () => {
        switch (chunk.type) {
            case 'assessment':
                return 'bg-violet-500/10';
            case 'hypothesis':
                return 'bg-amber-500/10';
            case 'evidence':
                return 'bg-cyan-500/10';
            case 'command':
                return 'bg-emerald-500/10';
            case 'synthesis':
            case 'conclusion':
                return 'bg-violet-500/10';
            default:
                return 'bg-zinc-800/50';
        }
    };

    // Command chunks get special treatment
    if (chunk.type === 'command') {
        return (
            <div className={`rounded-lg border ${getBorderColor()} overflow-hidden transition-all duration-300 ${isLatest ? 'animate-in fade-in slide-in-from-bottom-2' : ''}`}>
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className={`w-full px-3 py-2 ${getHeaderBg()} flex items-center gap-2 text-left hover:bg-emerald-500/15 transition-colors`}
                >
                    {getIcon()}
                    <code className="text-[11px] font-mono text-emerald-300 flex-1 truncate">
                        $ {chunk.metadata?.command || chunk.content}
                    </code>
                    {isExpanded ? <ChevronDown size={12} className="text-zinc-500" /> : <ChevronRight size={12} className="text-zinc-500" />}
                </button>
                {isExpanded && chunk.metadata?.output && (
                    <div className="px-3 py-2 bg-black/30 border-t border-emerald-500/20">
                        <pre className="text-[10px] font-mono text-zinc-400 whitespace-pre-wrap max-h-32 overflow-y-auto">
                            {chunk.metadata.output.slice(0, 500)}
                            {chunk.metadata.output.length > 500 && '...'}
                        </pre>
                    </div>
                )}
            </div>
        );
    }

    // Hypothesis chunks show confidence
    if (chunk.type === 'hypothesis') {
        const confidence = chunk.metadata?.confidence ?? 0.5;
        const status = chunk.metadata?.status || 'testing';

        return (
            <div className={`rounded-lg border ${getBorderColor()} overflow-hidden ${isLatest ? 'animate-in fade-in slide-in-from-bottom-2' : ''}`}>
                <div className={`px-3 py-2 ${getHeaderBg()} flex items-center gap-2`}>
                    {getIcon()}
                    <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider">Hypothesis</span>
                    <div className="ml-auto flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className={`h-full transition-all duration-500 ${status === 'confirmed' ? 'bg-emerald-500' :
                                        status === 'refuted' ? 'bg-red-500' : 'bg-amber-500'
                                    }`}
                                style={{ width: `${confidence * 100}%` }}
                            />
                        </div>
                        <span className="text-[9px] text-zinc-500 font-mono">
                            {Math.round(confidence * 100)}%
                        </span>
                    </div>
                </div>
                <div className="px-3 py-2">
                    <p className={`text-[12px] leading-relaxed ${status === 'refuted' ? 'text-zinc-500 line-through' : 'text-zinc-300'
                        }`}>
                        {chunk.content}
                    </p>
                </div>
            </div>
        );
    }

    // Evidence chunks
    if (chunk.type === 'evidence') {
        return (
            <div className={`rounded-lg border ${getBorderColor()} overflow-hidden ${isLatest ? 'animate-in fade-in slide-in-from-bottom-2' : ''}`}>
                <div className={`px-3 py-2 ${getHeaderBg()} flex items-center gap-2`}>
                    {getIcon()}
                    <span className="text-[10px] font-bold text-cyan-300 uppercase tracking-wider">Evidence</span>
                </div>
                <div className="px-3 py-2">
                    <p className="text-[12px] text-cyan-200 leading-relaxed">{chunk.content}</p>
                </div>
            </div>
        );
    }

    // Synthesis/Conclusion chunks (larger, more prominent)
    if (chunk.type === 'synthesis' || chunk.type === 'conclusion') {
        return (
            <div className={`rounded-xl border-2 ${getBorderColor()} overflow-hidden shadow-lg ${isLatest ? 'animate-in fade-in slide-in-from-bottom-3' : ''}`}>
                <div className={`px-4 py-3 ${getHeaderBg()} flex items-center gap-2 border-b border-violet-500/20`}>
                    {getIcon()}
                    <span className="text-xs font-bold text-violet-300 uppercase tracking-wider">
                        {chunk.type === 'conclusion' ? 'Conclusion' : 'Analysis'}
                    </span>
                    {chunk.type === 'conclusion' && (
                        <Sparkles size={12} className="ml-auto text-violet-400 animate-pulse" />
                    )}
                </div>
                <div className="px-4 py-3 prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            p: ({ children }) => <p className="text-[13px] text-zinc-300 my-2 leading-relaxed">{children}</p>,
                            strong: ({ children }) => <strong className="text-white font-bold">{children}</strong>,
                            code: ({ children }) => <code className="text-[11px] bg-white/5 px-1.5 py-0.5 rounded text-emerald-400 font-mono">{children}</code>,
                            ul: ({ children }) => <ul className="text-[12px] list-none ml-0 my-2 space-y-1.5">{children}</ul>,
                            li: ({ children }) => (
                                <li className="text-zinc-300 flex items-start gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-violet-500 mt-1.5 shrink-0" />
                                    <span>{children}</span>
                                </li>
                            ),
                        }}
                    >
                        {chunk.content}
                    </ReactMarkdown>
                </div>
            </div>
        );
    }

    // Default/Section/Assessment/Insight chunks
    return (
        <div className={`rounded-lg border ${getBorderColor()} overflow-hidden ${isLatest ? 'animate-in fade-in slide-in-from-bottom-2' : ''}`}>
            {chunk.title && (
                <div className={`px-3 py-2 ${getHeaderBg()} flex items-center gap-2`}>
                    {getIcon()}
                    <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-wider">{chunk.title}</span>
                </div>
            )}
            <div className="px-3 py-2">
                <p className="text-[12px] text-zinc-300 leading-relaxed">{chunk.content}</p>
            </div>
        </div>
    );
};

export const ProgressiveResponse: React.FC<ProgressiveResponseProps> = ({
    chunks,
    isStreaming = false,
    className = ''
}) => {
    // Group chunks by phase for better organization
    const groupedChunks = useMemo(() => {
        const groups: { phase: string; chunks: ResponseChunk[] }[] = [];
        let currentPhase = 'investigation';

        for (const chunk of chunks) {
            // Determine phase based on chunk type
            const phase = chunk.type === 'assessment' ? 'assessment' :
                chunk.type === 'synthesis' || chunk.type === 'conclusion' ? 'synthesis' :
                    'investigation';

            // Find or create group
            let group = groups.find(g => g.phase === phase);
            if (!group) {
                group = { phase, chunks: [] };
                groups.push(group);
            }
            group.chunks.push(chunk);
        }

        return groups;
    }, [chunks]);

    if (chunks.length === 0 && !isStreaming) {
        return null;
    }

    return (
        <div className={`space-y-3 ${className}`}>
            {/* Phase groups */}
            {groupedChunks.map((group, groupIdx) => (
                <div key={group.phase} className="space-y-2">
                    {/* Phase header */}
                    {group.phase !== 'investigation' && (
                        <div className="flex items-center gap-2 px-1">
                            <div className={`h-px flex-1 ${group.phase === 'synthesis' ? 'bg-gradient-to-r from-transparent via-violet-500/50 to-transparent' :
                                    'bg-gradient-to-r from-transparent via-zinc-700 to-transparent'
                                }`} />
                        </div>
                    )}

                    {/* Chunks */}
                    {group.chunks.map((chunk, idx) => (
                        <ChunkRenderer
                            key={chunk.id}
                            chunk={chunk}
                            isLatest={groupIdx === groupedChunks.length - 1 && idx === group.chunks.length - 1}
                        />
                    ))}
                </div>
            ))}

            {/* Streaming indicator */}
            {isStreaming && (
                <div className="flex items-center gap-2 px-2 py-2 text-cyan-400 animate-pulse">
                    <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <span className="text-[11px] font-medium">Analyzing...</span>
                </div>
            )}
        </div>
    );
};

export default ProgressiveResponse;
