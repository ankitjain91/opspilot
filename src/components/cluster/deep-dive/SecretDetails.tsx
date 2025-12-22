import React, { useState, useEffect } from 'react';
import { Save, Plus, Trash2, RotateCcw, Loader2, Check, Eye, EyeOff } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { K8sObject } from '../../../types/k8s';

interface SecretDetailsProps {
    resource: K8sObject;
    fullObject: any;
}

export function SecretDetails({ resource, fullObject }: SecretDetailsProps) {
    const [data, setData] = useState<Record<string, string>>({}); // Stores DECODED values
    const [originalData, setOriginalData] = useState<Record<string, string>>({}); // Stores DECODED values
    const [rawMap, setRawMap] = useState<Record<string, boolean>>({}); // Track which keys failed to decode (keep raw)
    const [showValues, setShowValues] = useState(false);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [success, setSuccess] = useState(false);

    // Helper: Safe Decode
    const safeDecode = (b64: string) => {
        try {
            return atob(b64);
        } catch (e) {
            return b64; // Return raw if decode fails
        }
    };

    // Helper: Safe Encode
    const safeEncode = (val: string, isRaw: boolean) => {
        if (isRaw) return val; // Don't double encode if it was already raw
        try {
            return btoa(val);
        } catch (e) {
            return val;
        }
    };

    useEffect(() => {
        if (fullObject?.data) {
            const decoded: Record<string, string> = {};
            const raw: Record<string, boolean> = {};

            Object.entries(fullObject.data).forEach(([k, v]) => {
                const val = String(v);
                try {
                    decoded[k] = atob(val);
                } catch (e) {
                    decoded[k] = val; // Keep raw
                    raw[k] = true;
                }
            });

            setData(decoded);
            setOriginalData({ ...decoded });
            setRawMap(raw);
            setDirty(false);
        } else {
            setData({});
            setOriginalData({});
        }
    }, [fullObject]);

    const handleKeyChange = (oldKey: string, newKey: string) => {
        if (oldKey === newKey) return;
        const newData = { ...data };
        const value = newData[oldKey];
        delete newData[oldKey];
        newData[newKey] = value;

        // Preserve raw state if moving
        const newRaw = { ...rawMap };
        if (newRaw[oldKey]) {
            delete newRaw[oldKey];
            newRaw[newKey] = true;
        }

        setData(newData);
        setRawMap(newRaw);
        setDirty(true);
    };

    const handleValueChange = (key: string, value: string) => {
        setData(prev => ({ ...prev, [key]: value }));
        setDirty(true);
    };

    const handleDelete = (key: string) => {
        const newData = { ...data };
        delete newData[key];
        setData(newData);
        setDirty(true);
    };

    const handleAdd = () => {
        let suffix = 1;
        while (data[`NEW_SECRET_${suffix}`]) suffix++;
        setData(prev => ({ ...prev, [`NEW_SECRET_${suffix}`]: "" }));
        setDirty(true);
    };

    const handleReset = () => {
        setData({ ...originalData });
        setDirty(false);
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            // Re-encode everything
            const encodedData: Record<string, string> = {};
            Object.entries(data).forEach(([k, v]) => {
                encodedData[k] = safeEncode(v, !!rawMap[k]);
            });

            const patchPayload = { data: encodedData };
            // Construct proper apiVersion
            const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;

            await invoke("patch_resource", {
                namespace: resource.namespace,
                kind: resource.kind,
                name: resource.name,
                apiVersion,
                patchData: patchPayload
            });

            setOriginalData({ ...data });
            setDirty(false);
            setSuccess(true);
            setTimeout(() => setSuccess(false), 2000);
        } catch (err) {
            console.error("Failed to save Secret", err);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-[#0f0f12] text-zinc-300">
            {/* Header / Toolbar */}
            <div className="flex items-center justify-between p-4 border-b border-white/5 bg-[#141416]">
                <div>
                    <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
                        Secret Data
                        <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 text-[10px] font-bold">ENCRYPTED</span>
                    </h2>
                    <p className="text-xs text-zinc-500">Values are shown decoded. They will be base64 encoded on save.</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowValues(!showValues)}
                        className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded transition-colors mr-2"
                        title={showValues ? "Hide Values" : "Reveal Values"}
                    >
                        {showValues ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>

                    {dirty && (
                        <button
                            onClick={handleReset}
                            className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                            title="Reset Changes"
                        >
                            <RotateCcw size={16} />
                        </button>
                    )}
                    <button
                        onClick={handleAdd}
                        className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-xs font-medium transition-colors"
                    >
                        <Plus size={14} /> Add Key
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!dirty || saving}
                        className={`flex items-center gap-2 px-4 py-1.5 rounded text-xs font-bold transition-all ${dirty
                            ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_10px_rgba(147,51,234,0.5)]'
                            : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                            }`}
                    >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : success ? <Check size={14} /> : <Save size={14} />}
                        {success ? 'Saved' : 'Save Changes'}
                    </button>
                </div>
            </div>

            {/* Table Editor */}
            <div className="flex-1 overflow-y-auto p-4 content-start">
                <div className="w-full max-w-5xl mx-auto space-y-2">
                    <div className="grid grid-cols-[1fr_2fr_40px] gap-4 px-2 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                        <div>Key</div>
                        <div>Value (Decoded)</div>
                        <div></div>
                    </div>

                    {Object.entries(data).map(([key, value], index) => {
                        const isRaw = rawMap[key];
                        return (
                            <div key={index} className="group grid grid-cols-[1fr_2fr_40px] gap-4 items-start p-2 rounded bg-[#18181b] border border-white/5 hover:border-white/10 transition-colors">
                                {/* Key Input */}
                                <input
                                    value={key}
                                    onChange={(e) => handleKeyChange(key, e.target.value)}
                                    className="bg-black/20 border border-white/5 rounded px-3 py-2 text-xs font-mono text-purple-300 focus:outline-none focus:border-purple-500/50 focus:bg-black/40 transition-all placeholder:text-zinc-700"
                                    placeholder="Key Name"
                                />

                                {/* Value Input */}
                                <div className="relative">
                                    <textarea
                                        value={value}
                                        onChange={(e) => handleValueChange(key, e.target.value)}
                                        readOnly={!showValues} // Prevent editing if hidden to avoid accidents
                                        className={`w-full bg-black/20 border border-white/5 rounded px-3 py-2 text-xs font-mono focus:outline-none focus:border-purple-500/50 focus:bg-black/40 transition-all placeholder:text-zinc-700 min-h-[38px] resize-y ${showValues ? 'text-zinc-300' : 'text-zinc-700 blur-[4px] select-none cursor-default'
                                            } ${isRaw ? 'text-yellow-500/80 italic' : ''}`}
                                        placeholder="Value"
                                        rows={Math.max(1, String(value).split('\n').length > 5 ? 5 : String(value).split('\n').length)}
                                    />
                                    {!showValues && (
                                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest bg-black/50 px-2 py-1 rounded backdrop-blur-sm">Hidden</span>
                                        </div>
                                    )}
                                </div>

                                {/* Delete Action */}
                                <button
                                    onClick={() => handleDelete(key)}
                                    className="flex items-center justify-center p-2 mt-0.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                                    title="Delete Row"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        );
                    })}

                    {Object.keys(data).length === 0 && (
                        <div className="flex flex-col items-center justify-center py-12 text-zinc-600 border border-dashed border-white/10 rounded-xl bg-white/[0.02]">
                            <p className="text-sm">No secret data.</p>
                            <button onClick={handleAdd} className="mt-2 text-purple-500 hover:underline text-xs">Add your first secret</button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
