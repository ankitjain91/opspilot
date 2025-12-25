/**
 * BundleInvestigator - Professional Support Bundle Analysis Tool
 *
 * A comprehensive incident investigation UI for analyzing Kubernetes support bundles.
 * Designed for SREs and support engineers to quickly identify and diagnose issues.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
    AlertTriangle, AlertOctagon, CheckCircle, Clock, Search,
    ChevronRight, ChevronDown, FileText, Activity, Loader2,
    Box, Server, Layers, Database, XCircle, ArrowLeft,
    AlertCircle, Terminal, Filter, Calendar, TrendingDown,
    Shield, Cpu, HardDrive, Network, Eye, ExternalLink,
    FolderOpen, Archive, Zap, ListTree, ScrollText, Bug,
    ChevronUp, MoreHorizontal, Copy, Check, RefreshCw,
    Flame, Info, X, Package, GitBranch, Settings2,
    MessageSquare, Send, Sparkles, MonitorDot
} from 'lucide-react';

// Types
interface SupportBundle {
    path: string;
    namespaces: string[];
    resource_counts: Record<string, number>;
    total_resources: number;
    has_events: boolean;
    has_logs: boolean;
    has_alerts: boolean;
    timestamp: string | null;
}

interface BundleResource {
    api_version: string;
    kind: string;
    name: string;
    namespace: string | null;
    labels: Record<string, string>;
    status_phase: string | null;
    conditions: ResourceCondition[];
    file_path: string;
}

interface ResourceCondition {
    condition_type: string;
    status: string;
    reason: string | null;
    message: string | null;
}

interface BundleEvent {
    name: string;
    namespace: string;
    reason: string;
    message: string;
    event_type: string;
    involved_object_kind: string;
    involved_object_name: string;
    first_timestamp: string | null;
    last_timestamp: string | null;
    count: number;
}

interface BundleAlert {
    name: string;
    severity: string;
    state: string;
    message: string | null;
    labels: Record<string, string>;
}

interface BundleAlerts {
    critical: BundleAlert[];
    warning: BundleAlert[];
}

interface BundleLogFile {
    namespace: string;
    pod: string;
    container: string;
    file_path: string;
    size_bytes: number;
}

interface PodHealthInfo {
    name: string;
    namespace: string;
    status: string;
    restart_count: number;
    reason: string | null;
}

interface DeploymentHealthInfo {
    name: string;
    namespace: string;
    ready_replicas: number;
    desired_replicas: number;
}

interface BundleHealthSummary {
    failing_pods: PodHealthInfo[];
    warning_events_count: number;
    critical_alerts_count: number;
    pending_pvcs: string[];
    unhealthy_deployments: DeploymentHealthInfo[];
}

interface BundleNodeInfo {
    name: string;
    status: string;
    roles: string[];
    cpu_capacity: string;
    cpu_allocatable: string;
    memory_capacity: string;
    memory_allocatable: string;
    pods_capacity: string;
    pods_allocatable: string;
    conditions: NodeCondition[];
    labels: Record<string, string>;
    internal_ip: string | null;
    hostname: string | null;
    kubelet_version: string | null;
    os_image: string | null;
    kernel_version: string | null;
    container_runtime: string | null;
}

interface NodeCondition {
    condition_type: string;
    status: string;
    reason: string | null;
    message: string | null;
}

// Navigation state
type ViewType = 'overview' | 'events' | 'resources' | 'logs' | 'alerts' | 'nodes' | 'chat';

interface InvestigationContext {
    selectedNamespace: string | null;
    selectedResource: BundleResource | null;
    selectedEvent: BundleEvent | null;
    selectedPod: string | null;
    searchQuery: string;
    eventTypeFilter: 'all' | 'Warning' | 'Normal';
    timeRange: 'all' | '1h' | '6h' | '24h';
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface BundleInvestigatorProps {
    onClose?: () => void;
}

export function BundleInvestigator({ onClose }: BundleInvestigatorProps) {
    // Core state
    const [bundle, setBundle] = useState<SupportBundle | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [error, setError] = useState<string | null>(null);

    // Data state
    const [allResources, setAllResources] = useState<Map<string, BundleResource[]>>(new Map());
    const [events, setEvents] = useState<BundleEvent[]>([]);
    const [alerts, setAlerts] = useState<BundleAlerts | null>(null);
    const [healthSummary, setHealthSummary] = useState<BundleHealthSummary | null>(null);
    const [nodes, setNodes] = useState<BundleNodeInfo[]>([]);

    // UI state
    const [activeView, setActiveView] = useState<ViewType>('overview');
    const [context, setContext] = useState<InvestigationContext>({
        selectedNamespace: null,
        selectedResource: null,
        selectedEvent: null,
        selectedPod: null,
        searchQuery: '',
        eventTypeFilter: 'all',
        timeRange: 'all',
    });
    const [showFloatingChat, setShowFloatingChat] = useState(false);

    // Derived data
    const stats = useMemo(() => {
        const resourceList = Array.from(allResources.values()).flat();
        const pods = resourceList.filter(r => r.kind === 'Pod');
        const deployments = resourceList.filter(r => r.kind === 'Deployment');

        const failingPods = pods.filter(p => {
            const status = p.status_phase?.toLowerCase() || '';
            return status.includes('error') || status.includes('crash') ||
                   status.includes('failed') || status.includes('backoff');
        });

        const warningEvents = events.filter(e => e.event_type === 'Warning');
        const criticalAlerts = alerts?.critical?.length || 0;

        return {
            totalResources: resourceList.length,
            totalPods: pods.length,
            failingPods: failingPods.length,
            totalDeployments: deployments.length,
            warningEvents: warningEvents.length,
            criticalAlerts,
            namespaces: bundle?.namespaces.length || 0,
        };
    }, [allResources, events, alerts, bundle]);

    // Handlers
    const loadBundle = async () => {
        try {
            const result = await open({
                directory: true,
                multiple: false,
                title: 'Select Support Bundle Directory'
            });

            if (!result) return;
            const path = Array.isArray(result) ? result[0] : result;
            if (!path) return;

            setLoading(true);
            setError(null);

            // Step 1: Load bundle metadata
            setLoadingMessage('Loading bundle metadata...');
            const bundleData = await invoke<SupportBundle>('load_support_bundle', { path });
            setBundle(bundleData);

            // Step 2: Load all data in parallel
            setLoadingMessage('Indexing resources and events...');
            const [eventsData, alertsData, healthData, resourcesData, nodesData] = await Promise.all([
                invoke<BundleEvent[]>('get_bundle_events', { bundlePath: path }),
                invoke<BundleAlerts>('get_bundle_alerts', { bundlePath: path }),
                invoke<BundleHealthSummary>('get_bundle_health_summary', { bundlePath: path }),
                invoke<Record<string, BundleResource[]>>('get_all_bundle_resources', { bundlePath: path }),
                invoke<BundleNodeInfo[]>('get_bundle_nodes', { bundlePath: path }).catch(() => [] as BundleNodeInfo[])
            ]);

            setEvents(eventsData);
            setAlerts(alertsData);
            setHealthSummary(healthData);
            setNodes(nodesData);

            // Convert to Map
            const resourcesMap = new Map<string, BundleResource[]>();
            for (const [ns, resources] of Object.entries(resourcesData)) {
                resourcesMap.set(ns, resources);
            }
            setAllResources(resourcesMap);

            setLoading(false);
            setLoadingMessage('');
        } catch (err: any) {
            console.error('Failed to load bundle:', err);
            setError(err.toString());
            setLoading(false);
        }
    };

    const handleClose = async () => {
        if (onClose) {
            onClose();
        } else {
            await invoke('close_support_bundle');
            setBundle(null);
            setAllResources(new Map());
            setEvents([]);
            setAlerts(null);
            setHealthSummary(null);
        }
    };

    // ========================================================================
    // RENDER: Loading State
    // ========================================================================
    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-zinc-950">
                <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-4" />
                <p className="text-zinc-400">{loadingMessage || 'Loading...'}</p>
            </div>
        );
    }

    // ========================================================================
    // RENDER: Empty State (No Bundle Loaded)
    // ========================================================================
    if (!bundle) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-zinc-950 p-8">
                <div className="max-w-lg text-center">
                    <div className="w-20 h-20 bg-zinc-900 rounded-2xl flex items-center justify-center mb-6 mx-auto border border-zinc-800">
                        <Bug className="w-10 h-10 text-zinc-600" />
                    </div>
                    <h1 className="text-2xl font-bold text-white mb-3">
                        Support Bundle Investigator
                    </h1>
                    <p className="text-zinc-400 mb-8 leading-relaxed">
                        Load a Kubernetes support bundle to analyze cluster health,
                        investigate incidents, view logs, and diagnose issues.
                    </p>

                    <button
                        onClick={loadBundle}
                        className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg
                                   flex items-center gap-3 mx-auto transition-all font-medium
                                   shadow-lg shadow-blue-900/30"
                    >
                        <FolderOpen size={20} />
                        Open Support Bundle
                    </button>

                    {error && (
                        <div className="mt-8 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-left">
                            <div className="flex items-center gap-2 text-red-400 mb-2">
                                <AlertTriangle size={16} />
                                <span className="font-medium">Failed to Load Bundle</span>
                            </div>
                            <p className="text-sm text-zinc-400 break-all">{error}</p>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // ========================================================================
    // RENDER: Main Investigation UI
    // ========================================================================
    return (
        <div className="flex h-full bg-zinc-950 text-white overflow-hidden">
            {/* Sidebar Navigation */}
            <div className="w-56 bg-zinc-900/50 border-r border-zinc-800 flex flex-col">
                {/* Header */}
                <div className="p-4 border-b border-zinc-800">
                    <button
                        onClick={handleClose}
                        className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors mb-3"
                    >
                        <ArrowLeft size={16} />
                        <span className="text-sm">Close Bundle</span>
                    </button>
                    <h2 className="font-semibold text-white truncate" title={bundle.path}>
                        {bundle.path.split('/').pop()}
                    </h2>
                    <p className="text-xs text-zinc-500 mt-1">
                        {bundle.timestamp ? new Date(bundle.timestamp).toLocaleString() : 'Unknown time'}
                    </p>
                </div>

                {/* Quick Stats */}
                <div className="p-4 border-b border-zinc-800 space-y-2">
                    <QuickStat
                        icon={AlertOctagon}
                        label="Critical Alerts"
                        value={stats.criticalAlerts}
                        variant={stats.criticalAlerts > 0 ? 'danger' : 'success'}
                    />
                    <QuickStat
                        icon={XCircle}
                        label="Failing Pods"
                        value={stats.failingPods}
                        variant={stats.failingPods > 0 ? 'danger' : 'success'}
                    />
                    <QuickStat
                        icon={AlertTriangle}
                        label="Warning Events"
                        value={stats.warningEvents}
                        variant={stats.warningEvents > 10 ? 'warning' : 'muted'}
                    />
                </div>

                {/* Navigation */}
                <nav className="flex-1 p-2 space-y-1">
                    <NavItem
                        icon={Activity}
                        label="Overview"
                        active={activeView === 'overview'}
                        onClick={() => setActiveView('overview')}
                    />
                    <NavItem
                        icon={AlertCircle}
                        label="Alerts & Issues"
                        active={activeView === 'alerts'}
                        onClick={() => setActiveView('alerts')}
                        badge={stats.criticalAlerts + stats.failingPods}
                        badgeVariant="danger"
                    />
                    <NavItem
                        icon={ScrollText}
                        label="Event Timeline"
                        active={activeView === 'events'}
                        onClick={() => setActiveView('events')}
                        badge={stats.warningEvents}
                        badgeVariant="warning"
                    />
                    <NavItem
                        icon={MonitorDot}
                        label="Nodes"
                        active={activeView === 'nodes'}
                        onClick={() => setActiveView('nodes')}
                        badge={nodes.filter(n => n.status !== 'Ready').length}
                        badgeVariant="danger"
                    />
                    <NavItem
                        icon={ListTree}
                        label="Resources"
                        active={activeView === 'resources'}
                        onClick={() => setActiveView('resources')}
                    />
                    <NavItem
                        icon={Terminal}
                        label="Logs"
                        active={activeView === 'logs'}
                        onClick={() => setActiveView('logs')}
                    />

                    <div className="h-px bg-zinc-800 my-2" />

                    <NavItem
                        icon={Sparkles}
                        label="AI Assistant"
                        active={activeView === 'chat'}
                        onClick={() => setActiveView('chat')}
                    />
                </nav>

                {/* Footer Stats */}
                <div className="p-4 border-t border-zinc-800 text-xs text-zinc-500">
                    <div className="flex justify-between">
                        <span>Namespaces</span>
                        <span className="text-zinc-400">{stats.namespaces}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                        <span>Resources</span>
                        <span className="text-zinc-400">{stats.totalResources.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                        <span>Events</span>
                        <span className="text-zinc-400">{events.length.toLocaleString()}</span>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                {activeView === 'overview' && (
                    <OverviewPanel
                        bundle={bundle}
                        stats={stats}
                        healthSummary={healthSummary}
                        alerts={alerts}
                        events={events}
                        allResources={allResources}
                        onViewAlerts={() => setActiveView('alerts')}
                        onViewEvents={() => setActiveView('events')}
                        onViewResources={() => setActiveView('resources')}
                    />
                )}
                {activeView === 'alerts' && (
                    <AlertsPanel
                        alerts={alerts}
                        healthSummary={healthSummary}
                        events={events}
                        allResources={allResources}
                        bundlePath={bundle.path}
                    />
                )}
                {activeView === 'events' && (
                    <EventsPanel
                        events={events}
                        context={context}
                        setContext={setContext}
                        allResources={allResources}
                    />
                )}
                {activeView === 'resources' && (
                    <ResourcesPanel
                        allResources={allResources}
                        bundle={bundle}
                        context={context}
                        setContext={setContext}
                    />
                )}
                {activeView === 'logs' && (
                    <LogsPanel
                        bundle={bundle}
                        allResources={allResources}
                    />
                )}
                {activeView === 'nodes' && (
                    <NodesPanel
                        nodes={nodes}
                        events={events}
                    />
                )}
                {activeView === 'chat' && (
                    <ChatPanel
                        bundle={bundle}
                        nodes={nodes}
                        events={events}
                        alerts={alerts}
                        healthSummary={healthSummary}
                        allResources={allResources}
                    />
                )}
            </div>

            {/* Floating AI Button - shows on all views except chat */}
            {activeView !== 'chat' && !showFloatingChat && (
                <button
                    onClick={() => setShowFloatingChat(true)}
                    className="fixed bottom-6 right-6 w-14 h-14 bg-gradient-to-br from-purple-600 to-purple-700 hover:from-purple-500 hover:to-purple-600 rounded-full shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 flex items-center justify-center transition-all hover:scale-105 active:scale-95 z-50"
                    title="AI Assistant"
                >
                    <Sparkles size={24} className="text-white" />
                </button>
            )}

            {/* Floating Chat Panel */}
            {showFloatingChat && (
                <div className="fixed bottom-6 right-6 w-[420px] h-[600px] bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col overflow-hidden z-50 animate-in fade-in slide-in-from-bottom-4 duration-200">
                    {/* Floating Header with minimize button */}
                    <div className="flex items-center justify-between p-3 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur">
                        <div className="flex items-center gap-2">
                            <div className="p-1.5 bg-purple-500/10 rounded-lg">
                                <Sparkles size={16} className="text-purple-400" />
                            </div>
                            <span className="font-medium text-white text-sm">AI Assistant</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => {
                                    setShowFloatingChat(false);
                                    setActiveView('chat');
                                }}
                                className="p-1.5 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                                title="Expand"
                            >
                                <ExternalLink size={14} />
                            </button>
                            <button
                                onClick={() => setShowFloatingChat(false)}
                                className="p-1.5 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                                title="Close"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-hidden">
                        <ChatPanel
                            bundle={bundle}
                            nodes={nodes}
                            events={events}
                            alerts={alerts}
                            healthSummary={healthSummary}
                            allResources={allResources}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// OVERVIEW PANEL
// ============================================================================

function OverviewPanel({
    bundle, stats, healthSummary, alerts, events, allResources,
    onViewAlerts, onViewEvents, onViewResources
}: {
    bundle: SupportBundle;
    stats: any;
    healthSummary: BundleHealthSummary | null;
    alerts: BundleAlerts | null;
    events: BundleEvent[];
    allResources: Map<string, BundleResource[]>;
    onViewAlerts: () => void;
    onViewEvents: () => void;
    onViewResources: () => void;
}) {
    const recentWarnings = events
        .filter(e => e.event_type === 'Warning')
        .slice(0, 10);

    const criticalIssues = [
        ...(alerts?.critical || []).map(a => ({
            type: 'alert' as const,
            severity: 'critical' as const,
            title: a.name,
            description: a.message || 'Critical alert firing',
            namespace: a.labels['namespace'] || 'cluster',
        })),
        ...(healthSummary?.failing_pods || []).map(p => ({
            type: 'pod' as const,
            severity: 'critical' as const,
            title: `Pod ${p.name}`,
            description: `${p.status}${p.reason ? `: ${p.reason}` : ''}`,
            namespace: p.namespace,
        })),
    ];

    return (
        <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-6xl mx-auto space-y-6">
                {/* Header */}
                <div>
                    <h1 className="text-2xl font-bold text-white">Investigation Overview</h1>
                    <p className="text-zinc-400 mt-1">
                        Bundle captured at {bundle.timestamp ? new Date(bundle.timestamp).toLocaleString() : 'unknown time'}
                    </p>
                </div>

                {/* Health Score Card */}
                <div className="grid grid-cols-4 gap-4">
                    <MetricCard
                        icon={AlertOctagon}
                        label="Critical Alerts"
                        value={stats.criticalAlerts}
                        variant={stats.criticalAlerts > 0 ? 'danger' : 'success'}
                        onClick={onViewAlerts}
                    />
                    <MetricCard
                        icon={XCircle}
                        label="Failing Pods"
                        value={stats.failingPods}
                        subtext={`of ${stats.totalPods} total`}
                        variant={stats.failingPods > 0 ? 'danger' : 'success'}
                        onClick={onViewAlerts}
                    />
                    <MetricCard
                        icon={AlertTriangle}
                        label="Warning Events"
                        value={stats.warningEvents}
                        variant={stats.warningEvents > 50 ? 'warning' : 'muted'}
                        onClick={onViewEvents}
                    />
                    <MetricCard
                        icon={Package}
                        label="Total Resources"
                        value={stats.totalResources}
                        variant="muted"
                        onClick={onViewResources}
                    />
                </div>

                {/* Critical Issues */}
                {criticalIssues.length > 0 && (
                    <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="font-semibold text-red-400 flex items-center gap-2">
                                <Flame size={18} />
                                Critical Issues ({criticalIssues.length})
                            </h2>
                            <button
                                onClick={onViewAlerts}
                                className="text-sm text-red-400 hover:text-red-300"
                            >
                                View All →
                            </button>
                        </div>
                        <div className="space-y-2">
                            {criticalIssues.slice(0, 5).map((issue, i) => (
                                <div
                                    key={i}
                                    className="flex items-start gap-3 p-3 bg-zinc-900/50 rounded-lg border border-zinc-800"
                                >
                                    <div className="mt-0.5">
                                        {issue.type === 'alert' ? (
                                            <AlertOctagon size={16} className="text-red-500" />
                                        ) : (
                                            <XCircle size={16} className="text-red-500" />
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-medium text-white">{issue.title}</div>
                                        <div className="text-sm text-zinc-400 truncate">{issue.description}</div>
                                        <div className="text-xs text-zinc-500 mt-1">
                                            Namespace: {issue.namespace}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Two Column Layout */}
                <div className="grid grid-cols-2 gap-6">
                    {/* Recent Warning Events */}
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl">
                        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
                            <h2 className="font-semibold text-white flex items-center gap-2">
                                <AlertTriangle size={16} className="text-amber-500" />
                                Recent Warnings
                            </h2>
                            <button
                                onClick={onViewEvents}
                                className="text-sm text-zinc-400 hover:text-white"
                            >
                                View All →
                            </button>
                        </div>
                        <div className="divide-y divide-zinc-800 max-h-80 overflow-y-auto">
                            {recentWarnings.length === 0 ? (
                                <div className="p-8 text-center text-zinc-500">
                                    No warning events found
                                </div>
                            ) : (
                                recentWarnings.map((event, i) => (
                                    <div key={i} className="p-3 hover:bg-zinc-800/50">
                                        <div className="flex items-start gap-2">
                                            <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-medium text-white">
                                                    {event.reason}
                                                </div>
                                                <div className="text-xs text-zinc-400 truncate">
                                                    {event.involved_object_kind}/{event.involved_object_name}
                                                </div>
                                                <div className="text-xs text-zinc-500 mt-1 line-clamp-2">
                                                    {event.message}
                                                </div>
                                            </div>
                                            {event.count > 1 && (
                                                <span className="text-xs bg-zinc-800 px-2 py-0.5 rounded text-zinc-400">
                                                    ×{event.count}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    {/* Namespace Summary */}
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl">
                        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
                            <h2 className="font-semibold text-white flex items-center gap-2">
                                <Layers size={16} className="text-blue-500" />
                                Namespaces
                            </h2>
                            <button
                                onClick={onViewResources}
                                className="text-sm text-zinc-400 hover:text-white"
                            >
                                Browse →
                            </button>
                        </div>
                        <div className="divide-y divide-zinc-800 max-h-80 overflow-y-auto">
                            {bundle.namespaces.slice(0, 12).map(ns => {
                                const resources = allResources.get(ns) || [];
                                const pods = resources.filter(r => r.kind === 'Pod');
                                const failing = pods.filter(p => {
                                    const s = p.status_phase?.toLowerCase() || '';
                                    return s.includes('error') || s.includes('crash') || s.includes('backoff');
                                });

                                return (
                                    <div key={ns} className="p-3 hover:bg-zinc-800/50 flex items-center justify-between">
                                        <div>
                                            <div className="font-medium text-white">{ns}</div>
                                            <div className="text-xs text-zinc-500">
                                                {resources.length} resources, {pods.length} pods
                                            </div>
                                        </div>
                                        {failing.length > 0 && (
                                            <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded">
                                                {failing.length} failing
                                            </span>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// ALERTS PANEL
// ============================================================================

function AlertsPanel({
    alerts,
    healthSummary,
    events,
    allResources,
    bundlePath,
}: {
    alerts: BundleAlerts | null;
    healthSummary: BundleHealthSummary | null;
    events: BundleEvent[];
    allResources: Map<string, BundleResource[]>;
    bundlePath: string;
}) {
    const [selectedItem, setSelectedItem] = useState<any>(null);
    const [logContent, setLogContent] = useState<string | null>(null);
    const [loadingLogs, setLoadingLogs] = useState(false);

    // Combine all issues
    const issues = useMemo(() => {
        const result: any[] = [];

        // Critical alerts
        (alerts?.critical || []).forEach(a => {
            result.push({
                id: `alert-${a.name}`,
                type: 'alert',
                severity: 'critical',
                title: a.name,
                description: a.message || 'Critical alert firing',
                namespace: a.labels['namespace'] || 'cluster',
                labels: a.labels,
                state: a.state,
            });
        });

        // Failing pods
        (healthSummary?.failing_pods || []).forEach(p => {
            result.push({
                id: `pod-${p.namespace}-${p.name}`,
                type: 'pod',
                severity: 'critical',
                title: p.name,
                description: `${p.status}${p.reason ? `: ${p.reason}` : ''}`,
                namespace: p.namespace,
                status: p.status,
                restartCount: p.restart_count,
                reason: p.reason,
            });
        });

        // Unhealthy deployments
        (healthSummary?.unhealthy_deployments || []).forEach(d => {
            result.push({
                id: `deploy-${d.namespace}-${d.name}`,
                type: 'deployment',
                severity: 'warning',
                title: d.name,
                description: `${d.ready_replicas}/${d.desired_replicas} replicas ready`,
                namespace: d.namespace,
                readyReplicas: d.ready_replicas,
                desiredReplicas: d.desired_replicas,
            });
        });

        // Pending PVCs
        (healthSummary?.pending_pvcs || []).forEach(pvc => {
            const [ns, name] = pvc.includes('/') ? pvc.split('/') : ['default', pvc];
            result.push({
                id: `pvc-${pvc}`,
                type: 'pvc',
                severity: 'warning',
                title: name,
                description: 'PersistentVolumeClaim is pending',
                namespace: ns,
            });
        });

        return result;
    }, [alerts, healthSummary]);

    // Get related events for selected item
    const relatedEvents = useMemo(() => {
        if (!selectedItem) return [];
        return events.filter(e =>
            e.involved_object_name === selectedItem.title &&
            (selectedItem.namespace === 'cluster' || e.namespace === selectedItem.namespace)
        ).slice(0, 20);
    }, [selectedItem, events]);

    // Load logs for pod
    const loadPodLogs = async (namespace: string, pod: string) => {
        setLoadingLogs(true);
        try {
            const logs = await invoke<string>('get_bundle_logs', {
                bundlePath,
                namespace,
                pod,
                container: null,
                tail: 200,
            });
            setLogContent(logs);
        } catch (err) {
            setLogContent(`Failed to load logs: ${err}`);
        }
        setLoadingLogs(false);
    };

    useEffect(() => {
        if (selectedItem?.type === 'pod') {
            loadPodLogs(selectedItem.namespace, selectedItem.title);
        } else {
            setLogContent(null);
        }
    }, [selectedItem]);

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Issues List */}
            <div className="w-96 border-r border-zinc-800 flex flex-col">
                <div className="p-4 border-b border-zinc-800">
                    <h2 className="font-semibold text-white">Issues & Alerts</h2>
                    <p className="text-sm text-zinc-500 mt-1">
                        {issues.length} issue{issues.length !== 1 ? 's' : ''} detected
                    </p>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {issues.length === 0 ? (
                        <div className="p-8 text-center">
                            <CheckCircle size={40} className="text-emerald-500 mx-auto mb-3" />
                            <p className="text-zinc-400">No issues detected</p>
                            <p className="text-sm text-zinc-500 mt-1">
                                The cluster appears healthy
                            </p>
                        </div>
                    ) : (
                        <div className="divide-y divide-zinc-800">
                            {issues.map(issue => (
                                <button
                                    key={issue.id}
                                    onClick={() => setSelectedItem(issue)}
                                    className={`w-full p-4 text-left hover:bg-zinc-800/50 transition-colors ${
                                        selectedItem?.id === issue.id ? 'bg-zinc-800/50' : ''
                                    }`}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="mt-0.5">
                                            {issue.severity === 'critical' ? (
                                                <AlertOctagon size={16} className="text-red-500" />
                                            ) : (
                                                <AlertTriangle size={16} className="text-amber-500" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="font-medium text-white truncate">
                                                    {issue.title}
                                                </span>
                                                <span className={`text-xs px-1.5 py-0.5 rounded ${
                                                    issue.type === 'alert' ? 'bg-purple-500/20 text-purple-400' :
                                                    issue.type === 'pod' ? 'bg-blue-500/20 text-blue-400' :
                                                    issue.type === 'deployment' ? 'bg-cyan-500/20 text-cyan-400' :
                                                    'bg-zinc-700 text-zinc-400'
                                                }`}>
                                                    {issue.type}
                                                </span>
                                            </div>
                                            <div className="text-sm text-zinc-400 truncate mt-0.5">
                                                {issue.description}
                                            </div>
                                            <div className="text-xs text-zinc-500 mt-1">
                                                {issue.namespace}
                                            </div>
                                        </div>
                                        <ChevronRight size={16} className="text-zinc-600 shrink-0" />
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Detail Panel */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {selectedItem ? (
                    <>
                        {/* Header */}
                        <div className="p-6 border-b border-zinc-800">
                            <div className="flex items-start gap-4">
                                <div className={`p-3 rounded-xl ${
                                    selectedItem.severity === 'critical'
                                        ? 'bg-red-500/10'
                                        : 'bg-amber-500/10'
                                }`}>
                                    {selectedItem.type === 'pod' ? (
                                        <Box size={24} className={selectedItem.severity === 'critical' ? 'text-red-500' : 'text-amber-500'} />
                                    ) : selectedItem.type === 'alert' ? (
                                        <AlertOctagon size={24} className="text-red-500" />
                                    ) : (
                                        <Layers size={24} className="text-amber-500" />
                                    )}
                                </div>
                                <div className="flex-1">
                                    <h2 className="text-xl font-bold text-white">{selectedItem.title}</h2>
                                    <p className="text-zinc-400 mt-1">{selectedItem.description}</p>
                                    <div className="flex items-center gap-4 mt-3 text-sm">
                                        <span className="text-zinc-500">
                                            Namespace: <span className="text-zinc-300">{selectedItem.namespace}</span>
                                        </span>
                                        <span className="text-zinc-500">
                                            Type: <span className="text-zinc-300 capitalize">{selectedItem.type}</span>
                                        </span>
                                        {selectedItem.restartCount > 0 && (
                                            <span className="text-zinc-500">
                                                Restarts: <span className="text-red-400">{selectedItem.restartCount}</span>
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                            {/* Related Events */}
                            {relatedEvents.length > 0 && (
                                <div>
                                    <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                                        <Activity size={16} />
                                        Related Events ({relatedEvents.length})
                                    </h3>
                                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
                                        {relatedEvents.map((event, i) => (
                                            <div key={i} className="p-3">
                                                <div className="flex items-center gap-2">
                                                    {event.event_type === 'Warning' ? (
                                                        <AlertTriangle size={14} className="text-amber-500" />
                                                    ) : (
                                                        <Info size={14} className="text-blue-500" />
                                                    )}
                                                    <span className="font-medium text-white">{event.reason}</span>
                                                    {event.count > 1 && (
                                                        <span className="text-xs bg-zinc-800 px-2 py-0.5 rounded">
                                                            ×{event.count}
                                                        </span>
                                                    )}
                                                    <span className="text-xs text-zinc-500 ml-auto">
                                                        {event.last_timestamp ? new Date(event.last_timestamp).toLocaleString() : ''}
                                                    </span>
                                                </div>
                                                <p className="text-sm text-zinc-400 mt-1 ml-6">
                                                    {event.message}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Pod Logs */}
                            {selectedItem.type === 'pod' && (
                                <div>
                                    <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                                        <Terminal size={16} />
                                        Container Logs
                                    </h3>
                                    {loadingLogs ? (
                                        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
                                            <Loader2 className="animate-spin mx-auto text-zinc-500" />
                                        </div>
                                    ) : logContent ? (
                                        <pre className="bg-black border border-zinc-800 rounded-lg p-4 overflow-x-auto text-xs font-mono text-zinc-300 max-h-96 overflow-y-auto">
                                            {logContent}
                                        </pre>
                                    ) : (
                                        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center text-zinc-500">
                                            No logs available
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Labels */}
                            {selectedItem.labels && Object.keys(selectedItem.labels).length > 0 && (
                                <div>
                                    <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                                        <Settings2 size={16} />
                                        Labels
                                    </h3>
                                    <div className="flex flex-wrap gap-2">
                                        {Object.entries(selectedItem.labels).map(([k, v]) => (
                                            <span key={k} className="text-xs bg-zinc-800 px-2 py-1 rounded font-mono">
                                                {k}=<span className="text-blue-400">{v as string}</span>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-zinc-500">
                        <div className="text-center">
                            <Eye size={40} className="mx-auto mb-3 opacity-50" />
                            <p>Select an issue to view details</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// EVENTS PANEL
// ============================================================================

function EventsPanel({
    events,
    context,
    setContext,
    allResources,
}: {
    events: BundleEvent[];
    context: InvestigationContext;
    setContext: (ctx: InvestigationContext) => void;
    allResources: Map<string, BundleResource[]>;
}) {
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState<'all' | 'Warning' | 'Normal'>('all');
    const [selectedEvent, setSelectedEvent] = useState<BundleEvent | null>(null);

    const namespaces = useMemo(() =>
        Array.from(new Set(events.map(e => e.namespace))).sort(),
        [events]
    );

    const filteredEvents = useMemo(() => {
        return events.filter(e => {
            if (typeFilter !== 'all' && e.event_type !== typeFilter) return false;
            if (context.selectedNamespace && e.namespace !== context.selectedNamespace) return false;
            if (search) {
                const q = search.toLowerCase();
                return e.reason.toLowerCase().includes(q) ||
                       e.message.toLowerCase().includes(q) ||
                       e.involved_object_name.toLowerCase().includes(q);
            }
            return true;
        });
    }, [events, typeFilter, context.selectedNamespace, search]);

    // Group events by time (rough timeline)
    const groupedEvents = useMemo(() => {
        const groups: Record<string, BundleEvent[]> = {};
        filteredEvents.forEach(e => {
            const date = e.last_timestamp ? new Date(e.last_timestamp).toLocaleDateString() : 'Unknown';
            if (!groups[date]) groups[date] = [];
            groups[date].push(e);
        });
        return groups;
    }, [filteredEvents]);

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Events List */}
            <div className="flex-1 flex flex-col border-r border-zinc-800">
                {/* Filters */}
                <div className="p-4 border-b border-zinc-800 space-y-3">
                    <div className="flex items-center gap-3">
                        <div className="relative flex-1">
                            <Search size={16} className="absolute left-3 top-2.5 text-zinc-500" />
                            <input
                                type="text"
                                placeholder="Search events..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm
                                         text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                            />
                        </div>
                        <select
                            value={typeFilter}
                            onChange={e => setTypeFilter(e.target.value as any)}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                        >
                            <option value="all">All Types</option>
                            <option value="Warning">Warnings Only</option>
                            <option value="Normal">Normal Only</option>
                        </select>
                        <select
                            value={context.selectedNamespace || ''}
                            onChange={e => setContext({ ...context, selectedNamespace: e.target.value || null })}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                        >
                            <option value="">All Namespaces</option>
                            {namespaces.map(ns => (
                                <option key={ns} value={ns}>{ns}</option>
                            ))}
                        </select>
                    </div>
                    <div className="text-sm text-zinc-500">
                        Showing {filteredEvents.length} of {events.length} events
                    </div>
                </div>

                {/* Events Timeline */}
                <div className="flex-1 overflow-y-auto">
                    {Object.entries(groupedEvents).map(([date, dateEvents]) => (
                        <div key={date}>
                            <div className="sticky top-0 bg-zinc-900/90 backdrop-blur px-4 py-2 text-sm font-medium text-zinc-400 border-b border-zinc-800">
                                {date}
                            </div>
                            <div className="divide-y divide-zinc-800/50">
                                {dateEvents.map((event, i) => (
                                    <button
                                        key={`${event.name}-${i}`}
                                        onClick={() => setSelectedEvent(event)}
                                        className={`w-full p-4 text-left hover:bg-zinc-800/30 transition-colors ${
                                            selectedEvent?.name === event.name ? 'bg-zinc-800/50' : ''
                                        }`}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className="mt-0.5">
                                                {event.event_type === 'Warning' ? (
                                                    <AlertTriangle size={14} className="text-amber-500" />
                                                ) : (
                                                    <CheckCircle size={14} className="text-emerald-500" />
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium text-white">{event.reason}</span>
                                                    {event.count > 1 && (
                                                        <span className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-400">
                                                            ×{event.count}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-sm text-zinc-400 mt-0.5">
                                                    {event.involved_object_kind}/{event.involved_object_name}
                                                </div>
                                                <div className="text-xs text-zinc-500 mt-1 line-clamp-2">
                                                    {event.message}
                                                </div>
                                            </div>
                                            <div className="text-xs text-zinc-500 shrink-0">
                                                {event.last_timestamp ?
                                                    new Date(event.last_timestamp).toLocaleTimeString() : ''}
                                            </div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Event Detail */}
            <div className="w-96 flex flex-col overflow-hidden">
                {selectedEvent ? (
                    <>
                        <div className="p-4 border-b border-zinc-800">
                            <div className="flex items-center gap-2 mb-2">
                                {selectedEvent.event_type === 'Warning' ? (
                                    <AlertTriangle size={18} className="text-amber-500" />
                                ) : (
                                    <CheckCircle size={18} className="text-emerald-500" />
                                )}
                                <h3 className="font-semibold text-white">{selectedEvent.reason}</h3>
                            </div>
                            <p className="text-sm text-zinc-400">{selectedEvent.message}</p>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            <DetailRow label="Namespace" value={selectedEvent.namespace} />
                            <DetailRow label="Object Kind" value={selectedEvent.involved_object_kind} />
                            <DetailRow label="Object Name" value={selectedEvent.involved_object_name} />
                            <DetailRow label="Event Type" value={selectedEvent.event_type} />
                            <DetailRow label="Count" value={selectedEvent.count.toString()} />
                            <DetailRow
                                label="First Seen"
                                value={selectedEvent.first_timestamp ?
                                    new Date(selectedEvent.first_timestamp).toLocaleString() : 'Unknown'}
                            />
                            <DetailRow
                                label="Last Seen"
                                value={selectedEvent.last_timestamp ?
                                    new Date(selectedEvent.last_timestamp).toLocaleString() : 'Unknown'}
                            />
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-zinc-500">
                        <div className="text-center">
                            <ScrollText size={40} className="mx-auto mb-3 opacity-50" />
                            <p>Select an event to view details</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// RESOURCES PANEL
// ============================================================================

function ResourcesPanel({
    allResources,
    bundle,
    context,
    setContext,
}: {
    allResources: Map<string, BundleResource[]>;
    bundle: SupportBundle;
    context: InvestigationContext;
    setContext: (ctx: InvestigationContext) => void;
}) {
    const [search, setSearch] = useState('');
    const [kindFilter, setKindFilter] = useState<string>('');
    const [selectedResource, setSelectedResource] = useState<BundleResource | null>(null);
    const [yamlContent, setYamlContent] = useState<string | null>(null);
    const [loadingYaml, setLoadingYaml] = useState(false);

    const resourceList = useMemo(() =>
        Array.from(allResources.values()).flat(),
        [allResources]
    );

    const kinds = useMemo(() =>
        Array.from(new Set(resourceList.map(r => r.kind))).sort(),
        [resourceList]
    );

    const namespaces = useMemo(() =>
        Array.from(new Set(resourceList.map(r => r.namespace || 'cluster-scope'))).sort(),
        [resourceList]
    );

    const filteredResources = useMemo(() => {
        return resourceList.filter(r => {
            if (kindFilter && r.kind !== kindFilter) return false;
            if (context.selectedNamespace && (r.namespace || 'cluster-scope') !== context.selectedNamespace) return false;
            if (search) {
                const q = search.toLowerCase();
                return r.name.toLowerCase().includes(q) ||
                       r.kind.toLowerCase().includes(q);
            }
            return true;
        });
    }, [resourceList, kindFilter, context.selectedNamespace, search]);

    // Load YAML when resource selected
    useEffect(() => {
        if (selectedResource) {
            setLoadingYaml(true);
            invoke<string>('get_bundle_resource_yaml', {
                bundlePath: bundle.path,
                namespace: selectedResource.namespace,
                resourceType: selectedResource.kind.toLowerCase() + 's',
                name: selectedResource.name,
            }).then(yaml => {
                setYamlContent(yaml);
                setLoadingYaml(false);
            }).catch(err => {
                setYamlContent(`# Failed to load: ${err}`);
                setLoadingYaml(false);
            });
        }
    }, [selectedResource, bundle.path]);

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Resources List */}
            <div className="flex-1 flex flex-col border-r border-zinc-800">
                {/* Filters */}
                <div className="p-4 border-b border-zinc-800 space-y-3">
                    <div className="flex items-center gap-3">
                        <div className="relative flex-1">
                            <Search size={16} className="absolute left-3 top-2.5 text-zinc-500" />
                            <input
                                type="text"
                                placeholder="Search resources..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm
                                         text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                            />
                        </div>
                        <select
                            value={kindFilter}
                            onChange={e => setKindFilter(e.target.value)}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                        >
                            <option value="">All Kinds</option>
                            {kinds.map(k => (
                                <option key={k} value={k}>{k}</option>
                            ))}
                        </select>
                        <select
                            value={context.selectedNamespace || ''}
                            onChange={e => setContext({ ...context, selectedNamespace: e.target.value || null })}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                        >
                            <option value="">All Namespaces</option>
                            {namespaces.map(ns => (
                                <option key={ns} value={ns}>{ns}</option>
                            ))}
                        </select>
                    </div>
                    <div className="text-sm text-zinc-500">
                        Showing {filteredResources.length} of {resourceList.length} resources
                    </div>
                </div>

                {/* Resource Table */}
                <div className="flex-1 overflow-y-auto">
                    <table className="w-full">
                        <thead className="sticky top-0 bg-zinc-900">
                            <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                                <th className="px-4 py-3 font-medium">Kind</th>
                                <th className="px-4 py-3 font-medium">Name</th>
                                <th className="px-4 py-3 font-medium">Namespace</th>
                                <th className="px-4 py-3 font-medium">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/50">
                            {filteredResources.slice(0, 200).map((r, i) => (
                                <tr
                                    key={`${r.kind}-${r.namespace}-${r.name}-${i}`}
                                    onClick={() => setSelectedResource(r)}
                                    className={`hover:bg-zinc-800/30 cursor-pointer ${
                                        selectedResource?.name === r.name &&
                                        selectedResource?.namespace === r.namespace ? 'bg-zinc-800/50' : ''
                                    }`}
                                >
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-2">
                                            <KindIcon kind={r.kind} />
                                            <span className="text-sm text-zinc-300">{r.kind}</span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 font-mono text-sm text-white">{r.name}</td>
                                    <td className="px-4 py-3 text-sm text-zinc-400">{r.namespace || '-'}</td>
                                    <td className="px-4 py-3">
                                        <StatusBadge status={r.status_phase} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {filteredResources.length > 200 && (
                        <div className="p-4 text-center text-zinc-500 text-sm">
                            Showing first 200 results. Use filters to narrow down.
                        </div>
                    )}
                </div>
            </div>

            {/* Resource Detail */}
            <div className="w-[500px] flex flex-col overflow-hidden">
                {selectedResource ? (
                    <>
                        <div className="p-4 border-b border-zinc-800">
                            <div className="flex items-center gap-3 mb-2">
                                <KindIcon kind={selectedResource.kind} size={20} />
                                <h3 className="font-semibold text-white">{selectedResource.name}</h3>
                            </div>
                            <div className="text-sm text-zinc-400">
                                {selectedResource.kind} in {selectedResource.namespace || 'cluster scope'}
                            </div>
                        </div>
                        <div className="flex-1 overflow-hidden flex flex-col">
                            {/* Labels */}
                            {Object.keys(selectedResource.labels).length > 0 && (
                                <div className="p-4 border-b border-zinc-800">
                                    <h4 className="text-xs font-medium text-zinc-500 mb-2">LABELS</h4>
                                    <div className="flex flex-wrap gap-1">
                                        {Object.entries(selectedResource.labels).slice(0, 10).map(([k, v]) => (
                                            <span key={k} className="text-xs bg-zinc-800 px-2 py-0.5 rounded font-mono truncate max-w-[200px]">
                                                {k}={v}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* YAML */}
                            <div className="flex-1 overflow-hidden flex flex-col">
                                <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
                                    <h4 className="text-xs font-medium text-zinc-500">YAML</h4>
                                    {yamlContent && (
                                        <button
                                            onClick={() => navigator.clipboard.writeText(yamlContent)}
                                            className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
                                        >
                                            <Copy size={12} />
                                            Copy
                                        </button>
                                    )}
                                </div>
                                <div className="flex-1 overflow-auto bg-black">
                                    {loadingYaml ? (
                                        <div className="p-8 text-center">
                                            <Loader2 className="animate-spin mx-auto text-zinc-500" />
                                        </div>
                                    ) : (
                                        <pre className="p-4 text-xs font-mono text-zinc-300 whitespace-pre">
                                            {yamlContent}
                                        </pre>
                                    )}
                                </div>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-zinc-500">
                        <div className="text-center">
                            <FileText size={40} className="mx-auto mb-3 opacity-50" />
                            <p>Select a resource to view details</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// LOGS PANEL
// ============================================================================

function LogsPanel({
    bundle,
    allResources,
}: {
    bundle: SupportBundle;
    allResources: Map<string, BundleResource[]>;
}) {
    const [selectedPod, setSelectedPod] = useState<{ namespace: string; pod: string } | null>(null);
    const [logFiles, setLogFiles] = useState<BundleLogFile[]>([]);
    const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
    const [logContent, setLogContent] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');

    // Get all pods
    const pods = useMemo(() => {
        const result: { namespace: string; name: string; status: string | null }[] = [];
        allResources.forEach((resources, ns) => {
            resources.filter(r => r.kind === 'Pod').forEach(p => {
                result.push({ namespace: ns, name: p.name, status: p.status_phase });
            });
        });
        return result.sort((a, b) => a.name.localeCompare(b.name));
    }, [allResources]);

    const filteredPods = useMemo(() => {
        if (!search) return pods;
        const q = search.toLowerCase();
        return pods.filter(p =>
            p.name.toLowerCase().includes(q) ||
            p.namespace.toLowerCase().includes(q)
        );
    }, [pods, search]);

    // Load log files when pod selected
    useEffect(() => {
        if (selectedPod) {
            invoke<BundleLogFile[]>('get_bundle_log_files', {
                bundlePath: bundle.path,
                namespace: selectedPod.namespace,
                pod: selectedPod.pod,
            }).then(files => {
                setLogFiles(files);
                if (files.length > 0) {
                    setSelectedContainer(files[0].container);
                }
            }).catch(() => {
                setLogFiles([]);
            });
        }
    }, [selectedPod, bundle.path]);

    // Load log content when container selected
    useEffect(() => {
        if (selectedPod && selectedContainer) {
            setLoading(true);
            invoke<string>('get_bundle_logs', {
                bundlePath: bundle.path,
                namespace: selectedPod.namespace,
                pod: selectedPod.pod,
                container: selectedContainer,
                tail: null,
            }).then(logs => {
                setLogContent(logs);
                setLoading(false);
            }).catch(err => {
                setLogContent(`Failed to load logs: ${err}`);
                setLoading(false);
            });
        }
    }, [selectedPod, selectedContainer, bundle.path]);

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Pod List */}
            <div className="w-80 border-r border-zinc-800 flex flex-col">
                <div className="p-4 border-b border-zinc-800">
                    <h2 className="font-semibold text-white mb-3">Pods</h2>
                    <div className="relative">
                        <Search size={16} className="absolute left-3 top-2.5 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Search pods..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm
                                     text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                        />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {filteredPods.map(pod => (
                        <button
                            key={`${pod.namespace}-${pod.name}`}
                            onClick={() => setSelectedPod({ namespace: pod.namespace, pod: pod.name })}
                            className={`w-full p-3 text-left hover:bg-zinc-800/50 border-b border-zinc-800/50 ${
                                selectedPod?.pod === pod.name && selectedPod?.namespace === pod.namespace
                                    ? 'bg-zinc-800/50' : ''
                            }`}
                        >
                            <div className="flex items-center gap-2">
                                <StatusDot status={pod.status} />
                                <span className="text-sm font-medium text-white truncate">{pod.name}</span>
                            </div>
                            <div className="text-xs text-zinc-500 mt-1 truncate">{pod.namespace}</div>
                        </button>
                    ))}
                </div>
            </div>

            {/* Log Viewer */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {selectedPod ? (
                    <>
                        {/* Container Tabs */}
                        <div className="flex items-center gap-2 p-3 border-b border-zinc-800 bg-zinc-900/50">
                            {logFiles.map(file => (
                                <button
                                    key={file.container}
                                    onClick={() => setSelectedContainer(file.container)}
                                    className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                                        selectedContainer === file.container
                                            ? 'bg-blue-600 text-white'
                                            : 'bg-zinc-800 text-zinc-400 hover:text-white'
                                    }`}
                                >
                                    {file.container}
                                    <span className="ml-2 text-xs opacity-60">
                                        {(file.size_bytes / 1024).toFixed(0)}KB
                                    </span>
                                </button>
                            ))}
                            {logFiles.length === 0 && (
                                <span className="text-sm text-zinc-500">No log files found</span>
                            )}
                        </div>

                        {/* Log Content */}
                        <div className="flex-1 overflow-auto bg-black">
                            {loading ? (
                                <div className="p-8 text-center">
                                    <Loader2 className="animate-spin mx-auto text-zinc-500" />
                                </div>
                            ) : (
                                <pre className="p-4 text-xs font-mono text-zinc-300 whitespace-pre">
                                    {logContent || 'No log content'}
                                </pre>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-zinc-500">
                        <div className="text-center">
                            <Terminal size={40} className="mx-auto mb-3 opacity-50" />
                            <p>Select a pod to view logs</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// NODES PANEL
// ============================================================================

function NodesPanel({
    nodes,
    events,
}: {
    nodes: BundleNodeInfo[];
    events: BundleEvent[];
}) {
    const [selectedNode, setSelectedNode] = useState<BundleNodeInfo | null>(null);
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['conditions', 'capacity', 'info']));

    const toggleSection = (section: string) => {
        const newSet = new Set(expandedSections);
        if (newSet.has(section)) {
            newSet.delete(section);
        } else {
            newSet.add(section);
        }
        setExpandedSections(newSet);
    };

    // Get events related to selected node
    const nodeEvents = useMemo(() => {
        if (!selectedNode) return [];
        return events.filter(e =>
            e.involved_object_kind === 'Node' &&
            e.involved_object_name === selectedNode.name
        ).slice(0, 50);
    }, [selectedNode, events]);

    // Parse memory to human-readable
    const parseMemory = (mem: string) => {
        const num = parseInt(mem);
        if (isNaN(num)) return mem;
        if (mem.includes('Ki')) return `${(num / 1024 / 1024).toFixed(1)} GB`;
        if (mem.includes('Mi')) return `${(num / 1024).toFixed(1)} GB`;
        if (mem.includes('Gi')) return `${num} GB`;
        return mem;
    };

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Nodes List */}
            <div className="w-80 border-r border-zinc-800 flex flex-col">
                <div className="p-4 border-b border-zinc-800">
                    <h2 className="font-semibold text-white">Cluster Nodes</h2>
                    <p className="text-sm text-zinc-500 mt-1">
                        {nodes.length} node{nodes.length !== 1 ? 's' : ''}
                    </p>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {nodes.length === 0 ? (
                        <div className="p-8 text-center text-zinc-500">
                            <MonitorDot size={40} className="mx-auto mb-3 opacity-50" />
                            <p>No node information found</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-zinc-800">
                            {nodes.map(node => {
                                const isReady = node.status === 'Ready';
                                return (
                                    <button
                                        key={node.name}
                                        onClick={() => setSelectedNode(node)}
                                        className={`w-full p-4 text-left hover:bg-zinc-800/50 transition-colors ${
                                            selectedNode?.name === node.name ? 'bg-zinc-800/50' : ''
                                        }`}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className={`mt-1 w-2 h-2 rounded-full ${isReady ? 'bg-emerald-500' : 'bg-red-500'}`} />
                                            <div className="flex-1 min-w-0">
                                                <div className="font-medium text-white truncate">{node.name}</div>
                                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                                    {node.roles.map(role => (
                                                        <span key={role} className="text-xs bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">
                                                            {role}
                                                        </span>
                                                    ))}
                                                </div>
                                                <div className="text-xs text-zinc-500 mt-2">
                                                    {node.kubelet_version || 'Unknown version'}
                                                </div>
                                            </div>
                                            <span className={`text-xs px-2 py-0.5 rounded ${
                                                isReady ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                                            }`}>
                                                {node.status}
                                            </span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Node Detail */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {selectedNode ? (
                    <>
                        {/* Header */}
                        <div className="p-6 border-b border-zinc-800 bg-zinc-900/30">
                            <div className="flex items-start gap-4">
                                <div className={`p-3 rounded-xl ${
                                    selectedNode.status === 'Ready' ? 'bg-emerald-500/10' : 'bg-red-500/10'
                                }`}>
                                    <Server size={24} className={
                                        selectedNode.status === 'Ready' ? 'text-emerald-500' : 'text-red-500'
                                    } />
                                </div>
                                <div className="flex-1">
                                    <h2 className="text-xl font-bold text-white">{selectedNode.name}</h2>
                                    <div className="flex items-center gap-3 mt-2 text-sm text-zinc-400">
                                        {selectedNode.internal_ip && <span>IP: {selectedNode.internal_ip}</span>}
                                        {selectedNode.os_image && <span>{selectedNode.os_image}</span>}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                            {/* Capacity Cards */}
                            <div className="grid grid-cols-3 gap-4">
                                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                                    <div className="flex items-center gap-2 text-zinc-400 mb-2">
                                        <Cpu size={16} />
                                        <span className="text-xs font-medium">CPU</span>
                                    </div>
                                    <div className="text-2xl font-bold text-white">{selectedNode.cpu_allocatable}</div>
                                    <div className="text-xs text-zinc-500">of {selectedNode.cpu_capacity} capacity</div>
                                </div>
                                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                                    <div className="flex items-center gap-2 text-zinc-400 mb-2">
                                        <HardDrive size={16} />
                                        <span className="text-xs font-medium">Memory</span>
                                    </div>
                                    <div className="text-2xl font-bold text-white">{parseMemory(selectedNode.memory_allocatable)}</div>
                                    <div className="text-xs text-zinc-500">of {parseMemory(selectedNode.memory_capacity)} capacity</div>
                                </div>
                                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                                    <div className="flex items-center gap-2 text-zinc-400 mb-2">
                                        <Box size={16} />
                                        <span className="text-xs font-medium">Pods</span>
                                    </div>
                                    <div className="text-2xl font-bold text-white">{selectedNode.pods_allocatable}</div>
                                    <div className="text-xs text-zinc-500">max pods</div>
                                </div>
                            </div>

                            {/* Conditions */}
                            <CollapsibleSection
                                title="Conditions"
                                icon={Activity}
                                expanded={expandedSections.has('conditions')}
                                onToggle={() => toggleSection('conditions')}
                            >
                                <div className="space-y-2">
                                    {selectedNode.conditions.map((cond, i) => (
                                        <div key={i} className="flex items-center justify-between p-3 bg-zinc-900/50 rounded-lg">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-2 h-2 rounded-full ${
                                                    cond.condition_type === 'Ready'
                                                        ? cond.status === 'True' ? 'bg-emerald-500' : 'bg-red-500'
                                                        : cond.status === 'False' ? 'bg-emerald-500' : 'bg-amber-500'
                                                }`} />
                                                <span className="font-medium text-white">{cond.condition_type}</span>
                                            </div>
                                            <div className="text-sm text-zinc-400">
                                                {cond.reason || cond.status}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </CollapsibleSection>

                            {/* System Info */}
                            <CollapsibleSection
                                title="System Information"
                                icon={Info}
                                expanded={expandedSections.has('info')}
                                onToggle={() => toggleSection('info')}
                            >
                                <div className="grid grid-cols-2 gap-4">
                                    <DetailRow label="Hostname" value={selectedNode.hostname || '-'} />
                                    <DetailRow label="Internal IP" value={selectedNode.internal_ip || '-'} />
                                    <DetailRow label="Kubelet Version" value={selectedNode.kubelet_version || '-'} />
                                    <DetailRow label="Container Runtime" value={selectedNode.container_runtime || '-'} />
                                    <DetailRow label="OS Image" value={selectedNode.os_image || '-'} />
                                    <DetailRow label="Kernel Version" value={selectedNode.kernel_version || '-'} />
                                </div>
                            </CollapsibleSection>

                            {/* Labels */}
                            {Object.keys(selectedNode.labels).length > 0 && (
                                <CollapsibleSection
                                    title={`Labels (${Object.keys(selectedNode.labels).length})`}
                                    icon={Settings2}
                                    expanded={expandedSections.has('labels')}
                                    onToggle={() => toggleSection('labels')}
                                >
                                    <div className="flex flex-wrap gap-2">
                                        {Object.entries(selectedNode.labels).map(([k, v]) => (
                                            <span key={k} className="text-xs bg-zinc-800 px-2 py-1 rounded font-mono">
                                                {k}=<span className="text-blue-400">{v}</span>
                                            </span>
                                        ))}
                                    </div>
                                </CollapsibleSection>
                            )}

                            {/* Node Events */}
                            {nodeEvents.length > 0 && (
                                <CollapsibleSection
                                    title={`Events (${nodeEvents.length})`}
                                    icon={ScrollText}
                                    expanded={expandedSections.has('events')}
                                    onToggle={() => toggleSection('events')}
                                >
                                    <div className="space-y-2 max-h-60 overflow-y-auto">
                                        {nodeEvents.map((event, i) => (
                                            <div key={i} className="p-3 bg-zinc-900/50 rounded-lg">
                                                <div className="flex items-center gap-2">
                                                    {event.event_type === 'Warning' ? (
                                                        <AlertTriangle size={14} className="text-amber-500" />
                                                    ) : (
                                                        <CheckCircle size={14} className="text-emerald-500" />
                                                    )}
                                                    <span className="font-medium text-white">{event.reason}</span>
                                                    {event.count > 1 && (
                                                        <span className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded">×{event.count}</span>
                                                    )}
                                                </div>
                                                <p className="text-sm text-zinc-400 mt-1 ml-6">{event.message}</p>
                                            </div>
                                        ))}
                                    </div>
                                </CollapsibleSection>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-zinc-500">
                        <div className="text-center">
                            <Server size={40} className="mx-auto mb-3 opacity-50" />
                            <p>Select a node to view details</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// CHAT PANEL (AI Assistant)
// ============================================================================

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

// Get agent server URL from config
function getAgentServerUrl(): string {
    // Check localStorage first
    const stored = localStorage.getItem('opspilot-agent-url');
    if (stored) return stored;
    // Default
    return 'http://127.0.0.1:8765';
}

function ChatPanel({
    bundle,
    nodes,
    events,
    alerts,
    healthSummary,
    allResources,
}: {
    bundle: SupportBundle;
    nodes: BundleNodeInfo[];
    events: BundleEvent[];
    alerts: BundleAlerts | null;
    healthSummary: BundleHealthSummary | null;
    allResources: Map<string, BundleResource[]>;
}) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [agentStatus, setAgentStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
    const [streamingContent, setStreamingContent] = useState('');

    const messagesEndRef = useCallback((node: HTMLDivElement | null) => {
        if (node) node.scrollIntoView({ behavior: 'smooth' });
    }, []);

    // Check agent connection on mount
    useEffect(() => {
        const checkAgent = async () => {
            try {
                const resp = await fetch(`${getAgentServerUrl()}/health`, {
                    method: 'GET',
                    signal: AbortSignal.timeout(3000)
                });
                if (resp.ok) {
                    setAgentStatus('connected');
                } else {
                    setAgentStatus('disconnected');
                }
            } catch {
                setAgentStatus('disconnected');
            }
        };
        checkAgent();
    }, []);

    // Build context for AI
    const buildContext = useCallback(() => {
        const resourceList = Array.from(allResources.values()).flat();
        const pods = resourceList.filter(r => r.kind === 'Pod');
        const failingPods = pods.filter(p => {
            const s = p.status_phase?.toLowerCase() || '';
            return s.includes('error') || s.includes('crash') || s.includes('failed') || s.includes('backoff');
        });
        const warningEvents = events.filter(e => e.event_type === 'Warning');

        return `## Support Bundle Analysis Context

**Bundle Path:** ${bundle.path}
**Captured:** ${bundle.timestamp ? new Date(bundle.timestamp).toISOString() : 'Unknown'}

### Cluster Overview
- **Namespaces:** ${bundle.namespaces.length}
- **Total Resources:** ${resourceList.length}
- **Total Pods:** ${pods.length}
- **Nodes:** ${nodes.length}

### Health Status
- **Critical Alerts:** ${alerts?.critical?.length || 0}
- **Warning Alerts:** ${alerts?.warning?.length || 0}
- **Failing Pods:** ${failingPods.length}
- **Warning Events:** ${warningEvents.length}
- **Unhealthy Deployments:** ${healthSummary?.unhealthy_deployments?.length || 0}
- **Pending PVCs:** ${healthSummary?.pending_pvcs?.length || 0}

### Nodes
${nodes.map(n => `- **${n.name}**: ${n.status} (${n.roles.join(', ') || 'worker'}) - CPU: ${n.cpu_allocatable}/${n.cpu_capacity}, Memory: ${n.memory_allocatable}`).join('\n')}

### Critical Issues
${alerts?.critical?.slice(0, 10).map(a => `- [ALERT] ${a.name}: ${a.message || a.state}`).join('\n') || 'None'}

### Failing Pods
${failingPods.slice(0, 10).map(p => `- ${p.namespace}/${p.name}: ${p.status_phase}`).join('\n') || 'None'}

### Recent Warning Events (last 20)
${warningEvents.slice(0, 20).map(e => `- [${e.reason}] ${e.involved_object_kind}/${e.involved_object_name}: ${e.message.substring(0, 100)}`).join('\n') || 'None'}

### Namespaces with Resources
${bundle.namespaces.slice(0, 15).map(ns => {
    const res = allResources.get(ns) || [];
    return `- ${ns}: ${res.length} resources`;
}).join('\n')}
`;
    }, [bundle, nodes, events, alerts, healthSummary, allResources]);

    const sendMessage = async () => {
        if (!input.trim() || isLoading) return;

        const userQuery = input.trim();
        const userMessage: ChatMessage = {
            role: 'user',
            content: userQuery,
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);
        setStreamingContent('');

        try {
            const context = buildContext();
            const systemPrompt = `You are an expert Kubernetes SRE assistant analyzing a support bundle offline.
Your role is to help identify issues, explain problems, and provide actionable recommendations.
Be concise and practical. Focus on the most critical issues first.
When analyzing the bundle data, look for patterns such as:
- Pods in CrashLoopBackOff, ImagePullBackOff, or Error states
- Pending pods that may indicate resource constraints
- Warning events that suggest configuration issues
- Critical alerts that need immediate attention
- Node health issues
- Resource pressure (memory, CPU, disk)
Provide specific kubectl commands when helpful.

${context}`;

            // Use the agent server's analyze-direct endpoint (uses Claude CLI/Codex)
            const response = await fetch(`${getAgentServerUrl()}/analyze-direct`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: userQuery,
                    system_prompt: systemPrompt,
                    stream: true,
                }),
            });

            if (!response.ok) {
                throw new Error(`Agent error: ${response.status} ${response.statusText}`);
            }

            // Handle streaming response
            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();
            let fullContent = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.content) {
                                fullContent += data.content;
                                setStreamingContent(fullContent);
                            }
                            if (data.done) {
                                break;
                            }
                        } catch {
                            // Not JSON, might be raw content
                            if (line.slice(6).trim()) {
                                fullContent += line.slice(6);
                                setStreamingContent(fullContent);
                            }
                        }
                    }
                }
            }

            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content: fullContent || 'No response received.',
                timestamp: new Date(),
            };
            setMessages(prev => [...prev, assistantMessage]);
            setStreamingContent('');

        } catch (err: any) {
            const errorStr = err.toString();
            let errorContent = `I encountered an error: ${errorStr}`;

            if (errorStr.includes('Failed to fetch') || errorStr.includes('NetworkError')) {
                errorContent = `Could not connect to the AI agent. Make sure OpsPilot is running with the agent sidecar started.\n\nGo to Settings → Setup to verify Claude Code or Codex CLI is configured.`;
                setAgentStatus('disconnected');
            }

            const errorMessage: ChatMessage = {
                role: 'assistant',
                content: errorContent,
                timestamp: new Date(),
            };
            setMessages(prev => [...prev, errorMessage]);
        }

        setIsLoading(false);
    };

    const suggestedQuestions = [
        "What are the main issues in this cluster?",
        "Why are some pods failing?",
        "Summarize the cluster health",
        "What should I investigate first?",
        "Explain the warning events",
    ];

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-zinc-800 bg-zinc-900/30">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-purple-500/10 rounded-lg">
                            <Sparkles size={20} className="text-purple-400" />
                        </div>
                        <div>
                            <h2 className="font-semibold text-white">AI Bundle Assistant</h2>
                            <p className="text-sm text-zinc-500">Uses Claude CLI / Codex from Settings</p>
                        </div>
                    </div>
                    <div className={`flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium ${
                        agentStatus === 'connected'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : agentStatus === 'checking'
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-red-500/20 text-red-400'
                    }`}>
                        <div className={`w-1.5 h-1.5 rounded-full ${
                            agentStatus === 'connected' ? 'bg-emerald-400' :
                            agentStatus === 'checking' ? 'bg-amber-400 animate-pulse' : 'bg-red-400'
                        }`} />
                        {agentStatus === 'connected' ? 'Agent Connected' :
                         agentStatus === 'checking' ? 'Connecting...' : 'Agent Offline'}
                    </div>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center py-8">
                        <div className="w-16 h-16 bg-zinc-900 rounded-2xl flex items-center justify-center mb-4 border border-zinc-800">
                            <MessageSquare size={28} className="text-zinc-600" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-2">Start a Conversation</h3>
                        <p className="text-sm text-zinc-500 text-center mb-6 max-w-md">
                            Ask me anything about this support bundle. I can help you identify issues,
                            understand errors, and suggest next steps for debugging.
                        </p>
                        {agentStatus === 'disconnected' && (
                            <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400 text-sm max-w-md text-center">
                                Agent not connected. Go to Settings → Setup to configure Claude CLI or Codex.
                            </div>
                        )}
                        <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                            {suggestedQuestions.map((q, i) => (
                                <button
                                    key={i}
                                    onClick={() => setInput(q)}
                                    className="text-sm px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors"
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <>
                        {messages.map((msg, i) => (
                            <div
                                key={i}
                                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                            >
                                <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                                    msg.role === 'user'
                                        ? 'bg-blue-600 text-white'
                                        : 'bg-zinc-800 text-zinc-100'
                                }`}>
                                    <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
                                    <div className={`text-xs mt-2 ${
                                        msg.role === 'user' ? 'text-blue-200' : 'text-zinc-500'
                                    }`}>
                                        {msg.timestamp.toLocaleTimeString()}
                                    </div>
                                </div>
                            </div>
                        ))}
                        {/* Streaming content */}
                        {isLoading && streamingContent && (
                            <div className="flex justify-start">
                                <div className="max-w-[80%] bg-zinc-800 rounded-2xl px-4 py-3">
                                    <div className="whitespace-pre-wrap text-sm text-zinc-100">{streamingContent}</div>
                                    <div className="flex items-center gap-2 text-zinc-500 mt-2">
                                        <Loader2 size={12} className="animate-spin" />
                                        <span className="text-xs">Thinking...</span>
                                    </div>
                                </div>
                            </div>
                        )}
                        {/* Loading without content */}
                        {isLoading && !streamingContent && (
                            <div className="flex justify-start">
                                <div className="bg-zinc-800 rounded-2xl px-4 py-3">
                                    <div className="flex items-center gap-2 text-zinc-400">
                                        <Loader2 size={16} className="animate-spin" />
                                        <span className="text-sm">Analyzing bundle...</span>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </>
                )}
            </div>

            {/* Input */}
            <div className="p-4 border-t border-zinc-800 bg-zinc-900/30">
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                        placeholder="Ask about this support bundle..."
                        className="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white
                                 placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
                        disabled={isLoading || agentStatus === 'disconnected'}
                    />
                    <button
                        onClick={sendMessage}
                        disabled={!input.trim() || isLoading || agentStatus === 'disconnected'}
                        className="p-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed
                                 rounded-xl transition-colors"
                    >
                        <Send size={20} className="text-white" />
                    </button>
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// COLLAPSIBLE SECTION COMPONENT
// ============================================================================

function CollapsibleSection({
    title,
    icon: Icon,
    expanded,
    onToggle,
    children,
}: {
    title: string;
    icon: any;
    expanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) {
    return (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between p-4 hover:bg-zinc-800/30 transition-colors"
            >
                <div className="flex items-center gap-3">
                    <Icon size={18} className="text-zinc-400" />
                    <span className="font-medium text-white">{title}</span>
                </div>
                {expanded ? (
                    <ChevronUp size={18} className="text-zinc-500" />
                ) : (
                    <ChevronDown size={18} className="text-zinc-500" />
                )}
            </button>
            {expanded && (
                <div className="p-4 pt-0 border-t border-zinc-800">
                    {children}
                </div>
            )}
        </div>
    );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

function QuickStat({ icon: Icon, label, value, variant }: {
    icon: any;
    label: string;
    value: number;
    variant: 'danger' | 'warning' | 'success' | 'muted';
}) {
    const colors = {
        danger: 'text-red-400',
        warning: 'text-amber-400',
        success: 'text-emerald-400',
        muted: 'text-zinc-400',
    };

    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-zinc-400">
                <Icon size={14} />
                <span className="text-xs">{label}</span>
            </div>
            <span className={`text-sm font-semibold ${colors[variant]}`}>{value}</span>
        </div>
    );
}

function NavItem({ icon: Icon, label, active, onClick, badge, badgeVariant }: {
    icon: any;
    label: string;
    active: boolean;
    onClick: () => void;
    badge?: number;
    badgeVariant?: 'danger' | 'warning';
}) {
    return (
        <button
            onClick={onClick}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                active
                    ? 'bg-blue-600/20 text-blue-400'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
            }`}
        >
            <Icon size={18} />
            <span className="flex-1 text-left">{label}</span>
            {badge !== undefined && badge > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    badgeVariant === 'danger' ? 'bg-red-500/20 text-red-400' :
                    badgeVariant === 'warning' ? 'bg-amber-500/20 text-amber-400' :
                    'bg-zinc-700 text-zinc-400'
                }`}>
                    {badge}
                </span>
            )}
        </button>
    );
}

function MetricCard({ icon: Icon, label, value, subtext, variant, onClick }: {
    icon: any;
    label: string;
    value: number;
    subtext?: string;
    variant: 'danger' | 'warning' | 'success' | 'muted';
    onClick?: () => void;
}) {
    const colors = {
        danger: 'border-red-500/30 bg-red-500/5',
        warning: 'border-amber-500/30 bg-amber-500/5',
        success: 'border-emerald-500/30 bg-emerald-500/5',
        muted: 'border-zinc-700 bg-zinc-900/50',
    };

    const textColors = {
        danger: 'text-red-400',
        warning: 'text-amber-400',
        success: 'text-emerald-400',
        muted: 'text-zinc-400',
    };

    return (
        <button
            onClick={onClick}
            className={`p-4 rounded-xl border ${colors[variant]} text-left hover:opacity-80 transition-opacity`}
        >
            <Icon size={20} className={textColors[variant]} />
            <div className={`text-3xl font-bold mt-2 ${textColors[variant]}`}>{value}</div>
            <div className="text-sm text-zinc-400 mt-1">{label}</div>
            {subtext && <div className="text-xs text-zinc-500">{subtext}</div>}
        </button>
    );
}

function KindIcon({ kind, size = 14 }: { kind: string; size?: number }) {
    const iconMap: Record<string, { icon: any; color: string }> = {
        Pod: { icon: Box, color: 'text-purple-400' },
        Deployment: { icon: Layers, color: 'text-blue-400' },
        Service: { icon: Server, color: 'text-amber-400' },
        ConfigMap: { icon: FileText, color: 'text-orange-400' },
        Secret: { icon: Shield, color: 'text-red-400' },
        StatefulSet: { icon: Database, color: 'text-cyan-400' },
        DaemonSet: { icon: Network, color: 'text-teal-400' },
        Job: { icon: Zap, color: 'text-yellow-400' },
        CronJob: { icon: Clock, color: 'text-pink-400' },
    };

    const { icon: Icon, color } = iconMap[kind] || { icon: Box, color: 'text-zinc-500' };
    return <Icon size={size} className={color} />;
}

function StatusBadge({ status }: { status: string | null }) {
    if (!status) return <span className="text-xs text-zinc-500">-</span>;

    const s = status.toLowerCase();
    let color = 'bg-zinc-800 text-zinc-400';

    if (s === 'running' || s === 'succeeded' || s === 'ready' || s === 'true') {
        color = 'bg-emerald-500/20 text-emerald-400';
    } else if (s.includes('fail') || s.includes('error') || s.includes('crash') || s.includes('backoff')) {
        color = 'bg-red-500/20 text-red-400';
    } else if (s === 'pending' || s.includes('creating')) {
        color = 'bg-amber-500/20 text-amber-400';
    }

    return (
        <span className={`text-xs px-2 py-0.5 rounded ${color}`}>
            {status}
        </span>
    );
}

function StatusDot({ status }: { status: string | null }) {
    const s = (status || '').toLowerCase();
    let color = 'bg-zinc-500';

    if (s === 'running' || s === 'succeeded') {
        color = 'bg-emerald-500';
    } else if (s.includes('fail') || s.includes('error') || s.includes('crash') || s.includes('backoff')) {
        color = 'bg-red-500';
    } else if (s === 'pending') {
        color = 'bg-amber-500';
    }

    return <div className={`w-2 h-2 rounded-full ${color}`} />;
}

function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className="text-xs text-zinc-500 mb-1">{label}</div>
            <div className="text-sm text-white font-mono">{value}</div>
        </div>
    );
}

export default BundleInvestigator;
