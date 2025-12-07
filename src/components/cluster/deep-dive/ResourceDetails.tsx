
import React from 'react';
import { FileCog, Box, Layers, Shield, Network, Database, Clock, Hash, Tag, Info, AlertTriangle, CheckCircle } from 'lucide-react';
import { PodDetails } from './details/PodDetails';
import { DeploymentDetails } from './details/DeploymentDetails';
import { ReplicaSetDetails } from './details/ReplicaSetDetails';
import { ServiceDetails } from './details/ServiceDetails';
import { NodeDetails } from './details/NodeDetails';
import { StorageDetails } from './details/StorageDetails';
import { ConfigDetails } from './details/ConfigDetails';
import { CollapsibleSection, renderValue, renderKV } from './shared';

interface ResourceDetailsProps {
    kind: string;
    fullObject: any;
    currentContext?: string;
}

// Helper component for generic spec/status display
function GenericResourceDetails({ kind, fullObject }: { kind: string; fullObject: any }) {
    const spec = fullObject?.spec || {};
    const status = fullObject?.status || {};
    const metadata = fullObject?.metadata || {};

    // Extract common fields
    const ownerRefs = metadata?.ownerReferences || [];
    const finalizers = metadata?.finalizers || [];
    const conditions = status?.conditions || [];

    // Render owner references
    const renderOwnerRefs = () => {
        if (ownerRefs.length === 0) return null;
        return (
            <div className="space-y-2">
                <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Owner References</h4>
                <div className="flex flex-wrap gap-1.5">
                    {ownerRefs.map((ref: any, i: number) => (
                        <span key={i} className="px-2 py-1 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={`${ref.kind}: ${ref.name}`}>
                            {ref.kind}/{ref.name}
                        </span>
                    ))}
                </div>
            </div>
        );
    };

    // Render finalizers
    const renderFinalizers = () => {
        if (finalizers.length === 0) return null;
        return (
            <div className="space-y-2">
                <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Finalizers</h4>
                <div className="flex flex-wrap gap-1">
                    {finalizers.map((f: string, i: number) => (
                        <span key={i} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-purple-500/30 rounded text-[10px] font-mono text-purple-400">{f}</span>
                    ))}
                </div>
            </div>
        );
    };

    // Render conditions
    const renderConditions = () => {
        if (conditions.length === 0) return null;
        return (
            <div className="space-y-2">
                <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Conditions</h4>
                <div className="space-y-1">
                    {conditions.map((c: any, i: number) => (
                        <div key={i} className="flex items-center gap-2 p-2 bg-[#1e1e1e] rounded border border-[#3e3e42]">
                            <div className={`w-2 h-2 rounded-full shrink-0 ${c.status === 'True' ? 'bg-green-500' : c.status === 'False' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                            <span className="text-xs font-medium text-[#cccccc]">{c.type}</span>
                            {c.reason && <span className="text-[10px] text-[#858585]">({c.reason})</span>}
                            <span className="text-[10px] text-[#585858] flex-1 truncate" title={c.message}>{c.message || ''}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    // Render spec intelligently based on content
    const renderSpec = () => {
        if (!spec || Object.keys(spec).length === 0) return null;

        // Common spec fields to highlight
        const specHighlights: { key: string; label: string; icon?: React.ReactNode }[] = [];

        if (spec.replicas !== undefined) specHighlights.push({ key: 'replicas', label: 'Replicas' });
        if (spec.selector) specHighlights.push({ key: 'selector', label: 'Selector' });
        if (spec.type) specHighlights.push({ key: 'type', label: 'Type' });
        if (spec.ports) specHighlights.push({ key: 'ports', label: 'Ports' });
        if (spec.rules) specHighlights.push({ key: 'rules', label: 'Rules' });
        if (spec.template) specHighlights.push({ key: 'template', label: 'Template' });
        if (spec.containers) specHighlights.push({ key: 'containers', label: 'Containers' });
        if (spec.volumes) specHighlights.push({ key: 'volumes', label: 'Volumes' });
        if (spec.accessModes) specHighlights.push({ key: 'accessModes', label: 'Access Modes' });
        if (spec.storageClassName) specHighlights.push({ key: 'storageClassName', label: 'Storage Class' });
        if (spec.capacity) specHighlights.push({ key: 'capacity', label: 'Capacity' });
        if (spec.claimRef) specHighlights.push({ key: 'claimRef', label: 'Claim Ref' });
        if (spec.provisioner) specHighlights.push({ key: 'provisioner', label: 'Provisioner' });
        if (spec.podSelector) specHighlights.push({ key: 'podSelector', label: 'Pod Selector' });
        if (spec.ingress) specHighlights.push({ key: 'ingress', label: 'Ingress Rules' });
        if (spec.egress) specHighlights.push({ key: 'egress', label: 'Egress Rules' });
        if (spec.roleRef) specHighlights.push({ key: 'roleRef', label: 'Role Ref' });
        if (spec.subjects) specHighlights.push({ key: 'subjects', label: 'Subjects' });
        if (spec.forProvider) specHighlights.push({ key: 'forProvider', label: 'Provider Config' });
        if (spec.providerConfigRef) specHighlights.push({ key: 'providerConfigRef', label: 'Provider Config Ref' });

        return (
            <div className="space-y-3">
                {/* Highlighted fields first */}
                {specHighlights.length > 0 && (
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        {specHighlights.slice(0, 6).map(({ key, label }) => {
                            const value = spec[key];
                            return (
                                <div key={key} className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                                    <span className="text-[#858585] text-[10px] uppercase tracking-wider block mb-1">{label}</span>
                                    <div className="text-[11px] text-[#cccccc] font-mono">
                                        {typeof value === 'object' ? (
                                            Array.isArray(value) ? (
                                                value.length > 0 ? `${value.length} items` : 'None'
                                            ) : Object.keys(value).length > 0 ? (
                                                <span className="text-[#858585]">{Object.keys(value).length} fields</span>
                                            ) : 'Empty'
                                        ) : String(value)}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Full spec in collapsible */}
                <details className="group">
                    <summary className="text-[10px] text-[#858585] cursor-pointer hover:text-[#cccccc] transition-colors">
                        View Full Spec ({Object.keys(spec).length} fields)
                    </summary>
                    <div className="mt-2 font-mono text-[10px] text-[#cccccc] overflow-auto max-h-[300px] p-2 bg-[#1e1e1e] rounded border border-[#3e3e42]">
                        {renderValue(spec)}
                    </div>
                </details>
            </div>
        );
    };

    // Render status intelligently
    const renderStatus = () => {
        if (!status || Object.keys(status).length === 0) return null;

        // Filter out conditions (rendered separately)
        const statusWithoutConditions = { ...status };
        delete statusWithoutConditions.conditions;

        if (Object.keys(statusWithoutConditions).length === 0) return null;

        // Highlight important status fields
        const statusHighlights: { key: string; value: any }[] = [];
        const statusKeys = ['phase', 'state', 'readyReplicas', 'availableReplicas', 'currentReplicas', 'observedGeneration', 'loadBalancer', 'ingress', 'addresses'];

        statusKeys.forEach(key => {
            if (statusWithoutConditions[key] !== undefined) {
                statusHighlights.push({ key, value: statusWithoutConditions[key] });
            }
        });

        return (
            <div className="space-y-2">
                <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Status</h4>
                {statusHighlights.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {statusHighlights.map(({ key, value }) => {
                            const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                            const isPhase = key === 'phase' || key === 'state';
                            const isPositive = isPhase && ['Running', 'Active', 'Bound', 'Ready', 'Succeeded', 'Available'].includes(displayValue);
                            const isNegative = isPhase && ['Failed', 'Error', 'CrashLoopBackOff', 'Pending', 'Terminating'].includes(displayValue);

                            return (
                                <div key={key} className={`px-2 py-1 rounded border text-[10px] ${isPositive ? 'bg-green-500/10 border-green-500/30 text-green-400' :
                                    isNegative ? 'bg-red-500/10 border-red-500/30 text-red-400' :
                                        'bg-[#252526] border-[#3e3e42] text-[#cccccc]'
                                    }`}>
                                    <span className="text-[#858585]">{key}: </span>
                                    <span className="font-mono">{displayValue.slice(0, 50)}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
                {Object.keys(statusWithoutConditions).length > statusHighlights.length && (
                    <details className="group">
                        <summary className="text-[10px] text-[#858585] cursor-pointer hover:text-[#cccccc] transition-colors">
                            View Full Status
                        </summary>
                        <div className="mt-2 font-mono text-[10px] text-[#cccccc] overflow-auto max-h-[200px] p-2 bg-[#1e1e1e] rounded border border-[#3e3e42]">
                            {renderValue(statusWithoutConditions)}
                        </div>
                    </details>
                )}
            </div>
        );
    };

    return (
        <CollapsibleSection title={`${kind} Details`} icon={<FileCog size={14} />}>
            <div className="space-y-4">
                {renderConditions()}
                {renderStatus()}
                {renderOwnerRefs()}
                {renderFinalizers()}
                {renderSpec()}
            </div>
        </CollapsibleSection>
    );
}

export function ResourceDetails({ kind, fullObject, currentContext }: ResourceDetailsProps) {
    const k = kind.toLowerCase();

    if (k === 'pod') {
        return <PodDetails fullObject={fullObject} currentContext={currentContext} />;
    }
    if (k === 'deployment') {
        return <DeploymentDetails fullObject={fullObject} currentContext={currentContext} />;
    }
    if (k === 'replicaset') {
        return <ReplicaSetDetails fullObject={fullObject} />;
    }
    if (k === 'service') {
        return <ServiceDetails fullObject={fullObject} currentContext={currentContext} />;
    }
    if (k === 'node') {
        return <NodeDetails fullObject={fullObject} />;
    }
    if (k === 'persistentvolumeclaim' || k === 'persistentvolume') {
        return <StorageDetails fullObject={fullObject} />;
    }
    if (k === 'configmap' || k === 'secret') {
        return <ConfigDetails kind={kind} fullObject={fullObject} />;
    }

    // Generic fallback with enhanced display
    return <GenericResourceDetails kind={kind} fullObject={fullObject} />;
}
