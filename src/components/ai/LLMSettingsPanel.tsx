
import { useState, useEffect } from 'react';
import { X, Eye, EyeOff, BookOpen, HardDrive, RefreshCw, Server, Network, ArrowRight, Info, ShieldCheck, Loader2, CheckCircle2, Github, Download, AlertCircle, Terminal, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { LLMConfig } from '../../types/ai';
import { DEFAULT_LLM_CONFIG } from './constants';
import { KBProgress } from './useSentinel';

const AGENT_SERVER_URL = 'http://127.0.0.1:8765';

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
    const [githubUser, setGithubUser] = useState<string | null>(null);
    const [testingGithub, setTestingGithub] = useState(false);

    // --- ACTIONS ---

    const handleSave = async () => {
        const configToSave = {
            ...localConfig,
            // provider is now managed in localConfig
            embedding_endpoint: embeddingMode === 'local' ? null : localConfig.embedding_endpoint
        };

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
                    default_repos: githubRepos
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

    // --- EFFECTS ---

    useEffect(() => {
        checkClaudeCodeStatus();
        checkCodexStatus();
        checkEmbeddingStatus();
        checkKbStatus();
        loadGithubConfig();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (embeddingStatus?.available) checkKbStatus();
    }, [embeddingStatus?.available]);

    // Auto-detect coding agent provider
    useEffect(() => {
        // Wait for both status checks to complete (they start as null)
        if (!claudeCodeStatus || !codexStatus) return;

        // Logic: If current provider is NOT connected, but the other ONE IS, switch to it.
        // This helps users who only have one installed.
        if (localConfig.provider === 'claude-code') {
            if (!claudeCodeStatus.connected && codexStatus.connected) {
                console.log("Auto-switching to Codex CLI (Claude not found)");
                setLocalConfig(prev => ({ ...prev, provider: 'codex-cli' }));
            }
        } else if (localConfig.provider === 'codex-cli') {
            if (!codexStatus.connected && claudeCodeStatus.connected) {
                console.log("Auto-switching to Claude Code (Codex not found)");
                setLocalConfig(prev => ({ ...prev, provider: 'claude-code' }));
            }
        }
    }, [claudeCodeStatus?.connected, codexStatus?.connected, localConfig.provider]);

    // RENDER HELPERS

    const StatusDot = ({ ok, loading }: { ok?: boolean, loading?: boolean }) => (
        <div className={`relative w-2 h-2 rounded-full ${loading ? 'bg-amber-400' :
            ok ? 'bg-emerald-400' : 'bg-red-400/80'
            }`}>
            {loading && <div className="absolute inset-0 bg-amber-400 rounded-full animate-ping" />}
            {ok && !loading && <div className="absolute inset-0 bg-emerald-400 rounded-full animate-pulse opacity-50" />}
        </div>
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
                        <X size={20} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">

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

                {/* === SECTION 2: GITHUB INTEGRATION === */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 shadow-xl relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 to-transparent pointer-events-none" />

                    <div className="flex items-center gap-2.5 mb-5 relative z-10">
                        <div className="p-1.5 bg-purple-500/20 rounded-lg text-purple-400">
                            <Github size={18} />
                        </div>
                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">GitHub Integration</h3>
                        {githubConfigured && (
                            <span className="ml-auto text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-bold">
                                CONNECTED
                            </span>
                        )}
                    </div>

                    <div className="space-y-4 relative z-10">
                        <p className="text-[11px] text-zinc-400">
                            Connect GitHub to let AI search your source code when debugging K8s issues.
                            The AI can find bugs, check recent changes, and correlate errors with code.
                        </p>

                        {/* PAT Token Input with Test Button */}
                        <div className="relative">
                            <label className="absolute -top-2 left-2 px-1 bg-[#18181b] text-[10px] font-bold text-zinc-500 uppercase z-20 flex items-center gap-1">
                                {githubConfigured && !githubPat ? 'Token Saved' : 'Personal Access Token'} <ShieldCheck size={9} className="text-emerald-500" />
                            </label>
                            {githubConfigured && !githubPat ? (
                                <div className="flex gap-2">
                                    <div className="flex-1 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 text-xs text-emerald-300 font-mono flex items-center justify-between">
                                        <span>••••••••••••••••••••</span>
                                        <button
                                            onClick={() => setGithubPat('replace')}
                                            className="text-[10px] text-purple-400 hover:text-purple-300 underline"
                                        >
                                            Replace
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => testGithubConnection()}
                                        disabled={testingGithub}
                                        className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs text-zinc-400 hover:text-white transition-colors disabled:opacity-50 flex items-center gap-2 whitespace-nowrap"
                                    >
                                        {testingGithub ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                                        Test
                                    </button>
                                </div>
                            ) : (
                                <div className="flex gap-2">
                                    <div className="relative flex-1">
                                        <input
                                            type={showGithubPat ? "text" : "password"}
                                            value={githubPat === 'replace' ? '' : githubPat}
                                            onChange={e => setGithubPat(e.target.value)}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-xs text-white placeholder-zinc-700 focus:border-purple-500/50 outline-none font-mono transition-all"
                                            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx or github_pat_..."
                                        />
                                        <button
                                            onClick={() => setShowGithubPat(!showGithubPat)}
                                            className="absolute right-3 top-3 text-zinc-600 hover:text-zinc-300"
                                        >
                                            {showGithubPat ? <EyeOff size={14} /> : <Eye size={14} />}
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => testGithubConnection()}
                                        disabled={testingGithub || (!githubPat || githubPat === 'replace')}
                                        className="px-4 py-2 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/30 rounded-xl text-xs text-purple-300 hover:text-white transition-colors disabled:opacity-50 flex items-center gap-2 whitespace-nowrap"
                                    >
                                        {testingGithub ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                                        Test
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Token Creation Guide */}
                        <div className="text-[10px] text-zinc-500 bg-white/5 px-3 py-2.5 rounded-lg space-y-1.5">
                            <div className="flex items-center gap-2">
                                <ShieldCheck size={10} className="text-emerald-500 shrink-0" />
                                <span className="font-bold text-zinc-400">Use a Fine-Grained Token (read-only)</span>
                            </div>
                            <div className="pl-4 space-y-1">
                                <div>1. <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:underline">Create fine-grained token</a></div>
                                <div>2. Set <code className="bg-white/10 px-1 rounded text-emerald-300">Contents</code> to Read-only</div>
                                <div>3. Select repos or "All repositories"</div>
                            </div>
                        </div>

                        {/* Default Repos */}
                        <div>
                            <label className="text-[10px] font-bold text-zinc-500 uppercase mb-1 block">
                                Default Repos to Search (optional)
                            </label>
                            <input
                                type="text"
                                value={githubRepos.join(", ")}
                                onChange={e => setGithubRepos(e.target.value.split(",").map(s => s.trim()).filter(Boolean))}
                                className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-zinc-700 focus:border-purple-500/50 outline-none font-mono"
                                placeholder="myorg/auth-service, myorg/api-gateway"
                            />
                            <p className="text-[10px] text-zinc-600 mt-1">
                                Comma-separated list of repos. Leave empty to search all accessible repos.
                            </p>
                        </div>

                        {/* Connection Status & Save */}
                        <div className={`p-3 rounded-xl border flex items-center gap-3 transition-all ${testingGithub ? 'bg-amber-500/5 border-amber-500/20' :
                            githubConfigured ? 'bg-emerald-500/5 border-emerald-500/20' :
                                'bg-zinc-500/5 border-zinc-500/20'
                            }`}>
                            <StatusDot ok={githubConfigured} loading={testingGithub} />
                            <div className="flex-1">
                                <div className={`text-xs font-bold ${testingGithub ? 'text-amber-400' :
                                    githubConfigured ? 'text-emerald-400' :
                                        'text-zinc-500'
                                    }`}>
                                    {testingGithub ? 'Testing Connection...' :
                                        githubConfigured ? `Connected as @${githubUser}` :
                                            'Not Connected'}
                                </div>
                            </div>
                            {githubPat && githubPat !== 'replace' && (
                                <button
                                    onClick={saveGithubConfig}
                                    className="text-[10px] bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/30 rounded px-3 py-1.5 transition-colors font-bold"
                                >
                                    Save Token
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* === SECTION 3: MEMORY SYSTEM === */}
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
            </div>

            {/* Footer Actions */}
            <div className="p-6 border-t border-white/5 bg-black/20 backdrop-blur-3xl">
                <button onClick={handleSave} className="w-full py-3 bg-white text-black text-xs font-bold rounded-xl hover:bg-zinc-200 transition-colors shadow-[0_0_20px_rgba(255,255,255,0.1)] flex items-center justify-center gap-2">
                    Save Configuration <ArrowRight size={16} />
                </button>
            </div>
        </div>
    );
}
