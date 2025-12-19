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

const TOOL_INFO: Record<string, { label: string; description: string; purpose: string; link: string; required: boolean }> = {
    kubectl: {
        label: "Kubernetes CLI",
        description: "The official command line tool for communicating with the Kubernetes control plane.",
        purpose: "Required to inspect clusters, manage resources, and execute commands.",
        link: "https://kubernetes.io/docs/tasks/tools/",
        required: true
    },
    helm: {
        label: "Helm Package Manager",
        description: "The package manager for Kubernetes.",
        purpose: "Needed to install, upgrade, and manage applications on your cluster.",
        link: "https://helm.sh/docs/intro/install/",
        required: true
    },
    vcluster: {
        label: "Virtual Cluster CLI",
        description: "Tool for creating isolated virtual clusters.",
        purpose: "Recommended for creating safe, sandboxed environments for testing.",
        link: "https://www.vcluster.com/docs/getting-started/setup",
        required: false
    },
    "agent-server": {
        label: "Python Agent Sidecar",
        description: "AI backend service designed for OpsPilot.",
        purpose: "Powers the LLM reasoning and code execution. Run `bin/agent-server`.",
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

    return (
        <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-green-400" />
                    System Dependencies
                </h2>
                <button
                    onClick={checkDeps}
                    className="p-2 hover:bg-gray-800 rounded-full text-gray-400"
                    disabled={loading}
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            <div className="space-y-3">
                <div className="space-y-4">
                    {statuses.map(tool => {
                        const info = TOOL_INFO[tool.name] || {
                            label: tool.name,
                            description: "System tool",
                            purpose: "Required for system operations",
                            link: "#",
                            required: false
                        };
                        const isDownloading = downloading[tool.name] !== undefined;
                        const progress = downloading[tool.name];
                        const canInstall = getDownloadUrl(tool.name) !== "";

                        return (
                            <div key={tool.name} className={`p-4 rounded-xl border transition-all ${tool.installed
                                    ? 'bg-emerald-500/5 border-emerald-500/20'
                                    : 'bg-gray-800/50 border-gray-700'
                                }`}>
                                <div className="flex items-start justify-between mb-3">
                                    <div>
                                        <h3 className="text-sm font-bold text-white flex items-center gap-2">
                                            {info.label}
                                            {info.required && <span className="text-[10px] bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded uppercase tracking-wider">Required</span>}
                                            {tool.installed && <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono">{tool.version}</span>}
                                        </h3>
                                        <p className="text-xs text-gray-400 mt-1">{info.description}</p>
                                    </div>
                                    <div className="shrink-0">
                                        {tool.installed ? (
                                            <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-bold bg-emerald-500/10 px-2 py-1 rounded-full">
                                                <CheckCircle size={14} />
                                                <span>Ready</span>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5 text-amber-500 text-xs font-bold bg-amber-500/10 px-2 py-1 rounded-full">
                                                <AlertTriangle size={14} />
                                                <span>Missing</span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="bg-black/20 rounded p-2.5 mb-3 border border-white/5">
                                    <div className="text-[11px] text-blue-300 font-medium mb-0.5">Why is this needed?</div>
                                    <div className="text-[11px] text-gray-400 leading-relaxed">{info.purpose}</div>
                                </div>

                                {!tool.installed && (
                                    <div className="flex items-center gap-3 pt-2 border-t border-white/5">
                                        {isDownloading ? (
                                            <div className="flex-1 flex items-center gap-3">
                                                <div className="flex flex-col flex-1">
                                                    <div className="flex justify-between text-[10px] text-blue-300 mb-1">
                                                        <span>Downloading...</span>
                                                        <span>{progress}%</span>
                                                    </div>
                                                    <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                                                        <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }} />
                                                    </div>
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                {canInstall ? (
                                                    <button
                                                        onClick={() => handleInstall(tool.name)}
                                                        className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition-colors"
                                                    >
                                                        <Download size={14} />
                                                        Auto-Install
                                                    </button>
                                                ) : (
                                                    <div className="text-[11px] text-gray-500 italic">
                                                        Results of auto-install may vary.
                                                    </div>
                                                )}

                                                <a
                                                    href={info.link}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-xs text-blue-400 hover:text-blue-300 hover:underline flex items-center gap-1"
                                                >
                                                    Manual Installation Guide ↗
                                                </a>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
