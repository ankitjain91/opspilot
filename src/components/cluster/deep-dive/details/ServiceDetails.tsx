
import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { Network } from 'lucide-react';
import { CollapsibleSection } from '../shared';

export function ServiceDetails({ fullObject, currentContext }: { fullObject: any, currentContext?: string }) {
    const spec = fullObject?.spec || {};
    const status = fullObject?.status || {};
    const metadata = fullObject?.metadata || {};
    const selector = spec.selector || {};

    const { data: endpoints } = useQuery({
        queryKey: ["service_endpoints", currentContext, metadata.namespace, metadata.name],
        queryFn: async () => {
            // Find pods matching selector
            if (!metadata.namespace || Object.keys(selector).length === 0) return [];
            try {
                const pods = await invoke<any[]>("list_resources", {
                    req: { group: "", version: "v1", kind: "Pod", namespace: metadata.namespace }
                });
                return pods.filter((p: any) => {
                    const pl = p.labels || {};
                    return Object.entries(selector).every(([k, v]) => pl[k] === v);
                });
            } catch { return []; }
        },
        enabled: Object.keys(selector).length > 0,
        staleTime: 10000,
    });

    return (
        <CollapsibleSection title="Service Details" icon={<Network size={14} />}>
            <div className="space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-4">
                    <div><span className="block text-[#858585] mb-1">Type</span><span className="font-mono text-[#cccccc]">{spec.type}</span></div>
                    <div><span className="block text-[#858585] mb-1">Cluster IP</span><span className="font-mono text-[#cccccc]">{spec.clusterIP}</span></div>
                    {spec.externalIPs && <div><span className="block text-[#858585] mb-1">External IPs</span><span className="font-mono text-[#cccccc]">{spec.externalIPs.join(', ')}</span></div>}
                    {spec.loadBalancerIP && <div><span className="block text-[#858585] mb-1">Load Balancer IP</span><span className="font-mono text-[#cccccc]">{spec.loadBalancerIP}</span></div>}
                    {status.loadBalancer?.ingress && (
                        <div>
                            <span className="block text-[#858585] mb-1">Ingress</span>
                            <span className="font-mono text-[#cccccc]">{status.loadBalancer.ingress.map((i: any) => i.ip || i.hostname).join(', ')}</span>
                        </div>
                    )}
                </div>

                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Ports</h4>
                    <div className="grid grid-cols-1 gap-2">
                        {(spec.ports || []).map((p: any, i: number) => (
                            <div key={i} className="px-3 py-2 bg-[#1e1e1e] border border-[#3e3e42] rounded flex items-center justify-between">
                                <span className="font-mono text-[#cccccc] font-semibold">{p.name || '-'}</span>
                                <span className="text-[#858585] uppercase text-[10px]">{p.protocol}</span>
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-cyan-400">{p.port}</span>
                                    <span className="text-[#585858]">→</span>
                                    <span className="font-mono text-purple-400">{p.targetPort}</span>
                                    {p.nodePort && <span className="text-[#585858] text-[9px]">(Node: {p.nodePort})</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Selector & Endpoints</h4>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-1">
                            {Object.keys(selector).length > 0 ? Object.entries(selector).map(([k, v]) => (
                                <span key={k} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{k}={String(v)}</span>
                            )) : <span className="text-[#858585] italic">No selector</span>}
                        </div>

                        {Object.keys(selector).length > 0 && (
                            <div className="mt-2 space-y-1">
                                <div className="text-[10px] text-[#858585]">Targeting {endpoints?.length || 0} pods:</div>
                                <div className="flex flex-wrap gap-1">
                                    {endpoints?.slice(0, 10).map((p: any) => (
                                        <span key={p.name} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={p.status}>{p.name} ({p.status})</span>
                                    ))}
                                    {endpoints && endpoints.length > 10 && <span className="text-[#858585] text-[10px]">+{endpoints.length - 10} more</span>}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </CollapsibleSection>
    );
}
