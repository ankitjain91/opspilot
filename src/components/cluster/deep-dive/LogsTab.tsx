import React, { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    Play, Pause, Eraser, ArrowDown, Search, Loader2, Sparkles, FileText,
    Download, Copy, Check, WrapText
} from 'lucide-react';
import { useToast } from '../../ui/Toast';
import { K8sObject } from '../../../types/k8s';

interface LogsTabProps {
    resource: K8sObject;
    fullObject: any;
}

export function LogsTab({ resource, fullObject }: LogsTabProps) {
    const [container, setContainer] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [isStreaming, setIsStreaming] = useState(true);
    const [autoScroll, setAutoScroll] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [fontSize, setFontSize] = useState(12);
    const [lineWrap, setLineWrap] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [copied, setCopied] = useState(false);

    const { showToast } = useToast();
    const logsEndRef = useRef<HTMLDivElement>(null);
    const unlistenRef = useRef<(() => void) | null>(null);
    const sessionId = useMemo(() => `logs-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

    // Extract containers
    const spec = fullObject?.spec || {};
    const containers = spec.containers || [];
    const initContainers = spec.initContainers || [];
    const allContainers = [...containers, ...initContainers];

    // Auto-select first container or correct invalid selection
    useEffect(() => {
        if (allContainers.length > 0) {
            const isValid = allContainers.some((c: any) => c.name === container);
            if (!container || !isValid) {
                setContainer(allContainers[0].name);
            }
        }
    }, [allContainers, container]);

    // Filter logic
    const filteredLogs = logs.filter(line => !searchTerm || line.toLowerCase().includes(searchTerm.toLowerCase()));

    // Scroll logic
    useEffect(() => {
        if (autoScroll && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs, autoScroll, filteredLogs.length]);

    // Stream Start/Stop
    const startStream = async () => {
        // Double check validity before starting
        const isValid = allContainers.some((c: any) => c.name === container);
        if (!container || !isValid) return;

        setIsStreaming(true);
        try {
            await invoke("start_log_stream", {
                namespace: resource.namespace,
                name: resource.name,
                container,
                sessionId
            });
            const unlisten = await listen<string>(`log_stream:${sessionId}`, (event) => {
                setLogs(prev => [...prev, event.payload]);
            });
            unlistenRef.current = unlisten;
        } catch (err) {
            setLogs(prev => [...prev, `Error starting log stream: ${err}`]);
            setIsStreaming(false);
        }
    };

    const stopStream = async () => {
        if (unlistenRef.current) {
            unlistenRef.current();
            unlistenRef.current = null;
        }
        try { await invoke("stop_log_stream", { sessionId }); } catch { }
        setIsStreaming(false);
    };

    useEffect(() => {
        setLogs([]); // Clear on container switch
        if (container) startStream();
        return () => { stopStream(); };
    }, [container, resource.name]);

    // AI Analysis
    const analyzeLogs = async () => {
        if (logs.length === 0) return;
        setAnalyzing(true);
        try {
            const recentLogs = logs.slice(-50).join('\n');
            const analysis = await invoke<string>("analyze_text", {
                text: recentLogs,
                context: `Logs for ${resource.name}/${container}. Check for errors.`
            });
            setLogs(prev => [...prev, `\n--- 🤖 AI ANALYSIS ---\n${analysis}\n-------------------\n`]);
            setAutoScroll(true);
        } catch (err) {
            console.error(err);
        } finally {
            setAnalyzing(false);
        }
    };

    // Actions
    const handleDownload = () => {
        const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${resource.name}-${container}-${new Date().toISOString()}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("Logs downloaded manually", "success");
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(logs.join('\n'));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        showToast("Logs copied to clipboard", "success");
    };

    // Zoom Controls
    const zoomIn = () => setFontSize(prev => Math.min(prev + 2, 24));
    const zoomOut = () => setFontSize(prev => Math.max(prev - 2, 8));

    // Improved syntax highlighting
    const renderLogLine = (line: string, index: number) => {
        // Strip ANSI codes for cleaner rendering (simple regex)
        // eslint-disable-next-line no-control-regex
        const cleanLine = line.replace(/\x1B\[\d+m/g, '');

        let className = "leading-tight px-1 rounded border-l-2 border-transparent hover:border-zinc-500/50 hover:bg-white/5 ";
        let content: React.ReactNode = cleanLine;

        // Log Level Detection
        const lower = cleanLine.toLowerCase();
        if (lower.includes("error") || lower.includes("fatal") || lower.includes("exception") || lower.includes("level=error")) {
            className += "text-red-400 bg-red-500/5 ";
        } else if (lower.includes("warn") || lower.includes("warning") || lower.includes("level=warn")) {
            className += "text-yellow-400 bg-yellow-500/5 ";
        } else if (lower.includes("info") || lower.includes("level=info")) {
            className += "text-blue-300 ";
        } else if (lower.includes("debug") || lower.includes("level=debug")) {
            className += "text-zinc-500 ";
        } else {
            className += "text-zinc-300 ";
        }

        // Timestamp Dimming (Simple ISO 8601 or similar detection at start)
        const timestampRegex = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^ ]*)/;
        const match = cleanLine.match(timestampRegex);

        if (match) {
            const timestamp = match[1];
            const rest = cleanLine.substring(timestamp.length);
            content = (
                <>
                    <span className="text-zinc-600 select-none mr-2">{timestamp}</span>
                    <span>{rest}</span>
                </>
            );
        }

        return (
            <div key={index} className={className}>
                {content}
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e]">
            {/* Header / Controls */}
            <div className="flex items-center gap-2 p-2 px-3 bg-[#252526] border-b border-white/5 text-[10px]">
                {/* Container Selector */}
                <select
                    value={container}
                    onChange={e => setContainer(e.target.value)}
                    className="bg-black/20 border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500/50 mr-2 max-w-[120px]"
                >
                    {allContainers.map((c: any) => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                </select>

                <div className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                <span className={`font-medium uppercase tracking-wider hidden sm:inline ${isStreaming ? 'text-green-400' : 'text-yellow-400'}`}>
                    {isStreaming ? 'Live' : 'Paused'}
                </span>

                <div className="h-3 w-px bg-white/10 mx-1" />

                <button onClick={() => isStreaming ? stopStream() : startStream()} className="hover:text-white text-zinc-400 transition-colors" title={isStreaming ? "Pause" : "Resume"}>
                    {isStreaming ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button onClick={() => setLogs([])} className="hover:text-red-400 text-zinc-400 transition-colors" title="Clear Logs">
                    <Eraser size={14} />
                </button>
                <button onClick={() => setAutoScroll(!autoScroll)} className={`${autoScroll ? 'text-cyan-400' : 'text-zinc-400'} transition-colors`} title="Auto-scroll">
                    <ArrowDown size={14} />
                </button>

                <div className="h-3 w-px bg-white/10 mx-1" />

                <button onClick={zoomOut} className="hover:text-white text-zinc-400 transition-colors font-mono w-5 h-5 flex items-center justify-center rounded hover:bg-white/5" title="Zoom Out">A-</button>
                <button onClick={zoomIn} className="hover:text-white text-zinc-400 transition-colors font-mono w-5 h-5 flex items-center justify-center rounded hover:bg-white/5" title="Zoom In">A+</button>
                <button onClick={() => setLineWrap(!lineWrap)} className={`${lineWrap ? 'text-cyan-400 bg-cyan-500/10' : 'text-zinc-400 hover:bg-white/5'} p-0.5 rounded transition-colors`} title="Wrap Text">
                    <WrapText size={14} />
                </button>

                <div className="h-3 w-px bg-white/10 mx-1" />

                <button onClick={handleDownload} className="hover:text-white text-zinc-400 transition-colors" title="Download Logs">
                    <Download size={14} />
                </button>
                <button onClick={handleCopy} className="hover:text-white text-zinc-400 transition-colors" title="Copy All">
                    {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                </button>

                <div className="flex-1" />
                <div className="relative group">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        placeholder="Filter..."
                        className="bg-black/20 border border-white/5 rounded pl-7 pr-2 py-0.5 w-24 text-zinc-300 focus:w-40 transition-all focus:outline-none focus:border-cyan-500/50"
                    />
                </div>
                <button disabled={analyzing} onClick={analyzeLogs} className={`flex items-center gap-1.5 px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-all ${analyzing ? 'opacity-50' : ''}`}>
                    {analyzing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    <span className="hidden sm:inline">Analyze</span>
                </button>
            </div>

            {/* Log Content */}
            <div className="flex-1 overflow-auto bg-[#1e1e1e] p-2 font-mono scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-700"
                style={{ fontSize: `${fontSize}px` }}
                onScroll={(e) => {
                    const t = e.currentTarget;
                    if (t.scrollHeight - t.scrollTop - t.clientHeight > 50) setAutoScroll(false);
                    else setAutoScroll(true);
                }}
            >
                {filteredLogs.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-2">
                        <FileText size={24} className="opacity-20" />
                        <span className="text-xs">Waiting for logs from {container}...</span>
                    </div>
                ) : (
                    <div className={lineWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}>
                        {filteredLogs.map((line, i) => renderLogLine(line, i))}
                        <div ref={logsEndRef} />
                    </div>
                )}
            </div>
        </div>
    );
}
