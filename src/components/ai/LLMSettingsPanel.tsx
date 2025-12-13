import { useState, useEffect } from 'react';
import { Settings, X, Check, ExternalLink, Eye, EyeOff, Copy, AlertCircle, Terminal, Sparkles, Download, Database, Loader2, Zap, BookOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { LLMConfig, LLMStatus, LLMProvider } from '../../types/ai';
import { DEFAULT_LLM_CONFIGS } from './constants';
import { MCPSettings } from '../settings/MCPSettings';

// Asset Imports
import openAiLogo from '../../assets/openai-logo.png';
import anthropicLogo from '../../assets/anthropic-logo.png';
import ollamaLogo from '../../assets/ollama-logo.png';

interface ClaudeCodeStatus {
    available: boolean;
    version: string | null;
    error: string | null;
}

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

const AGENT_SERVER_URL = 'http://127.0.0.1:8765';

type ProviderGroup = 'openai' | 'anthropic' | 'local';

export function LLMSettingsPanel({
    config,
    onConfigChange,
    onClose,
    systemSpecs
}: {
    config: LLMConfig;
    onConfigChange: (config: LLMConfig) => void;
    onClose: () => void;
    systemSpecs: { cpu_brand: string; total_memory: number; is_apple_silicon: boolean; } | null;
}) {
    const [activeTab, setActiveTab] = useState<'provider' | 'mcp'>('provider');
    const [localConfig, setLocalConfig] = useState<LLMConfig>(config);
    const [status, setStatus] = useState<LLMStatus | null>(null);
    const [checking, setChecking] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);
    const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

    const [claudeCodeStatus, setClaudeCodeStatus] = useState<ClaudeCodeStatus | null>(null);
    const [checkingClaudeCode, setCheckingClaudeCode] = useState(false);

    // Determine initial provider group based on config
    const getInitialGroup = (p: LLMProvider): ProviderGroup => {
        if (p === 'anthropic' || p === 'claude-code') return 'anthropic';
        if (p === 'ollama' || p === 'custom') return 'local';
        return 'openai';
    };

    const [activeProviderGroup, setActiveProviderGroup] = useState<ProviderGroup>(getInitialGroup(config.provider));

    // Embedding model state
    const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingModelStatus | null>(null);
    const [checkingEmbedding, setCheckingEmbedding] = useState(false);
    const [downloadingEmbedding, setDownloadingEmbedding] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

    // KB Embeddings state
    const [kbEmbeddingsStatus, setKBEmbeddingsStatus] = useState<KBEmbeddingsStatus | null>(null);
    const [generatingKBEmbeddings, setGeneratingKBEmbeddings] = useState(false);
    const [kbGenProgress, setKBGenProgress] = useState<number | null>(null);
    const [kbGenMessage, setKBGenMessage] = useState<string | null>(null);

    const checkClaudeCodeStatus = async () => {
        setCheckingClaudeCode(true);
        try {
            const result = await invoke<ClaudeCodeStatus>("check_claude_code_status");
            setClaudeCodeStatus(result);

            // Sync with main status for the UI pill
            setStatus({
                connected: result.available,
                provider: 'claude-code',
                model: result.version || 'claude-code-cli',
                available_models: [],
                error: result.error
            });

        } catch (err) {
            const errorStr = String(err);
            setClaudeCodeStatus({
                available: false,
                version: null,
                error: errorStr,
            });
            setStatus({
                connected: false,
                provider: 'claude-code',
                model: 'claude-code-cli',
                available_models: [],
                error: errorStr
            });
        }
        setCheckingClaudeCode(false);
    };

    const checkEmbeddingModel = async () => {
        setCheckingEmbedding(true);
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/embedding-model/status?llm_endpoint=${encodeURIComponent(localConfig.base_url)}`);
            if (resp.ok) {
                const data = await resp.json();
                setEmbeddingStatus(data);
            }
        } catch (err) {
            setEmbeddingStatus({
                model: 'nomic-embed-text',
                available: false,
                size_mb: null,
                ollama_connected: false,
                error: 'Agent server not reachable'
            });
        }
        setCheckingEmbedding(false);
    };

    const downloadEmbeddingModel = async () => {
        setDownloadingEmbedding(true);
        setDownloadProgress(0);

        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/embedding-model/pull?llm_endpoint=${encodeURIComponent(localConfig.base_url)}`, {
                method: 'POST',
            });

            if (!resp.body) throw new Error('No response body');

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.percent !== undefined) {
                                setDownloadProgress(data.percent);
                            }
                            if (data.status === 'success') {
                                setEmbeddingStatus(prev => prev ? { ...prev, available: true } : null);
                                setDownloadProgress(100);
                            }
                            if (data.status === 'error') {
                                console.error('Download error:', data.message);
                            }
                        } catch { }
                    }
                }
            }
        } catch (err) {
            console.error('Failed to download embedding model:', err);
        }

        setDownloadingEmbedding(false);
        // Re-check status after download
        setTimeout(checkEmbeddingModel, 1000);
    };

    const checkKBEmbeddingsStatus = async () => {
        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/kb-embeddings/status?llm_endpoint=${encodeURIComponent(localConfig.base_url)}`);
            if (resp.ok) {
                const data = await resp.json();
                setKBEmbeddingsStatus(data);
            }
        } catch (err) {
            console.error('Failed to check KB embeddings status:', err);
        }
    };

    const generateKBEmbeddings = async () => {
        setGeneratingKBEmbeddings(true);
        setKBGenProgress(0);
        setKBGenMessage('Starting...');

        try {
            const resp = await fetch(`${AGENT_SERVER_URL}/kb-embeddings/generate?llm_endpoint=${encodeURIComponent(localConfig.base_url)}`, {
                method: 'POST',
            });

            if (!resp.body) throw new Error('No response body');

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.percent !== undefined) {
                                setKBGenProgress(data.percent);
                            }
                            if (data.message) {
                                setKBGenMessage(data.message);
                            }
                            if (data.status === 'success') {
                                setKBEmbeddingsStatus(prev => prev ? {
                                    ...prev,
                                    available: true,
                                    source: 'cached',
                                    document_count: data.document_count || prev.document_count
                                } : null);
                                setKBGenProgress(100);
                            }
                            if (data.status === 'error') {
                                console.error('KB generation error:', data.message);
                                setKBGenMessage(`Error: ${data.message}`);
                            }
                        } catch { }
                    }
                }
            }
        } catch (err) {
            console.error('Failed to generate KB embeddings:', err);
            setKBGenMessage('Failed to connect to agent server');
        }

        setGeneratingKBEmbeddings(false);
        // Re-check status after generation
        setTimeout(checkKBEmbeddingsStatus, 1000);
    };

    const checkConnection = async () => {
        setChecking(true);
        setStatus(null);

        // Special handling for Claude Code
        if (localConfig.provider === 'claude-code') {
            await checkClaudeCodeStatus();
            setChecking(false);
            return;
        }

        try {
            const result = await invoke<LLMStatus>("check_llm_status", { config: localConfig });
            setStatus(result);
        } catch (err) {
            setStatus({
                connected: false,
                provider: localConfig.provider,
                model: localConfig.model,
                available_models: [],
                error: String(err),
            });
        }
        setChecking(false);
    };

    const handleProviderGroupChange = (group: ProviderGroup) => {
        setActiveProviderGroup(group);

        // Reset provider based on group
        // If switching to Anthropic, default to 'anthropic' (API Key) unless already claude-code
        // If switching to Local, default to 'ollama' unless already custom
        // If switching to OpenAI, set to 'openai'

        let newProvider: LLMProvider = 'openai';
        if (group === 'anthropic') newProvider = 'anthropic';
        if (group === 'local') newProvider = 'ollama'; // Default to Ollama for local

        const defaultConfig = DEFAULT_LLM_CONFIGS[newProvider];
        setLocalConfig({
            ...defaultConfig,
            // Preserve API keys/urls if switching back to a provider we used before?
            // For simplicity, just load default, but try to preserve key if matching
            api_key: newProvider === localConfig.provider ? localConfig.api_key : null
        });
        setStatus(null);
    };

    const copyToClipboard = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedCommand(id);
        setTimeout(() => setCopiedCommand(null), 2000);
    };

    const handleSave = () => {
        // Use default model if model field is empty
        const configToSave = {
            ...localConfig,
            model: localConfig.model.trim() || DEFAULT_LLM_CONFIGS[localConfig.provider].model,
        };
        onConfigChange(configToSave);
        // Save to localStorage
        localStorage.setItem('opspilot-llm-config', JSON.stringify(configToSave));
        onClose();
    };

    useEffect(() => {
        // Auto-check on mount
        checkConnection();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Check embedding model when Ollama connects
    useEffect(() => {
        if (localConfig.provider === 'ollama' && status?.connected) {
            checkEmbeddingModel();
        }
    }, [localConfig.provider, status?.connected]); // eslint-disable-line react-hooks/exhaustive-deps

    // Check KB embeddings when embedding model is available
    useEffect(() => {
        if (embeddingStatus?.available) {
            checkKBEmbeddingsStatus();
        }
    }, [embeddingStatus?.available]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="p-5 space-y-5 max-h-full overflow-y-auto">
            {/* Decorative background */}
            <div className="absolute top-0 left-0 right-0 h-40 bg-gradient-to-b from-violet-500/10 via-fuchsia-500/5 to-transparent pointer-events-none" />
            <div className="absolute -top-20 -right-20 w-40 h-40 bg-purple-500/20 rounded-full blur-3xl pointer-events-none" />

            {/* Header */}
            <div className="relative flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-xl blur-sm opacity-60" />
                        <div className="relative w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                            <Settings size={20} className="text-white" />
                        </div>
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white tracking-tight">AI Settings</h3>
                        <p className="text-xs text-zinc-400">Configure providers & extensions</p>
                    </div>
                </div>
                <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all">
                    <X size={18} />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 p-1 bg-black/20 rounded-xl border border-white/5 mb-5">
                <button
                    onClick={() => setActiveTab('provider')}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${activeTab === 'provider' ? 'bg-white/10 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                >
                    LLM Provider
                </button>
                <button
                    onClick={() => setActiveTab('mcp')}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${activeTab === 'mcp' ? 'bg-white/10 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                >
                    MCP Extensions
                </button>
            </div>

            {activeTab === 'provider' ? (
                <>
                    {/* Provider Selection */}
                    <div className="relative space-y-3">
                        <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Select Provider</label>
                        <div className="grid grid-cols-3 gap-2.5">
                            <button
                                onClick={() => handleProviderGroupChange('openai')}
                                className={`relative p-3 rounded-xl flex flex-col items-center gap-2 transition-all duration-200 border overflow-hidden group ${activeProviderGroup === 'openai'
                                    ? 'bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border-violet-500/50 shadow-lg shadow-purple-500/10'
                                    : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10'
                                    }`}
                            >
                                {activeProviderGroup === 'openai' && (
                                    <div className="absolute top-2 right-2">
                                        <div className="w-5 h-5 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                                            <Check size={12} className="text-white" />
                                        </div>
                                    </div>
                                )}
                                <div className="w-10 h-10 flex items-center justify-center">
                                    <img src={openAiLogo} alt="OpenAI" className="w-8 h-8 object-contain" />
                                </div>
                                <span className="font-semibold text-white text-xs">OpenAI</span>
                            </button>

                            <button
                                onClick={() => handleProviderGroupChange('anthropic')}
                                className={`relative p-3 rounded-xl flex flex-col items-center gap-2 transition-all duration-200 border overflow-hidden group ${activeProviderGroup === 'anthropic'
                                    ? 'bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border-violet-500/50 shadow-lg shadow-purple-500/10'
                                    : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10'
                                    }`}
                            >
                                {activeProviderGroup === 'anthropic' && (
                                    <div className="absolute top-2 right-2">
                                        <div className="w-5 h-5 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                                            <Check size={12} className="text-white" />
                                        </div>
                                    </div>
                                )}
                                <div className="w-10 h-10 flex items-center justify-center">
                                    <img src={anthropicLogo} alt="Anthropic" className="w-8 h-8 object-contain" />
                                </div>
                                <span className="font-semibold text-white text-xs">Anthropic</span>
                            </button>

                            <button
                                onClick={() => handleProviderGroupChange('local')}
                                className={`relative p-3 rounded-xl flex flex-col items-center gap-2 transition-all duration-200 border overflow-hidden group ${activeProviderGroup === 'local'
                                    ? 'bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border-violet-500/50 shadow-lg shadow-purple-500/10'
                                    : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10'
                                    }`}
                            >
                                {activeProviderGroup === 'local' && (
                                    <div className="absolute top-2 right-2">
                                        <div className="w-5 h-5 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                                            <Check size={12} className="text-white" />
                                        </div>
                                    </div>
                                )}
                                <div className="w-10 h-10 flex items-center justify-center">
                                    <img src={ollamaLogo} alt="Local / Custom" className="w-8 h-8 object-contain rounded-full bg-white/10 p-1" />
                                </div>
                                <span className="font-semibold text-white text-xs">Local / Custom</span>
                            </button>
                        </div>
                    </div>

                    {/* Connection Status */}
                    <div className="relative bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className={`relative w-3 h-3 rounded-full ${checking ? 'bg-amber-400' :
                                    status?.connected ? 'bg-emerald-400' : 'bg-red-400'
                                    }`}>
                                    {checking && <div className="absolute inset-0 bg-amber-400 rounded-full animate-ping" />}
                                    {status?.connected && <div className="absolute inset-0 bg-emerald-400 rounded-full animate-pulse opacity-50" />}
                                </div>
                                <div>
                                    <span className="text-sm font-medium text-white">Connection Status</span>
                                    {status && (
                                        <p className={`text-xs ${status.connected ? 'text-emerald-400' : 'text-red-400'}`}>
                                            {status.connected ? `Connected to ${status.provider}` : (status.error || 'Not connected')}
                                        </p>
                                    )}
                                </div>
                            </div>
                            <button
                                onClick={checkConnection}
                                disabled={checking}
                                className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white transition-all disabled:opacity-50 font-medium"
                            >
                                {checking ? 'Testing...' : 'Test Connection'}
                            </button>
                        </div>
                    </div>

                    {/* ANTHROPIC / CLAUDE CODE SPECIAL TOGGLE */}
                    {activeProviderGroup === 'anthropic' && (
                        <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-indigo-500/20 rounded-lg">
                                        <Terminal size={16} className="text-indigo-400" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium text-white">Use Claude Code CLI</p>
                                        <p className="text-[11px] text-zinc-400">Use local authentication instead of API Key</p>
                                    </div>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={localConfig.provider === 'claude-code'}
                                        onChange={(e) => {
                                            const isChecked = e.target.checked;
                                            const newProvider = isChecked ? 'claude-code' : 'anthropic';
                                            const def = DEFAULT_LLM_CONFIGS[newProvider];
                                            setLocalConfig({ ...def, api_key: newProvider === 'anthropic' ? localConfig.api_key : null }); // Keep key if going back to api
                                            setStatus(null);
                                        }}
                                    />
                                    <div className="w-11 h-6 bg-white/10 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                                </label>
                            </div>

                            {/* Claude Code Status Detail */}
                            {localConfig.provider === 'claude-code' && (
                                <div className="mt-3 pt-3 border-t border-white/10">
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className={`w-2 h-2 rounded-full ${claudeCodeStatus?.available ? 'bg-emerald-400' : 'bg-red-400'}`} />
                                        <span className="text-xs text-zinc-300">
                                            {claudeCodeStatus?.available
                                                ? `CLI Available ${claudeCodeStatus.version ? `(${claudeCodeStatus.version})` : ''}`
                                                : (claudeCodeStatus?.error || 'Checking...')}
                                        </span>
                                    </div>
                                    {!claudeCodeStatus?.available && (
                                        <div className="bg-black/20 rounded-lg p-2 flex items-center gap-2">
                                            <code className="text-[10px] text-cyan-300 flex-1">npm install -g @anthropic-ai/claude-code</code>
                                            <button onClick={() => copyToClipboard('npm install -g @anthropic-ai/claude-code', 'cc')} className="p-1 hover:text-white text-zinc-500">
                                                {copiedCommand === 'cc' ? <Check size={12} /> : <Copy size={12} />}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* LOCAL / OLLAMA SPECIAL TOGGLE */}
                    {activeProviderGroup === 'local' && (
                        <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-orange-500/20 rounded-lg">
                                        <Sparkles size={16} className="text-orange-400" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium text-white">Use Ollama</p>
                                        <p className="text-[11px] text-zinc-400">Pull and run local models</p>
                                    </div>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={localConfig.provider === 'ollama'}
                                        onChange={(e) => {
                                            const isChecked = e.target.checked;
                                            const newProvider = isChecked ? 'ollama' : 'custom';
                                            const def = DEFAULT_LLM_CONFIGS[newProvider];
                                            setLocalConfig({ ...def, base_url: isChecked ? 'http://localhost:11434' : localConfig.base_url });
                                            setStatus(null);
                                        }}
                                    />
                                    <div className="w-11 h-6 bg-white/10 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-orange-500/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
                                </label>
                            </div>
                        </div>
                    )}

                    {/* API Settings (Key & URL) */}
                    <div className="space-y-4">
                        {/* API Key Input - Show for OpenAI or Anthropic (logic: NOT local/custom/claude-code) */}
                        {activeProviderGroup !== 'local' && localConfig.provider !== 'claude-code' && (
                            <div className="space-y-2.5">
                                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">API Key</label>
                                <div className="relative">
                                    <input
                                        type={showApiKey ? 'text' : 'password'}
                                        value={localConfig.api_key || ''}
                                        onChange={(e) => setLocalConfig({ ...localConfig, api_key: e.target.value || null })}
                                        placeholder={activeProviderGroup === 'openai' ? "sk-..." : "sk-ant-..."}
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 pr-11 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white transition-colors"
                                    >
                                        {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Base URL Input - Show for Custom or Ollama */}
                        {(activeProviderGroup === 'local') && (
                            <div className="space-y-2.5">
                                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Base URL</label>
                                <input
                                    type="text"
                                    value={localConfig.base_url}
                                    onChange={(e) => setLocalConfig({ ...localConfig, base_url: e.target.value })}
                                    placeholder="http://localhost:11434"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all font-mono text-xs"
                                />
                            </div>
                        )}

                        {/* Model Name Input - Show for everyone except Claude Code which uses CLI default logic for now? Or allow override? Current code allows override. */}
                        {localConfig.provider !== 'claude-code' && (
                            <div className="space-y-2.5">
                                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Model Name</label>
                                <input
                                    type="text"
                                    value={localConfig.model}
                                    onChange={(e) => setLocalConfig({ ...localConfig, model: e.target.value })}
                                    placeholder={activeProviderGroup === 'openai' ? 'gpt-4o' : 'llama3'}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all font-mono text-xs"
                                />
                                {/* Helper for Ollama: Pull instructions */}
                                {localConfig.provider === 'ollama' && (
                                    <div className="bg-black/20 rounded-lg p-2 flex items-center gap-2 mt-1">
                                        <code className="text-[10px] text-zinc-400 flex-1">ollama pull {localConfig.model}</code>
                                        <button onClick={() => copyToClipboard(`ollama pull ${localConfig.model}`, 'pull')} className="p-1 hover:text-white text-zinc-500">
                                            {copiedCommand === 'pull' ? <Check size={12} /> : <Copy size={12} />}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Hardware Specs - Only for Local */}
                    {activeProviderGroup === 'local' && systemSpecs && (
                        <div className="bg-white/5 rounded-lg p-3 text-xs border border-white/10 mt-4">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-zinc-400 flex items-center gap-1.5"><Settings size={12} /> Hardware Detected</span>
                                <span className="text-zinc-200 font-mono">{systemSpecs.cpu_brand} ({Math.round(systemSpecs.total_memory / 1024 / 1024 / 1024)}GB RAM)</span>
                            </div>
                        </div>
                    )}

                    {/* Embedding Model Status - For Knowledge Base RAG */}
                    {localConfig.provider === 'ollama' && status?.connected && embeddingStatus && (
                        <div className={`relative rounded-xl p-4 border ${embeddingStatus.available
                            ? 'bg-gradient-to-br from-emerald-500/10 to-cyan-500/10 border-emerald-500/20'
                            : 'bg-gradient-to-br from-amber-500/10 to-orange-500/10 border-amber-500/20'
                            }`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-lg ${embeddingStatus.available ? 'bg-emerald-500/20' : 'bg-amber-500/20'}`}>
                                        <Database size={16} className={embeddingStatus.available ? 'text-emerald-400' : 'text-amber-400'} />
                                    </div>
                                    <div>
                                        <p className={`text-sm font-semibold ${embeddingStatus.available ? 'text-emerald-300' : 'text-amber-300'}`}>
                                            Knowledge Base {embeddingStatus.available ? 'Ready' : 'Enhancement Available'}
                                        </p>
                                        <p className="text-[11px] text-zinc-400">
                                            {embeddingStatus.available
                                                ? `${embeddingStatus.model} - Enables smarter troubleshooting`
                                                : `Download ${embeddingStatus.model} (~274MB) for RAG-powered insights`
                                            }
                                        </p>
                                    </div>
                                </div>

                                {!embeddingStatus.available && (
                                    <button
                                        onClick={downloadEmbeddingModel}
                                        disabled={downloadingEmbedding}
                                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-medium transition-all disabled:opacity-50"
                                    >
                                        {downloadingEmbedding ? (
                                            <>
                                                <Loader2 size={14} className="animate-spin" />
                                                {downloadProgress !== null ? `${downloadProgress.toFixed(0)}%` : 'Downloading...'}
                                            </>
                                        ) : (
                                            <>
                                                <Download size={14} />
                                                Download
                                            </>
                                        )}
                                    </button>
                                )}

                                {embeddingStatus.available && (
                                    <div className="flex items-center gap-1.5 text-emerald-400">
                                        <Check size={16} />
                                        <span className="text-xs font-medium">Installed</span>
                                    </div>
                                )}
                            </div>

                            {/* Download Progress Bar */}
                            {downloadingEmbedding && downloadProgress !== null && (
                                <div className="mt-3">
                                    <div className="h-1.5 bg-black/20 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-gradient-to-r from-amber-500 to-orange-500 transition-all duration-300"
                                            style={{ width: `${downloadProgress}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            {!embeddingStatus.available && !downloadingEmbedding && (
                                <p className="mt-2 text-[10px] text-zinc-500">
                                    Optional: Improves agent accuracy with curated K8s troubleshooting knowledge.
                                </p>
                            )}
                        </div>
                    )}

                    {/* KB Embeddings Generation - Show after embedding model is installed */}
                    {localConfig.provider === 'ollama' && embeddingStatus?.available && kbEmbeddingsStatus && (
                        <div className={`relative rounded-xl p-4 border ${kbEmbeddingsStatus.available
                            ? 'bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border-blue-500/20'
                            : 'bg-gradient-to-br from-purple-500/10 to-pink-500/10 border-purple-500/20'
                            }`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-lg ${kbEmbeddingsStatus.available ? 'bg-blue-500/20' : 'bg-purple-500/20'}`}>
                                        <BookOpen size={16} className={kbEmbeddingsStatus.available ? 'text-blue-400' : 'text-purple-400'} />
                                    </div>
                                    <div>
                                        <p className={`text-sm font-semibold ${kbEmbeddingsStatus.available ? 'text-blue-300' : 'text-purple-300'}`}>
                                            {kbEmbeddingsStatus.available
                                                ? `Knowledge Indexed (${kbEmbeddingsStatus.document_count} docs)`
                                                : 'Index Knowledge Base'
                                            }
                                        </p>
                                        <p className="text-[11px] text-zinc-400">
                                            {kbEmbeddingsStatus.available
                                                ? `Source: ${kbEmbeddingsStatus.source === 'cached' ? 'Local cache' : 'Bundled'}`
                                                : `Generate embeddings for ${kbEmbeddingsStatus.kb_files_found || 0} KB files`
                                            }
                                        </p>
                                    </div>
                                </div>

                                {!kbEmbeddingsStatus.available && (
                                    <button
                                        onClick={generateKBEmbeddings}
                                        disabled={generatingKBEmbeddings}
                                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 text-xs font-medium transition-all disabled:opacity-50"
                                    >
                                        {generatingKBEmbeddings ? (
                                            <>
                                                <Loader2 size={14} className="animate-spin" />
                                                {kbGenProgress !== null ? `${kbGenProgress.toFixed(0)}%` : 'Generating...'}
                                            </>
                                        ) : (
                                            <>
                                                <Zap size={14} />
                                                Generate
                                            </>
                                        )}
                                    </button>
                                )}

                                {kbEmbeddingsStatus.available && (
                                    <div className="flex items-center gap-1.5 text-blue-400">
                                        <Check size={16} />
                                        <span className="text-xs font-medium">Ready</span>
                                    </div>
                                )}
                            </div>

                            {/* Generation Progress Bar */}
                            {generatingKBEmbeddings && kbGenProgress !== null && (
                                <div className="mt-3">
                                    <div className="h-1.5 bg-black/20 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-300"
                                            style={{ width: `${kbGenProgress}%` }}
                                        />
                                    </div>
                                    {kbGenMessage && (
                                        <p className="mt-1 text-[10px] text-zinc-400">{kbGenMessage}</p>
                                    )}
                                </div>
                            )}

                            {!kbEmbeddingsStatus.available && !generatingKBEmbeddings && (
                                <p className="mt-2 text-[10px] text-zinc-500">
                                    One-time setup: Index 57+ K8s troubleshooting patterns for RAG-enhanced responses.
                                </p>
                            )}
                        </div>
                    )}

                    {/* Multi-Agent Architecture Explanation */}
                    {localConfig.provider !== 'claude-code' && (
                        <div className="bg-gradient-to-br from-violet-500/10 to-cyan-500/10 border border-violet-500/20 rounded-xl p-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Sparkles size={14} className="text-violet-400" />
                                <span className="text-xs font-semibold text-violet-300">Multi-Agent Architecture</span>
                            </div>
                            <p className="text-[11px] text-zinc-400 leading-relaxed">
                                OpsPilot uses two AI roles for optimal performance:
                            </p>
                            <ul className="text-[11px] text-zinc-400 space-y-1 ml-2">
                                <li className="flex items-start gap-2">
                                    <span className="text-violet-400">🧠</span>
                                    <span><strong className="text-white">Brain</strong> — Planning, reasoning, analysis. Needs a smart model.</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-cyan-400">⚡</span>
                                    <span><strong className="text-white">Executor</strong> — Fast kubectl translation. Can use a smaller, faster model.</span>
                                </li>
                            </ul>
                        </div>
                    )}

                    {/* Model Selection - Show available models when connected */}
                    {localConfig.provider !== 'claude-code' && status?.connected && status.available_models.length > 0 && (
                        <div className="space-y-4">
                            {/* Brain Model */}
                            <div className="space-y-2">
                                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
                                    <span className="text-violet-400">🧠</span> Brain Model
                                </label>
                                <select
                                    value={localConfig.model}
                                    onChange={(e) => setLocalConfig({ ...localConfig, model: e.target.value })}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all cursor-pointer"
                                >
                                    {!status.available_models.includes(localConfig.model) && (
                                        <option value={localConfig.model} className="bg-zinc-800 text-amber-400">
                                            {localConfig.model} (not found)
                                        </option>
                                    )}
                                    {status.available_models.map(model => (
                                        <option key={model} value={model} className="bg-zinc-800">
                                            {model}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Executor Model */}
                            <div className="space-y-2">
                                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
                                    <span className="text-cyan-400">⚡</span> Executor Model <span className="text-zinc-500 font-normal text-[10px]">(Optional)</span>
                                </label>
                                <select
                                    value={localConfig.executor_model || ''}
                                    onChange={(e) => setLocalConfig({ ...localConfig, executor_model: e.target.value || null })}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all cursor-pointer"
                                >
                                    <option value="" className="bg-zinc-800 text-zinc-400">
                                        Same as Brain (recommended for APIs)
                                    </option>
                                    {status.available_models.map(model => (
                                        <option key={model} value={model} className="bg-zinc-800">
                                            {model}
                                        </option>
                                    ))}
                                </select>
                                <p className="text-[10px] text-zinc-500">
                                    {localConfig.provider === 'ollama'
                                        ? '💡 For local Ollama, use qwen2.5-coder:1.5b for 2-3x faster CLI execution.'
                                        : '💡 For cloud APIs, same model is recommended (no cost difference).'}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Model Input - Show text input when no models available or not connected */}
                    {localConfig.provider !== 'claude-code' && (!status?.connected || status.available_models.length === 0) && (
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
                                    <span className="text-violet-400">🧠</span> Brain Model
                                </label>
                                <input
                                    type="text"
                                    value={localConfig.model}
                                    onChange={(e) => setLocalConfig({ ...localConfig, model: e.target.value })}
                                    placeholder={DEFAULT_LLM_CONFIGS[localConfig.provider]?.model || 'default'}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all font-mono"
                                />
                                <p className="text-[10px] text-zinc-500">
                                    {localConfig.provider === 'ollama' && 'e.g., llama3.1, qwen2.5:14b, mistral'}
                                    {localConfig.provider === 'openai' && 'e.g., gpt-4o, gpt-4-turbo, gpt-3.5-turbo'}
                                    {localConfig.provider === 'anthropic' && 'e.g., claude-sonnet-4-20250514, claude-3-5-haiku-20241022'}
                                    {localConfig.provider === 'custom' && 'Enter the model name available on your server'}
                                </p>
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
                                    <span className="text-cyan-400">⚡</span> Executor Model <span className="text-zinc-500 font-normal text-[10px]">(Optional)</span>
                                </label>
                                <input
                                    type="text"
                                    value={localConfig.executor_model || ''}
                                    onChange={(e) => setLocalConfig({ ...localConfig, executor_model: e.target.value || null })}
                                    placeholder="Leave empty to use Brain model"
                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all font-mono"
                                />
                            </div>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="flex gap-3 pt-3">
                        <button
                            onClick={onClose}
                            className="flex-1 py-3 px-4 rounded-xl border border-white/10 text-zinc-300 font-medium text-sm hover:bg-white/5 hover:border-white/20 transition-all"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={(localConfig.provider === 'openai' || localConfig.provider === 'anthropic') && !localConfig.api_key}
                            className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-semibold text-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 disabled:shadow-none hover:scale-[1.02] disabled:hover:scale-100"
                        >
                            <Check size={16} />
                            Save Settings
                        </button>
                    </div>
                </>
            ) : (
                <div className="pt-2">
                    <MCPSettings />
                </div>
            )}
        </div>
    );
}
