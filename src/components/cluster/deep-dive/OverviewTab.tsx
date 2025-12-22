import React, { useState } from 'react';
import {
    Activity,
    Box,
    ChevronDown,
    ChevronRight,
    Clock,
    Server,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    Copy,
    List,
    Tag,
    Settings,
    Network,
    Sparkles,
    Maximize2,
    HardDrive,
    Workflow
} from 'lucide-react';
import { K8sObject, ResourceMetrics, NavResource } from '../../../types/k8s';
import { StatusBadge } from '../../shared/StatusBadge';
import { DetailPopup } from '../../shared/DetailPopup';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { formatAge } from '../../../utils/time';
import { ObjectTree } from './ObjectTree';
import { MetricsChart } from './MetricsChart';
import { ResourceChainCard } from './ResourceChainCard';

// Kind explanations for non-Kubernetes experts
const KIND_EXPLANATIONS: Record<string, { title: string; summary: string; why: string; icon: React.ReactNode }> = {
    pod: {
        title: 'Pod',
        summary: 'Smallest deployable unit in Kubernetes — one or more tightly-coupled containers running together.',
        why: 'Pods run your app code. Most diagnostics start here: logs, restarts, resource usage.',
        icon: <Server size={16} className="text-cyan-300" />
    },
    deployment: {
        title: 'Deployment',
        summary: 'Manages a fleet of identical Pods with rollout, rollback, and scaling.',
        why: 'Keeps your app highly available and makes safe updates (rollouts).',
        icon: <Activity size={16} className="text-indigo-300" />
    },
    statefulset: {
        title: 'StatefulSet',
        summary: 'Like a Deployment, but for stateful apps — stable identities and persistent storage.',
        why: 'Databases and stateful services rely on ordered updates and fixed identities.',
        icon: <HardDrive size={16} className="text-violet-300" />
    },
    daemonset: {
        title: 'DaemonSet',
        summary: 'Ensures a Pod runs on every (or selected) node.',
        why: 'Cluster-wide agents (logging, metrics) are typically DaemonSets.',
        icon: <Activity size={16} className="text-emerald-300" />
    },
    service: {
        title: 'Service',
        summary: 'Stable virtual IP and DNS for talking to Pods reliably.',
        why: 'Decouples clients from changing Pod IPs; enables load balancing.',
        icon: <Network size={16} className="text-blue-300" />
    },
    ingress: {
        title: 'Ingress',
        summary: 'HTTP(S) routing from outside the cluster to Services, with host/path rules.',
        why: 'Exposes web apps securely; integrates TLS and reverse proxies.',
        icon: <Sparkles size={16} className="text-fuchsia-300" />
    },
    configmap: {
        title: 'ConfigMap',
        summary: 'Non-secret configuration injected into Pods as env or files.',
        why: 'Keeps code and configuration separate for safer changes.',
        icon: <Settings size={16} className="text-zinc-300" />
    },
    secret: {
        title: 'Secret',
        summary: 'Holds credentials and sensitive data, base64-encoded with access controls.',
        why: 'Protects tokens and passwords; restricts who can read them.',
        icon: <Tag size={16} className="text-rose-300" />
    },
    job: {
        title: 'Job',
        summary: 'Runs Pods to completion (batch work).',
        why: 'Good for one-off tasks, migrations, or scheduled work (via CronJob).',
        icon: <Activity size={16} className="text-amber-300" />
    },
    cronjob: {
        title: 'CronJob',
        summary: 'Schedules Jobs at specific times.',
        why: 'Automates recurring maintenance tasks and reports.',
        icon: <Workflow size={16} className="text-amber-300" />
    },
    node: {
        title: 'Node',
        summary: 'Worker machine where Pods run.',
        why: 'Health and capacity of Nodes drive app reliability and performance.',
        icon: <Server size={16} className="text-zinc-300" />
    },
    persistentvolumeclaim: {
        title: 'PersistentVolumeClaim',
        summary: 'A request for storage; binds to a PersistentVolume.',
        why: 'Your Pods need PVCs for durable data beyond restarts.',
        icon: <Box size={16} className="text-lime-300" />
    },
    endpointslice: {
        title: 'EndpointSlice',
        summary: 'Contains IP addresses and ports of Pods backing a Service — the modern replacement for Endpoints.',
        why: 'Kubernetes uses EndpointSlices to route traffic from Services to the actual Pod IPs. If endpoints are missing, your Service won\'t work.',
        icon: <Network size={16} className="text-teal-300" />
    },
    endpoints: {
        title: 'Endpoints',
        summary: 'Legacy resource listing Pod IPs and ports for a Service (replaced by EndpointSlices).',
        why: 'Shows which Pods are receiving traffic from a Service.',
        icon: <Network size={16} className="text-teal-300" />
    },
    networkpolicy: {
        title: 'NetworkPolicy',
        summary: 'Firewall rules that control Pod-to-Pod and external traffic.',
        why: 'Security: restricts which Pods can talk to each other and the outside world.',
        icon: <Network size={16} className="text-orange-300" />
    },
    replicaset: {
        title: 'ReplicaSet',
        summary: 'Ensures a specified number of Pod replicas are running.',
        why: 'Usually managed by Deployments — keeps your app scaled properly.',
        icon: <Activity size={16} className="text-purple-300" />
    },
    namespace: {
        title: 'Namespace',
        summary: 'Virtual cluster partition for organizing and isolating resources.',
        why: 'Separates teams, environments (dev/prod), or applications.',
        icon: <Box size={16} className="text-sky-300" />
    },
    serviceaccount: {
        title: 'ServiceAccount',
        summary: 'Identity for Pods to authenticate with the Kubernetes API.',
        why: 'Controls what your app can do inside the cluster (RBAC permissions).',
        icon: <Tag size={16} className="text-amber-300" />
    }
};

// Helper for Copy Button
const CopyButton = ({ value, label }: { value: string, label?: string }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div
            className="flex items-center gap-2 group cursor-pointer hover:bg-white/5 px-2 py-1 rounded transition-colors"
            onClick={handleCopy}
            title="Click to copy"
        >
            <span className="text-zinc-400 text-xs font-medium min-w-[60px]">{label || 'Value'}:</span>
            <span className="text-zinc-200 text-sm font-mono truncate max-w-[200px]">{value}</span>
            <span className={`text-xs ml-auto transition-opacity ${copied ? 'text-emerald-400' : 'text-zinc-500 opacity-0 group-hover:opacity-100'}`}>
                {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
            </span>
        </div>
    );
};



interface OverviewTabProps {
    resource: K8sObject;
    fullObject: any;
    currentContext?: string;
    loading?: boolean;
    onViewLogs: () => void;
    onAnalyzeLogs?: (container: string) => void;
    onUpdate: (path: string[], value: any) => Promise<void>;
    onNavigateResource?: (kind: string, name: string, namespace: string, apiVersion?: string) => void;
}

// Popup state type
type PopupState =
    | { type: 'labels'; data: Record<string, string> }
    | { type: 'annotations'; data: Record<string, string> }
    | { type: 'image'; containerName: string; image: string }
    | { type: 'condition'; condition: any }
    | null;

const SkeletonLine = ({ className }: { className?: string }) => <div className={`bg-white/5 animate-pulse rounded ${className}`} />;

const OverviewSkeleton = () => (
    <div className="flex flex-col gap-6 pb-20 animate-in fade-in duration-300">
        {/* Metadata Skeleton */}
        <section className="space-y-3">
            <div className="flex items-center gap-2 px-1">
                <SkeletonLine className="w-4 h-4" />
                <SkeletonLine className="w-24 h-4" />
            </div>
            <div className="bg-[#18181b] border border-white/5 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                    {[1, 2, 3, 4].map(i => <div key={i} className="flex justify-between"><SkeletonLine className="h-4 w-20" /><SkeletonLine className="h-4 w-32" /></div>)}
                </div>
                <div className="space-y-4">
                    <SkeletonLine className="h-24 w-full" />
                </div>
            </div>
        </section>
        {/* Spec Skeleton */}
        <section className="space-y-3">
            <div className="flex items-center gap-2 px-1">
                <SkeletonLine className="w-4 h-4" />
                <SkeletonLine className="w-24 h-4" />
            </div>
            <div className="bg-[#18181b] border border-white/5 rounded-xl p-4 space-y-4">
                <SkeletonLine className="h-16 w-full" />
                <SkeletonLine className="h-16 w-full" />
            </div>
        </section>
    </div>
);

export function OverviewTab({ resource, fullObject, currentContext, loading, onViewLogs, onAnalyzeLogs, onUpdate, onNavigateResource }: OverviewTabProps) {
    if (loading) {
        return <OverviewSkeleton />;
    }

    const isPod = resource.kind.toLowerCase() === "pod";
    const isWorkload = ['deployment', 'statefulset', 'daemonset', 'replicaset', 'job'].includes(resource.kind.toLowerCase());
    const isEndpointSlice = resource.kind.toLowerCase() === "endpointslice";
    const isService = resource.kind.toLowerCase() === "service";

    const containers = isPod
        ? (fullObject?.spec?.containers || [])
        : (isWorkload ? (fullObject?.spec?.template?.spec?.containers || []) : []);

    // Auto-expand spec if there are no "smart" cards (like containers) to show
    const hasSmartView = isPod || isWorkload || isEndpointSlice || isService;
    const [specExpanded, setSpecExpanded] = useState(!hasSmartView || containers.length === 0);
    // Auto-expand status for simple resources or if status looks brief
    const [statusExpanded, setStatusExpanded] = useState(!isPod && !isWorkload && !isEndpointSlice);

    // Popup state for showing full details
    const [popup, setPopup] = useState<PopupState>(null);

    const conditions = fullObject?.status?.conditions || [];
    const metadata = fullObject?.metadata || {};

    // Calculate Restarts from ContainerStatus
    const containerStatuses = fullObject?.status?.containerStatuses || [];
    const totalRestarts = containerStatuses.reduce((acc: number, cs: any) => acc + (cs.restartCount || 0), 0);

    return (
        <div className="flex flex-col gap-6 pb-20">

            {/* 1. METADATA (Top Section) */}
            <section id="metadata" className="space-y-3">
                <div className="flex items-center gap-2 text-zinc-400 px-1">
                    <Tag size={16} />
                    <h3 className="text-sm font-bold uppercase tracking-wide">Metadata</h3>
                </div>
                <div className="bg-[#18181b] border border-white/5 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                        <CopyButton label="Name" value={resource.name} />
                        <CopyButton label="Namespace" value={resource.namespace} />
                        <CopyButton label="UID" value={metadata.uid || '-'} />
                        <CopyButton label="Created" value={formatAge(resource.age)} />
                        {metadata.ownerReferences?.map((ref: any) => (
                            <CopyButton key={ref.uid} label="Controlled By" value={`${ref.kind}/${ref.name}`} />
                        ))}
                    </div>
                    <div className="space-y-4">
                        {metadata.labels && (
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <div className="text-[10px] text-zinc-500 font-medium">LABELS</div>
                                    <button
                                        onClick={() => setPopup({ type: 'labels', data: metadata.labels })}
                                        className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] text-zinc-500 hover:text-purple-400 hover:bg-purple-500/10 rounded transition-all"
                                        title="View all labels"
                                    >
                                        <Maximize2 size={10} />
                                        <span>Expand</span>
                                    </button>
                                </div>
                                <div
                                    className="flex flex-wrap gap-1.5 cursor-pointer group/labels"
                                    onClick={() => setPopup({ type: 'labels', data: metadata.labels })}
                                    title="Click to view all labels"
                                >
                                    {Object.entries(metadata.labels).slice(0, 6).map(([k, v]) => (
                                        <div key={k} className="px-2 py-1 bg-black/40 border border-white/10 rounded text-[10px] text-zinc-300 font-mono truncate max-w-[180px] group-hover/labels:border-purple-500/30 transition-colors">
                                            <span className="text-zinc-500">{k}=</span>
                                            <span className="text-zinc-200">{String(v)}</span>
                                        </div>
                                    ))}
                                    {Object.keys(metadata.labels).length > 6 && (
                                        <div className="px-2 py-1 bg-purple-500/10 border border-purple-500/20 rounded text-[10px] text-purple-400 font-medium">
                                            +{Object.keys(metadata.labels).length - 6} more
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                        {metadata.annotations && (
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <div className="text-[10px] text-zinc-500 font-medium">ANNOTATIONS ({Object.keys(metadata.annotations).length})</div>
                                    <button
                                        onClick={() => setPopup({ type: 'annotations', data: metadata.annotations })}
                                        className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] text-zinc-500 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-all"
                                        title="View all annotations"
                                    >
                                        <Maximize2 size={10} />
                                        <span>Expand</span>
                                    </button>
                                </div>
                                <div
                                    className="max-h-[80px] overflow-hidden cursor-pointer group/annotations bg-black/20 rounded-lg p-2 border border-white/5 hover:border-blue-500/30 transition-colors relative"
                                    onClick={() => setPopup({ type: 'annotations', data: metadata.annotations })}
                                    title="Click to view all annotations"
                                >
                                    <div className="space-y-1">
                                        {Object.entries(metadata.annotations).slice(0, 3).map(([k, v]) => (
                                            <div key={k} className="text-[10px] font-mono truncate">
                                                <span className="text-zinc-500">{k}:</span>
                                                <span className="text-zinc-400 ml-1">{String(v).substring(0, 50)}{String(v).length > 50 ? '...' : ''}</span>
                                            </div>
                                        ))}
                                    </div>
                                    {Object.keys(metadata.annotations).length > 3 && (
                                        <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-black/80 to-transparent flex items-end justify-center pb-1">
                                            <span className="text-[9px] text-blue-400 font-medium">+{Object.keys(metadata.annotations).length - 3} more annotations</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </section>

            {/* 1.2 EXPLAINER (Friendly Description) */}
            {(() => {
                const key = resource.kind.toLowerCase();
                const info = KIND_EXPLANATIONS[key];
                if (!info) return null;
                return (
                    <section id="explainer" className="relative">
                        <div className="bg-gradient-to-br from-indigo-500/10 via-fuchsia-500/10 to-transparent border border-white/10 rounded-2xl p-4 overflow-hidden">
                            <div className="flex items-start gap-3">
                                <div className="p-2 rounded-lg bg-white/10 border border-white/10">
                                    {info.icon}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-sm font-bold text-white tracking-wide">What is a {info.title}?</h3>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-white/5 text-zinc-400">Beginner-friendly</span>
                                    </div>
                                    <p className="text-[12px] text-zinc-300 mt-1 leading-relaxed">{info.summary}</p>
                                    <div className="mt-2 text-[11px] text-zinc-400">Why it matters: <span className="text-zinc-200">{info.why}</span></div>
                                </div>
                            </div>
                        </div>
                    </section>
                );
            })()}

            {/* 1.5 RESOURCE CHAIN (Relationships) */}
            <ResourceChainCard
                kind={resource.kind}
                name={resource.name}
                namespace={resource.namespace}
                currentContext={currentContext}
                onNavigate={onNavigateResource}
            />

            {/* ENDPOINTSLICE DETAILS */}
            {isEndpointSlice && (() => {
                const endpoints = fullObject?.endpoints || [];
                const ports = fullObject?.ports || [];
                const addressType = fullObject?.addressType || 'IPv4';
                // Get the parent service from the label
                const serviceName = metadata?.labels?.['kubernetes.io/service-name'];

                return (
                    <section id="endpoints" className="space-y-4">
                        <div className="flex items-center gap-2 text-zinc-400 px-1">
                            <Network size={16} />
                            <h3 className="text-sm font-bold uppercase tracking-wide">Endpoint Details</h3>
                        </div>

                        {/* Parent Service Link */}
                        {serviceName && (
                            <div className="bg-gradient-to-r from-teal-500/10 to-transparent border border-teal-500/20 rounded-xl p-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="text-[10px] text-zinc-500 uppercase mb-1">Parent Service</div>
                                        <div className="flex items-center gap-2">
                                            <Network size={14} className="text-teal-400" />
                                            <span className="text-zinc-200 font-medium">{serviceName}</span>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => onNavigateResource?.('Service', serviceName, resource.namespace)}
                                        className="px-3 py-1.5 bg-teal-500/20 hover:bg-teal-500/30 text-teal-300 text-xs font-medium rounded-lg transition-colors border border-teal-500/30"
                                    >
                                        View Service →
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Ports */}
                        {ports.length > 0 && (
                            <div className="bg-[#18181b] border border-white/5 rounded-xl p-4">
                                <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                                    Ports ({ports.length})
                                </h4>
                                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                                    {ports.map((port: any, i: number) => (
                                        <div key={i} className="bg-black/30 border border-white/5 rounded-lg p-3 text-center">
                                            <div className="text-xl font-bold text-teal-400">{port.port}</div>
                                            <div className="text-[10px] text-zinc-500 uppercase">{port.protocol || 'TCP'}</div>
                                            {port.name && (
                                                <div className="text-xs text-zinc-400 mt-1 font-mono">{port.name}</div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Endpoints List */}
                        <div className="bg-[#18181b] border border-white/5 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-3">
                                <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                                    Endpoints ({endpoints.length})
                                </h4>
                                <span className="text-[10px] text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
                                    {addressType}
                                </span>
                            </div>

                            {endpoints.length === 0 ? (
                                <div className="text-center py-8 text-zinc-500">
                                    <AlertTriangle size={24} className="mx-auto mb-2 text-amber-500" />
                                    <p className="text-sm">No endpoints available</p>
                                    <p className="text-xs text-zinc-600 mt-1">This usually means no Pods match the Service selector</p>
                                </div>
                            ) : (
                                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                                    {endpoints.map((ep: any, i: number) => {
                                        const addresses = ep.addresses || [];
                                        const isReady = ep.conditions?.ready !== false;
                                        const isServing = ep.conditions?.serving !== false;
                                        const isTerminating = ep.conditions?.terminating === true;
                                        const targetRef = ep.targetRef;

                                        return (
                                            <div key={i} className="bg-black/20 border border-white/5 rounded-lg p-3 hover:border-white/10 transition-colors">
                                                <div className="flex items-start justify-between gap-4">
                                                    <div className="flex-1 min-w-0">
                                                        {/* Addresses */}
                                                        <div className="flex flex-wrap gap-2 mb-2">
                                                            {addresses.map((addr: string, j: number) => (
                                                                <div key={j} className="flex items-center gap-1.5 px-2 py-1 bg-teal-500/10 border border-teal-500/20 rounded font-mono text-sm text-teal-300">
                                                                    <div className={`w-1.5 h-1.5 rounded-full ${isReady ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                                                    {addr}
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {/* Target Pod */}
                                                        {targetRef && (
                                                            <div
                                                                className="flex items-center gap-2 text-xs cursor-pointer group/pod"
                                                                onClick={() => onNavigateResource?.(targetRef.kind, targetRef.name, targetRef.namespace || resource.namespace)}
                                                            >
                                                                <Server size={12} className="text-zinc-500 group-hover/pod:text-cyan-400 transition-colors" />
                                                                <span className="text-zinc-500">Pod:</span>
                                                                <span className="text-zinc-300 group-hover/pod:text-cyan-400 transition-colors font-medium">
                                                                    {targetRef.name}
                                                                </span>
                                                            </div>
                                                        )}

                                                        {/* Node info if available */}
                                                        {ep.nodeName && (
                                                            <div className="flex items-center gap-2 text-xs mt-1">
                                                                <HardDrive size={12} className="text-zinc-600" />
                                                                <span className="text-zinc-500">Node:</span>
                                                                <span className="text-zinc-400">{ep.nodeName}</span>
                                                            </div>
                                                        )}

                                                        {/* Zone if available */}
                                                        {ep.zone && (
                                                            <div className="flex items-center gap-2 text-xs mt-1">
                                                                <Box size={12} className="text-zinc-600" />
                                                                <span className="text-zinc-500">Zone:</span>
                                                                <span className="text-zinc-400">{ep.zone}</span>
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* Status Badges */}
                                                    <div className="flex flex-col gap-1 items-end shrink-0">
                                                        <span className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${isReady
                                                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                                                : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                                            }`}>
                                                            {isReady ? 'Ready' : 'Not Ready'}
                                                        </span>
                                                        {isTerminating && (
                                                            <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border bg-rose-500/10 text-rose-400 border-rose-500/20">
                                                                Terminating
                                                            </span>
                                                        )}
                                                        {!isServing && !isTerminating && (
                                                            <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border bg-zinc-500/10 text-zinc-400 border-zinc-500/20">
                                                                Not Serving
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Quick Summary */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="bg-[#18181b] border border-white/5 rounded-xl p-3 text-center">
                                <div className="text-2xl font-bold text-zinc-200">{endpoints.length}</div>
                                <div className="text-[10px] text-zinc-500 uppercase">Total Endpoints</div>
                            </div>
                            <div className="bg-[#18181b] border border-white/5 rounded-xl p-3 text-center">
                                <div className="text-2xl font-bold text-emerald-400">
                                    {endpoints.filter((ep: any) => ep.conditions?.ready !== false).length}
                                </div>
                                <div className="text-[10px] text-zinc-500 uppercase">Ready</div>
                            </div>
                            <div className="bg-[#18181b] border border-white/5 rounded-xl p-3 text-center">
                                <div className="text-2xl font-bold text-amber-400">
                                    {endpoints.filter((ep: any) => ep.conditions?.ready === false).length}
                                </div>
                                <div className="text-[10px] text-zinc-500 uppercase">Not Ready</div>
                            </div>
                            <div className="bg-[#18181b] border border-white/5 rounded-xl p-3 text-center">
                                <div className="text-2xl font-bold text-teal-400">{ports.length}</div>
                                <div className="text-[10px] text-zinc-500 uppercase">Ports</div>
                            </div>
                        </div>
                    </section>
                );
            })()}

            {/* SERVICE DETAILS */}
            {isService && (() => {
                const spec = fullObject?.spec || {};
                const servicePorts = spec.ports || [];
                const selector = spec.selector || {};
                const clusterIP = spec.clusterIP;
                const externalIPs = spec.externalIPs || [];
                const loadBalancerIP = spec.loadBalancerIP;
                const serviceType = spec.type || 'ClusterIP';

                return (
                    <section id="service-details" className="space-y-4">
                        <div className="flex items-center gap-2 text-zinc-400 px-1">
                            <Network size={16} />
                            <h3 className="text-sm font-bold uppercase tracking-wide">Service Details</h3>
                        </div>

                        {/* Service Type & IPs */}
                        <div className="bg-[#18181b] border border-white/5 rounded-xl p-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase mb-1">Type</div>
                                    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium ${serviceType === 'LoadBalancer' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' :
                                            serviceType === 'NodePort' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                                                serviceType === 'ExternalName' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' :
                                                    'bg-blue-500/10 text-blue-400 border-blue-500/20'
                                        }`}>
                                        {serviceType}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase mb-1">Cluster IP</div>
                                    <div className="font-mono text-zinc-200">{clusterIP || 'None'}</div>
                                </div>
                                {loadBalancerIP && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 uppercase mb-1">Load Balancer IP</div>
                                        <div className="font-mono text-purple-400">{loadBalancerIP}</div>
                                    </div>
                                )}
                                {externalIPs.length > 0 && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 uppercase mb-1">External IPs</div>
                                        <div className="flex flex-wrap gap-1">
                                            {externalIPs.map((ip: string, i: number) => (
                                                <span key={i} className="font-mono text-xs px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded">{ip}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Selector */}
                        {Object.keys(selector).length > 0 && (
                            <div className="bg-[#18181b] border border-white/5 rounded-xl p-4">
                                <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                                    Pod Selector
                                </h4>
                                <div className="flex flex-wrap gap-2">
                                    {Object.entries(selector).map(([k, v]) => (
                                        <div key={k} className="px-2 py-1 bg-cyan-500/10 border border-cyan-500/20 rounded text-xs font-mono">
                                            <span className="text-zinc-500">{k}=</span>
                                            <span className="text-cyan-400">{String(v)}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Ports */}
                        {servicePorts.length > 0 && (
                            <div className="bg-[#18181b] border border-white/5 rounded-xl p-4">
                                <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                                    Ports ({servicePorts.length})
                                </h4>
                                <div className="space-y-2">
                                    {servicePorts.map((port: any, i: number) => (
                                        <div key={i} className="bg-black/30 border border-white/5 rounded-lg p-3 flex items-center justify-between">
                                            <div className="flex items-center gap-4">
                                                {port.name && (
                                                    <span className="text-zinc-300 font-medium">{port.name}</span>
                                                )}
                                                <div className="flex items-center gap-2">
                                                    <span className="text-blue-400 font-mono text-lg">{port.port}</span>
                                                    <span className="text-zinc-600">→</span>
                                                    <span className="text-emerald-400 font-mono text-lg">{port.targetPort}</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] text-zinc-500 uppercase">{port.protocol || 'TCP'}</span>
                                                {port.nodePort && (
                                                    <span className="text-xs px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded font-mono">
                                                        NodePort: {port.nodePort}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </section>
                );
            })()}

            {/* 2. SPEC (Configuration) */}
            <section id="spec" className="space-y-4">
                <div className="flex items-center gap-2 text-zinc-400 px-1">
                    <Settings size={16} />
                    <h3 className="text-sm font-bold uppercase tracking-wide">Spec</h3>
                </div>

                {/* Containers Card (Pod & Workloads) */}
                {(isPod || isWorkload) && containers.length > 0 && (
                    <div className="bg-[#18181b] border border-white/5 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-4">
                            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Containers ({containers.length})</h4>
                        </div>
                        <div className="grid grid-cols-1 gap-3">
                            {containers.map((c: any) => {
                                const status = containerStatuses.find((cs: any) => cs.name === c.name);
                                const isReady = status?.ready;
                                const state = status?.state?.running ? 'Running' : status?.state?.waiting ? 'Waiting' : status?.state?.terminated ? 'Terminated' : 'Unknown';

                                return (
                                    <div key={c.name} className="bg-black/20 border border-white/5 rounded-lg p-3 flex flex-col gap-2 group hover:border-white/10 transition-colors">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <div className={`w-1.5 h-1.5 rounded-full ${isReady ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-red-500'}`} />
                                                <span className="font-semibold text-zinc-200 text-sm">{c.name}</span>
                                            </div>
                                            <div className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${state === 'Running' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                                                }`}>
                                                {state}
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                            <div className="space-y-1">
                                                <div className="text-zinc-500">Image</div>
                                                <div
                                                    className="font-mono text-zinc-300 truncate cursor-pointer hover:text-emerald-400 flex items-center gap-1 group/image"
                                                    title="Click to view full image name"
                                                    onClick={() => setPopup({ type: 'image', containerName: c.name, image: c.image })}
                                                >
                                                    <span className="truncate">{c.image}</span>
                                                    <Maximize2 size={10} className="shrink-0 opacity-0 group-hover/image:opacity-100 transition-opacity text-emerald-400" />
                                                </div>
                                            </div>
                                            <div className="space-y-1">
                                                <div className="text-zinc-500">Ports</div>
                                                <div className="text-zinc-300">
                                                    {c.ports?.map((p: any) => `${p.containerPort}/${p.protocol}`).join(', ') || 'No ports'}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="pt-2 mt-auto border-t border-white/5 flex gap-2">
                                            {isPod && (
                                                <div className="flex-1 flex gap-2">
                                                    <button
                                                        onClick={onViewLogs}
                                                        className="flex-1 flex items-center justify-center gap-2 px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-[10px] font-medium text-zinc-300 transition-colors"
                                                    >
                                                        <List size={12} /> View Logs
                                                    </button>
                                                    <button
                                                        onClick={() => onAnalyzeLogs?.(c.name)}
                                                        className="flex-1 flex items-center justify-center gap-2 px-2 py-1 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/20 rounded text-[10px] font-medium transition-all"
                                                        title="Analyze logs with Claude AI"
                                                    >
                                                        <Sparkles size={11} className="text-purple-400" /> AI Analyze
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}



                {/* Full Spec Tree */}
                <div className="bg-[#18181b] border border-white/5 rounded-xl overflow-hidden">
                    <button
                        onClick={() => setSpecExpanded(!specExpanded)}
                        className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors group text-left"
                    >
                        <span className="text-xs font-semibold text-zinc-400 group-hover:text-zinc-200">Full Configuration (YAML)</span>
                        <ChevronRight size={14} className={`text-zinc-500 transition-transform ${specExpanded ? 'rotate-90' : ''}`} />
                    </button>
                    {specExpanded && (
                        <div className="p-3 border-t border-white/5 bg-[#0f0f12]">
                            <ObjectTree data={fullObject?.spec || {}} name="spec" expandAll={true} onEdit={onUpdate} />
                        </div>
                    )}
                </div>
            </section >

            {/* 3. STATUS (State & Metrics) */}
            < section id="status" className="space-y-4" >
                <div className="flex items-center gap-2 text-zinc-400 px-1">
                    <Activity size={16} />
                    <h3 className="text-sm font-bold uppercase tracking-wide">Status</h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Vital Signs (Metrics) */}
                    {/* Vital Signs (Metrics) */}
                    {(isPod || resource.kind === 'Node') && (
                        <div className="space-y-3">
                            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">Real-time Metrics</h4>
                            <MetricsChart
                                resourceKind={resource.kind}
                                namespace={resource.namespace}
                                name={resource.name}
                                currentContext={currentContext} // Ensure context causes reset
                            />
                        </div>
                    )}

                    {/* Health Summary */}
                    <div className="space-y-3">
                        <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">State</h4>
                        <div className="bg-[#18181b] border border-white/5 rounded-xl p-4 flex flex-col gap-3">
                            <div className="flex items-center justify-between py-1 border-b border-white/5">
                                <span className="text-xs text-zinc-400">Phase</span>
                                <StatusBadge status={resource.status} />
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-white/5">
                                <span className="text-xs text-zinc-400">Restarts</span>
                                <span className={`text-xs font-mono font-bold ${totalRestarts > 0 ? 'text-yellow-400' : 'text-zinc-200'}`}>{totalRestarts}</span>
                            </div>
                            {isPod && (
                                <>
                                    <div className="flex items-center justify-between py-1 border-b border-white/5">
                                        <span className="text-xs text-zinc-400">Pod IP</span>
                                        <CopyButton label="" value={fullObject?.status?.podIP || '-'} />
                                    </div>
                                    <div className="flex items-center justify-between py-1">
                                        <span className="text-xs text-zinc-400">Node</span>
                                        <div className="text-right">
                                            <div className="text-xs text-zinc-200">{fullObject?.spec?.nodeName}</div>
                                            <div className="text-[10px] text-zinc-500">{fullObject?.status?.hostIP}</div>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* Conditions */}
                {
                    conditions.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">Conditions</h4>
                            <div className="bg-[#18181b] border border-white/5 rounded-xl overflow-hidden">
                                {conditions.map((cond: any, i: number) => (
                                    <div
                                        key={cond.type}
                                        className={`px-4 py-3 flex items-center justify-between ${i !== conditions.length - 1 ? 'border-b border-white/5' : ''} ${cond.message ? 'cursor-pointer hover:bg-white/5' : ''} transition-colors group/cond`}
                                        onClick={() => cond.message && setPopup({ type: 'condition', condition: cond })}
                                        title={cond.message ? 'Click to view full details' : undefined}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={`p-1 rounded-full ${cond.status === 'True' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                                {cond.status === 'True' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                                            </div>
                                            <span className="text-sm text-zinc-300 font-medium">{cond.type}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="flex flex-col items-end gap-0.5">
                                                <span className="text-xs text-zinc-500">{formatAge(cond.lastTransitionTime)} ago</span>
                                                {cond.message && (
                                                    <span className="text-[10px] text-zinc-600 max-w-[300px] truncate group-hover/cond:text-amber-400/80 transition-colors">
                                                        {cond.message}
                                                    </span>
                                                )}
                                            </div>
                                            {cond.message && (
                                                <Maximize2 size={12} className="text-zinc-600 opacity-0 group-hover/cond:opacity-100 transition-opacity" />
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )
                }

                {/* Full Status Tree */}
                <div className="bg-[#18181b] border border-white/5 rounded-xl overflow-hidden">
                    <button
                        onClick={() => setStatusExpanded(!statusExpanded)}
                        className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors group text-left"
                    >
                        <span className="text-xs font-semibold text-zinc-400 group-hover:text-zinc-200">Full Status Details (YAML)</span>
                        <ChevronRight size={14} className={`text-zinc-500 transition-transform ${statusExpanded ? 'rotate-90' : ''}`} />
                    </button>
                    {statusExpanded && (
                        <div className="p-3 border-t border-white/5 bg-[#0f0f12]">
                            <ObjectTree data={fullObject?.status || {}} name="status" expandAll={true} />
                        </div>
                    )}
                </div>
            </section >

            {/* Detail Popup for viewing full content */}
            {popup?.type === 'labels' && (
                <DetailPopup
                    isOpen={true}
                    onClose={() => setPopup(null)}
                    title="Labels"
                    subtitle={`${Object.keys(popup.data).length} labels on ${resource.name}`}
                    content={{ type: 'keyValue', data: popup.data }}
                    accentColor="purple"
                />
            )}
            {popup?.type === 'annotations' && (
                <DetailPopup
                    isOpen={true}
                    onClose={() => setPopup(null)}
                    title="Annotations"
                    subtitle={`${Object.keys(popup.data).length} annotations on ${resource.name}`}
                    content={{ type: 'keyValue', data: popup.data }}
                    accentColor="blue"
                />
            )}
            {popup?.type === 'image' && (
                <DetailPopup
                    isOpen={true}
                    onClose={() => setPopup(null)}
                    title="Container Image"
                    subtitle={`Container: ${popup.containerName}`}
                    content={{ type: 'text', value: popup.image }}
                    accentColor="emerald"
                />
            )}
            {popup?.type === 'condition' && (
                <DetailPopup
                    isOpen={true}
                    onClose={() => setPopup(null)}
                    title={`Condition: ${popup.condition.type}`}
                    subtitle={`Status: ${popup.condition.status} • ${formatAge(popup.condition.lastTransitionTime)} ago`}
                    content={{
                        type: 'keyValue',
                        data: {
                            Type: popup.condition.type,
                            Status: popup.condition.status,
                            Reason: popup.condition.reason || 'N/A',
                            Message: popup.condition.message || 'No message',
                            'Last Transition': popup.condition.lastTransitionTime || 'Unknown',
                            'Last Update': popup.condition.lastUpdateTime || 'Unknown',
                        }
                    }}
                    accentColor="amber"
                />
            )}
        </div >
    );
}
