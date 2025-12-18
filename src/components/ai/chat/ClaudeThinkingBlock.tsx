import React, { useState, useEffect } from 'react';
import {
    ChevronDown,
    ChevronUp,
    Brain,
    Loader2
} from 'lucide-react';
import type { ParsedBlock } from '../claudeParser';

interface ClaudeThinkingBlockProps {
    block: ParsedBlock;
    autoCollapse?: boolean;
}

export function ClaudeThinkingBlock({ block, autoCollapse = true }: ClaudeThinkingBlockProps) {
    const [isExpanded, setIsExpanded] = useState(!autoCollapse || block.isStreaming);

    // Auto-collapse when streaming ends
    useEffect(() => {
        if (autoCollapse && !block.isStreaming && isExpanded) {
            const timer = setTimeout(() => setIsExpanded(false), 500);
            return () => clearTimeout(timer);
        }
    }, [block.isStreaming, autoCollapse]);

    const lines = block.content.split('\n');
    const preview = lines[0].slice(0, 80) + (lines[0].length > 80 ? '...' : '');

    return (
        <div className={`my-2 rounded-lg border overflow-hidden transition-all duration-300 ${
            block.isStreaming
                ? 'border-violet-500/30 bg-violet-500/5'
                : 'border-zinc-800 bg-zinc-900/30'
        }`}>
            {/* Header */}
            <div
                className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <div className={`p-1.5 rounded-md ${
                        block.isStreaming ? 'bg-violet-500/20' : 'bg-zinc-800'
                    }`}>
                        {block.isStreaming ? (
                            <Loader2 size={14} className="text-violet-400 animate-spin" />
                        ) : (
                            <Brain size={14} className="text-zinc-500" />
                        )}
                    </div>
                    <div className="flex flex-col min-w-0">
                        <span className={`text-xs font-medium ${
                            block.isStreaming ? 'text-violet-300' : 'text-zinc-500'
                        }`}>
                            Thinking
                        </span>
                        {!isExpanded && (
                            <span className="text-[10px] text-zinc-600 truncate max-w-[300px]">
                                {preview}
                            </span>
                        )}
                    </div>
                    {block.isStreaming && (
                        <span className="text-[10px] text-violet-400 animate-pulse ml-2">
                            ...
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    <span className="text-[10px] text-zinc-600">
                        {lines.length} lines
                    </span>
                    {isExpanded ? (
                        <ChevronUp size={14} className="text-zinc-600" />
                    ) : (
                        <ChevronDown size={14} className="text-zinc-600" />
                    )}
                </div>
            </div>

            {/* Content */}
            {isExpanded && (
                <div className="border-t border-zinc-800/50">
                    <div className="p-3 text-xs text-zinc-500 leading-relaxed max-h-60 overflow-y-auto">
                        {block.content}
                        {block.isStreaming && (
                            <span className="inline-block w-1.5 h-3 bg-violet-400/70 animate-pulse ml-0.5" />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
