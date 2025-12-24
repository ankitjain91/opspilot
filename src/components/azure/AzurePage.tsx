
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    Cloud,
    Server,
    RefreshCw,
    Search,
    AlertCircle,
    ChevronDown,
    ChevronRight,
    Globe,
    Layers,
    Plug,
    Loader2
} from 'lucide-react';
import { LoadingScreen } from '../shared/LoadingScreen';
import { AzureSubscription, AksCluster } from '../../types/azure';

interface AzurePageProps {
    onConnect: () => void;
}

export function AzurePage({ onConnect }: AzurePageProps) {
    const [searchQuery, setSearchQuery] = useState("");
    const [expandedSubs, setExpandedSubs] = useState<Record<string, boolean>>({});

    const [realtimeSubscriptions, setRealtimeSubscriptions] = useState<AzureSubscription[]>([]);
    const [statusMessage, setStatusMessage] = useState("Fetching Azure Data...");

    // Error parsing logic
    const parseError = (err: any) => {
        const msg = err?.message || String(err);
        if (msg.includes('|')) {
            const parts = msg.split('|');
            return {
                code: parts[0],
                context: parts[1],
                message: parts[2],
                command: parts[3]
            };
        }
        return { code: 'UNKNOWN', message: msg };
    };

    // Real-time Event Listener
    useEffect(() => {
        let unlistenUpdate: () => void;
        let unlistenStatus: () => void;

        const setupListener = async () => {
            unlistenUpdate = await listen<AzureSubscription>("azure:subscription_update", (event) => {
                setRealtimeSubscriptions(prev => {
                    // Avoid duplicates if re-mounting or re-fetching
                    const exists = prev.find(s => s.id === event.payload.id);
                    if (exists) return prev.map(s => s.id === event.payload.id ? event.payload : s);
                    return [...prev, event.payload];
                });
            });

            unlistenStatus = await listen<string>("azure:status", (event) => {
                setStatusMessage(event.payload);
            });
        };
        setupListener();
        return () => {
            if (unlistenUpdate) unlistenUpdate();
            if (unlistenStatus) unlistenStatus();
        };
    }, []);

    const { data: queryData, isLoading, error, refetch, isRefetching } = useQuery({
        queryKey: ["azure_data"],
        queryFn: async () => {
            setRealtimeSubscriptions([]); // Clear previous results on new fetch
            return await invoke<AzureSubscription[]>("refresh_azure_data");
        },
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        retry: false,
    });

    // Merge data: If loading or refetching, use realtime data. Else use query data.
    const subscriptions = (isLoading || isRefetching) ? realtimeSubscriptions : queryData;

    const connectMutation = useMutation({
        mutationFn: async ({ subId, cluster }: { subId: string, cluster: AksCluster }) => {
            await invoke("get_aks_credentials", {
                subscriptionId: subId,
                resourceGroup: cluster.resourceGroup,
                name: cluster.name
            });
        },
        onSuccess: () => {
            onConnect();
        },
    });

    // Filter Logic
    const filteredSubs = useMemo(() => {
        if (!subscriptions) return [];
        if (!searchQuery) return subscriptions;

        const lowerQuery = searchQuery.toLowerCase();
        return subscriptions.map(sub => {
            if (sub.name.toLowerCase().includes(lowerQuery) || sub.id.toLowerCase().includes(lowerQuery)) {
                return sub;
            }
            const matchingClusters = sub.clusters.filter(c =>
                c.name.toLowerCase().includes(lowerQuery) ||
                c.resourceGroup.toLowerCase().includes(lowerQuery)
            );

            if (matchingClusters.length > 0) {
                return { ...sub, clusters: matchingClusters };
            }

            return null;
        }).filter(Boolean) as AzureSubscription[];
    }, [subscriptions, searchQuery]);

    // Auto-expand if searching
    useEffect(() => {
        if (searchQuery && filteredSubs.length > 0) {
            const newExpanded: Record<string, boolean> = {};
            filteredSubs.forEach(s => newExpanded[s.id] = true);
            setExpandedSubs(newExpanded);
        }
    }, [searchQuery, filteredSubs]);

    const toggleSub = (id: string) => {
        setExpandedSubs(prev => ({ ...prev, [id]: !prev[id] }));
    };

    // Calculate totals
    const totalClusters = subscriptions?.reduce((acc, sub) => acc + sub.clusters.length, 0) || 0;
    const runningClusters = subscriptions?.reduce((acc, sub) =>
        acc + sub.clusters.filter(c => c.powerState.code === 'Running').length, 0) || 0;

    // Show loading screen only if we're loading AND have no data yet
    if (isLoading && realtimeSubscriptions.length === 0) return <LoadingScreen message={statusMessage} />;

    if (error) {
        const errObj = parseError(error);
        const isLoginError = ['AZURE_LOGIN_REQUIRED', 'AZURE_TOKEN_EXPIRED', 'AZURE_DEVICE_CODE'].includes(errObj.code) ||
            errObj.message.toLowerCase().includes("login");

        return (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 bg-gradient-to-br from-zinc-900 to-zinc-950">
                <div className="bg-gradient-to-br from-red-500/10 to-orange-500/5 p-10 rounded-2xl border border-red-500/20 max-w-md backdrop-blur-xl shadow-2xl">
                    <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center border border-red-500/30">
                        <AlertCircle size={32} className="text-red-400" />
                    </div>
                    <h3 className="text-xl font-bold text-white mb-3">Azure Connection Error</h3>
                    <p className="text-zinc-400 text-sm mb-6 leading-relaxed">{errObj.message}</p>

                    {isLoginError ? (
                        <button
                            onClick={async () => {
                                try {
                                    await invoke("azure_login");
                                    refetch();
                                } catch (e) {
                                    console.error(e);
                                    refetch();
                                }
                            }}
                            className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 rounded-xl text-white font-medium shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.02] active:scale-[0.98]"
                        >
                            <Cloud size={18} />
                            Sign in to Azure
                        </button>
                    ) : (
                        <button
                            onClick={() => refetch()}
                            className="inline-flex items-center gap-2 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-white font-medium transition-all"
                        >
                            <RefreshCw size={16} />
                            Try Again
                        </button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950">
            {/* Header */}
            <div className="border-b border-white/5 bg-black/20 backdrop-blur-xl shrink-0">
                <div className="px-6 py-5">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-blue-500/25">
                                <Cloud className="text-white" size={24} />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-white">Azure Kubernetes Service</h2>
                                <p className="text-sm text-zinc-500">Select a cluster to connect</p>
                            </div>
                        </div>

                        <div className="flex items-center gap-3">
                            {/* Stats Pills */}
                            <div className="hidden md:flex items-center gap-2">
                                <div className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 flex items-center gap-2">
                                    <Server size={14} className="text-blue-400" />
                                    <span className="text-xs font-medium text-zinc-300">{totalClusters} Clusters</span>
                                </div>
                                <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                    <span className="text-xs font-medium text-emerald-300">{runningClusters} Running</span>
                                </div>
                            </div>

                            <button
                                onClick={() => refetch()}
                                disabled={isRefetching}
                                className="p-2.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded-xl transition-all disabled:opacity-50 border border-transparent hover:border-white/10"
                                title="Refresh Azure Data"
                            >
                                <RefreshCw size={18} className={(isRefetching || isLoading) ? "animate-spin" : ""} />
                            </button>
                        </div>
                    </div>

                    {/* Search Bar */}
                    <div className="relative">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
                        <input
                            type="text"
                            placeholder="Search subscriptions, clusters, or resource groups..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 transition-all"
                        />
                        {subscriptions && (
                            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-600">
                                {filteredSubs.length} subscription{filteredSubs.length !== 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Subscription List */}
            <div className="flex-1 overflow-auto p-6 space-y-4">
                {filteredSubs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                        <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
                            <Search size={28} className="text-zinc-600" />
                        </div>
                        <p className="text-zinc-400 font-medium">
                            {searchQuery ? "No matches found" : "No subscriptions available"}
                        </p>
                        <p className="text-sm text-zinc-600 mt-1">
                            {searchQuery ? "Try a different search term" : "Make sure you're logged in to Azure"}
                        </p>
                    </div>
                ) : (
                    filteredSubs.map(sub => (
                        <div
                            key={sub.id}
                            className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden backdrop-blur-sm hover:border-white/20 transition-all"
                        >
                            {/* Subscription Header */}
                            <button
                                onClick={() => toggleSub(sub.id)}
                                className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/5 transition-colors"
                            >
                                <div className="flex items-center gap-4">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${expandedSubs[sub.id] ? 'bg-blue-500/20' : 'bg-white/5'}`}>
                                        {expandedSubs[sub.id] ? (
                                            <ChevronDown size={18} className="text-blue-400" />
                                        ) : (
                                            <ChevronRight size={18} className="text-zinc-500" />
                                        )}
                                    </div>
                                    <div className="flex flex-col items-start">
                                        <div className="flex items-center gap-2">
                                            <span className="font-semibold text-white">{sub.name}</span>
                                            {sub.isDefault && (
                                                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                                    Default
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-xs text-zinc-600 font-mono">{sub.id}</span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-2">
                                        <Server size={14} className="text-zinc-600" />
                                        <span className="text-sm text-zinc-400">{sub.clusters.length} cluster{sub.clusters.length !== 1 ? 's' : ''}</span>
                                    </div>
                                </div>
                            </button>

                            {/* Clusters Grid */}
                            {expandedSubs[sub.id] && (
                                <div className="border-t border-white/5 bg-black/20 p-5">
                                    {sub.clusters.length === 0 ? (
                                        <div className="text-center py-8">
                                            <Server size={24} className="text-zinc-700 mx-auto mb-2" />
                                            <p className="text-sm text-zinc-600">No clusters in this subscription</p>
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                                            {sub.clusters.map(cluster => {
                                                const isRunning = cluster.powerState.code === 'Running';
                                                const isConnecting = connectMutation.isPending &&
                                                    connectMutation.variables?.cluster.id === cluster.id;

                                                return (
                                                    <div
                                                        key={cluster.id}
                                                        className={`group relative rounded-xl border p-5 transition-all duration-300 ${isRunning
                                                            ? 'bg-gradient-to-br from-emerald-500/5 to-transparent border-emerald-500/20 hover:border-emerald-500/40 hover:shadow-lg hover:shadow-emerald-500/10'
                                                            : 'bg-white/[0.02] border-white/10 hover:border-white/20'
                                                            }`}
                                                    >
                                                        {/* Status Badge */}
                                                        <div className="absolute top-4 right-4">
                                                            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium ${isRunning
                                                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                                                : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                                                                }`}>
                                                                <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                                                                {isRunning ? 'Running' : 'Stopped'}
                                                            </div>
                                                        </div>

                                                        {/* Cluster Info */}
                                                        <div className="mb-4">
                                                            <h3 className="font-bold text-white text-lg mb-1 pr-20">{cluster.name}</h3>
                                                            <div className="flex flex-wrap gap-2 mt-3">
                                                                <span className="inline-flex items-center gap-1 text-xs text-zinc-500 bg-white/5 px-2 py-1 rounded-md">
                                                                    <Globe size={12} />
                                                                    {cluster.location}
                                                                </span>
                                                                <span className="inline-flex items-center gap-1 text-xs text-zinc-500 bg-white/5 px-2 py-1 rounded-md truncate max-w-[180px]" title={cluster.resourceGroup}>
                                                                    <Layers size={12} />
                                                                    {cluster.resourceGroup}
                                                                </span>
                                                            </div>
                                                        </div>

                                                        {/* Connect Button */}
                                                        <button
                                                            onClick={() => connectMutation.mutate({ subId: sub.id, cluster })}
                                                            disabled={connectMutation.isPending || !isRunning}
                                                            className={`w-full py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${isRunning
                                                                ? 'bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 disabled:opacity-50'
                                                                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                                                                }`}
                                                        >
                                                            {isConnecting ? (
                                                                <>
                                                                    <Loader2 className="animate-spin" size={16} />
                                                                    Connecting...
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <Plug size={16} />
                                                                    {isRunning ? 'Connect to Cluster' : 'Cluster Stopped'}
                                                                </>
                                                            )}
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
