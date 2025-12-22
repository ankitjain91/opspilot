import { useState, useEffect, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
    Archive, FolderOpen, X, AlertTriangle, CheckCircle, Clock,
    Search, ChevronRight, ChevronDown, FileText, Activity,
    Loader2, Box, Server, Network, Settings2, Layers, Database,
    XCircle, Copy, Check, ArrowLeft, Zap, RefreshCw,
    AlertOctagon, Eye, Terminal, ExternalLink, ChevronUp,
    Info, Flame, HardDrive, MemoryStick, Cpu
} from 'lucide-react';
import type {
    SupportBundle, BundleResource, BundleEvent, BundleHealthSummary,
    BundleAlerts, BundleLogFile, PodHealthInfo, DeploymentHealthInfo
} from './types';

// ============================================================================
// TYPES
// ============================================================================

interface ResourceChain {
    deployment?: BundleResource;
    replicaSet?: BundleResource;
    pod: BundleResource;
    service?: BundleResource;
    events: BundleEvent[];
    logs?: BundleLogFile[];
}

interface FailureAnalysis {
    type: 'crash' | 'oom' | 'image' | 'pending' | 'evicted' | 'error' | 'unhealthy';
    title: string;
    description: string;
    severity: 'critical' | 'warning';
    suggestions: string[];
}

// ============================================================================
// HELPERS
// ============================================================================

function analyzeFailure(pod: BundleResource, events: BundleEvent[]): FailureAnalysis {
    const status = pod.status_phase?.toLowerCase() || '';
    const conditions = pod.conditions || [];
    const podEvents = events.filter(e =>
        e.involved_object_name === pod.name && e.involved_object_kind === 'Pod'
    );

    // Check for OOMKilled
    if (status.includes('oom') || podEvents.some(e => e.reason?.includes('OOM'))) {
        return {
            type: 'oom',
            title: 'Out of Memory',
            description: 'Container was killed because it exceeded memory limits',
            severity: 'critical',
            suggestions: [
                'Increase memory limits in the pod spec',
                'Check for memory leaks in the application',
                'Review application memory usage patterns',
                'Consider horizontal scaling instead of vertical'
            ]
        };
    }

    // Check for CrashLoopBackOff
    if (status.includes('crash') || status.includes('backoff')) {
        const exitCode = podEvents.find(e => e.message?.includes('exit code'))?.message;
        return {
            type: 'crash',
            title: 'CrashLoopBackOff',
            description: exitCode || 'Container keeps crashing and restarting',
            severity: 'critical',
            suggestions: [
                'Check container logs for error messages',
                'Verify environment variables and secrets are correct',
                'Ensure the application entrypoint is valid',
                'Check if required dependencies/services are available'
            ]
        };
    }

    // Check for ImagePull errors
    if (status.includes('image') || status.includes('pull') ||
        podEvents.some(e => e.reason?.includes('Pull') || e.reason?.includes('Image'))) {
        const imageEvent = podEvents.find(e => e.reason?.includes('Pull'));
        return {
            type: 'image',
            title: 'Image Pull Failed',
            description: imageEvent?.message || 'Cannot pull container image',
            severity: 'critical',
            suggestions: [
                'Verify the image name and tag are correct',
                'Check if image registry is accessible',
                'Ensure imagePullSecrets are configured if using private registry',
                'Verify network connectivity to the registry'
            ]
        };
    }

    // Check for Pending
    if (status === 'pending') {
        const schedulingEvent = podEvents.find(e =>
            e.reason?.includes('Schedul') || e.reason?.includes('Insufficient')
        );
        if (schedulingEvent?.message?.includes('Insufficient')) {
            return {
                type: 'pending',
                title: 'Insufficient Resources',
                description: schedulingEvent.message,
                severity: 'warning',
                suggestions: [
                    'Check cluster resource availability',
                    'Review pod resource requests',
                    'Consider scaling up the cluster',
                    'Check node taints and tolerations'
                ]
            };
        }
        return {
            type: 'pending',
            title: 'Pending',
            description: schedulingEvent?.message || 'Pod is waiting to be scheduled',
            severity: 'warning',
            suggestions: [
                'Check for node selector/affinity constraints',
                'Verify PersistentVolumeClaims are bound',
                'Check for resource quota limits',
                'Review pod scheduling constraints'
            ]
        };
    }

    // Check for Evicted
    if (status === 'evicted' || podEvents.some(e => e.reason === 'Evicted')) {
        return {
            type: 'evicted',
            title: 'Evicted',
            description: 'Pod was evicted from the node',
            severity: 'warning',
            suggestions: [
                'Check node disk pressure conditions',
                'Review pod resource usage',
                'Check for node memory pressure',
                'Consider adding resource limits'
            ]
        };
    }

    // Check conditions for unhealthy probes
    const readyCondition = conditions.find(c => c.condition_type === 'Ready');
    if (readyCondition?.status === 'False') {
        return {
            type: 'unhealthy',
            title: 'Not Ready',
            description: readyCondition.message || 'Pod failed readiness check',
            severity: 'warning',
            suggestions: [
                'Check readiness probe configuration',
                'Verify the application health endpoint',
                'Check container startup time',
                'Review application logs for errors'
            ]
        };
    }

    return {
        type: 'error',
        title: status || 'Error',
        description: 'Pod is in an unhealthy state',
        severity: 'warning',
        suggestions: ['Check pod events and logs for more details']
    };
}

function getStatusColor(status: string | null): string {
    if (!status) return 'zinc';
    const s = status.toLowerCase();
    if (s === 'running' || s === 'succeeded' || s === 'active' || s === 'bound') return 'emerald';
    if (s === 'pending') return 'amber';
    if (s.includes('crash') || s.includes('error') || s.includes('failed') || s.includes('oom')) return 'red';
    return 'zinc';
}

function formatAge(ts: string | null): string {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (mins > 0) return `${mins}m`;
    return 'now';
}

// ============================================================================
// FAILURE CARD COMPONENT
// ============================================================================

interface FailureCardProps {
    chain: ResourceChain;
    analysis: FailureAnalysis;
    onViewDetails: () => void;
    isExpanded: boolean;
    logContent?: string;
    onLoadLogs?: () => void;
}

function FailureCard({ chain, analysis, onViewDetails, isExpanded, logContent, onLoadLogs }: FailureCardProps) {
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [copied, setCopied] = useState(false);

    const copyName = async () => {
        await navigator.clipboard.writeText(chain.pod.name);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const severityStyles = {
        critical: {
            border: 'border-red-500/30',
            bg: 'bg-gradient-to-br from-red-950/40 via-red-950/20 to-transparent',
            icon: 'bg-red-500/20 text-red-400',
            badge: 'bg-red-500/20 text-red-400 border-red-500/30'
        },
        warning: {
            border: 'border-amber-500/30',
            bg: 'bg-gradient-to-br from-amber-950/40 via-amber-950/20 to-transparent',
            icon: 'bg-amber-500/20 text-amber-400',
            badge: 'bg-amber-500/20 text-amber-400 border-amber-500/30'
        }
    };

    const style = severityStyles[analysis.severity];

    const FailureIcon = {
        crash: RefreshCw,
        oom: MemoryStick,
        image: HardDrive,
        pending: Clock,
        evicted: Zap,
        error: XCircle,
        unhealthy: AlertTriangle
    }[analysis.type];

    return (
        <div className={`rounded-2xl border ${style.border} ${style.bg} overflow-hidden`}>
            {/* Header */}
            <div className="p-4">
                <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-xl ${style.icon} flex items-center justify-center flex-shrink-0`}>
                        <FailureIcon size={24} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-base font-semibold text-white">{analysis.title}</h3>
                            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${style.badge}`}>
                                {analysis.severity.toUpperCase()}
                            </span>
                        </div>
                        <p className="text-sm text-zinc-400 mt-1 line-clamp-2">{analysis.description}</p>
                    </div>
                </div>

                {/* Resource Chain */}
                <div className="mt-4 flex items-center gap-2 text-xs overflow-x-auto pb-1">
                    {chain.deployment && (
                        <>
                            <span className="flex items-center gap-1.5 px-2 py-1 bg-purple-500/10 text-purple-400 rounded-lg whitespace-nowrap">
                                <Layers size={12} />
                                {chain.deployment.name}
                            </span>
                            <ChevronRight size={12} className="text-zinc-600 flex-shrink-0" />
                        </>
                    )}
                    {chain.replicaSet && (
                        <>
                            <span className="flex items-center gap-1.5 px-2 py-1 bg-violet-500/10 text-violet-400 rounded-lg whitespace-nowrap">
                                <Layers size={12} />
                                {chain.replicaSet.name.length > 30 ? chain.replicaSet.name.slice(0, 27) + '...' : chain.replicaSet.name}
                            </span>
                            <ChevronRight size={12} className="text-zinc-600 flex-shrink-0" />
                        </>
                    )}
                    <span className="flex items-center gap-1.5 px-2 py-1 bg-red-500/10 text-red-400 rounded-lg whitespace-nowrap">
                        <Box size={12} />
                        {chain.pod.name}
                        <button onClick={copyName} className="ml-1 p-0.5 hover:bg-white/10 rounded">
                            {copied ? <Check size={10} /> : <Copy size={10} />}
                        </button>
                    </span>
                    {chain.service && (
                        <>
                            <span className="text-zinc-600 flex-shrink-0">←</span>
                            <span className="flex items-center gap-1.5 px-2 py-1 bg-cyan-500/10 text-cyan-400 rounded-lg whitespace-nowrap">
                                <Network size={12} />
                                {chain.service.name}
                            </span>
                        </>
                    )}
                </div>

                {/* Namespace */}
                <div className="mt-3 text-xs text-zinc-500">
                    Namespace: <span className="text-zinc-400">{chain.pod.namespace}</span>
                </div>
            </div>

            {/* Actions */}
            <div className="px-4 py-3 bg-black/20 border-t border-white/5 flex items-center gap-2">
                <button
                    onClick={() => setShowSuggestions(!showSuggestions)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
                >
                    <Info size={12} />
                    How to fix
                    {showSuggestions ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
                {chain.logs && chain.logs.length > 0 && (
                    <button
                        onClick={onLoadLogs}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
                    >
                        <Terminal size={12} />
                        View Logs
                    </button>
                )}
                <button
                    onClick={onViewDetails}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-zinc-300 text-xs font-medium rounded-lg transition-colors ml-auto"
                >
                    <Eye size={12} />
                    Details
                </button>
            </div>

            {/* Suggestions */}
            {showSuggestions && (
                <div className="px-4 py-3 bg-black/30 border-t border-white/5">
                    <h4 className="text-xs font-medium text-zinc-400 mb-2">Suggested Actions:</h4>
                    <ul className="space-y-1.5">
                        {analysis.suggestions.map((s, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                                <span className="text-emerald-500 mt-0.5">→</span>
                                {s}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Recent Events */}
            {chain.events.length > 0 && (
                <div className="px-4 py-3 bg-black/20 border-t border-white/5">
                    <h4 className="text-xs font-medium text-zinc-400 mb-2">Recent Events:</h4>
                    <div className="space-y-1.5 max-h-32 overflow-y-auto">
                        {chain.events.slice(0, 5).map((e, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs">
                                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${e.event_type === 'Warning' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                                <div className="flex-1 min-w-0">
                                    <span className="text-zinc-400">{e.reason}:</span>{' '}
                                    <span className="text-zinc-500">{e.message?.slice(0, 100)}{e.message && e.message.length > 100 ? '...' : ''}</span>
                                </div>
                                {e.count > 1 && <span className="text-zinc-600">×{e.count}</span>}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Logs Preview */}
            {logContent && (
                <div className="border-t border-white/5">
                    <pre className="p-4 text-[11px] font-mono text-zinc-400 bg-black/40 max-h-48 overflow-auto whitespace-pre-wrap">
                        {logContent}
                    </pre>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// RESOURCE DETAIL PANEL
// ============================================================================

interface ResourceDetailProps {
    resource: BundleResource;
    yaml: string;
    logs?: string;
    logFiles: BundleLogFile[];
    events: BundleEvent[];
    onClose: () => void;
    onLoadLog: (lf: BundleLogFile) => void;
    selectedLogFile?: BundleLogFile;
}

function ResourceDetail({ resource, yaml, logs, logFiles, events, onClose, onLoadLog, selectedLogFile }: ResourceDetailProps) {
    const [tab, setTab] = useState<'overview' | 'events' | 'logs' | 'yaml'>('overview');
    const [copied, setCopied] = useState(false);

    const copyYaml = async () => {
        await navigator.clipboard.writeText(yaml);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const statusColor = getStatusColor(resource.status_phase);
    const resourceEvents = events.filter(e =>
        e.involved_object_name === resource.name &&
        e.involved_object_kind === resource.kind
    );

    return (
        <div className="h-full flex flex-col bg-zinc-900">
            {/* Header */}
            <div className="flex-none p-4 border-b border-white/10 bg-zinc-900/80">
                <div className="flex items-start justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold text-white">{resource.name}</h2>
                            <span className={`text-xs px-2 py-0.5 rounded-full bg-${statusColor}-500/20 text-${statusColor}-400 border border-${statusColor}-500/30`}>
                                {resource.status_phase || 'Unknown'}
                            </span>
                        </div>
                        <p className="text-sm text-zinc-500 mt-1">{resource.kind} · {resource.namespace || 'cluster-scoped'}</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg text-zinc-400">
                        <X size={18} />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-1 mt-4 bg-zinc-800/50 rounded-lg p-1 w-fit">
                    {[
                        { id: 'overview', label: 'Overview' },
                        { id: 'events', label: 'Events', count: resourceEvents.length },
                        { id: 'logs', label: 'Logs', show: logFiles.length > 0 },
                        { id: 'yaml', label: 'YAML' }
                    ].filter(t => t.show !== false).map(t => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id as typeof tab)}
                            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                                tab === t.id ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'
                            }`}
                        >
                            {t.label}
                            {t.count !== undefined && t.count > 0 && (
                                <span className="ml-1.5 text-[10px] text-zinc-500">({t.count})</span>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
                {tab === 'overview' && (
                    <div className="space-y-4">
                        {/* Conditions */}
                        {resource.conditions.length > 0 && (
                            <div>
                                <h3 className="text-sm font-medium text-zinc-300 mb-3">Conditions</h3>
                                <div className="space-y-2">
                                    {resource.conditions.map((c, i) => (
                                        <div
                                            key={i}
                                            className={`p-3 rounded-xl border ${
                                                c.status === 'True'
                                                    ? 'bg-emerald-500/5 border-emerald-500/20'
                                                    : c.status === 'False'
                                                        ? 'bg-red-500/5 border-red-500/20'
                                                        : 'bg-zinc-800/50 border-white/5'
                                            }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="text-sm font-medium text-white">{c.condition_type}</span>
                                                <span className={`text-xs px-2 py-0.5 rounded-full ${
                                                    c.status === 'True'
                                                        ? 'bg-emerald-500/20 text-emerald-400'
                                                        : c.status === 'False'
                                                            ? 'bg-red-500/20 text-red-400'
                                                            : 'bg-zinc-700 text-zinc-400'
                                                }`}>
                                                    {c.status}
                                                </span>
                                            </div>
                                            {c.reason && <p className="text-xs text-zinc-400 mt-1">{c.reason}</p>}
                                            {c.message && <p className="text-xs text-zinc-500 mt-1">{c.message}</p>}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Labels */}
                        {Object.keys(resource.labels).length > 0 && (
                            <div>
                                <h3 className="text-sm font-medium text-zinc-300 mb-3">Labels</h3>
                                <div className="flex flex-wrap gap-1.5">
                                    {Object.entries(resource.labels).map(([k, v]) => (
                                        <span key={k} className="text-xs px-2 py-1 bg-zinc-800 text-zinc-400 rounded-lg">
                                            {k}: <span className="text-zinc-300">{v}</span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === 'events' && (
                    <div className="space-y-2">
                        {resourceEvents.length === 0 ? (
                            <div className="text-center py-8 text-zinc-500">No events for this resource</div>
                        ) : (
                            resourceEvents.map((e, i) => (
                                <div
                                    key={i}
                                    className={`p-3 rounded-xl border ${
                                        e.event_type === 'Warning'
                                            ? 'bg-amber-500/5 border-amber-500/20'
                                            : 'bg-zinc-800/50 border-white/5'
                                    }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className={`w-2 h-2 rounded-full ${e.event_type === 'Warning' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                                        <span className="text-sm font-medium text-white">{e.reason}</span>
                                        {e.count > 1 && <span className="text-xs text-zinc-500">×{e.count}</span>}
                                        {e.last_timestamp && (
                                            <span className="text-xs text-zinc-600 ml-auto">{formatAge(e.last_timestamp)}</span>
                                        )}
                                    </div>
                                    <p className="text-sm text-zinc-400 mt-1">{e.message}</p>
                                </div>
                            ))
                        )}
                    </div>
                )}

                {tab === 'logs' && (
                    <div className="space-y-3">
                        <div className="flex flex-wrap gap-1.5">
                            {logFiles.map(lf => (
                                <button
                                    key={lf.file_path}
                                    onClick={() => onLoadLog(lf)}
                                    className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                                        selectedLogFile?.file_path === lf.file_path
                                            ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                            : 'bg-zinc-800 text-zinc-400 hover:text-white border border-transparent'
                                    }`}
                                >
                                    {lf.container}
                                </button>
                            ))}
                        </div>
                        {logs ? (
                            <pre className="p-4 bg-black/50 rounded-xl text-[11px] font-mono text-zinc-300 overflow-auto max-h-[60vh] whitespace-pre-wrap">
                                {logs}
                            </pre>
                        ) : (
                            <div className="text-center py-8 text-zinc-500">Select a container to view logs</div>
                        )}
                    </div>
                )}

                {tab === 'yaml' && (
                    <div className="bg-black/50 rounded-xl border border-white/5 overflow-hidden">
                        <div className="px-3 py-2 bg-white/5 border-b border-white/5 flex justify-between">
                            <span className="text-xs text-zinc-500">YAML</span>
                            <button onClick={copyYaml} className="text-xs text-zinc-400 hover:text-white flex items-center gap-1">
                                {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                                {copied ? 'Copied' : 'Copy'}
                            </button>
                        </div>
                        <pre className="p-4 text-[11px] font-mono text-zinc-300 overflow-auto max-h-[60vh]">
                            {yaml}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function BundleDashboard({ onClose }: { onClose?: () => void }) {
    // Bundle state
    const [bundle, setBundle] = useState<SupportBundle | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Data
    const [healthSummary, setHealthSummary] = useState<BundleHealthSummary | null>(null);
    const [events, setEvents] = useState<BundleEvent[]>([]);
    const [alerts, setAlerts] = useState<BundleAlerts | null>(null);
    const [allResources, setAllResources] = useState<Map<string, BundleResource[]>>(new Map());

    // UI state
    const [view, setView] = useState<'failures' | 'explore' | 'events'>('failures');
    const [selectedResource, setSelectedResource] = useState<BundleResource | null>(null);
    const [resourceYaml, setResourceYaml] = useState('');
    const [logFiles, setLogFiles] = useState<BundleLogFile[]>([]);
    const [logContent, setLogContent] = useState('');
    const [selectedLogFile, setSelectedLogFile] = useState<BundleLogFile | undefined>();
    const [expandedFailure, setExpandedFailure] = useState<string | null>(null);
    const [failureLogs, setFailureLogs] = useState<Record<string, string>>({});

    // Explore state
    const [selectedNs, setSelectedNs] = useState<string | null>(null);
    const [selectedType, setSelectedType] = useState<string | null>(null);
    const [resourceTypes, setResourceTypes] = useState<string[]>([]);
    const [resources, setResources] = useState<BundleResource[]>([]);
    const [search, setSearch] = useState('');

    // Load bundle
    const loadBundle = async () => {
        try {
            const path = await open({ directory: true, multiple: false, title: 'Select Support Bundle Folder' });
            if (!path) return;
            setLoading(true);
            setError(null);

            const result = await invoke<SupportBundle>('load_support_bundle', { path });
            setBundle(result);

            const health = await invoke<BundleHealthSummary>('get_bundle_health_summary', { bundlePath: path });
            setHealthSummary(health);

            if (result.has_alerts) {
                setAlerts(await invoke<BundleAlerts>('get_bundle_alerts', { bundlePath: path }));
            }
            if (result.has_events) {
                setEvents(await invoke<BundleEvent[]>('get_bundle_events', { bundlePath: path, namespace: null, involvedObject: null }));
            }

            // Index all resources
            const all = new Map<string, BundleResource[]>();
            for (const ns of result.namespaces) {
                try {
                    const types = await invoke<string[]>('get_bundle_resource_types', { bundlePath: path, namespace: ns });
                    const nsRes: BundleResource[] = [];
                    for (const t of types) {
                        try {
                            const res = await invoke<BundleResource[]>('get_bundle_resources', { bundlePath: path, namespace: ns, resourceType: t });
                            nsRes.push(...res);
                        } catch {}
                    }
                    all.set(ns, nsRes);
                } catch {}
            }
            setAllResources(all);

            if (result.namespaces.length > 0) {
                setSelectedNs(result.namespaces[0]);
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    };

    // Build failure chains
    const failureChains = useMemo(() => {
        if (!healthSummary || allResources.size === 0) return [];

        const chains: ResourceChain[] = [];
        const allResourcesList: BundleResource[] = [];
        allResources.forEach(r => allResourcesList.push(...r));

        const failingPods = healthSummary.failing_pods || [];

        for (const podInfo of failingPods) {
            const pod = allResourcesList.find(r =>
                r.kind === 'Pod' && r.name === podInfo.name && r.namespace === podInfo.namespace
            );
            if (!pod) continue;

            const nsResources = allResources.get(podInfo.namespace) || [];

            // Find owner ReplicaSet
            const podHash = pod.labels['pod-template-hash'];
            const replicaSet = nsResources.find(r =>
                r.kind === 'ReplicaSet' &&
                (podHash ? r.labels['pod-template-hash'] === podHash : pod.name.startsWith(r.name))
            );

            // Find owner Deployment
            let deployment: BundleResource | undefined;
            if (replicaSet) {
                const depName = replicaSet.name.replace(/-[a-z0-9]+$/, '');
                deployment = nsResources.find(r => r.kind === 'Deployment' && r.name === depName);
            } else {
                const appLabel = pod.labels['app'] || pod.labels['app.kubernetes.io/name'];
                if (appLabel) {
                    deployment = nsResources.find(r =>
                        r.kind === 'Deployment' &&
                        (r.labels['app'] === appLabel || r.labels['app.kubernetes.io/name'] === appLabel)
                    );
                }
            }

            // Find related Service
            const appLabel = pod.labels['app'] || pod.labels['app.kubernetes.io/name'];
            const service = appLabel ? nsResources.find(r =>
                r.kind === 'Service' &&
                (r.labels['app'] === appLabel || r.labels['app.kubernetes.io/name'] === appLabel)
            ) : undefined;

            // Get pod events
            const podEvents = events.filter(e =>
                e.involved_object_name === pod.name &&
                e.involved_object_kind === 'Pod' &&
                e.namespace === pod.namespace
            );

            chains.push({
                deployment,
                replicaSet,
                pod,
                service,
                events: podEvents
            });
        }

        return chains;
    }, [healthSummary, allResources, events]);

    // Load resource types for explore view
    useEffect(() => {
        if (!bundle || !selectedNs) return;
        invoke<string[]>('get_bundle_resource_types', { bundlePath: bundle.path, namespace: selectedNs })
            .then(types => {
                setResourceTypes(types);
                setSelectedType(types.includes('pods') ? 'pods' : types[0] || null);
            });
    }, [bundle, selectedNs]);

    // Load resources for explore view
    useEffect(() => {
        if (!bundle || !selectedNs || !selectedType) return;
        invoke<BundleResource[]>('get_bundle_resources', { bundlePath: bundle.path, namespace: selectedNs, resourceType: selectedType })
            .then(r => {
                setResources(r);
                setSelectedResource(null);
            });
    }, [bundle, selectedNs, selectedType]);

    // Load YAML when resource selected
    useEffect(() => {
        if (!bundle || !selectedResource) return;
        const type = selectedResource.kind.toLowerCase() + 's';
        invoke<string>('get_bundle_resource_yaml', {
            bundlePath: bundle.path,
            namespace: selectedResource.namespace,
            resourceType: type,
            name: selectedResource.name
        }).then(setResourceYaml);
    }, [bundle, selectedResource]);

    // Load log files when pod selected
    useEffect(() => {
        if (!bundle || !selectedResource || selectedResource.kind !== 'Pod') {
            setLogFiles([]);
            return;
        }
        invoke<BundleLogFile[]>('get_bundle_log_files', {
            bundlePath: bundle.path,
            namespace: selectedResource.namespace || '',
            pod: selectedResource.name
        }).then(setLogFiles);
    }, [bundle, selectedResource]);

    const loadLog = async (lf: BundleLogFile) => {
        if (!bundle) return;
        setSelectedLogFile(lf);
        const content = await invoke<string>('get_bundle_logs', {
            bundlePath: bundle.path,
            namespace: lf.namespace,
            pod: lf.pod,
            container: lf.container,
            tail: 500
        });
        setLogContent(content);
    };

    const loadFailureLogs = async (podName: string, namespace: string) => {
        if (!bundle) return;
        try {
            const files = await invoke<BundleLogFile[]>('get_bundle_log_files', {
                bundlePath: bundle.path,
                namespace,
                pod: podName
            });
            if (files.length > 0) {
                const content = await invoke<string>('get_bundle_logs', {
                    bundlePath: bundle.path,
                    namespace: files[0].namespace,
                    pod: files[0].pod,
                    container: files[0].container,
                    tail: 100
                });
                setFailureLogs(prev => ({ ...prev, [podName]: content }));
            }
        } catch {}
    };

    const closeBundle = async () => {
        await invoke('close_support_bundle');
        setBundle(null);
        setAllResources(new Map());
        onClose?.();
    };

    const filteredResources = useMemo(() =>
        search ? resources.filter(r => r.name.toLowerCase().includes(search.toLowerCase())) : resources
    , [resources, search]);

    const warningEvents = useMemo(() => events.filter(e => e.event_type === 'Warning'), [events]);
    const criticalCount = (alerts?.critical.length || 0) + failureChains.length;
    const warningCount = (alerts?.warning.length || 0) + warningEvents.length;

    // =========================================================================
    // RENDER: Import screen
    // =========================================================================
    if (!bundle) {
        return (
            <div className="h-full flex items-center justify-center bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950">
                <div className="max-w-lg w-full mx-auto px-8 text-center">
                    <div className="relative mb-8">
                        <div className="w-32 h-32 mx-auto rounded-3xl bg-gradient-to-br from-red-500/20 via-orange-500/20 to-amber-500/20 border border-red-500/30 flex items-center justify-center shadow-2xl shadow-red-500/10">
                            <AlertOctagon size={56} className="text-red-400" />
                        </div>
                    </div>
                    <h1 className="text-3xl font-bold text-white mb-3">Debug Support Bundle</h1>
                    <p className="text-zinc-400 mb-2">Find and fix cluster issues fast</p>
                    <p className="text-sm text-zinc-600 mb-8">
                        Analyzes failing pods, surfaces root causes, and provides actionable fixes
                    </p>

                    {error && (
                        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-left">
                            <AlertTriangle size={16} className="text-red-400 inline mr-2" />
                            <span className="text-red-400 text-sm">{error}</span>
                        </div>
                    )}

                    <button
                        onClick={loadBundle}
                        disabled={loading}
                        className="w-full py-4 px-6 bg-gradient-to-r from-red-600 via-orange-600 to-amber-600 hover:from-red-500 hover:via-orange-500 hover:to-amber-500 text-white font-semibold rounded-xl flex items-center justify-center gap-3 disabled:opacity-50 shadow-lg shadow-red-500/25 transition-all"
                    >
                        {loading ? <Loader2 size={20} className="animate-spin" /> : <FolderOpen size={20} />}
                        {loading ? 'Analyzing Bundle...' : 'Open Support Bundle'}
                    </button>

                    <div className="mt-8 grid grid-cols-3 gap-4 text-center">
                        <div className="p-3 bg-zinc-900/50 rounded-xl border border-white/5">
                            <Flame size={20} className="text-red-400 mx-auto mb-2" />
                            <p className="text-xs text-zinc-400">Failure Analysis</p>
                        </div>
                        <div className="p-3 bg-zinc-900/50 rounded-xl border border-white/5">
                            <Layers size={20} className="text-purple-400 mx-auto mb-2" />
                            <p className="text-xs text-zinc-400">Resource Chains</p>
                        </div>
                        <div className="p-3 bg-zinc-900/50 rounded-xl border border-white/5">
                            <Zap size={20} className="text-amber-400 mx-auto mb-2" />
                            <p className="text-xs text-zinc-400">Fix Suggestions</p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // =========================================================================
    // RENDER: Main dashboard
    // =========================================================================
    return (
        <div className="h-full flex flex-col bg-zinc-950">
            {/* Header */}
            <header className="flex-none h-14 px-4 border-b border-white/10 bg-zinc-900/80 backdrop-blur flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <button onClick={closeBundle} className="p-2 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-white">
                        <ArrowLeft size={18} />
                    </button>
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-red-500/20 to-orange-500/20 border border-red-500/30 flex items-center justify-center">
                            <Archive size={16} className="text-red-400" />
                        </div>
                        <div>
                            <h1 className="text-sm font-semibold text-white">{bundle.path.split('/').pop()}</h1>
                            <div className="flex items-center gap-2 text-[11px]">
                                <span className="text-zinc-500">{bundle.total_resources} resources</span>
                                {criticalCount > 0 && (
                                    <span className="text-red-400">· {criticalCount} critical</span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Nav */}
                <nav className="flex items-center gap-1 bg-zinc-800/50 rounded-lg p-1">
                    <button
                        onClick={() => setView('failures')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                            view === 'failures' ? 'bg-red-500/20 text-red-400' : 'text-zinc-500 hover:text-white'
                        }`}
                    >
                        <AlertOctagon size={14} />
                        Failures
                        {failureChains.length > 0 && (
                            <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-red-500/30 rounded-full">{failureChains.length}</span>
                        )}
                    </button>
                    <button
                        onClick={() => setView('events')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                            view === 'events' ? 'bg-amber-500/20 text-amber-400' : 'text-zinc-500 hover:text-white'
                        }`}
                    >
                        <Activity size={14} />
                        Events
                        {warningEvents.length > 0 && (
                            <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-amber-500/30 rounded-full">{warningEvents.length}</span>
                        )}
                    </button>
                    <button
                        onClick={() => setView('explore')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                            view === 'explore' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'
                        }`}
                    >
                        <Search size={14} />
                        Explore
                    </button>
                </nav>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-hidden flex">
                {/* FAILURES VIEW */}
                {view === 'failures' && (
                    <div className="flex-1 overflow-y-auto">
                        {failureChains.length === 0 ? (
                            <div className="h-full flex items-center justify-center">
                                <div className="text-center p-8">
                                    <div className="w-20 h-20 mx-auto rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
                                        <CheckCircle size={36} className="text-emerald-400" />
                                    </div>
                                    <h2 className="text-xl font-semibold text-white mb-2">No Failing Pods</h2>
                                    <p className="text-zinc-500 max-w-md">
                                        All pods in this bundle appear healthy. Check the Events tab for any warnings.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="max-w-4xl mx-auto p-6 space-y-4">
                                <div className="flex items-center justify-between mb-2">
                                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                                        <AlertOctagon size={20} className="text-red-400" />
                                        {failureChains.length} Failing Pod{failureChains.length !== 1 ? 's' : ''}
                                    </h2>
                                </div>

                                {failureChains.map((chain, i) => {
                                    const analysis = analyzeFailure(chain.pod, events);
                                    return (
                                        <FailureCard
                                            key={chain.pod.name + i}
                                            chain={{
                                                ...chain,
                                                logs: bundle ? undefined : undefined // Will be loaded on demand
                                            }}
                                            analysis={analysis}
                                            isExpanded={expandedFailure === chain.pod.name}
                                            logContent={failureLogs[chain.pod.name]}
                                            onLoadLogs={() => loadFailureLogs(chain.pod.name, chain.pod.namespace || '')}
                                            onViewDetails={() => {
                                                setSelectedResource(chain.pod);
                                                setSelectedType('pods');
                                            }}
                                        />
                                    );
                                })}

                                {/* Unhealthy Deployments */}
                                {healthSummary?.unhealthy_deployments && healthSummary.unhealthy_deployments.length > 0 && (
                                    <div className="mt-8">
                                        <h3 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
                                            <Layers size={14} />
                                            Unhealthy Deployments
                                        </h3>
                                        <div className="space-y-2">
                                            {healthSummary.unhealthy_deployments.map((dep, i) => (
                                                <div
                                                    key={i}
                                                    className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl flex items-center justify-between"
                                                >
                                                    <div>
                                                        <p className="text-sm font-medium text-white">{dep.name}</p>
                                                        <p className="text-xs text-zinc-500">{dep.namespace}</p>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="text-sm font-medium text-amber-400">
                                                            {dep.ready_replicas}/{dep.desired_replicas} ready
                                                        </p>
                                                        <p className="text-xs text-zinc-500">
                                                            {dep.desired_replicas - dep.ready_replicas} unavailable
                                                        </p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Alerts */}
                                {alerts && (alerts.critical.length > 0 || alerts.warning.length > 0) && (
                                    <div className="mt-8">
                                        <h3 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
                                            <AlertTriangle size={14} />
                                            Prometheus Alerts
                                        </h3>
                                        <div className="space-y-2">
                                            {alerts.critical.map((a, i) => (
                                                <div key={i} className="p-3 bg-red-500/5 border border-red-500/20 rounded-xl">
                                                    <div className="flex items-center gap-2">
                                                        <span className="w-2 h-2 rounded-full bg-red-500" />
                                                        <span className="text-sm font-medium text-white">{a.name}</span>
                                                        <span className="text-xs text-red-400 px-1.5 py-0.5 bg-red-500/20 rounded">critical</span>
                                                    </div>
                                                    {a.message && <p className="text-xs text-zinc-500 mt-1 ml-4">{a.message}</p>}
                                                </div>
                                            ))}
                                            {alerts.warning.map((a, i) => (
                                                <div key={i} className="p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl">
                                                    <div className="flex items-center gap-2">
                                                        <span className="w-2 h-2 rounded-full bg-amber-500" />
                                                        <span className="text-sm font-medium text-white">{a.name}</span>
                                                        <span className="text-xs text-amber-400 px-1.5 py-0.5 bg-amber-500/20 rounded">warning</span>
                                                    </div>
                                                    {a.message && <p className="text-xs text-zinc-500 mt-1 ml-4">{a.message}</p>}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* EVENTS VIEW */}
                {view === 'events' && (
                    <div className="flex-1 overflow-y-auto p-6">
                        <div className="max-w-4xl mx-auto">
                            <div className="flex items-center justify-between mb-4">
                                <h2 className="text-lg font-semibold text-white">{events.length} Events</h2>
                                <div className="flex items-center gap-2 text-xs">
                                    <span className="flex items-center gap-1 text-amber-400">
                                        <span className="w-2 h-2 rounded-full bg-amber-500" />
                                        {warningEvents.length} warnings
                                    </span>
                                </div>
                            </div>

                            {events.length === 0 ? (
                                <div className="text-center py-12 text-zinc-500">No events found</div>
                            ) : (
                                <div className="space-y-2">
                                    {events.slice(0, 200).map((e, i) => (
                                        <div
                                            key={i}
                                            className={`p-4 rounded-xl border ${
                                                e.event_type === 'Warning'
                                                    ? 'bg-amber-500/5 border-amber-500/20'
                                                    : 'bg-zinc-900/50 border-white/5'
                                            }`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <span className={`w-2 h-2 mt-2 rounded-full flex-shrink-0 ${
                                                    e.event_type === 'Warning' ? 'bg-amber-500' : 'bg-blue-500'
                                                }`} />
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="text-sm font-medium text-white">{e.reason}</span>
                                                        {e.count > 1 && (
                                                            <span className="text-xs text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">×{e.count}</span>
                                                        )}
                                                        {e.last_timestamp && (
                                                            <span className="text-xs text-zinc-600">{formatAge(e.last_timestamp)}</span>
                                                        )}
                                                    </div>
                                                    <p className="text-sm text-zinc-400 mt-1">{e.message}</p>
                                                    <div className="flex items-center gap-2 mt-2 text-xs text-zinc-600">
                                                        <span className="px-1.5 py-0.5 bg-zinc-800/50 rounded">{e.involved_object_kind}</span>
                                                        <span>{e.involved_object_name}</span>
                                                        <span>·</span>
                                                        <span>{e.namespace}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* EXPLORE VIEW */}
                {view === 'explore' && (
                    <>
                        <div className="w-52 flex-none border-r border-white/10 bg-zinc-900/30 overflow-y-auto p-3">
                            <p className="px-2 py-1.5 text-[10px] text-zinc-500 uppercase tracking-wider font-medium">Namespaces</p>
                            {bundle.namespaces.map(ns => (
                                <button
                                    key={ns}
                                    onClick={() => setSelectedNs(ns)}
                                    className={`w-full px-3 py-2 text-left text-sm rounded-lg truncate ${
                                        selectedNs === ns
                                            ? 'bg-violet-500/20 text-violet-300'
                                            : 'text-zinc-400 hover:text-white hover:bg-white/5'
                                    }`}
                                >
                                    {ns}
                                </button>
                            ))}
                        </div>

                        <div className="flex-1 flex flex-col overflow-hidden">
                            {/* Resource type tabs */}
                            <div className="flex-none px-4 py-3 border-b border-white/10 bg-zinc-900/30">
                                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                                    {resourceTypes.map(type => (
                                        <button
                                            key={type}
                                            onClick={() => setSelectedType(type)}
                                            className={`px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap ${
                                                selectedType === type
                                                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                                    : 'text-zinc-400 hover:text-white bg-zinc-800/50 border border-transparent'
                                            }`}
                                        >
                                            {type}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Search */}
                            <div className="flex-none px-4 py-3 border-b border-white/10">
                                <div className="relative">
                                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                                    <input
                                        type="text"
                                        placeholder="Search resources..."
                                        value={search}
                                        onChange={e => setSearch(e.target.value)}
                                        className="w-full pl-9 pr-3 py-2 bg-zinc-800/50 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500/50"
                                    />
                                </div>
                            </div>

                            {/* Resource list */}
                            <div className="flex-1 flex overflow-hidden">
                                <div className={`${selectedResource ? 'w-1/2' : 'w-full'} overflow-y-auto p-4`}>
                                    {filteredResources.length === 0 ? (
                                        <div className="h-full flex items-center justify-center text-zinc-500">No resources</div>
                                    ) : (
                                        <div className="space-y-2">
                                            {filteredResources.map(r => {
                                                const color = getStatusColor(r.status_phase);
                                                return (
                                                    <button
                                                        key={r.file_path}
                                                        onClick={() => setSelectedResource(r)}
                                                        className={`w-full p-4 rounded-xl border text-left transition-colors ${
                                                            selectedResource?.file_path === r.file_path
                                                                ? 'bg-violet-500/10 border-violet-500/30'
                                                                : 'bg-zinc-900/50 border-white/5 hover:border-white/10'
                                                        }`}
                                                    >
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-sm font-medium text-white truncate">{r.name}</span>
                                                            <span className={`text-xs px-2 py-0.5 rounded-full bg-${color}-500/20 text-${color}-400`}>
                                                                {r.status_phase || 'Unknown'}
                                                            </span>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                {/* Detail panel */}
                                {selectedResource && (
                                    <div className="w-1/2 border-l border-white/10">
                                        <ResourceDetail
                                            resource={selectedResource}
                                            yaml={resourceYaml}
                                            logs={logContent}
                                            logFiles={logFiles}
                                            events={events}
                                            onClose={() => setSelectedResource(null)}
                                            onLoadLog={loadLog}
                                            selectedLogFile={selectedLogFile}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
