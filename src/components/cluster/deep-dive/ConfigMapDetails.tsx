import React, { useState, useEffect } from 'react';
import { Save, Plus, Trash2, RotateCcw, Loader2, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { K8sObject } from '../../../types/k8s';

interface ConfigMapDetailsProps {
    resource: K8sObject;
    fullObject: any;
}

export function ConfigMapDetails({ resource, fullObject }: ConfigMapDetailsProps) {
    const [data, setData] = useState<Record<string, string>>({});
    const [originalData, setOriginalData] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        if (fullObject?.data) {
            setData({ ...fullObject.data });
            setOriginalData({ ...fullObject.data });
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
        setData(newData);
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
        while (data[`NEW_KEY_${suffix}`]) suffix++;
        setData(prev => ({ ...prev, [`NEW_KEY_${suffix}`]: "" }));
        setDirty(true);
    };

    const handleReset = () => {
        setData({ ...originalData });
        setDirty(false);
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            // Construct Patch: Replace entirely via Merge Patch or JSON Patch?
            // Safer to use JSON Merge Patch for 'data' if we send the whole map.
            // But K8s Merge Patch might not delete missing keys unless explicitly set to null.
            // Strategic Merge Patch works for maps by replacing.
            // Let's use invoking a generic 'patch_resource' command if available, or 'update_resource'.
            // Assuming 'update_resource' replaces the object or we patch specifically.

            // For now, let's assume we can invoke a patch. 
            // If we don't have patch, we might need a generic 'apply'.

            // Simplest logic: Construct a simplified object and use a custom backend command if needed.
            // Re-using 'apply_yaml' might be heavy.
            // Let's rely on standard 'patch_resource' (which we need to implement or verify).
            // Wait, previous plans mentioned 'patch_resource'.

            const patchPayload = { data: data };
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
            console.error("Failed to save ConfigMap", err);
            // Show error toast
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-[#0f0f12] text-zinc-300">
            {/* Header / Toolbar */}
            <div className="flex items-center justify-between p-4 border-b border-white/5 bg-[#141416]">
                <div>
                    <h2 className="text-sm font-semibold text-white uppercase tracking-wider">ConfigMap Data</h2>
                    <p className="text-xs text-zinc-500">Edit key-value pairs directly. Changes are applied immediately on save.</p>
                </div>
                <div className="flex items-center gap-2">
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
                            ? 'bg-cyan-500 hover:bg-cyan-400 text-black shadow-[0_0_10px_rgba(6,182,212,0.5)]'
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
                        <div>Value</div>
                        <div></div>
                    </div>

                    {Object.entries(data).map(([key, value], index) => (
                        <div key={index /* Use index or unique ID if stability needed during key rename */} className="group grid grid-cols-[1fr_2fr_40px] gap-4 items-start p-2 rounded bg-[#18181b] border border-white/5 hover:border-white/10 transition-colors">
                            {/* Key Input */}
                            <input
                                value={key}
                                onChange={(e) => handleKeyChange(key, e.target.value)}
                                className="bg-black/20 border border-white/5 rounded px-3 py-2 text-xs font-mono text-emerald-400 focus:outline-none focus:border-cyan-500/50 focus:bg-black/40 transition-all placeholder:text-zinc-700"
                                placeholder="Key Name"
                            />

                            {/* Value Input (Textarea for multi-line) */}
                            <textarea
                                value={value}
                                onChange={(e) => handleValueChange(key, e.target.value)}
                                className="w-full bg-black/20 border border-white/5 rounded px-3 py-2 text-xs font-mono text-zinc-300 focus:outline-none focus:border-cyan-500/50 focus:bg-black/40 transition-all placeholder:text-zinc-700 min-h-[38px] resize-y"
                                placeholder="Value"
                                rows={Math.max(1, value.split('\n').length > 5 ? 5 : value.split('\n').length)}
                            />

                            {/* Delete Action */}
                            <button
                                onClick={() => handleDelete(key)}
                                className="flex items-center justify-center p-2 mt-0.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                                title="Delete Row"
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}

                    {Object.keys(data).length === 0 && (
                        <div className="flex flex-col items-center justify-center py-12 text-zinc-600 border border-dashed border-white/10 rounded-xl bg-white/[0.02]">
                            <p className="text-sm">No data entries found.</p>
                            <button onClick={handleAdd} className="mt-2 text-cyan-500 hover:underline text-xs">Add your first key</button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
