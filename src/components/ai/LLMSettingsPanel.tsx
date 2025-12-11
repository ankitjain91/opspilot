
import { useState, useEffect } from 'react';
import { Settings, X, Check, ExternalLink, Eye, EyeOff, Copy, AlertCircle, Terminal, Sparkles } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { LLMConfig, LLMStatus, LLMProvider } from '../../types/ai';
import { DEFAULT_LLM_CONFIGS } from './constants';

interface ClaudeCodeStatus {
    available: boolean;
    version: string | null;
    error: string | null;
}

import { MCPSettings } from '../settings/MCPSettings';

// ... (existing imports)

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

    const providerInfo: Record<LLMProvider, { name: string; description: string; icon: string; requiresApiKey: boolean; defaultModel: string }> = {
        ollama: {
            name: 'Ollama',
            description: 'Free, local AI. Runs on your machine.',
            icon: '🦙',
            requiresApiKey: false,
            defaultModel: 'k8s-cli',
        },
        'claude-code': {
            name: 'Claude Code',
            description: 'Use your existing Claude Code CLI. No API key needed.',
            icon: '💻',
            requiresApiKey: false,
            defaultModel: 'claude-code-cli',
        },
        openai: {
            name: 'OpenAI',
            description: 'GPT-4o and more. Requires API key.',
            icon: '🤖',
            requiresApiKey: true,
            defaultModel: 'gpt-4o',
        },
        anthropic: {
            name: 'Anthropic',
            description: 'Claude models. Requires API key.',
            icon: '🧠',
            requiresApiKey: true,
            defaultModel: 'claude-sonnet-4-20250514',
        },
        custom: {
            name: 'Custom',
            description: 'OpenAI-compatible endpoint (vLLM, etc.)',
            icon: '⚙️',
            requiresApiKey: false,
            defaultModel: 'default',
        },
    };

    const copyToClipboard = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedCommand(id);
        setTimeout(() => setCopiedCommand(null), 2000);
    };

    const checkClaudeCodeStatus = async () => {
        setCheckingClaudeCode(true);
        try {
            const result = await invoke<ClaudeCodeStatus>("check_claude_code_status");
            setClaudeCodeStatus(result);
        } catch (err) {
            setClaudeCodeStatus({
                available: false,
                version: null,
                error: String(err),
            });
        }
        setCheckingClaudeCode(false);
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

    const handleProviderChange = (provider: LLMProvider) => {
        const defaultConfig = DEFAULT_LLM_CONFIGS[provider];
        setLocalConfig({ ...defaultConfig, api_key: provider === localConfig.provider ? localConfig.api_key : null });
        setStatus(null);
    };

    const handleSave = () => {
        // Use default model if model field is empty
        const configToSave = {
            ...localConfig,
            model: localConfig.model.trim() || currentProviderInfo.defaultModel,
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

    const currentProviderInfo = providerInfo[localConfig.provider];

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
                        <div className="grid grid-cols-2 gap-2.5">
                            {(Object.keys(providerInfo) as LLMProvider[]).map(provider => (
                                <button
                                    key={provider}
                                    onClick={() => handleProviderChange(provider)}
                                    className={`relative p-3.5 rounded-xl text-left transition-all duration-200 border overflow-hidden group ${localConfig.provider === provider
                                        ? 'bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border-violet-500/50 shadow-lg shadow-purple-500/10'
                                        : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10'
                                        }`}
                                >
                                    {localConfig.provider === provider && (
                                        <div className="absolute top-2 right-2">
                                            <div className="w-5 h-5 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                                                <Check size={12} className="text-white" />
                                            </div>
                                        </div>
                                    )}
                                    <div className="flex items-center gap-2.5 mb-1.5">
                                        <span className="text-xl">{providerInfo[provider].icon}</span>
                                        <span className="font-semibold text-white text-sm">{providerInfo[provider].name}</span>
                                    </div>
                                    <p className="text-[11px] text-zinc-400 leading-relaxed">{providerInfo[provider].description}</p>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Connection Status */}
                    <div className="relative bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                {localConfig.provider === 'claude-code' ? (
                                    <>
                                        <div className={`relative w-3 h-3 rounded-full ${checking || checkingClaudeCode ? 'bg-amber-400' :
                                            claudeCodeStatus?.available ? 'bg-emerald-400' : 'bg-red-400'
                                            }`}>
                                            {(checking || checkingClaudeCode) && <div className="absolute inset-0 bg-amber-400 rounded-full animate-ping" />}
                                            {claudeCodeStatus?.available && <div className="absolute inset-0 bg-emerald-400 rounded-full animate-pulse opacity-50" />}
                                        </div>
                                        <div>
                                            <span className="text-sm font-medium text-white">Claude Code Status</span>
                                            {claudeCodeStatus && (
                                                <p className={`text-xs ${claudeCodeStatus.available ? 'text-emerald-400' : 'text-red-400'}`}>
                                                    {claudeCodeStatus.available
                                                        ? `Available ${claudeCodeStatus.version ? `(${claudeCodeStatus.version})` : ''}`
                                                        : (claudeCodeStatus.error || 'Not found')}
                                                </p>
                                            )}
                                        </div>
                                    </>
                                ) : (
                                    <>
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
                                    </>
                                )}
                            </div>
                            <button
                                onClick={checkConnection}
                                disabled={checking || checkingClaudeCode}
                                className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white transition-all disabled:opacity-50 font-medium"
                            >
                                {checking || checkingClaudeCode ? 'Testing...' : 'Test Connection'}
                            </button>
                        </div>
                    </div>

                    {/* Ollama Setup Instructions */}
                    {localConfig.provider === 'ollama' && status && !status.connected && (
                        <div className="relative bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-xl p-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <AlertCircle size={16} className="text-amber-400" />
                                <p className="text-sm text-amber-300 font-semibold">Ollama Setup Required</p>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 bg-black/20 rounded-lg p-2">
                                    <code className="flex-1 text-[11px] text-cyan-300 font-mono">brew install ollama && ollama serve</code>
                                    <button
                                        onClick={() => copyToClipboard('brew install ollama && ollama serve', 'install')}
                                        className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-all"
                                    >
                                        {copiedCommand === 'install' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                                    </button>
                                </div>
                                <div className="flex items-center gap-2 bg-black/20 rounded-lg p-2">
                                    <code className="flex-1 text-[11px] text-cyan-300 font-mono">ollama pull {localConfig.model}</code>
                                    <button
                                        onClick={() => copyToClipboard(`ollama pull ${localConfig.model}`, 'pull')}
                                        className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-all"
                                    >
                                        {copiedCommand === 'pull' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                                    </button>
                                </div>
                            </div>
                            <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1.5 transition-colors">
                                Visit ollama.com for more info <ExternalLink size={12} />
                            </a>
                        </div>
                    )}

                    {/* Claude Code Setup Instructions */}
                    {localConfig.provider === 'claude-code' && claudeCodeStatus && !claudeCodeStatus.available && (
                        <div className="relative bg-gradient-to-br from-violet-500/10 to-purple-500/10 border border-violet-500/20 rounded-xl p-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <Terminal size={16} className="text-violet-400" />
                                <p className="text-sm text-violet-300 font-semibold">Claude Code Setup Required</p>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 bg-black/20 rounded-lg p-2">
                                    <code className="flex-1 text-[11px] text-cyan-300 font-mono">npm install -g @anthropic-ai/claude-code</code>
                                    <button
                                        onClick={() => copyToClipboard('npm install -g @anthropic-ai/claude-code', 'install-claude')}
                                        className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-all"
                                    >
                                        {copiedCommand === 'install-claude' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                                    </button>
                                </div>
                                <p className="text-[11px] text-zinc-400">Then run <code className="text-cyan-300">claude</code> once in your terminal to authenticate.</p>
                            </div>
                            <a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" rel="noopener noreferrer" className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1.5 transition-colors">
                                Learn more about Claude Code <ExternalLink size={12} />
                            </a>
                        </div>
                    )}

                    {/* Claude Code Info when available */}
                    {localConfig.provider === 'claude-code' && claudeCodeStatus?.available && (
                        <div className="relative bg-gradient-to-br from-emerald-500/10 to-green-500/10 border border-emerald-500/20 rounded-xl p-4">
                            <div className="flex items-center gap-2">
                                <Terminal size={16} className="text-emerald-400" />
                                <p className="text-sm text-emerald-300 font-semibold">Claude Code Ready</p>
                            </div>
                            <p className="text-[11px] text-zinc-400 mt-2">
                                Using your terminal Claude Code installation. No API key needed - uses your existing authentication.
                            </p>
                        </div>
                    )}

                    {/* API Key */}
                    {currentProviderInfo.requiresApiKey && (
                        <div className="space-y-2.5">
                            <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">API Key</label>
                            <div className="relative">
                                <input
                                    type={showApiKey ? 'text' : 'password'}
                                    value={localConfig.api_key || ''}
                                    onChange={(e) => setLocalConfig({ ...localConfig, api_key: e.target.value || null })}
                                    placeholder={`Enter your ${currentProviderInfo.name} API key`}
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
                            <p className="text-[11px] text-zinc-500">
                                {localConfig.provider === 'openai' && 'Get your API key from platform.openai.com'}
                                {localConfig.provider === 'anthropic' && 'Get your API key from console.anthropic.com'}
                            </p>
                        </div>
                    )}

                    {/* Base URL - hide for Claude Code */}
                    {localConfig.provider !== 'claude-code' && (
                        <div className="space-y-2.5">
                            <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
                                Base URL
                                {localConfig.provider !== 'custom' && <span className="text-zinc-500 font-normal normal-case">(optional)</span>}
                            </label>
                            <input
                                type="text"
                                value={localConfig.base_url}
                                onChange={(e) => setLocalConfig({ ...localConfig, base_url: e.target.value })}
                                placeholder="API endpoint URL"
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all font-mono text-xs"
                            />
                        </div>
                    )}

                    {/* Hardware Recommendation for Ollama */}
                    {localConfig.provider === 'ollama' && systemSpecs && (
                        <div className="bg-white/5 rounded-lg p-3 text-xs border border-white/10">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-zinc-400 flex items-center gap-1.5"><Settings size={12} /> Hardware Detected</span>
                                <span className="text-zinc-200 font-mono">{systemSpecs.cpu_brand} ({Math.round(systemSpecs.total_memory / 1024 / 1024 / 1024)}GB RAM)</span>
                            </div>
                            {systemSpecs.is_apple_silicon && systemSpecs.total_memory > 17179869184 ? (
                                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/10">
                                    <Sparkles size={12} className="text-amber-400 flex-shrink-0" />
                                    <span className="text-amber-300/90 leading-relaxed">
                                        Your Mac is powerful! Switch model to <code className="bg-amber-500/20 px-1 rounded text-amber-200 border border-amber-500/30">qwen2.5:14b</code> for superior reasoning and deep dives.
                                    </span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/10">
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)] flex-shrink-0" />
                                    <span className="text-emerald-300/90 leading-relaxed">
                                        Recommended: <code className="bg-emerald-500/20 px-1 rounded text-emerald-200 border border-emerald-500/30">k8s-cli</code> (Llama 3.1 8B) for best speed/performance balance.
                                    </span>
                                </div>
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
                                    placeholder={currentProviderInfo.defaultModel}
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
                            disabled={currentProviderInfo.requiresApiKey && !localConfig.api_key}
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
