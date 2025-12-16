
import { useState, useEffect } from 'react';
import { Settings, X, Check, Eye, EyeOff, Copy, AlertCircle, Terminal, Download, Zap, BookOpen, Brain, Network, HardDrive, RefreshCw, Server, ArrowRight, Info, ShieldCheck, Activity, Cpu, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { LLMConfig, LLMStatus, LLMProvider } from '../../types/ai';
import { DEFAULT_LLM_CONFIGS } from './constants';
import { KBProgress } from './useSentinel';
import openAiLogo from '../../assets/openai-logo.png';
import anthropicLogo from '../../assets/anthropic-logo.png';
import ollamaLogo from '../../assets/ollama-logo.png';

const AGENT_SERVER_URL = 'http://127.0.0.1:8765';

type ProviderGroup = 'openai' | 'anthropic' | 'local' | 'groq';

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
    available: boolean;
    version: string | null;
    error: string | null;
}

export function LLMSettingsPanel({
    config,
    onConfigChange,
    onClose,
    systemSpecs,
    kbProgress
}: {
    config: LLMConfig;
    onConfigChange: (config: LLMConfig) => void;
    onClose: () => void;
    systemSpecs: { cpu_brand: string; total_memory: number; is_apple_silicon: boolean; } | null;
    kbProgress?: KBProgress | null;
}) {
    // --- STATE ---
    const [localConfig, setLocalConfig] = useState<LLMConfig>(config);

    // Inference State
    const [inferenceStatus, setInferenceStatus] = useState<LLMStatus | null>(null);
    const [checkingInference, setCheckingInference] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);

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
    const [reindexingProgress, setReindexingProgress] = useState<number | null>(null);
    const [kbMessage, setKbMessage] = useState<string | null>(null);

    // Claude Code State
    const [claudeCodeStatus, setClaudeCodeStatus] = useState<ClaudeCodeStatus | null>(null);
    const [checkingClaudeCode, setCheckingClaudeCode] = useState(false);

    // UI Helpers
    const [copiedId, setCopiedId] = useState<string | null>(null);

    // Initial Provider Logic
    const getInitialGroup = (p: LLMProvider): ProviderGroup => {
        if (p === 'anthropic' || p === 'claude-code') return 'anthropic';
        if (p === 'groq') return 'groq';
        if (p === 'ollama' || p === 'custom') return 'local';
        return 'openai';
    };
    const [activeProviderGroup, setActiveProviderGroup] = useState<ProviderGroup>(getInitialGroup(config.provider));

    // --- ACTIONS ---

    const copyToClipboard = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const handleSave = async () => {
        const configToSave = {
            ...localConfig,
            model: localConfig.model.trim() || DEFAULT_LLM_CONFIGS[localConfig.provider].model,
            executor_model: localConfig.executor_model?.trim() || null,
            // Ensure endpoint is cleared if switching to local mode
            embedding_endpoint: embeddingMode === 'local' ? null : localConfig.embedding_endpoint
        };

        onConfigChange(configToSave);
        localStorage.setItem('opspilot-llm-config', JSON.stringify(configToSave));

        try {
            await invoke('save_llm_config', {
                config: {
                    ...configToSave,
                    api_key: configToSave.api_key || null,
                    executor_model: configToSave.executor_model || null
                }
            });
        } catch (e) {
            console.warn('Failed to persist LLM config:', e);
        }
        onClose();
    };

    // --- INFERENCE LOGIC ---

    const fetchInferenceModels = async () => {
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/llm/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: localConfig.provider,
                    api_key: localConfig.api_key,
                    base_url: localConfig.base_url
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.models?.length > 0) {
                    setInferenceStatus(prev => prev ? { ...prev, available_models: data.models, connected: true } : null);
                    return data.models;
                }
            }
        } catch (e) {
            console.error("Failed to fetch models", e);
        }
        return [];
    };

    const checkInferenceConnection = async () => {
        setCheckingInference(true);
        setInferenceStatus(null);

        // Special case: Claude Code
        if (localConfig.provider === 'claude-code') {
            setCheckingClaudeCode(true);
            try {
                const result = await invoke<ClaudeCodeStatus>("check_claude_code_status");
                setClaudeCodeStatus(result);
                setInferenceStatus({
                    connected: result.available,
                    provider: 'claude-code',
                    model: result.version || 'cli',
                    available_models: [],
                    error: result.error
                });
            } catch (err) {
                setInferenceStatus({
                    connected: false,
                    provider: 'claude-code',
                    model: 'cli',
                    available_models: [],
                    error: String(err)
                });
            }
            setCheckingClaudeCode(false);
            setCheckingInference(false);
            return;
        }

        // Standard Providers
        try {
            // First try pure Python check if possible (faster for keys)
            if (['openai', 'groq'].includes(localConfig.provider)) {
                const resp = await fetch(`${AGENT_SERVER_URL}/llm/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        provider: localConfig.provider,
                        api_key: localConfig.api_key,
                        base_url: localConfig.base_url,
                        model: localConfig.model
                    })
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const models = await fetchInferenceModels();
                    setInferenceStatus({
                        connected: !!data.connected,
                        provider: localConfig.provider,
                        model: localConfig.model,
                        available_models: models || [],
                        error: data.error
                    });
                    setCheckingInference(false);
                    return;
                }
            }

            // Fallback to Rust/Tauri System check
            const result = await invoke<LLMStatus>("check_llm_status", { config: localConfig });
            if (result.connected && ['openai', 'groq'].includes(localConfig.provider)) {
                const models = await fetchInferenceModels();
                if (models.length) result.available_models = models;
            }
            setInferenceStatus(result);

        } catch (err) {
            setInferenceStatus({
                connected: false,
                provider: localConfig.provider,
                model: localConfig.model,
                available_models: [],
                error: String(err)
            });
        }
        setCheckingInference(false);
    };

    const handleProviderSelect = (group: ProviderGroup) => {
        setActiveProviderGroup(group);
        let newProvider: LLMProvider = 'openai';
        if (group === 'anthropic') newProvider = 'anthropic';
        if (group === 'groq') newProvider = 'groq';
        if (group === 'local') newProvider = 'ollama';

        const def = DEFAULT_LLM_CONFIGS[newProvider];
        const newConfig = {
            ...localConfig,
            ...def,
            // Preserve key if provider matches
            api_key: newProvider === localConfig.provider ? localConfig.api_key : def.api_key
        };
        setLocalConfig(newConfig);
        // Trigger check after state update
        setTimeout(() => checkInferenceConnection(), 100);
    };


    // --- EMBEDDING LOGIC ---

    const getEffectiveEmbeddingEndpoint = () => {
        if (embeddingMode === 'custom') return localConfig.embedding_endpoint;
        // If mode is local, we need the Ollama URL
        // Using 127.0.0.1 is safer than localhost for backend python requests
        if (localConfig.provider === 'ollama') {
            const base = localConfig.base_url || 'http://127.0.0.1:11434';
            return base.replace('localhost', '127.0.0.1');
        }
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
                const data = await resp.json();
                setEmbeddingStatus(data);
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
            // KB Status doesn't strictly need endpoint unless checking generation capability, but good to pass
            // Actually, the backend check_embedding_model_available call inside kb_embeddings_status uses llm_endpoint param
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
        setReindexingProgress(0);
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
                            if (data.percent) setReindexingProgress(data.percent);
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

    // --- EFFECTS ---

    useEffect(() => {
        checkInferenceConnection();
        checkEmbeddingStatus();
        checkKbStatus();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-check KB if embedding availability changes
    useEffect(() => {
        if (embeddingStatus?.available) checkKbStatus();
    }, [embeddingStatus?.available]);

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
                            <Cpu size={24} className="text-white" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white tracking-tight">AI Configuration</h2>
                            <p className="text-sm text-zinc-400 font-medium">Fine-tune your Agent's Brain & Memory</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2.5 rounded-full hover:bg-white/10 text-zinc-400 hover:text-white transition-all hover:scale-110">
                        <X size={20} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">

                {/* === SECTION 1: AI BRAIN === */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5 shadow-xl relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-br from-violet-500/5 to-transparent pointer-events-none" />

                    <div className="flex items-center gap-2.5 mb-5 relative z-10">
                        <div className="p-1.5 bg-violet-500/20 rounded-lg text-violet-400">
                            <Brain size={18} />
                        </div>
                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">AI Brain (Inference)</h3>
                    </div>

                    <div className="space-y-6 relative z-10">
                        {/* Provider Grid */}
                        <div className="grid grid-cols-4 gap-3">
                            {[
                                { id: 'openai', label: 'OpenAI', icon: openAiLogo, active: activeProviderGroup === 'openai' },
                                { id: 'anthropic', label: 'Anthropic', icon: anthropicLogo, active: activeProviderGroup === 'anthropic' },
                                { id: 'groq', label: 'Groq', icon: null, component: <Zap size={20} className="text-orange-500" />, active: activeProviderGroup === 'groq' },
                                { id: 'local', label: 'Local', icon: ollamaLogo, active: activeProviderGroup === 'local' },
                            ].map(p => (
                                <button
                                    key={p.id}
                                    onClick={() => handleProviderSelect(p.id as ProviderGroup)}
                                    className={`relative p-3 rounded-xl border flex flex-col items-center gap-2 transition-all duration-300 group ${p.active
                                        ? 'bg-violet-500/10 border-violet-500/50 shadow-[0_0_15px_rgba(139,92,246,0.15)] scale-[1.02]'
                                        : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/10 hover:scale-[1.02]'
                                        }`}
                                >
                                    <div className="h-7 flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity">
                                        {p.icon ?
                                            <img src={p.icon} className="w-7 h-7 object-contain" alt={p.label} /> :
                                            p.component
                                        }
                                    </div>
                                    <span className={`text-[10px] font-bold uppercase tracking-wider ${p.active ? 'text-white' : 'text-zinc-500'}`}>{p.label}</span>
                                </button>
                            ))}
                        </div>

                        {/* Config Inputs */}
                        <div className="space-y-4">
                            {/* Key/URL */}
                            <div>
                                {activeProviderGroup !== 'local' && localConfig.provider !== 'claude-code' && (
                                    <div className="relative group">
                                        <label className="absolute -top-2 left-2 px-1 bg-[#18181b] text-[10px] font-bold text-zinc-500 uppercase flex items-center gap-1 z-20">
                                            API Key <ShieldCheck size={9} className="text-emerald-500" />
                                        </label>
                                        <input
                                            type={showApiKey ? "text" : "password"}
                                            value={localConfig.api_key || ''}
                                            onChange={e => setLocalConfig({ ...localConfig, api_key: e.target.value })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-xs text-white placeholder-zinc-700 focus:border-violet-500/50 outline-none transition-all font-mono"
                                            placeholder="sk-..."
                                        />
                                        <button
                                            onClick={() => setShowApiKey(!showApiKey)}
                                            className="absolute right-3 top-3 text-zinc-600 hover:text-zinc-300"
                                        >
                                            {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                                        </button>
                                    </div>
                                )}
                                {activeProviderGroup === 'local' && (
                                    <div className="relative group">
                                        <label className="absolute -top-2 left-2 px-1 bg-[#18181b] text-[10px] font-bold text-zinc-500 uppercase z-20">Ollama Base URL</label>
                                        <input
                                            type="text"
                                            value={localConfig.base_url}
                                            onChange={e => setLocalConfig({ ...localConfig, base_url: e.target.value })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-xs text-white placeholder-zinc-700 focus:border-violet-500/50 outline-none font-mono"
                                            placeholder="http://localhost:11434"
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Claude Code Toggle */}
                            {activeProviderGroup === 'anthropic' && (
                                <div className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5">
                                    <div className="flex items-center gap-3">
                                        <div className="p-1.5 bg-indigo-500/20 rounded">
                                            <Terminal size={14} className="text-indigo-400" />
                                        </div>
                                        <div>
                                            <div className="text-xs font-bold text-white">Use Claude Code CLI</div>
                                            <div className="text-[10px] text-zinc-500">Auth via terminal instead of API Key</div>
                                        </div>
                                    </div>
                                    <input
                                        type="checkbox"
                                        checked={localConfig.provider === 'claude-code'}
                                        onChange={e => {
                                            const useCli = e.target.checked;
                                            setLocalConfig(prev => ({
                                                ...prev,
                                                provider: useCli ? 'claude-code' : 'anthropic',
                                                api_key: useCli ? prev.api_key : DEFAULT_LLM_CONFIGS.anthropic.api_key
                                            }));
                                            setTimeout(checkInferenceConnection, 100);
                                        }}
                                        className="accent-violet-500 w-4 h-4 rounded"
                                    />
                                </div>
                            )}

                            {/* Models Section */}
                            {localConfig.provider !== 'claude-code' && (
                                <div className="grid grid-cols-2 gap-4 pt-2">
                                    {/* Brain Model */}
                                    <div className="space-y-1.5">
                                        <div className="flex justify-between items-center">
                                            <div className="flex items-center gap-1.5">
                                                <Brain size={12} className="text-violet-400" />
                                                <label className="text-[10px] font-bold text-zinc-400 uppercase">Brain Model</label>
                                                <div className="group/brain-info relative inline-block">
                                                    <Info size={10} className="text-zinc-600 cursor-help" />
                                                    <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-48 p-2 bg-black border border-white/10 rounded text-[10px] text-zinc-400 hidden group-hover/brain-info:block z-[9999] pointer-events-none shadow-lg">
                                                        Primary model for complex reasoning, planning, and analysis.
                                                    </div>
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => {
                                                    setCheckingInference(true);
                                                    fetchInferenceModels().then(() => setCheckingInference(false));
                                                }}
                                                disabled={checkingInference}
                                                className="text-[10px] text-violet-400 hover:text-white flex items-center gap-1 transition-colors"
                                            >
                                                <RefreshCw size={10} className={checkingInference ? "animate-spin" : ""} />
                                            </button>
                                        </div>
                                        <input
                                            list="inference-models"
                                            type="text"
                                            value={localConfig.model}
                                            onChange={e => setLocalConfig({ ...localConfig, model: e.target.value })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-zinc-700 focus:border-violet-500/50 outline-none font-mono transition-all"
                                            placeholder="Select or type..."
                                        />
                                        <datalist id="inference-models">
                                            {inferenceStatus?.available_models?.map(m => <option key={m} value={m} />)}
                                        </datalist>
                                    </div>

                                    {/* Executor Model */}
                                    <div className="space-y-1.5">
                                        <div className="flex items-center gap-1.5">
                                            <Activity size={12} className="text-emerald-400" />
                                            <label className="text-[10px] font-bold text-zinc-400 uppercase">Executor Model</label>
                                            <div className="group/exec-info relative inline-block">
                                                <Info size={10} className="text-zinc-600 cursor-help" />
                                                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-48 p-2 bg-black border border-white/10 rounded text-[10px] text-zinc-400 hidden group-hover/exec-info:block z-[9999] pointer-events-none shadow-lg">
                                                    Faster, cheaper model for simple tasks like executing specific CLI commands.
                                                </div>
                                            </div>
                                        </div>
                                        <input
                                            list="inference-models"
                                            type="text"
                                            value={localConfig.executor_model || ''}
                                            onChange={e => setLocalConfig({ ...localConfig, executor_model: e.target.value })}
                                            className="w-full bg-black/20 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-zinc-700 focus:border-emerald-500/50 outline-none font-mono transition-all"
                                            placeholder="Same as brain (Default)"
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Connection Status */}
                            <div className={`p-3 rounded-xl border flex items-center gap-3 transition-all ${checkingInference ? 'bg-amber-500/5 border-amber-500/20' :
                                inferenceStatus?.connected ? 'bg-emerald-500/5 border-emerald-500/20' :
                                    'bg-red-500/5 border-red-500/20'
                                }`}>
                                <StatusDot ok={inferenceStatus?.connected} loading={checkingInference} />
                                <div className="flex-1">
                                    <div className={`text-xs font-bold ${checkingInference ? 'text-amber-400' :
                                        inferenceStatus?.connected ? 'text-emerald-400' :
                                            'text-red-400'
                                        }`}>
                                        {checkingInference ? 'Testing Connection...' :
                                            inferenceStatus?.connected ? 'Brain Connected' :
                                                'Connection Failed'}
                                    </div>
                                    {inferenceStatus?.error && !checkingInference && (
                                        <div className="text-[10px] text-red-400/80 mt-1 leading-tight">{inferenceStatus.error}</div>
                                    )}
                                </div>
                                <button
                                    onClick={checkInferenceConnection}
                                    className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/5 rounded px-2 py-1 text-zinc-400 transition-colors"
                                >
                                    Test
                                </button>
                            </div>

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
                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">Memory System (Embeddings)</h3>
                    </div>

                    <div className="space-y-6 relative z-10">
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
                            {/* Endpoint (Custom Only) */}
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

                            {/* Model Name */}
                            <div className={embeddingMode === 'custom' ? 'col-span-2' : 'col-span-2'}>
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
                                            {embeddingStatus?.error && (
                                                <div className="absolute right-0 top-full mt-2 w-48 p-2 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-200 hidden group-hover/status:block z-50 backdrop-blur-md">
                                                    {embeddingStatus.error}
                                                </div>
                                            )}
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

                        {/* --- KB HEALTH --- */}
                        <div className="pt-4 border-t border-white/5">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                    <BookOpen size={14} className="text-fuchsia-400" />
                                    <span className="text-xs font-bold text-white uppercase">Knowledge Base</span>
                                </div>
                                {kbStatus?.available ? 'ACTIVE' : 'OFFLINE'}
                            </div>
                        </div>

                        {/* NEW: Global CRD Loading Progress */}
                        {kbProgress && (
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
                                <div className="text-[9px] text-blue-300/60 truncate font-mono">
                                    Context: {kbProgress.context}
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
        </div >
    );
}
