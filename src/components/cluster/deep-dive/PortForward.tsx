
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';

export function PortForwardModal({ isOpen, onClose, namespace, podName }: { isOpen: boolean, onClose: () => void, namespace: string, podName: string }) {
    const [localPort, setLocalPort] = useState("");
    const [podPort, setPodPort] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const qc = useQueryClient();

    const handleStart = async () => {
        setIsLoading(true);
        setError(null);
        try {
            await invoke("start_port_forward", {
                namespace,
                name: podName,
                localPort: parseInt(localPort),
                podPort: parseInt(podPort)
            });
            qc.invalidateQueries({ queryKey: ["portforwards"] });
            onClose();
        } catch (err: any) {
            setError(err.toString());
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-6 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
                <h3 className="text-lg font-semibold text-white mb-4">Port Forward</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-xs font-medium text-[#858585] mb-1.5 uppercase tracking-wide">Local Port</label>
                        <input
                            type="number"
                            value={localPort}
                            onChange={e => setLocalPort(e.target.value)}
                            className="w-full bg-[#3c3c3c] border border-[#3e3e42] rounded px-3 py-2 text-sm text-[#cccccc] focus:outline-none focus:border-[#007acc]"
                            placeholder="e.g. 8080"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-[#858585] mb-1.5 uppercase tracking-wide">Pod Port</label>
                        <input
                            type="number"
                            value={podPort}
                            onChange={e => setPodPort(e.target.value)}
                            className="w-full bg-[#3c3c3c] border border-[#3e3e42] rounded px-3 py-2 text-sm text-[#cccccc] focus:outline-none focus:border-[#007acc]"
                            placeholder="e.g. 80"
                        />
                    </div>

                    {error && (
                        <div className="text-[#f48771] text-xs bg-[#f48771]/10 p-2 rounded border border-[#f48771]/20">
                            {error}
                        </div>
                    )}

                    <div className="flex justify-end gap-2 mt-6">
                        <button onClick={onClose} className="px-4 py-2 text-sm text-[#cccccc] hover:bg-[#3e3e42] rounded transition-colors">Cancel</button>
                        <button
                            onClick={handleStart}
                            disabled={isLoading || !localPort || !podPort}
                            className="px-4 py-2 text-sm bg-[#007acc] hover:bg-[#0062a3] text-white rounded transition-colors disabled:opacity-50"
                        >
                            {isLoading ? "Starting..." : "Start Forwarding"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function PortForwardList({ currentContext }: { currentContext?: string }) {
    const qc = useQueryClient();
    const { data: forwards } = useQuery({
        queryKey: ["portforwards", currentContext],
        queryFn: async () => await invoke<any[]>("list_port_forwards"),
        refetchInterval: 5000,
    });

    const stopMutation = useMutation({
        mutationFn: async (id: string) => {
            await invoke("stop_port_forward", { sessionId: id });
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["portforwards"] });
        }
    });

    if (!forwards || forwards.length === 0) return null;

    return (
        <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2">
            {forwards.map((pf: any) => (
                <div key={pf.id} className="bg-[#252526] border border-[#3e3e42] rounded-md shadow-lg p-3 flex items-center gap-4 animate-in slide-in-from-bottom-5">
                    <div className="flex flex-col">
                        <span className="text-xs font-medium text-white flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-[#89d185] animate-pulse" />
                            {pf.local_port} → {pf.pod_port}
                        </span>
                        <span className="text-[10px] text-[#858585]">{pf.pod_name}</span>
                    </div>
                    <button
                        onClick={() => stopMutation.mutate(pf.id)}
                        className="p-1 text-[#858585] hover:text-[#f48771] hover:bg-[#3e3e42] rounded transition-colors"
                    >
                        <X size={14} />
                    </button>
                </div>
            ))}
        </div>
    );
}
