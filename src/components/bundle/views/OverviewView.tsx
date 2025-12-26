/**
 * OverviewView - Dashboard with charts and stats for Bundle Investigator
 * Enhanced with visual health indicators and click-through navigation
 */

import { useMemo } from 'react';
import {
    AlertTriangle, CheckCircle, XCircle, Server, Box, Layers,
    AlertCircle, Database, Clock, Cpu, Activity, ChevronRight,
    Zap, TrendingDown, ExternalLink
} from 'lucide-react';
import {
    PieChart, Pie, Cell, ResponsiveContainer,
    BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid
} from 'recharts';
import { useBundleContext } from '../BundleContext';
import { BundleResource, BundleEvent, ViewType } from '../types';

const COLORS = {
    running: '#22c55e',
    pending: '#eab308',
    failed: '#ef4444',
    succeeded: '#3b82f6',
    unknown: '#6b7280'
};

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    Running: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30' },
    Succeeded: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
    Pending: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/30' },
    Failed: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
    Error: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
    CrashLoopBackOff: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
    ImagePullBackOff: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
    OOMKilled: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
};

// Health Score Circle - Larger and more prominent
function HealthScore({ score, onClick }: { score: number; onClick?: () => void }) {
    const color = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : '#ef4444';
    const status = score >= 80 ? 'Healthy' : score >= 60 ? 'Degraded' : 'Critical';
    const circumference = 2 * Math.PI * 54;
    const strokeDashoffset = circumference - (score / 100) * circumference;

    return (
        <div
            className={`relative w-40 h-40 ${onClick ? 'cursor-pointer hover:scale-105 transition-transform' : ''}`}
            onClick={onClick}
        >
            <svg className="w-full h-full -rotate-90">
                <circle cx="80" cy="80" r="54" stroke="#27272a" strokeWidth="10" fill="none" />
                <circle
                    cx="80" cy="80" r="54"
                    stroke={color}
                    strokeWidth="10"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    className="transition-all duration-1000"
                    style={{ filter: `drop-shadow(0 0 8px ${color}40)` }}
                />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-bold text-white">{score}</span>
                <span className="text-xs text-zinc-400 uppercase tracking-wider">{status}</span>
            </div>
        </div>
    );
}

// Clickable Stat Card
function StatCard({ icon: Icon, label, value, subValue, color = 'zinc', onClick, pulse }: {
    icon: any;
    label: string;
    value: number | string;
    subValue?: string;
    color?: string;
    onClick?: () => void;
    pulse?: boolean;
}) {
    const colorClasses: Record<string, string> = {
        green: 'bg-green-500/10 text-green-400 border-green-500/20 hover:border-green-500/40',
        red: 'bg-red-500/10 text-red-400 border-red-500/20 hover:border-red-500/40',
        yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20 hover:border-yellow-500/40',
        blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:border-blue-500/40',
        purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20 hover:border-purple-500/40',
        zinc: 'bg-zinc-800/50 text-zinc-400 border-zinc-700 hover:border-zinc-600'
    };

    return (
        <div
            className={`rounded-xl border p-4 transition-all ${colorClasses[color]} ${onClick ? 'cursor-pointer hover:scale-[1.02]' : ''} ${pulse ? 'animate-pulse' : ''}`}
            onClick={onClick}
        >
            <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${color !== 'zinc' ? `bg-${color}-500/20` : 'bg-zinc-700/50'}`}>
                    <Icon size={20} />
                </div>
                <div className="flex-1">
                    <div className="text-2xl font-bold text-white">{value}</div>
                    <div className="text-xs opacity-80">{label}</div>
                    {subValue && <div className="text-[10px] opacity-60">{subValue}</div>}
                </div>
                {onClick && <ChevronRight size={16} className="opacity-50" />}
            </div>
        </div>
    );
}

// Issue Card - Clickable card for failing resources
function IssueCard({ resource, onClick }: { resource: BundleResource; onClick: () => void }) {
    const statusColors = STATUS_COLORS[resource.status_phase || ''] || STATUS_COLORS.Failed;

    return (
        <div
            className={`p-3 rounded-lg border ${statusColors.bg} ${statusColors.border} cursor-pointer hover:scale-[1.01] transition-all group`}
            onClick={onClick}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded ${statusColors.bg} ${statusColors.text}`}>
                            {resource.status_phase}
                        </span>
                        <span className="text-[10px] text-zinc-500">{resource.kind}</span>
                    </div>
                    <div className="text-sm font-medium text-white mt-1 truncate">{resource.name}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">{resource.namespace || 'cluster-scoped'}</div>
                </div>
                <ExternalLink size={14} className="text-zinc-500 group-hover:text-zinc-300 transition-colors shrink-0 mt-1" />
            </div>
        </div>
    );
}

// Event Card - Clickable event
function EventCard({ event, onClick }: { event: BundleEvent; onClick: () => void }) {
    const isWarning = event.event_type === 'Warning';

    return (
        <div
            className={`p-3 rounded-lg border cursor-pointer hover:scale-[1.01] transition-all group ${isWarning ? 'bg-yellow-500/5 border-yellow-500/20 hover:border-yellow-500/40' : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'
                }`}
            onClick={onClick}
        >
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded ${isWarning ? 'bg-yellow-500/20 text-yellow-300' : 'bg-blue-500/20 text-blue-300'
                            }`}>
                            {event.reason}
                        </span>
                        {event.count > 1 && (
                            <span className="text-[10px] text-zinc-500">×{event.count}</span>
                        )}
                    </div>
                    <div className="text-xs text-zinc-300 mt-1.5 line-clamp-2">{event.message}</div>
                    <div className="text-[10px] text-zinc-600 mt-1">
                        {event.namespace}/{event.involved_object_name}
                    </div>
                </div>
                <ExternalLink size={14} className="text-zinc-500 group-hover:text-zinc-300 transition-colors shrink-0 mt-1" />
            </div>
        </div>
    );
}

export function OverviewView() {
    const {
        bundle, resources, events, alerts, nodes, namespaces, argoApps, logs,
        setActiveView, setSelectedResource
    } = useBundleContext();

    // Navigate to a resource
    const navigateToResource = (resource: BundleResource) => {
        setSelectedResource(resource);
        setActiveView('workloads');
    };

    // Navigate to events view
    const navigateToEvents = () => {
        setActiveView('events');
    };

    // Navigate to specific view
    const navigateToView = (view: ViewType) => {
        setActiveView(view);
    };

    // Compute stats
    const stats = useMemo(() => {
        const allPods: BundleResource[] = [];
        const allDeployments: BundleResource[] = [];
        const allServices: BundleResource[] = [];
        const allStatefulSets: BundleResource[] = [];
        const allDaemonSets: BundleResource[] = [];
        const allJobs: BundleResource[] = [];
        const allCronJobs: BundleResource[] = [];

        Object.values(resources).forEach(resList => {
            resList.forEach(r => {
                switch (r.kind) {
                    case 'Pod': allPods.push(r); break;
                    case 'Deployment': allDeployments.push(r); break;
                    case 'Service': allServices.push(r); break;
                    case 'StatefulSet': allStatefulSets.push(r); break;
                    case 'DaemonSet': allDaemonSets.push(r); break;
                    case 'Job': allJobs.push(r); break;
                    case 'CronJob': allCronJobs.push(r); break;
                }
            });
        });

        const runningPods = allPods.filter(p => p.status_phase === 'Running').length;
        const pendingPods = allPods.filter(p => p.status_phase === 'Pending').length;
        const failedPods = allPods.filter(p =>
            ['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff', 'OOMKilled'].includes(p.status_phase || '')
        );
        const succeededPods = allPods.filter(p => p.status_phase === 'Succeeded').length;

        const warningEvents = events.filter(e => e.event_type === 'Warning');
        const criticalAlerts = alerts?.critical || [];

        // Health score calculation
        const totalPods = allPods.length || 1;
        const healthyRatio = (runningPods + succeededPods) / totalPods;
        const healthScore = Math.round(
            healthyRatio * 60 +
            (warningEvents.length === 0 ? 20 : Math.max(0, 20 - warningEvents.length / 2)) +
            (criticalAlerts.length === 0 ? 20 : Math.max(0, 20 - criticalAlerts.length * 5))
        );

        return {
            totalPods: allPods.length,
            runningPods,
            pendingPods,
            failedPods,
            succeededPods,
            deployments: allDeployments.length,
            services: allServices.length,
            statefulSets: allStatefulSets.length,
            daemonSets: allDaemonSets.length,
            jobs: allJobs.length,
            cronJobs: allCronJobs.length,
            warningEvents,
            criticalAlerts,
            healthScore: Math.min(100, Math.max(0, healthScore))
        };
    }, [resources, events, alerts]);

    // Chart data
    const podStatusData = useMemo(() => [
        { name: 'Running', value: stats.runningPods, color: COLORS.running },
        { name: 'Pending', value: stats.pendingPods, color: COLORS.pending },
        { name: 'Failed', value: stats.failedPods.length, color: COLORS.failed },
        { name: 'Succeeded', value: stats.succeededPods, color: COLORS.succeeded }
    ].filter(d => d.value > 0), [stats]);

    const namespaceData = useMemo(() => {
        return namespaces
            .sort((a, b) => b.totalResources - a.totalResources)
            .slice(0, 8)
            .map(ns => ({
                name: ns.name.length > 15 ? ns.name.slice(0, 15) + '...' : ns.name,
                fullName: ns.name,
                resources: ns.totalResources,
                pods: ns.resourceCounts?.pods || 0
            }));
    }, [namespaces]);

    if (!bundle) return null;

    const hasCriticalIssues = stats.failedPods.length > 0 || stats.criticalAlerts.length > 0;

    return (
        <div className="p-6 space-y-6 overflow-auto">
            {/* Critical Alert Banner */}
            {hasCriticalIssues && (
                <div className="bg-gradient-to-r from-red-500/10 to-orange-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-red-500/20">
                        <Zap size={24} className="text-red-400" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-lg font-semibold text-red-300">Critical Issues Detected</h3>
                        <p className="text-sm text-red-200/70">
                            {stats.failedPods.length} failing pods, {stats.criticalAlerts.length} critical alerts
                        </p>
                    </div>
                    <button
                        onClick={() => navigateToView('workloads')}
                        className="px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 transition-colors flex items-center gap-2"
                    >
                        Investigate <ChevronRight size={16} />
                    </button>
                </div>
            )}

            {/* Header Stats Row */}
            <div className="flex items-start gap-6">
                <HealthScore score={stats.healthScore} />

                <div className="flex-1 grid grid-cols-4 gap-3">
                    <StatCard
                        icon={Box}
                        label="Total Pods"
                        value={stats.totalPods}
                        subValue={`${stats.runningPods} running`}
                        color="blue"
                        onClick={() => navigateToView('workloads')}
                    />
                    <StatCard
                        icon={XCircle}
                        label="Failing Pods"
                        value={stats.failedPods.length}
                        color={stats.failedPods.length > 0 ? 'red' : 'green'}
                        onClick={stats.failedPods.length > 0 ? () => navigateToView('workloads') : undefined}
                        pulse={stats.failedPods.length > 5}
                    />
                    <StatCard
                        icon={AlertTriangle}
                        label="Warning Events"
                        value={stats.warningEvents.length}
                        color={stats.warningEvents.length > 0 ? 'yellow' : 'green'}
                        onClick={stats.warningEvents.length > 0 ? navigateToEvents : undefined}
                    />
                    <StatCard
                        icon={AlertCircle}
                        label="Critical Alerts"
                        value={stats.criticalAlerts.length}
                        color={stats.criticalAlerts.length > 0 ? 'red' : 'green'}
                        pulse={stats.criticalAlerts.length > 0}
                    />
                </div>
            </div>

            {/* Main Content Grid */}
            <div className="grid grid-cols-3 gap-4">
                {/* Failing Pods - Priority Column */}
                <div className="col-span-1 bg-zinc-900/50 rounded-xl border border-zinc-800 p-4">
                    <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                        <TrendingDown size={14} className="text-red-400" />
                        Failing Resources ({stats.failedPods.length})
                    </h3>
                    <div className="space-y-2 max-h-[300px] overflow-auto">
                        {stats.failedPods.length === 0 ? (
                            <div className="text-center py-8">
                                <CheckCircle size={32} className="mx-auto mb-2 text-green-400" />
                                <div className="text-zinc-500 text-sm">All pods healthy</div>
                            </div>
                        ) : (
                            stats.failedPods.slice(0, 10).map((pod, i) => (
                                <IssueCard
                                    key={i}
                                    resource={pod}
                                    onClick={() => navigateToResource(pod)}
                                />
                            ))
                        )}
                        {stats.failedPods.length > 10 && (
                            <button
                                onClick={() => navigateToView('workloads')}
                                className="w-full text-center py-2 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                            >
                                View all {stats.failedPods.length} failing pods →
                            </button>
                        )}
                    </div>
                </div>

                {/* Pod Status Pie Chart */}
                <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4">
                    <h3 className="text-sm font-medium text-white mb-4">Pod Status Distribution</h3>
                    <div className="h-[250px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={podStatusData}
                                    cx="50%" cy="50%"
                                    innerRadius={50} outerRadius={80}
                                    dataKey="value"
                                    labelLine={false}
                                    label={({ name, value, percent }) =>
                                        `${name}: ${value} (${(percent * 100).toFixed(0)}%)`
                                    }
                                >
                                    {podStatusData.map((entry, i) => (
                                        <Cell key={i} fill={entry.color} />
                                    ))}
                                </Pie>
                                <Tooltip
                                    contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                                />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* Recent Warning Events */}
                <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4">
                    <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                        <AlertTriangle size={14} className="text-yellow-400" />
                        Recent Warnings
                    </h3>
                    <div className="space-y-2 max-h-[300px] overflow-auto">
                        {stats.warningEvents.length === 0 ? (
                            <div className="text-center py-8">
                                <CheckCircle size={32} className="mx-auto mb-2 text-green-400" />
                                <div className="text-zinc-500 text-sm">No warnings</div>
                            </div>
                        ) : (
                            stats.warningEvents.slice(0, 5).map((event, i) => (
                                <EventCard
                                    key={i}
                                    event={event}
                                    onClick={navigateToEvents}
                                />
                            ))
                        )}
                        {stats.warningEvents.length > 5 && (
                            <button
                                onClick={navigateToEvents}
                                className="w-full text-center py-2 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                            >
                                View all {stats.warningEvents.length} warnings →
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Namespace Resources Bar Chart */}
            <div className="bg-zinc-900/50 rounded-xl border border-zinc-800 p-4">
                <h3 className="text-sm font-medium text-white mb-4">Resources by Namespace (Top 8)</h3>
                <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={namespaceData} layout="vertical">
                            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                            <XAxis type="number" stroke="#71717a" fontSize={10} />
                            <YAxis dataKey="name" type="category" width={120} stroke="#71717a" fontSize={10} />
                            <Tooltip
                                contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                                labelStyle={{ color: '#fff' }}
                                formatter={(value: number, name: string) => [value, name === 'resources' ? 'Total Resources' : 'Pods']}
                            />
                            <Bar dataKey="resources" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* Quick Stats Grid */}
            <div className="grid grid-cols-6 gap-3">
                <StatCard icon={Layers} label="Namespaces" value={namespaces.length} onClick={() => navigateToView('namespaces')} />
                <StatCard icon={Activity} label="Deployments" value={stats.deployments} onClick={() => navigateToView('workloads')} />
                <StatCard icon={Database} label="StatefulSets" value={stats.statefulSets} onClick={() => navigateToView('workloads')} />
                <StatCard icon={Server} label="Nodes" value={nodes.length} color="purple" onClick={() => navigateToView('nodes')} />
                <StatCard icon={Clock} label="Jobs" value={stats.jobs} onClick={() => navigateToView('workloads')} />
                <StatCard icon={Cpu} label="ArgoCD Apps" value={argoApps.length} onClick={() => navigateToView('argocd')} />
            </div>

            {/* Critical Alerts Section */}
            {stats.criticalAlerts.length > 0 && (
                <div className="bg-red-500/5 rounded-xl border border-red-500/20 p-4">
                    <h3 className="text-sm font-medium text-red-300 mb-3 flex items-center gap-2">
                        <AlertCircle size={14} />
                        Critical Alerts ({stats.criticalAlerts.length})
                    </h3>
                    <div className="grid grid-cols-2 gap-2">
                        {stats.criticalAlerts.map((alert, i) => (
                            <div key={i} className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                                <div className="text-sm font-medium text-red-300">{alert.name}</div>
                                {alert.message && (
                                    <div className="text-xs text-red-200/70 mt-1 line-clamp-2">{alert.message}</div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Bundle Info Footer */}
            <div className="text-xs text-zinc-600 flex items-center gap-4 pt-4 border-t border-zinc-800">
                <span>Bundle: {bundle.path.split('/').pop()}</span>
                <span>•</span>
                <span>Total Resources: {bundle.total_resources}</span>
                <span>•</span>
                {bundle.timestamp && <span>Captured: {new Date(bundle.timestamp).toLocaleString()}</span>}
                <span>•</span>
                <span>Log Files: {logs.length}</span>
            </div>
        </div>
    );
}
