
import { DependencyManager } from "../onboarding/DependencyManager";
import React, { useState, useMemo } from "react";
import {
    Sparkles,
    FileCode,
    FolderOpen,
    Search,
    AlertCircle,
    X,
    Loader2,
    ChevronRight,
    Trash2,
    ServerOff,
    Cloud,
    Globe,
    Server,
    Check,
    Layers,
    Terminal,
    Copy,
    CheckCircle2,
    ShieldAlert,
    KeyRound,
    Wifi,
    WifiOff,
    Lock,
    Ban,
    RefreshCw,
} from "lucide-react";

// Error type definitions for structured error handling
interface ParsedConnectionError {
    code: string;
    context: string;
    message: string;
    command?: string;
}

// Parse structured error from backend (format: CODE|context|message|command)
function parseConnectionError(errorMessage: string): ParsedConnectionError {
    const parts = errorMessage.split('|');
    if (parts.length >= 3) {
        return {
            code: parts[0],
            context: parts[1],
            message: parts[2],
            command: parts[3] || undefined,
        };
    }
    // Fallback for unstructured errors
    return {
        code: 'UNKNOWN_ERROR',
        context: '',
        message: errorMessage,
    };
}

// Get error icon and color based on error code
function getErrorStyle(code: string): { icon: React.ReactNode; bgColor: string; borderColor: string; iconBg: string } {
    switch (code) {
        case 'AZURE_DEVICE_COMPLIANCE':
        case 'AZURE_MFA_REQUIRED':
            return {
                icon: <ShieldAlert size={20} />,
                bgColor: 'bg-orange-500/10',
                borderColor: 'border-orange-500/30',
                iconBg: 'bg-orange-500/20',
            };
        case 'AZURE_TOKEN_EXPIRED':
        case 'AZURE_AUTH_ERROR':
        case 'AWS_AUTH_ERROR':
        case 'GCP_AUTH_ERROR':
        case 'AUTH_UNAUTHORIZED':
        case 'AUTH_EXEC_ERROR':
            return {
                icon: <KeyRound size={20} />,
                bgColor: 'bg-amber-500/10',
                borderColor: 'border-amber-500/30',
                iconBg: 'bg-amber-500/20',
            };
        case 'AUTH_FORBIDDEN':
            return {
                icon: <Ban size={20} />,
                bgColor: 'bg-red-500/10',
                borderColor: 'border-red-500/30',
                iconBg: 'bg-red-500/20',
            };
        case 'CONNECTION_TIMEOUT':
        case 'DNS_ERROR':
            return {
                icon: <WifiOff size={20} />,
                bgColor: 'bg-blue-500/10',
                borderColor: 'border-blue-500/30',
                iconBg: 'bg-blue-500/20',
            };
        case 'CONNECTION_REFUSED':
            return {
                icon: <Wifi size={20} />,
                bgColor: 'bg-purple-500/10',
                borderColor: 'border-purple-500/30',
                iconBg: 'bg-purple-500/20',
            };
        case 'TLS_ERROR':
            return {
                icon: <Lock size={20} />,
                bgColor: 'bg-yellow-500/10',
                borderColor: 'border-yellow-500/30',
                iconBg: 'bg-yellow-500/20',
            };
        default:
            return {
                icon: <AlertCircle size={20} />,
                bgColor: 'bg-red-500/10',
                borderColor: 'border-red-500/30',
                iconBg: 'bg-red-500/20',
            };
    }
}

// Get user-friendly error title
function getErrorTitle(code: string): string {
    switch (code) {
        case 'AZURE_DEVICE_COMPLIANCE':
            return 'Device Compliance Required';
        case 'AZURE_TOKEN_EXPIRED':
            return 'Azure Token Expired';
        case 'AZURE_MFA_REQUIRED':
            return 'MFA Authentication Required';
        case 'AZURE_AUTH_ERROR':
            return 'Azure Authentication Failed';
        case 'AWS_AUTH_ERROR':
            return 'AWS Authentication Failed';
        case 'GCP_AUTH_ERROR':
            return 'GCP Authentication Failed';
        case 'AUTH_UNAUTHORIZED':
            return 'Authentication Failed';
        case 'AUTH_FORBIDDEN':
            return 'Access Denied';
        case 'AUTH_EXEC_ERROR':
            return 'Auth Plugin Error';
        case 'CONNECTION_TIMEOUT':
            return 'Connection Timeout';
        case 'CONNECTION_REFUSED':
            return 'Connection Refused';
        case 'TLS_ERROR':
            return 'Certificate Error';
        case 'DNS_ERROR':
            return 'DNS Resolution Failed';
        default:
            return 'Connection Failed';
    }
}

// Connection Error Panel Component
function ConnectionErrorPanel({ error, onDismiss, onRetry }: { error: string; onDismiss: () => void; onRetry: () => void }) {
    const [copied, setCopied] = React.useState(false);
    const parsed = parseConnectionError(error);
    const style = getErrorStyle(parsed.code);
    const title = getErrorTitle(parsed.code);

    const handleCopy = async () => {
        if (parsed.command) {
            await navigator.clipboard.writeText(parsed.command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div className={`${style.bgColor} border ${style.borderColor} rounded-xl overflow-hidden animate-in fade-in slide-in-from-top-2`}>
            {/* Header */}
            <div className="flex items-start justify-between p-4 pb-3">
                <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${style.iconBg} text-white shrink-0`}>
                        {style.icon}
                    </div>
                    <div className="min-w-0">
                        <h4 className="text-white font-semibold text-sm">{title}</h4>
                        <p className="text-zinc-400 text-xs mt-1 leading-relaxed">{parsed.message}</p>
                    </div>
                </div>
                <button
                    onClick={onDismiss}
                    className="p-1 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-white transition-colors shrink-0"
                >
                    <X size={16} />
                </button>
            </div>

            {/* Remediation Command */}
            {parsed.command && (
                <div className="px-4 pb-4">
                    <div className="bg-black/40 rounded-lg border border-white/5 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/5">
                            <div className="flex items-center gap-2 text-xs text-zinc-400">
                                <Terminal size={12} />
                                <span>Run this command to fix:</span>
                            </div>
                            <button
                                onClick={handleCopy}
                                className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white transition-all"
                            >
                                {copied ? (
                                    <>
                                        <CheckCircle2 size={12} className="text-green-400" />
                                        <span className="text-green-400">Copied!</span>
                                    </>
                                ) : (
                                    <>
                                        <Copy size={12} />
                                        <span>Copy</span>
                                    </>
                                )}
                            </button>
                        </div>
                        <div className="p-3 overflow-x-auto">
                            <code className="text-xs font-mono text-cyan-300 whitespace-pre-wrap break-all">
                                {parsed.command}
                            </code>
                        </div>
                    </div>
                </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 px-4 pb-4">
                <button
                    onClick={onRetry}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition-all"
                >
                    <RefreshCw size={14} />
                    Retry Connection
                </button>
                {parsed.code.startsWith('AZURE_') && (
                    <a
                        href="https://learn.microsoft.com/en-us/azure/aks/managed-azure-ad"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-zinc-400 hover:text-white text-xs transition-all hover:bg-white/5"
                    >
                        Learn more about AKS authentication
                    </a>
                )}
            </div>
        </div>
    );
}

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { LoadingScreen } from "../shared/LoadingScreen";

interface ConnectionScreenProps {
    onConnect: () => void;
    onOpenAzure: () => void;
}

export function ConnectionScreen({ onConnect, onOpenAzure }: ConnectionScreenProps) {
    const [customPath, setCustomPath] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [activeTab, setActiveTab] = useState<"local" | "azure" | "setup">("local");
    const [connectionLogs, setConnectionLogs] = useState<Array<{ time: string; message: string; status: 'pending' | 'success' | 'error' | 'info' }>>([]);
    const qc = useQueryClient();

    const addLog = (message: string, status: 'pending' | 'success' | 'error' | 'info' = 'info') => {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setConnectionLogs(prev => [...prev, { time, message, status }]);
    };

    const { data: contexts, isLoading } = useQuery({
        queryKey: ["kube_contexts", customPath],
        queryFn: async () => {
            const result = await invoke<{ name: string }[]>("list_contexts", { customPath });
            return result.map(c => c.name);
        },
    });

    const { data: currentContext } = useQuery({
        queryKey: ["current_context", customPath],
        queryFn: async () => await invoke<string>("get_current_context_name", { customPath }),
    });

    const filteredContexts = useMemo(() => {
        if (!contexts) return [];
        if (!searchQuery) return contexts;
        return contexts.filter(c => c.toLowerCase().includes(searchQuery.toLowerCase()));
    }, [contexts, searchQuery]);

    const connectMutation = useMutation({
        mutationFn: async (context: string) => {
            setConnectionLogs([]);
            addLog(`Initiating connection to ${context}`, 'info');

            // Try to disconnect from any existing vcluster first
            try {
                addLog('Checking for active vcluster...', 'pending');
                await Promise.race([
                    invoke("disconnect_vcluster"),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Disconnect timeout")), 3000)
                    )
                ]);
                addLog('vcluster cleanup complete', 'success');
            } catch (err) {
                addLog('No active vcluster (or already disconnected)', 'info');
            }

            // Reset all state and release locks first
            try {
                addLog('Resetting backend state...', 'pending');
                await Promise.race([
                    invoke("reset_state"),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Reset timeout")), 1000)
                    )
                ]);
                addLog('Backend state cleared', 'success');
            } catch (err) {
                addLog('Backend reset skipped (non-critical)', 'info');
            }

            // Try to set the context and validate connection
            addLog('Loading kubeconfig...', 'pending');
            await new Promise(r => setTimeout(r, 200));
            addLog('Connecting to cluster...', 'pending');

            try {
                const result = await Promise.race([
                    invoke<string>("set_kube_config", { context, path: customPath }),
                    new Promise<string>((_, reject) =>
                        setTimeout(() => reject(new Error("Connection timeout after 60 seconds")), 60000)
                    )
                ]);
                addLog(result || 'Connected successfully', 'success');
            } catch (err: any) {
                const errorMsg = err?.message || String(err);
                addLog(`Connection failed: ${errorMsg}`, 'error');
                throw new Error(errorMsg);
            }

            addLog('Preparing API discovery...', 'pending');
            await new Promise(r => setTimeout(r, 200));

            return Promise.resolve();
        },
        onSuccess: async () => {
            addLog('Connection established!', 'success');
            addLog('Clearing cached data...', 'pending');

            // Clear backend caches first
            try {
                await invoke("clear_all_caches");
            } catch (e) {
                console.warn("Failed to clear backend caches:", e);
            }

            // Invalidate ALL cached data to prevent showing stale data from previous cluster
            qc.invalidateQueries({ queryKey: ["current_context"] });
            qc.invalidateQueries({ queryKey: ["current_context_boot"] });
            qc.invalidateQueries({ queryKey: ["current_context_global"] });
            qc.invalidateQueries({ queryKey: ["discovery"] });
            qc.invalidateQueries({ queryKey: ["namespaces"] });
            qc.invalidateQueries({ queryKey: ["cluster_stats"] });
            qc.invalidateQueries({ queryKey: ["cluster_cockpit"] });
            qc.invalidateQueries({ queryKey: ["initial_cluster_data"] });
            qc.invalidateQueries({ queryKey: ["vclusters"] });
            qc.invalidateQueries({ queryKey: ["list_resources"] });
            qc.invalidateQueries({ queryKey: ["crd-groups"] });
            qc.invalidateQueries({ queryKey: ["metrics"] });
            qc.invalidateQueries({ queryKey: ["pod_metrics"] });
            qc.invalidateQueries({ queryKey: ["node_metrics"] });
            qc.clear();
            addLog('Loading cluster dashboard...', 'success');
            setTimeout(() => onConnect(), 500);
        },
        onError: (error: Error) => {
            addLog(`Connection failed: ${error.message}`, 'error');
            console.error("Connection error:", error);
        }
    });

    // Add error state for connection failures
    const [connectionError, setConnectionError] = useState<string | null>(null);

    // Delete context state
    const [contextToDelete, setContextToDelete] = useState<string | null>(null);

    // Delete context mutation
    const deleteMutation = useMutation({
        mutationFn: async (contextName: string) => {
            await invoke("delete_context", { contextName, customPath });
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["kube_contexts"] });
            setContextToDelete(null);
        },
    });

    // Wrap mutation to handle error state
    const handleConnect = (ctx: string) => {
        setConnectionError(null);
        connectMutation.mutate(ctx, {
            onError: (err) => {
                setConnectionError(err.message);
            }
        });
    };

    const handleDeleteContext = (ctx: string, e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent triggering connect
        setContextToDelete(ctx);
    };

    const handleFileSelect = async () => {
        try {
            const selected = await open({
                multiple: false,
                filters: [{
                    name: 'Kubeconfig',
                    extensions: ['yaml', 'yml', 'config', 'kubeconfig']
                }]
            });

            if (selected && typeof selected === 'string') {
                setCustomPath(selected);
            }
        } catch (err) {
            console.error("Failed to open file dialog", err);
        }
    };

    if (isLoading) return <LoadingScreen message="Loading Kubeconfig..." />;

    return (
        <div className="h-screen w-full bg-[#09090b] flex items-center justify-center relative overflow-hidden">
            {/* Animated Background */}
            <div className="absolute inset-0 overflow-hidden">
                <div className="absolute top-[-30%] left-[-20%] w-[70%] h-[70%] bg-gradient-to-br from-purple-600/20 via-purple-900/10 to-transparent rounded-full blur-[100px] animate-pulse" style={{ animationDuration: '8s' }} />
                <div className="absolute bottom-[-30%] right-[-20%] w-[70%] h-[70%] bg-gradient-to-tl from-cyan-600/20 via-blue-900/10 to-transparent rounded-full blur-[100px] animate-pulse" style={{ animationDuration: '10s' }} />
                <div className="absolute top-[20%] right-[10%] w-[40%] h-[40%] bg-gradient-to-bl from-blue-600/10 to-transparent rounded-full blur-[80px] animate-pulse" style={{ animationDuration: '12s' }} />
            </div>

            {/* Grid Pattern Overlay */}
            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(closest-side_at_50%_50%,black_40%,transparent_100%)]" />

            <div className="w-full max-w-2xl z-10 animate-in fade-in zoom-in-95 duration-700 px-4">
                {/* Hero Section */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/20 mb-6">
                        <Sparkles size={14} className="text-cyan-400" />
                        <span className="text-xs font-medium text-cyan-300">Kubernetes Management Made Simple</span>
                    </div>

                    <div className="w-24 h-24 mx-auto mb-6 relative group">
                        <div className="absolute inset-0 bg-blue-600/20 rounded-3xl blur-xl opacity-50 group-hover:opacity-75 transition-all duration-700 group-hover:scale-110" />
                        <img src="/icon.png" alt="OpsPilot" className="relative w-full h-full rounded-3xl shadow-2xl border border-white/10" />
                    </div>

                    <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">
                        Welcome to <span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">OpsPilot</span>
                    </h1>
                    <p className="text-zinc-400 text-base max-w-md mx-auto">
                        Connect to your Kubernetes clusters and manage resources with ease
                    </p>
                </div>

                {/* Connection Options Card */}
                <div className="glass-panel border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-xl bg-black/40">
                    {/* Tab Selector */}
                    <div className="flex border-b border-white/5">
                        <button
                            onClick={() => setActiveTab("local")}
                            className={`flex-1 px-6 py-4 text-sm font-medium transition-all relative ${activeTab === "local" ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                        >
                            <div className="flex items-center justify-center gap-2">
                                <FileCode size={18} />
                                <span>Local Kubeconfig</span>
                            </div>
                            {activeTab === "local" && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-500 to-blue-500" />
                            )}
                        </button>
                        <button
                            onClick={() => setActiveTab("azure")}
                            className={`flex-1 px-6 py-4 text-sm font-medium transition-all relative ${activeTab === "azure" ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                        >
                            <div className="flex items-center justify-center gap-2">
                                <Cloud size={18} />
                                <span>Azure AKS</span>
                            </div>
                            {activeTab === "azure" && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-purple-500" />
                            )}
                        </button>
                        <button
                            onClick={() => setActiveTab("setup")}
                            className={`flex-1 px-6 py-4 text-sm font-medium transition-all relative ${activeTab === "setup" ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                        >
                            <div className="flex items-center justify-center gap-2">
                                <Terminal size={18} />
                                <span>Setup</span>
                            </div>
                            {activeTab === "setup" && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-purple-500 to-pink-500" />
                            )}
                        </button>
                    </div>

                    {activeTab === "local" ? (
                        <div className="p-6 space-y-5">
                            {/* Kubeconfig Path */}
                            <div className="space-y-2">
                                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                                    <FileCode size={12} />
                                    Kubeconfig File
                                </label>
                                <div className="flex gap-2">
                                    <div className="flex-1 bg-zinc-900/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-zinc-300 truncate flex items-center hover:border-white/20 transition-colors group">
                                        <span className="truncate opacity-70 group-hover:opacity-100 transition-opacity">{customPath || "~/.kube/config"}</span>
                                    </div>
                                    <button
                                        onClick={handleFileSelect}
                                        className="bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-3 rounded-xl border border-white/10 transition-all hover:shadow-lg hover:shadow-cyan-500/10 active:scale-95 flex items-center gap-2"
                                        title="Browse for kubeconfig file"
                                    >
                                        <FolderOpen size={18} />
                                        <span className="text-sm font-medium">Browse</span>
                                    </button>
                                </div>
                            </div>

                            {/* Search */}
                            <div className="relative">
                                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
                                <input
                                    type="text"
                                    placeholder="Search contexts..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="w-full bg-zinc-900/50 border border-white/10 rounded-xl pl-11 pr-4 py-3 text-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/50 transition-all placeholder:text-zinc-600"
                                />
                                {contexts && (
                                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-600">
                                        {filteredContexts.length} context{filteredContexts.length !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>

                            {/* Enhanced Error Panel */}
                            {connectionError && <ConnectionErrorPanel error={connectionError} onDismiss={() => setConnectionError(null)} onRetry={() => connectMutation.variables && handleConnect(connectMutation.variables)} />}

                            {/* Connecting Overlay with Live Logs */}
                            {connectMutation.isPending && (
                                <div className="bg-zinc-900/95 backdrop-blur-sm border border-cyan-500/20 rounded-xl overflow-hidden mb-4 animate-in fade-in">
                                    {/* Header */}
                                    <div className="flex items-center justify-between p-4 border-b border-white/5">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                                                <Loader2 size={20} className="animate-spin text-cyan-400" />
                                            </div>
                                            <div>
                                                <p className="text-white font-medium">Connecting to cluster</p>
                                                <p className="text-zinc-500 text-xs font-mono truncate max-w-[280px]">{connectMutation.variables}</p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => {
                                                setConnectionLogs([]);
                                                connectMutation.reset();
                                            }}
                                            className="px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-xs font-medium transition-all flex items-center gap-1.5"
                                        >
                                            <X size={14} />
                                            Cancel
                                        </button>
                                    </div>
                                    {/* Live Log */}
                                    <div className="bg-black/40 p-3 max-h-[200px] overflow-y-auto font-mono text-xs">
                                        {connectionLogs.map((log, i) => (
                                            <div key={i} className="flex items-start gap-2 py-1 animate-in fade-in slide-in-from-left-2">
                                                <span className="text-zinc-600 shrink-0">{log.time}</span>
                                                <span className={`shrink-0 ${log.status === 'success' ? 'text-green-400' :
                                                    log.status === 'error' ? 'text-red-400' :
                                                        log.status === 'pending' ? 'text-yellow-400' :
                                                            'text-zinc-400'
                                                    }`}>
                                                    {log.status === 'success' ? '✓' :
                                                        log.status === 'error' ? '✗' :
                                                            log.status === 'pending' ? '○' : '→'}
                                                </span>
                                                <span className={`${log.status === 'success' ? 'text-green-300' :
                                                    log.status === 'error' ? 'text-red-300' :
                                                        log.status === 'pending' ? 'text-yellow-200' :
                                                            'text-zinc-300'
                                                    }`}>{log.message}</span>
                                            </div>
                                        ))}
                                        {connectionLogs.length > 0 && (
                                            <div className="flex items-center gap-2 py-1 text-cyan-400">
                                                <span className="text-zinc-600">{new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                                <Loader2 size={10} className="animate-spin" />
                                                <span className="animate-pulse">Processing...</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Context List */}
                            <div className="bg-zinc-900/30 rounded-xl border border-white/5 overflow-hidden">
                                <div className="max-h-[280px] overflow-y-auto custom-scrollbar p-2 space-y-1">
                                    {filteredContexts.map(ctx => (
                                        <div
                                            key={ctx}
                                            className={`w-full text-left px-4 py-3.5 rounded-xl text-sm transition-all border group flex items-center gap-2
                        ${connectMutation.isPending ? 'opacity-50' : 'hover:bg-white/5'}
                        ${ctx === currentContext ? 'bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border-cyan-500/30' : 'border-transparent hover:border-white/10'}
                      `}
                                        >
                                            <button
                                                onClick={() => handleConnect(ctx)}
                                                disabled={connectMutation.isPending}
                                                className="flex-1 min-w-0 flex items-center justify-between relative z-10 cursor-pointer"
                                            >
                                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                                    <div className={`w-2.5 h-2.5 rounded-full shrink-0 transition-all ${ctx === currentContext ? 'bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.6)]' : 'bg-zinc-600 group-hover:bg-zinc-400'}`} />
                                                    <span className={`font-medium truncate ${ctx === currentContext ? 'text-cyan-100' : 'text-zinc-300 group-hover:text-white'}`}>
                                                        {ctx}
                                                    </span>
                                                    {ctx === currentContext && (
                                                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shrink-0">
                                                            Active
                                                        </span>
                                                    )}
                                                </div>
                                                {connectMutation.isPending && connectMutation.variables === ctx ? (
                                                    <Loader2 size={18} className="animate-spin text-cyan-400 shrink-0 ml-2" />
                                                ) : (
                                                    <ChevronRight size={16} className={`shrink-0 ml-2 transition-[color,transform] duration-150 ${ctx === currentContext ? 'text-cyan-400' : 'text-zinc-600 group-hover:text-zinc-400 group-hover:translate-x-0.5'}`} />
                                                )}
                                            </button>
                                            {/* Delete button - always visible in layout, opacity controlled by hover */}
                                            <button
                                                onClick={(e) => handleDeleteContext(ctx, e)}
                                                disabled={ctx === currentContext || deleteMutation.isPending}
                                                className={`shrink-0 p-1.5 rounded-lg transition-[color,background-color,opacity] opacity-0 group-hover:opacity-100
                          ${ctx === currentContext
                                                        ? 'text-zinc-600 cursor-not-allowed'
                                                        : 'text-zinc-500 hover:text-red-400 hover:bg-red-500/10'}`}
                                                title={ctx === currentContext ? "Cannot delete active context" : "Delete context"}
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    ))}

                                    {filteredContexts.length === 0 && (
                                        <div className="py-12 flex flex-col items-center justify-center text-zinc-500 gap-3">
                                            <ServerOff size={32} className="opacity-40" />
                                            <div className="text-center">
                                                <p className="text-sm font-medium">No contexts found</p>
                                                <p className="text-xs text-zinc-600 mt-1">Try a different kubeconfig file</p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : activeTab === "azure" ? (
                        /* Azure Tab Content */
                        <div className="p-8">
                            <div className="text-center">
                                <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/30 flex items-center justify-center">
                                    <Cloud size={40} className="text-blue-400" />
                                </div>
                                <h3 className="text-xl font-semibold text-white mb-2">Connect to Azure AKS</h3>
                                <p className="text-zinc-400 text-sm mb-6 max-w-sm mx-auto">
                                    Browse and connect to your Azure Kubernetes Service clusters directly from your subscriptions
                                </p>
                                <button
                                    onClick={onOpenAzure}
                                    className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-medium transition-all shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
                                >
                                    <Globe size={18} />
                                    Open Azure Explorer
                                </button>

                                <div className="mt-8 pt-6 border-t border-white/5">
                                    <p className="text-xs text-zinc-600 mb-4">Features</p>
                                    <div className="grid grid-cols-3 gap-4 text-center">
                                        <div className="p-3 rounded-lg bg-white/5">
                                            <div className="text-blue-400 mb-1">
                                                <Server size={20} className="mx-auto" />
                                            </div>
                                            <p className="text-xs text-zinc-400">Multi-subscription</p>
                                        </div>
                                        <div className="p-3 rounded-lg bg-white/5">
                                            <div className="text-green-400 mb-1">
                                                <Check size={20} className="mx-auto" />
                                            </div>
                                            <p className="text-xs text-zinc-400">Auto-credentials</p>
                                        </div>
                                        <div className="p-3 rounded-lg bg-white/5">
                                            <div className="text-purple-400 mb-1">
                                                <Layers size={20} className="mx-auto" />
                                            </div>
                                            <p className="text-xs text-zinc-400">Resource groups</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        /* Setup Tab Content */
                        <div className="p-6">
                            <DependencyManager />
                        </div>
                    )}

                    {/* Footer */}
                    <div className="px-6 py-3 bg-zinc-900/50 border-t border-white/5 flex items-center justify-between">
                        <p className="text-[10px] text-zinc-600 font-mono">OpsPilot v1.0.0</p>
                        <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            Ready
                        </div>
                    </div>
                </div>
            </div>

            {/* Delete Context Confirmation Modal */}
            {contextToDelete && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-in zoom-in-95 duration-200">
                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30">
                                    <AlertCircle className="w-6 h-6 text-red-400" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-semibold text-white">Delete Context</h3>
                                    <p className="text-sm text-zinc-400">This action cannot be undone</p>
                                </div>
                            </div>

                            <div className="bg-zinc-800/50 rounded-lg p-4 mb-4 border border-zinc-700">
                                <p className="text-sm text-zinc-300 mb-2">Are you sure you want to delete this context?</p>
                                <code className="text-sm font-mono text-cyan-400 bg-zinc-800 px-2 py-1 rounded break-all">
                                    {contextToDelete}
                                </code>
                                <p className="text-xs text-zinc-500 mt-3">
                                    This will remove the context from your kubeconfig file. If the cluster and user credentials are not used by other contexts, they will also be removed.
                                </p>
                            </div>

                            <div className="flex gap-3 justify-end">
                                <button
                                    onClick={() => setContextToDelete(null)}
                                    disabled={deleteMutation.isPending}
                                    className="px-4 py-2 text-sm font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => deleteMutation.mutate(contextToDelete)}
                                    disabled={deleteMutation.isPending}
                                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                                >
                                    {deleteMutation.isPending ? (
                                        <>
                                            <Loader2 size={14} className="animate-spin" />
                                            Deleting...
                                        </>
                                    ) : (
                                        <>
                                            <Trash2 size={14} />
                                            Delete Context
                                        </>
                                    )}
                                </button>
                            </div>

                            {deleteMutation.isError && (
                                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                                    <p className="text-sm text-red-400">
                                        {deleteMutation.error instanceof Error ? deleteMutation.error.message : 'Failed to delete context'}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
