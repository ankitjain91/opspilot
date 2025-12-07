
import { useState, useEffect } from 'react';
import { Settings, X, Check, ExternalLink, Eye, EyeOff, ChevronRight, Copy, AlertCircle, Terminal } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { LLMConfig, LLMStatus, LLMProvider } from '../../types/ai';
import { DEFAULT_LLM_CONFIGS } from './constants';

interface ClaudeCodeStatus {
    available: boolean;
    version: string | null;
    error: string | null;
}

export function LLMSettingsPanel({
    config,
    onConfigChange,
    onClose
}: {
    config: LLMConfig;
    onConfigChange: (config: LLMConfig) => void;
    onClose: () => void;
}) {
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
            defaultModel: 'llama3.1:8b',
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
                        <p className="text-xs text-zinc-400">Configure your AI provider</p>
                    </div>
                </div>
                <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all">
                    <X size={18} />
                </button>
            </div>

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

            {/* Advanced Settings - hide for Claude Code */}
            {localConfig.provider !== 'claude-code' && <details className="group">
                <summary className="text-xs font-semibold text-zinc-400 uppercase tracking-wider cursor-pointer hover:text-zinc-300 flex items-center gap-2 transition-colors">
                    <ChevronRight size={14} className="transition-transform duration-200 group-open:rotate-90" />
                    Advanced Settings
                </summary>
                <div className="mt-4 space-y-5 pl-5 border-l-2 border-white/10">
                    {/* Model Override */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <label className="text-xs text-zinc-300 font-medium">Model Override</label>
                            <span className="text-[10px] text-zinc-500">Default: {currentProviderInfo.defaultModel}</span>
                        </div>
                        <input
                            type="text"
                            value={localConfig.model}
                            onChange={(e) => setLocalConfig({ ...localConfig, model: e.target.value })}
                            placeholder={currentProviderInfo.defaultModel}
                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:outline-none transition-all font-mono text-xs"
                        />
                        <p className="text-[10px] text-zinc-500">Leave empty to use the default. Only change if you know the exact model name.</p>
                    </div>

                    {/* Temperature */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="text-xs text-zinc-300 font-medium">Temperature</label>
                            <span className="text-xs text-violet-400 font-mono bg-violet-500/10 px-2 py-0.5 rounded-md">{localConfig.temperature.toFixed(2)}</span>
                        </div>
                        <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.1"
                            value={localConfig.temperature}
                            onChange={(e) => setLocalConfig({ ...localConfig, temperature: parseFloat(e.target.value) })}
                            className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-500"
                        />
                        <div className="flex justify-between text-[10px] text-zinc-500">
                            <span>Precise</span>
                            <span>Creative</span>
                        </div>
                    </div>

                    {/* Max Tokens */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="text-xs text-zinc-300 font-medium">Max Tokens</label>
                            <span className="text-xs text-violet-400 font-mono bg-violet-500/10 px-2 py-0.5 rounded-md">{localConfig.max_tokens}</span>
                        </div>
                        <input
                            type="range"
                            min="256"
                            max="8192"
                            step="256"
                            value={localConfig.max_tokens}
                            onChange={(e) => setLocalConfig({ ...localConfig, max_tokens: parseInt(e.target.value) })}
                            className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-500"
                        />
                    </div>
                </div>
            </details>}

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
        </div>
    );
}
