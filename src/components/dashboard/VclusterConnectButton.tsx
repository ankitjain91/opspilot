import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, X, Plug, AlertCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';

interface VclusterConnectButtonProps {
    name: string;
    namespace: string;
    onConnected?: () => void;
    onConnectStart?: () => void;
    onConnectError?: (error: string) => void;
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

export function VclusterConnectButton({ name, namespace, onConnected, onConnectStart, onConnectError }: VclusterConnectButtonProps) {
    const [state, setState] = useState<ConnectionState>('idle');
    const [status, setStatus] = useState("");
    const [error, setError] = useState<string | null>(null);
    const qc = useQueryClient();
    const abortRef = useRef(false);
    const connectingRef = useRef(false);

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

        onConnectStart?.(); // Notify parent
        setState('connecting');
        setError(null);
        setStatus("Preparing connection...");

        try {
            // Step 1: Disconnect from any existing vcluster
            setStatus("Disconnecting from current vcluster...");
            try {
                await Promise.race([
                    invoke("disconnect_vcluster"),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
                ]);
            } catch {
                // Ignore - might not be connected to a vcluster
            }

            if (abortRef.current) {
                setState('idle');
                return;
            }

            // Step 2: Start vcluster connect
            setStatus("Starting vcluster proxy...");

            // Status updates for long-running connection
            const statusUpdates = [
                { delay: 2000, msg: "Waiting for proxy to initialize..." },
                { delay: 4000, msg: "Configuring kubeconfig..." },
                { delay: 6000, msg: "Verifying API connection..." },
                { delay: 10000, msg: "Establishing secure tunnel..." },
            ];

            const timeoutIds: ReturnType<typeof setTimeout>[] = [];
            statusUpdates.forEach(({ delay, msg }) => {
                const id = setTimeout(() => {
                    if (!abortRef.current) setStatus(msg);
                }, delay);
                timeoutIds.push(id);
            });

            const result = await invoke("connect_vcluster", { name, namespace });

            // Clear status timeouts
            timeoutIds.forEach(id => clearTimeout(id));

            if (abortRef.current) {
                setState('idle');
                return;
            }

            console.log('[vCluster] Connect success:', result);
            setStatus("Connected! Refreshing...");
            setState('connected');

            // Step 3: Comprehensive cache invalidation
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

        } catch (err: any) {
            console.error('[vCluster] Connect error:', err);
            setState('error');
            setError(String(err));
            onConnectError?.(String(err)); // Notify parent

            if ((window as any).showToast) {
                (window as any).showToast(`Failed to connect: ${err}`, 'error');
            }
        } finally {
            connectingRef.current = false;
        }
    }, [name, namespace, qc, onConnected, onConnectStart, onConnectError]);

    const handleCancel = useCallback(() => {
        abortRef.current = true;
        setState('idle');
        setStatus("");
        setError(null);

        if ((window as any).showToast) {
            (window as any).showToast('Connection cancelled', 'info');
        }
    }, []);

    const handleRetry = useCallback(() => {
        setError(null);
        setState('idle');
    }, []);

    // Render based on state
    if (state === 'connecting') {
        return (
            <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                    <Loader2 size={14} className="animate-spin text-purple-400 flex-shrink-0" />
                    <span className="text-xs text-purple-200 flex-1 truncate">{status || "Connecting..."}</span>
                </div>
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

    if (state === 'error') {
        return (
            <div className="mt-3 space-y-2">
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20">
                    <AlertCircle size={14} className="text-rose-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                        <span className="text-xs text-rose-200 block">Connection failed</span>
                        <span className="text-xs text-rose-400/70 block truncate">{error}</span>
                    </div>
                </div>
                <button
                    onClick={handleRetry}
                    className="w-full px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors"
                >
                    Try Again
                </button>
            </div>
        );
    }

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
