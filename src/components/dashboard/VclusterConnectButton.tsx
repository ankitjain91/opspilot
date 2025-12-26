import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, X, Plug, AlertCircle, RefreshCw, ChevronDown, ChevronUp, Terminal, Copy, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';

interface VclusterConnectButtonProps {
    name: string;
    namespace: string;
    onConnected?: () => void;
    onConnectStart?: () => void;
    onConnectError?: (error: string) => void;
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

interface VClusterError {
    code: string;
    message: string;
    details?: string;
    suggestion?: string;
}

interface VClusterConnectProgress {
    stage: string;
    message: string;
    progress: number;
    is_error: boolean;
    error_code?: string;
    suggestion?: string;
}

// Parse error from backend (could be JSON or plain string)
function parseError(err: unknown): VClusterError {
    if (typeof err === 'string') {
        // Try to parse as JSON
        try {
            const parsed = JSON.parse(err);
            if (parsed.code && parsed.message) {
                return parsed as VClusterError;
            }
        } catch {
            // Not JSON, use as message
        }

        // Check for known error patterns
        if (err.includes('VCLUSTER_NOT_INSTALLED')) {
            return {
                code: 'VCLUSTER_NOT_INSTALLED',
                message: 'vcluster CLI is not installed',
                suggestion: 'Install vcluster CLI from https://www.vcluster.com/docs/getting-started/setup'
            };
        }

        return {
            code: 'UNKNOWN_ERROR',
            message: err,
        };
    }

    return {
        code: 'UNKNOWN_ERROR',
        message: String(err),
    };
}

// Get user-friendly stage name
function getStageName(stage: string): string {
    const stageNames: Record<string, string> = {
        preflight: 'Pre-flight Check',
        cleanup: 'Cleanup',
        connect: 'Connecting',
        context: 'Waiting for Context',
        switch: 'Switching Context',
        verify: 'Verifying',
        finalize: 'Finalizing',
        complete: 'Complete',
        error: 'Error',
    };
    return stageNames[stage] || stage;
}

export function VclusterConnectButton({ name, namespace, onConnected, onConnectStart, onConnectError }: VclusterConnectButtonProps) {
    const [state, setState] = useState<ConnectionState>('idle');
    const [progress, setProgress] = useState<VClusterConnectProgress | null>(null);
    const [error, setError] = useState<VClusterError | null>(null);
    const [showDetails, setShowDetails] = useState(false);
    const [copied, setCopied] = useState(false);
    const [retryCount, setRetryCount] = useState(0);
    const qc = useQueryClient();
    const abortRef = useRef(false);
    const connectingRef = useRef(false);
    const unlistenRef = useRef<(() => void) | null>(null);

    // Listen to progress events
    useEffect(() => {
        const setupListener = async () => {
            unlistenRef.current = await listen<VClusterConnectProgress>('vcluster-connect-progress', (event) => {
                const data = event.payload;
                setProgress(data);

                if (data.is_error) {
                    setState('error');
                    setError({
                        code: data.error_code || 'UNKNOWN_ERROR',
                        message: data.message,
                        suggestion: data.suggestion,
                    });
                }
            });
        };

        setupListener();

        return () => {
            unlistenRef.current?.();
        };
    }, []);

    // Clean up on unmount
    useEffect(() => {
        return () => {
            abortRef.current = true;
        };
    }, []);

    // Handle reload event
    useEffect(() => {
        const handler = () => {
            try {
                qc.invalidateQueries();
            } catch { }
        };
        window.addEventListener("lenskiller:reload", handler);
        return () => window.removeEventListener("lenskiller:reload", handler);
    }, [qc]);

    const handleConnect = useCallback(async () => {
        // Prevent double-click
        if (connectingRef.current) return;
        connectingRef.current = true;
        abortRef.current = false;

        onConnectStart?.();
        setState('connecting');
        setError(null);
        setProgress(null);
        setShowDetails(false);

        try {
            const result = await invoke("connect_vcluster", { name, namespace });

            if (abortRef.current) {
                setState('idle');
                return;
            }

            console.log('[vCluster] Connect success:', result);
            setState('connected');
            setRetryCount(0);

            // Clear ALL query cache to force fresh data
            qc.clear();

            // Trigger full app reload
            window.dispatchEvent(new Event("lenskiller:reload"));

            // Small delay to let the reload propagate
            await new Promise(r => setTimeout(r, 500));

            // Invalidate specific queries with immediate refetch
            const queriesToInvalidate = [
                "current_context",
                "current_context_boot",
                "current_context_global",
                "cluster_bootstrap",
                "cluster_stats",
                "cluster_cockpit",
                "initial_cluster_data",
                "vclusters",
                "discovery",
                "namespaces",
                "crd-groups",
                "metrics",
            ];

            for (const key of queriesToInvalidate) {
                await qc.invalidateQueries({ queryKey: [key], refetchType: 'all' });
            }

            // Invalidate all resource lists
            await qc.invalidateQueries({
                predicate: (q) => Array.isArray(q.queryKey) && q.queryKey.includes("list_resources"),
                refetchType: 'all'
            });

            // Show success toast
            if ((window as any).showToast) {
                (window as any).showToast(`Connected to vcluster '${name}'`, 'success');
            }

            // Callback
            onConnected?.();

        } catch (err: unknown) {
            console.error('[vCluster] Connect error:', err);
            const parsedError = parseError(err);
            setState('error');
            setError(parsedError);
            setRetryCount(prev => prev + 1);
            onConnectError?.(parsedError.message);

            if ((window as any).showToast) {
                (window as any).showToast(`Failed to connect: ${parsedError.message}`, 'error');
            }
        } finally {
            connectingRef.current = false;
        }
    }, [name, namespace, qc, onConnected, onConnectStart, onConnectError]);

    const handleCancel = useCallback(() => {
        abortRef.current = true;
        setState('idle');
        setProgress(null);
        setError(null);

        if ((window as any).showToast) {
            (window as any).showToast('Connection cancelled', 'info');
        }
    }, []);

    const handleRetry = useCallback(() => {
        setError(null);
        setState('idle');
        // Auto-retry after a brief moment
        setTimeout(() => handleConnect(), 100);
    }, [handleConnect]);

    const handleDismiss = useCallback(() => {
        setError(null);
        setState('idle');
    }, []);

    const copyToClipboard = useCallback((text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, []);

    // Render connecting state with progress
    if (state === 'connecting') {
        return (
            <div className="mt-3 space-y-2">
                {/* Progress bar */}
                <div className="relative h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                        className="absolute inset-y-0 left-0 bg-purple-500 transition-all duration-300 ease-out"
                        style={{ width: `${progress?.progress || 0}%` }}
                    />
                </div>

                {/* Status message */}
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                    <Loader2 size={14} className="animate-spin text-purple-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-purple-300">
                                {progress ? getStageName(progress.stage) : 'Preparing'}
                            </span>
                            <span className="text-xs text-purple-400/60">
                                {progress?.progress || 0}%
                            </span>
                        </div>
                        <span className="text-xs text-purple-200/80 block truncate">
                            {progress?.message || "Starting connection..."}
                        </span>
                    </div>
                </div>

                {/* Cancel button */}
                <button
                    onClick={handleCancel}
                    className="w-full px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors flex items-center justify-center gap-2"
                >
                    <X size={14} />
                    Cancel
                </button>
            </div>
        );
    }

    // Render error state with detailed information
    if (state === 'error' && error) {
        return (
            <div className="mt-3 space-y-2">
                {/* Error header */}
                <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20">
                    <div className="flex items-start gap-2">
                        <AlertCircle size={14} className="text-rose-400 flex-shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-rose-300">
                                    Connection Failed
                                </span>
                                {error.code !== 'UNKNOWN_ERROR' && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400/80 font-mono">
                                        {error.code}
                                    </span>
                                )}
                            </div>
                            <p className="text-xs text-rose-200/80 mt-0.5">
                                {error.message}
                            </p>
                        </div>
                    </div>

                    {/* Suggestion */}
                    {error.suggestion && (
                        <div className="mt-2 pt-2 border-t border-rose-500/20">
                            <p className="text-xs text-rose-200/70">
                                <span className="font-medium">Suggestion:</span> {error.suggestion}
                            </p>
                        </div>
                    )}

                    {/* Details toggle */}
                    {error.details && (
                        <>
                            <button
                                onClick={() => setShowDetails(!showDetails)}
                                className="mt-2 flex items-center gap-1 text-xs text-rose-400/70 hover:text-rose-400 transition-colors"
                            >
                                {showDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                {showDetails ? 'Hide' : 'Show'} technical details
                            </button>

                            {showDetails && (
                                <div className="mt-2 p-2 rounded bg-zinc-900/50 border border-zinc-800">
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="text-[10px] text-zinc-500 font-mono">Error Details</span>
                                        <button
                                            onClick={() => copyToClipboard(error.details || '')}
                                            className="text-zinc-500 hover:text-zinc-300 transition-colors"
                                        >
                                            {copied ? <Check size={12} /> : <Copy size={12} />}
                                        </button>
                                    </div>
                                    <pre className="text-[10px] text-zinc-400 font-mono whitespace-pre-wrap break-all">
                                        {error.details}
                                    </pre>
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Action buttons */}
                <div className="flex gap-2">
                    <button
                        onClick={handleRetry}
                        className="flex-1 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium transition-colors flex items-center justify-center gap-2"
                    >
                        <RefreshCw size={14} />
                        Retry {retryCount > 0 && `(${retryCount})`}
                    </button>
                    <button
                        onClick={handleDismiss}
                        className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
                    >
                        Dismiss
                    </button>
                </div>

                {/* Manual command hint */}
                {error.code === 'CLUSTER_UNREACHABLE' && (
                    <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <div className="flex items-center gap-2 text-xs text-amber-300">
                            <Terminal size={12} />
                            <span>Try running manually:</span>
                        </div>
                        <code className="block mt-1 text-[10px] text-amber-200/80 font-mono bg-zinc-900/50 px-2 py-1 rounded">
                            vcluster connect {name} -n {namespace}
                        </code>
                    </div>
                )}
            </div>
        );
    }

    // Render connected state
    if (state === 'connected') {
        return (
            <div className="mt-3">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <Plug size={14} className="text-emerald-400" />
                    <span className="text-xs text-emerald-200">Connected</span>
                </div>
            </div>
        );
    }

    // Idle state - show connect button
    return (
        <div className="mt-3">
            <button
                onClick={handleConnect}
                className="w-full px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white text-xs font-medium transition-colors flex items-center justify-center gap-2"
            >
                <Plug size={14} />
                Connect
            </button>
        </div>
    );
}
