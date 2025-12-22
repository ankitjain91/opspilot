import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { CheckCircle, AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';



interface DependencyStatus {
    name: string;
    installed: boolean;
    version?: string;
    path?: string;
}

interface ProgressEvent {
    id: string;
    percentage: number;
    status: string;
    error?: string;
}

const TOOL_INFO: Record<string, { label: string; description: string; purpose: string; link: string; required: boolean; lookingFor: string }> = {
    kubectl: {
        label: "kubectl",
        description: "Kubernetes command-line tool",
        purpose: "Connect to clusters, list resources, view logs, and execute commands",
        lookingFor: "kubectl binary in PATH",
        link: "https://kubernetes.io/docs/tasks/tools/",
        required: true
    },
    helm: {
        label: "Helm",
        description: "Kubernetes package manager",
        purpose: "Install, upgrade, and manage Helm charts and releases",
        lookingFor: "helm binary in PATH",
        link: "https://helm.sh/docs/intro/install/",
        required: true
    },
    vcluster: {
        label: "vcluster",
        description: "Virtual Kubernetes clusters",
        purpose: "Create isolated virtual clusters for testing and development",
        lookingFor: "vcluster binary in PATH",
        link: "https://www.vcluster.com/docs/getting-started/setup",
        required: false
    },
    "agent-server": {
        label: "Agent Server",
        description: "AI-powered backend service",
        purpose: "Powers AI chat, knowledge base, and intelligent analysis features",
        lookingFor: "Python sidecar running on port 8765",
        link: "https://github.com/ankitjain91/opspilot",
        required: true
    }
};


export function DependencyManager() {
    const [statuses, setStatuses] = useState<DependencyStatus[]>([]);
    const [loading, setLoading] = useState(false);
    const [downloading, setDownloading] = useState<Record<string, number>>({}); // id -> percentage
    const [osInfo, setOsInfo] = useState<{ os: string; arch: string }>({ os: 'linux', arch: 'amd64' });

    useEffect(() => {
        checkDeps();
        detectOS();
    }, []);

    const detectOS = async () => {
        // Simple heuristic for now, assuming 64bit
        const userAgent = window.navigator.userAgent.toLowerCase();
        let os = "linux";
        let arch = "amd64";

        if (userAgent.includes("mac")) {
            os = "darwin";
            arch = userAgent.includes("arm") || userAgent.includes("apple") ? "arm64" : "amd64";
            // Check for Apple Silicon explicitly if possible, mostly implied by 'mac' these days in modern envs or rosetta?
            // Note: Chrome on M1 reports arm64.
        } else if (userAgent.includes("win")) {
            os = "windows";
            arch = "amd64"; // exe
        }

        setOsInfo({ os, arch });
    };

    const checkDeps = async () => {
        setLoading(true);
        try {
            const res = await invoke<DependencyStatus[]>('check_dependencies');
            setStatuses(res);
        } catch (e) {
            console.error("Failed to check deps:", e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        let unlisten: UnlistenFn;
        listen<ProgressEvent>('download_progress', (event) => {
            const { id, percentage, status } = event.payload;
            if (status === 'completed') {
                setDownloading(prev => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
                checkDeps(); // Refresh status
            } else {
                setDownloading(prev => ({ ...prev, [id]: percentage }));
            }
        }).then(u => unlisten = u);

        return () => {
            if (unlisten) unlisten();
        };
    }, []);

    const getDownloadUrl = (name: string) => {
        const { os, arch } = osInfo;
        const ext = os === 'windows' ? '.exe' : '';

        if (name === 'kubectl') {
            return `https://dl.k8s.io/release/v1.30.0/bin/${os}/${arch}/kubectl${ext}`;
        }
        if (name === 'vcluster') {
            // https://github.com/loft-sh/vcluster/releases/download/v0.19.5/vcluster-darwin-arm64
            return `https://github.com/loft-sh/vcluster/releases/download/v0.19.5/vcluster-${os}-${arch}${ext}`;
        }
        // Helm requires extraction, skipping auto-download for now
        return "";
    };

    const handleInstall = async (name: string) => {
        const url = getDownloadUrl(name);
        if (!url) {
            alert("Auto-download not supported for this tool. Please install manually.");
            return;
        }

        setDownloading(prev => ({ ...prev, [name]: 0 }));
        try {
            await invoke('download_dependency', { name, url });
        } catch (e) {
            console.error(e);
            alert(`Download failed: ${e}`);
            setDownloading(prev => {
                const next = { ...prev };
                delete next[name];
                return next;
            });
        }
    };

    const requiredCount = statuses.filter(s => TOOL_INFO[s.name]?.required).length;
    const installedCount = statuses.filter(s => s.installed && TOOL_INFO[s.name]?.required).length;
    const allRequiredInstalled = requiredCount > 0 && installedCount === requiredCount;

    return (
        <div className="space-y-4">
            {/* Header with clear explanation */}
            <div className="text-center pb-4 border-b border-white/10">
                <h2 className="text-lg font-semibold text-white mb-2">Required Tools</h2>
                <p className="text-sm text-zinc-400 max-w-md mx-auto">
                    OpsPilot needs the following CLI tools to manage your Kubernetes clusters. Install any missing tools to get started.
                </p>
                {/* Status summary */}
                <div className="mt-3 flex items-center justify-center gap-2">
                    {allRequiredInstalled ? (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-medium">
                            <CheckCircle size={14} />
                            All required tools installed
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium">
                            <AlertTriangle size={14} />
                            {requiredCount - installedCount} required tool{requiredCount - installedCount !== 1 ? 's' : ''} missing
                        </span>
                    )}
                    <button
                        onClick={checkDeps}
                        className="p-1.5 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-white transition-colors"
                        disabled={loading}
                        title="Refresh status"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Tool list */}
            <div className="space-y-2">
                {statuses.map(tool => {
                    const info = TOOL_INFO[tool.name] || {
                        label: tool.name,
                        description: "System tool",
                        purpose: "Required for system operations",
                        lookingFor: `${tool.name} in PATH`,
                        link: "#",
                        required: false
                    };
                    const isDownloading = downloading[tool.name] !== undefined;
                    const progress = downloading[tool.name];
                    const canInstall = getDownloadUrl(tool.name) !== "";

                    return (
                        <div key={tool.name} className={`p-3 rounded-xl border transition-all ${tool.installed
                                ? 'bg-emerald-500/5 border-emerald-500/20'
                                : 'bg-zinc-800/50 border-zinc-700'
                            }`}>
                            <div className="flex items-center justify-between gap-3">
                                {/* Left: Icon + Info */}
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${tool.installed
                                        ? 'bg-emerald-500/20 text-emerald-400'
                                        : 'bg-zinc-700 text-zinc-400'
                                        }`}>
                                        {tool.installed ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-sm font-semibold text-white truncate">{info.label}</h3>
                                            {info.required && (
                                                <span className="text-[9px] bg-zinc-700 text-zinc-300 px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0">Required</span>
                                            )}
                                            {tool.installed && tool.version && (
                                                <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono shrink-0">{tool.version}</span>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-zinc-500 truncate">
                                            {tool.installed ? info.purpose : (
                                                <span>
                                                    <span className="text-zinc-400">Looking for:</span> {info.lookingFor}
                                                </span>
                                            )}
                                        </p>
                                    </div>
                                </div>

                                {/* Right: Action */}
                                <div className="shrink-0">
                                    {tool.installed ? (
                                        <span className="text-xs text-emerald-400 font-medium">Ready</span>
                                    ) : isDownloading ? (
                                        <div className="flex items-center gap-2 min-w-[100px]">
                                            <div className="flex-1">
                                                <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                                    <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }} />
                                                </div>
                                            </div>
                                            <span className="text-[10px] text-blue-300 font-mono">{progress}%</span>
                                        </div>
                                    ) : canInstall ? (
                                        <button
                                            onClick={() => handleInstall(tool.name)}
                                            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors"
                                        >
                                            <Download size={12} />
                                            Install
                                        </button>
                                    ) : (
                                        <a
                                            href={info.link}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                                        >
                                            Install Guide ↗
                                        </a>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Help text at bottom */}
            <div className="text-center pt-3 border-t border-white/5">
                <p className="text-[11px] text-zinc-600">
                    Can't find a tool? Make sure it's in your system PATH and click refresh.
                </p>
            </div>
        </div>
    );
}
