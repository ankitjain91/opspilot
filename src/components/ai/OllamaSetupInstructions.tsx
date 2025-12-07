import { useState } from 'react';
import { Sparkles, Check, Copy, ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';
import { OllamaStatus } from '../../types/ai';

interface InstallStep {
    label: string;
    command?: string;
    link?: string;
}

interface PlatformConfig {
    name: string;
    icon: string;
    installSteps: InstallStep[];
    startCommand: string;
    pullCommand: string;
}

export function OllamaSetupInstructions({ status, onRetry }: { status: OllamaStatus | null, onRetry: () => void }) {
    const [selectedPlatform, setSelectedPlatform] = useState<'macos' | 'windows' | 'linux'>('macos');
    const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

    const copyToClipboard = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedCommand(id);
        setTimeout(() => setCopiedCommand(null), 2000);
    };

    const platforms: Record<'macos' | 'windows' | 'linux', PlatformConfig> = {
        macos: {
            name: 'macOS',
            icon: '🍎',
            installSteps: [
                { label: 'Install via Homebrew', command: 'brew install ollama' },
                { label: 'Or download from', link: 'https://ollama.com/download/mac' },
            ],
            startCommand: 'ollama serve',
            pullCommand: 'ollama pull llama3.1:8b',
        },
        windows: {
            name: 'Windows',
            icon: '🪟',
            installSteps: [
                { label: 'Download installer from', link: 'https://ollama.com/download/windows' },
                { label: 'Or via winget', command: 'winget install Ollama.Ollama' },
            ],
            startCommand: 'ollama serve',
            pullCommand: 'ollama pull llama3.1:8b',
        },
        linux: {
            name: 'Linux',
            icon: '🐧',
            installSteps: [
                { label: 'Install script', command: 'curl -fsSL https://ollama.com/install.sh | sh' },
            ],
            startCommand: 'ollama serve',
            pullCommand: 'ollama pull llama3.1:8b',
        },
    };

    const platform = platforms[selectedPlatform];

    return (
        <div className="p-4 space-y-4">
            {/* Header */}
            <div className="text-center">
                <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-orange-500/20 to-red-500/20 flex items-center justify-center border border-orange-500/30">
                    <Sparkles size={32} className="text-orange-400" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-1">AI Setup Required</h3>
                <p className="text-sm text-zinc-400">
                    OpsPilot uses Ollama for local AI. Let's get you set up!
                </p>
            </div>

            {/* Status Indicators */}
            <div className="bg-zinc-800/50 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${status?.ollama_running ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="text-sm text-zinc-300">Ollama Service</span>
                    <span className={`text-xs ml-auto ${status?.ollama_running ? 'text-green-400' : 'text-red-400'}`}>
                        {status?.ollama_running ? 'Running' : 'Not Running'}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${status?.model_available ? 'bg-green-500' : 'bg-yellow-500'}`} />
                    <span className="text-sm text-zinc-300">llama3.1:8b Model</span>
                    <span className={`text-xs ml-auto ${status?.model_available ? 'text-green-400' : 'text-yellow-400'}`}>
                        {status?.model_available ? 'Available' : 'Not Installed'}
                    </span>
                </div>
                {status?.available_models && status.available_models.length > 0 && (
                    <div className="text-xs text-zinc-500 pt-1 border-t border-zinc-700">
                        Installed models: {status.available_models.join(', ')}
                    </div>
                )}
            </div>

            {/* Platform Selector */}
            <div className="flex gap-2">
                {(Object.keys(platforms) as Array<'macos' | 'windows' | 'linux'>).map(p => (
                    <button
                        key={p}
                        onClick={() => setSelectedPlatform(p)}
                        className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all ${selectedPlatform === p
                            ? 'bg-purple-500/20 border border-purple-500/50 text-purple-300'
                            : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border border-transparent'
                            }`}
                    >
                        <span className="mr-1">{platforms[p].icon}</span>
                        {platforms[p].name}
                    </button>
                ))}
            </div>

            {/* Installation Steps */}
            <div className="space-y-3">
                {/* Step 1: Install Ollama */}
                {!status?.ollama_running && (
                    <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 text-xs flex items-center justify-center font-bold">1</span>
                            <span className="text-sm font-medium text-white">Install Ollama</span>
                        </div>
                        {platform.installSteps.map((step, i) => (
                            <div key={i} className="ml-7 mb-2 last:mb-0">
                                {step.command ? (
                                    <div className="flex items-center gap-2">
                                        <code className="flex-1 text-xs bg-black/40 px-2 py-1.5 rounded text-cyan-300 font-mono">{step.command}</code>
                                        <button
                                            onClick={() => copyToClipboard(step.command!, `install-${i}`)}
                                            className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
                                        >
                                            {copiedCommand === `install-${i}` ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                                        </button>
                                    </div>
                                ) : (
                                    <a
                                        href={step.link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
                                    >
                                        {step.label} <ExternalLink size={12} />
                                    </a>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Step 2: Start Ollama */}
                {!status?.ollama_running && (
                    <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 text-xs flex items-center justify-center font-bold">2</span>
                            <span className="text-sm font-medium text-white">Start Ollama</span>
                        </div>
                        <div className="ml-7 flex items-center gap-2">
                            <code className="flex-1 text-xs bg-black/40 px-2 py-1.5 rounded text-cyan-300 font-mono">{platform.startCommand}</code>
                            <button
                                onClick={() => copyToClipboard(platform.startCommand, 'start')}
                                className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
                            >
                                {copiedCommand === 'start' ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                            </button>
                        </div>
                        <p className="ml-7 mt-1 text-xs text-zinc-500">
                            Or launch the Ollama app (it runs in the background)
                        </p>
                    </div>
                )}

                {/* Step 3: Pull Model */}
                {status?.ollama_running && !status?.model_available && (
                    <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-5 h-5 rounded-full bg-green-500/20 text-green-400 text-xs flex items-center justify-center font-bold">✓</span>
                            <span className="text-sm font-medium text-white">Ollama is running!</span>
                        </div>
                        <div className="flex items-center gap-2 mb-2 mt-3">
                            <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 text-xs flex items-center justify-center font-bold">2</span>
                            <span className="text-sm font-medium text-white">Pull the AI model</span>
                        </div>
                        <div className="ml-7 flex items-center gap-2">
                            <code className="flex-1 text-xs bg-black/40 px-2 py-1.5 rounded text-cyan-300 font-mono">{platform.pullCommand}</code>
                            <button
                                onClick={() => copyToClipboard(platform.pullCommand, 'pull')}
                                className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
                            >
                                {copiedCommand === 'pull' ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                            </button>
                        </div>
                        <p className="ml-7 mt-1 text-xs text-zinc-500">
                            This downloads ~4.7GB model (one-time setup)
                        </p>
                    </div>
                )}
            </div>

            {/* Retry Button */}
            <button
                onClick={onRetry}
                className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white font-medium text-sm transition-all flex items-center justify-center gap-2"
            >
                <RefreshCw size={16} />
                Check Again
            </button>

            {/* Help Link */}
            <p className="text-center text-xs text-zinc-500">
                Need help? Visit{' '}
                <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300">
                    ollama.com
                </a>
            </p>
        </div>
    );
}
