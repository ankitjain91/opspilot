import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
    Archive, FolderOpen, X, AlertTriangle, CheckCircle, Clock,
    Search, ChevronRight, ChevronDown, FileText, Activity,
    Loader2, Box, Server, Network, Settings2, Layers, Database,
    XCircle, Copy, Check, ArrowLeft, Zap, RefreshCw,
    AlertOctagon, Eye, Terminal, ExternalLink, ChevronUp,
    Info, Flame, HardDrive, MemoryStick, Cpu, Download,
    Filter, BarChart3, GitBranch, Calendar, TrendingUp,
    Shield, AlertCircle, Target, Gauge, FileDown, PanelRightOpen,
    PanelRightClose, Timer, Hash, Tag, Crosshair, Brain, Sparkles,
    LayoutDashboard, Grip, List, Split
} from 'lucide-react';
import { BundleAIAnalyzer } from './BundleAIAnalyzer';
import { BundleHealthGauge } from './BundleHealthGauge';
import { CriticalAlertTicker } from './CriticalAlertTicker';
import { BundleTimeline } from './BundleTimeline';
import { BundleTopology } from './BundleTopology';
import { BundleIssues } from './BundleIssues';
import { BundleResourceExplorer } from './BundleResourceExplorer';
import type {
    SupportBundle, BundleResource, BundleEvent, BundleHealthSummary,
    BundleAlerts, BundleLogFile, PodHealthInfo, DeploymentHealthInfo, PreloadedBundleData,
    DetectedIssue, ClusterOverview
} from './types';

// ============================================================================
// TYPES (retained/simplified)
// ============================================================================

interface FilterState {
    status: ('failing' | 'warning' | 'healthy' | 'pending')[];
    resourceTypes: string[];
    namespaces: string[];
    issueTypes: string[];
    severity: ('critical' | 'warning' | 'info')[];
    hasLogs: boolean | null;
    timeRange: 'all' | '1h' | '6h' | '24h' | '7d';
}

// ============================================================================
// HELPER FUNCTIONS (retained)
// ============================================================================

function analyzeBundle(
    allResources: Map<string, BundleResource[]>,
    events: BundleEvent[],
    alerts: BundleAlerts | null,
    healthSummary: BundleHealthSummary | null
): DetectedIssue[] {
    const issues: DetectedIssue[] = [];
    const allResourcesList: BundleResource[] = [];
    allResources.forEach(r => allResourcesList.push(...r));

    // Analyze failing pods
    if (healthSummary?.failing_pods) {
        for (const podInfo of healthSummary.failing_pods) {
            const podEvents = events.filter(e =>
                e.involved_object_name === podInfo.name && e.involved_object_kind === 'Pod'
            );

            // Basic failure analysis if pod struct is missing
            const failureReason = podInfo.reason || podInfo.status || 'Unknown';
            let failureType = 'error';
            let title = 'Pod Failure';
            let suggestions = ['Check events', 'Check logs'];

            if (failureReason.includes('CrashLoop')) {
                failureType = 'crash';
                title = 'CrashLoopBackOff';
                suggestions = ['Check logs for application panic', 'Verify env vars'];
            } else if (failureReason.includes('OOM')) {
                failureType = 'oom';
                title = 'Out of Memory';
                suggestions = ['Increase memory limits'];
            } else if (failureReason.includes('Image')) {
                failureType = 'image';
                title = 'Image Pull Error';
                suggestions = ['Check image name/tag', 'Check registry auth'];
            }

            issues.push({
                id: `pod-${podInfo.namespace}-${podInfo.name}`,
                type: failureType,
                title: title,
                description: `${podInfo.name} is in ${podInfo.status} state. Reason: ${failureReason}`,
                severity: 'critical',
                namespace: podInfo.namespace,
                affectedResource: podInfo.name,
                resourceKind: 'Pod',
                rootCause: failureReason,
                suggestions: suggestions,
                relatedEvents: podEvents,
                timestamp: undefined // Could infer from events if needed
            });
        }
    }

    // Analyze critical alerts
    if (alerts?.critical) {
        for (const alert of alerts.critical) {
            issues.push({
                id: `alert-critical-${alert.name}`,
                type: 'alert',
                title: alert.name,
                description: alert.message || 'Critical alert firing',
                severity: 'critical',
                namespace: alert.labels['namespace'] || 'cluster',
                affectedResource: alert.labels['pod'] || alert.labels['deployment'] || alert.name,
                resourceKind: 'Alert',
                suggestions: ['Investigate the alert conditions', 'Check related metrics'],
                relatedEvents: []
            });
        }
    }

    return issues.sort((a, b) => {
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
    });
}

function computeOverview(
    allResources: Map<string, BundleResource[]>,
    events: BundleEvent[],
    alerts: BundleAlerts | null,
    healthSummary: BundleHealthSummary | null
): ClusterOverview {
    let totalPods = 0, healthyPods = 0, failingPods = 0, pendingPods = 0;
    let totalDeployments = 0, healthyDeployments = 0;
    let totalServices = 0;
    const namespaceHealth = new Map<string, { healthy: number; total: number }>();

    allResources.forEach((resources, ns) => {
        let nsHealthy = 0, nsTotal = 0;

        for (const r of resources) {
            if (r.kind === 'Pod') {
                totalPods++;
                nsTotal++;
                const status = r.status_phase?.toLowerCase() || '';
                if (status === 'running' || status === 'succeeded') {
                    healthyPods++;
                    nsHealthy++;
                } else if (status === 'pending') {
                    pendingPods++;
                } else if (status.includes('error') || status.includes('crash') || status.includes('failed')) {
                    failingPods++;
                }
            } else if (r.kind === 'Deployment') {
                totalDeployments++;
                const isHealthy = !healthSummary?.unhealthy_deployments?.some(
                    d => d.name === r.name && d.namespace === ns
                );
                if (isHealthy) healthyDeployments++;
            } else if (r.kind === 'Service') {
                totalServices++;
            }
        }
        namespaceHealth.set(ns, { healthy: nsHealthy, total: nsTotal });
    });

    failingPods = Math.max(failingPods, healthSummary?.failing_pods?.length || 0);

    const warningEvents = events.filter(e => e.event_type === 'Warning').length;
    const criticalAlerts = alerts?.critical?.length || 0;
    const warningAlerts = alerts?.warning?.length || 0;

    // Calculate health score (0-100)
    let healthScore = 100;
    if (totalPods > 0) {
        healthScore -= (failingPods / totalPods) * 40;
        healthScore -= (pendingPods / totalPods) * 10;
    }
    if (totalDeployments > 0) {
        const unhealthyDeps = totalDeployments - healthyDeployments;
        healthScore -= (unhealthyDeps / totalDeployments) * 20;
    }
    healthScore -= Math.min(criticalAlerts * 5, 15);
    healthScore -= Math.min(warningAlerts * 2, 10);
    healthScore -= Math.min(warningEvents * 0.5, 5);
    healthScore = Math.max(0, Math.round(healthScore));

    return {
        healthScore, totalPods, healthyPods, failingPods, pendingPods,
        totalDeployments, healthyDeployments, totalServices,
        warningEvents, criticalAlerts, warningAlerts, namespaceHealth
    };
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface BundleDashboardProps {
    onClose?: () => void;
    preloadedData?: PreloadedBundleData;
}

export function BundleDashboard({ onClose, preloadedData }: BundleDashboardProps) {
    // State
    const [bundle, setBundle] = useState<SupportBundle | null>(preloadedData?.bundle || null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'overview' | 'issues' | 'timeline' | 'resources'>('overview');

    // Data State
    const [allResources, setAllResources] = useState<Map<string, BundleResource[]>>(preloadedData?.allResources || new Map());
    const [events, setEvents] = useState<BundleEvent[]>(preloadedData?.events || []);
    const [alerts, setAlerts] = useState<BundleAlerts | null>(preloadedData?.alerts || null);
    const [healthSummary, setHealthSummary] = useState<BundleHealthSummary | null>(preloadedData?.healthSummary || null);

    // UI State
    const [aiPanelOpen, setAiPanelOpen] = useState(false);
    const [selectedIssue, setSelectedIssue] = useState<DetectedIssue | null>(null);
    const [resourceViewMode, setResourceViewMode] = useState<'graph' | 'list'>('graph');

    // Derived State
    const overview = useMemo(() =>
        computeOverview(allResources, events, alerts, healthSummary),
        [allResources, events, alerts, healthSummary]
    );

    const issues = useMemo(() =>
        analyzeBundle(allResources, events, alerts, healthSummary),
        [allResources, events, alerts, healthSummary]
    );

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

            // 1. Load basic bundle info
            const bundleData = await invoke<SupportBundle>('load_support_bundle', { path });
            setBundle(bundleData);

            // 2. Load supporting data in parallel
            const [eventsData, alertsData, healthData, resourcesData] = await Promise.all([
                invoke<BundleEvent[]>('get_bundle_events', { bundlePath: path }),
                invoke<BundleAlerts>('get_bundle_alerts', { bundlePath: path }),
                invoke<BundleHealthSummary>('get_bundle_health_summary', { bundlePath: path }),
                invoke<Record<string, BundleResource[]>>('get_all_bundle_resources', { bundlePath: path })
            ]);

            setEvents(eventsData);
            setAlerts(alertsData);
            setHealthSummary(healthData);

            // 3. Convert resources object to Map
            const resourcesMap = new Map<string, BundleResource[]>();
            for (const [ns, resources] of Object.entries(resourcesData)) {
                resourcesMap.set(ns, resources);
            }
            setAllResources(resourcesMap);

            setLoading(false);
        } catch (err: any) {
            console.error('Failed to load bundle:', err);
            setError(err.toString());
            setLoading(false);
        }
    };

    const handleCloseBundle = async () => {
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

    if (!bundle && !loading) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-zinc-950 p-8 text-center">
                <div className="w-24 h-24 bg-zinc-900 rounded-2xl flex items-center justify-center mb-6 border border-white/5">
                    <Archive className="w-10 h-10 text-zinc-500" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Support Bundle Analysis</h2>
                <p className="text-zinc-400 max-w-md mb-8">
                    Import a Kubernetes support bundle to analyze cluster health,
                    view logs, and debug issues offline.
                </p>
                <div className="flex gap-4">
                    <button
                        onClick={loadBundle}
                        className="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg flex items-center gap-2 transition-all shadow-lg shadow-purple-900/20"
                    >
                        <FolderOpen size={20} />
                        Select Bundle Directory
                    </button>
                </div>
                {error && (
                    <div className="mt-8 p-4 bg-red-500/10 border border-red-500/20 rounded-lg max-w-md">
                        <div className="flex items-center gap-2 text-red-400 mb-1">
                            <AlertTriangle size={16} />
                            <span className="font-semibold">Error Loading Bundle</span>
                        </div>
                        <p className="text-sm text-zinc-400 break-all">{error}</p>
                    </div>
                )}
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-full bg-zinc-950">
                <Loader2 className="w-8 h-8 text-purple-500 animate-spin mb-4" />
                <p className="text-zinc-400"> Analyzing bundle content...</p>
            </div>
        );
    }

    // ========================================================================
    // WAR ROOM DASHBOARD LAYOUT
    // ========================================================================

    return (
        <div className="flex h-full bg-zinc-950 text-white overflow-hidden">
            {/* LEFT SIDEBAR (Navigation) */}
            <div className="w-16 bg-zinc-900 border-r border-white/10 flex flex-col items-center py-4 gap-2 z-20">
                <button
                    onClick={handleCloseBundle}
                    className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg mb-4"
                    title="Close Bundle"
                >
                    <ArrowLeft size={20} />
                </button>

                <div className="w-8 h-[1px] bg-white/10 mb-2" />

                <NavButton
                    active={activeTab === 'overview'}
                    onClick={() => setActiveTab('overview')}
                    icon={LayoutDashboard}
                    label="Overview"
                />
                <NavButton
                    active={activeTab === 'issues'}
                    onClick={() => setActiveTab('issues')}
                    icon={AlertCircle}
                    label="Issues"
                    alertCount={issues.length}
                />
                <NavButton
                    active={activeTab === 'timeline'}
                    onClick={() => setActiveTab('timeline')}
                    icon={Activity}
                    label="Timeline"
                />
                <NavButton
                    active={activeTab === 'resources'}
                    onClick={() => setActiveTab('resources')}
                    icon={Layers}
                    label="Resources"
                />

                <div className="flex-1" />

                <NavButton
                    active={aiPanelOpen}
                    onClick={() => setAiPanelOpen(!aiPanelOpen)}
                    icon={Brain}
                    label="AI Analyst"
                    color="text-purple-400"
                />
            </div>

            {/* MAIN CONTENT AREA */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">

                {/* TOP BAR: Context & Alerts */}
                <div className="shrink-0 bg-zinc-900/50 border-b border-white/10">
                    <div className="px-6 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-2 h-8 bg-purple-500 rounded-full" />
                            <div>
                                <h1 className="text-lg font-bold truncate max-w-xl" title={bundle?.path}>
                                    {bundle?.path.split('/').pop()}
                                </h1>
                                <div className="flex items-center gap-2 text-xs text-zinc-400">
                                    <Clock size={12} />
                                    <span>{bundle?.timestamp ? new Date(bundle.timestamp).toLocaleString() : 'Time unknown'}</span>
                                    <span className="mx-1">•</span>
                                    <span>{bundle?.namespaces.length} Namespaces</span>
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 rounded-lg border border-white/5">
                                <Database size={14} className="text-zinc-500" />
                                <span className="text-sm font-medium">{overview.totalPods} Pods</span>
                            </div>
                            <button
                                onClick={() => setAiPanelOpen(true)}
                                className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500/80 text-white text-sm font-medium rounded-lg flex items-center gap-2 transition-colors"
                            >
                                <Sparkles size={14} />
                                Fix Issues
                            </button>
                        </div>
                    </div>

                    {/* Alert Ticker */}
                    {alerts && <CriticalAlertTicker alerts={alerts.critical} />}
                </div>

                {/* SCROLLABLE VIEW PORT */}
                <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">

                    {/* VIEW: OVERVIEW (The War Room) */}
                    {activeTab === 'overview' && (
                        <div className="grid grid-cols-12 gap-6 max-w-7xl mx-auto">

                            {/* 1. Health Gauge (Top Left) */}
                            <div className="col-span-12 md:col-span-4 lg:col-span-3">
                                <Card>
                                    <div className="flex flex-col items-center p-4">
                                        <h3 className="text-sm font-medium text-zinc-400 mb-2 w-full">Cluster Health</h3>
                                        <BundleHealthGauge score={overview.healthScore} />

                                        <div className="w-full grid grid-cols-2 gap-2 mt-4">
                                            <StatCompact label="Failing Pods" value={overview.failingPods} color="text-red-400" />
                                            <StatCompact label="Warnings" value={overview.warningEvents} color="text-amber-400" />
                                        </div>
                                    </div>
                                </Card>
                            </div>

                            {/* 2. Timeline Preview (Top Center/Right) */}
                            <div className="col-span-12 md:col-span-8 lg:col-span-9">
                                <Card className="h-full flex flex-col justify-center">
                                    <div className="px-4 py-3 border-b border-white/5 flex justify-between items-center">
                                        <h3 className="text-sm font-medium text-zinc-400 inline-flex items-center gap-2">
                                            <Activity size={14} />
                                            Active Timeline
                                        </h3>
                                        <button
                                            onClick={() => setActiveTab('timeline')}
                                            className="text-xs text-purple-400 hover:text-purple-300"
                                        >
                                            View Full
                                        </button>
                                    </div>
                                    <div className="p-4 flex-1 flex flex-col justify-center">
                                        <BundleTimeline events={events} />
                                    </div>
                                </Card>
                            </div>

                            {/* 3. Top Issues List (Middle) */}
                            <div className="col-span-12 lg:col-span-8">
                                <Card className="min-h-[300px]">
                                    <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                                        <h3 className="text-sm font-medium text-white inline-flex items-center gap-2">
                                            <AlertCircle size={14} className="text-red-400" />
                                            Prioritized Issues ({issues.length})
                                        </h3>
                                    </div>
                                    <div className="divide-y divide-white/5">
                                        {issues.slice(0, 5).map(issue => (
                                            <div key={issue.id} className="p-4 hover:bg-white/5 transition-colors cursor-pointer group" onClick={() => {
                                                setSelectedIssue(issue);
                                                setAiPanelOpen(true);
                                            }}>
                                                <div className="flex items-start justify-between">
                                                    <div className="flex items-start gap-3">
                                                        <div className={`mt-1 w-2 h-2 rounded-full ${issue.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'
                                                            }`} />
                                                        <div>
                                                            <div className="font-medium text-sm text-zinc-200 group-hover:text-purple-300 transition-colors">
                                                                {issue.title}
                                                            </div>
                                                            <div className="text-xs text-zinc-500 mt-0.5">
                                                                {issue.resourceKind} / {issue.affectedResource}
                                                            </div>
                                                            <div className="text-xs text-zinc-400 mt-1 line-clamp-1">
                                                                {issue.description}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <ChevronRight size={16} className="text-zinc-600 group-hover:text-zinc-400" />
                                                </div>
                                            </div>
                                        ))}
                                        {issues.length === 0 && (
                                            <div className="p-8 text-center text-zinc-500 text-sm">
                                                No issues detected. Cluster looks healthy!
                                            </div>
                                        )}
                                        {issues.length > 5 && (
                                            <div
                                                onClick={() => setActiveTab('issues')}
                                                className="p-3 text-center text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/5 cursor-pointer"
                                            >
                                                View {issues.length - 5} more issues...
                                            </div>
                                        )}
                                    </div>
                                </Card>
                            </div>

                            {/* 4. Namespace Heatmap (Middle Right) */}
                            <div className="col-span-12 lg:col-span-4">
                                <Card className="h-full">
                                    <div className="px-4 py-3 border-b border-white/5">
                                        <h3 className="text-sm font-medium text-white">Namespace Health</h3>
                                    </div>
                                    <div className="p-4 space-y-3">
                                        {Array.from(overview.namespaceHealth.entries())
                                            .sort((a, b) => b[1].total - a[1].total) // largest first
                                            .slice(0, 8)
                                            .map(([ns, stats]) => {
                                                const healthPercent = stats.total > 0 ? (stats.healthy / stats.total) * 100 : 100;
                                                const color = healthPercent === 100 ? 'bg-emerald-500' : healthPercent > 70 ? 'bg-amber-500' : 'bg-red-500';

                                                return (
                                                    <div key={ns} className="space-y-1">
                                                        <div className="flex justify-between text-xs">
                                                            <span className="text-zinc-300 font-medium">{ns}</span>
                                                            <span className="text-zinc-500">{stats.healthy}/{stats.total} Ready</span>
                                                        </div>
                                                        <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                                                            <div
                                                                className={`h-full ${color}`}
                                                                style={{ width: `${healthPercent}%` }}
                                                            />
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                    </div>
                                </Card>
                            </div>

                        </div>
                    )}

                    {/* VIEW: TIMELINE */}
                    {activeTab === 'timeline' && (
                        <div className="h-full flex flex-col gap-4">
                            <Card className="flex-1 p-6 flex flex-col">
                                <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                                    <Activity className="text-purple-400" />
                                    Cluster Event Timeline
                                </h2>
                                <div className="flex-1">
                                    <BundleTimeline events={events} />
                                </div>
                            </Card>
                        </div>
                    )}

                    {/* VIEW: RESOURCES (Topology / Explorer) */}
                    {activeTab === 'resources' && (
                        <div className="h-full flex flex-col gap-4">
                            <Card className="flex-1 p-4 flex flex-col relative bg-zinc-950/50">
                                {/* Header / Toggle */}
                                <div className="flex items-center justify-between mb-4 z-10 relative">
                                    <h2 className="text-lg font-bold flex items-center gap-2">
                                        <Network className="text-blue-400" />
                                        Cluster Resources
                                    </h2>
                                    <div className="flex p-0.5 bg-zinc-900 border border-white/10 rounded-lg">
                                        <button
                                            onClick={() => setResourceViewMode('graph')}
                                            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-2 ${resourceViewMode === 'graph'
                                                ? 'bg-zinc-800 text-white shadow-sm'
                                                : 'text-zinc-500 hover:text-zinc-300'
                                                }`}
                                        >
                                            <Activity size={14} /> Topology
                                        </button>
                                        <button
                                            onClick={() => setResourceViewMode('list')}
                                            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-2 ${resourceViewMode === 'list'
                                                ? 'bg-zinc-800 text-white shadow-sm'
                                                : 'text-zinc-500 hover:text-zinc-300'
                                                }`}
                                        >
                                            <List size={14} /> Explorer
                                        </button>
                                    </div>
                                </div>

                                {/* Content */}
                                <div className="flex-1 bg-black/20 rounded-xl overflow-hidden border border-white/5 relative">
                                    {resourceViewMode === 'graph' ? (
                                        <BundleTopology resources={Array.from(allResources.values()).flat()} />
                                    ) : (
                                        <BundleResourceExplorer allResources={allResources} />
                                    )}
                                </div>
                            </Card>
                        </div>
                    )}

                    {/* VIEW: ISSUES (Master-Detail) */}
                    {activeTab === 'issues' && (
                        <div className="h-full">
                            <BundleIssues
                                issues={issues}
                                allResources={allResources}
                                events={events}
                            />
                        </div>
                    )}

                </div>

                {/* SLIDE-OUT AI PANEL */}
                {aiPanelOpen && bundle && (
                    <div className="absolute top-0 right-0 bottom-0 w-[450px] bg-zinc-950 border-l border-white/10 shadow-2xl z-30 transition-transform duration-300 animate-in slide-in-from-right">
                        <BundleAIAnalyzer
                            bundlePath={bundle.path}
                            context={{
                                healthSummary,
                                alerts,
                                events,
                                overview,
                                namespaces: bundle.namespaces
                            }}
                            onClose={() => setAiPanelOpen(false)}
                        />
                    </div>
                )}

            </div>
        </div>
    );
}

// ============================================================================
// UI HELPER COMPONENTS
// ============================================================================

function Card({ children, className = "" }: { children: React.ReactNode, className?: string }) {
    return (
        <div className={`bg-zinc-900/50 border border-white/10 rounded-xl overflow-hidden ${className}`}>
            {children}
        </div>
    );
}

function StatCompact({ label, value, color }: { label: string, value: string | number, color: string }) {
    return (
        <div className="p-2 bg-zinc-800/50 rounded-lg text-center border border-white/5">
            <div className={`text-xl font-bold ${color}`}>{value}</div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</div>
        </div>
    );
}

function NavButton({ active, onClick, icon: Icon, label, alertCount, color }: any) {
    return (
        <button
            onClick={onClick}
            className={`w-12 h-12 flex flex-col items-center justify-center rounded-xl transition-all relative group ${active
                ? 'bg-purple-500/10 text-purple-400'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                }`}
        >
            <Icon size={20} className={`mb-1 ${color}`} />
            <span className="text-[9px] font-medium">{label}</span>

            {alertCount > 0 && (
                <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center font-bold border border-zinc-900">
                    {alertCount > 9 ? '9+' : alertCount}
                </div>
            )}
        </button>
    );
}
