
import React from 'react';
import { Server } from 'lucide-react';
import { CollapsibleSection } from '../shared';

export function NodeDetails({ fullObject }: { fullObject: any }) {
    const status = fullObject?.status || {};
    const metadata = fullObject?.metadata || {};
    const spec = fullObject?.spec || {};
    const info = status.nodeInfo || {};

    const addresses = status.addresses || [];
    const capacity = status.capacity || {};
    const allocatable = status.allocatable || {};
    const conditions = status.conditions || [];
    const images = status.images || [];

    const formatMemory = (mem: string) => {
        if (!mem) return '-';
        // If Ki, Mi, Gi
        if (mem.endsWith('Ki')) return `${(parseInt(mem) / 1024 / 1024).toFixed(1)} Gi`;
        if (mem.endsWith('Mi')) return `${(parseInt(mem) / 1024).toFixed(1)} Gi`;
        if (mem.endsWith('Gi')) return mem;
        // If bytes (no suffix, just number)
        const num = parseInt(mem);
        if (!isNaN(num)) return `${(num / 1024 / 1024 / 1024).toFixed(1)} Gi`;
        return mem;
    };

    return (
        <CollapsibleSection title="Node Details" icon={<Server size={14} />}>
            <div className="space-y-6 text-xs">
                {/* System Info */}
                <div className="grid grid-cols-2 gap-4">
                    <div><span className="block text-[#858585] mb-1">Kernel Version</span><span className="font-mono text-[#cccccc]">{info.kernelVersion}</span></div>
                    <div><span className="block text-[#858585] mb-1">OS Image</span><span className="font-mono text-[#cccccc]">{info.osImage}</span></div>
                    <div><span className="block text-[#858585] mb-1">Container Runtime</span><span className="font-mono text-[#cccccc]">{info.containerRuntimeVersion}</span></div>
                    <div><span className="block text-[#858585] mb-1">Kubelet Version</span><span className="font-mono text-[#cccccc]">{info.kubeletVersion}</span></div>
                    <div><span className="block text-[#858585] mb-1">Architecture</span><span className="font-mono text-[#cccccc]">{info.architecture} ({info.operatingSystem})</span></div>
                    <div><span className="block text-[#858585] mb-1">Pod CIDR</span><span className="font-mono text-[#cccccc]">{spec.podCIDR || '-'}</span></div>
                </div>

                {/* Status Conditions */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Conditions</h4>
                    <div className="flex flex-wrap gap-2">
                        {conditions.map((c: any, i: number) => {
                            const isGood = (c.type === 'Ready' && c.status === 'True') || (c.type !== 'Ready' && c.status === 'False');
                            return (
                                <div key={i} className="px-2 py-1 bg-[#1e1e1e] border border-[#3e3e42] rounded flex items-center gap-1.5" title={`${c.reason}: ${c.message}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${isGood ? 'bg-green-500' : 'bg-red-500'}`} />
                                    <span className="text-[10px] text-[#cccccc]">{c.type}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Addresses */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Addresses</h4>
                    <div className="flex flex-wrap gap-2">
                        {addresses.map((a: any, i: number) => (
                            <div key={i} className="px-2 py-1 bg-[#252526] border border-[#3e3e42] rounded">
                                <span className="text-[#858585] mr-2">{a.type}:</span>
                                <span className="font-mono text-[#cccccc]">{a.address}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Taints */}
                {spec.taints && spec.taints.length > 0 && (
                    <div>
                        <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Taints</h4>
                        <div className="flex flex-wrap gap-2">
                            {spec.taints.map((t: any, i: number) => (
                                <span key={i} className="px-2 py-1 bg-[#f48771]/10 border border-[#f48771]/20 rounded text-[#f48771] font-mono">
                                    {t.key}{t.value ? `=${t.value}` : ''}:{t.effect}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Capacity / Allocatable */}
                <div className="grid grid-cols-2 gap-6">
                    <div>
                        <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Capacity</h4>
                        <div className="space-y-1">
                            <div className="flex justify-between py-1 border-b border-[#3e3e42]">
                                <span className="text-[#858585]">CPU</span>
                                <span className="font-mono text-[#cccccc]">{capacity.cpu}</span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[#3e3e42]">
                                <span className="text-[#858585]">Memory</span>
                                <span className="font-mono text-[#cccccc]">{formatMemory(capacity.memory)}</span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[#3e3e42]">
                                <span className="text-[#858585]">Pods</span>
                                <span className="font-mono text-[#cccccc]">{capacity.pods}</span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[#3e3e42]">
                                <span className="text-[#858585]">Ephemeral Storage</span>
                                <span className="font-mono text-[#cccccc]">{formatMemory(capacity['ephemeral-storage'])}</span>
                            </div>
                        </div>
                    </div>
                    <div>
                        <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Allocatable</h4>
                        <div className="space-y-1">
                            <div className="flex justify-between py-1 border-b border-[#3e3e42]">
                                <span className="text-[#858585]">CPU</span>
                                <span className="font-mono text-[#cccccc]">{allocatable.cpu}</span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[#3e3e42]">
                                <span className="text-[#858585]">Memory</span>
                                <span className="font-mono text-[#cccccc]">{formatMemory(allocatable.memory)}</span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[#3e3e42]">
                                <span className="text-[#858585]">Pods</span>
                                <span className="font-mono text-[#cccccc]">{allocatable.pods}</span>
                            </div>
                            <div className="flex justify-between py-1 border-b border-[#3e3e42]">
                                <span className="text-[#858585]">Ephemeral Storage</span>
                                <span className="font-mono text-[#cccccc]">{formatMemory(allocatable['ephemeral-storage'])}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Images Summary */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Images ({images.length})</h4>
                    <div className="text-[10px] text-[#858585]">
                        Total compressed size: {images.reduce((acc: number, img: any) => acc + (img.sizeBytes || 0), 0) / 1024 / 1024 > 1024 ?
                            `${(images.reduce((acc: number, img: any) => acc + (img.sizeBytes || 0), 0) / 1024 / 1024 / 1024).toFixed(1)} GB` :
                            `${(images.reduce((acc: number, img: any) => acc + (img.sizeBytes || 0), 0) / 1024 / 1024).toFixed(0)} MB`}
                    </div>
                </div>
            </div>
        </CollapsibleSection>
    );
}
