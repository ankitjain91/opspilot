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
        <div>
            {connecting ? (
                <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2 px-3 py-2.5 rounded-md bg-cyan-900/50 border border-cyan-500/30">
                        <Loader2 size={14} className="animate-spin text-cyan-400" />
                        <span className="text-xs text-cyan-200 flex-1">{status || "Initializing..."}</span>
                    </div>
                    <button
                        onClick={() => {
                            setConnecting(false);
                            setStatus("");
                            if ((window as any).showToast) {
                                (window as any).showToast('Connection cancelled', 'info');
                            }
                        }}
                        className="w-full px-3 py-1.5 rounded-md bg-zinc-700/50 hover:bg-zinc-600/50 text-zinc-300 text-xs font-medium transition-all flex items-center justify-center gap-1.5"
                    >
                        <X size={12} />
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
                            setStatus("Connected! Loading cluster...");
                            setConnected(true);
                            // Toast notify
                            if ((window as any).showToast) {
                                (window as any).showToast(`Connected to vcluster '${name}' in namespace '${namespace}'`, 'success');
                            }
                            // Clear all caches - backend caches are already cleared in connect_vcluster
                            // Clear frontend React Query caches
                            qc.clear();
                            await qc.invalidateQueries({ queryKey: ["current_context"] });
                            await qc.invalidateQueries({ queryKey: ["cluster_stats"] });
                            await qc.invalidateQueries({ queryKey: ["cluster_cockpit"] });
                            await qc.invalidateQueries({ queryKey: ["initial_cluster_data"] });
                            await qc.invalidateQueries({ queryKey: ["vclusters"] });
                            await qc.invalidateQueries({ queryKey: ["discovery"] });
                            await qc.invalidateQueries({ queryKey: ["namespaces"] });
                            await qc.invalidateQueries({ queryKey: ["crd-groups"] });
                            await qc.invalidateQueries({ queryKey: ["metrics"] });
                            // Also refetch any resource lists that depend on context
                            await qc.invalidateQueries({ predicate: (q) => Array.isArray(q.queryKey) && q.queryKey.includes("list_resources") });
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
                    className={`w-full mt-3 px-3 py-2 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 ${connecting ? 'bg-cyan-800 text-white cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-700 text-white'}`}
                >
                    <Plug size={14} />
                    Connect to vcluster
                </button>
            )}
            {connected && (
                <div className="mt-2 text-xs flex items-center gap-2 text-green-400">
                    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.707a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 10-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" /></svg>
                    Connected to {name}. Refreshing data...
                </div>
            )}
        </div>
    );
}
