
import React, { useEffect, useRef, useState, useCallback } from 'react';
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
    const sessionIdRef = useRef<string | null>(null);
    const unlistenersRef = useRef<UnlistenFn[]>([]);
    const initialCommandSentRef = useRef(false);

    const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Generate session ID immediately (not in effect)
    if (!sessionIdRef.current) {
        sessionIdRef.current = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    }

    // Main terminal initialization
    useEffect(() => {
        const sessionId = sessionIdRef.current;
        if (!terminalRef.current || !sessionId) return;

        console.log('[LocalTerminalTab] Generated session ID:', sessionId);

        console.log('[LocalTerminalTab] Initializing terminal with session:', sessionId);
        let mounted = true;

        const init = async () => {
            // Create terminal instance
            const term = new Terminal({
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

            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);

            // Try WebGL addon
            try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => webglAddon.dispose());
                term.loadAddon(webglAddon);
            } catch {
                console.log('[LocalTerminalTab] WebGL not available, using canvas renderer');
            }

            if (!terminalRef.current || !mounted) {
                term.dispose();
                return;
            }

            term.open(terminalRef.current);
            xtermRef.current = term;
            fitAddonRef.current = fitAddon;

            // Set up event listeners BEFORE starting shell
            console.log('[LocalTerminalTab] Setting up listeners for:', `shell_output:${sessionId}`);

            const outputUnlisten = await listen<string>(`shell_output:${sessionId}`, (event) => {
                console.log('[LocalTerminalTab] Received output:', event.payload.length, 'bytes');
                if (xtermRef.current) {
                    xtermRef.current.write(event.payload);
                }
            });
            unlistenersRef.current.push(outputUnlisten);

            const closedUnlisten = await listen(`shell_closed:${sessionId}`, () => {
                console.log('[LocalTerminalTab] Shell closed');
                if (xtermRef.current) {
                    xtermRef.current.writeln('\r\n\x1b[31mShell session ended.\x1b[0m');
                }
                if (mounted) setStatus('error');
            });
            unlistenersRef.current.push(closedUnlisten);

            // Handle user input
            term.onData(data => {
                invoke("send_shell_input", { sessionId: sessionId, data }).catch(err => {
                    console.error('[LocalTerminalTab] Failed to send input:', err);
                });
            });

            // Handle resize
            const handleResize = () => {
                if (fitAddonRef.current && xtermRef.current) {
                    try {
                        fitAddonRef.current.fit();
                        const { cols, rows } = xtermRef.current;
                        invoke("resize_shell", { sessionId: sessionId, rows, cols }).catch(() => { });
                    } catch { }
                }
            };

            // ResizeObserver for container size changes
            const resizeObserver = new ResizeObserver(() => {
                requestAnimationFrame(handleResize);
            });
            if (terminalRef.current) {
                resizeObserver.observe(terminalRef.current);
            }

            // Start the shell
            try {
                console.log('[LocalTerminalTab] Starting shell...');
                await invoke("start_local_shell", { sessionId: sessionId });
                console.log('[LocalTerminalTab] Shell started successfully');

                if (mounted) {
                    setStatus('ready');

                    // Initial fit and focus
                    requestAnimationFrame(() => {
                        handleResize();
                        term.focus();
                    });

                    // Send initial command if provided
                    if (initialCommand && !initialCommandSentRef.current) {
                        initialCommandSentRef.current = true;
                        setTimeout(() => {
                            console.log('[LocalTerminalTab] Sending initial command:', initialCommand);
                            invoke("send_shell_input", { sessionId: sessionId, data: initialCommand + '\n' }).catch(() => { });
                            onCommandSent?.();
                        }, 300);
                    }
                }
            } catch (err) {
                console.error('[LocalTerminalTab] Failed to start shell:', err);
                if (mounted) {
                    setStatus('error');
                    setErrorMessage(String(err));
                }
                term.writeln(`\x1b[31mFailed to start shell: ${err}\x1b[0m`);
            }

            // Cleanup function
            return () => {
                resizeObserver.disconnect();
            };
        };

        const cleanupPromise = init();

        return () => {
            mounted = false;
            cleanupPromise.then(cleanup => cleanup?.());

            // Cleanup listeners
            unlistenersRef.current.forEach(unlisten => unlisten());
            unlistenersRef.current = [];

            // Dispose terminal
            if (xtermRef.current) {
                xtermRef.current.dispose();
                xtermRef.current = null;
            }

            // Stop the shell session
            if (sessionIdRef.current) {
                invoke("stop_local_shell", { sessionId: sessionIdRef.current }).catch(() => { });
            }
        };
    }, []); // Only run once on mount

    // Handle initialCommand changes after mount
    useEffect(() => {
        const sessionId = sessionIdRef.current;
        if (status === 'ready' && initialCommand && !initialCommandSentRef.current && sessionId) {
            initialCommandSentRef.current = true;
            setTimeout(() => {
                console.log('[LocalTerminalTab] Sending delayed initial command:', initialCommand);
                invoke("send_shell_input", { sessionId: sessionId, data: initialCommand + '\n' }).catch(() => { });
                onCommandSent?.();
            }, 100);
        }
    }, [status, initialCommand, onCommandSent]);

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
