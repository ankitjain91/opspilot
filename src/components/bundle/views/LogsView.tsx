/**
 * LogsView - Pod logs browser with filtering and search
 */

import { useState, useMemo, useCallback } from 'react';
import { FileText, Search, Download, ChevronRight, Folder, File, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useBundleContext } from '../BundleContext';
import { BundleLogFile } from '../types';

interface LogsByNamespace {
    [namespace: string]: {
        [pod: string]: BundleLogFile[];
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LogsView() {
    const { bundle, logs, selectedNamespace } = useBundleContext();
    const [search, setSearch] = useState('');
    const [expandedNs, setExpandedNs] = useState<string | null>(null);
    const [expandedPod, setExpandedPod] = useState<string | null>(null);
    const [selectedLog, setSelectedLog] = useState<BundleLogFile | null>(null);
    const [logContent, setLogContent] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [logSearch, setLogSearch] = useState('');

    const logsByNamespace = useMemo(() => {
        const result: LogsByNamespace = {};

        logs.forEach(log => {
            if (selectedNamespace && log.namespace !== selectedNamespace) return;
            if (search) {
                const q = search.toLowerCase();
                if (!log.namespace.toLowerCase().includes(q) &&
                    !log.pod.toLowerCase().includes(q) &&
                    !log.container.toLowerCase().includes(q)) {
                    return;
                }
            }

            if (!result[log.namespace]) result[log.namespace] = {};
            if (!result[log.namespace][log.pod]) result[log.namespace][log.pod] = [];
            result[log.namespace][log.pod].push(log);
        });

        return result;
    }, [logs, selectedNamespace, search]);

    const loadLog = useCallback(async (log: BundleLogFile) => {
        if (!bundle) return;
        setSelectedLog(log);
        setLoading(true);
        setLogContent(null);

        try {
            const content = await invoke<string>('read_bundle_log', {
                bundlePath: bundle.path,
                logPath: log.file_path
            });
            setLogContent(content);
        } catch (err) {
            setLogContent(`Error loading log: ${err}`);
        } finally {
            setLoading(false);
        }
    }, [bundle]);

    const highlightedContent = useMemo(() => {
        if (!logContent || !logSearch) return logContent;

        const lines = logContent.split('\n');
        const q = logSearch.toLowerCase();
        return lines.filter(line => line.toLowerCase().includes(q)).join('\n');
    }, [logContent, logSearch]);

    const namespaceEntries = Object.entries(logsByNamespace).sort((a, b) => a[0].localeCompare(b[0]));

    return (
        <div className="flex h-full">
            {/* Left Panel - Log Browser */}
            <div className="w-80 border-r border-zinc-800 flex flex-col">
                <div className="p-4 border-b border-zinc-800">
                    <h2 className="text-lg font-semibold text-white">Logs</h2>
                    <p className="text-xs text-zinc-500">{logs.length} log files</p>
                    <div className="relative mt-3">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Filter logs..."
                            className="w-full pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-auto p-2 space-y-1">
                    {namespaceEntries.map(([ns, pods]) => {
                        const isNsExpanded = expandedNs === ns;
                        const podEntries = Object.entries(pods).sort((a, b) => a[0].localeCompare(b[0]));
                        const totalLogs = podEntries.reduce((acc, [, logs]) => acc + logs.length, 0);

                        return (
                            <div key={ns}>
                                <button
                                    onClick={() => setExpandedNs(isNsExpanded ? null : ns)}
                                    className="w-full flex items-center gap-2 p-2 rounded hover:bg-zinc-800 text-left transition-colors"
                                >
                                    <ChevronRight
                                        size={14}
                                        className={`text-zinc-500 transition-transform ${isNsExpanded ? 'rotate-90' : ''}`}
                                    />
                                    <Folder size={14} className="text-purple-400" />
                                    <span className="text-sm text-zinc-300 flex-1 truncate">{ns}</span>
                                    <span className="text-[10px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded">
                                        {totalLogs}
                                    </span>
                                </button>

                                {isNsExpanded && (
                                    <div className="ml-4 space-y-0.5">
                                        {podEntries.map(([pod, logFiles]) => {
                                            const isPodExpanded = expandedPod === `${ns}/${pod}`;

                                            return (
                                                <div key={pod}>
                                                    <button
                                                        onClick={() => setExpandedPod(isPodExpanded ? null : `${ns}/${pod}`)}
                                                        className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-zinc-800/50 text-left transition-colors"
                                                    >
                                                        <ChevronRight
                                                            size={12}
                                                            className={`text-zinc-600 transition-transform ${isPodExpanded ? 'rotate-90' : ''}`}
                                                        />
                                                        <FileText size={12} className="text-blue-400" />
                                                        <span className="text-xs text-zinc-400 flex-1 truncate">{pod}</span>
                                                        <span className="text-[10px] text-zinc-600">
                                                            {logFiles.length}
                                                        </span>
                                                    </button>

                                                    {isPodExpanded && (
                                                        <div className="ml-6 space-y-0.5">
                                                            {logFiles.map(log => (
                                                                <button
                                                                    key={log.file_path}
                                                                    onClick={() => loadLog(log)}
                                                                    className={`w-full flex items-center gap-2 p-1.5 rounded text-left transition-colors ${
                                                                        selectedLog?.file_path === log.file_path
                                                                            ? 'bg-purple-500/20 text-purple-300'
                                                                            : 'hover:bg-zinc-800/30 text-zinc-500'
                                                                    }`}
                                                                >
                                                                    <File size={10} />
                                                                    <span className="text-[11px] flex-1 truncate">
                                                                        {log.container}
                                                                    </span>
                                                                    <span className="text-[10px] text-zinc-600">
                                                                        {formatBytes(log.size_bytes)}
                                                                    </span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {namespaceEntries.length === 0 && (
                        <div className="text-center py-8 text-zinc-600 text-sm">
                            No logs found
                        </div>
                    )}
                </div>
            </div>

            {/* Right Panel - Log Viewer */}
            <div className="flex-1 flex flex-col">
                {selectedLog ? (
                    <>
                        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                            <div>
                                <div className="text-sm font-medium text-white">
                                    {selectedLog.pod} / {selectedLog.container}
                                </div>
                                <div className="text-xs text-zinc-500">
                                    {selectedLog.namespace} • {formatBytes(selectedLog.size_bytes)}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="relative">
                                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                                    <input
                                        type="text"
                                        value={logSearch}
                                        onChange={e => setLogSearch(e.target.value)}
                                        placeholder="Search in log..."
                                        className="pl-9 pr-4 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500 w-48"
                                    />
                                </div>
                                <button
                                    onClick={() => loadLog(selectedLog)}
                                    className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
                                    title="Reload"
                                >
                                    <RefreshCw size={14} />
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-auto bg-zinc-950 p-4">
                            {loading ? (
                                <div className="flex items-center justify-center h-full text-zinc-500">
                                    <RefreshCw size={20} className="animate-spin mr-2" />
                                    Loading log...
                                </div>
                            ) : (
                                <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap break-all">
                                    {highlightedContent || logContent}
                                </pre>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-zinc-600">
                        <div className="text-center">
                            <FileText size={48} className="mx-auto mb-4 opacity-30" />
                            <div className="text-sm">Select a log file to view</div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
