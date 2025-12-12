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
                {statuses.map(tool => {
                    const isDownloading = downloading[tool.name] !== undefined;
                    const progress = downloading[tool.name];
                    const canInstall = getDownloadUrl(tool.name) !== "";

                    return (
                        <div key={tool.name} className="flex items-center justify-between p-3 bg-gray-800 rounded border border-gray-700">
                            <div className="flex flex-col">
                                <span className="font-medium text-gray-200 capitalize">{tool.name}</span>
                                <div className="flex gap-2 text-xs text-gray-400">
                                    {tool.installed ? (
                                        <span className="text-green-400 flex items-center gap-1">
                                            Installed {tool.version && `(${tool.version})`}
                                        </span>
                                    ) : (
                                        <span className="text-yellow-500 flex items-center gap-1">
                                            Missing
                                        </span>
                                    )}
                                    {tool.path && <span className="opacity-50 truncate max-w-[200px]">{tool.path}</span>}
                                </div>
                            </div>

                            <div>
                                {isDownloading ? (
                                    <div className="flex flex-col items-end min-w-[100px]">
                                        <div className="flex items-center gap-2 text-blue-400 text-sm mb-1">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            {progress}%
                                        </div>
                                        <div className="w-24 h-1 bg-gray-700 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-blue-500 transition-all duration-300"
                                                style={{ width: `${progress}%` }}
                                            />
                                        </div>
                                    </div>
                                ) : !tool.installed && canInstall ? (
                                    <button
                                        onClick={() => handleInstall(tool.name)}
                                        className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium transition-colors"
                                    >
                                        <Download className="w-4 h-4" />
                                        Install
                                    </button>
                                ) : !tool.installed && !canInstall ? (
                                    <span className="text-xs text-gray-500 italic">Manual Install Req.</span>
                                ) : (
                                    <CheckCircle className="w-5 h-5 text-green-500 opacity-50" />
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
