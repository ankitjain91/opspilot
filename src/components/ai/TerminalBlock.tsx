import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { listen } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';


interface TerminalBlockProps {
    sessionId?: string; // Optional if we support multiple sessions
    isActive?: boolean; // Whether this terminal is currently receiving input
    onInput?: (data: string) => void; // Callback when user types in terminal
    className?: string; // Tailwind classes
    theme?: 'light' | 'dark';
}

export function TerminalBlock({ isActive = true, onInput, className, theme = 'dark' }: TerminalBlockProps) {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    useEffect(() => {
        if (!terminalRef.current) return;

        // Initialize xterm.js
        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: '"Geist Mono", Menlo, Monaco, "Courier New", monospace',
            theme: {
                background: theme === 'dark' ? '#1e1e1e' : '#ffffff',
                foreground: theme === 'dark' ? '#cccccc' : '#333333',
                cursor: theme === 'dark' ? '#ffffff' : '#000000',
            },
            convertEol: false,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        // WebGL for performance if possible
        try {
            const webglAddon = new WebglAddon();
            term.loadAddon(webglAddon);
        } catch (e) {
            console.warn("WebGL addon failed to load", e);
        }

        term.open(terminalRef.current);
        fitAddon.fit();

        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        // Listen for data from backend (Claude PTY)
        const unlistenPromise = listen<string>('agent:terminal:data', (event) => {
            term.write(event.payload);
        });

        // Handle user input
        term.onData((data) => {
            if (isActive && onInput) {
                onInput(data);
            }
        });

        // Handle resize
        const handleResize = () => {
            fitAddon.fit();
        };
        window.addEventListener('resize', handleResize);

        return () => {
            term.dispose();
            window.removeEventListener('resize', handleResize);
            unlistenPromise.then(unlisten => unlisten());
        };
    }, [theme]); // Re-init if theme changes (simplistic, better to setOption)

    // Re-fit on becoming active/visible
    useEffect(() => {
        if (fitAddonRef.current) {
            setTimeout(() => fitAddonRef.current?.fit(), 100);
        }
    }, [isActive]);

    return (
        <div className={`w-full h-96 bg-[#1e1e1e] rounded-lg overflow-hidden border border-gray-700 my-2 ${className || ''}`}>
            <div ref={terminalRef} className="w-full h-full" />
        </div>
    );
}

