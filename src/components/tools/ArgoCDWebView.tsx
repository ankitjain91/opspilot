import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    Loader2, AlertCircle, RefreshCw, Copy, Check,
    Eye, EyeOff, Lock, Key, Server, X, ExternalLink
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utils ---
function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// --- Types ---
interface ArgoCDServerInfo {
    url: string; // Now points to Proxy
    username: string;
    password: string;
    namespace: string;
    port_forward_active: boolean;
}

interface ArgoCDWebViewProps {
    onClose?: () => void;
    kubeContext?: string;
}

export function ArgoCDWebView({ onClose, kubeContext = 'default' }: ArgoCDWebViewProps) {
    // --- State ---
    const [serverInfo, setServerInfo] = useState<ArgoCDServerInfo | null>(null);
    const [status, setStatus] = useState<'idle' | 'initializing' | 'port-forwarding' | 'connecting' | 'ready' | 'error'>('idle');
    const [statusMessage, setStatusMessage] = useState<string>('Ready');
    const [error, setError] = useState<string | null>(null);
    const [showPassword, setShowPassword] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const [iframeLoaded, setIframeLoaded] = useState(false);

    // --- Refs ---
    const initializingRef = useRef(false);
    const previousContextRef = useRef<string>(kubeContext);
    const mountedRef = useRef(true);
    const retryCountRef = useRef(0);

    // --- Effects ---

    // 1. Context Switch Handling
    useEffect(() => {
        if (previousContextRef.current !== kubeContext) {
            console.log(`[ArgoCD] Context changed: ${previousContextRef.current} -> ${kubeContext}`);
            setStatusMessage(`Disconnecting from ${previousContextRef.current}...`);
            // Stop port forward for old context
            invoke('stop_argocd_port_forward').catch(console.error);

            setServerInfo(null);
            setIframeLoaded(false);
            previousContextRef.current = kubeContext;
            setStatus('idle');
            retryCountRef.current = 0;
            initializeArgoCD(true);
        }
    }, [kubeContext]);

    // 2. Initial Load
    useEffect(() => {
        mountedRef.current = true;
        initializeArgoCD();

        return () => {
            mountedRef.current = false;
            // Clean up port forward on unmount
            invoke('stop_argocd_port_forward').catch(console.error);
        };
    }, []);

    // --- Core Logic ---

    const initializeArgoCD = async (forceRefresh = false) => {
        if (initializingRef.current && !forceRefresh) return;
        initializingRef.current = true;

        if (forceRefresh) {
            setServerInfo(null);
            setIframeLoaded(false);
            await invoke('stop_argocd_port_forward').catch(console.error);
        }

        setStatus('initializing');
        setStatusMessage('Initializing ArgoCD connection...');
        setError(null);

        try {
            setStatus('port-forwarding');
            setStatusMessage('Establishing secure port-forward & proxy...');
            // This now starts both kubectl port-forward AND the axum proxy
            await invoke('start_argocd_port_forward');

            setStatus('connecting');
            setStatusMessage('Retrieving ArgoCD credentials...');
            const info = await invoke<ArgoCDServerInfo>('get_argocd_server_info');

            if (!mountedRef.current) return;

            console.log("[ArgoCD] Proxy Info:", info);
            setServerInfo(info);
            setStatusMessage('Loading Interface...');
            // Status will switch to 'ready' when iframe loads

        } catch (e: any) {
            console.error("ArgoCD Init Error:", e);
            if (mountedRef.current) {
                setError(e?.toString() || 'Failed to connect to ArgoCD');
                setStatus('error');
                setStatusMessage('Connection failed');
            }
        } finally {
            initializingRef.current = false;
        }
    };

    const handleIframeLoad = () => {
        console.log("[ArgoCD] IFrame Loaded");
        setIframeLoaded(true);
        setStatus('ready');
        setStatusMessage('Connected');
    };

    const handleRetry = () => {
        retryCountRef.current = 0;
        initializeArgoCD(true);
    };

    const copyToClipboard = async (text: string, field: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedField(field);
            setTimeout(() => setCopiedField(null), 2000);
        } catch (e) { console.error(e); }
    };

    // --- Render Helpers ---

    if (error) {
        return (
            <div className="flex items-center justify-center h-full bg-zinc-950/50 backdrop-blur-sm">
                <div className="text-center max-w-md p-8 rounded-2xl bg-zinc-900/80 border border-white/5 shadow-2xl">
                    <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                        <AlertCircle size={32} className="text-red-400" />
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2">Connection Failed</h3>
                    <p className="text-zinc-400 text-sm mb-6 leading-relaxed">{error}</p>
                    <button
                        onClick={handleRetry}
                        className="group relative px-6 py-3 bg-gradient-to-r from-orange-600 to-red-600 text-white rounded-xl font-medium shadow-lg shadow-orange-900/20 hover:shadow-orange-900/40 transition-all active:scale-95"
                    >
                        <span className="flex items-center gap-2">
                            <RefreshCw size={18} className="group-hover:rotate-180 transition-transform duration-500" />
                            Retry Connection
                        </span>
                    </button>
                </div>
            </div>
        );
    }

    const isLoading = status === 'initializing' || status === 'port-forwarding' || status === 'connecting' || (status !== 'error' && !iframeLoaded);

    return (
        <div className="flex flex-col h-full bg-zinc-950 relative overflow-hidden group">
            {/* Background Texture */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_var(--tw-gradient-stops))] from-orange-900/10 via-zinc-950 to-zinc-950 pointer-events-none" />

            {/* Header */}
            <div className="shrink-0 relative z-20 border-b border-white/5 bg-zinc-900/60 backdrop-blur-md px-4 py-3 shadow-sm transition-all duration-300">
                <div className="flex items-center justify-between">
                    {/* Left: Branding & Status */}
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5">
                            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center shadow-inner">
                                <Server size={18} className="text-white drop-shadow-md" />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-bold text-white tracking-wide">ArgoCD</span>
                                <div className="flex items-center gap-1.5">
                                    <div className={cn(
                                        "w-1.5 h-1.5 rounded-full",
                                        status === 'ready' ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" : "bg-orange-400 animate-pulse"
                                    )} />
                                    <span className="text-[10px] uppercase font-medium text-zinc-400 tracking-wider">
                                        {status === 'ready' ? 'Connected' : status}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Quick Actions (only if we have server info) */}
                        {serverInfo && (
                            <div className="hidden md:flex items-center gap-2 animate-in fade-in slide-in-from-left-4 duration-500">
                                <div className="h-8 w-px bg-white/10 mx-2" />

                                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group/creds">
                                    <Key size={14} className="text-zinc-500 group-hover/creds:text-orange-400 transition-colors" />
                                    <span className="text-xs text-zinc-300 font-mono">admin</span>
                                    <button
                                        onClick={() => copyToClipboard('admin', 'username')}
                                        className="ml-1 p-1 hover:bg-white/10 rounded-md transition-colors"
                                    >
                                        {copiedField === 'username' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} className="text-zinc-500" />}
                                    </button>
                                </div>

                                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group/pass">
                                    <Lock size={14} className="text-zinc-500 group-hover/pass:text-orange-400 transition-colors" />
                                    <span className="text-xs text-zinc-300 font-mono min-w-[60px]">
                                        {showPassword ? serverInfo.password : '••••••••'}
                                    </span>
                                    <div className="flex items-center border-l border-white/10 ml-1 pl-1">
                                        <button
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="p-1 hover:bg-white/10 rounded-md text-zinc-500 hover:text-zinc-300"
                                        >
                                            {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                                        </button>
                                        <button
                                            onClick={() => copyToClipboard(serverInfo.password, 'password')}
                                            className="p-1 hover:bg-white/10 rounded-md text-zinc-500 hover:text-zinc-300"
                                        >
                                            {copiedField === 'password' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Right: Window Controls */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => initializeArgoCD(true)}
                            className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                            title="Force Refresh Connection"
                        >
                            <RefreshCw size={16} className={cn("transition-transform", isLoading && "animate-spin")} />
                        </button>
                        {serverInfo?.url && (
                            <a
                                href={serverInfo.url}
                                target="_blank"
                                rel="noreferrer"
                                className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                title="Open in Default Browser"
                            >
                                <ExternalLink size={16} />
                            </a>
                        )}
                        {onClose && (
                            <button
                                onClick={onClose}
                                className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                title="Close Panel"
                            >
                                <X size={16} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* IFrame Container */}
            <div className="flex-1 relative bg-zinc-950 isolate">
                {/* Loader Overlay */}
                {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 z-20">
                        <div className="flex flex-col items-center gap-4">
                            <div className="relative">
                                <div className="absolute inset-0 bg-orange-500/20 blur-xl rounded-full animate-pulse" />
                                <Loader2 size={40} className="relative z-10 animate-spin text-orange-400" />
                            </div>
                            <div className="flex flex-col items-center gap-1">
                                <span className="text-zinc-200 font-medium tracking-wide">Connecting to ArgoCD</span>
                                <span className="text-xs text-zinc-500 font-mono uppercase tracking-widest animate-pulse">{statusMessage}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* The Magic IFrame */}
                {serverInfo && (
                    <iframe
                        src={serverInfo.url}
                        className={cn(
                            "w-full h-full border-none transition-opacity duration-500",
                            iframeLoaded ? "opacity-100" : "opacity-0"
                        )}
                        onLoad={handleIframeLoad}
                        title="ArgoCD Interface"
                        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                    />
                )}
            </div>
        </div>
    );
}
