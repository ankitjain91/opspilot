import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { CheckCircle, AlertTriangle, RefreshCw, Terminal, Copy, CheckCircle2, ExternalLink, FolderOpen } from 'lucide-react';

interface DependencyStatus {
    name: string;
    installed: boolean;
    version?: string;
    path?: string;
}

interface ToolInfo {
    label: string;
    description: string;
    purpose: string;
    link: string;
    required: boolean;
    lookingFor: string;
    installCommands: {
        darwin: string;
        linux: string;
        windows: string;
    };
}

const TOOL_INFO: Record<string, ToolInfo> = {
    kubectl: {
        label: "kubectl",
        description: "Kubernetes command-line tool",
        purpose: "Connect to clusters, list resources, view logs, and execute commands",
        lookingFor: "kubectl binary in PATH",
        link: "https://kubernetes.io/docs/tasks/tools/",
        required: true,
        installCommands: {
            darwin: "brew install kubectl",
            linux: "curl -LO \"https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl\" && chmod +x kubectl && sudo mv kubectl /usr/local/bin/",
            windows: "winget install -e --id Kubernetes.kubectl"
        }
    },
    helm: {
        label: "Helm",
        description: "Kubernetes package manager",
        purpose: "Install, upgrade, and manage Helm charts and releases",
        lookingFor: "helm binary in PATH",
        link: "https://helm.sh/docs/intro/install/",
        required: true,
        installCommands: {
            darwin: "brew install helm",
            linux: "curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash",
            windows: "winget install -e --id Helm.Helm"
        }
    },
    vcluster: {
        label: "vcluster",
        description: "Virtual Kubernetes clusters",
        purpose: "Create isolated virtual clusters for testing and development",
        lookingFor: "vcluster binary in PATH",
        link: "https://www.vcluster.com/docs/getting-started/setup",
        required: false,
        installCommands: {
            darwin: "brew install loft-sh/tap/vcluster",
            linux: "curl -L -o vcluster \"https://github.com/loft-sh/vcluster/releases/latest/download/vcluster-linux-amd64\" && chmod +x vcluster && sudo mv vcluster /usr/local/bin/",
            windows: "winget install -e --id loft-sh.vcluster"
        }
    },
    "agent-server": {
        label: "Agent Server",
        description: "AI-powered backend service",
        purpose: "Powers AI chat, knowledge base, and intelligent analysis features",
        lookingFor: "Python sidecar running on port 8765",
        link: "https://github.com/ankitjain91/opspilot",
        required: true,
        installCommands: {
            darwin: "# Starts automatically with OpsPilot",
            linux: "# Starts automatically with OpsPilot",
            windows: "# Starts automatically with OpsPilot"
        }
    },
    ollama: {
        label: "Ollama",
        description: "Local AI model runtime",
        purpose: "Required for local embeddings and knowledge base features",
        lookingFor: "ollama binary in PATH",
        link: "https://ollama.com/download",
        required: false,
        installCommands: {
            darwin: "brew install ollama",
            linux: "curl -fsSL https://ollama.com/install.sh | sh",
            windows: "winget install Ollama.Ollama"
        }
    }
};

// Quick setup commands for all tools at once
const QUICK_SETUP_COMMANDS = {
    darwin: `# Install all tools (macOS)
brew install kubectl helm ollama
ollama serve &
ollama pull nomic-embed-text`,
    linux: `# Install all tools (Linux)
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && chmod +x kubectl && sudo mv kubectl /usr/local/bin/
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull nomic-embed-text`,
    windows: `# Install all tools (Windows - run in PowerShell as Admin)
winget install -e --id Kubernetes.kubectl
winget install -e --id Helm.Helm
winget install -e --id Ollama.Ollama
ollama serve
ollama pull nomic-embed-text`
};

interface DependencyManagerProps {
    onRefresh?: () => void;
}

export function DependencyManager({ onRefresh }: DependencyManagerProps) {
    const [statuses, setStatuses] = useState<DependencyStatus[]>([]);
    const [loading, setLoading] = useState(false);
    const [osInfo, setOsInfo] = useState<{ os: 'darwin' | 'linux' | 'windows'; arch: string }>({ os: 'linux', arch: 'amd64' });
    const [expandedTool, setExpandedTool] = useState<string | null>(null);
    const [copiedTool, setCopiedTool] = useState<string | null>(null);
    const [copiedQuickSetup, setCopiedQuickSetup] = useState(false);
    const [browsingTool, setBrowsingTool] = useState<string | null>(null);

    useEffect(() => {
        checkDeps();
        detectOS();
    }, []);

    const detectOS = async () => {
        const userAgent = window.navigator.userAgent.toLowerCase();
        let os: 'darwin' | 'linux' | 'windows' = "linux";
        let arch = "amd64";

        if (userAgent.includes("mac")) {
            os = "darwin";
            arch = userAgent.includes("arm") || userAgent.includes("apple") ? "arm64" : "amd64";
        } else if (userAgent.includes("win")) {
            os = "windows";
            arch = "amd64";
        }

        setOsInfo({ os, arch });
    };

    const checkDeps = async () => {
        setLoading(true);
        try {
            const res = await invoke<DependencyStatus[]>('check_dependencies');
            setStatuses(res);
            // Notify parent to update its badge
            onRefresh?.();
        } catch (e) {
            console.error("Failed to check deps:", e);
        } finally {
            setLoading(false);
        }
    };

    const copyCommand = async (toolName: string, command: string) => {
        await navigator.clipboard.writeText(command);
        setCopiedTool(toolName);
        setTimeout(() => setCopiedTool(null), 2000);
    };

    // Browse for executable (Windows only)
    const browseForTool = async (toolName: string) => {
        setBrowsingTool(toolName);
        try {
            const selected = await open({
                multiple: false,
                filters: [{
                    name: 'Executable',
                    extensions: ['exe', 'cmd', 'bat']
                }],
                title: `Select ${TOOL_INFO[toolName]?.label || toolName} executable`
            });

            if (selected && typeof selected === 'string') {
                // Set the custom path via Tauri command
                const result = await invoke<DependencyStatus>('set_tool_path', {
                    toolName,
                    toolPath: selected
                });

                // Update the status in our state
                setStatuses(prev => prev.map(s =>
                    s.name === toolName ? result : s
                ));

                // Notify parent
                onRefresh?.();
            }
        } catch (e) {
            console.error("Failed to set tool path:", e);
        } finally {
            setBrowsingTool(null);
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
                    const info = TOOL_INFO[tool.name];
                    if (!info) return null;

                    const isExpanded = expandedTool === tool.name;
                    const installCommand = info.installCommands[osInfo.os];
                    const isCopied = copiedTool === tool.name;

                    return (
                        <div key={tool.name} className={`rounded-xl border transition-all ${tool.installed
                            ? 'bg-emerald-500/5 border-emerald-500/20'
                            : 'bg-zinc-800/50 border-zinc-700'
                            }`}>
                            <div className="p-3 flex items-center justify-between gap-3">
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
                                    ) : tool.name === 'agent-server' ? (
                                        <span className="text-xs text-amber-400 flex items-center gap-1.5">
                                            <RefreshCw size={10} className="animate-spin" />
                                            Starting (~10s)
                                        </span>
                                    ) : (
                                        <button
                                            onClick={() => setExpandedTool(isExpanded ? null : tool.name)}
                                            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors"
                                        >
                                            <Terminal size={12} />
                                            {isExpanded ? 'Hide' : 'Install'}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Expanded install instructions */}
                            {isExpanded && !tool.installed && (
                                <div className="px-3 pb-3 pt-1 border-t border-white/5 animate-in slide-in-from-top-2 duration-200">
                                    <div className="bg-black/40 rounded-lg border border-white/10 overflow-hidden">
                                        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/5">
                                            <div className="flex items-center gap-2 text-xs text-zinc-400">
                                                <Terminal size={12} />
                                                <span>
                                                    {osInfo.os === 'darwin' ? 'macOS' : osInfo.os === 'windows' ? 'Windows' : 'Linux'}
                                                </span>
                                            </div>
                                            <button
                                                onClick={() => copyCommand(tool.name, installCommand)}
                                                className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white transition-all"
                                            >
                                                {isCopied ? (
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
                                        <div className="p-3">
                                            <code className="text-xs font-mono text-cyan-300 whitespace-pre-wrap break-all">
                                                {installCommand}
                                            </code>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between mt-2">
                                        <a
                                            href={info.link}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                                        >
                                            <ExternalLink size={10} />
                                            Official docs
                                        </a>
                                        <p className="text-[10px] text-zinc-600">
                                            After installing, click refresh above
                                        </p>
                                    </div>

                                    {/* Browse for executable - Windows only */}
                                    {osInfo.os === 'windows' && (
                                        <div className="mt-3 pt-3 border-t border-white/5">
                                            <div className="flex items-center justify-between">
                                                <p className="text-[11px] text-zinc-400">
                                                    Already installed but not detected?
                                                </p>
                                                <button
                                                    onClick={() => browseForTool(tool.name)}
                                                    disabled={browsingTool === tool.name}
                                                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                                                >
                                                    <FolderOpen size={12} />
                                                    {browsingTool === tool.name ? 'Selecting...' : 'Browse'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Quick Setup Section */}
            {!allRequiredInstalled && (
                <div className="pt-4 border-t border-white/10">
                    <div className="bg-gradient-to-br from-cyan-500/10 to-blue-500/10 border border-cyan-500/20 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                                <Terminal size={16} className="text-cyan-400" />
                                <span className="text-sm font-semibold text-white">Quick Setup</span>
                            </div>
                            <span className="text-[10px] text-zinc-500 uppercase">
                                {osInfo.os === 'darwin' ? 'macOS' : osInfo.os === 'windows' ? 'Windows' : 'Linux'}
                            </span>
                        </div>
                        <p className="text-[11px] text-zinc-400 mb-3">
                            Copy and run these commands to install all tools at once:
                        </p>
                        <div className="bg-black/40 rounded-lg border border-white/10 overflow-hidden">
                            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/5">
                                <span className="text-[10px] text-zinc-500 font-mono">Terminal</span>
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(QUICK_SETUP_COMMANDS[osInfo.os]);
                                        setCopiedQuickSetup(true);
                                        setTimeout(() => setCopiedQuickSetup(false), 2000);
                                    }}
                                    className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white transition-all"
                                >
                                    {copiedQuickSetup ? (
                                        <>
                                            <CheckCircle2 size={12} className="text-green-400" />
                                            <span className="text-green-400">Copied!</span>
                                        </>
                                    ) : (
                                        <>
                                            <Copy size={12} />
                                            <span>Copy All</span>
                                        </>
                                    )}
                                </button>
                            </div>
                            <div className="p-3 max-h-32 overflow-y-auto">
                                <code className="text-[11px] font-mono text-cyan-300 whitespace-pre-wrap">
                                    {QUICK_SETUP_COMMANDS[osInfo.os]}
                                </code>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Help text at bottom */}
            <div className="text-center pt-3 border-t border-white/5">
                <p className="text-[11px] text-zinc-600">
                    {osInfo.os === 'windows'
                        ? "Can't find a tool? Click Install, then use Browse to select the executable."
                        : "Can't find a tool? Make sure it's in your system PATH and click refresh."}
                </p>
            </div>
        </div>
    );
}
