import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { X, Info, FileText, Settings, Code } from 'lucide-react';
import { LoadingScreen } from '../shared/LoadingScreen';

interface HelmDetailsProps {
    namespace: string;
    name: string;
    onClose: () => void;
}

interface HelmReleaseDetails {
    info: {
        status: string;
        first_deployed: string;
        last_deployed: string;
        deleted: string;
        description: string;
        notes: string;
    };
    manifest: string;
    values: any;
}

export function HelmDetails({ namespace, name, onClose }: HelmDetailsProps) {
    const [activeTab, setActiveTab] = useState<'info' | 'values' | 'manifest'>('info');

    const { data: details, isLoading, error } = useQuery({
        queryKey: ["helm_details", namespace, name],
        queryFn: async () => await invoke<HelmReleaseDetails>("helm_get_details", { namespace, name }),
    });

    if (isLoading) return (
        <div className="fixed inset-y-0 right-0 w-full md:w-[600px] lg:w-[800px] bg-[#1e1e1e] border-l border-[#3e3e42] shadow-2xl z-50 flex flex-col">
            <LoadingScreen message="Fetching Helm details..." />
        </div>
    );

    if (error) return (
        <div className="fixed inset-y-0 right-0 w-full md:w-[600px] lg:w-[800px] bg-[#1e1e1e] border-l border-[#3e3e42] shadow-2xl z-50 flex flex-col p-6">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-red-400">Error</h2>
                <button onClick={onClose}><X size={20} /></button>
            </div>
            <div className="text-zinc-400">{String(error)}</div>
        </div>
    );

    return (
        <div className="fixed inset-y-0 right-0 w-full md:w-[600px] lg:w-[800px] bg-[#1e1e1e] border-l border-[#3e3e42] shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-300">
            {/* Header */}
            <div className="h-16 border-b border-[#3e3e42] flex items-center justify-between px-6 bg-[#252526] shrink-0">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-purple-500/10 rounded">
                        <Code size={20} className="text-purple-400" />
                    </div>
                    <div>
                        <h2 className="font-bold text-white text-lg">{name}</h2>
                        <div className="text-xs text-zinc-500">{namespace}</div>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="p-2 hover:bg-white/5 rounded-full transition-colors text-zinc-400 hover:text-white"
                >
                    <X size={20} />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-[#3e3e42] bg-[#252526] px-4">
                <button
                    onClick={() => setActiveTab('info')}
                    className={`px-4 py-3 text-sm font-medium transition-colors relative ${activeTab === 'info' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    <div className="flex items-center gap-2">
                        <Info size={16} />
                        <span>Info & Notes</span>
                    </div>
                    {activeTab === 'info' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500" />}
                </button>
                <button
                    onClick={() => setActiveTab('values')}
                    className={`px-4 py-3 text-sm font-medium transition-colors relative ${activeTab === 'values' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    <div className="flex items-center gap-2">
                        <Settings size={16} />
                        <span>Values</span>
                    </div>
                    {activeTab === 'values' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500" />}
                </button>
                <button
                    onClick={() => setActiveTab('manifest')}
                    className={`px-4 py-3 text-sm font-medium transition-colors relative ${activeTab === 'manifest' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    <div className="flex items-center gap-2">
                        <FileText size={16} />
                        <span>Manifest</span>
                    </div>
                    {activeTab === 'manifest' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500" />}
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto bg-[#0d0d0d]">
                {activeTab === 'info' && (
                    <div className="p-6 space-y-6">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-[#1e1e1e] p-4 rounded border border-[#3e3e42]">
                                <div className="text-xs text-zinc-500 uppercase font-bold mb-1">Status</div>
                                <div className="text-sm text-zinc-200 capitalize">{details?.info?.status || 'Unknown'}</div>
                            </div>
                            <div className="bg-[#1e1e1e] p-4 rounded border border-[#3e3e42]">
                                <div className="text-xs text-zinc-500 uppercase font-bold mb-1">Last Deployed</div>
                                <div className="text-sm text-zinc-200">{details?.info?.last_deployed || 'N/A'}</div>
                            </div>
                        </div>

                        {details?.info?.description && (
                            <div className="bg-[#1e1e1e] p-4 rounded border border-[#3e3e42]">
                                <div className="text-xs text-zinc-500 uppercase font-bold mb-1">Description</div>
                                <div className="text-sm text-zinc-300 italic">{details.info.description}</div>
                            </div>
                        )}

                        {details?.info?.notes && (
                            <div className="space-y-2">
                                <h3 className="text-sm font-bold text-zinc-400 flex items-center gap-2">
                                    <FileText size={14} />
                                    <span>HELM NOTES</span>
                                </h3>
                                <pre className="p-4 bg-[#1e1e1e] rounded border border-[#3e3e42] text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto ring-1 ring-purple-500/10">
                                    {details.info.notes}
                                </pre>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'values' && (
                    <div className="p-6 space-y-4">
                        <h3 className="text-sm font-bold text-zinc-400 flex items-center gap-2">
                            <Settings size={14} />
                            <span>USER SUPPLIED VALUES</span>
                        </h3>
                        <pre className="p-4 bg-[#1e1e1e] rounded border border-[#3e3e42] text-xs text-emerald-400 font-mono overflow-auto max-h-[calc(100vh-250px)]">
                            {JSON.stringify(details?.values || {}, null, 2)}
                        </pre>
                    </div>
                )}

                {activeTab === 'manifest' && (
                    <div className="p-6 space-y-4 h-full">
                        <h3 className="text-sm font-bold text-zinc-400 flex items-center gap-2">
                            <FileText size={14} />
                            <span>RENDERED MANIFEST</span>
                        </h3>
                        <pre className="p-4 bg-[#1e1e1e] rounded border border-[#3e3e42] text-[10px] text-zinc-400 font-mono overflow-auto max-h-[calc(100vh-250px)] leading-tight">
                            {details?.manifest || 'No manifest data available.'}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}
