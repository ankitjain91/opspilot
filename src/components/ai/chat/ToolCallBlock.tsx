import React, { useState } from 'react';
import {
    ChevronDown,
    ChevronUp,
    Copy,
    Check,
    Loader2,
    FileText,
    Edit3,
    Terminal,
    Search,
    Globe,
    Cpu,
    ListTodo,
    FolderSearch,
    FileCode,
    CheckCircle2,
    XCircle
} from 'lucide-react';
import type { ParsedBlock, BlockStatus } from '../claudeParser';

interface ToolCallBlockProps {
    block: ParsedBlock;
    defaultExpanded?: boolean;
}

// Icon mapping for tool types
const TOOL_ICONS: Record<string, React.ReactNode> = {
    'Read': <FileText size={14} />,
    'Write': <FileCode size={14} />,
    'Edit': <Edit3 size={14} />,
    'Bash': <Terminal size={14} />,
    'Glob': <FolderSearch size={14} />,
    'Grep': <Search size={14} />,
    'Task': <Cpu size={14} />,
    'WebFetch': <Globe size={14} />,
    'WebSearch': <Search size={14} />,
    'TodoWrite': <ListTodo size={14} />,
    'Tool': <Terminal size={14} />,
};

// Status colors
const STATUS_COLORS: Record<BlockStatus, string> = {
    'running': 'border-violet-500/40 bg-violet-500/5',
    'success': 'border-emerald-500/30 bg-emerald-500/5',
    'error': 'border-red-500/30 bg-red-500/5',
    'pending': 'border-zinc-700/50 bg-zinc-800/30',
};

const STATUS_TEXT_COLORS: Record<BlockStatus, string> = {
    'running': 'text-violet-400',
    'success': 'text-emerald-400',
    'error': 'text-red-400',
    'pending': 'text-zinc-400',
};

export function ToolCallBlock({ block, defaultExpanded = false }: ToolCallBlockProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded || block.isStreaming);
    const [copied, setCopied] = useState(false);

    const status = block.status || 'pending';
    const toolName = block.toolName || 'Tool';
    const icon = TOOL_ICONS[toolName] || TOOL_ICONS['Tool'];

    // Auto-collapse on success
    React.useEffect(() => {
        if (status === 'success' && !defaultExpanded) {
            // Small delay to let user see "check" state before collapsing
            const timer = setTimeout(() => setIsExpanded(false), 1500);
            return () => clearTimeout(timer);
        }
    }, [status, defaultExpanded]);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(block.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const lines = block.content.split('\n');
    const hasMultipleLines = lines.length > 3;

    return (
        <div className={`my-2 rounded-lg border overflow-hidden transition-all duration-200 ${STATUS_COLORS[status]}`}>
            {/* Header */}
            <div
                className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-2.5 min-w-0">
                    {/* Status indicator */}
                    <div className={`p-1.5 rounded-md ${status === 'running' ? 'bg-violet-500/20' :
                            status === 'success' ? 'bg-emerald-500/20' :
                                status === 'error' ? 'bg-red-500/20' :
                                    'bg-zinc-700/50'
                        }`}>
                        {status === 'running' ? (
                            <Loader2 size={14} className="text-violet-400 animate-spin" />
                        ) : status === 'success' ? (
                            <CheckCircle2 size={14} className="text-emerald-400" />
                        ) : status === 'error' ? (
                            <XCircle size={14} className="text-red-400" />
                        ) : (
                            <span className={STATUS_TEXT_COLORS[status]}>{icon}</span>
                        )}
                    </div>

                    {/* Tool name and file path */}
                    <div className="flex flex-col min-w-0">
                        <span className={`text-xs font-medium ${STATUS_TEXT_COLORS[status]}`}>
                            {toolName}
                        </span>
                        {block.filePath && (
                            <span className="text-[10px] text-zinc-500 truncate max-w-[300px]" title={block.filePath}>
                                {block.filePath}
                            </span>
                        )}
                    </div>

                    {/* Running indicator */}
                    {status === 'running' && (
                        <span className="text-[10px] text-violet-400 animate-pulse ml-2">
                            Running...
                        </span>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={handleCopy}
                        className="p-1.5 rounded hover:bg-zinc-700/50 transition-colors"
                        title="Copy to clipboard"
                    >
                        {copied ? (
                            <Check size={12} className="text-emerald-400" />
                        ) : (
                            <Copy size={12} className="text-zinc-500 hover:text-zinc-300" />
                        )}
                    </button>
                    {hasMultipleLines && (
                        isExpanded ? (
                            <ChevronUp size={14} className="text-zinc-500" />
                        ) : (
                            <ChevronDown size={14} className="text-zinc-500" />
                        )
                    )}
                </div>
            </div>

            {/* Content */}
            {(isExpanded || !hasMultipleLines) && block.content && (
                <div className="border-t border-white/5">
                    <pre className="p-3 text-xs font-mono text-zinc-300 overflow-x-auto max-h-80 whitespace-pre-wrap leading-relaxed">
                        {block.content}
                    </pre>
                </div>
            )}

            {/* Collapsed preview */}
            {!isExpanded && hasMultipleLines && (
                <div className="px-3 pb-2">
                    <span className="text-[10px] text-zinc-500">
                        {lines.length} lines • Click to expand
                    </span>
                </div>
            )}
        </div>
    );
}
