
import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { Cpu, HardDrive } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ResourceMetrics } from '../../../types/k8s';

interface MetricsChartProps {
    resourceKind: string;
    namespace: string;
    name: string;
    currentContext?: string;
}

export function MetricsChart({ resourceKind, namespace, name, currentContext }: MetricsChartProps) {
    const [metricsHistory, setMetricsHistory] = useState<ResourceMetrics[]>([]);

    const { data: currentMetrics } = useQuery({
        queryKey: ["metrics_chart", currentContext, resourceKind, namespace, name],
        queryFn: async () => {
            const allMetrics = await invoke<ResourceMetrics[]>("get_resource_metrics", {
                kind: resourceKind,
                namespace: resourceKind === "Pod" ? namespace : null
            });
            return allMetrics.find(m => m.name === name);
        },
        enabled: resourceKind === "Pod" || resourceKind === "Node",
        refetchInterval: 5000,
    });

    // Clear metrics history when context changes
    useEffect(() => {
        setMetricsHistory([]);
    }, [currentContext]);

    useEffect(() => {
        if (currentMetrics) {
            setMetricsHistory(prev => {
                const updated = [...prev, currentMetrics];
                // Keep last 60 data points (5 minutes at 5s intervals)
                return updated.slice(-60);
            });
        }
    }, [currentMetrics]);

    const getPercentageColor = (percent?: number) => {
        if (!percent) return '#6b7280'; // gray-500
        if (percent >= 90) return '#f87171'; // red-400
        if (percent >= 70) return '#fbbf24'; // yellow-400
        return '#34d399'; // green-400
    };

    const chartData = metricsHistory.map(m => ({
        time: new Date(m.timestamp).toLocaleTimeString(),
        cpu: (m.cpu_nano / 1_000_000).toFixed(2), // Convert to millicores
        memory: (m.memory_bytes / (1024 * 1024)).toFixed(2), // Convert to Mi
        cpuPercent: m.cpu_percent || 0,
        memoryPercent: m.memory_percent || 0,
    }));

    if (metricsHistory.length === 0) {
        return (
            <div className="flex items-center justify-center h-48 text-zinc-600 text-sm bg-zinc-900/80 rounded-xl border border-zinc-800/80">
                <div className="flex flex-col items-center gap-2">
                    <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-500 rounded-full animate-spin" />
                    <span>Collecting metrics data...</span>
                </div>
            </div>
        );
    }

    const latest = metricsHistory[metricsHistory.length - 1];

    // Get color class based on percentage - using muted colors
    const getColorClass = (percent?: number) => {
        if (!percent) return { text: 'text-zinc-500', bg: 'bg-zinc-600' };
        if (percent >= 90) return { text: 'text-red-500', bg: 'bg-red-600' };
        if (percent >= 70) return { text: 'text-amber-500', bg: 'bg-amber-600' };
        return { text: 'text-emerald-500', bg: 'bg-emerald-600' };
    };

    const cpuColors = getColorClass(latest.cpu_percent);
    const memoryColors = getColorClass(latest.memory_percent);

    return (
        <div className="space-y-3">
            {/* Current Usage Cards */}
            <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800/80">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <div className="p-1.5 bg-zinc-800 rounded-lg border border-zinc-700/50">
                                <Cpu size={12} className="text-emerald-500" />
                            </div>
                            <span className="text-zinc-600 text-[10px] uppercase font-bold tracking-wider">CPU</span>
                        </div>
                        {latest.cpu_percent !== undefined && (
                            <span className={`text-xs font-mono font-bold ${cpuColors.text}`}>
                                {latest.cpu_percent.toFixed(1)}%
                            </span>
                        )}
                    </div>
                    <div className="text-lg font-mono text-zinc-200 font-medium">{latest.cpu}</div>
                    {latest.cpu_percent !== undefined && (
                        <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className={`h-full ${cpuColors.bg} transition-all duration-300`}
                                style={{ width: `${Math.min(latest.cpu_percent, 100)}%` }}
                            />
                        </div>
                    )}
                    {latest.cpu_limit_nano && (
                        <div className="text-zinc-600 text-[10px] mt-1.5">
                            Limit: <span className="text-zinc-500">{(latest.cpu_limit_nano / 1_000_000_000).toFixed(2)} cores</span>
                        </div>
                    )}
                </div>

                <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800/80">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <div className="p-1.5 bg-zinc-800 rounded-lg border border-zinc-700/50">
                                <HardDrive size={12} className="text-blue-500" />
                            </div>
                            <span className="text-zinc-600 text-[10px] uppercase font-bold tracking-wider">Memory</span>
                        </div>
                        {latest.memory_percent !== undefined && (
                            <span className={`text-xs font-mono font-bold ${memoryColors.text}`}>
                                {latest.memory_percent.toFixed(1)}%
                            </span>
                        )}
                    </div>
                    <div className="text-lg font-mono text-zinc-200 font-medium">{latest.memory}</div>
                    {latest.memory_percent !== undefined && (
                        <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className={`h-full ${memoryColors.bg} transition-all duration-300`}
                                style={{ width: `${Math.min(latest.memory_percent, 100)}%` }}
                            />
                        </div>
                    )}
                    {latest.memory_limit_bytes && (
                        <div className="text-zinc-600 text-[10px] mt-1.5">
                            Limit: <span className="text-zinc-500">{(latest.memory_limit_bytes / (1024 * 1024 * 1024)).toFixed(2)} Gi</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Time Series Charts */}
            <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800/80">
                <h4 className="text-zinc-600 text-[10px] uppercase font-bold tracking-wider mb-3">Usage History (Last 5 min)</h4>
                <div className="grid grid-cols-1 gap-4">
                    {/* CPU Chart */}
                    <div className="h-[100px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#18181b" vertical={false} />
                                <XAxis dataKey="time" hide />
                                <YAxis stroke="#3f3f46" fontSize={10} width={30} tickFormatter={(val) => `${val}`} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', borderRadius: '8px', fontSize: '11px', color: '#a1a1aa' }}
                                    itemStyle={{ fontSize: '11px' }}
                                    labelStyle={{ display: 'none' }}
                                />
                                <Line type="monotone" dataKey="cpu" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
                            </LineChart>
                        </ResponsiveContainer>
                        <div className="text-center text-[10px] text-zinc-600 mt-1">CPU (millicores)</div>
                    </div>

                    {/* Memory Chart */}
                    <div className="h-[100px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#18181b" vertical={false} />
                                <XAxis dataKey="time" hide />
                                <YAxis stroke="#3f3f46" fontSize={10} width={30} tickFormatter={(val) => `${val}`} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', borderRadius: '8px', fontSize: '11px', color: '#a1a1aa' }}
                                    itemStyle={{ fontSize: '11px' }}
                                    labelStyle={{ display: 'none' }}
                                />
                                <Line type="monotone" dataKey="memory" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                            </LineChart>
                        </ResponsiveContainer>
                        <div className="text-center text-[10px] text-zinc-600 mt-1">Memory (MiB)</div>
                    </div>
                </div>
            </div>
        </div>
    );
}
