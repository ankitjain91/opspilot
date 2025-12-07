
import React from 'react';
import { Package } from 'lucide-react';
import { CollapsibleSection } from '../shared';

export function ReplicaSetDetails({ fullObject }: { fullObject: any }) {
    const spec = fullObject?.spec || {};
    const status = fullObject?.status || {};
    const replicas = spec.replicas ?? 1;
    const readyReplicas = status.readyReplicas || 0;
    const availableReplicas = status.availableReplicas || 0;
    const tplContainers = spec.template?.spec?.containers || [];

    return (
        <CollapsibleSection title="ReplicaSet Details" icon={<Package size={14} />}>
            <div className="space-y-4 text-xs">
                {/* Replicas */}
                <div className="grid grid-cols-3 gap-3">
                    <div className="p-2 bg-[#252526] border border-[#3e3e42] rounded text-center">
                        <div className="text-lg font-mono text-purple-400">{replicas}</div>
                        <div className="text-[9px] text-[#858585]">Desired</div>
                    </div>
                    <div className="p-2 bg-[#252526] border border-[#3e3e42] rounded text-center">
                        <div className={`text-lg font-mono ${readyReplicas === replicas ? 'text-green-400' : 'text-yellow-400'}`}>{readyReplicas}</div>
                        <div className="text-[9px] text-[#858585]">Ready</div>
                    </div>
                    <div className="p-2 bg-[#252526] border border-[#3e3e42] rounded text-center">
                        <div className={`text-lg font-mono ${availableReplicas === replicas ? 'text-green-400' : 'text-orange-400'}`}>{availableReplicas}</div>
                        <div className="text-[9px] text-[#858585]">Available</div>
                    </div>
                </div>
                {/* Selector */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Selector</h4>
                    <div className="flex flex-wrap gap-1">
                        {spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => (
                            <span key={k} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{k}={String(v)}</span>
                        )) : <span className="text-[#858585] italic">None</span>}
                    </div>
                </div>
                {/* Template Containers */}
                <div>
                    <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Template Containers</h4>
                    <div className="flex flex-wrap gap-1.5">
                        {tplContainers.map((c: any, i: number) => (
                            <span key={i} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={c.image}>{c.name}</span>
                        ))}
                    </div>
                </div>
            </div>
        </CollapsibleSection>
    );
}
