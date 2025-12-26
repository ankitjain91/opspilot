import React, { useState, useMemo, useEffect } from 'react';
import { Search, AlertCircle, ArrowDown, ArrowUp, Filter, Download } from 'lucide-react';

interface SmartLogViewerProps {
    logs: string;
    fileName?: string;
}

export function SmartLogViewer({ logs, fileName = 'container.log' }: SmartLogViewerProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [showErrorsOnly, setShowErrorsOnly] = useState(false);
    const [matches, setMatches] = useState<number[]>([]);
    const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

    const logLines = useMemo(() => logs.split('\n'), [logs]);

    // Derived filtered lines
    const processedLines = useMemo(() => {
        let lines = logLines.map((line, index) => ({ content: line, index }));

        if (showErrorsOnly) {
            lines = lines.filter(l =>
                l.content.toLowerCase().includes('error') ||
                l.content.toLowerCase().includes('fail') ||
                l.content.toLowerCase().includes('panic') ||
                l.content.toLowerCase().includes('exception')
            );
        }

        return lines;
    }, [logLines, showErrorsOnly]);

    // Search logic
    useEffect(() => {
        if (!searchTerm) {
            setMatches([]);
            return;
        }

        const newMatches: number[] = [];
        processedLines.forEach((line, i) => {
            if (line.content.toLowerCase().includes(searchTerm.toLowerCase())) {
                newMatches.push(i);
            }
        });
        setMatches(newMatches);
        setCurrentMatchIndex(0);
    }, [searchTerm, processedLines]);

    const scrollToMatch = (direction: 'next' | 'prev') => {
        if (matches.length === 0) return;

        let newIndex = direction === 'next' ? currentMatchIndex + 1 : currentMatchIndex - 1;
        if (newIndex >= matches.length) newIndex = 0;
        if (newIndex < 0) newIndex = matches.length - 1;

        setCurrentMatchIndex(newIndex);

        const rowId = `log-row-${matches[newIndex]}`;
        const element = document.getElementById(rowId);
        element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] rounded-lg overflow-hidden border border-white/10">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-white/5">
                <div className="flex items-center gap-4">
                    <span className="text-xs font-mono text-zinc-400">{fileName}</span>
                    <div className="h-4 w-[1px] bg-white/10" />
                    <div className="flex items-center gap-2 bg-zinc-900 rounded-md px-2 py-1 border border-white/10">
                        <Search size={14} className="text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Find..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="bg-transparent border-none outline-none text-xs text-white w-32 focus:w-48 transition-all"
                        />
                        {matches.length > 0 && (
                            <span className="text-[10px] text-zinc-500">
                                {currentMatchIndex + 1}/{matches.length}
                            </span>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowErrorsOnly(!showErrorsOnly)}
                        className={`p-1.5 rounded transition-colors ${showErrorsOnly ? 'bg-red-500/20 text-red-400' : 'text-zinc-400 hover:bg-white/5'}`}
                        title="Show Errors Only"
                    >
                        <AlertCircle size={16} />
                    </button>
                    <div className="h-4 w-[1px] bg-white/10" />
                    <button onClick={() => scrollToMatch('prev')} className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 rounded">
                        <ArrowUp size={16} />
                    </button>
                    <button onClick={() => scrollToMatch('next')} className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 rounded">
                        <ArrowDown size={16} />
                    </button>
                </div>
            </div>

            {/* Log Content */}
            <div className="flex-1 overflow-auto custom-scrollbar relative font-mono text-xs">
                {processedLines.length > 0 ? (
                    <div className="p-4">
                        {processedLines.map((line, relativeIndex) => {
                            const isSearchMatch = searchTerm && line.content.toLowerCase().includes(searchTerm.toLowerCase());
                            const isError = line.content.toLowerCase().includes('error') || line.content.toLowerCase().includes('fail');
                            const isCurrentMatch = matches[currentMatchIndex] === relativeIndex;

                            return (
                                <div
                                    key={line.index}
                                    id={`log-row-${relativeIndex}`}
                                    className={`flex gap-4 hover:bg-white/5 px-2 py-0.5 rounded ${isCurrentMatch ? 'bg-yellow-500/20' : ''
                                        }`}
                                >
                                    <span className="text-zinc-600 select-none w-8 text-right shrink-0">{line.index + 1}</span>
                                    <span className={`break-all ${isError ? 'text-red-400' :
                                        isSearchMatch ? 'text-yellow-200 bg-yellow-900/30' :
                                            'text-zinc-300'
                                        }`}>
                                        {line.content}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="flex items-center justify-center h-full text-zinc-500">
                        No logs match your filter
                    </div>
                )}
            </div>
        </div>
    );
}
