
import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, Package } from 'lucide-react';
import { LoadingScreen } from '../shared/LoadingScreen';
import { HelmRelease } from '../../types/k8s';

interface HelmReleasesProps {
    currentContext?: string;
}

export function HelmReleases({ currentContext }: HelmReleasesProps) {
    const qc = useQueryClient();
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
        }
    });

    if (isLoading) return <LoadingScreen message="Loading Helm Releases..." />;

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] text-[#cccccc]">
            <div className="h-12 border-b border-[#3e3e42] flex items-center px-4 bg-[#252526] shrink-0">
                <h2 className="font-semibold text-white">Helm Releases</h2>
            </div>
            <div className="flex-1 overflow-auto p-4">
                {releases?.length === 0 && (
                    <div className="text-center text-[#858585] mt-20">No Helm releases found.</div>
                )}
                <div className="grid grid-cols-1 gap-3">
                    {releases?.map((r) => (
                        <div key={`${r.namespace}/${r.name}`} className="bg-[#252526] border border-[#3e3e42] rounded p-4 flex items-center justify-between hover:border-[#505050] transition-colors">
                            <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-3">
                                    <span className="font-bold text-white text-sm">{r.name}</span>
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${r.status === 'deployed' ? 'bg-[#89d185]/10 text-[#89d185] border-[#89d185]/20' : 'bg-[#f48771]/10 text-[#f48771] border-[#f48771]/20'}`}>
                                        {r.status}
                                    </span>
                                </div>
                                <div className="text-xs text-[#858585] flex gap-4">
                                    <span>NS: {r.namespace}</span>
                                    <span>Chart: {r.chart}</span>
                                    <span>App v{r.app_version}</span>
                                    <span>Rev: {r.revision}</span>
                                </div>
                                <div className="text-[10px] text-[#505050]">Updated: {r.updated}</div>
                            </div>
                            <button
                                onClick={() => uninstallMutation.mutate(r)}
                                className="p-2 text-[#858585] hover:text-[#f48771] hover:bg-[#3e3e42] rounded transition-colors"
                                title="Uninstall Release"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
