
import React from 'react';
import { HardDrive } from 'lucide-react';
import { CollapsibleSection } from '../shared';

export function StorageDetails({ fullObject }: { fullObject: any }) {
    const spec = fullObject?.spec || {};
    const status = fullObject?.status || {};

    return (
        <CollapsibleSection title="Storage Claim" icon={<HardDrive size={14} />}>
            <div className="space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-4">
                    <div><span className="block text-[#858585] mb-1">Status</span><span className="font-mono text-[#cccccc]">{status.phase}</span></div>
                    <div><span className="block text-[#858585] mb-1">Volume</span><span className="font-mono text-[#cccccc]">{spec.volumeName}</span></div>
                    <div><span className="block text-[#858585] mb-1">Storage Class</span><span className="font-mono text-[#cccccc]">{spec.storageClassName}</span></div>
                    <div>
                        <span className="block text-[#858585] mb-1">Capacity</span>
                        <span className="font-mono text-[#cccccc]">{status.capacity?.storage || spec.resources?.requests?.storage || '-'}</span>
                    </div>
                    <div>
                        <span className="block text-[#858585] mb-1">Access Modes</span>
                        <span className="font-mono text-[#cccccc]">{(spec.accessModes || []).join(', ')}</span>
                    </div>
                </div>
            </div>
        </CollapsibleSection>
    );
}
