
import { useState, useEffect } from 'react';
import { X, Eye, EyeOff, BookOpen, HardDrive, RefreshCw, Server, Network, ArrowRight, Info, ShieldCheck, Loader2, CheckCircle2, Github, Download, AlertCircle, Terminal, Check, Search, FileJson, Settings2, FileCode, Plus, Trash2, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';
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

    // KB State
    const [kbStatus, setKbStatus] = useState<KBEmbeddingsStatus | null>(null);
    const [reindexingKb, setReindexingKb] = useState(false);
    const [kbMessage, setKbMessage] = useState<string | null>(null);
    const [kbDirInfo, setKbDirInfo] = useState<{ path: string; exists: boolean; has_files: boolean; file_count: number; initialized: boolean } | null>(null);
    const [initializingKb, setInitializingKb] = useState(false);

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

    const checkClaudeCodeStatus = async (retries = 3) => {
        setCheckingClaudeCode(true);

        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const resp = await fetch(`${AGENT_SERVER_URL}/llm/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider: 'claude-code' })
                });

                // Always try to parse JSON, even on error, to get the message
                const data = await resp.json().catch(() => ({}));

                if (resp.ok) {
                    setClaudeCodeStatus({ connected: data.connected, error: data.error });
                    setCheckingClaudeCode(false);
                    return;
                } else {
                    // If server returned an explicit error (4xx/5xx), STOP retrying and show it
                    const errorMessage = data.detail || data.error || `Server Error ${resp.status}`;
                    console.error("Claude Code check failed:", errorMessage);
                    setClaudeCodeStatus({ connected: false, error: errorMessage });
                    setCheckingClaudeCode(false);
                    return;
                }
            } catch (e: any) {
                // Only retry on network errors (fetch failed entirely)
                console.warn(`Claude Code check attempt ${attempt + 1} failed:`, e);

                if (attempt === retries - 1) {
                    setClaudeCodeStatus({ connected: false, error: `Connection failed: ${e.message || 'Agent unreachable'}` });
                } else {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
            }
        }
        setCheckingClaudeCode(false);
    };

    const checkCodexStatus = async (retries = 3) => {
        setCheckingCodex(true);
        // Similar logic for Codex if needed, but keeping simple for now to focus on Claude
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
            setCodexStatus({ connected: false, error: 'Agent unreachable' });
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

    // --- KB DIRECTORY LOGIC ---

    const checkKbDirectory = async () => {
        try {
            const info = await invoke<{ path: string; exists: boolean; has_files: boolean; file_count: number; initialized: boolean }>('get_kb_directory_info');
            setKbDirInfo(info);
        } catch (e) {
            console.error("Failed to check KB directory:", e);
        }
    };

    const initializeKbDirectory = async () => {
        setInitializingKb(true);
        try {
            const info = await invoke<{ path: string; exists: boolean; has_files: boolean; file_count: number; initialized: boolean }>('init_kb_directory');
            setKbDirInfo(info);
            setKbMessage("Knowledge base initialized with sample entries!");
        } catch (e) {
            setKbMessage("Failed to initialize: " + e);
        }
        setInitializingKb(false);
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
        checkKbDirectory();
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

    // Helper to determine if error is actionable
    const isAuthError = (err?: string) => {
        if (!err) return false;
        const lower = err.toLowerCase();
        return lower.includes('login') || lower.includes('auth') || lower.includes('keyring') || lower.includes('broken pipe');
    };

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
                                <strong className="text-indigo-300">[TIP] Tip:</strong> Set <code className="bg-black/30 px-1 rounded">OPSPILOT_AGENT_URL</code> environment variable or create <code className="bg-black/30 px-1 rounded">~/.opspilot.json</code> for zero-config setup across machines.
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
                            <div className="space-y-3">
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
                                            {checkingClaudeCode ? 'Checking Connection...' :
                                                claudeCodeStatus?.connected ? 'Claude Code Ready' :
                                                    'Connection Failed'}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => checkClaudeCodeStatus()}
                                        disabled={checkingClaudeCode}
                                        className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/5 rounded px-2 py-1 text-zinc-400 transition-colors disabled:opacity-50"
                                    >
                                        Retry
                                    </button>
                                </div>

                                {/* ERROR ALERT - PROMINENT DISPLAY */}
                                {claudeCodeStatus?.error && !checkingClaudeCode && (
                                    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 animate-in fade-in slide-in-from-top-2">
                                        <div className="flex gap-3">
                                            <AlertCircle className="text-red-400 shrink-0 mt-0.5" size={16} />
                                            <div className="space-y-2 flex-1">
                                                <h4 className="text-xs font-bold text-red-400 uppercase tracking-wide">Agent Error</h4>
                                                <div className="text-[11px] text-zinc-300 font-mono bg-black/30 p-2 rounded border border-white/5 whitespace-pre-wrap break-words">
                                                    {claudeCodeStatus.error}
                                                </div>

                                                {/* Actionable Hint for Auth/Keyring */}
                                                {isAuthError(claudeCodeStatus.error) && (
                                                    <div className="mt-2 pt-2 border-t border-red-500/20">
                                                        <div className="flex items-center gap-2 text-amber-400 text-[11px] font-bold mb-1">
                                                            <ShieldCheck size={12} />
                                                            ACTION REQUIRED
                                                        </div>
                                                        <p className="text-[11px] text-zinc-400 mb-2">
                                                            The agent cannot access the keychain. Run this in your terminal:
                                                        </p>
                                                        <div className="flex items-center gap-2 bg-black/40 rounded px-2 py-1.5 border border-white/10 group cursor-pointer hover:border-white/30 transition-colors"
                                                            onClick={() => {
                                                                navigator.clipboard.writeText('claude login');
                                                                // You could trigger a toast here
                                                            }}>
                                                            <code className="text-[11px] text-emerald-300 font-mono flex-1">claude login</code>
                                                            <div className="text-[10px] text-zinc-500 uppercase font-bold group-hover:text-zinc-300">Copy</div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
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
                                    onClick={() => checkCodexStatus()}
                                    disabled={checkingCodex}
                                    className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/5 rounded px-2 py-1 text-zinc-400 transition-colors disabled:opacity-50"
                                >
                                    Test
                                </button>
                            </div>
                        )}

                        {/* General Setup Instructions (Only show if generic failure and no specific error displayed) */}
                        {((localConfig.provider === 'claude-code' && !claudeCodeStatus?.connected && !checkingClaudeCode && !claudeCodeStatus?.error) ||
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

                {/* === SECTION 1.5: GITHUB INTEGRATION === */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 shadow-xl relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-gray-500/5 to-transparent pointer-events-none" />

                    <div className="flex items-center justify-between mb-4 relative z-10">
                        <div className="flex items-center gap-2.5">
                            <div className="p-1.5 bg-gray-500/20 rounded-lg text-gray-300">
                                <Github size={18} />
                            </div>
                            <h3 className="text-sm font-bold text-white uppercase tracking-wider">GitHub Integration</h3>
                        </div>
                        {githubConfigured && (
                            <div className="flex items-center gap-2">
                                <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded-lg">
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                    <span className="text-[10px] font-bold text-emerald-400">Connected</span>
                                </div>
                                <button
                                    onClick={handleDisconnectGithub}
                                    className="p-1.5 hover:bg-white/10 text-zinc-500 hover:text-white rounded-lg transition-colors"
                                    title="Disconnect"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        )}
                    </div>

                    {!githubConfigured ? (
                        <div className="space-y-4 relative z-10">
                            <p className="text-[11px] text-zinc-400">
                                Connect GitHub to allow the agent to search your repositories for context.
                            </p>
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={githubPat}
                                    onChange={(e) => setGithubPat(e.target.value)}
                                    placeholder="GitHub Personal Access Token (classic)..."
                                    className="flex-1 bg-black/20 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:border-gray-500/50 outline-none font-mono"
                                />
                                <button
                                    onClick={() => testGithubConnection()}
                                    disabled={testingGithub || !githubPat}
                                    className="px-4 py-2 bg-white text-black text-xs font-bold rounded-xl hover:bg-zinc-200 transition-colors disabled:opacity-50 flex items-center gap-2"
                                >
                                    {testingGithub ? <Loader2 size={14} className="animate-spin" /> : <Network size={14} />}
                                    Connect
                                </button>
                            </div>
                            <div className="text-[10px] text-zinc-500">
                                Note: Token requires <code className="bg-white/10 px-1 rounded text-zinc-300">repo</code> scope.
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4 relative z-10">
                            {/* User Info */}
                            {githubUser && (
                                <div className="flex items-center gap-3 p-3 bg-black/20 rounded-xl border border-white/5">
                                    <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-xs font-bold ring-2 ring-white/10">
                                        {githubUser.substring(0, 2).toUpperCase()}
                                    </div>
                                    <div className="flex-1">
                                        <div className="text-xs font-bold text-white">Logged in as {githubUser}</div>
                                        <div className="text-[10px] text-zinc-500">
                                            {githubGroups.length} organizations accessible
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Search Mode Selection - Primary Choice */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-zinc-400 uppercase block">Search Mode</label>

                                {/* Option 1: Global Search (Recommended) */}
                                <button
                                    onClick={() => setSearchAllRepos(true)}
                                    className={`w-full p-3 rounded-xl border-2 transition-all text-left ${
                                        searchAllRepos
                                            ? 'bg-violet-500/10 border-violet-500/50'
                                            : 'bg-black/20 border-white/10 hover:border-white/20'
                                    }`}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                                            searchAllRepos ? 'border-violet-500 bg-violet-500' : 'border-zinc-600'
                                        }`}>
                                            {searchAllRepos && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                                        </div>
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className={`text-[11px] font-bold ${searchAllRepos ? 'text-violet-300' : 'text-zinc-400'}`}>
                                                    🌐 Search All Accessible Repos
                                                </span>
                                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 font-medium">Recommended</span>
                                            </div>
                                            <p className="text-[10px] text-zinc-500 mt-1">
                                                Agent searches across ALL repositories your GitHub token can access. Best for discovering code anywhere in your organization.
                                            </p>
                                        </div>
                                    </div>
                                </button>

                                {/* Option 2: Selected Repos Only */}
                                <button
                                    onClick={() => setSearchAllRepos(false)}
                                    className={`w-full p-3 rounded-xl border-2 transition-all text-left ${
                                        !searchAllRepos
                                            ? 'bg-emerald-500/10 border-emerald-500/50'
                                            : 'bg-black/20 border-white/10 hover:border-white/20'
                                    }`}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                                            !searchAllRepos ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-600'
                                        }`}>
                                            {!searchAllRepos && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                                        </div>
                                        <div className="flex-1">
                                            <span className={`text-[11px] font-bold ${!searchAllRepos ? 'text-emerald-300' : 'text-zinc-400'}`}>
                                                📁 Search Selected Repos Only
                                            </span>
                                            <p className="text-[10px] text-zinc-500 mt-1">
                                                Agent only searches the specific repositories you select below. Use this for focused searches in known repos.
                                            </p>
                                        </div>
                                    </div>
                                </button>
                            </div>

                            {/* Selected Repos Section - Only shown when using Selected Repos mode, or as hints for Global mode */}
                            <div className={`rounded-xl border overflow-hidden transition-all ${
                                !searchAllRepos
                                    ? 'border-emerald-500/30 bg-emerald-500/5'
                                    : 'border-white/10 bg-black/10 opacity-60'
                            }`}>
                                <div className="p-3 border-b border-white/5">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <span className={`text-[10px] font-bold uppercase ${!searchAllRepos ? 'text-emerald-400' : 'text-zinc-500'}`}>
                                                {!searchAllRepos ? 'Repositories to Search' : 'Hint Repos (Optional)'}
                                            </span>
                                            {searchAllRepos && (
                                                <p className="text-[9px] text-zinc-600 mt-0.5">These help guide the agent but global search is active</p>
                                            )}
                                        </div>
                                        {githubRepos.length > 0 && (
                                            <button
                                                onClick={() => setGithubRepos([])}
                                                className="text-[9px] text-zinc-500 hover:text-red-400 transition-colors"
                                            >
                                                Clear all
                                            </button>
                                        )}
                                    </div>

                                    {/* Selected repos chips */}
                                    {githubRepos.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5 mt-2">
                                            {githubRepos.map(repo => (
                                                <div
                                                    key={repo}
                                                    className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg ${
                                                        !searchAllRepos
                                                            ? 'bg-emerald-500/10 border border-emerald-500/20'
                                                            : 'bg-white/5 border border-white/10'
                                                    }`}
                                                >
                                                    <Github size={10} className={!searchAllRepos ? 'text-emerald-400' : 'text-zinc-500'} />
                                                    <span className={`text-[10px] font-medium ${!searchAllRepos ? 'text-emerald-300' : 'text-zinc-400'}`}>{repo}</span>
                                                    <button
                                                        onClick={() => setGithubRepos(githubRepos.filter(r => r !== repo))}
                                                        className="text-zinc-600 hover:text-red-400 transition-colors ml-0.5"
                                                    >
                                                        <X size={10} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {githubRepos.length === 0 && !searchAllRepos && (
                                        <p className="text-[10px] text-amber-400/80 mt-2 flex items-center gap-1">
                                            <AlertCircle size={10} />
                                            Select at least one repository to search
                                        </p>
                                    )}
                                </div>

                                {/* Org Selector */}
                                <div className="p-3 border-b border-white/5">
                                    <label className="text-[9px] font-bold text-zinc-500 uppercase mb-1.5 block">Browse by Organization</label>
                                    <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
                                        {loadingGroups ? (
                                            <div className="text-[10px] text-zinc-500 animate-pulse">Loading orgs...</div>
                                        ) : (
                                            githubGroups.map(group => (
                                                <button
                                                    key={group.id}
                                                    onClick={() => setSelectedGroup(group.id)}
                                                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-all shrink-0 ${selectedGroup === group.id
                                                        ? 'bg-white/10 border-white/30 text-white'
                                                        : 'bg-black/20 border-white/5 text-zinc-400 hover:bg-white/5'
                                                        }`}
                                                >
                                                    {group.avatar_url && (
                                                        <img src={group.avatar_url} alt="" className="w-4 h-4 rounded-full" />
                                                    )}
                                                    <span className="text-[10px] truncate">{group.name}</span>
                                                </button>
                                            ))
                                        )}
                                    </div>
                                </div>

                                {/* Repo Search & Selection */}
                                <div className="p-2 border-b border-white/5">
                                    <div className="relative">
                                        <Search size={12} className="absolute left-2.5 top-2 text-zinc-500" />
                                        <input
                                            type="text"
                                            value={repoSearch}
                                            onChange={(e) => setRepoSearch(e.target.value)}
                                            placeholder="Filter repositories..."
                                            className="w-full bg-black/20 rounded-lg pl-8 pr-3 py-1.5 text-[11px] text-white focus:outline-none focus:bg-black/40 transition-colors placeholder:text-zinc-600"
                                        />
                                    </div>
                                </div>
                                <div className="max-h-[140px] overflow-y-auto custom-scrollbar p-1">
                                    {loadingRepos ? (
                                        <div className="p-4 text-center">
                                            <Loader2 size={16} className="animate-spin mx-auto text-zinc-500 mb-2" />
                                            <div className="text-[10px] text-zinc-500">Loading repositories...</div>
                                        </div>
                                    ) : filteredRepos.length === 0 ? (
                                        <div className="p-4 text-center text-[10px] text-zinc-500 italic">
                                            {repoSearch ? `No repos matching "${repoSearch}"` : 'Select an organization above'}
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                                            {filteredRepos.map(repo => {
                                                const isSelected = githubRepos.includes(repo);
                                                return (
                                                    <button
                                                        key={repo}
                                                        onClick={() => {
                                                            if (isSelected) {
                                                                setGithubRepos(githubRepos.filter(r => r !== repo));
                                                            } else {
                                                                setGithubRepos([...githubRepos, repo]);
                                                            }
                                                        }}
                                                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all text-left ${isSelected
                                                            ? 'bg-emerald-500/10 text-emerald-300'
                                                            : 'hover:bg-white/5 text-zinc-400'
                                                            }`}
                                                    >
                                                        <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${isSelected
                                                            ? 'bg-emerald-500 border-emerald-500'
                                                            : 'border-zinc-600'
                                                            }`}>
                                                            {isSelected && <Check size={9} className="text-black" />}
                                                        </div>
                                                        <span className="text-[11px] truncate flex-1">{repo.split('/')[1]}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                                {/* Footer */}
                                <div className="px-3 py-2 bg-white/5 border-t border-white/5 flex items-center justify-between">
                                    <span className="text-[9px] text-zinc-500">
                                        {availableRepos.length} repos in {selectedGroup || 'organization'}
                                    </span>
                                    {filteredRepos.length > 0 && (
                                        <button
                                            onClick={() => {
                                                const newRepos = filteredRepos.filter(r => !githubRepos.includes(r));
                                                setGithubRepos([...githubRepos, ...newRepos]);
                                            }}
                                            className="text-[9px] text-violet-400 hover:text-violet-300 transition-colors"
                                        >
                                            + Add all visible
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
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
                                            <StatusDot ok={embeddingStatus?.available} loading={checkingEmbedding} />
                                            <span className={`text-[10px] font-bold ${embeddingStatus?.available ? 'text-emerald-400' : 'text-zinc-500'}`}>
                                                {checkingEmbedding ? 'CHECK' : embeddingStatus?.available ? 'READY' : 'MISSING'}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Download Prompt (Local Only) */}
                        {embeddingMode === 'local' && !embeddingStatus?.available && !checkingEmbedding && (
                            <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-4 space-y-3">
                                <div className="flex items-center gap-4">
                                    <AlertCircle size={20} className="text-cyan-400 shrink-0" />
                                    <div className="flex-1">
                                        <h4 className="text-xs font-bold text-white">
                                            {embeddingStatus?.ollama_connected === true ? 'Model Missing' : 'Ollama Not Running'}
                                        </h4>
                                        <p className="text-[10px] text-zinc-400">
                                            {embeddingStatus?.ollama_connected === true
                                                ? 'Required for memory functions.'
                                                : 'Install and run Ollama to use local embeddings.'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={checkEmbeddingStatus}
                                        disabled={checkingEmbedding}
                                        className="p-2 bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white rounded-lg border border-white/10 transition-all disabled:opacity-50"
                                        title="Refresh status"
                                    >
                                        <RefreshCw size={14} className={checkingEmbedding ? "animate-spin" : ""} />
                                    </button>
                                </div>
                                {embeddingStatus?.ollama_connected !== true ? (
                                    <div className="bg-black/20 rounded-lg p-3 border border-white/5">
                                        <p className="text-[10px] text-zinc-500 mb-2">Install Ollama:</p>
                                        <code className="text-[10px] font-mono text-cyan-300 block">
                                            {navigator.platform.toLowerCase().includes('mac')
                                                ? 'brew install ollama && ollama serve'
                                                : navigator.platform.toLowerCase().includes('win')
                                                    ? 'winget install Ollama.Ollama'
                                                    : 'curl -fsSL https://ollama.com/install.sh | sh && ollama serve'}
                                        </code>
                                        <div className="flex items-center justify-between mt-2">
                                            <a
                                                href="https://ollama.com/download"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[10px] text-cyan-400 hover:text-cyan-300"
                                            >
                                                Or download from ollama.com →
                                            </a>
                                            <span className="text-[9px] text-zinc-600">Click refresh after installing</span>
                                        </div>
                                    </div>
                                ) : embeddingStatus?.available !== true && (
                                    <div className="bg-black/20 rounded-lg p-3 border border-white/5">
                                        <p className="text-[10px] text-zinc-500 mb-2">Pull embedding model:</p>
                                        <code className="text-[10px] font-mono text-cyan-300 block">
                                            ollama pull nomic-embed-text
                                        </code>
                                        <div className="flex items-center justify-between mt-2">
                                            <a
                                                href="https://ollama.com/library/nomic-embed-text"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[10px] text-cyan-400 hover:text-cyan-300"
                                            >
                                                View model on ollama.com →
                                            </a>
                                            <span className="text-[9px] text-zinc-600">Click refresh after pulling</span>
                                        </div>
                                    </div>
                                )}
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

                            {/* KB Explanation */}
                            <div className="bg-fuchsia-500/5 border border-fuchsia-500/20 rounded-xl p-4 mb-4 space-y-3">
                                <div className="flex items-start gap-2">
                                    <Info size={14} className="text-fuchsia-400 mt-0.5 shrink-0" />
                                    <div className="text-[11px] text-zinc-300 leading-relaxed">
                                        <strong className="text-fuchsia-300">What is the Knowledge Base?</strong>
                                        <p className="mt-1 text-zinc-400">
                                            OpsPilot comes with <strong className="text-white">57+ built-in troubleshooting patterns</strong> for Kubernetes issues (CrashLoopBackOff, OOMKilled, ImagePullBackOff, etc.). Additionally, it auto-discovers CRDs from your cluster at runtime.
                                        </p>
                                    </div>
                                </div>

                                <div className="border-t border-fuchsia-500/10 pt-3 space-y-2">
                                    <div className="text-[10px] font-bold text-fuchsia-300 uppercase">Document Sources:</div>
                                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                                        <div className="bg-black/20 rounded-lg p-2 border border-white/5">
                                            <div className="text-zinc-300 font-medium">Built-in Patterns</div>
                                            <div className="text-zinc-500">Pre-bundled K8s troubleshooting guides</div>
                                        </div>
                                        <div className="bg-black/20 rounded-lg p-2 border border-white/5">
                                            <div className="text-zinc-300 font-medium">Cluster CRDs</div>
                                            <div className="text-zinc-500">Auto-discovered from your cluster</div>
                                        </div>
                                        <div className="bg-black/20 rounded-lg p-2 border border-white/5">
                                            <div className="text-zinc-300 font-medium">GitHub Repos</div>
                                            <div className="text-zinc-500">Indexed from configured repos</div>
                                        </div>
                                        <div className="bg-black/20 rounded-lg p-2 border border-white/5">
                                            <div className="text-zinc-300 font-medium">Custom Entries</div>
                                            <div className="text-zinc-500">Your own .jsonl files</div>
                                        </div>
                                    </div>
                                </div>

                                <div className="border-t border-fuchsia-500/10 pt-3">
                                    <div className="text-[10px] font-bold text-fuchsia-300 uppercase mb-2">Add Custom Knowledge:</div>
                                    <div className="text-[10px] text-zinc-400 space-y-1.5">
                                        <div className="flex items-start gap-1.5">
                                            <span className="text-fuchsia-400">1.</span>
                                            <span>Create <code className="bg-black/30 px-1 rounded font-mono text-fuchsia-200">~/.opspilot/knowledge/</code> directory</span>
                                        </div>
                                        <div className="flex items-start gap-1.5">
                                            <span className="text-fuchsia-400">2.</span>
                                            <span>Add <code className="bg-black/30 px-1 rounded font-mono text-fuchsia-200">.jsonl</code> files with your patterns</span>
                                        </div>
                                        <div className="flex items-start gap-1.5">
                                            <span className="text-fuchsia-400">3.</span>
                                            <span>Click "Re-Index Data" to include them</span>
                                        </div>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            try {
                                                const { openUrl } = await import('@tauri-apps/plugin-opener');
                                                await openUrl('https://github.com/ankitjain-wiz/opspilot/blob/main/docs/knowledge-base.md');
                                            } catch {
                                                // Fallback: use window.open
                                                window.open('https://github.com/ankitjain-wiz/opspilot/blob/main/docs/knowledge-base.md', '_blank');
                                            }
                                        }}
                                        className="inline-flex items-center gap-1.5 mt-2 text-[10px] text-fuchsia-400 hover:text-fuchsia-300 transition-colors"
                                    >
                                        <BookOpen size={10} />
                                        View full documentation
                                        <ArrowRight size={10} />
                                    </button>
                                </div>
                            </div>

                            {/* Custom KB Directory Status */}
                            <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <FolderOpen size={14} className="text-amber-400" />
                                        <span className="text-[10px] font-bold text-zinc-300 uppercase">Your Custom Entries</span>
                                    </div>
                                    {kbDirInfo?.initialized && (
                                        <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                                            INITIALIZED
                                        </span>
                                    )}
                                </div>

                                {kbDirInfo ? (
                                    <div className="space-y-3">
                                        <div className="text-[10px] font-mono text-zinc-500 bg-black/30 px-2 py-1.5 rounded border border-white/5 truncate" title={kbDirInfo.path}>
                                            {kbDirInfo.path}
                                        </div>

                                        {kbDirInfo.initialized ? (
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <div className="flex items-center gap-1.5">
                                                        <FileJson size={12} className="text-amber-400" />
                                                        <span className="text-[10px] text-zinc-400">
                                                            <strong className="text-white">{kbDirInfo.file_count}</strong> custom file{kbDirInfo.file_count !== 1 ? 's' : ''}
                                                        </span>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={async () => {
                                                        try {
                                                            // Detect platform and use appropriate command
                                                            const platform = navigator.platform.toLowerCase();
                                                            let cmd;
                                                            if (platform.includes('mac') || platform.includes('darwin')) {
                                                                cmd = Command.create('open', [kbDirInfo.path]);
                                                            } else if (platform.includes('win')) {
                                                                cmd = Command.create('explorer', [kbDirInfo.path]);
                                                            } else {
                                                                // Linux
                                                                cmd = Command.create('xdg-open', [kbDirInfo.path]);
                                                            }
                                                            await cmd.execute();
                                                        } catch (err) {
                                                            console.error("Failed to open folder:", err);
                                                            // Fallback: copy path to clipboard
                                                            navigator.clipboard.writeText(kbDirInfo.path);
                                                            setKbMessage("Path copied to clipboard");
                                                        }
                                                    }}
                                                    className="text-[9px] text-zinc-500 hover:text-zinc-300 bg-white/5 hover:bg-white/10 px-2 py-1 rounded transition-colors"
                                                >
                                                    Open Folder
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="flex items-center justify-between">
                                                <span className="text-[10px] text-zinc-500">
                                                    No custom entries yet
                                                </span>
                                                <button
                                                    onClick={initializeKbDirectory}
                                                    disabled={initializingKb}
                                                    className="flex items-center gap-1.5 text-[10px] font-bold text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1.5 rounded-lg border border-amber-500/20 transition-colors disabled:opacity-50"
                                                >
                                                    {initializingKb ? (
                                                        <>
                                                            <Loader2 size={10} className="animate-spin" />
                                                            Initializing...
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Plus size={10} />
                                                            Initialize with Examples
                                                        </>
                                                    )}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="text-[10px] text-zinc-600 animate-pulse">Checking...</div>
                                )}
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
