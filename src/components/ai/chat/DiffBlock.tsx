import React, { useState, useMemo } from 'react';
import {
    ChevronDown,
    ChevronUp,
    Copy,
    Check,
    FileDiff,
    Plus,
    Minus,
    FileText
} from 'lucide-react';
import type { ParsedBlock } from '../claudeParser';

interface DiffBlockProps {
    block: ParsedBlock;
    defaultExpanded?: boolean;
}

interface DiffLine {
    type: 'add' | 'remove' | 'context' | 'header';
    content: string;
    lineNumber?: number;
}

function parseDiffLines(content: string): DiffLine[] {
    const lines = content.split('\n');
    const result: DiffLine[] = [];
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
        if (line.startsWith('@@')) {
            // Parse hunk header: @@ -start,count +start,count @@
            const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match) {
                oldLineNum = parseInt(match[1], 10) - 1;
                newLineNum = parseInt(match[2], 10) - 1;
            }
            result.push({ type: 'header', content: line });
        } else if (line.startsWith('---') || line.startsWith('+++')) {
            result.push({ type: 'header', content: line });
        } else if (line.startsWith('+')) {
            newLineNum++;
            result.push({ type: 'add', content: line.slice(1), lineNumber: newLineNum });
        } else if (line.startsWith('-')) {
            oldLineNum++;
            result.push({ type: 'remove', content: line.slice(1), lineNumber: oldLineNum });
        } else {
            oldLineNum++;
            newLineNum++;
            result.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line, lineNumber: newLineNum });
        }
    }

    return result;
}

export function DiffBlock({ block, defaultExpanded = true }: DiffBlockProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const [copied, setCopied] = useState(false);

    const diffLines = useMemo(() => parseDiffLines(block.content), [block.content]);

    const stats = useMemo(() => {
        let additions = 0;
        let deletions = 0;
        for (const line of diffLines) {
            if (line.type === 'add') additions++;
            if (line.type === 'remove') deletions++;
        }
        return { additions, deletions };
    }, [diffLines]);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(block.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Extract file name from diff if possible
    const fileName = useMemo(() => {
        const lines = block.content.split('\n');
        for (const line of lines) {
            if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
                return line.replace('+++ b/', '').replace('+++ ', '');
            }
            if (line.startsWith('--- a/') || line.startsWith('--- ')) {
                return line.replace('--- a/', '').replace('--- ', '');
            }
        }
        return block.filePath || 'Diff';
    }, [block.content, block.filePath]);

    return (
        <div className="my-2 rounded-lg border border-zinc-700/50 overflow-hidden bg-[#0d0d11]">
            {/* Header */}
            <div
                className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 cursor-pointer hover:bg-zinc-800/70 transition-colors"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-2.5 min-w-0">
                    <div className="p-1.5 rounded-md bg-amber-500/20">
                        <FileDiff size={14} className="text-amber-400" />
                    </div>
                    <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-2">
                            <FileText size={12} className="text-zinc-500" />
                            <span className="text-xs font-medium text-zinc-300 truncate max-w-[250px]" title={fileName}>
                                {fileName}
                            </span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                            {stats.additions > 0 && (
                                <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                                    <Plus size={10} />
                                    {stats.additions}
                                </span>
                            )}
                            {stats.deletions > 0 && (
                                <span className="flex items-center gap-1 text-[10px] text-red-400">
                                    <Minus size={10} />
                                    {stats.deletions}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-1.5">
                    <button
                        onClick={handleCopy}
                        className="p-1.5 rounded hover:bg-zinc-700/50 transition-colors"
                        title="Copy diff"
                    >
                        {copied ? (
                            <Check size={12} className="text-emerald-400" />
                        ) : (
                            <Copy size={12} className="text-zinc-500 hover:text-zinc-300" />
                        )}
                    </button>
                    {isExpanded ? (
                        <ChevronUp size={14} className="text-zinc-500" />
                    ) : (
                        <ChevronDown size={14} className="text-zinc-500" />
                    )}
                </div>
            </div>

            {/* Diff content */}
            {isExpanded && (
                <div className="overflow-x-auto max-h-96">
                    <table className="w-full text-xs font-mono">
                        <tbody>
                            {diffLines.map((line, idx) => (
                                <tr
                                    key={idx}
                                    className={
                                        line.type === 'add' ? 'bg-emerald-500/10' :
                                        line.type === 'remove' ? 'bg-red-500/10' :
                                        line.type === 'header' ? 'bg-zinc-800/50' :
                                        ''
                                    }
                                >
                                    {/* Line number */}
                                    <td className="w-10 px-2 py-0.5 text-right text-zinc-600 select-none border-r border-zinc-800">
                                        {line.lineNumber || ''}
                                    </td>
                                    {/* Line indicator */}
                                    <td className="w-6 px-1 py-0.5 text-center select-none">
                                        {line.type === 'add' && <span className="text-emerald-400">+</span>}
                                        {line.type === 'remove' && <span className="text-red-400">-</span>}
                                    </td>
                                    {/* Content */}
                                    <td className={`px-2 py-0.5 whitespace-pre ${
                                        line.type === 'add' ? 'text-emerald-300' :
                                        line.type === 'remove' ? 'text-red-300' :
                                        line.type === 'header' ? 'text-cyan-400' :
                                        'text-zinc-400'
                                    }`}>
                                        {line.content}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
