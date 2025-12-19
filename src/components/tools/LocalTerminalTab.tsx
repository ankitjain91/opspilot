import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Loader2, AlertCircle } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

interface LocalTerminalTabProps {
    initialCommand?: string;
    onCommandSent?: () => void;
}

export function LocalTerminalTab({ initialCommand, onCommandSent }: LocalTerminalTabProps) {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const sessionId = useMemo(() => `shell-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`, []);

    // Anti-double init ref
    const isInitializingRef = useRef(false);
    const initialCommandSentRef = useRef(false);

    const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Main terminal initialization
    useEffect(() => {
        if (!terminalRef.current || isInitializingRef.current) return;
        isInitializingRef.current = true;

        let mounted = true;
        let xterm: Terminal | null = null;
        let fitAddon: FitAddon | null = null;
        let resizeObs: ResizeObserver | null = null;
        let unlisteners: UnlistenFn[] = [];

        const init = async () => {
            // Create terminal instance
            xterm = new Terminal({
                cursorBlink: true,
                cursorStyle: 'block',
                fontSize: 14,
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
                fontWeight: '400',
                lineHeight: 1.2,
                scrollback: 50000,
                allowProposedApi: true,
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

            fitAddon = new FitAddon();
            xterm.loadAddon(fitAddon);

            // Try WebGL addon
            try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => webglAddon.dispose());
                xterm.loadAddon(webglAddon);
            } catch {
                // Ignore WebGL failures
            }

            if (!terminalRef.current || !mounted) {
                xterm.dispose();
                return;
            }

            xterm.open(terminalRef.current);
            xtermRef.current = xterm;
            fitAddonRef.current = fitAddon;

            // Set up event listeners
            try {
                const outputUnlisten = await listen<string>(`shell_output:${sessionId}`, (event) => {
                    if (mounted && xtermRef.current) {
                        xtermRef.current.write(event.payload);
                    }
                });
                if (mounted) unlisteners.push(outputUnlisten); else outputUnlisten();

                const closedUnlisten = await listen(`shell_closed:${sessionId}`, () => {
                    if (mounted) {
                        if (xtermRef.current) {
                            xtermRef.current.writeln('\r\n\x1b[31mShell session ended.\x1b[0m');
                        }
                        setStatus('error');
                    }
                });
                if (mounted) unlisteners.push(closedUnlisten); else closedUnlisten();
            } catch (e) {
                console.error('Failed to setup listeners:', e);
            }

            // Handle user input
            const dataDisposable = xterm.onData(data => {
                if (mounted) {
                    invoke("send_shell_input", { sessionId, data }).catch(() => { });
                }
            });

            // Handle resize
            const handleResize = () => {
                if (fitAddon && xterm) {
                    try {
                        fitAddon.fit();
                        const { cols, rows } = xterm;
                        invoke("resize_shell", { sessionId, rows, cols }).catch(() => { });
                    } catch { }
                }
            };

            resizeObs = new ResizeObserver(() => {
                if (mounted) requestAnimationFrame(handleResize);
            });
            if (terminalRef.current) {
                resizeObs.observe(terminalRef.current);
            }

            // Start the shell
            try {
                await invoke("start_local_shell", { sessionId });
                if (mounted) {
                    setStatus('ready');
                    requestAnimationFrame(() => {
                        handleResize();
                        xterm?.focus();
                    });

                    if (initialCommand && !initialCommandSentRef.current) {
                        initialCommandSentRef.current = true;
                        setTimeout(() => {
                            if (mounted) {
                                invoke("send_shell_input", { sessionId, data: initialCommand + '\n' }).catch(() => { });
                                onCommandSent?.();
                            }
                        }, 300);
                    }
                }
            } catch (err) {
                if (mounted) {
                    setStatus('error');
                    setErrorMessage(String(err));
                    xterm?.writeln(`\x1b[31mFailed to start shell: ${err}\x1b[0m`);
                }
            }
        };

        const initPromise = init();

        return () => {
            mounted = false;
            isInitializingRef.current = false;
            unlisteners.forEach(u => u());
            resizeObs?.disconnect();
            if (xterm) {
                xterm.dispose();
                xtermRef.current = null;
            }
            invoke("stop_local_shell", { sessionId }).catch(() => { });
        };
    }, []); // Only run once on mount

    // Handle initialCommand changes after mount
    useEffect(() => {
        if (status === 'ready' && initialCommand && !initialCommandSentRef.current) {
            initialCommandSentRef.current = true;
            setTimeout(() => {
                invoke("send_shell_input", { sessionId, data: initialCommand + '\n' }).catch(() => { });
                onCommandSent?.();
            }, 100);
        }
    }, [status, initialCommand, onCommandSent, sessionId]);

    // Reset flag when initialCommand is cleared
    useEffect(() => {
        if (!initialCommand) {
            initialCommandSentRef.current = false;
        }
    }, [initialCommand]);

    return (
        <div className="h-full bg-[#0d0d0d] overflow-hidden relative">
            {status === 'connecting' && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d0d] z-10">
                    <div className="flex items-center gap-2 text-zinc-500">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span className="text-sm">Starting shell...</span>
                    </div>
                </div>
            )}
            {status === 'error' && errorMessage && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d0d] z-10">
                    <div className="flex flex-col items-center gap-3 text-red-400 p-4 text-center">
                        <AlertCircle className="w-8 h-8" />
                        <span className="text-sm font-medium">Failed to start terminal</span>
                        <span className="text-xs text-zinc-500 max-w-md">{errorMessage}</span>
                        <button
                            onClick={() => window.location.reload()}
                            className="mt-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs text-zinc-300"
                        >
                            Reload
                        </button>
                    </div>
                </div>
            )}
            <div ref={terminalRef} className="h-full w-full" />
        </div>
    );
}
