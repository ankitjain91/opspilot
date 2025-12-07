
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    Loader2, Play, Pause, Search, Download, Maximize2, Minimize2,
    ChevronDown, AlignLeft, WrapText, Type, X, Eraser, ArrowDown, Sparkles
} from 'lucide-react';
import { K8sObject } from '../../../types/k8s';

interface LogsTabProps {
    resource: K8sObject;
    fullObject: any;
}

export function LogsTab({ resource, fullObject }: LogsTabProps) {
    const [selectedContainer, setSelectedContainer] = useState<string>("");
    const [logs, setLogs] = useState<string[]>([]);
    const [isStreaming, setIsStreaming] = useState(true); // Start with streaming enabled
    const [autoScroll, setAutoScroll] = useState(true); // Follow is on by default
    const [searchTerm, setSearchTerm] = useState("");
    const [fontSize, setFontSize] = useState(12);
    const [lineWrap, setLineWrap] = useState(false);
    const [showTimestamps, setShowTimestamps] = useState(false); // Not implemented yet but UI placeholder

    const [analyzing, setAnalyzing] = useState(false);
    const logsEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const unlistenRef = useRef<(() => void) | null>(null);
    const sessionId = useMemo(() => `logs-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

    // Extract containers
    const containers = fullObject?.spec?.containers?.map((c: any) => c.name) || [];
    const initContainers = fullObject?.spec?.initContainers?.map((c: any) => c.name) || [];
    const allContainers = [...containers, ...initContainers];

    useEffect(() => {
        if (allContainers.length > 0 && !selectedContainer) {
            setSelectedContainer(allContainers[0]);
        }
    }, [allContainers, selectedContainer]);

    // Scroll to bottom
    useEffect(() => {
        if (autoScroll && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs, autoScroll]);

    // Handle stream logic
    const startStream = async () => {
        if (!selectedContainer) return;
        setIsStreaming(true);
        setLogs([]); // Clear logs on new stream

        try {
            // Start backend stream
            await invoke("start_log_stream", {
                namespace: resource.namespace,
                name: resource.name,
                container: selectedContainer,
                sessionId
            });

            // Listen for events
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
        try {
            await invoke("stop_log_stream", { sessionId }); // Backend handles stopping current stream
        } catch { } // Ignore error if no stream
        setIsStreaming(false);
    };

    // Auto-start (optional - maybe manual is better? Let's auto-start)
    // For now, let's make it manual or specific effect dependent.
    // Original implementation had manual start or auto-fetch logic.
    // We'll stick to a simple "Fetch/Stream" model.
    // Actually, original uses `get_pod_logs` (non-streaming) in `tool` logic, but `LogsTab` likely used streaming or fetch.
    // In `App.tsx` lines 5282+, it seems it uses `listen` so it is streaming.
    // Let's verify if `useEffect` starts it automatically.
    // It wasn't clear from my reading, but usually logs tabs start automatically.

    useEffect(() => {
        if (selectedContainer) {
            startStream();
        }
        return () => {
            stopStream();
        };
    }, [selectedContainer]);


    // Search / Filter
    const filteredLogs = logs.filter(line => {
        if (!searchTerm) return true;
        return line.toLowerCase().includes(searchTerm.toLowerCase());
    });

    const handleDownload = () => {
        const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${resource.name}-${selectedContainer}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const analyzeLogs = async () => {
        if (logs.length === 0) return;
        setAnalyzing(true);
        try {
            const recentLogs = logs.slice(-50).join('\n'); // Analyze last 50 lines
            const analysis = await invoke<string>("analyze_text", {
                text: recentLogs,
                context: `Logs for ${resource.name}/${selectedContainer}. Check for errors or issues.`
            });
            if ((window as any).showToast) {
                // Show as a helper or toast. Original code might have shown a modal.
                // We'll use alert for now or a custom UI element if we had one.
                // Let's just prepend the analysis to logs as a special message?
                // Or cleaner: show a toast/alert.
                // (window as any).showToast(`Analysis: ${analysis}`, 'info', 10000);
                // Better: Prepend to logs
                setLogs(prev => [...prev, `\n--- AI ANALYSIS ---\n${analysis}\n-------------------\n`]);
            }
        } catch (err) {
            console.error(err);
            (window as any).showToast?.(`Analysis failed: ${err}`, 'error');
        } finally {
            setAnalyzing(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] border border-[#3e3e42] rounded overflow-hidden">
            {/* Controls */}
            <div className="flex flex-wrap items-center gap-3 px-4 py-2 bg-[#252526] border-b border-[#3e3e42]">
                {/* Container Selector */}
                <div className="flex items-center gap-2">
                    <label className="text-[10px] text-[#858585] uppercase font-bold">Container</label>
                    <div className="relative">
                        <select
                            value={selectedContainer}
                            onChange={(e) => setSelectedContainer(e.target.value)}
                            className="bg-[#1e1e1e] border border-[#3e3e42] text-[#cccccc] text-xs rounded pl-2 pr-6 py-1 appearance-none focus:border-[#007acc] focus:outline-none min-w-[120px]"
                        >
                            {allContainers.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#858585] pointer-events-none" />
                    </div>
                </div>

                <div className="h-4 w-px bg-[#3e3e42]" />

                {/* Status Indicator - Always visible */}
                <div className="flex items-center gap-1.5 px-2 py-1 bg-[#1e1e1e] rounded border border-[#3e3e42]">
                    <div className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                    <span className={`text-[10px] font-medium ${isStreaming ? 'text-green-400' : 'text-yellow-400'}`}>
                        {isStreaming ? 'LIVE' : 'PAUSED'}
                    </span>
                </div>

                {/* Stream Control Button */}
                <button
                    onClick={() => isStreaming ? stopStream() : startStream()}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                        isStreaming
                            ? 'bg-[#1e1e1e] text-[#858585] border-[#3e3e42] hover:bg-[#3e3e42] hover:text-yellow-400'
                            : 'bg-green-500/20 text-green-400 border-green-500/30 hover:bg-green-500/30'
                    }`}
                    title={isStreaming ? 'Click to pause streaming' : 'Click to resume streaming'}
                >
                    {isStreaming ? <Pause size={12} /> : <Play size={12} />}
                    {isStreaming ? 'Pause' : 'Resume'}
                </button>

                <div className="h-4 w-px bg-[#3e3e42]" />

                {/* Auto-scroll Toggle with clear state */}
                <button
                    onClick={() => setAutoScroll(!autoScroll)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                        autoScroll
                            ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30'
                            : 'bg-[#1e1e1e] text-[#858585] border-[#3e3e42] hover:bg-[#3e3e42]'
                    }`}
                    title={autoScroll ? 'Auto-scroll is ON - click to disable' : 'Auto-scroll is OFF - click to enable'}
                >
                    <ArrowDown size={12} className={autoScroll ? 'animate-bounce' : ''} />
                    {autoScroll ? 'Following' : 'Scroll Off'}
                </button>

                {/* Clear Button */}
                <button
                    onClick={() => setLogs([])}
                    className="flex items-center gap-1 px-2 py-1 text-[#858585] hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/30 rounded transition-colors text-xs"
                    title="Clear all logs"
                >
                    <Eraser size={12} />
                    Clear
                </button>

                <div className="flex-1" />

                <div className="relative group">
                    <Search size={12} className="absolute left-2 top-1.5 text-gray-500" />
                    <input
                        type="text"
                        placeholder="Search logs..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="bg-[#1e1e1e] border border-[#3e3e42] rounded pl-7 pr-2 py-1 text-xs text-[#cccccc] focus:outline-none focus:border-[#007acc] w-[150px] transition-all focus:w-[200px]"
                    />
                </div>

                <div className="h-4 w-px bg-[#3e3e42]" />

                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setLineWrap(!lineWrap)}
                        className={`p-1.5 rounded transition-colors ${lineWrap ? 'bg-[#007acc]/20 text-[#007acc]' : 'text-[#858585] hover:text-[#cccccc]'}`}
                        title="Toggle Wrap"
                    >
                        <WrapText size={14} />
                    </button>
                    <button
                        onClick={() => setFontSize(prev => Math.max(10, prev - 1))}
                        className="p-1.5 text-[#858585] hover:text-[#cccccc] hover:bg-[#3e3e42] rounded"
                        title="Decrease Font Size"
                    >
                        <Type size={10} />
                    </button>
                    <button
                        onClick={() => setFontSize(prev => Math.min(18, prev + 1))}
                        className="p-1.5 text-[#858585] hover:text-[#cccccc] hover:bg-[#3e3e42] rounded"
                        title="Increase Font Size"
                    >
                        <Type size={16} />
                    </button>
                </div>

                <div className="h-4 w-px bg-[#3e3e42]" />

                <button
                    onClick={analyzeLogs}
                    disabled={analyzing}
                    className="flex items-center gap-1.5 px-3 py-1 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-600/30 rounded text-xs transition-colors disabled:opacity-50"
                >
                    {analyzing ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                    AI Analyze
                </button>

                <button
                    onClick={handleDownload}
                    className="p-1.5 text-[#858585] hover:text-[#cccccc] hover:bg-[#3e3e42] rounded transition-colors"
                    title="Download Logs"
                >
                    <Download size={14} />
                </button>
            </div>

            {/* Logs View */}
            <div
                ref={scrollContainerRef}
                className="flex-1 overflow-auto bg-[#1e1e1e] p-2 relative font-mono"
                style={{ fontSize: `${fontSize}px` }}
                onScroll={(e) => {
                    const target = e.currentTarget;
                    // Disable autoscroll if user scrolls up
                    if (target.scrollHeight - target.scrollTop - target.clientHeight > 50) {
                        setAutoScroll(false);
                    } else {
                        setAutoScroll(true);
                    }
                }}
            >
                {filteredLogs.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-[#505050] italic select-none">
                        {isStreaming ? "Waiting for logs..." : "No logs to display"}
                    </div>
                ) : (
                    <div className={`${lineWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
                        {filteredLogs.map((line, i) => (
                            <div key={i} className="leading-tight hover:bg-[#2d2d30] px-1 rounded text-[#cccccc]">
                                <span className="text-[#505050] select-none mr-3 w-8 inline-block text-right">{i + 1}</span>
                                {line}
                            </div>
                        ))}
                        <div ref={logsEndRef} />
                    </div>
                )}
                {!autoScroll && (
                    <button
                        onClick={() => {
                            setAutoScroll(true);
                            logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                        }}
                        className="absolute bottom-4 right-4 bg-[#007acc] text-white p-2 rounded-full shadow-lg opacity-80 hover:opacity-100 transition-opacity"
                        title="Resume Auto-scroll"
                    >
                        <ArrowDown size={16} />
                    </button>
                )}
            </div>
        </div>
    );
}
