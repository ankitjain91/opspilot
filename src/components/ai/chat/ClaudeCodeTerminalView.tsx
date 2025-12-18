import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import '@xterm/xterm/css/xterm.css';

interface ClaudeCodeTerminalViewProps {
    className?: string;
}

export function ClaudeCodeTerminalView({ className }: ClaudeCodeTerminalViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [isReady, setIsReady] = useState(false);

    // Initialize terminal
    useEffect(() => {
        if (!terminalRef.current || xtermRef.current) return;

        const term = new Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            lineHeight: 1.2,
            theme: {
                background: '#0a0a0f',
                foreground: '#e4e4e7',
                cursor: '#a78bfa',
                cursorAccent: '#0a0a0f',
                selectionBackground: '#7c3aed50',
                black: '#18181b',
                red: '#f87171',
                green: '#4ade80',
                yellow: '#fbbf24',
                blue: '#60a5fa',
                magenta: '#c084fc',
                cyan: '#22d3ee',
                white: '#fafafa',
                brightBlack: '#52525b',
                brightRed: '#fca5a5',
                brightGreen: '#86efac',
                brightYellow: '#fde047',
                brightBlue: '#93c5fd',
                brightMagenta: '#d8b4fe',
                brightCyan: '#67e8f9',
                brightWhite: '#ffffff',
            },
            scrollback: 10000,
            convertEol: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        term.open(terminalRef.current);
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        // Multiple fit attempts to ensure proper sizing
        const fitTerminal = () => {
            if (fitAddonRef.current && terminalRef.current) {
                try {
                    fitAddonRef.current.fit();
                } catch (e) {
                    console.warn('Fit failed:', e);
                }
            }
        };

        // Fit immediately and after delays
        fitTerminal();
        setTimeout(fitTerminal, 100);
        setTimeout(fitTerminal, 300);
        setTimeout(fitTerminal, 500);

        setIsReady(true);

        // Listen for PTY data
        const unlistenPromise = listen<string>('agent:terminal:data', (event) => {
            term.write(event.payload);
        });

        // Send user input to PTY
        term.onData((data) => {
            invoke('send_agent_input', { data }).catch(console.error);
        });

        // Handle window resize
        const handleResize = () => {
            fitTerminal();
            if (term.cols && term.rows) {
                invoke('resize_agent_terminal', {
                    cols: term.cols,
                    rows: term.rows,
                }).catch(() => {});
            }
        };

        window.addEventListener('resize', handleResize);

        // Observe container resize
        const resizeObserver = new ResizeObserver(() => {
            setTimeout(fitTerminal, 50);
        });
        if (containerRef.current) {
            resizeObserver.observe(containerRef.current);
        }

        return () => {
            window.removeEventListener('resize', handleResize);
            resizeObserver.disconnect();
            unlistenPromise.then(fn => fn());
            term.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
        };
    }, []);

    // Re-fit periodically to handle layout changes
    useEffect(() => {
        if (!isReady) return;

        const interval = setInterval(() => {
            fitAddonRef.current?.fit();
        }, 1000);

        return () => clearInterval(interval);
    }, [isReady]);

    return (
        <div
            ref={containerRef}
            className={`${className || ''}`}
            style={{ background: '#0a0a0f' }}
        >
            <div
                ref={terminalRef}
                style={{
                    width: '100%',
                    height: '100%',
                    padding: '8px',
                }}
            />
        </div>
    );
}
