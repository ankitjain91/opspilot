import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    Loader2, AlertCircle, RefreshCw, Copy, Check,
    Eye, EyeOff, Lock, Key, Server, X, Database, CheckCircle2,
    Maximize2, Minimize2, ExternalLink
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utils ---
function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// --- Types ---
interface ArgoCDServerInfo {
    url: string;
    username: string;
    password: string;
    namespace: string;
    port_forward_active: boolean;
}

interface ArgoCDWebViewProps {
    onClose?: () => void;
    kubeContext?: string;
}

// --- Constants ---
const ARGOCD_SESSION_KEY = 'argocd_session';

interface ArgoCDSession {
    serverInfo: ArgoCDServerInfo;
    timestamp: number;
    isConnected: boolean;
    kubeContext: string;
}

// --- Helper Functions ---
function loadSession(currentContext: string): ArgoCDSession | null {
    try {
        const stored = sessionStorage.getItem(ARGOCD_SESSION_KEY);
        if (!stored) return null;
        const session = JSON.parse(stored) as ArgoCDSession;
        if (session.kubeContext !== currentContext) {
            sessionStorage.removeItem(ARGOCD_SESSION_KEY);
            return null;
        }
        // Session valid for 60 minutes
        const maxAge = 60 * 60 * 1000;
        if (Date.now() - session.timestamp > maxAge) {
            sessionStorage.removeItem(ARGOCD_SESSION_KEY);
            return null;
        }
        return session;
    } catch {
        return null;
    }
}

function saveSession(serverInfo: ArgoCDServerInfo, kubeContext: string): void {
    try {
        const session: ArgoCDSession = {
            serverInfo,
            timestamp: Date.now(),
            isConnected: true,
            kubeContext
        };
        sessionStorage.setItem(ARGOCD_SESSION_KEY, JSON.stringify(session));
    } catch (e) {
        console.error('Failed to save ArgoCD session:', e);
    }
}

function clearSession(): void {
    sessionStorage.removeItem(ARGOCD_SESSION_KEY);
}

export function ArgoCDWebView({ onClose, kubeContext = 'default' }: ArgoCDWebViewProps) {
    // --- State ---
    const [serverInfo, setServerInfo] = useState<ArgoCDServerInfo | null>(null);
    const [status, setStatus] = useState<'idle' | 'initializing' | 'port-forwarding' | 'connecting' | 'ready' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [showPassword, setShowPassword] = useState(false);
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const [webviewReady, setWebviewReady] = useState(false);
    const [isFromCache, setIsFromCache] = useState(false);
    const [isSessionPreserved, setIsSessionPreserved] = useState(false);

    // --- Refs ---
    const containerRef = useRef<HTMLDivElement>(null);
    const initializingRef = useRef(false);
    const previousContextRef = useRef<string>(kubeContext);
    const mountedRef = useRef(true);
    const retryCountRef = useRef(0);

    // --- Effects ---

    // 1. Context Switch Handling
    useEffect(() => {
        if (previousContextRef.current !== kubeContext) {
            console.log(`[ArgoCD] Context changed: ${previousContextRef.current} -> ${kubeContext}`);
            // Force reset everything
            invoke('force_close_argocd_webview').catch(console.error);
            clearSession();
            setWebviewReady(false);
            setServerInfo(null);
            setIsFromCache(false);
            setIsSessionPreserved(false);
            previousContextRef.current = kubeContext;
            setStatus('idle');
            // Re-init happens in the next effect due to dependency change or manual trigger
            // But we actually want to trigger init immediately
            retryCountRef.current = 0;
            initializeArgoCD(true);
        }
    }, [kubeContext]);

    // 2. Initial Load
    useEffect(() => {
        mountedRef.current = true;
        const session = loadSession(kubeContext);

        if (session && session.isConnected) {
            console.log('[ArgoCD] Restoring valid session');
            setServerInfo(session.serverInfo);
            setIsFromCache(true);
            setStatus('port-forwarding'); // Fast track
            verifyAndReconnect(session.serverInfo);
        } else {
            initializeArgoCD();
        }

        return () => {
            mountedRef.current = false;
            // On unmount, close the webview handle in backend so it doesn't float
            // But we try to keep port-forward alive for a bit if user returns
            invoke('close_argocd_webview').catch(console.error);
        };
    }, []);

    // 3. Resize Handling - The "White Screen" Fixer
    // We only attach the observer when we believe we are ready
    useEffect(() => {
        if (!containerRef.current || !webviewReady) return;

        let resizeTimeout: ReturnType<typeof setTimeout>;

        const updateBounds = () => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            // Using invoke directly for immediate updates
            invoke('update_argocd_webview_bounds', {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
            }).catch(e => console.warn("Failed to update bounds", e));
        };

        const observer = new ResizeObserver(() => {
            // Immediate update for responsiveness
            updateBounds();

            // Debounced update for final settlement
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(updateBounds, 100);
        });

        observer.observe(containerRef.current);
        // Initial sync
        setTimeout(updateBounds, 50);

        return () => {
            observer.disconnect();
            clearTimeout(resizeTimeout);
        };
    }, [webviewReady]);

    // --- Core Logic ---

    const verifyAndReconnect = async (info: ArgoCDServerInfo) => {
        if (initializingRef.current) return;
        initializingRef.current = true;

        try {
            // Even with cached info, ensure port forward is active
            setStatus('port-forwarding');
            await invoke('start_argocd_port_forward');

            setStatus('connecting');
            // We can skip getting server info if we trust the cache, but good to verify
            // For now, trust cache to be fast

            initializingRef.current = false;
        } catch (e: any) {
            console.error("Failed to restore session", e);
            // Fallback to full init
            initializingRef.current = false;
            initializeArgoCD(true);
        }
    };

    const initializeArgoCD = async (forceRefresh = false) => {
        if (initializingRef.current && !forceRefresh) return;
        initializingRef.current = true;

        if (forceRefresh) {
            clearSession();
            setIsFromCache(false);
            setWebviewReady(false);
            invoke('force_close_argocd_webview').catch(console.error);
            await invoke('stop_argocd_port_forward').catch(console.error);
        }

        setStatus('initializing');
        setError(null);

        try {
            setStatus('port-forwarding');
            await invoke('start_argocd_port_forward');

            setStatus('connecting');
            const info = await invoke<ArgoCDServerInfo>('get_argocd_server_info');

            if (!mountedRef.current) return;

            setServerInfo(info);
            setIsFromCache(false);
            saveSession(info, kubeContext);

            // Auto-open happens via effect when serverInfo is present
        } catch (e: any) {
            console.error("ArgoCD Init Error:", e);
            if (mountedRef.current) {
                setError(e?.toString() || 'Failed to connect to ArgoCD');
                setStatus('error');
            }
        } finally {
            initializingRef.current = false;
        }
    };

    // Effect to trigger webview opening once we have server info
    useEffect(() => {
        if (serverInfo && containerRef.current && !webviewReady && status !== 'error') {
            openEmbeddedWebview();
        }
    }, [serverInfo, status]);

    const openEmbeddedWebview = async () => {
        if (!containerRef.current || !serverInfo) return;

        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            // Wait for layout
            setTimeout(openEmbeddedWebview, 100);
            return;
        }

        try {
            console.log(`[ArgoCD] Opening webview at ${rect.left},${rect.top} ${rect.width}x${rect.height}`);
            const result = await invoke<string>('open_argocd_webview', {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
            });

            if (!mountedRef.current) return;

            const preserved = result.includes('session preserved');
            setIsSessionPreserved(preserved);
            setWebviewReady(true);
            setStatus('ready');

        } catch (e: any) {
            console.error('Failed to open embedded webview:', e);
            if (retryCountRef.current < 2) {
                retryCountRef.current++;
                console.log(`[ArgoCD] Retrying webview open (${retryCountRef.current}/2)...`);
                setTimeout(openEmbeddedWebview, 500);
            } else {
                setError(e?.toString() || 'Failed to open ArgoCD webview UI');
                setStatus('error');
            }
        }
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

    const isLoading = status === 'initializing' || status === 'port-forwarding' || status === 'connecting';

    return (
        <div className="flex flex-col h-full bg-zinc-950 relative overflow-hidden group">
            {/* Background Texture/Gradient for Premium Feel */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_var(--tw-gradient-stops))] from-orange-900/10 via-zinc-950 to-zinc-950 pointer-events-none" />

            {/* Header: Glassmorphism */}
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
                                        {status === 'ready' ? (isSessionPreserved ? 'Active Session' : 'Connected') : status}
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

            {/* Webview Container */}
            <div
                ref={containerRef}
                className="flex-1 relative bg-zinc-950 isolate"
            >
                {/* Loader Overlay - sits behind webview, visible when webview is transparent or loading */}
                <div className={cn(
                    "absolute inset-0 flex items-center justify-center bg-zinc-950 transition-opacity duration-700",
                    status === 'ready' ? "opacity-0 pointer-events-none" : "opacity-100 z-10"
                )}>
                    <div className="flex flex-col items-center gap-4">
                        <div className="relative">
                            <div className="absolute inset-0 bg-orange-500/20 blur-xl rounded-full animate-pulse" />
                            <Loader2 size={40} className="relative z-10 animate-spin text-orange-400" />
                        </div>
                        <div className="flex flex-col items-center gap-1">
                            <span className="text-zinc-200 font-medium tracking-wide">Connecting to ArgoCD</span>
                            <span className="text-xs text-zinc-500 font-mono uppercase tracking-widest">{status}...</span>
                        </div>
                    </div>
                </div>

                {/* The Webview Placeholder - keeps space, but Tauri overlays the actual webview on top */}
                {/* The background ensures we don't see white flashes if the webview lags */}
                <div className="absolute inset-0 bg-zinc-950" />
            </div>
        </div>
    );
}
