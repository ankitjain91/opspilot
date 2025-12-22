import React, { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Activity, Server, Box, Cpu, HardDrive, TrendingUp, ChevronDown, ChevronUp, Cloud, Database } from 'lucide-react';
import { ClusterMetricsSnapshot, AksMetricPoint } from '../../types/cockpit';
import { createLogger } from '../../utils/logger';

const log = createLogger('Timeline');

// Persistent storage for metrics history per cluster
const METRICS_STORAGE_KEY = 'opspilot_metrics_history';
const MAX_STORED_POINTS = 288; // 24 hours at 5-min intervals

interface StoredMetricsHistory {
    [contextName: string]: ClusterMetricsSnapshot[];
}

function normalizeContextKey(contextName: string | undefined): string {
    // Ensure we have a valid, non-empty context key
    // This prevents mixing metrics from different contexts
    if (!contextName || contextName.trim() === '') {
        return '__unknown_context__';
    }
    return contextName.trim();
}

function loadStoredMetrics(contextName: string | undefined): ClusterMetricsSnapshot[] {
    const key = normalizeContextKey(contextName);
    try {
        const stored = localStorage.getItem(METRICS_STORAGE_KEY);
        if (stored) {
            const data: StoredMetricsHistory = JSON.parse(stored);
            const metrics = data[key] || [];
            log.debug('Loaded stored metrics', { context: key, count: metrics.length });
            return metrics;
        }
    } catch (e) {
        console.warn('Failed to load stored metrics:', e);
    }
    return [];
}

function saveMetricsToStorage(contextName: string | undefined, metrics: ClusterMetricsSnapshot[]) {
    const key = normalizeContextKey(contextName);
    // Don't save metrics for unknown/unset context
    if (key === '__unknown_context__') {
        log.warn('Skipping metrics save - context not set');
        return;
    }

    try {
        const stored = localStorage.getItem(METRICS_STORAGE_KEY);
        const data: StoredMetricsHistory = stored ? JSON.parse(stored) : {};

        // Merge with existing, dedupe by timestamp, keep latest MAX_STORED_POINTS
        const existing = data[key] || [];
        const merged = [...existing, ...metrics];
        const deduped = merged.reduce((acc, m) => {
            if (!acc.find(x => x.timestamp === m.timestamp)) {
                acc.push(m);
            }
            return acc;
        }, [] as ClusterMetricsSnapshot[]);

        // Sort by timestamp and keep latest
        deduped.sort((a, b) => a.timestamp - b.timestamp);
        data[key] = deduped.slice(-MAX_STORED_POINTS);

        localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(data));
        log.debug('Saved metrics to storage', { context: key, count: data[key].length });
    } catch (e) {
        console.warn('Failed to save metrics:', e);
    }
}

interface ClusterTimelineChartProps {
    currentContext?: string;
}

type MetricView = 'resources' | 'utilization';
type DataSource = 'azure' | 'local' | 'loading';

export function ClusterTimelineChart({ currentContext }: ClusterTimelineChartProps) {
    const [isExpanded, setIsExpanded] = useState(true);
    const [metricView, setMetricView] = useState<MetricView>('resources');
    const [dataSource, setDataSource] = useState<DataSource>('loading');
    const [storedMetrics, setStoredMetrics] = useState<ClusterMetricsSnapshot[]>([]);

    // Load stored metrics on mount or context change
    // Clear state first to prevent showing stale data from previous context
    useEffect(() => {
        // Reset to loading state when context changes
        setDataSource('loading');
        setStoredMetrics([]);

        if (currentContext) {
            log.info('Context changed, loading metrics for', { context: currentContext });
            const stored = loadStoredMetrics(currentContext);
            setStoredMetrics(stored);
        }
    }, [currentContext]);

    // Try to detect if this is an AKS cluster
    const { data: aksResourceId, error: aksDetectError } = useQuery({
        queryKey: ['aks_detect', currentContext],
        queryFn: async () => {
            if (!currentContext) return null;
            try {
                log.debug('Detecting AKS cluster for context', { context: currentContext });
                const result = await invoke<string | null>('detect_aks_cluster', { contextName: currentContext });
                log.info('AKS detection result', { found: !!result, resourceId: result?.substring(0, 50) });
                return result;
            } catch (e) {
                log.warn('AKS detection failed', { error: String(e) });
                return null;
            }
        },
        staleTime: 300000, // Cache for 5 minutes
        enabled: !!currentContext,
    });

    // Fetch Azure Monitor metrics if AKS cluster detected
    const { data: azureMetrics = [], error: azureMetricsError } = useQuery({
        queryKey: ['aks_metrics', aksResourceId],
        queryFn: async () => {
            if (!aksResourceId) return [];
            try {
                log.info('Fetching Azure Monitor metrics', { resourceId: aksResourceId.substring(0, 50) });
                const result = await invoke<AksMetricPoint[]>('get_aks_metrics_history', {
                    resourceId: aksResourceId,
                    hours: 1
                });
                log.info('Azure metrics received', { points: result.length, sample: result[0] });
                return result;
            } catch (e) {
                log.error('Azure metrics fetch failed', { error: String(e) });
                return [];
            }
        },
        refetchInterval: 300000, // Refresh every 5 minutes
        staleTime: 240000,
        enabled: !!aksResourceId,
    });

    // Fallback: local in-memory metrics from backend
    const { data: localHistory = [], isLoading: isLocalLoading } = useQuery({
        queryKey: ['metrics_history', currentContext],
        queryFn: async () => {
            log.debug('Fetching local metrics history');
            const result = await invoke<ClusterMetricsSnapshot[]>('get_metrics_history');
            if (result.length > 0) {
                const latest = result[result.length - 1];
                log.info('Local history received', {
                    points: result.length,
                    latestNodes: latest.total_nodes,
                    latestPods: latest.total_pods
                });
            } else {
                log.debug('No local history available yet');
            }
            return result;
        },
        refetchInterval: 30000, // Sync with cockpit refresh
        staleTime: 25000,
    });

    // Save new metrics to persistent storage when they arrive
    useEffect(() => {
        if (currentContext && localHistory.length > 0) {
            // Log the metrics we're about to save for debugging
            const latest = localHistory[localHistory.length - 1];
            log.debug('Saving metrics to storage', {
                context: currentContext,
                points: localHistory.length,
                latestPods: latest?.total_pods,
                latestNodes: latest?.total_nodes
            });
            saveMetricsToStorage(currentContext, localHistory);
            // Also update our local state with merged data
            const stored = loadStoredMetrics(currentContext);
            setStoredMetrics(stored);
        }
    }, [currentContext, localHistory]);

    // Determine which data source is active (matches chartData logic)
    useEffect(() => {
        const allLocalData = [...storedMetrics, ...localHistory];
        const localSpanMinutes = allLocalData.length > 1
            ? (Math.max(...allLocalData.map(s => s.timestamp)) - Math.min(...allLocalData.map(s => s.timestamp))) / 60
            : 0;

        if (azureMetrics.length > 0 && localSpanMinutes < 10) {
            // Merged mode - show Azure as source since it provides the historical data
            setDataSource('azure');
        } else if (allLocalData.length > 0) {
            setDataSource('local');
        } else if (azureMetrics.length > 0) {
            setDataSource('azure');
        } else {
            setDataSource('loading');
        }
    }, [localHistory.length, azureMetrics.length, storedMetrics.length, localHistory, storedMetrics, azureMetrics]);

    // Transform data for charts
    // Strategy: Use local data as primary (more granular), but merge Azure historical data
    // when local data is sparse (< 5 minutes of history)
    const chartData = React.useMemo(() => {
        const transformLocalSnapshot = (snapshot: ClusterMetricsSnapshot) => {
            const date = new Date(snapshot.timestamp * 1000);
            return {
                time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                timestamp: snapshot.timestamp,
                nodes: snapshot.total_nodes,
                healthyNodes: snapshot.healthy_nodes,
                pods: snapshot.total_pods,
                runningPods: snapshot.running_pods,
                pendingPods: snapshot.pending_pods,
                failedPods: snapshot.failed_pods,
                deployments: snapshot.total_deployments,
                cpu: snapshot.cpu_usage_percent,
                memory: snapshot.memory_usage_percent,
                source: 'local' as const,
            };
        };

        const transformAzurePoint = (point: AksMetricPoint) => {
            const date = new Date(point.timestamp * 1000);
            return {
                time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                timestamp: point.timestamp,
                nodes: point.node_count ?? 0,
                pods: point.pod_count ?? 0,
                cpu: point.cpu_usage_percent ?? 0,
                memory: point.memory_usage_percent ?? 0,
                // Azure doesn't provide these granular breakdowns
                healthyNodes: point.node_count ?? 0,
                runningPods: point.pod_count ?? 0,
                pendingPods: 0,
                failedPods: 0,
                deployments: 0,
                source: 'azure' as const,
            };
        };

        // Combine all available local data (fresh + stored)
        const allLocalData = [...storedMetrics, ...localHistory];
        // Dedupe by timestamp
        const localByTimestamp = new Map<number, ClusterMetricsSnapshot>();
        for (const snap of allLocalData) {
            localByTimestamp.set(snap.timestamp, snap);
        }
        const dedupedLocal = Array.from(localByTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);

        // Calculate local data span in minutes
        const localSpanMinutes = dedupedLocal.length > 1
            ? (dedupedLocal[dedupedLocal.length - 1].timestamp - dedupedLocal[0].timestamp) / 60
            : 0;

        // If we have Azure data and local data is sparse (< 10 min), merge them
        if (azureMetrics.length > 0 && localSpanMinutes < 10) {
            log.info('Merging Azure historical data with local data', {
                azurePoints: azureMetrics.length,
                localPoints: dedupedLocal.length,
                localSpanMinutes: Math.round(localSpanMinutes)
            });

            // Find the oldest local timestamp to avoid overlap
            const oldestLocalTs = dedupedLocal.length > 0 ? dedupedLocal[0].timestamp : Infinity;

            // Take Azure data that's older than our local data
            const azureHistorical = azureMetrics
                .filter(p => p.timestamp < oldestLocalTs - 60) // 1 min buffer
                .map(transformAzurePoint);

            const localTransformed = dedupedLocal.map(transformLocalSnapshot);

            // Combine: Azure historical first, then local
            const merged = [...azureHistorical, ...localTransformed];
            merged.sort((a, b) => a.timestamp - b.timestamp);

            log.debug('Merged timeline', { total: merged.length, azure: azureHistorical.length, local: localTransformed.length });
            return merged;
        }

        // If we have enough local data, use it
        if (dedupedLocal.length > 0) {
            log.debug('Using local data', { points: dedupedLocal.length, spanMinutes: Math.round(localSpanMinutes) });
            return dedupedLocal.map(transformLocalSnapshot);
        }

        // Fallback: Azure only
        if (azureMetrics.length > 0) {
            log.debug('Using Azure metrics only', { points: azureMetrics.length });
            return azureMetrics.map(transformAzurePoint);
        }

        log.debug('No metrics data available');
        return [];
    }, [localHistory, azureMetrics, storedMetrics]);

    // Calculate trends (compare last vs first) and get current values
    const getTrend = (metric: keyof typeof chartData[0]) => {
        if (chartData.length === 0) return { value: 0, current: 0, direction: 'stable' as const };
        const first = chartData[0][metric] as number;
        const last = chartData[chartData.length - 1][metric] as number;
        const diff = last - first;
        return {
            value: Math.abs(diff),
            current: last,
            direction: diff > 0 ? 'up' as const : diff < 0 ? 'down' as const : 'stable' as const,
        };
    };

    const nodeTrend = getTrend('nodes');
    const podTrend = getTrend('pods');

    if (!isExpanded) {
        return (
            <button
                onClick={() => setIsExpanded(true)}
                className="w-full flex items-center justify-between p-3 bg-zinc-900/50 rounded-xl border border-zinc-800/50 hover:border-zinc-700/50 transition-colors group"
            >
                <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-cyan-400" />
                    <span className="text-sm font-medium text-zinc-300">Cluster Timeline</span>
                    {chartData.length > 0 && (
                        <span className="text-xs text-zinc-500">({chartData.length} data points)</span>
                    )}
                </div>
                <ChevronDown className="w-4 h-4 text-zinc-500 group-hover:text-zinc-400" />
            </button>
        );
    }

    return (
        <div className="bg-zinc-900/50 rounded-xl border border-zinc-800/50 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-zinc-800/50">
                <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-cyan-400" />
                    <span className="text-sm font-medium text-zinc-300">Cluster Timeline</span>
                    {chartData.length > 0 && (
                        <span className="text-xs text-zinc-500">
                            Last {Math.round((chartData[chartData.length - 1]?.timestamp - chartData[0]?.timestamp) / 60)} min
                        </span>
                    )}
                    {dataSource === 'azure' && (
                        <span
                            className="flex items-center gap-1 text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded cursor-help"
                            title="Historical data from Azure Monitor (up to 1 hour). AKS cluster detected."
                        >
                            <Cloud className="w-3 h-3" />
                            Azure Monitor
                        </span>
                    )}
                    {dataSource === 'local' && (
                        <span
                            className="flex items-center gap-1 text-[10px] text-zinc-400 bg-zinc-800/50 px-1.5 py-0.5 rounded cursor-help"
                            title="Metrics collected locally while app is running. Data persists across sessions (up to 24h). For full history, connect an AKS cluster or configure Prometheus."
                        >
                            <Database className="w-3 h-3" />
                            Local ({chartData.length} pts)
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {/* View Toggle */}
                    <div className="flex rounded-lg bg-zinc-800/50 p-0.5">
                        <button
                            onClick={() => setMetricView('resources')}
                            className={`px-2 py-1 text-xs rounded-md transition-colors ${
                                metricView === 'resources'
                                    ? 'bg-zinc-700 text-zinc-200'
                                    : 'text-zinc-500 hover:text-zinc-400'
                            }`}
                        >
                            Resources
                        </button>
                        <button
                            onClick={() => setMetricView('utilization')}
                            className={`px-2 py-1 text-xs rounded-md transition-colors ${
                                metricView === 'utilization'
                                    ? 'bg-zinc-700 text-zinc-200'
                                    : 'text-zinc-500 hover:text-zinc-400'
                            }`}
                        >
                            Utilization
                        </button>
                    </div>
                    <button
                        onClick={() => setIsExpanded(false)}
                        className="p-1 hover:bg-zinc-800 rounded transition-colors"
                    >
                        <ChevronUp className="w-4 h-4 text-zinc-500" />
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="p-3">
                {dataSource === 'loading' && chartData.length === 0 ? (
                    <div className="h-[140px] flex items-center justify-center text-zinc-500 text-sm">
                        <div className="flex flex-col items-center gap-2">
                            <div className="w-4 h-4 border-2 border-zinc-700 border-t-zinc-500 rounded-full animate-spin" />
                            <span>Loading metrics...</span>
                        </div>
                    </div>
                ) : chartData.length === 0 ? (
                    <div className="h-[140px] flex items-center justify-center text-zinc-500 text-sm">
                        <span>No metrics data available yet. Waiting for first cockpit refresh...</span>
                    </div>
                ) : (
                    <>
                        {/* Current Values & Trend Indicators */}
                        <div className="flex gap-6 mb-3">
                            <div className="flex items-center gap-2 text-xs">
                                <Server className="w-3 h-3 text-emerald-400" />
                                <span className="text-zinc-400">Nodes</span>
                                <span className="font-mono font-medium text-zinc-200">{nodeTrend.current}</span>
                                {nodeTrend.value > 0 && (
                                    <span className={`font-mono text-[10px] ${nodeTrend.direction === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
                                        ({nodeTrend.direction === 'up' ? '↑' : '↓'}{nodeTrend.value})
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <Box className="w-3 h-3 text-cyan-400" />
                                <span className="text-zinc-400">Pods</span>
                                <span className="font-mono font-medium text-zinc-200">{podTrend.current}</span>
                                {podTrend.value > 0 && (
                                    <span className={`font-mono text-[10px] ${podTrend.direction === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
                                        ({podTrend.direction === 'up' ? '↑' : '↓'}{podTrend.value})
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Chart */}
                        <div className="h-[120px]">
                            <ResponsiveContainer width="100%" height="100%">
                                {metricView === 'resources' ? (
                                    <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="nodesGradient" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                            </linearGradient>
                                            <linearGradient id="podsGradient" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                                            </linearGradient>
                                            <linearGradient id="runningGradient" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                                        <XAxis
                                            dataKey="time"
                                            stroke="#52525b"
                                            fontSize={10}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            stroke="#52525b"
                                            fontSize={10}
                                            tickLine={false}
                                            axisLine={false}
                                            width={30}
                                        />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: '#18181b',
                                                border: '1px solid #3f3f46',
                                                borderRadius: '8px',
                                                fontSize: '11px',
                                            }}
                                            labelStyle={{ color: '#a1a1aa' }}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="nodes"
                                            name="Nodes"
                                            stroke="#10b981"
                                            strokeWidth={2}
                                            fill="url(#nodesGradient)"
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="pods"
                                            name="Total Pods"
                                            stroke="#22d3ee"
                                            strokeWidth={2}
                                            fill="url(#podsGradient)"
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="runningPods"
                                            name="Running"
                                            stroke="#3b82f6"
                                            strokeWidth={1.5}
                                            fill="url(#runningGradient)"
                                            strokeDasharray="3 3"
                                        />
                                    </AreaChart>
                                ) : (
                                    <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                                            </linearGradient>
                                            <linearGradient id="memGradient" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                                        <XAxis
                                            dataKey="time"
                                            stroke="#52525b"
                                            fontSize={10}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            stroke="#52525b"
                                            fontSize={10}
                                            tickLine={false}
                                            axisLine={false}
                                            width={30}
                                            domain={[0, 100]}
                                            tickFormatter={(v) => `${v}%`}
                                        />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: '#18181b',
                                                border: '1px solid #3f3f46',
                                                borderRadius: '8px',
                                                fontSize: '11px',
                                            }}
                                            labelStyle={{ color: '#a1a1aa' }}
                                            formatter={(value: number) => [`${value.toFixed(1)}%`, '']}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="cpu"
                                            name="CPU"
                                            stroke="#f59e0b"
                                            strokeWidth={2}
                                            fill="url(#cpuGradient)"
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="memory"
                                            name="Memory"
                                            stroke="#8b5cf6"
                                            strokeWidth={2}
                                            fill="url(#memGradient)"
                                        />
                                    </AreaChart>
                                )}
                            </ResponsiveContainer>
                        </div>

                        {/* Legend */}
                        <div className="flex justify-center gap-4 mt-2">
                            {metricView === 'resources' ? (
                                <>
                                    <div className="flex items-center gap-1.5 text-[10px]">
                                        <div className="w-2 h-2 rounded-full bg-emerald-400" />
                                        <span className="text-zinc-400">Nodes</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 text-[10px]">
                                        <div className="w-2 h-2 rounded-full bg-cyan-400" />
                                        <span className="text-zinc-400">Pods</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 text-[10px]">
                                        <div className="w-2 h-2 rounded-full bg-blue-400" />
                                        <span className="text-zinc-400">Running</span>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="flex items-center gap-1.5 text-[10px]">
                                        <div className="w-2 h-2 rounded-full bg-amber-400" />
                                        <span className="text-zinc-400">CPU</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 text-[10px]">
                                        <div className="w-2 h-2 rounded-full bg-purple-400" />
                                        <span className="text-zinc-400">Memory</span>
                                    </div>
                                </>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
