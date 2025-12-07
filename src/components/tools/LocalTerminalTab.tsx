
import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Loader2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

export function LocalTerminalTab() {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const unlistenOutputRef = useRef<(() => void) | null>(null);
    const unlistenClosedRef = useRef<(() => void) | null>(null);
    const sessionId = useMemo(() => `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
        if (!terminalRef.current) return;

        let mounted = true;

        const initTerminal = async () => {
            // Initialize xterm with optimized settings
            const term = new Terminal({
                cursorBlink: true,
                cursorStyle: 'block',
                fontSize: 14,
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
                fontWeight: '400',
                letterSpacing: 0,
                lineHeight: 1.2,
                scrollback: 50000,
                fastScrollModifier: 'alt',
                fastScrollSensitivity: 5,
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

            // Try WebGL for better performance
            try {
                const webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => webglAddon.dispose());
                term.loadAddon(webglAddon);
            } catch {
                // Canvas fallback
            }

            if (!terminalRef.current || !mounted) {
                term.dispose();
                return;
            }

            term.open(terminalRef.current);
            xtermRef.current = term;
            fitAddonRef.current = fitAddon;

            // Set up event listeners
            const outputUnlisten = await listen<string>(`shell_output:${sessionId}`, (event) => {
                if (xtermRef.current) {
                    xtermRef.current.write(event.payload);
                }
            });
            unlistenOutputRef.current = outputUnlisten;

            const closedUnlisten = await listen(`shell_closed:${sessionId}`, () => {
                if (xtermRef.current) {
                    xtermRef.current.writeln('\r\n\x1b[31mShell session ended.\x1b[0m');
                }
            });
            unlistenClosedRef.current = closedUnlisten;

            // Handle Input
            const inputDisposable = term.onData(data => {
                invoke("send_shell_input", { sessionId, data }).catch(() => { });
            });

            // Handle Resize with debounce
            let resizeTimeout: ReturnType<typeof setTimeout>;
            const handleResize = () => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    if (fitAddonRef.current && xtermRef.current) {
                        try {
                            fitAddonRef.current.fit();
                            const { cols, rows } = xtermRef.current;
                            invoke("resize_shell", { sessionId, rows, cols }).catch(() => { });
                        } catch { }
                    }
                }, 50);
            };
            window.addEventListener("resize", handleResize);

            // Start shell
            try {
                await invoke("start_local_shell", { sessionId });
                if (mounted) {
                    setIsReady(true);
                    // Fit and focus after shell starts
                    requestAnimationFrame(() => {
                        handleResize();
                        term.focus();
                    });
                }
            } catch (err) {
                term.writeln(`\x1b[31mFailed to start shell: ${err}\x1b[0m`);
            }

            // Return cleanup
            return () => {
                clearTimeout(resizeTimeout);
                inputDisposable.dispose();
                window.removeEventListener("resize", handleResize);
            };
        };

        const cleanupFn = initTerminal();

        return () => {
            mounted = false;
            cleanupFn.then(fn => fn?.());

            if (unlistenOutputRef.current) {
                unlistenOutputRef.current();
                unlistenOutputRef.current = null;
            }
            if (unlistenClosedRef.current) {
                unlistenClosedRef.current();
                unlistenClosedRef.current = null;
            }
            if (xtermRef.current) {
                xtermRef.current.dispose();
                xtermRef.current = null;
            }
            // Kill the shell session
            invoke("stop_local_shell", { sessionId }).catch(() => { });
        };
    }, [sessionId]);

    return (
        <div className="h-full bg-[#0d0d0d] overflow-hidden relative">
            {!isReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d0d] z-10">
                    <div className="flex items-center gap-2 text-zinc-500">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span className="text-sm">Starting shell...</span>
                    </div>
                </div>
            )}
            <div ref={terminalRef} className="h-full w-full" />
        </div>
    );
}
