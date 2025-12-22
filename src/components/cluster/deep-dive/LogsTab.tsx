import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Virtuoso } from 'react-virtuoso';
import {
    Play, Pause, Eraser, ArrowDown, ArrowUp, Search, Loader2, Sparkles, FileText,
    Download, Copy, Check, WrapText, X
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useToast } from '../../ui/Toast';
import { K8sObject } from '../../../types/k8s';
import { getAgentServerUrl } from '../../../utils/config';
import { useAgentUrl } from '../../../hooks/useAgentUrl';

// --- Smart Log Analysis Constants & Types ---

interface LogPattern {
    name: string;
    pattern: RegExp;
    level: 'error' | 'warn' | 'info';
    color: string;
}

const LOG_PATTERNS: LogPattern[] = [
    { name: "CrashLoop", pattern: /(CrashLoopBackOff|Back-off restarting failed container)/i, level: 'error', color: 'bg-red-500' },
    { name: "OOMKilled", pattern: /(OOMKilled|reason: OOMKilled)/i, level: 'error', color: 'bg-red-500' },
    { name: "ImagePull", pattern: /(ImagePullBackOff|ErrImagePull|pull access denied|unauthorized)/i, level: 'error', color: 'bg-red-500' },
    { name: "ConnectionRefused", pattern: /(Connection refused|dial tcp.*:\d+|upstream connect error)/i, level: 'error', color: 'bg-red-500' },
    { name: "Timeout", pattern: /(context deadline exceeded|i\/o timeout|Client.Timeout)/i, level: 'error', color: 'bg-red-500' },
    { name: "VolumeMount", pattern: /(MountVolume.SetUp failed|Unable to attach or mount volumes)/i, level: 'error', color: 'bg-red-500' },
    { name: "ConfigError", pattern: /(CreateContainerConfigError|configmap.*not found|secret.*not found)/i, level: 'error', color: 'bg-red-500' },
    { name: "Critical", pattern: /\b(Fatal|Panic|Critical)\b/i, level: 'error', color: 'bg-red-500' },
    { name: "Error", pattern: /\b(Error|Exception)\b/i, level: 'error', color: 'bg-red-500' },
    { name: "Warning", pattern: /\b(Warn|Warning)\b/i, level: 'warn', color: 'bg-yellow-500' },
];

interface LogScanResult {
    lineIndex: number;
    patternName: string;
    level: 'error' | 'warn' | 'info';
}

interface LogCluster {
    startIndex: number;
    endIndex: number;
    errorCount: number;
    score: number; // Density score
}

// --- Components ---

function LogMinimap({ logs, scanResults, onScrollTo, searchMatches, currentMatchIndex }: { logs: string[], scanResults: LogScanResult[], onScrollTo: (index: number) => void, searchMatches: number[], currentMatchIndex: number }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const totalLines = logs.length;

        if (totalLines === 0) return;

        ctx.clearRect(0, 0, width, height);

        // Draw marks
        const lineHeight = Math.max(1, height / totalLines);

        // Draw Errors/Warnings
        scanResults.forEach(res => {
            const y = (res.lineIndex / totalLines) * height;
            ctx.fillStyle = res.level === 'error' ? '#ef4444' : '#eab308'; // red-500 : yellow-500
            ctx.fillRect(0, y, width, Math.max(2, lineHeight));
        });

        // Draw Search Matches (Cyan)
        if (searchMatches.length > 0) {
            ctx.fillStyle = '#06b6d4'; // cyan-500
            searchMatches.forEach(idx => {
                const y = (idx / totalLines) * height;
                ctx.fillRect(0, y, width, Math.max(2, lineHeight));
            });

            // Draw Current Match (White)
            if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
                const idx = searchMatches[currentMatchIndex];
                const y = (idx / totalLines) * height;
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, y, width, Math.max(3, lineHeight + 1));
            }
        }

    }, [logs.length, scanResults, searchMatches, currentMatchIndex]);

    const handleClick = (e: React.MouseEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const percentage = y / rect.height;
        const targetIndex = Math.floor(percentage * logs.length);
        onScrollTo(targetIndex);
    };

    return (
        <canvas
            ref={canvasRef}
            width={12}
            height={500}
            className="w-3 h-full cursor-pointer hover:bg-white/5 opacity-80"
            onClick={handleClick}
            title="Density Map (Click to jump)"
        />
    );
}

interface LogsTabProps {
    resource: K8sObject;
    fullObject: any;
    autoAnalyzeContainer?: string;
    onAnalysisStarted?: () => void;
}

export function LogsTab({ resource, fullObject, autoAnalyzeContainer, onAnalysisStarted }: LogsTabProps) {
    const [container, setContainer] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [isStreaming, setIsStreaming] = useState(true);
    const [autoScroll, setAutoScroll] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [fontSize, setFontSize] = useState(12);
    const [lineWrap, setLineWrap] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [analysisStatus, setAnalysisStatus] = useState<string>("");
    const [lastAnalysis, setLastAnalysis] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [scanResults, setScanResults] = useState<LogScanResult[]>([]);

    // Search State
    const [searchMatches, setSearchMatches] = useState<number[]>([]);
    const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

    const [lastPacketTime, setLastPacketTime] = useState<Date | null>(null);
    const [reconnectAttempts, setReconnectAttempts] = useState(0);

    const { showToast } = useToast();
    const agentUrl = useAgentUrl();
    const logsEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const virtuosoRef = useRef<any>(null);
    const unlistenRef = useRef<(() => void) | null>(null);
    const activeSessionId = useRef<string | null>(null);
    const activePodContainer = useRef<string>("");
    const logBufferRef = useRef<string[]>([]);
    const lastUpdateRef = useRef<number>(0);
    const isStreamingRef = useRef<boolean>(false); // Track streaming state in ref for closure access
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Extract containers
    const spec = fullObject?.spec || {};
    const podSpec = spec.containers ? spec : (spec.template?.spec || {});
    const containers = podSpec.containers || [];
    const initContainers = podSpec.initContainers || [];
    const allContainers = [...containers, ...initContainers];

    // Initial Container Selection
    useEffect(() => {
        if (allContainers.length > 0) {
            if (autoAnalyzeContainer) {
                setContainer(autoAnalyzeContainer);
            } else {
                const isValid = allContainers.some((c: any) => c.name === container);
                if (!container || !isValid) {
                    setContainer(allContainers[0].name);
                }
            }
        }
    }, [allContainers, container, autoAnalyzeContainer]);

    // Local Scan & Search Effect
    useEffect(() => {
        if (logs.length === 0) {
            setScanResults([]);
            setSearchMatches([]);
            return;
        }

        // Debounce scan
        const timer = setTimeout(() => {
            const results: LogScanResult[] = [];
            const matches: number[] = [];

            logs.forEach((line, index) => {
                const clean = line.replace(/\x1B\[\d+m/g, '');

                // Patterns
                for (const p of LOG_PATTERNS) {
                    if (p.pattern.test(clean)) {
                        results.push({ lineIndex: index, patternName: p.name, level: p.level });
                        break;
                    }
                }

                // Search
                if (searchTerm && line.toLowerCase().includes(searchTerm.toLowerCase())) {
                    matches.push(index);
                }
            });

            setScanResults(results);
            setSearchMatches(matches);
            // If we have matches and no current match, select first
            if (matches.length > 0) {
            } else {
                setCurrentMatchIndex(-1);
            }
        }, 500);

        return () => clearTimeout(timer);
    }, [logs.length, searchTerm]);

    // Auto-analysis trigger
    useEffect(() => {
        if (autoAnalyzeContainer && container === autoAnalyzeContainer && logs.length > 5 && !analyzing && !lastAnalysis) {
            console.log("[LogsTab] Auto-triggering AI analysis for", container);
            onAnalysisStarted?.();
            analyzeLogs();
        }
    }, [autoAnalyzeContainer, container, logs.length, analyzing, lastAnalysis]);

    // Unified Batch Processing Effect
    useEffect(() => {
        console.log("[LogsTab] Batch Flush interval started");
        const interval = setInterval(() => {
            if (logBufferRef.current.length === 0) return;

            // Atomically collect and clear buffer
            const newLines = logBufferRef.current.splice(0, logBufferRef.current.length);
            console.log(`[LogsTab] Batch Flush: ${newLines.length} lines appended to state.`);

            setLogs(prev => {
                const combined = [...prev, ...newLines];
                // Keep history sane (10,000 lines for debugging)
                if (combined.length > 10000) return combined.slice(-8000);
                return combined;
            });
        }, 100);

        return () => {
            console.log("[LogsTab] Batch Flush interval cleared");
            clearInterval(interval);
        };
    }, []); // Run for the lifetime of the component

    const scrollToLine = useCallback((index: number) => {
        setAutoScroll(false);
        if (scrollContainerRef.current) {
            const container = scrollContainerRef.current;
            const percentage = index / logs.length;
            container.scrollTop = percentage * container.scrollHeight;
        }
    }, [logs.length]);

    // Jump to Match
    useEffect(() => {
        if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
            const lineIdx = searchMatches[currentMatchIndex];
            scrollToLine(lineIdx);
        }
    }, [currentMatchIndex, searchMatches, scrollToLine]);

    const handleNextMatch = () => {
        if (searchMatches.length === 0) return;
        setCurrentMatchIndex(prev => (prev + 1) % searchMatches.length);
        setAutoScroll(false);
    };

    const handlePrevMatch = () => {
        if (searchMatches.length === 0) return;
        setCurrentMatchIndex(prev => (prev - 1 + searchMatches.length) % searchMatches.length);
        setAutoScroll(false);
    };

    const zoomIn = () => setFontSize(prev => Math.min(prev + 2, 24));
    const zoomOut = () => setFontSize(prev => Math.max(prev - 2, 8));

    // LLM-powered log analysis using Claude Code
    const analyzeLogs = async () => {
        if (logs.length === 0) {
            showToast("No logs to analyze", "error");
            return;
        }

        setAnalyzing(true);
        setAnalysisStatus("Connecting to AI...");

        try {
            // Take last 200 lines for analysis (balance between context and token limits)
            const logsToAnalyze = logs.slice(-200).join('\n');

            const response = await fetch(`${agentUrl}/analyze-logs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
                body: JSON.stringify({
                    logs: logsToAnalyze,
                    pod_name: resource.name,
                    container_name: container,
                    namespace: resource.namespace,
                    kube_context: '', // Will use default context
                }),
            });

            if (!response.ok) {
                throw new Error(`Analysis failed: ${response.status}`);
            }

            if (!response.body) {
                throw new Error("No response body");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let analysisText = "\n--- 🤖 AI ANALYSIS ---\n\n";
            let streamedText = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const eventData = JSON.parse(line.slice(6));

                            switch (eventData.type) {
                                case 'progress':
                                    setAnalysisStatus(eventData.message || 'Analyzing...');
                                    break;
                                case 'text':
                                    // Stream text as it arrives
                                    streamedText += eventData.content || '';
                                    break;
                                case 'done':
                                    // Final analysis received
                                    if (eventData.analysis) {
                                        analysisText += eventData.analysis;
                                    } else if (streamedText) {
                                        analysisText += streamedText;
                                    }
                                    break;
                                case 'error':
                                    throw new Error(eventData.message);
                            }
                        } catch (parseErr) {
                            // Ignore parse errors for incomplete chunks
                        }
                    }
                }
            }

            // Add the analysis to logs display
            if (analysisText.length > 30) {
                setLogs(prev => [...prev, analysisText]);
                setLastAnalysis(analysisText.replace("\n--- 🤖 AI ANALYSIS ---\n\n", ""));
                showToast("AI analysis complete", "success");
            } else {
                showToast("Analysis returned empty result", "error");
            }
        } catch (error: any) {
            console.error("Log analysis failed:", error);
            showToast(`Analysis failed: ${error.message}`, "error");

            // Fallback to local pattern analysis
            const errorLines = scanResults.filter(r => r.level === 'error');
            const warnLines = scanResults.filter(r => r.level === 'warn');

            let fallback = "\n--- 🤖 LOCAL ANALYSIS (AI unavailable) ---\n\n";
            fallback += `## Quick Summary\n`;
            fallback += `- **Total Lines:** ${logs.length}\n`;
            fallback += `- **Errors Found:** ${errorLines.length}\n`;
            fallback += `- **Warnings Found:** ${warnLines.length}\n`;

            if (errorLines.length === 0 && warnLines.length === 0) {
                fallback += "\n✅ No critical issues detected in logs.\n";
            }

            setLogs(prev => [...prev, fallback]);
        } finally {
            setAnalyzing(false);
            setAnalysisStatus("");
        }
    };

    // --- Stream Logic ---
    const startStream = async () => {
        const podId = `${resource.namespace}/${resource.name}/${container}`;
        if (activePodContainer.current === podId && isStreamingRef.current) {
            console.log(`[LogsTab] Stream already active for ${podId}, skipping restart.`);
            return;
        }

        const isValid = allContainers.some((c: any) => c.name === container);
        if (!container || !isValid) {
            if (allContainers.length > 0) {
                setContainer(allContainers[0].name);
                return;
            } else {
                showToast("No valid container found.", "error");
                return;
            }
        }

        if (activePodContainer.current !== podId) {
            setLogs([]);
            setReconnectAttempts(0); // Reset reconnect attempts on new container
        }

        // Clear any pending reconnect timeout
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        // Capture old SID to stop it after starting the new one (avoids race)
        const oldSessionId = activeSessionId.current;
        const newSessionId = `logs-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        activePodContainer.current = podId;
        activeSessionId.current = newSessionId;
        console.log(`[LogsTab] Starting stream ${newSessionId} for ${container}`);

        setIsStreaming(true);
        isStreamingRef.current = true;
        try {
            console.log(`[LogsTab] Invoking start_log_stream for ${resource.name}...`);
            await invoke("start_log_stream", {
                namespace: resource.namespace,
                name: resource.name,
                container,
                sessionId: newSessionId,
                tailLines: 500
            });
            console.log(`[LogsTab] start_log_stream INVOKE success for ${newSessionId}`);
            setReconnectAttempts(0); // Reset on successful start

            // Stop the previous session IF it's different
            if (oldSessionId && oldSessionId !== newSessionId) {
                console.log(`[LogsTab] Stopping old session ${oldSessionId}`);
                invoke("stop_log_stream", { sessionId: oldSessionId }).catch(() => { });
            }

            const unlisten = await listen<string>(`log_stream:${newSessionId}`, (event) => {
                if (activeSessionId.current === newSessionId) {
                    const lines = event.payload.split('\n');
                    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

                    if (lines.length > 0) {
                        console.log(`[LogsTab] IPC Event received: ${lines.length} lines`);
                        logBufferRef.current.push(...lines);
                        setLastPacketTime(new Date());
                        setReconnectAttempts(0); // Reset attempts on successful data
                    }
                }
            });
            const unlistenEnd = await listen(`log_stream_end:${newSessionId}`, () => {
                console.log(`[LogsTab] Received log_stream_end for ${newSessionId}`);
                if (activeSessionId.current === newSessionId) {
                    setIsStreaming(false);
                    isStreamingRef.current = false;
                    // Automatic retry if target hasn't changed and we haven't exceeded attempts
                    const currentId = `${resource.namespace}/${resource.name}/${container}`;
                    if (activePodContainer.current === currentId) {
                        setReconnectAttempts(prev => {
                            const attempts = prev + 1;
                            if (attempts <= 3) {
                                // Exponential backoff: 2s, 4s, 8s
                                const delay = Math.min(2000 * Math.pow(2, attempts - 1), 8000);
                                console.log(`[LogsTab] Reconnect attempt ${attempts}/3 in ${delay}ms...`);
                                reconnectTimeoutRef.current = setTimeout(() => {
                                    if (activePodContainer.current === currentId && !isStreamingRef.current) {
                                        startStream();
                                    }
                                }, delay);
                            } else {
                                console.log("[LogsTab] Max reconnect attempts reached, stopping auto-reconnect");
                            }
                            return attempts;
                        });
                    }
                }
            });
            unlistenRef.current = () => { unlisten(); unlistenEnd(); };
        } catch (err) {
            if (activeSessionId.current === newSessionId) {
                showToast(`Failed: ${err}`, "error");
                setIsStreaming(false);
                isStreamingRef.current = false;
            }
        }
    };

    const stopStream = async () => {
        // Clear pending reconnect
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }

        const sid = activeSessionId.current;
        if (sid) {
            try { await invoke("stop_log_stream", { sessionId: sid }); } catch { }
            activeSessionId.current = null;
        }
        setIsStreaming(false);
        isStreamingRef.current = false;
        setReconnectAttempts(0);
    };

    useEffect(() => {
        if (container) startStream();
        return () => {
            // Full cleanup on unmount
            stopStream();
        };
    }, [container, resource.name, resource.namespace]);

    // --- Rendering Helpers ---

    const highlightSearchTerm = (text: string) => {
        if (!searchTerm) return text;
        const parts = text.split(new RegExp(`(${searchTerm})`, 'gi'));
        return parts.map((part, i) =>
            part.toLowerCase() === searchTerm.toLowerCase()
                ? <span key={i} className="bg-yellow-500/50 text-white rounded px-0.5">{part}</span>
                : part
        );
    };

    // Simplified Keyword Highlight for non-ANSI
    const highlightKeywords = (text: string): React.ReactNode => {
        const parts: React.ReactNode[] = [];
        // Simple matcher for key words
        const regex = /((?:^|\b)(?:ERROR|ERRO|FATAL|PANIC|FAIL|FAILED|FAILURE)|(?:^|\b)(?:WARN|WARNING)|(?:^|\b)(?:INFO|INF))(\b|$)/gi;
        let lastIndex = 0;
        let match;
        const re = new RegExp(regex);

        while ((match = re.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parts.push(highlightSearchTerm(text.substring(lastIndex, match.index)));
            }
            const keyword = match[0];
            let className = "text-zinc-300";
            if (/ERROR|ERRO|FATAL|PANIC|FAIL/i.test(keyword)) className = "text-red-400 font-bold";
            else if (/WARN/i.test(keyword)) className = "text-yellow-400 font-bold";
            else if (/INFO/i.test(keyword)) className = "text-green-400 font-bold";

            // Search highlight INSIDE keyword?
            if (searchTerm && keyword.toLowerCase().includes(searchTerm.toLowerCase())) {
                parts.push(<span key={match.index} className={className}>{highlightSearchTerm(keyword)}</span>);
            } else {
                parts.push(<span key={match.index} className={className}>{keyword}</span>);
            }
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            parts.push(highlightSearchTerm(text.substring(lastIndex)));
        }
        return parts.length > 0 ? parts : highlightSearchTerm(text);
    };

    const parseAnsi = (text: string): React.ReactNode => {
        // If no ANSI, fall back to keywords
        if (!text.includes('\x1B')) return highlightKeywords(text);

        const regex = /(\x1B\[[0-9;]*m)/g;
        const tokens = text.split(regex);
        let style: React.CSSProperties = {};
        let currentClass = "";
        const parts: React.ReactNode[] = [];

        tokens.forEach((token, i) => {
            if (regex.test(token)) {
                // Parse code
                const codes = token.match(/\d+/g);
                if (codes) {
                    codes.forEach(code => {
                        const c = parseInt(code);
                        if (c === 0) { style = {}; currentClass = ""; }
                        else if (c === 1) style.fontWeight = 'bold';
                        else if (c >= 30 && c <= 37) currentClass = `text-${['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'][c - 30]}-400`;
                    });
                }
            } else if (token) {
                parts.push(<span key={i} className={currentClass} style={style}>{highlightSearchTerm(token)}</span>);
            }
        });
        return parts;
    };

    const renderLogLine = (line: string, index: number) => {
        // Detect AI analysis blocks (both new AI and legacy local analysis)
        if (line.includes("--- 🤖 AI ANALYSIS ---") || line.includes("--- 🤖 SMART ANALYSIS ---") || line.includes("--- 🤖 LOCAL ANALYSIS")) {
            return (
                <div key={index} className="my-4 p-4 bg-purple-500/10 border border-purple-500/20 rounded-lg">
                    <div className="prose prose-invert prose-sm max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{line}</ReactMarkdown>
                    </div>
                </div>
            );
        }

        const cleanLine = line.replace(/\x1B\[\d+m/g, '');
        // Determine line level
        let lineLevel: 'error' | 'warn' | 'info' | null = null;
        if (/ERROR|ERRO|FATAL|PANIC|FAIL/i.test(cleanLine)) lineLevel = 'error';
        else if (/WARN|WARNING/i.test(cleanLine)) lineLevel = 'warn';

        // Styling
        let containerClass = "leading-tight px-1 rounded border-l-2 border-transparent hover:border-zinc-500/50 hover:bg-white/5 font-mono whitespace-pre-wrap break-all ";
        // Background tint
        if (lineLevel === 'error') containerClass += "bg-red-500/10 border-l-red-500 text-red-300 ";
        else if (lineLevel === 'warn') containerClass += "bg-yellow-500/10 border-l-yellow-500 text-yellow-300 ";

        // Search Match Highlight (Active Line)
        const isMatch = searchMatches.includes(index);
        const isCurrentMatch = currentMatchIndex !== -1 && searchMatches[currentMatchIndex] === index;

        if (isCurrentMatch) {
            containerClass += " !bg-blue-500/30 ring-1 ring-blue-500 ";
        }

        // Timestamp
        const timestampRegex = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^ ]*)/;
        const match = cleanLine.match(timestampRegex);
        let content: React.ReactNode;

        if (match) {
            const timestamp = match[1];
            if (line.includes('\x1B')) {
                content = parseAnsi(line);
            } else {
                const rest = line.substring(timestamp.length);
                content = <><span className="text-zinc-600 select-none mr-2">{timestamp}</span>{highlightKeywords(rest)}</>;
            }
        } else {
            content = parseAnsi(line);
        }

        return <div key={index} className={containerClass}>{content}</div>;
    };

    // --- Main Render ---
    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] relative">
            {/* Header / Controls */}
            <div className="flex items-center gap-2 p-2 px-3 bg-[#252526] border-b border-white/5 text-[10px] shrink-0 z-10 w-full overflow-hidden">
                <select
                    value={container}
                    onChange={e => setContainer(e.target.value)}
                    className="bg-black/20 border border-white/10 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-cyan-500/50 mr-2 max-w-[120px] truncate"
                >
                    {allContainers.map((c: any) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>

                <div className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-green-500 animate-pulse' : reconnectAttempts > 0 && reconnectAttempts <= 3 ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`} />
                <span className={`font-medium uppercase tracking-wider hidden sm:inline ${isStreaming ? 'text-green-400' : reconnectAttempts > 0 && reconnectAttempts <= 3 ? 'text-yellow-400' : 'text-zinc-500'}`}>
                    {isStreaming ? 'Live' : reconnectAttempts > 0 && reconnectAttempts <= 3 ? `Reconnecting (${reconnectAttempts}/3)` : 'Disconnected'}
                </span>
                {lastPacketTime && (
                    <span className="text-zinc-600 font-mono hidden md:inline ml-2 truncate" title={`Time of last received log line (Session: ${activeSessionId.current})`}>
                        Rx: {lastPacketTime.toLocaleTimeString()} [{activeSessionId.current?.slice(-4)}]
                    </span>
                )}

                <div className="h-3 w-px bg-white/10 mx-1" />

                <button type="button" onClick={() => isStreaming ? stopStream() : startStream()} className="hover:text-white text-zinc-400 transition-colors flex items-center gap-1.5 px-1" title={isStreaming ? "Stop Streaming" : "Start Streaming"}>
                    {isStreaming ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button type="button" onClick={() => { console.log("[LogsTab] Clearing logs"); setLogs([]); }} className="hover:text-red-400 text-zinc-400 transition-colors px-1" title="Clear Logs">
                    <Eraser size={14} />
                </button>

                {/* Search Bar */}
                <div className="flex items-center bg-black/20 border border-white/10 rounded overflow-hidden mx-2 ml-4">
                    <Search size={12} className="ml-2 text-zinc-500" />
                    <input
                        value={searchTerm}
                        onChange={e => { setSearchTerm(e.target.value); setCurrentMatchIndex(-1); }}
                        placeholder="Search logs..."
                        className="bg-transparent border-none text-zinc-300 px-2 py-1 w-32 focus:w-48 transition-all focus:outline-none text-xs"
                    />
                    {searchTerm && (
                        <div className="flex items-center text-zinc-400 border-l border-white/5 px-1">
                            <span className="text-[9px] mr-1">
                                {searchMatches.length > 0 ? `${currentMatchIndex + 1}/${searchMatches.length}` : '0'}
                            </span>
                            <button onClick={handlePrevMatch} className="hover:text-white p-0.5"><ArrowUp size={10} /></button>
                            <button onClick={handleNextMatch} className="hover:text-white p-0.5"><ArrowDown size={10} /></button>
                            <button onClick={() => { setSearchTerm(""); setSearchMatches([]); }} className="hover:text-red-400 p-0.5 ml-1"><X size={10} /></button>
                        </div>
                    )}
                </div>

                <div className="flex-1" />

                {/* AI Analyze Button */}
                <button
                    disabled={analyzing}
                    onClick={() => { analyzeLogs(); }}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded border transition-all shadow-sm ${analyzing
                        ? 'bg-purple-500/20 text-purple-300 border-purple-500/30'
                        : 'bg-gradient-to-r from-purple-500/10 to-blue-500/10 hover:from-purple-500/20 hover:to-blue-500/20 text-white border-white/10 hover:border-purple-500/50'
                        }`}
                >
                    {analyzing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} className="text-purple-400" />}
                    <span className="font-medium whitespace-nowrap hidden sm:inline">{analyzing ? analysisStatus : "AI Analyze"}</span>
                </button>

                <div className="h-3 w-px bg-white/10 mx-1" />

                {/* Line Wrap Toggle */}
                <button
                    onClick={() => setLineWrap(!lineWrap)}
                    className={`p-1.5 rounded transition-colors ${lineWrap ? 'text-cyan-400 bg-cyan-500/10' : 'text-zinc-400 hover:text-white hover:bg-white/5'}`}
                    title={lineWrap ? "Disable Line Wrap" : "Enable Line Wrap"}
                >
                    <WrapText size={14} />
                </button>

                <div className="h-3 w-px bg-white/10 mx-1" />

                {/* Copy Logs */}
                <button
                    onClick={() => {
                        navigator.clipboard.writeText(logs.join('\n'));
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                        showToast("Logs copied to clipboard", "success");
                    }}
                    className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
                    title="Copy All Logs"
                >
                    {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                </button>

                {/* Download Logs */}
                <button
                    onClick={async () => {
                        try {
                            const { save } = await import('@tauri-apps/plugin-dialog');
                            const { writeTextFile } = await import('@tauri-apps/plugin-fs');

                            const path = await save({
                                defaultPath: `${resource.name}-${container}-logs.txt`,
                                filters: [{
                                    name: 'Log File',
                                    extensions: ['txt']
                                }]
                            });

                            if (path) {
                                await writeTextFile(path, logs.join('\n'));
                                showToast("Logs saved successfully", "success");
                            }
                        } catch (err) {
                            console.error("Native save failed, falling back to browser download:", err);
                            // Fallback
                            const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `${resource.name}-${container}-logs.txt`;
                            a.click();
                            URL.revokeObjectURL(url);
                        }
                    }}
                    className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
                    title="Download Logs"
                >
                    <Download size={14} />
                </button>

                <div className="h-3 w-px bg-white/10 mx-1" />

                <button onClick={zoomOut} className="hover:text-white text-zinc-400 transition-colors font-mono w-5 h-5 flex items-center justify-center rounded hover:bg-white/5">A-</button>
                <button onClick={zoomIn} className="hover:text-white text-zinc-400 transition-colors font-mono w-5 h-5 flex items-center justify-center rounded hover:bg-white/5">A+</button>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 overflow-hidden flex flex-col relative">
                {/* AI Analyzing Banner */}
                {analyzing && (
                    <div className="m-3 p-4 bg-purple-500/10 border border-purple-500/20 rounded-xl flex items-center gap-3 animate-pulse">
                        <div className="p-2 bg-purple-500/20 rounded-lg text-purple-400">
                            <Loader2 size={18} className="animate-spin" />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-xs font-bold text-purple-300 uppercase tracking-wider">Claude AI Analysis</h3>
                            <p className="text-xs text-purple-200/70 mt-0.5">Scanning logs for errors and patterns...</p>
                        </div>
                    </div>
                )}

                {/* AI Summary Banner */}
                {lastAnalysis && !analyzing && (
                    <div className="m-3 p-4 bg-purple-500/10 border border-purple-500/20 rounded-xl animate-in slide-in-from-top-2 duration-300 relative group overflow-hidden shrink-0">
                        <div className="absolute top-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                                onClick={() => setLastAnalysis(null)}
                                className="p-1 hover:bg-white/10 rounded-md text-zinc-400 hover:text-white transition-colors"
                                title="Clear Analysis"
                            >
                                <X size={14} />
                            </button>
                        </div>
                        <div className="flex items-start gap-3">
                            <div className="p-2 bg-purple-500/20 rounded-lg text-purple-400 shrink-0">
                                <Sparkles size={18} />
                            </div>
                            <div className="flex-1 overflow-hidden">
                                <h3 className="text-xs font-bold text-purple-300 uppercase tracking-wider mb-2 flex items-center gap-2">
                                    AI Troubleshooting Summary
                                    <span className="text-[10px] lowercase font-normal text-zinc-500 bg-white/5 px-2 py-0.5 rounded-full">Claude AI</span>
                                </h3>
                                <div className="prose prose-invert prose-xs max-w-none prose-p:leading-relaxed prose-li:my-0.5 text-zinc-300">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{lastAnalysis}</ReactMarkdown>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex-1 flex relative overflow-hidden">
                    <div
                        ref={scrollContainerRef}
                        className="flex-1 bg-[#1e1e1e] font-mono scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-700 overflow-hidden"
                        style={{ fontSize: `${fontSize}px` }}
                    >
                        {logs.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-2">
                                {isStreaming ? <Loader2 size={24} className="animate-spin opacity-50" /> : <FileText size={24} className="opacity-20" />}
                                <span className="text-xs">{isStreaming ? `Waiting for logs from ${container}...` : 'No logs to display.'}</span>
                            </div>
                        ) : (
                            <Virtuoso
                                ref={virtuosoRef}
                                style={{ height: '100%' }}
                                data={logs}
                                followOutput={autoScroll ? 'smooth' : false}
                                atBottomStateChange={(bottom: boolean) => {
                                    setAutoScroll(bottom);
                                }}
                                itemContent={(index: number, line: string) => renderLogLine(line, index)}
                                className={lineWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}
                            />
                        )}
                    </div>

                    {/* Floating Resume Button */}
                    {!autoScroll && logs.length > 0 && (
                        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 animate-in fade-in slide-in-from-bottom-2 duration-200">
                            <button
                                onClick={() => {
                                    setAutoScroll(true);
                                    virtuosoRef.current?.scrollToIndex({ index: logs.length - 1, behavior: 'smooth' });
                                }}
                                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-full shadow-xl shadow-black/50 transition-all transform hover:scale-105 border border-white/10"
                            >
                                <ArrowDown size={14} className="animate-bounce" />
                                <span>Resume Scroll</span>
                            </button>
                        </div>
                    )}

                    {/* Minimap Sidebar */}
                    <div className="w-3 border-l border-white/5 bg-[#16161a] hidden sm:block">
                        <LogMinimap logs={logs} scanResults={scanResults} onScrollTo={scrollToLine} searchMatches={searchMatches} currentMatchIndex={currentMatchIndex} />
                    </div>
                </div>
            </div>
        </div>
    );
}
