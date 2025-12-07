
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal as TerminalIcon, X, ChevronDown } from 'lucide-react';
import { default as Loading } from '../../Loading';
import '@xterm/xterm/css/xterm.css';

interface TerminalTabProps {
    namespace: string;
    name: string;
    podSpec: any;
}

export function TerminalTab({ namespace, name, podSpec }: TerminalTabProps) {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);
    const unlistenClosedRef = useRef<(() => void) | null>(null);
    const sessionId = useMemo(() => `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

    const [selectedContainer, setSelectedContainer] = useState<string>("");
    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);

    // Extract containers from spec
    const containers = useMemo(() => [
        ...(podSpec?.containers || []).map((c: any) => c.name),
        ...(podSpec?.initContainers || []).map((c: any) => c.name)
    ], [podSpec]);

    // Set default container
    useEffect(() => {
        if (containers.length > 0 && !selectedContainer) {
            setSelectedContainer(containers[0]);
        }
    }, [containers, selectedContainer]);

    const cleanupTerminal = useCallback(() => {
        if (unlistenRef.current) {
            unlistenRef.current();
            unlistenRef.current = null;
        }
        if (unlistenClosedRef.current) {
            unlistenClosedRef.current();
            unlistenClosedRef.current = null;
        }
        if (xtermRef.current) {
            xtermRef.current.dispose();
            xtermRef.current = null;
        }
        fitAddonRef.current = null;
    }, []);

    const handleDisconnect = useCallback(() => {
        cleanupTerminal();
        setIsConnected(false);
        setIsConnecting(false);
    }, [cleanupTerminal]);

    const handleConnect = useCallback(async () => {
        if (!terminalRef.current || !selectedContainer) return;

        // Clean up any existing terminal first
        cleanupTerminal();
        setIsConnecting(true);

        // Initialize xterm with optimized settings
        const term = new Terminal({
            cursorBlink: true,
            cursorStyle: 'block',
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
            fontWeight: '400',
            letterSpacing: 0,
            lineHeight: 1.2,
            scrollback: 10000,
            fastScrollModifier: 'alt',
            fastScrollSensitivity: 5,
            theme: {
                background: '#0d0d0d',
                foreground: '#e0e0e0',
                cursor: '#f0f0f0',
                cursorAccent: '#0d0d0d',
                selectionBackground: '#264f78',
                black: '#000000',
                red: '#e06c75',
                green: '#98c379',
                yellow: '#e5c07b',
                blue: '#61afef',
                magenta: '#c678dd',
                cyan: '#56b6c2',
                white: '#abb2bf',
                brightBlack: '#5c6370',
                brightRed: '#e06c75',
                brightGreen: '#98c379',
                brightYellow: '#e5c07b',
                brightBlue: '#61afef',
                brightMagenta: '#c678dd',
                brightCyan: '#56b6c2',
                brightWhite: '#ffffff',
            }
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        // Try WebGL, fall back gracefully
        try {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => webglAddon.dispose());
            term.loadAddon(webglAddon);
        } catch {
            // WebGL not available, canvas renderer will be used
        }

        term.open(terminalRef.current);

        // Fit after a brief delay to ensure proper sizing
        requestAnimationFrame(() => {
            try { fitAddon.fit(); } catch { }
        });

        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        term.writeln(`\x1b[33mConnecting to container '\x1b[1m${selectedContainer}\x1b[0m\x1b[33m'...\x1b[0m`);

        // Set up event listeners before connecting
        const outputUnlisten = await listen<string>(`term_output:${sessionId}`, (event) => {
            if (xtermRef.current) {
                xtermRef.current.write(event.payload);
            }
        });
        unlistenRef.current = outputUnlisten;

        const closedUnlisten = await listen(`term_closed:${sessionId}`, () => {
            if (xtermRef.current) {
                xtermRef.current.writeln('\r\n\x1b[31mConnection closed by remote host.\x1b[0m');
            }
            setIsConnected(false);
        });
        unlistenClosedRef.current = closedUnlisten;

        // Handle Input - send immediately for responsiveness
        const inputDisposable = term.onData(data => {
            invoke("send_exec_input", { sessionId, data }).catch(() => { });
        });

        // Handle Resize with debounce
        let resizeTimeout: ReturnType<typeof setTimeout>;
        const handleResize = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (fitAddonRef.current && xtermRef.current) {
                    try {
                        fitAddonRef.current.fit();
                    } catch { }
                }
            }, 100);
        };
        window.addEventListener("resize", handleResize);

        try {
            await invoke("start_exec", { namespace, name, container: selectedContainer, sessionId });
            term.writeln(`\x1b[32mConnected to ${name}/${selectedContainer}\x1b[0m\r\n`);
            // Fit terminal after connection established with slight delay for DOM to settle
            setTimeout(() => {
                if (fitAddonRef.current) {
                    try { fitAddonRef.current.fit(); } catch { }
                }
            }, 50);
            term.focus();
            setIsConnected(true);
        } catch (err) {
            term.writeln(`\x1b[31mFailed to connect: ${err}\x1b[0m`);
            cleanupTerminal();
        } finally {
            setIsConnecting(false);
        }

        // Return cleanup
        return () => {
            clearTimeout(resizeTimeout);
            inputDisposable.dispose();
            window.removeEventListener("resize", handleResize);
        };
    }, [namespace, name, selectedContainer, sessionId, cleanupTerminal]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cleanupTerminal();
        };
    }, [cleanupTerminal]);

    // Show loading if containers not yet available
    if (containers.length === 0) {
        return (
            <div className="flex flex-col h-full items-center justify-center text-gray-500">
                <Loading size={24} label="Loading container list..." />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full gap-2">
            <div className="flex items-center gap-2 shrink-0 bg-[#252526] p-1 rounded border border-[#3e3e42]">
                <div className="flex items-center gap-2 px-2">
                    <label className="text-[10px] uppercase font-bold text-[#858585]">Container:</label>
                    <div className="relative">
                        <select
                            value={selectedContainer}
                            onChange={(e) => setSelectedContainer(e.target.value)}
                            disabled={isConnected || isConnecting}
                            className="bg-[#1e1e1e] border border-[#3e3e42] text-[#cccccc] text-xs rounded pl-2 pr-6 py-1 appearance-none focus:border-[#007acc] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed min-w-[150px]"
                        >
                            {containers.map((c: string) => (
                                <option key={c} value={c}>{c}</option>
                            ))}
                        </select>
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[#858585]">
                            <ChevronDown size={10} />
                        </div>
                    </div>
                </div>

                <div className="h-4 w-px bg-[#3e3e42]" />

                {!isConnected ? (
                    <button
                        onClick={handleConnect}
                        disabled={isConnecting || !selectedContainer}
                        className="flex items-center gap-1.5 px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isConnecting ? <Loading size={10} label="" /> : <TerminalIcon size={12} />}
                        Connect
                    </button>
                ) : (
                    <button
                        onClick={handleDisconnect}
                        className="flex items-center gap-1.5 px-3 py-1 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded transition-colors"
                    >
                        <X size={12} />
                        Disconnect
                    </button>
                )}

                {isConnected && (
                    <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[#4ec9b0] px-2">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4ec9b0] opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#4ec9b0]"></span>
                        </span>
                        Live Session
                    </span>
                )}
            </div>

            <div className="flex-1 bg-[#1e1e1e] p-2 rounded-md border border-[#3e3e42] overflow-hidden relative">
                {!isConnected && !isConnecting && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500 z-10">
                        <TerminalIcon size={48} className="mb-4 opacity-20" />
                        <p className="text-sm">Select a container and click Connect</p>
                    </div>
                )}
                <div ref={terminalRef} className="h-full w-full" />
            </div>
        </div>
    );
}
