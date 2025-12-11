import React, { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    Play, Pause, Eraser, ArrowDown, Search, Loader2, Sparkles, FileText
} from 'lucide-react';
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
    const [fontSize, setFontSize] = useState(11);
    const [lineWrap, setLineWrap] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);

    const logsEndRef = useRef<HTMLDivElement>(null);
    const unlistenRef = useRef<(() => void) | null>(null);
    const sessionId = useMemo(() => `logs-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

    // Extract containers
    const spec = fullObject?.spec || {};
    const containers = spec.containers || [];
    const initContainers = spec.initContainers || [];
    const allContainers = [...containers, ...initContainers];

    // Auto-select first container
    useEffect(() => {
        if (allContainers.length > 0 && !container) {
            setContainer(allContainers[0].name);
        }
    }, [allContainers]);

    // Filter logic
    const filteredLogs = logs.filter(line => !searchTerm || line.toLowerCase().includes(searchTerm.toLowerCase()));

    // Scroll logic
    useEffect(() => {
        if (autoScroll && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs, autoScroll]);

    // Stream Start/Stop
    const startStream = async () => {
        if (!container) return;
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

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e]">
            {/* Header / Controls */}
            <div className="flex items-center gap-2 p-2 px-3 bg-[#252526] border-b border-white/5 text-[10px]">
                {/* Container Selector */}
                <select
                    value={container}
                    onChange={e => setContainer(e.target.value)}
                    className="bg-black/20 border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500/50 mr-2"
                >
                    {allContainers.map((c: any) => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                </select>

                <div className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                <span className={`font-medium uppercase tracking-wider ${isStreaming ? 'text-green-400' : 'text-yellow-400'}`}>
                    {isStreaming ? 'Live' : 'Paused'}
                </span>

                <div className="h-3 w-px bg-white/10 mx-1" />

                <button onClick={() => isStreaming ? stopStream() : startStream()} className="hover:text-white text-zinc-400 transition-colors">
                    {isStreaming ? <Pause size={12} /> : <Play size={12} />}
                </button>
                <button onClick={() => setLogs([])} className="hover:text-red-400 text-zinc-400 transition-colors">
                    <Eraser size={12} />
                </button>
                <button onClick={() => setAutoScroll(!autoScroll)} className={`${autoScroll ? 'text-cyan-400' : 'text-zinc-400'} transition-colors`}>
                    <ArrowDown size={12} />
                </button>
                <div className="flex-1" />
                <div className="relative group">
                    <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        placeholder="Filter..."
                        className="bg-black/20 border border-white/5 rounded pl-6 pr-2 py-0.5 w-24 text-zinc-300 focus:w-40 transition-all focus:outline-none focus:border-cyan-500/50"
                    />
                </div>
                <button disabled={analyzing} onClick={analyzeLogs} className={`flex items-center gap-1.5 px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-all ${analyzing ? 'opacity-50' : ''}`}>
                    {analyzing ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
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
                        {filteredLogs.map((line, i) => (
                            <div key={i} className="leading-tight hover:bg-white/5 px-1 rounded text-zinc-300 border-l-2 border-transparent hover:border-zinc-500/50">
                                {line}
                            </div>
                        ))}
                        <div ref={logsEndRef} />
                    </div>
                )}
            </div>
        </div>
    );
}
