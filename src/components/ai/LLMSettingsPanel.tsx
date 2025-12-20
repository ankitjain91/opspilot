
import { useState, useEffect } from 'react';
import { X, Eye, EyeOff, BookOpen, HardDrive, RefreshCw, Server, Network, ArrowRight, Info, ShieldCheck, Loader2, CheckCircle2, Github, Download, AlertCircle, Terminal, Check, Search, FileJson, Settings2, FileCode, Plus, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { LLMConfig } from '../../types/ai';
import { DEFAULT_LLM_CONFIG } from './constants';
import { getAgentServerUrl, setAgentServerUrl, getAllConfigWithSources, ConfigSource } from '../../utils/config';
import { KBProgress } from './useSentinel';

const AGENT_SERVER_URL = getAgentServerUrl();

interface EmbeddingModelStatus {
    model: string;
    available: boolean;
    size_mb: number | null;
    ollama_connected: boolean;
    error?: string;
}

interface KBEmbeddingsStatus {
    available: boolean;
    source: 'bundled' | 'cached' | null;
    document_count: number;
    kb_files_found?: number;
    can_generate?: boolean;
    embedding_model?: string;
    embedding_model_available?: boolean;
}

interface ClaudeCodeStatus {
    connected: boolean;
    error?: string;
}

interface CodexStatus {
    connected: boolean;
    version?: string;
    error?: string;
}

interface GitHubGroup {
    id: string;
    name: string;
    type: 'user' | 'org';
    avatar_url: string;
}

export function LLMSettingsPanel({
    config,
    onConfigChange,
    onClose,
    kbProgress
}: {
    config: LLMConfig;
    onConfigChange: (config: LLMConfig) => void;
    onClose: () => void;
    systemSpecs?: { cpu_brand: string; total_memory: number; is_apple_silicon: boolean; } | null;
    kbProgress?: KBProgress | null;
}) {
    // --- STATE ---
    const [localConfig, setLocalConfig] = useState<LLMConfig>(config);

    // Claude Code Status
    const [claudeCodeStatus, setClaudeCodeStatus] = useState<ClaudeCodeStatus | null>(null);
    const [checkingClaudeCode, setCheckingClaudeCode] = useState(false);

    // Codex Status
    const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
    const [checkingCodex, setCheckingCodex] = useState(false);

    // Embedding State
    const [embeddingMode, setEmbeddingMode] = useState<'local' | 'custom'>(
        localConfig.embedding_endpoint ? 'custom' : 'local'
    );
    const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingModelStatus | null>(null);
    const [checkingEmbedding, setCheckingEmbedding] = useState(false);
    const [downloadingEmbedding, setDownloadingEmbedding] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

    // KB State
    const [kbStatus, setKbStatus] = useState<KBEmbeddingsStatus | null>(null);
    const [reindexingKb, setReindexingKb] = useState(false);
    const [kbMessage, setKbMessage] = useState<string | null>(null);

    // GitHub Integration State
    const [githubPat, setGithubPat] = useState<string>('');
    const [showGithubPat, setShowGithubPat] = useState(false);
    const [githubRepos, setGithubRepos] = useState<string[]>([]);
    const [githubConfigured, setGithubConfigured] = useState(false);
    const [githubSaveStatus, setGithubSaveStatus] = useState<string | null>(null);
    const [githubUser, setGithubUser] = useState<string | null>(null);
    const [testingGithub, setTestingGithub] = useState(false);
    const [githubGroups, setGithubGroups] = useState<GitHubGroup[]>([]);
    const [selectedGroup, setSelectedGroup] = useState<string>('');
    const [availableRepos, setAvailableRepos] = useState<string[]>([]);
    const [repoSearch, setRepoSearch] = useState('');
    const [loadingGroups, setLoadingGroups] = useState(false);
    const [loadingRepos, setLoadingRepos] = useState(false);
    const [searchAllRepos, setSearchAllRepos] = useState(true); // ON by default - search all accessible repos
    const [githubConfigLoaded, setGithubConfigLoaded] = useState(false); // Track if initial load is complete

    // Agent Config State
    const [agentUrl, setAgentUrl] = useState(getAgentServerUrl());
    const [claudeCliPath, setClaudeCliPath] = useState('claude');
    const [showAgentSettings, setShowAgentSettings] = useState(false);

    // Config source tracking (shows where each setting came from)
    const [configSources, setConfigSources] = useState<{
        agentUrl?: ConfigSource;
        claudeCliPath?: ConfigSource;
        embeddingEndpoint?: ConfigSource;
    }>({});

    // Derived State
    const filteredRepos = availableRepos.filter(repo =>
        repo.toLowerCase().includes(repoSearch.toLowerCase())
    );

    // --- ACTIONS ---

    const handleSave = async () => {
        const configToSave = {
            ...localConfig,
            // provider is now managed in localConfig
            embedding_endpoint: embeddingMode === 'local' ? null : localConfig.embedding_endpoint
        };

        // Persist Agent URL
        setAgentServerUrl(agentUrl);

        onConfigChange(configToSave);
        localStorage.setItem('opspilot-llm-config', JSON.stringify(configToSave));

        try {
            await invoke('save_llm_config', { config: configToSave });
        } catch (e) {
            console.warn('Failed to persist config:', e);
        }
        onClose();
    };

    // --- CLAUDE CODE STATUS ---

    const checkClaudeCodeStatus = async () => {
        setCheckingClaudeCode(true);
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/llm/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'claude-code' })
            });
            if (resp.ok) {
                const data = await resp.json();
                setClaudeCodeStatus({ connected: data.connected, error: data.error });
            }
        } catch (e) {
            setClaudeCodeStatus({ connected: false, error: String(e) });
        }
        setCheckingClaudeCode(false);
    };

    const checkCodexStatus = async () => {
        setCheckingCodex(true);
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/llm/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'codex-cli' })
            });
            if (resp.ok) {
                const data = await resp.json();
                setCodexStatus({ connected: data.connected, version: data.version, error: data.error });
            }
        } catch (e) {
            setCodexStatus({ connected: false, error: String(e) });
        }
        setCheckingCodex(false);
    };

    // --- EMBEDDING LOGIC ---

    const getEffectiveEmbeddingEndpoint = () => {
        if (embeddingMode === 'custom') return localConfig.embedding_endpoint;
        return 'http://127.0.0.1:11434';
    };

    const checkEmbeddingStatus = async () => {
        setCheckingEmbedding(true);
        try {
            const modelParam = localConfig.embedding_model ? `&model_name=${encodeURIComponent(localConfig.embedding_model)}` : '';
            const targetEndpoint = getEffectiveEmbeddingEndpoint();
            const endpointParam = targetEndpoint ? `&embedding_endpoint=${encodeURIComponent(targetEndpoint)}` : '';

            const resp = await fetch(`${AGENT_SERVER_URL}/embedding-model/status?llm_endpoint=${encodeURIComponent(localConfig.base_url || '')}${modelParam}${endpointParam}`);
            if (resp.ok) {
                setEmbeddingStatus(await resp.json());
            }
        } catch (e) {
            console.error("Embedding status check failed", e);
            setEmbeddingStatus(null);
        }
        setCheckingEmbedding(false);
    };

    const pullEmbeddingModel = async () => {
        setDownloadingEmbedding(true);
        setDownloadProgress(0);
        try {
            const modelParam = localConfig.embedding_model ? `&model_name=${encodeURIComponent(localConfig.embedding_model)}` : '';
            const targetEndpoint = getEffectiveEmbeddingEndpoint();
            const endpointParam = targetEndpoint ? `&embedding_endpoint=${encodeURIComponent(targetEndpoint)}` : '';

            const resp = await fetch(`${AGENT_SERVER_URL}/embedding-model/pull?llm_endpoint=${encodeURIComponent(localConfig.base_url || '')}${modelParam}${endpointParam}`, {
                method: 'POST'
            });

            if (!resp.body) throw new Error("No stream");
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const lines = decoder.decode(value).split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.percent) setDownloadProgress(data.percent);
                            if (data.status === 'success') {
                                setDownloadProgress(100);
                                setTimeout(checkEmbeddingStatus, 1000);
                            }
                        } catch { }
                    }
                }
            }
        } catch (e) {
            console.error("Pull failed", e);
        }
        setDownloadingEmbedding(false);
    };

    // --- KB LOGIC ---

    const checkKbStatus = async () => {
        try {
            const targetEndpoint = getEffectiveEmbeddingEndpoint();
            const endpointParam = targetEndpoint ? `&embedding_endpoint=${encodeURIComponent(targetEndpoint)}` : '';
            const resp = await fetch(`${AGENT_SERVER_URL}/kb-embeddings/status?llm_endpoint=${encodeURIComponent(localConfig.base_url || '')}${endpointParam}`);
            if (resp.ok) setKbStatus(await resp.json());
        } catch (e) {
            console.error("KB status failed", e);
        }
    };

    const reindexKb = async () => {
        setReindexingKb(true);
        setKbMessage("Starting indexing...");

        try {
            const modelParam = localConfig.embedding_model ? `&model_name=${encodeURIComponent(localConfig.embedding_model)}` : '';
            const targetEndpoint = getEffectiveEmbeddingEndpoint();
            const endpointParam = targetEndpoint ? `&embedding_endpoint=${encodeURIComponent(targetEndpoint)}` : '';

            const resp = await fetch(`${AGENT_SERVER_URL}/kb-embeddings/generate?llm_endpoint=${encodeURIComponent(localConfig.base_url || '')}${modelParam}${endpointParam}`, {
                method: 'POST'
            });

            if (!resp.body) throw new Error("No stream");
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const lines = decoder.decode(value).split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.message) setKbMessage(data.message);
                            if (data.status === 'success') setTimeout(checkKbStatus, 1000);
                        } catch { }
                    }
                }
            }
        } catch (e) {
            setKbMessage("Failed: " + e);
        }
        setReindexingKb(false);
    };

    // --- GITHUB LOGIC ---

    const loadGithubConfig = async () => {
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/github-config`);
            if (resp.ok) {
                const data = await resp.json();
                setGithubConfigured(data.configured);
                setGithubRepos(data.default_repos || []);
                setSearchAllRepos(data.search_all_repos !== false);  // Default to true if not set
                setClaudeCliPath(data.claude_cli_path || 'claude');
                setGithubConfigLoaded(true);  // Mark as loaded to enable auto-save
                if (data.configured) {
                    testGithubConnection();
                }
            }
        } catch (e) {
            console.error("Failed to load GitHub config:", e);
        }
    };

    const saveGithubConfig = async () => {
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/github-config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pat_token: githubPat || null,
                    default_repos: githubRepos,
                    search_all_repos: searchAllRepos,
                    claude_cli_path: claudeCliPath
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                setGithubConfigured(data.configured);
                if (data.configured) {
                    testGithubConnection();
                }
            }
        } catch (e) {
            console.error("Failed to save GitHub config:", e);
        }
    };

    const handleDisconnectGithub = async () => {
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/github-config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pat_token: null,
                    default_repos: [],
                    search_all_repos: true
                })
            });
            if (resp.ok) {
                setGithubConfigured(false);
                setGithubUser(null);
                setGithubPat('');
                setGithubRepos([]);
                setAvailableRepos([]);
                setSelectedGroup('');
            }
        } catch (e) {
            console.error("Failed to disconnect GitHub:", e);
        }
    };

    const testGithubConnection = async (tokenToTest?: string) => {
        setTestingGithub(true);
        try {
            const testToken = tokenToTest || (githubPat && githubPat !== 'replace' ? githubPat : undefined);
            const resp = await fetch(`${AGENT_SERVER_URL}/github-config/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pat_token: testToken })
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.connected) {
                    setGithubConfigured(true);
                    setGithubUser(data.user);
                    loadGithubGroups();
                } else {
                    setGithubConfigured(false);
                    setGithubUser(null);
                }
            }
        } catch (e) {
            console.error("Failed to test GitHub:", e);
            setGithubConfigured(false);
            setGithubUser(null);
        }
        setTestingGithub(false);
    };

    const loadGithubGroups = async () => {
        if (loadingGroups) return;
        setLoadingGroups(true);
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/github/orgs`);
            if (resp.ok) {
                const data = await resp.json();
                setGithubGroups(data);
                // Also load repos for first group if none selected
                if (data.length > 0 && !selectedGroup) {
                    setSelectedGroup(data[0].id);
                }
            }
        } catch (e) {
            console.error("Failed to load GitHub groups:", e);
        }
        setLoadingGroups(false);
    };

    const loadGithubRepos = async (groupId: string) => {
        if (!groupId || loadingRepos) return;
        setLoadingRepos(true);
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/github/repos/${groupId}`);
            if (resp.ok) {
                const data = await resp.json();
                setAvailableRepos(data);
            }
        } catch (e) {
            console.error("Failed to load GitHub repos:", e);
        }
        setLoadingRepos(false);
    };

    useEffect(() => {
        if (selectedGroup) {
            loadGithubRepos(selectedGroup);
        }
    }, [selectedGroup]);

    useEffect(() => {
        checkClaudeCodeStatus();
        checkCodexStatus();
        checkEmbeddingStatus();
        checkKbStatus();
        loadGithubConfig();

        // Load config with sources to show where values came from
        getAllConfigWithSources().then(config => {
            setAgentUrl(config.agentUrl.value);
            setClaudeCliPath(config.claudeCliPath.value);
            setConfigSources({
                agentUrl: config.agentUrl.source,
                claudeCliPath: config.claudeCliPath.source,
                embeddingEndpoint: config.embeddingEndpoint.source,
            });
        }).catch(e => console.warn('Failed to load config sources:', e));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (embeddingStatus?.available) checkKbStatus();
    }, [embeddingStatus?.available]);

    // Auto-save GitHub config when repos or searchAllRepos changes (after initial load)
    useEffect(() => {
        if (!githubConfigLoaded || !githubConfigured) return;  // Don't save until config is loaded

        const saveTimeout = setTimeout(async () => {
            try {
                await fetch(`${AGENT_SERVER_URL}/github-config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        default_repos: githubRepos,
                        search_all_repos: searchAllRepos,
                        claude_cli_path: claudeCliPath
                    })
                });
            } catch (e) {
                console.error("Failed to auto-save GitHub config:", e);
            }
        }, 500);  // Debounce saves by 500ms

        return () => clearTimeout(saveTimeout);
    }, [githubRepos, searchAllRepos, claudeCliPath, githubConfigLoaded, githubConfigured]);

    // Auto-detect coding agent provider logic removed


    // RENDER HELPERS

    const StatusDot = ({ ok, loading }: { ok?: boolean, loading?: boolean }) => (
        <div className={`relative w-2 h-2 rounded-full ${loading ? 'bg-amber-400' :
            ok ? 'bg-emerald-400' : 'bg-red-400/80'
            }`}>
            {loading && <div className="absolute inset-0 bg-amber-400 rounded-full animate-ping" />}
            {ok && !loading && <div className="absolute inset-0 bg-emerald-400 rounded-full animate-pulse opacity-50" />}
        </div>
    );

    // Config source badge - shows where a setting value came from
    const ConfigSourceBadge = ({ source }: { source?: ConfigSource }) => {
        if (!source || source === 'default') return null;

        const labels: Record<ConfigSource, { label: string; color: string; icon: React.ReactNode }> = {
            'env': { label: 'ENV', color: 'bg-green-500/20 text-green-400 border-green-500/30', icon: <Settings2 size={10} /> },
            'file': { label: 'CONFIG', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', icon: <FileJson size={10} /> },
            'localStorage': { label: 'SAVED', color: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', icon: null },
            'auto-detected': { label: 'AUTO', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30', icon: <Sparkles size={10} /> },
            'default': { label: '', color: '', icon: null },
        };

        const config = labels[source];
        return (
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border ${config.color}`}
                title={`Value loaded from: ${source === 'env' ? 'Environment Variable' : source === 'file' ? '.opspilot.json config file' : source === 'auto-detected' ? 'Auto-detected' : 'Saved in app'}`}>
                {config.icon}
                {config.label}
            </span>
        );
    };

    // Sparkles icon for auto-detected values
    const Sparkles = ({ size }: { size: number }) => (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
        </svg>
    );

    return (
        <div className="flex flex-col h-full bg-black/60 backdrop-blur-2xl">
            {/* --- HEADER --- */}
            <div className="p-6 border-b border-white/5 bg-white/[0.02]">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="p-3 rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 shadow-[0_0_25px_rgba(124,58,237,0.3)] border border-white/10">
                            <Terminal size={24} className="text-white" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white tracking-tight">Settings</h2>
                            <p className="text-sm text-zinc-400 font-medium">Claude Code + GitHub Integration</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2.5 rounded-full hover:bg-white/10 text-zinc-400 hover:text-white transition-all hover:scale-110">
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">

                {/* === SECTION 0: AGENT CONNECTION === */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 shadow-xl relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-transparent pointer-events-none" />

                    <div className="flex items-center justify-between mb-0 relative z-10 cursor-pointer" onClick={() => setShowAgentSettings(!showAgentSettings)}>
                        <div className="flex items-center gap-2.5">
                            <div className="p-1.5 bg-indigo-500/20 rounded-lg text-indigo-400">
                                <Network size={18} />
                            </div>
                            <h3 className="text-sm font-bold text-white uppercase tracking-wider">Agent Connection</h3>
                        </div>
                        <button className="text-zinc-500 hover:text-white transition-colors">
                            {showAgentSettings ? "Hide" : "Show"}
                        </button>
                    </div>

                    {showAgentSettings && (
                        <div className="mt-5 space-y-4 relative z-10 animate-in fade-in slide-in-from-top-2 duration-200">
                            {/* Quick config tip */}
                            <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-3 text-[10px] text-indigo-300/80">
                                <strong className="text-indigo-300">💡 Tip:</strong> Set <code className="bg-black/30 px-1 rounded">OPSPILOT_AGENT_URL</code> environment variable or create <code className="bg-black/30 px-1 rounded">~/.opspilot.json</code> for zero-config setup across machines.
                            </div>

                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <label className="text-[10px] font-bold text-zinc-500 uppercase">Agent Server URL</label>
                                    <ConfigSourceBadge source={configSources.agentUrl} />
                                </div>
                                <input
                                    type="text"
                                    value={agentUrl}
                                    onChange={e => {
                                        setAgentUrl(e.target.value);
                                        setConfigSources(prev => ({ ...prev, agentUrl: 'localStorage' }));
                                    }}
                                    className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white focus:border-indigo-500/50 outline-none font-mono"
                                    placeholder="http://127.0.0.1:8765"
                                />
                                <p className="text-[10px] text-zinc-500 mt-1">
                                    {configSources.agentUrl === 'auto-detected' ? '✓ Auto-detected from running agent' :
                                        configSources.agentUrl === 'env' ? '✓ Set via OPSPILOT_AGENT_URL environment variable' :
                                            configSources.agentUrl === 'file' ? '✓ Loaded from .opspilot.json config file' :
                                                'Check the backend terminal output for the Network URL (e.g., http://192.168.1.5:8765).'}
                                </p>
                            </div>

                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <label className="text-[10px] font-bold text-zinc-500 uppercase">Claude CLI Path</label>
                                    <ConfigSourceBadge source={configSources.claudeCliPath} />
                                </div>
                                <input
                                    type="text"
                                    value={claudeCliPath}
                                    onChange={e => {
                                        setClaudeCliPath(e.target.value);
                                        setConfigSources(prev => ({ ...prev, claudeCliPath: 'localStorage' }));
                                    }}
                                    className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white focus:border-indigo-500/50 outline-none font-mono"
                                    placeholder="claude"
                                />
                                <p className="text-[10px] text-zinc-500 mt-1">
                                    {configSources.claudeCliPath === 'env' ? '✓ Set via OPSPILOT_CLAUDE_CLI_PATH environment variable' :
                                        configSources.claudeCliPath === 'file' ? '✓ Loaded from .opspilot.json config file' :
                                            "Absolute path to 'claude' executable. Default: 'claude' (uses system PATH)."}
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* === SECTION 1: CODING AGENT === */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 shadow-xl relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-violet-500/5 to-transparent pointer-events-none" />

                    <div className="flex items-center justify-between mb-4 relative z-10">
                        <div className="flex items-center gap-2.5">
                            <div className="p-1.5 bg-violet-500/20 rounded-lg text-violet-400">
                                <Terminal size={18} />
                            </div>
                            <h3 className="text-sm font-bold text-white uppercase tracking-wider">Coding Agent</h3>
                        </div>

                        {/* Provider Toggle */}
                        <div className="flex bg-black/40 rounded-lg p-1 border border-white/10">
                            <button
                                onClick={() => setLocalConfig({ ...localConfig, provider: 'claude-code' })}
                                className={`px-3 py-1.5 rounded text-[10px] font-bold transition-all ${localConfig.provider === 'claude-code'
                                    ? 'bg-violet-500/20 text-violet-300 shadow-sm border border-violet-500/30'
                                    : 'text-zinc-500 hover:text-zinc-300'
                                    }`}
                            >
                                Claude Code
                            </button>
                            <button
                                onClick={() => setLocalConfig({ ...localConfig, provider: 'codex-cli' })}
                                className={`px-3 py-1.5 rounded text-[10px] font-bold transition-all ${localConfig.provider === 'codex-cli'
                                    ? 'bg-blue-500/20 text-blue-300 shadow-sm border border-blue-500/30'
                                    : 'text-zinc-500 hover:text-zinc-300'
                                    }`}
                            >
                                Codex CLI
                            </button>
                        </div>
                    </div>

                    <div className="space-y-4 relative z-10">
                        <p className="text-[11px] text-zinc-400">
                            {localConfig.provider === 'claude-code'
                                ? "OpsPilot uses Claude Code as its AI backbone. Authenticate via the terminal for full agent capabilities."
                                : "OpsPilot uses the OpenAI Codex CLI for autonomous coding and troubleshooting."}
                        </p>

                        {/* Status Display */}
                        {localConfig.provider === 'claude-code' ? (
                            <div className={`p-3 rounded-xl border flex items-center gap-3 transition-all ${checkingClaudeCode ? 'bg-amber-500/5 border-amber-500/20' :
                                claudeCodeStatus?.connected ? 'bg-emerald-500/5 border-emerald-500/20' :
                                    'bg-red-500/5 border-red-500/20'
                                }`}>
                                <StatusDot ok={claudeCodeStatus?.connected} loading={checkingClaudeCode} />
                                <div className="flex-1">
                                    <div className={`text-xs font-bold ${checkingClaudeCode ? 'text-amber-400' :
                                        claudeCodeStatus?.connected ? 'text-emerald-400' :
                                            'text-red-400'
                                        }`}>
                                        {checkingClaudeCode ? 'Checking...' :
                                            claudeCodeStatus?.connected ? 'Claude Code Ready' :
                                                'Claude Code Not Available'}
                                    </div>
                                    {claudeCodeStatus?.error && !checkingClaudeCode && (
                                        <div className="text-[10px] text-red-400/80 mt-1">{claudeCodeStatus.error}</div>
                                    )}
                                </div>
                                <button
                                    onClick={checkClaudeCodeStatus}
                                    disabled={checkingClaudeCode}
                                    className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/5 rounded px-2 py-1 text-zinc-400 transition-colors disabled:opacity-50"
                                >
                                    Test
                                </button>
                            </div>
                        ) : (
                            <div className={`p-3 rounded-xl border flex items-center gap-3 transition-all ${checkingCodex ? 'bg-amber-500/5 border-amber-500/20' :
                                codexStatus?.connected ? 'bg-blue-500/5 border-blue-500/20' :
                                    'bg-red-500/5 border-red-500/20'
                                }`}>
                                <StatusDot ok={codexStatus?.connected} loading={checkingCodex} />
                                <div className="flex-1">
                                    <div className={`text-xs font-bold ${checkingCodex ? 'text-amber-400' :
                                        codexStatus?.connected ? 'text-blue-400' :
                                            'text-red-400'
                                        }`}>
                                        {checkingCodex ? 'Checking...' :
                                            codexStatus?.connected ? `Codex Ready (${codexStatus.version})` :
                                                'Codex CLI Not Available'}
                                    </div>
                                    {codexStatus?.error && !checkingCodex && (
                                        <div className="text-[10px] text-red-400/80 mt-1">{codexStatus.error}</div>
                                    )}
                                </div>
                                <button
                                    onClick={checkCodexStatus}
                                    disabled={checkingCodex}
                                    className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/5 rounded px-2 py-1 text-zinc-400 transition-colors disabled:opacity-50"
                                >
                                    Test
                                </button>
                            </div>
                        )}

                        {/* Setup Instructions */}
                        {((localConfig.provider === 'claude-code' && !claudeCodeStatus?.connected && !checkingClaudeCode) ||
                            (localConfig.provider === 'codex-cli' && !codexStatus?.connected && !checkingCodex)) && (
                                <div className="bg-zinc-900/80 rounded-lg border border-white/5 p-3 space-y-2">
                                    <div className="flex items-center gap-2 text-zinc-500 border-b border-white/5 pb-2">
                                        <Info size={12} />
                                        <span className="text-[10px] font-bold uppercase tracking-wider">Setup Instructions</span>
                                    </div>
                                    <div className="text-[11px] text-zinc-400 space-y-2">
                                        {localConfig.provider === 'claude-code' ? (
                                            <>
                                                <div className="flex items-start gap-2">
                                                    <span className="text-violet-400 font-bold">1.</span>
                                                    <span>Install Claude Code: <code className="bg-white/10 px-1.5 py-0.5 rounded text-emerald-300">npm install -g @anthropic-ai/claude-code</code></span>
                                                </div>
                                                <div className="flex items-start gap-2">
                                                    <span className="text-violet-400 font-bold">2.</span>
                                                    <span>Authenticate: <code className="bg-white/10 px-1.5 py-0.5 rounded text-emerald-300">claude login</code></span>
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <div className="flex items-start gap-2">
                                                    <span className="text-blue-400 font-bold">1.</span>
                                                    <span>Install Codex CLI: <code className="bg-white/10 px-1.5 py-0.5 rounded text-emerald-300">npm install -g @openai/codex-cli</code></span>
                                                </div>
                                                <div className="flex items-start gap-2">
                                                    <span className="text-blue-400 font-bold">2.</span>
                                                    <span>Authenticate: <code className="bg-white/10 px-1.5 py-0.5 rounded text-emerald-300">codex login</code></span>
                                                </div>
                                            </>
                                        )}
                                        <div className="flex items-start gap-2">
                                            <span className={localConfig.provider === 'claude-code' ? "text-violet-400 font-bold" : "text-blue-400 font-bold"}>3.</span>
                                            <span>Restart OpsPilot</span>
                                        </div>
                                    </div>
                                </div>
                            )}
                    </div>
                </div>

                {/* === SECTION 2: SMART CODE DISCOVERY === */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 shadow-xl relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />

                    <div className="flex items-center gap-2.5 mb-5 relative z-10">
                        <div className="p-1.5 bg-emerald-500/20 rounded-lg text-emerald-400">
                            <FileCode size={18} />
                        </div>
                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">Smart Code Discovery</h3>
                    </div>

                    <div className="space-y-4 relative z-10">
                        <p className="text-[11px] text-zinc-400">
                            Map container images to local project folders. This allows the agent to deep link stack traces directly to your source code.
                        </p>

                        {/* Mappings List */}
                        <div className="space-y-2">
                            {(localConfig.project_mappings || []).map((mapping, idx) => (
                                <div key={idx} className="flex items-center gap-2 p-2 bg-black/20 rounded-lg border border-white/5 group">
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[10px] font-mono text-emerald-300 truncate">{mapping.image_pattern}</div>
                                        <div className="text-[10px] font-mono text-zinc-500 truncate" title={mapping.local_path}>{mapping.local_path}</div>
                                    </div>
                                    <button
                                        onClick={() => {
                                            const newMappings = [...(localConfig.project_mappings || [])];
                                            newMappings.splice(idx, 1);
                                            setLocalConfig({ ...localConfig, project_mappings: newMappings });
                                        }}
                                        className="p-1.5 hover:bg-red-500/20 text-zinc-600 hover:text-red-400 rounded transition-colors"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            ))}
                            {(localConfig.project_mappings || []).length === 0 && (
                                <div className="text-[10px] text-zinc-600 italic text-center py-2">No mappings configured</div>
                            )}
                        </div>

                        {/* Add New Mapping */}
                        <div className="flex gap-2 items-end">
                            <div className="flex-1 space-y-1">
                                <label className="text-[9px] font-bold text-zinc-500 uppercase">Image Pattern (Regex)</label>
                                <input
                                    type="text"
                                    id="new-mapping-pattern"
                                    className="w-full bg-black/20 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:border-emerald-500/50 outline-none font-mono"
                                    placeholder="my-app:.*"
                                />
                            </div>
                            <div className="flex-[2] space-y-1">
                                <label className="text-[9px] font-bold text-zinc-500 uppercase">Local Absolute Path</label>
                                <input
                                    type="text"
                                    id="new-mapping-path"
                                    className="w-full bg-black/20 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:border-emerald-500/50 outline-none font-mono"
                                    placeholder="/Users/me/projects/my-app"
                                />
                            </div>
                            <button
                                onClick={() => {
                                    const patternInput = document.getElementById('new-mapping-pattern') as HTMLInputElement;
                                    const pathInput = document.getElementById('new-mapping-path') as HTMLInputElement;
                                    if (patternInput.value && pathInput.value) {
                                        setLocalConfig({
                                            ...localConfig,
                                            project_mappings: [
                                                ...(localConfig.project_mappings || []),
                                                { image_pattern: patternInput.value, local_path: pathInput.value }
                                            ]
                                        });
                                        patternInput.value = '';
                                        pathInput.value = '';
                                    }
                                }}
                                className="p-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg border border-emerald-500/30 transition-colors"
                            >
                                <Plus size={14} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* === SECTION 2: MEMORY SYSTEM === */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 shadow-xl relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 to-transparent pointer-events-none" />

                    <div className="flex items-center gap-2.5 mb-5 relative z-10">
                        <div className="p-1.5 bg-cyan-500/20 rounded-lg text-cyan-400">
                            <HardDrive size={18} />
                        </div>
                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">Memory System</h3>
                    </div>

                    <div className="space-y-6 relative z-10">
                        <p className="text-[11px] text-zinc-400">
                            Optional: Use Ollama for local embeddings to enable semantic search in the knowledge base.
                        </p>

                        {/* Embedding Provider Toggle */}
                        <div className="flex gap-2 p-1 bg-black/20 rounded-xl border border-white/5">
                            <button
                                onClick={() => {
                                    setEmbeddingMode('local');
                                    setLocalConfig(prev => ({ ...prev, embedding_endpoint: null }));
                                }}
                                className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-lg transition-all ${embeddingMode === 'local' ? 'bg-cyan-500/20 text-cyan-400 shadow-sm' : 'text-zinc-600 hover:text-zinc-400'
                                    }`}
                            >
                                <Server size={14} /> Local (Ollama)
                            </button>
                            <button
                                onClick={() => setEmbeddingMode('custom')}
                                className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-lg transition-all ${embeddingMode === 'custom' ? 'bg-cyan-500/20 text-cyan-400 shadow-sm' : 'text-zinc-600 hover:text-zinc-400'
                                    }`}
                            >
                                <Network size={14} /> Custom Endpoint
                            </button>
                        </div>

                        {/* Config Inputs */}
                        <div className="grid grid-cols-2 gap-4">
                            {embeddingMode === 'custom' && (
                                <div className="col-span-2">
                                    <label className="text-[10px] font-bold text-zinc-500 uppercase mb-1 block">Endpoint URL</label>
                                    <input
                                        type="text"
                                        value={localConfig.embedding_endpoint || ''}
                                        onChange={e => setLocalConfig({ ...localConfig, embedding_endpoint: e.target.value })}
                                        className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white focus:border-cyan-500/50 outline-none font-mono"
                                        placeholder="https://api.openai.com/v1"
                                    />
                                </div>
                            )}

                            <div className="col-span-2">
                                <label className="text-[10px] font-bold text-zinc-500 uppercase mb-1 block">Embedding Model</label>
                                <div className="relative">
                                    <input
                                        type="text"
                                        value={localConfig.embedding_model || 'nomic-embed-text'}
                                        onChange={e => setLocalConfig({ ...localConfig, embedding_model: e.target.value })}
                                        className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white focus:border-cyan-500/50 outline-none font-mono"
                                        placeholder="nomic-embed-text"
                                    />
                                    {embeddingMode === 'local' && (
                                        <div className="absolute right-3 top-2.5 flex items-center gap-2 group/status cursor-help">
                                            <StatusDot ok={embeddingStatus?.available} loading={checkingEmbedding || downloadingEmbedding} />
                                            <span className={`text-[10px] font-bold ${embeddingStatus?.available ? 'text-emerald-400' : 'text-zinc-500'}`}>
                                                {checkingEmbedding ? 'CHECK' : downloadingEmbedding ? `${downloadProgress}%` : embeddingStatus?.available ? 'READY' : 'MISSING'}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Download Prompt (Local Only) */}
                        {embeddingMode === 'local' && !embeddingStatus?.available && !checkingEmbedding && (
                            <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-4 flex items-center gap-4">
                                <AlertCircle size={20} className="text-cyan-400 shrink-0" />
                                <div className="flex-1">
                                    <h4 className="text-xs font-bold text-white">Model Missing</h4>
                                    <p className="text-[10px] text-zinc-400">Required for memory functions.</p>
                                </div>
                                <button
                                    onClick={pullEmbeddingModel}
                                    disabled={downloadingEmbedding}
                                    className="px-4 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 text-xs font-bold rounded-lg border border-cyan-500/20 flex items-center gap-2 transition-all disabled:opacity-50 whitespace-nowrap"
                                >
                                    <Download size={14} className={downloadingEmbedding ? "animate-bounce" : ""} />
                                    {downloadingEmbedding ? 'Pulling...' : 'Auto-Pull'}
                                </button>
                            </div>
                        )}

                        {/* KB Status */}
                        <div className="pt-4 border-t border-white/5">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                    <BookOpen size={14} className="text-fuchsia-400" />
                                    <span className="text-xs font-bold text-white uppercase">Knowledge Base</span>
                                </div>
                                <span className={`text-[10px] font-bold ${kbStatus?.available ? 'text-emerald-400' : 'text-zinc-500'}`}>
                                    {kbStatus?.available ? 'ACTIVE' : 'OFFLINE'}
                                </span>
                            </div>
                        </div>

                        {kbProgress ? (
                            <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl space-y-2">
                                <div className="flex justify-between text-[10px] items-center text-blue-200">
                                    <span className="font-bold flex items-center gap-1.5">
                                        <Loader2 size={10} className="animate-spin" />
                                        {kbProgress.message}
                                    </span>
                                    <span className="font-mono bg-blue-500/20 px-1.5 py-0.5 rounded text-blue-300">
                                        {kbProgress.current} / {kbProgress.total}
                                    </span>
                                </div>
                                <div className="h-1.5 bg-blue-900/50 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-blue-500 transition-all duration-300 ease-out"
                                        style={{ width: `${(kbProgress.current / kbProgress.total) * 100}%` }}
                                    />
                                </div>
                            </div>
                        ) : kbStatus?.available && (
                            <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-2">
                                <div className="flex justify-between text-[10px] items-center text-emerald-200">
                                    <span className="font-bold flex items-center gap-1.5">
                                        <CheckCircle2 size={10} className="text-emerald-400" />
                                        Knowledge Base Ready
                                    </span>
                                    <span className="font-mono bg-emerald-500/20 px-1.5 py-0.5 rounded text-emerald-300">
                                        {kbStatus.document_count} Docs
                                    </span>
                                </div>
                            </div>
                        )}

                        <div className="flex items-center gap-2">
                            <div className="flex-1 bg-white/5 rounded-lg p-2 border border-white/5 flex flex-col items-center">
                                <span className="text-[10px] text-zinc-500 uppercase font-bold">Docs</span>
                                <span className="text-sm font-bold text-white">{kbStatus?.document_count || 0}</span>
                            </div>
                            <div className="flex-1 bg-white/5 rounded-lg p-2 border border-white/5 flex flex-col items-center">
                                <span className="text-[10px] text-zinc-500 uppercase font-bold">Source</span>
                                <span className="text-[10px] font-bold text-zinc-400 truncate max-w-[80px]">{kbStatus?.source || '-'}</span>
                            </div>
                            <button
                                onClick={reindexKb}
                                disabled={reindexingKb || !embeddingStatus?.available}
                                className="flex-[2] py-2 bg-white/5 hover:bg-white/10 text-zinc-300 text-xs font-bold rounded-lg border border-white/10 flex items-center justify-center gap-2 transition-all disabled:opacity-50 h-[54px]"
                            >
                                <RefreshCw size={16} className={reindexingKb ? "animate-spin" : ""} />
                                {reindexingKb ? 'Re-Indexing...' : 'Re-Index Data'}
                            </button>
                        </div>
                        {kbMessage && (
                            <div className="text-[10px] text-center text-zinc-500 animate-pulse mt-2">{kbMessage}</div>
                        )}
                    </div>
                </div>
            </div >

            {/* Footer Actions */}
            <div className="p-6 border-t border-white/5 bg-black/20 backdrop-blur-3xl">
                <button onClick={handleSave} className="w-full py-3 bg-white text-black text-xs font-bold rounded-xl hover:bg-zinc-200 transition-colors shadow-[0_0_20px_rgba(255,255,255,0.1)] flex items-center justify-center gap-2">
                    Save Configuration <ArrowRight size={16} />
                </button>
            </div>
        </div >
    );
}
