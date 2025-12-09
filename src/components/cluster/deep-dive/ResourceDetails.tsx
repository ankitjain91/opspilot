
import React, { useState, useMemo } from 'react';
import { FileCog, Box, Layers, Shield, Network, Database, Clock, Hash, Tag, Info, AlertTriangle, CheckCircle, X, Maximize2, Copy, Check, Search } from 'lucide-react';
import yaml from 'js-yaml';
import { PodDetails } from './details/PodDetails';
import { DeploymentDetails } from './details/DeploymentDetails';
import { ReplicaSetDetails } from './details/ReplicaSetDetails';
import { ServiceDetails } from './details/ServiceDetails';
import { NodeDetails } from './details/NodeDetails';
import { StorageDetails } from './details/StorageDetails';
import { ConfigDetails } from './details/ConfigDetails';
import { CollapsibleSection, renderValue, renderKV } from './shared';

// YAML Syntax Highlighter - makes YAML much more readable
function YamlHighlight({ content }: { content: string }) {
    const highlightYaml = (yamlStr: string) => {
        return yamlStr.split('\n').map((line, i) => {
            // Empty lines
            if (!line.trim()) return <div key={i} className="h-4" />;

            // Determine indentation
            const indent = line.match(/^(\s*)/)?.[1]?.length || 0;
            const trimmed = line.trimStart();

            // Comments
            if (trimmed.startsWith('#')) {
                return (
                    <div key={i} className="leading-relaxed" style={{ paddingLeft: `${indent * 8}px` }}>
                        <span className="text-zinc-500 italic">{trimmed}</span>
                    </div>
                );
            }

            // Key-value pairs
            const keyMatch = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
            if (keyMatch) {
                const [, key, value] = keyMatch;
                const isArrayItem = line.trimStart().startsWith('- ');

                // Handle different value types
                let valueElement = null;
                if (value) {
                    const trimmedValue = value.trim();
                    if (trimmedValue === 'true' || trimmedValue === 'false') {
                        valueElement = <span className={trimmedValue === 'true' ? 'text-emerald-400' : 'text-rose-400'}>{value}</span>;
                    } else if (/^-?\d+(\.\d+)?$/.test(trimmedValue)) {
                        valueElement = <span className="text-amber-400">{value}</span>;
                    } else if (trimmedValue.startsWith('"') || trimmedValue.startsWith("'")) {
                        valueElement = <span className="text-green-400">{value}</span>;
                    } else if (trimmedValue === 'null' || trimmedValue === '~') {
                        valueElement = <span className="text-zinc-500 italic">{value}</span>;
                    } else {
                        valueElement = <span className="text-green-400">{value}</span>;
                    }
                }

                return (
                    <div key={i} className="leading-relaxed" style={{ paddingLeft: `${indent * 8}px` }}>
                        <span className="text-cyan-400">{key}</span>
                        <span className="text-zinc-500">:</span>
                        {valueElement && <span> {valueElement}</span>}
                    </div>
                );
            }

            // Array items (- value)
            if (trimmed.startsWith('- ')) {
                const itemValue = trimmed.slice(2);
                const itemKeyMatch = itemValue.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);

                if (itemKeyMatch) {
                    const [, key, value] = itemKeyMatch;
                    return (
                        <div key={i} className="leading-relaxed" style={{ paddingLeft: `${indent * 8}px` }}>
                            <span className="text-purple-400">-</span>
                            <span> </span>
                            <span className="text-cyan-400">{key}</span>
                            <span className="text-zinc-500">:</span>
                            {value && <span className="text-green-400"> {value}</span>}
                        </div>
                    );
                }

                return (
                    <div key={i} className="leading-relaxed" style={{ paddingLeft: `${indent * 8}px` }}>
                        <span className="text-purple-400">-</span>
                        <span className="text-green-400"> {itemValue}</span>
                    </div>
                );
            }

            // Fallback - plain text
            return (
                <div key={i} className="leading-relaxed text-zinc-300" style={{ paddingLeft: `${indent * 8}px` }}>
                    {trimmed}
                </div>
            );
        });
    };

    return (
        <div className="font-mono text-xs">
            {highlightYaml(content)}
        </div>
    );
}

// Details Modal - beautiful popup with search
function DetailsModal({ isOpen, onClose, title, content, yamlContent }: {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content?: React.ReactNode;
    yamlContent?: string;
}) {
    const [searchQuery, setSearchQuery] = useState('');
    const [copied, setCopied] = useState(false);

    // Filter YAML content by search query - MUST be before early return to maintain hook order
    const filteredYaml = useMemo(() => {
        if (!yamlContent || !searchQuery) return yamlContent;
        const lines = yamlContent.split('\n');
        const matchingLines: number[] = [];

        // Find all matching line indices
        lines.forEach((line, i) => {
            if (line.toLowerCase().includes(searchQuery.toLowerCase())) {
                matchingLines.push(i);
            }
        });

        // Include context (2 lines before/after each match)
        const contextLines = new Set<number>();
        matchingLines.forEach(i => {
            for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
                contextLines.add(j);
            }
        });

        // If no matches, show all
        if (matchingLines.length === 0) return yamlContent;

        return lines.map((line, i) => contextLines.has(i) ? line : null)
            .filter(line => line !== null)
            .join('\n');
    }, [yamlContent, searchQuery]);

    // Early return AFTER all hooks
    if (!isOpen) return null;

    const handleCopy = async () => {
        if (yamlContent) {
            await navigator.clipboard.writeText(yamlContent);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div
                className="bg-zinc-900 border border-cyan-500/30 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-gradient-to-r from-cyan-500/10 to-zinc-900">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-cyan-500/20 rounded-lg">
                            <FileCog size={18} className="text-cyan-400" />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-white">{title}</h3>
                            <p className="text-sm text-zinc-400">Resource Details</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {yamlContent && (
                            <button
                                onClick={handleCopy}
                                className={`p-2 rounded-lg transition-colors ${
                                    copied ? 'bg-green-500/20 text-green-400' : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                                }`}
                                title="Copy YAML"
                            >
                                {copied ? <Check size={18} /> : <Copy size={18} />}
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* Search Bar */}
                {yamlContent && (
                    <div className="px-5 py-3 border-b border-zinc-800 bg-zinc-900/50">
                        <div className="relative">
                            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                            <input
                                type="text"
                                placeholder="Search in YAML..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-10 pr-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-cyan-500/50"
                                autoFocus
                            />
                            {searchQuery && (
                                <button
                                    onClick={() => setSearchQuery('')}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5">
                    {content ? (
                        <div className="bg-zinc-800/50 rounded-xl p-5 border border-zinc-700/50">
                            {content}
                        </div>
                    ) : yamlContent ? (
                        <div className="bg-[#0d1117] rounded-xl p-5 border border-zinc-700/50">
                            <YamlHighlight content={filteredYaml || ''} />
                        </div>
                    ) : null}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/50 flex justify-between items-center">
                    <span className="text-xs text-zinc-500">
                        {yamlContent && `${yamlContent.split('\n').length} lines`}
                    </span>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

interface ResourceDetailsProps {
    kind: string;
    fullObject: any;
    currentContext?: string;
}

// Helper component for generic spec/status display
function GenericResourceDetails({ kind, fullObject }: { kind: string; fullObject: any }) {
    const [specModalOpen, setSpecModalOpen] = useState(false);
    const [statusModalOpen, setStatusModalOpen] = useState(false);

    const spec = fullObject?.spec || {};
    const status = fullObject?.status || {};
    const metadata = fullObject?.metadata || {};

    // Extract common fields
    const ownerRefs = metadata?.ownerReferences || [];
    const finalizers = metadata?.finalizers || [];
    const conditions = status?.conditions || [];

    // Generate YAML strings for modals
    const specYaml = Object.keys(spec).length > 0 ? yaml.dump(spec, { indent: 2, lineWidth: 120, noRefs: true }) : '';
    const statusYaml = Object.keys(status).length > 0 ? yaml.dump(status, { indent: 2, lineWidth: 120, noRefs: true }) : '';

    // Render owner references
    const renderOwnerRefs = () => {
        if (ownerRefs.length === 0) return null;
        return (
            <div className="space-y-2">
                <h4 className="text-[11px] uppercase tracking-wider text-[#7f7f8a] font-bold">Owner References</h4>
                <div className="flex flex-wrap gap-1.5">
                    {ownerRefs.map((ref: any, i: number) => (
                        <span key={i} className="px-2 py-1 bg-[#0f0f16] border border-[#1f1f2b] rounded text-[10px] font-mono text-[#e5e7eb]" title={`${ref.kind}: ${ref.name}`}>
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
                <h4 className="text-[11px] uppercase tracking-wider text-[#7f7f8a] font-bold">Finalizers</h4>
                <div className="flex flex-wrap gap-1">
                    {finalizers.map((f: string, i: number) => (
                        <span key={i} className="px-1.5 py-0.5 bg-[#11111a] border border-purple-500/30 rounded text-[10px] font-mono text-purple-300">{f}</span>
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
                <h4 className="text-[11px] uppercase tracking-wider text-[#7f7f8a] font-bold">Conditions</h4>
                <div className="space-y-1.5">
                    {conditions.map((c: any, i: number) => {
                        const statusColor = c.status === 'True' ? 'bg-green-500/20 border-green-500/40 text-green-300' :
                            c.status === 'False' ? 'bg-red-500/20 border-red-500/40 text-red-300' :
                                'bg-yellow-500/15 border-yellow-500/30 text-yellow-200';
                        const dot = c.status === 'True' ? 'bg-green-400' : c.status === 'False' ? 'bg-red-400' : 'bg-yellow-400';
                        return (
                            <div key={i} className={`flex items-center gap-2 p-2 rounded border ${statusColor} backdrop-blur-sm`}>
                                <div className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                                <span className="text-xs font-semibold truncate">{c.type}</span>
                                {c.reason && <span className="text-[10px] text-[#9ca3af]">({c.reason})</span>}
                                <span className="text-[10px] text-[#7f7f8a] flex-1 truncate" title={c.message}>{c.message || ''}</span>
                            </div>
                        );
                    })}
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
                                <div key={key} className="p-2 bg-[#0f0f16] border border-[#1f1f2b] rounded">
                                    <span className="text-[#7f7f8a] text-[10px] uppercase tracking-wider block mb-1">{label}</span>
                                    <div className="text-[11px] text-[#e5e7eb] font-mono">
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

                {/* Full spec with expand button */}
                <div className="bg-[#0b0b10] rounded-xl border border-[#1a1a22] overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-[#0f0f16] border-b border-[#1a1a22]">
                        <span className="text-xs text-zinc-400">
                            Resource Spec ({Object.keys(spec).length} fields)
                        </span>
                        <button
                            onClick={() => setSpecModalOpen(true)}
                            className="p-1.5 text-zinc-500 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition-colors"
                            title="Expand Spec"
                        >
                            <Maximize2 size={14} />
                        </button>
                    </div>
                    <div className="p-3 overflow-auto max-h-[300px]">
                        <YamlHighlight content={specYaml} />
                    </div>
                </div>
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
                <h4 className="text-[11px] uppercase tracking-wider text-[#7f7f8a] font-bold">Status</h4>
                {statusHighlights.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {statusHighlights.map(({ key, value }) => {
                            const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                            const isPhase = key === 'phase' || key === 'state';
                            const isPositive = isPhase && ['Running', 'Active', 'Bound', 'Ready', 'Succeeded', 'Available'].includes(displayValue);
                            const isNegative = isPhase && ['Failed', 'Error', 'CrashLoopBackOff', 'Pending', 'Terminating'].includes(displayValue);

                            return (
                                <div key={key} className={`px-2 py-1 rounded border text-[10px] ${isPositive ? 'bg-green-500/10 border-green-500/30 text-green-300' :
                                    isNegative ? 'bg-red-500/10 border-red-500/30 text-red-300' :
                                        'bg-[#0f0f16] border-[#1f1f2b] text-[#e5e7eb]'
                                    }`}>
                                    <span className="text-[#7f7f8a]">{key}: </span>
                                    <span className="font-mono">{displayValue.slice(0, 50)}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
                {Object.keys(statusWithoutConditions).length > statusHighlights.length && (
                    <details className="group">
                        <summary className="text-[10px] text-[#7f7f8a] cursor-pointer hover:text-[#e5e7eb] transition-colors">
                            View Full Status
                        </summary>
                        <div className="mt-2 font-mono text-[10px] text-[#e5e7eb] overflow-auto max-h-[200px] p-2 bg-[#0b0b10] rounded border border-[#1a1a22]">
                            {renderValue(statusWithoutConditions)}
                        </div>
                    </details>
                )}
            </div>
        );
    };

    return (
        <>
            {/* Spec Modal */}
            <DetailsModal
                isOpen={specModalOpen}
                onClose={() => setSpecModalOpen(false)}
                title={`${kind} Spec`}
                yamlContent={specYaml}
            />

            {/* Status Modal */}
            <DetailsModal
                isOpen={statusModalOpen}
                onClose={() => setStatusModalOpen(false)}
                title={`${kind} Status`}
                yamlContent={statusYaml}
            />

            <CollapsibleSection title={`${kind} Details`} icon={<FileCog size={14} />}>
                <div className="space-y-4">
                    {renderConditions()}
                    {renderStatus()}
                    {renderOwnerRefs()}
                    {renderFinalizers()}
                    {renderSpec()}
                </div>
            </CollapsibleSection>
        </>
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
