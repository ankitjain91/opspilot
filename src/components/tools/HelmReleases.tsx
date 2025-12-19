import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, Package, Search, ExternalLink } from 'lucide-react';
import { LoadingScreen } from '../shared/LoadingScreen';
import { HelmRelease } from '../../types/k8s';
import { HelmDetails } from './HelmDetails';

interface HelmReleasesProps {
    currentContext?: string;
}

export function HelmReleases({ currentContext }: HelmReleasesProps) {
    const qc = useQueryClient();
    const [selectedRelease, setSelectedRelease] = useState<{ name: string; namespace: string } | null>(null);

    const { data: releases, isLoading } = useQuery({
        queryKey: ["helm_releases", currentContext],
        queryFn: async () => await invoke<HelmRelease[]>("helm_list"),
        refetchInterval: 10000,
    });

    const uninstallMutation = useMutation({
        mutationFn: async (r: HelmRelease) => {
            if (confirm(`Uninstall ${r.name} from ${r.namespace}?`)) {
                await invoke("helm_uninstall", { namespace: r.namespace, name: r.name });
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["helm_releases"] });
            if (selectedRelease) setSelectedRelease(null);
        }
    });

    if (isLoading) return <LoadingScreen message="Loading Helm Releases..." />;

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] text-[#cccccc] relative overflow-hidden">
            <div className="h-12 border-b border-[#3e3e42] flex items-center justify-between px-4 bg-[#252526] shrink-0">
                <div className="flex items-center gap-2">
                    <Package size={18} className="text-purple-400" />
                    <h2 className="font-semibold text-white">Helm Releases</h2>
                </div>
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">
                    {releases?.length || 0} Releases
                </div>
            </div>

            <div className="flex-1 overflow-auto p-4">
                {releases?.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-64 text-[#858585]">
                        <Package size={48} className="mb-4 opacity-20" />
                        <div>No Helm releases found.</div>
                    </div>
                )}

                <div className="grid grid-cols-1 gap-2">
                    {releases?.map((r) => (
                        <div
                            key={`${r.namespace}/${r.name}`}
                            className="group bg-[#252526] border border-[#3e3e42] rounded-lg flex items-center justify-between hover:border-purple-500/50 hover:bg-[#2d2d30] transition-all cursor-pointer overflow-hidden"
                            onClick={() => setSelectedRelease({ name: r.name, namespace: r.namespace })}
                        >
                            <div className="flex-1 p-4 flex flex-col gap-1">
                                <div className="flex items-center gap-3">
                                    <span className="font-bold text-zinc-100 text-sm group-hover:text-purple-300 transition-colors">{r.name}</span>
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${r.status === 'deployed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                                        {r.status.toUpperCase()}
                                    </span>
                                </div>
                                <div className="text-xs text-zinc-500 flex flex-wrap gap-x-4 gap-y-1">
                                    <span className="flex items-center gap-1.5"><span className="text-[9px] text-zinc-600 font-bold">NS</span> {r.namespace}</span>
                                    <span className="flex items-center gap-1.5"><span className="text-[9px] text-zinc-600 font-bold">CHART</span> {r.chart}</span>
                                    <span className="flex items-center gap-1.5"><span className="text-[9px] text-zinc-600 font-bold">REV</span> {r.revision}</span>
                                </div>
                                <div className="text-[10px] text-zinc-600 mt-1 italic">Updated: {r.updated}</div>
                            </div>

                            <div className="flex items-center pr-2 gap-1 translate-x-2 group-hover:translate-x-0 transition-transform opacity-0 group-hover:opacity-100">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        uninstallMutation.mutate(r);
                                    }}
                                    className="p-2.5 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-all"
                                    title="Uninstall Release"
                                >
                                    <Trash2 size={16} />
                                </button>
                                <div className="p-2.5 text-zinc-500">
                                    <ExternalLink size={16} />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Detailed View Panel */}
            {selectedRelease && (
                <>
                    <div
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 animate-in fade-in duration-300"
                        onClick={() => setSelectedRelease(null)}
                    />
                    <HelmDetails
                        name={selectedRelease.name}
                        namespace={selectedRelease.namespace}
                        onClose={() => setSelectedRelease(null)}
                    />
                </>
            )}
        </div>
    );
}
