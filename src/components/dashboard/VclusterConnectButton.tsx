import { useState, useEffect } from 'react';
import { Loader2, X, Plug } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';

export function VclusterConnectButton({ name, namespace }: { name: string, namespace: string }) {
    const [connecting, setConnecting] = useState(false);
    const [connected, setConnected] = useState(false);
    const [status, setStatus] = useState("");
    const qc = useQueryClient();

    // Handle Reload button: invalidate queries globally when event fires
    useEffect(() => {
        const handler = () => {
            try {
                qc.invalidateQueries();
            } catch { }
        };
        window.addEventListener("lenskiller:reload", handler);
        return () => window.removeEventListener("lenskiller:reload", handler);
    }, [qc]);

    return (
        <div className="mt-3">
            {connecting ? (
                <div className="space-y-2">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                        <Loader2 size={14} className="animate-spin text-purple-400 flex-shrink-0" />
                        <span className="text-xs text-purple-200 flex-1 truncate">{status || "Initializing..."}</span>
                    </div>
                    <button
                        onClick={() => {
                            setConnecting(false);
                            setStatus("");
                            if ((window as any).showToast) {
                                (window as any).showToast('Connection cancelled', 'info');
                            }
                        }}
                        className="w-full px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors flex items-center justify-center gap-2"
                    >
                        <X size={14} />
                        Cancel
                    </button>
                </div>
            ) : (
                <button
                    onClick={async () => {
                        try {
                            setConnecting(true);
                            setStatus("Disconnecting from current vcluster...");

                            // First disconnect from any existing vcluster
                            try {
                                await Promise.race([
                                    invoke("disconnect_vcluster"),
                                    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
                                ]);
                            } catch (e) {
                                // Ignore - might not be connected to a vcluster
                            }

                            setStatus("Starting vcluster proxy...");

                            // Status updates to show progress
                            const statusUpdates = [
                                { delay: 500, msg: "Starting vcluster proxy..." },
                                { delay: 2000, msg: "Waiting for proxy to initialize..." },
                                { delay: 4000, msg: "Configuring kubeconfig..." },
                                { delay: 6000, msg: "Verifying API connection..." },
                                { delay: 10000, msg: "Establishing secure tunnel..." },
                            ];

                            const timeoutIds: ReturnType<typeof setTimeout>[] = [];
                            statusUpdates.forEach(({ delay, msg }) => {
                                const id = setTimeout(() => setStatus(msg), delay);
                                timeoutIds.push(id);
                            });

                            const result = await invoke("connect_vcluster", {
                                name,
                                namespace
                            });

                            // Clear status timeouts
                            timeoutIds.forEach(id => clearTimeout(id));

                            console.log('vcluster connect success:', result);
                            setStatus("Connected! Switching context...");

                            // Toast notify
                            if ((window as any).showToast) {
                                (window as any).showToast(`Connected to vcluster '${name}' in namespace '${namespace}'`, 'success');
                            }

                            // Clear all caches - backend caches are already cleared in connect_vcluster
                            // Clear frontend React Query caches completely
                            qc.clear();

                            // Invalidate all context-related queries with immediate refetch
                            await qc.invalidateQueries({ queryKey: ["current_context"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["current_context_boot"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["current_context_global"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["cluster_bootstrap"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["cluster_stats"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["cluster_cockpit"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["initial_cluster_data"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["vclusters"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["discovery"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["namespaces"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["crd-groups"], refetchType: 'all' });
                            await qc.invalidateQueries({ queryKey: ["metrics"], refetchType: 'all' });

                            // Also refetch any resource lists that depend on context
                            await qc.invalidateQueries({
                                predicate: (q) => Array.isArray(q.queryKey) && q.queryKey.includes("list_resources"),
                                refetchType: 'all'
                            });

                            // Trigger reload event to refresh the entire app
                            window.dispatchEvent(new Event("lenskiller:reload"));
                        } catch (err) {
                            console.error('vcluster connect error:', err);
                            if ((window as any).showToast) {
                                (window as any).showToast(`Failed to connect: ${err}`, 'error');
                            }
                            alert(`Error: ${err}\n\nTo connect manually, run:\nvcluster connect ${name} -n ${namespace}`);
                        } finally {
                            setConnecting(false);
                            setStatus("");
                        }
                    }}
                    disabled={connecting}
                    className="w-full px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 active:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors flex items-center justify-center gap-2"
                >
                    <Plug size={14} />
                    Connect
                </button>
            )}
        </div>
    );
}
