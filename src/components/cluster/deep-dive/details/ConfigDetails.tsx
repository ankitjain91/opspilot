
import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileCog, Shield, Copy, Eye, EyeOff, Search } from 'lucide-react';
import { CollapsibleSection } from '../shared';

interface ConfigDetailsProps {
    fullObject: any;
    kind: string; // "ConfigMap" or "Secret"
}

export function ConfigDetails({ fullObject, kind }: ConfigDetailsProps) {
    const data = fullObject?.data || {};
    const [showSecretMap, setShowSecretMap] = useState<Record<string, boolean>>({});
    const [analyzingKey, setAnalyzingKey] = useState<string | null>(null);

    const toggleSecret = (key: string) => {
        setShowSecretMap(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        if ((window as any).showToast) {
            (window as any).showToast('Copied to clipboard', 'success');
        }
    };

    const analyzeSecret = async (key: string, value: string) => {
        setAnalyzingKey(key);
        try {
            // Decode if base64 (simple heuristic: has no spaces, valid base64 chars)
            let text = value;
            if (kind === 'Secret') {
                try { text = atob(value); } catch { }
            }

            const analysis = await invoke<string>("analyze_text", { text, context: `Key: ${key} in ${kind}` });
            if ((window as any).showToast) {
                (window as any).showToast(`Analysis: ${analysis}`, 'info', 8000);
            } else {
                alert(`Analysis: ${analysis}`);
            }
        } catch (err) {
            console.error(err);
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

    return (
        <CollapsibleSection title={kind === 'Secret' ? 'Secret Data' : 'Data'} icon={kind === 'Secret' ? <Shield size={14} /> : <FileCog size={14} />}>
            <div className="space-y-2">
                {Object.keys(data).length === 0 && <span className="text-[#858585] text-xs italic">No data</span>}
                {Object.entries(data).map(([k, v]) => {
                    const valStr = String(v);
                    const isHidden = kind === 'Secret' && !showSecretMap[k];
                    return (
                        <div key={k} className="border border-[#3e3e42] rounded overflow-hidden bg-[#1e1e1e]">
                            <div className="flex items-center justify-between px-3 py-2 bg-[#252526] border-b border-[#3e3e42]">
                                <div className="flex items-center gap-2 overflow-hidden">
                                    <span className="font-mono text-xs text-[#cccccc] font-bold truncate">{k}</span>
                                    <span className="px-1.5 py-0.5 rounded text-[9px] bg-[#3e3e42] text-[#858585]">{formatSize(valStr)}</span>
                                </div>
                                <div className="flex items-center gap-1">
                                    {kind === 'Secret' && (
                                        <button
                                            onClick={() => toggleSecret(k)}
                                            className="p-1 hover:bg-[#3e3e42] rounded text-[#858585] hover:text-[#cccccc] transition-colors"
                                            title={isHidden ? "Show Value" : "Hide Value"}
                                        >
                                            {isHidden ? <Eye size={12} /> : <EyeOff size={12} />}
                                        </button>
                                    )}
                                    <button
                                        onClick={() => copyToClipboard(valStr)}
                                        className="p-1 hover:bg-[#3e3e42] rounded text-[#858585] hover:text-[#cccccc] transition-colors"
                                        title="Copy Value"
                                    >
                                        <Copy size={12} />
                                    </button>
                                    <button
                                        onClick={() => analyzeSecret(k, valStr)}
                                        disabled={analyzingKey === k}
                                        className={`p-1 hover:bg-[#3e3e42] rounded text-[#858585] hover:text-purple-400 transition-colors ${analyzingKey === k ? 'animate-pulse text-purple-400' : ''}`}
                                        title="AI Analyze"
                                    >
                                        <Search size={12} />
                                    </button>
                                </div>
                            </div>
                            <div className="p-3 bg-[#1e1e1e] overflow-x-auto">
                                <pre className="font-mono text-[10px] text-[#cccccc] leading-relaxed whitespace-pre-wrap break-all">
                                    {isHidden ? '••••••••' : valStr.slice(0, 1000) + (valStr.length > 1000 ? '...' : '')}
                                </pre>
                            </div>
                        </div>
                    );
                })}
            </div>
        </CollapsibleSection>
    );
}
