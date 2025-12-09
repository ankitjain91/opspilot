
import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileCog, Shield, Copy, Eye, EyeOff, Search, Code, Check, FileText, Lock, Unlock, X, Sparkles, Loader2 } from 'lucide-react';
import { CollapsibleSection } from '../shared';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ConfigDetailsProps {
    fullObject: any;
    kind: string; // "ConfigMap" or "Secret"
}

// AI Analysis Modal Component
function AnalysisModal({ isOpen, onClose, keyName, analysis, loading }: {
    isOpen: boolean;
    onClose: () => void;
    keyName: string;
    analysis: string;
    loading: boolean;
}) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div
                className="bg-zinc-900 border border-purple-500/30 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-purple-500/20 bg-gradient-to-r from-purple-500/10 to-zinc-900">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-purple-500/20 rounded-lg">
                            <Sparkles size={18} className="text-purple-400" />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-white">AI Analysis</h3>
                            <p className="text-sm text-zinc-400 font-mono">{keyName}</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-12 text-zinc-400">
                            <Loader2 size={32} className="animate-spin text-purple-400 mb-4" />
                            <p className="text-sm">Analyzing content...</p>
                        </div>
                    ) : (
                        <div className="bg-zinc-800/50 rounded-xl p-5 border border-zinc-700/50">
                            <div className="prose prose-invert prose-sm max-w-none">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        p: ({ children }) => <p className="text-sm text-zinc-200 my-2 leading-relaxed">{children}</p>,
                                        strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                                        em: ({ children }) => <em className="text-purple-300 italic">{children}</em>,
                                        code: ({ children }) => <code className="text-xs bg-zinc-900/80 px-1.5 py-0.5 rounded text-cyan-300 font-mono">{children}</code>,
                                        pre: ({ children }) => <pre className="bg-zinc-900/80 rounded-lg p-3 my-3 overflow-x-auto">{children}</pre>,
                                        ul: ({ children }) => <ul className="text-sm list-disc list-inside ml-2 my-2 space-y-1">{children}</ul>,
                                        ol: ({ children }) => <ol className="text-sm list-decimal list-inside ml-2 my-2 space-y-1">{children}</ol>,
                                        li: ({ children }) => <li className="text-zinc-200">{children}</li>,
                                        h1: ({ children }) => <h1 className="text-lg font-bold text-white mt-4 mb-2">{children}</h1>,
                                        h2: ({ children }) => <h2 className="text-base font-bold text-purple-300 mt-3 mb-2">{children}</h2>,
                                        h3: ({ children }) => <h3 className="text-sm font-semibold text-cyan-300 mt-2 mb-1">{children}</h3>,
                                        blockquote: ({ children }) => <blockquote className="border-l-4 border-purple-500/50 pl-4 my-3 text-zinc-400 italic">{children}</blockquote>,
                                        a: ({ href, children }) => <a href={href} className="text-cyan-400 hover:text-cyan-300 underline">{children}</a>,
                                    }}
                                >
                                    {analysis}
                                </ReactMarkdown>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/50 flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

export function ConfigDetails({ fullObject, kind }: ConfigDetailsProps) {
    const data = fullObject?.data || {};
    const binaryData = fullObject?.binaryData || {};
    const [showSecretMap, setShowSecretMap] = useState<Record<string, boolean>>({});
    const [decodedMap, setDecodedMap] = useState<Record<string, boolean>>({});
    const [analyzingKey, setAnalyzingKey] = useState<string | null>(null);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const [analysisModal, setAnalysisModal] = useState<{ open: boolean; key: string; content: string; loading: boolean }>({
        open: false,
        key: '',
        content: '',
        loading: false
    });

    const toggleSecret = (key: string) => {
        setShowSecretMap(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const toggleDecode = (key: string) => {
        setDecodedMap(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const copyToClipboard = async (key: string, text: string) => {
        await navigator.clipboard.writeText(text);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
        if ((window as any).showToast) {
            (window as any).showToast('Copied to clipboard', 'success');
        }
    };

    const analyzeSecret = async (key: string, value: string) => {
        // Open modal immediately with loading state
        setAnalysisModal({ open: true, key, content: '', loading: true });
        setAnalyzingKey(key);

        try {
            // Decode if base64 for secrets
            let text = value;
            if (kind === 'Secret') {
                try { text = atob(value); } catch { }
            }

            const analysis = await invoke<string>("analyze_text", { text, context: `Key: ${key} in ${kind}` });
            setAnalysisModal(prev => ({ ...prev, content: analysis, loading: false }));
        } catch (err: any) {
            console.error(err);
            setAnalysisModal(prev => ({ ...prev, content: `Error: ${err.toString()}`, loading: false }));
        } finally {
            setAnalyzingKey(null);
        }
    };

    const formatSize = (str: string) => {
        if (!str) return '0 B';
        const bytes = str.length;
        if (bytes < 1024) return `${bytes} B`;
        return `${(bytes / 1024).toFixed(1)} KB`;
    };

    // Decode base64 safely
    const decodeBase64 = (str: string): string => {
        try {
            return atob(str);
        } catch {
            return str;
        }
    };

    // Get the display value based on decode state and secret visibility
    const getDisplayValue = (key: string, value: string, isSecret: boolean): string => {
        const isHidden = isSecret && !showSecretMap[key];
        if (isHidden) return '••••••••••••••••';

        // For secrets, check if we should show decoded
        if (isSecret && decodedMap[key]) {
            return decodeBase64(value);
        }
        return value;
    };

    // Get the value for copying (always decoded for secrets if decode is on)
    const getCopyValue = (key: string, value: string, isSecret: boolean): string => {
        if (isSecret && decodedMap[key]) {
            return decodeBase64(value);
        }
        return value;
    };

    const entries: Array<{ key: string; value: string; from: 'data' | 'binary' }> = [
        ...Object.entries(data).map(([k, v]) => ({ key: k, value: String(v), from: 'data' as const })),
        ...Object.entries(binaryData).map(([k, v]) => {
            return { key: k, value: String(v), from: 'binary' as const };
        }),
    ];

    const secretType = fullObject?.type;
    const isSecret = kind === 'Secret';

    return (
        <>
            {/* AI Analysis Modal */}
            <AnalysisModal
                isOpen={analysisModal.open}
                onClose={() => setAnalysisModal(prev => ({ ...prev, open: false }))}
                keyName={analysisModal.key}
                analysis={analysisModal.content}
                loading={analysisModal.loading}
            />

            <CollapsibleSection
                title={isSecret ? 'Secret Data' : 'ConfigMap Data'}
                icon={isSecret ? <Shield size={16} className="text-amber-400" /> : <FileCog size={16} className="text-blue-400" />}
            >
                <div className="space-y-4">
                    {/* Secret Type Badge */}
                    {isSecret && secretType && (
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-sm text-zinc-500">Type:</span>
                            <span className="px-2.5 py-1 rounded-lg text-sm font-mono bg-amber-500/10 text-amber-300 border border-amber-500/30">
                                {secretType}
                            </span>
                        </div>
                    )}

                    {/* Summary Stats */}
                    <div className="flex items-center gap-4 text-sm text-zinc-400 pb-3 border-b border-zinc-800">
                        <span className="flex items-center gap-2">
                            <FileText size={16} />
                            <span className="font-medium">{entries.length} {entries.length === 1 ? 'key' : 'keys'}</span>
                        </span>
                        {isSecret && (
                            <span className="flex items-center gap-2 text-amber-400">
                                <Lock size={16} />
                                <span>Base64 encoded</span>
                            </span>
                        )}
                    </div>

                    {entries.length === 0 && (
                        <div className="text-center py-8 text-zinc-500">
                            <FileText size={32} className="mx-auto mb-3 opacity-40" />
                            <span className="text-sm">No data in this {kind}</span>
                        </div>
                    )}

                    {entries.map(({ key, value, from }) => {
                        const isHidden = isSecret && !showSecretMap[key];
                        const isDecoded = decodedMap[key];
                        const displayValue = getDisplayValue(key, value, isSecret);
                        const copyValue = getCopyValue(key, value, isSecret);
                        const decodedValue = decodeBase64(value);
                        const decodedSize = formatSize(decodedValue);
                        const rawSize = formatSize(value);

                        return (
                            <div key={key} className="border border-zinc-700/50 rounded-xl overflow-hidden bg-zinc-900/50 hover:border-zinc-600/50 transition-colors">
                                {/* Header */}
                                <div className="flex items-center justify-between px-4 py-3 bg-zinc-800/50 border-b border-zinc-700/50">
                                    <div className="flex items-center gap-3 overflow-hidden min-w-0">
                                        <span className="font-mono text-sm text-white font-semibold truncate">{key}</span>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                                                from === 'binary'
                                                    ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                                                    : 'bg-zinc-700/50 text-zinc-400 border border-zinc-600/50'
                                            }`}>
                                                {from === 'binary' ? 'binary' : 'text'}
                                            </span>
                                            <span className="text-xs text-zinc-500">
                                                {isSecret && isDecoded ? decodedSize : rawSize}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Action Buttons */}
                                    <div className="flex items-center gap-1 shrink-0">
                                        {/* Decode button - only for secrets */}
                                        {isSecret && (
                                            <button
                                                onClick={() => toggleDecode(key)}
                                                className={`p-2 rounded-lg transition-colors ${
                                                    isDecoded
                                                        ? 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30'
                                                        : 'hover:bg-zinc-700 text-zinc-400 hover:text-white'
                                                }`}
                                                title={isDecoded ? "Show Base64" : "Decode Base64"}
                                            >
                                                <Code size={16} />
                                            </button>
                                        )}

                                        {/* Show/Hide for secrets */}
                                        {isSecret && (
                                            <button
                                                onClick={() => toggleSecret(key)}
                                                className={`p-2 rounded-lg transition-colors ${
                                                    !isHidden
                                                        ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                                                        : 'hover:bg-zinc-700 text-zinc-400 hover:text-white'
                                                }`}
                                                title={isHidden ? "Reveal Value" : "Hide Value"}
                                            >
                                                {isHidden ? <Eye size={16} /> : <EyeOff size={16} />}
                                            </button>
                                        )}

                                        {/* Copy button */}
                                        <button
                                            onClick={() => copyToClipboard(key, copyValue)}
                                            className={`p-2 rounded-lg transition-colors ${
                                                copiedKey === key
                                                    ? 'bg-green-500/20 text-green-400'
                                                    : 'hover:bg-zinc-700 text-zinc-400 hover:text-white'
                                            }`}
                                            title={isSecret && isDecoded ? "Copy Decoded Value" : "Copy Value"}
                                        >
                                            {copiedKey === key ? <Check size={16} /> : <Copy size={16} />}
                                        </button>

                                        {/* AI Analyze button */}
                                        <button
                                            onClick={() => analyzeSecret(key, value)}
                                            disabled={analyzingKey === key}
                                            className={`p-2 rounded-lg transition-colors ${
                                                analyzingKey === key
                                                    ? 'bg-purple-500/20 text-purple-400 animate-pulse'
                                                    : 'hover:bg-zinc-700 text-zinc-400 hover:text-purple-400'
                                            }`}
                                            title="AI Analyze"
                                        >
                                            <Search size={16} />
                                        </button>
                                    </div>
                                </div>

                                {/* Value Content */}
                                <div className="p-4 bg-zinc-900/30">
                                    {/* Decode indicator */}
                                    {isSecret && isDecoded && !isHidden && (
                                        <div className="flex items-center gap-2 mb-3 text-sm text-cyan-400">
                                            <Unlock size={14} />
                                            <span>Showing decoded value</span>
                                        </div>
                                    )}

                                    <pre className={`font-mono text-sm leading-relaxed whitespace-pre-wrap break-all ${
                                        isHidden ? 'text-zinc-600' : 'text-zinc-200'
                                    }`}>
                                        {displayValue.slice(0, 5000)}{displayValue.length > 5000 ? '\n...(truncated)' : ''}
                                    </pre>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </CollapsibleSection>
        </>
    );
}
