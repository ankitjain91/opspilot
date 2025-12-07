
import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import {
    Layers, Activity, Box, Cpu, HardDrive, Network, Shield, Key, Variable,
    FolderOpen, CheckCircle2, XCircle, AlertCircle, Clock, RefreshCw, Play,
    ChevronRight, Copy, Check, X, Search, Eye, EyeOff, Lock, Unlock,
    Server, Tag, Maximize2, Settings, Terminal, ArrowRight
} from 'lucide-react';
import { CollapsibleSection } from '../shared';
import { MetricsChart } from '../MetricsChart';

interface PodDetailsProps {
    fullObject: any;
    currentContext?: string;
}

// Env Var Modal with values - now with pod metadata to resolve field refs
function EnvVarsModal({ isOpen, onClose, container, envVars, podMetadata, podSpec, podStatus }: {
    isOpen: boolean;
    onClose: () => void;
    container: string;
    envVars: any[];
    podMetadata?: any;
    podSpec?: any;
    podStatus?: any;
}) {
    const [searchTerm, setSearchTerm] = useState('');
    const [showSecrets, setShowSecrets] = useState(false);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);

    if (!isOpen) return null;

    // Resolve field ref values from pod metadata/spec/status
    const resolveFieldRef = (fieldPath: string): string | null => {
        if (!fieldPath) return null;

        // Common field paths and their values
        const fieldMap: Record<string, string | undefined> = {
            'metadata.name': podMetadata?.name,
            'metadata.namespace': podMetadata?.namespace,
            'metadata.uid': podMetadata?.uid,
            'metadata.labels': podMetadata?.labels ? JSON.stringify(podMetadata.labels) : undefined,
            'metadata.annotations': podMetadata?.annotations ? JSON.stringify(podMetadata.annotations) : undefined,
            'spec.nodeName': podSpec?.nodeName,
            'spec.serviceAccountName': podSpec?.serviceAccountName,
            'status.podIP': podStatus?.podIP,
            'status.hostIP': podStatus?.hostIP,
            'status.phase': podStatus?.phase,
        };

        // Direct match
        if (fieldMap[fieldPath]) {
            return fieldMap[fieldPath]!;
        }

        // Try to resolve nested paths like metadata.labels['app']
        const labelMatch = fieldPath.match(/metadata\.labels\['(.+)'\]/);
        if (labelMatch && podMetadata?.labels) {
            return podMetadata.labels[labelMatch[1]] || null;
        }

        const annotationMatch = fieldPath.match(/metadata\.annotations\['(.+)'\]/);
        if (annotationMatch && podMetadata?.annotations) {
            return podMetadata.annotations[annotationMatch[1]] || null;
        }

        return null;
    };

    // Resolve resource field ref (CPU/memory limits/requests)
    const resolveResourceFieldRef = (resource: string, containerName?: string): string | null => {
        if (!resource || !podSpec?.containers) return null;

        // Find the container
        const targetContainer = containerName
            ? podSpec.containers.find((c: any) => c.name === containerName)
            : podSpec.containers.find((c: any) => c.name === container);

        if (!targetContainer?.resources) return null;

        const resourceMap: Record<string, string | undefined> = {
            'limits.cpu': targetContainer.resources?.limits?.cpu,
            'limits.memory': targetContainer.resources?.limits?.memory,
            'requests.cpu': targetContainer.resources?.requests?.cpu,
            'requests.memory': targetContainer.resources?.requests?.memory,
        };

        return resourceMap[resource] || null;
    };

    const handleCopy = async (key: string, value: string) => {
        await navigator.clipboard.writeText(`${key}=${value}`);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
    };

    const filteredVars = envVars.filter(e =>
        e.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (e.value && e.value.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    // Categorize env vars
    const secretVars = filteredVars.filter(e => e.valueFrom?.secretKeyRef);
    const configMapVars = filteredVars.filter(e => e.valueFrom?.configMapKeyRef);
    const fieldRefVars = filteredVars.filter(e => e.valueFrom?.fieldRef || e.valueFrom?.resourceFieldRef);
    const plainVars = filteredVars.filter(e => e.value !== undefined && !e.valueFrom);

    const renderEnvVar = (e: any) => {
        const isSecret = e.valueFrom?.secretKeyRef;
        const isConfigMap = e.valueFrom?.configMapKeyRef;
        const isFieldRef = e.valueFrom?.fieldRef;
        const isResourceFieldRef = e.valueFrom?.resourceFieldRef;
        const isSensitive = /password|secret|token|key|api|auth|credential/i.test(e.name);

        let displayValue = '';
        let resolvedValue: string | null = null;
        let source = '';

        if (e.value !== undefined) {
            displayValue = isSensitive && !showSecrets ? '••••••••' : e.value;
            resolvedValue = e.value;
        } else if (isSecret) {
            const secretRef = e.valueFrom.secretKeyRef;
            source = `from Secret "${secretRef.name}" key "${secretRef.key}"`;
            displayValue = '(value hidden in Secret)';
        } else if (isConfigMap) {
            const cmRef = e.valueFrom.configMapKeyRef;
            source = `from ConfigMap "${cmRef.name}" key "${cmRef.key}"`;
            displayValue = '(value stored in ConfigMap)';
        } else if (isFieldRef) {
            const fieldPath = e.valueFrom.fieldRef.fieldPath;
            resolvedValue = resolveFieldRef(fieldPath);
            source = `fieldRef: ${fieldPath}`;
            displayValue = resolvedValue || '(unable to resolve)';
        } else if (isResourceFieldRef) {
            const resource = e.valueFrom.resourceFieldRef.resource;
            const containerName = e.valueFrom.resourceFieldRef.containerName;
            resolvedValue = resolveResourceFieldRef(resource, containerName);
            source = `resourceFieldRef: ${resource}`;
            displayValue = resolvedValue || '(unable to resolve)';
        }

        return (
            <div
                key={e.name}
                className={`group p-3 rounded-xl border transition-all hover:shadow-md ${isSecret
                    ? 'bg-red-500/5 border-red-500/20 hover:border-red-500/40'
                    : isConfigMap
                        ? 'bg-blue-500/5 border-blue-500/20 hover:border-blue-500/40'
                        : (isFieldRef || isResourceFieldRef)
                            ? 'bg-purple-500/5 border-purple-500/20 hover:border-purple-500/40'
                            : 'bg-zinc-800/30 border-zinc-700 hover:border-zinc-600'
                    }`}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            {isSecret && <Lock size={12} className="text-red-400" />}
                            {isConfigMap && <Settings size={12} className="text-blue-400" />}
                            {(isFieldRef || isResourceFieldRef) && <Server size={12} className="text-purple-400" />}
                            {isSensitive && !isSecret && !isConfigMap && !isFieldRef && !isResourceFieldRef && <Key size={12} className="text-yellow-400" />}
                            <span className={`text-xs font-semibold ${isSecret ? 'text-red-400' : isConfigMap ? 'text-blue-400' : (isFieldRef || isResourceFieldRef) ? 'text-purple-400' : 'text-cyan-400'
                                }`}>
                                {e.name}
                            </span>
                        </div>
                        <div className={`text-sm font-mono break-all ${resolvedValue ? 'text-white' : 'text-zinc-500 italic'}`}>
                            {displayValue}
                        </div>
                        {source && (
                            <div className="text-[10px] text-zinc-500 mt-1">
                                {source}
                            </div>
                        )}
                    </div>
                    {resolvedValue && (
                        <button
                            onClick={() => handleCopy(e.name, resolvedValue!)}
                            className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-zinc-700 rounded-lg transition-all shrink-0"
                            title="Copy"
                        >
                            {copiedKey === e.name ? <Check size={12} className="text-green-400" /> : <Copy size={12} className="text-zinc-400" />}
                        </button>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-800/50">
                    <div className="flex items-center gap-3 min-w-0">
                        <Variable size={18} className="text-cyan-400 shrink-0" />
                        <h3 className="text-lg font-semibold text-white truncate">Environment Variables</h3>
                        <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full shrink-0">
                            {container}
                        </span>
                        <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full shrink-0">
                            {envVars.length} vars
                        </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            onClick={() => setShowSecrets(!showSecrets)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border ${showSecrets
                                ? 'text-yellow-300 bg-yellow-500/20 border-yellow-500/30'
                                : 'text-zinc-400 bg-zinc-800 border-zinc-700 hover:bg-zinc-700'
                                }`}
                        >
                            {showSecrets ? <Eye size={12} /> : <EyeOff size={12} />}
                            {showSecrets ? 'Hide Secrets' : 'Show Secrets'}
                        </button>
                        <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Search */}
                <div className="px-5 py-3 border-b border-zinc-800/50">
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Search environment variables..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
                        />
                    </div>
                </div>

                {/* Legend */}
                <div className="px-5 py-2 border-b border-zinc-800/50 bg-zinc-800/20 flex items-center gap-4 text-[10px]">
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded bg-red-500" />
                        <span className="text-zinc-400">Secret ({secretVars.length})</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded bg-blue-500" />
                        <span className="text-zinc-400">ConfigMap ({configMapVars.length})</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded bg-purple-500" />
                        <span className="text-zinc-400">Field Ref ({fieldRefVars.length})</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded bg-zinc-500" />
                        <span className="text-zinc-400">Plain ({plainVars.length})</span>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 space-y-2">
                    {filteredVars.length > 0 ? (
                        filteredVars.map(renderEnvVar)
                    ) : (
                        <div className="text-center py-8 text-zinc-500">
                            <Search size={24} className="mx-auto mb-2 opacity-30" />
                            <p className="text-sm">No environment variables found</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// Container Detail Modal
function ContainerDetailModal({ isOpen, onClose, container, status }: {
    isOpen: boolean;
    onClose: () => void;
    container: any;
    status: any;
}) {
    const [copiedValue, setCopiedValue] = useState<string | null>(null);

    if (!isOpen || !container) return null;

    const handleCopy = async (value: string) => {
        await navigator.clipboard.writeText(value);
        setCopiedValue(value);
        setTimeout(() => setCopiedValue(null), 2000);
    };

    let stateInfo = { state: 'Unknown', color: 'zinc', reason: '', message: '', startedAt: '' };
    if (status?.state?.running) {
        stateInfo = { state: 'Running', color: 'emerald', reason: '', message: '', startedAt: status.state.running.startedAt || '' };
    } else if (status?.state?.waiting) {
        stateInfo = { state: 'Waiting', color: 'yellow', reason: status.state.waiting.reason || '', message: status.state.waiting.message || '', startedAt: '' };
    } else if (status?.state?.terminated) {
        stateInfo = { state: 'Terminated', color: 'red', reason: status.state.terminated.reason || '', message: status.state.terminated.message || '', startedAt: '' };
    }

    const securityContext = container.securityContext || {};

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className={`flex items-center justify-between px-5 py-4 border-b bg-${stateInfo.color}-500/10 border-${stateInfo.color}-500/20`}>
                    <div className="flex items-center gap-3 min-w-0">
                        <Box size={18} className={`text-${stateInfo.color}-400 shrink-0`} />
                        <h3 className="text-lg font-semibold text-white truncate">{container.name}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full bg-${stateInfo.color}-500/20 text-${stateInfo.color}-400 shrink-0`}>
                            {stateInfo.state}
                        </span>
                    </div>
                    <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg">
                        <X size={18} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* Image */}
                    <div className="space-y-2">
                        <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">Image</h4>
                        <div
                            className="group flex items-center gap-2 p-3 bg-zinc-800/50 rounded-xl border border-zinc-700 cursor-pointer hover:border-zinc-600"
                            onClick={() => handleCopy(container.image)}
                        >
                            <span className="text-sm font-mono text-zinc-300 break-all flex-1">{container.image}</span>
                            {copiedValue === container.image ? <Check size={14} className="text-green-400 shrink-0" /> : <Copy size={14} className="opacity-0 group-hover:opacity-50 text-zinc-400 shrink-0" />}
                        </div>
                        {container.imagePullPolicy && (
                            <div className="text-[10px] text-zinc-500">Pull Policy: <span className="text-zinc-400">{container.imagePullPolicy}</span></div>
                        )}
                    </div>

                    {/* Status Details */}
                    {(stateInfo.reason || stateInfo.message || status?.restartCount > 0) && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">Status Details</h4>
                            <div className="grid grid-cols-2 gap-3">
                                {stateInfo.reason && (
                                    <div className="p-3 bg-zinc-800/50 rounded-xl border border-zinc-700">
                                        <div className="text-[10px] text-zinc-500 mb-1">Reason</div>
                                        <div className={`text-sm text-${stateInfo.color}-400`}>{stateInfo.reason}</div>
                                    </div>
                                )}
                                {status?.restartCount !== undefined && (
                                    <div className="p-3 bg-zinc-800/50 rounded-xl border border-zinc-700">
                                        <div className="text-[10px] text-zinc-500 mb-1">Restart Count</div>
                                        <div className={`text-sm ${status.restartCount > 0 ? 'text-orange-400' : 'text-zinc-300'}`}>{status.restartCount}</div>
                                    </div>
                                )}
                            </div>
                            {stateInfo.message && (
                                <div className="p-3 bg-zinc-800/50 rounded-xl border border-zinc-700">
                                    <div className="text-[10px] text-zinc-500 mb-1">Message</div>
                                    <div className="text-sm text-zinc-300">{stateInfo.message}</div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Resources */}
                    {(container.resources?.requests || container.resources?.limits) && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">Resources</h4>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 bg-zinc-800/50 rounded-xl border border-zinc-700">
                                    <div className="text-[10px] text-zinc-500 mb-2">Requests</div>
                                    <div className="space-y-1.5">
                                        {container.resources?.requests?.cpu && (
                                            <div className="flex items-center gap-2">
                                                <Cpu size={12} className="text-green-400" />
                                                <span className="text-xs text-zinc-400">CPU:</span>
                                                <span className="text-xs font-mono text-white">{container.resources.requests.cpu}</span>
                                            </div>
                                        )}
                                        {container.resources?.requests?.memory && (
                                            <div className="flex items-center gap-2">
                                                <HardDrive size={12} className="text-blue-400" />
                                                <span className="text-xs text-zinc-400">Memory:</span>
                                                <span className="text-xs font-mono text-white">{container.resources.requests.memory}</span>
                                            </div>
                                        )}
                                        {!container.resources?.requests?.cpu && !container.resources?.requests?.memory && (
                                            <span className="text-xs text-zinc-500 italic">Not set</span>
                                        )}
                                    </div>
                                </div>
                                <div className="p-3 bg-zinc-800/50 rounded-xl border border-zinc-700">
                                    <div className="text-[10px] text-zinc-500 mb-2">Limits</div>
                                    <div className="space-y-1.5">
                                        {container.resources?.limits?.cpu && (
                                            <div className="flex items-center gap-2">
                                                <Cpu size={12} className="text-green-400" />
                                                <span className="text-xs text-zinc-400">CPU:</span>
                                                <span className="text-xs font-mono text-white">{container.resources.limits.cpu}</span>
                                            </div>
                                        )}
                                        {container.resources?.limits?.memory && (
                                            <div className="flex items-center gap-2">
                                                <HardDrive size={12} className="text-blue-400" />
                                                <span className="text-xs text-zinc-400">Memory:</span>
                                                <span className="text-xs font-mono text-white">{container.resources.limits.memory}</span>
                                            </div>
                                        )}
                                        {!container.resources?.limits?.cpu && !container.resources?.limits?.memory && (
                                            <span className="text-xs text-zinc-500 italic">Not set</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Ports */}
                    {Array.isArray(container.ports) && container.ports.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">Ports</h4>
                            <div className="flex flex-wrap gap-2">
                                {container.ports.map((p: any, i: number) => (
                                    <div key={i} className="flex items-center gap-2 px-3 py-2 bg-zinc-800/50 rounded-xl border border-zinc-700">
                                        <Network size={12} className="text-cyan-400" />
                                        <span className="text-xs font-mono text-white">{p.containerPort}</span>
                                        <span className="text-[10px] text-zinc-500">/{p.protocol || 'TCP'}</span>
                                        {p.name && <span className="text-[10px] text-zinc-400">({p.name})</span>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Security Context */}
                    {Object.keys(securityContext).length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">Security Context</h4>
                            <div className="grid grid-cols-2 gap-2">
                                {securityContext.runAsUser !== undefined && (
                                    <div className="flex items-center gap-2 p-2 bg-zinc-800/50 rounded-lg border border-zinc-700">
                                        <span className="text-[10px] text-zinc-500">runAsUser:</span>
                                        <span className="text-xs font-mono text-white">{securityContext.runAsUser}</span>
                                    </div>
                                )}
                                {securityContext.runAsNonRoot !== undefined && (
                                    <div className="flex items-center gap-2 p-2 bg-zinc-800/50 rounded-lg border border-zinc-700">
                                        <span className="text-[10px] text-zinc-500">runAsNonRoot:</span>
                                        <span className={`text-xs font-mono ${securityContext.runAsNonRoot ? 'text-green-400' : 'text-red-400'}`}>
                                            {String(securityContext.runAsNonRoot)}
                                        </span>
                                    </div>
                                )}
                                {securityContext.readOnlyRootFilesystem !== undefined && (
                                    <div className="flex items-center gap-2 p-2 bg-zinc-800/50 rounded-lg border border-zinc-700">
                                        <span className="text-[10px] text-zinc-500">readOnlyRootFilesystem:</span>
                                        <span className={`text-xs font-mono ${securityContext.readOnlyRootFilesystem ? 'text-green-400' : 'text-yellow-400'}`}>
                                            {String(securityContext.readOnlyRootFilesystem)}
                                        </span>
                                    </div>
                                )}
                                {securityContext.privileged !== undefined && (
                                    <div className="flex items-center gap-2 p-2 bg-zinc-800/50 rounded-lg border border-zinc-700">
                                        <span className="text-[10px] text-zinc-500">privileged:</span>
                                        <span className={`text-xs font-mono ${securityContext.privileged ? 'text-red-400' : 'text-green-400'}`}>
                                            {String(securityContext.privileged)}
                                        </span>
                                    </div>
                                )}
                                {securityContext.allowPrivilegeEscalation !== undefined && (
                                    <div className="flex items-center gap-2 p-2 bg-zinc-800/50 rounded-lg border border-zinc-700 col-span-2">
                                        <span className="text-[10px] text-zinc-500">allowPrivilegeEscalation:</span>
                                        <span className={`text-xs font-mono ${securityContext.allowPrivilegeEscalation ? 'text-red-400' : 'text-green-400'}`}>
                                            {String(securityContext.allowPrivilegeEscalation)}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Probes */}
                    {(container.livenessProbe || container.readinessProbe || container.startupProbe) && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">Health Probes</h4>
                            <div className="space-y-2">
                                {['livenessProbe', 'readinessProbe', 'startupProbe'].map((probeKey) => {
                                    const probe = container[probeKey];
                                    if (!probe) return null;

                                    const type = probe.httpGet ? 'HTTP' : probe.tcpSocket ? 'TCP' : probe.exec ? 'Exec' : probe.grpc ? 'gRPC' : 'Unknown';
                                    let detail = '';
                                    if (probe.httpGet) detail = `${probe.httpGet.scheme || 'HTTP'}://:${probe.httpGet.port}${probe.httpGet.path || '/'}`;
                                    else if (probe.tcpSocket) detail = `Port ${probe.tcpSocket.port}`;
                                    else if (probe.exec) detail = (probe.exec.command || []).join(' ');
                                    else if (probe.grpc) detail = `Port ${probe.grpc.port}`;

                                    const probeColor = probeKey === 'livenessProbe' ? 'red' : probeKey === 'readinessProbe' ? 'green' : 'blue';

                                    return (
                                        <div key={probeKey} className={`p-3 bg-${probeColor}-500/5 rounded-xl border border-${probeColor}-500/20`}>
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className={`text-xs font-bold text-${probeColor}-400`}>{probeKey.replace('Probe', '')}</span>
                                                <span className={`text-[10px] px-1.5 py-0.5 rounded bg-${probeColor}-500/20 text-${probeColor}-400`}>{type}</span>
                                            </div>
                                            <div className="text-xs font-mono text-zinc-300 mb-2 break-all">{detail}</div>
                                            <div className="flex flex-wrap gap-3 text-[10px] text-zinc-500">
                                                {probe.initialDelaySeconds !== undefined && <span>delay: <span className="text-zinc-400">{probe.initialDelaySeconds}s</span></span>}
                                                {probe.periodSeconds !== undefined && <span>period: <span className="text-zinc-400">{probe.periodSeconds}s</span></span>}
                                                {probe.timeoutSeconds !== undefined && <span>timeout: <span className="text-zinc-400">{probe.timeoutSeconds}s</span></span>}
                                                {probe.successThreshold !== undefined && <span>success: <span className="text-green-400">{probe.successThreshold}</span></span>}
                                                {probe.failureThreshold !== undefined && <span>failure: <span className="text-red-400">{probe.failureThreshold}</span></span>}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Volume Mounts */}
                    {Array.isArray(container.volumeMounts) && container.volumeMounts.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">Volume Mounts</h4>
                            <div className="space-y-1.5">
                                {container.volumeMounts.map((m: any, i: number) => (
                                    <div key={i} className="flex items-center gap-2 p-2 bg-zinc-800/50 rounded-lg border border-zinc-700">
                                        <FolderOpen size={12} className={m.readOnly ? 'text-yellow-400' : 'text-cyan-400'} />
                                        <span className="text-xs font-mono text-cyan-400">{m.name}</span>
                                        <ArrowRight size={10} className="text-zinc-600" />
                                        <span className="text-xs font-mono text-zinc-300 flex-1 truncate">{m.mountPath}</span>
                                        {m.readOnly && <span className="text-[9px] text-yellow-400 bg-yellow-500/10 px-1.5 py-0.5 rounded">RO</span>}
                                        {m.subPath && <span className="text-[9px] text-zinc-500">subPath: {m.subPath}</span>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// Resource gauge component
function ResourceGauge({ label, used, limit, unit, color }: { label: string; used?: string; limit?: string; unit: string; color: string }) {
    const parseValue = (val?: string): number => {
        if (!val) return 0;
        if (val.endsWith('m')) return parseFloat(val) / 1000;
        if (val.endsWith('Mi')) return parseFloat(val);
        if (val.endsWith('Gi')) return parseFloat(val) * 1024;
        if (val.endsWith('Ki')) return parseFloat(val) / 1024;
        return parseFloat(val);
    };

    const usedVal = parseValue(used);
    const limitVal = parseValue(limit);
    const percentage = limitVal > 0 ? Math.min((usedVal / limitVal) * 100, 100) : 0;

    const getBarColor = () => {
        if (percentage >= 90) return 'bg-red-500';
        if (percentage >= 70) return 'bg-yellow-500';
        return color;
    };

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-500">{label}</span>
                <span className="font-mono text-zinc-300">{used || 'N/A'} / {limit || '∞'}</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                    className={`h-full ${getBarColor()} transition-all duration-300`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
        </div>
    );
}

export function PodDetails({ fullObject, currentContext }: PodDetailsProps) {
    const [activeContainer, setActiveContainer] = useState<string>('');
    const [envModalOpen, setEnvModalOpen] = useState(false);
    const [selectedContainerForEnv, setSelectedContainerForEnv] = useState<any>(null);
    const [containerDetailOpen, setContainerDetailOpen] = useState(false);
    const [selectedContainerDetail, setSelectedContainerDetail] = useState<any>(null);

    // Extract data from fullObject (can be empty)
    const spec = fullObject?.spec || {};
    const status = fullObject?.status || {};
    const metadata = fullObject?.metadata || {};

    const containers = spec.containers || [];
    const initContainers = spec.initContainers || [];
    const cStatuses: Record<string, any> = {};
    (status.containerStatuses || []).forEach((cs: any) => { cStatuses[cs.name] = cs; });
    const initCStatuses: Record<string, any> = {};
    (status.initContainerStatuses || []).forEach((cs: any) => { initCStatuses[cs.name] = cs; });
    const volumes = spec.volumes || [];

    // useEffect MUST be called unconditionally (before any returns)
    useEffect(() => {
        if (containers.length > 0 && !containers.find((c: any) => c.name === activeContainer)) {
            setActiveContainer(containers[0].name);
        }
    }, [containers, activeContainer]);

    // Handle loading state AFTER all hooks
    if (!fullObject || Object.keys(fullObject).length === 0) {
        return (
            <CollapsibleSection title="Pod Details" icon={<Layers size={14} />}>
                <div className="flex items-center justify-center p-8 text-zinc-500">
                    <span className="animate-pulse">Loading pod details...</span>
                </div>
            </CollapsibleSection>
        );
    }

    // Calculate QoS class
    const getQoSClass = () => {
        const allContainers = [...containers, ...initContainers];
        if (allContainers.length === 0) return 'BestEffort';

        let allGuaranteed = true;
        let anyRequestOrLimit = false;

        for (const c of allContainers) {
            const requests = c.resources?.requests || {};
            const limits = c.resources?.limits || {};

            if (requests.cpu || requests.memory || limits.cpu || limits.memory) {
                anyRequestOrLimit = true;
            }

            if (!(limits.cpu && limits.memory && requests.cpu && requests.memory &&
                requests.cpu === limits.cpu && requests.memory === limits.memory)) {
                allGuaranteed = false;
            }
        }

        if (!anyRequestOrLimit) return 'BestEffort';
        if (allGuaranteed) return 'Guaranteed';
        return 'Burstable';
    };

    const qosClass = status?.qosClass || getQoSClass();
    const securityContext = spec?.securityContext || {};

    const openEnvModal = (container: any) => {
        setSelectedContainerForEnv(container);
        setEnvModalOpen(true);
    };

    const openContainerDetail = (container: any) => {
        setSelectedContainerDetail(container);
        setContainerDetailOpen(true);
    };

    const getContainerState = (cs: any) => {
        if (cs?.state?.running) return { state: 'Running', color: 'emerald' };
        if (cs?.state?.waiting) return { state: cs.state.waiting.reason || 'Waiting', color: 'yellow' };
        if (cs?.state?.terminated) return { state: cs.state.terminated.reason || 'Terminated', color: 'red' };
        return { state: 'Unknown', color: 'zinc' };
    };

    return (
        <div className="space-y-4">
            {/* Env Vars Modal */}
            {selectedContainerForEnv && (
                <EnvVarsModal
                    isOpen={envModalOpen}
                    onClose={() => setEnvModalOpen(false)}
                    container={selectedContainerForEnv.name}
                    envVars={selectedContainerForEnv.env || []}
                    podMetadata={metadata}
                    podSpec={spec}
                    podStatus={status}
                />
            )}

            {/* Container Detail Modal */}
            {selectedContainerDetail && (
                <ContainerDetailModal
                    isOpen={containerDetailOpen}
                    onClose={() => setContainerDetailOpen(false)}
                    container={selectedContainerDetail}
                    status={cStatuses[selectedContainerDetail.name]}
                />
            )}

            {/* Metrics */}
            <CollapsibleSection title="Resource Metrics" icon={<Activity size={14} />}>
                <MetricsChart
                    resourceKind="Pod"
                    namespace={metadata.namespace || 'default'}
                    name={metadata.name || ''}
                    currentContext={currentContext}
                />
            </CollapsibleSection>

            <CollapsibleSection title="Pod Details" icon={<Layers size={14} />}>
                <div className="space-y-5">
                    {/* Quick Info Cards */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800/80">
                            <div className="flex items-center gap-2 mb-1">
                                <Server size={12} className="text-cyan-500" />
                                <span className="text-[9px] text-zinc-600 uppercase">Node</span>
                            </div>
                            <div className="text-xs font-mono text-zinc-200 truncate" title={spec?.nodeName || status?.hostIP}>
                                {spec?.nodeName || status?.hostIP || '-'}
                            </div>
                        </div>
                        <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800/80">
                            <div className="flex items-center gap-2 mb-1">
                                <Network size={12} className="text-blue-500" />
                                <span className="text-[9px] text-zinc-600 uppercase">Pod IP</span>
                            </div>
                            <div className="text-xs font-mono text-zinc-200">{status?.podIP || '-'}</div>
                        </div>
                        <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800/80">
                            <div className="flex items-center gap-2 mb-1">
                                <Shield size={12} className="text-purple-500" />
                                <span className="text-[9px] text-zinc-600 uppercase">Service Account</span>
                            </div>
                            <div className="text-xs font-mono text-zinc-200 truncate" title={spec?.serviceAccountName}>
                                {spec?.serviceAccountName || 'default'}
                            </div>
                        </div>
                        <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800/80">
                            <div className="flex items-center gap-2 mb-1">
                                <Tag size={12} className="text-green-500" />
                                <span className="text-[9px] text-zinc-600 uppercase">QoS Class</span>
                            </div>
                            <div className={`text-xs font-mono ${qosClass === 'Guaranteed' ? 'text-green-500' : qosClass === 'Burstable' ? 'text-amber-500' : 'text-zinc-500'
                                }`}>
                                {qosClass}
                            </div>
                        </div>
                    </div>

                    {/* Containers Section */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold flex items-center gap-2">
                                <Box size={12} />
                                Containers
                            </h4>
                            <span className="text-[10px] text-zinc-600">{containers.length} container{containers.length !== 1 ? 's' : ''}</span>
                        </div>

                        <div className="space-y-2">
                            {containers.map((c: any) => {
                                const st = cStatuses[c.name];
                                const stateInfo = getContainerState(st);
                                const isActive = activeContainer === c.name;

                                return (
                                    <div
                                        key={c.name}
                                        className={`p-3 rounded-xl border transition-all cursor-pointer ${isActive
                                            ? 'bg-cyan-500/10 border-cyan-500/40'
                                            : 'bg-zinc-900/80 border-zinc-800/80 hover:border-zinc-700'
                                            }`}
                                        onClick={() => setActiveContainer(c.name)}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <div className={`w-2 h-2 rounded-full bg-${stateInfo.color}-500 ${stateInfo.state === 'Running' ? 'animate-pulse' : ''}`} />
                                                    <span className="text-sm font-medium text-white truncate">{c.name}</span>
                                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full bg-${stateInfo.color}-500/20 text-${stateInfo.color}-400`}>
                                                        {stateInfo.state}
                                                    </span>
                                                    {st?.restartCount > 0 && (
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 flex items-center gap-1">
                                                            <RefreshCw size={8} />
                                                            {st.restartCount}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[10px] font-mono text-zinc-500 truncate mb-2" title={c.image}>
                                                    {c.image?.split('@')[0]}
                                                </div>

                                                {/* Resource Bars */}
                                                {(c.resources?.requests || c.resources?.limits) && (
                                                    <div className="grid grid-cols-2 gap-3 mt-2">
                                                        <ResourceGauge
                                                            label="CPU"
                                                            used={c.resources?.requests?.cpu}
                                                            limit={c.resources?.limits?.cpu}
                                                            unit="cores"
                                                            color="bg-green-500"
                                                        />
                                                        <ResourceGauge
                                                            label="Memory"
                                                            used={c.resources?.requests?.memory}
                                                            limit={c.resources?.limits?.memory}
                                                            unit="bytes"
                                                            color="bg-blue-500"
                                                        />
                                                    </div>
                                                )}
                                            </div>

                                            {/* Quick Actions */}
                                            <div className="flex flex-col gap-1 shrink-0">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); openContainerDetail(c); }}
                                                    className="p-1.5 text-zinc-500 hover:text-white hover:bg-zinc-700 rounded-lg transition-colors"
                                                    title="View Details"
                                                >
                                                    <Maximize2 size={12} />
                                                </button>
                                                {c.env && c.env.length > 0 && (
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); openEnvModal(c); }}
                                                        className="p-1.5 text-zinc-500 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition-colors"
                                                        title={`View ${c.env.length} Environment Variables`}
                                                    >
                                                        <Variable size={12} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        {/* Expanded Details */}
                                        {isActive && (
                                            <div className="mt-3 pt-3 border-t border-zinc-700/50 space-y-3">
                                                {/* Ports */}
                                                {Array.isArray(c.ports) && c.ports.length > 0 && (
                                                    <div className="flex items-center gap-2">
                                                        <Network size={11} className="text-zinc-500" />
                                                        <span className="text-[10px] text-zinc-500">Ports:</span>
                                                        <div className="flex flex-wrap gap-1">
                                                            {c.ports.map((p: any, i: number) => (
                                                                <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-cyan-400">
                                                                    {p.containerPort}/{p.protocol || 'TCP'}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Env count */}
                                                {c.env && c.env.length > 0 && (
                                                    <div className="flex items-center gap-2">
                                                        <Variable size={11} className="text-zinc-500" />
                                                        <span className="text-[10px] text-zinc-500">Environment:</span>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); openEnvModal(c); }}
                                                            className="text-[10px] text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                                                        >
                                                            {c.env.length} variables →
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Volume Mounts */}
                                                {c.volumeMounts && c.volumeMounts.length > 0 && (
                                                    <div className="flex items-start gap-2">
                                                        <FolderOpen size={11} className="text-zinc-500 mt-0.5" />
                                                        <span className="text-[10px] text-zinc-500">Mounts:</span>
                                                        <div className="flex flex-wrap gap-1 flex-1">
                                                            {c.volumeMounts.slice(0, 3).map((m: any, i: number) => (
                                                                <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400" title={m.mountPath}>
                                                                    {m.name}
                                                                </span>
                                                            ))}
                                                            {c.volumeMounts.length > 3 && (
                                                                <span className="text-[10px] text-zinc-500">+{c.volumeMounts.length - 3} more</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Probes */}
                                                {(c.livenessProbe || c.readinessProbe || c.startupProbe) && (
                                                    <div className="flex items-center gap-2">
                                                        <Activity size={11} className="text-zinc-500" />
                                                        <span className="text-[10px] text-zinc-500">Probes:</span>
                                                        <div className="flex gap-1">
                                                            {c.livenessProbe && <span className="text-[9px] px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded">liveness</span>}
                                                            {c.readinessProbe && <span className="text-[9px] px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded">readiness</span>}
                                                            {c.startupProbe && <span className="text-[9px] px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded">startup</span>}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Init Containers */}
                        {initContainers.length > 0 && (
                            <div className="space-y-2 mt-3">
                                <h5 className="text-[10px] text-zinc-500 font-bold">Init Containers</h5>
                                <div className="flex flex-wrap gap-2">
                                    {initContainers.map((c: any) => {
                                        const st = initCStatuses[c.name];
                                        const stateInfo = getContainerState(st);
                                        return (
                                            <div
                                                key={c.name}
                                                className="flex items-center gap-2 px-2.5 py-1.5 bg-zinc-900/80 rounded-lg border border-zinc-800/80"
                                            >
                                                <div className={`w-1.5 h-1.5 rounded-full bg-${stateInfo.color}-500`} />
                                                <span className="text-[10px] font-mono text-zinc-400">{c.name}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Volumes */}
                    {volumes.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold flex items-center gap-2">
                                <FolderOpen size={12} />
                                Volumes
                            </h4>
                            <div className="flex flex-wrap gap-2">
                                {volumes.map((v: any, i: number) => {
                                    const type = Object.keys(v).find(k => k !== 'name') || 'unknown';
                                    const typeColors: Record<string, string> = {
                                        secret: 'text-red-400 bg-red-500/10 border-red-500/20',
                                        configMap: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
                                        persistentVolumeClaim: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
                                        emptyDir: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20',
                                        hostPath: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
                                        projected: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
                                    };
                                    const colorClass = typeColors[type] || 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20';

                                    return (
                                        <div
                                            key={i}
                                            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border ${colorClass}`}
                                            title={JSON.stringify(v[type] || {}, null, 2)}
                                        >
                                            <span className="text-[10px] font-mono font-medium">{v.name}</span>
                                            <span className="text-[9px] opacity-70">{type}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Security Context */}
                    {Object.keys(securityContext).length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold flex items-center gap-2">
                                <Shield size={12} />
                                Pod Security Context
                            </h4>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {securityContext.runAsUser !== undefined && (
                                    <div className="p-2 bg-zinc-900/80 rounded-lg border border-zinc-800/80">
                                        <div className="text-[9px] text-zinc-600">runAsUser</div>
                                        <div className="text-xs font-mono text-zinc-200">{securityContext.runAsUser}</div>
                                    </div>
                                )}
                                {securityContext.runAsGroup !== undefined && (
                                    <div className="p-2 bg-zinc-900/80 rounded-lg border border-zinc-800/80">
                                        <div className="text-[9px] text-zinc-600">runAsGroup</div>
                                        <div className="text-xs font-mono text-zinc-200">{securityContext.runAsGroup}</div>
                                    </div>
                                )}
                                {securityContext.fsGroup !== undefined && (
                                    <div className="p-2 bg-zinc-900/80 rounded-lg border border-zinc-800/80">
                                        <div className="text-[9px] text-zinc-600">fsGroup</div>
                                        <div className="text-xs font-mono text-zinc-200">{securityContext.fsGroup}</div>
                                    </div>
                                )}
                                {securityContext.runAsNonRoot !== undefined && (
                                    <div className="p-2 bg-zinc-900/80 rounded-lg border border-zinc-800/80">
                                        <div className="text-[9px] text-zinc-600">runAsNonRoot</div>
                                        <div className={`text-xs font-mono ${securityContext.runAsNonRoot ? 'text-green-400' : 'text-red-400'}`}>
                                            {String(securityContext.runAsNonRoot)}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Scheduling */}
                    {(spec.nodeSelector || spec.tolerations || spec.affinity) && (
                        <div className="space-y-2">
                            <h4 className="text-[11px] uppercase tracking-wider text-zinc-500 font-bold">Scheduling</h4>
                            <div className="space-y-2">
                                {spec.nodeSelector && Object.keys(spec.nodeSelector).length > 0 && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 mb-1">Node Selector</div>
                                        <div className="flex flex-wrap gap-1">
                                            {Object.entries(spec.nodeSelector).map(([k, v]) => (
                                                <span key={k} className="text-[10px] font-mono px-2 py-1 bg-zinc-800 rounded-lg border border-zinc-700 text-zinc-300">
                                                    {k}={String(v)}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {spec.tolerations && spec.tolerations.length > 0 && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 mb-1">Tolerations ({spec.tolerations.length})</div>
                                        <div className="flex flex-wrap gap-1">
                                            {spec.tolerations.slice(0, 5).map((t: any, i: number) => (
                                                <span
                                                    key={i}
                                                    className="text-[10px] font-mono px-2 py-1 bg-zinc-800 rounded-lg border border-zinc-700 text-zinc-300"
                                                    title={JSON.stringify(t)}
                                                >
                                                    {t.key || '*'}:{t.effect || 'All'}
                                                </span>
                                            ))}
                                            {spec.tolerations.length > 5 && (
                                                <span className="text-[10px] text-zinc-500">+{spec.tolerations.length - 5} more</span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </CollapsibleSection>
        </div>
    );
}
