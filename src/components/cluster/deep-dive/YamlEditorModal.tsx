import React, { useState, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { X, Save, AlertCircle, Loader2, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';
import { K8sObject } from '../../../types/k8s';

interface YamlEditorModalProps {
    isOpen: boolean;
    onClose: () => void;
    resource: K8sObject;
    currentContext?: string;
    onSuccess?: () => void;
}

export function YamlEditorModal({ isOpen, onClose, resource, currentContext, onSuccess }: YamlEditorModalProps) {
    const [yamlContent, setYamlContent] = useState<string>('');
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const qc = useQueryClient();

    // Fetch YAML content when modal opens
    useEffect(() => {
        if (isOpen && resource) {
            loadYaml();
        }
    }, [isOpen, resource]);

    // Handle Esc key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };

        if (isOpen) {
            window.addEventListener('keydown', handleKeyDown);
        }
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    const loadYaml = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const content = await invoke<string>('get_resource_details', {
                req: {
                    group: resource.group,
                    version: resource.version,
                    kind: resource.kind,
                    namespace: resource.namespace === '-' ? null : resource.namespace
                },
                name: resource.name
            });
            setYamlContent(content);
        } catch (err: any) {
            setError(err.toString());
        } finally {
            setIsLoading(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        setError(null);
        setSaveSuccess(false);
        try {
            // apply_yaml now returns the updated YAML directly
            const updatedYaml = await invoke<string>('apply_yaml', {
                namespace: resource.namespace === '-' ? '' : resource.namespace,
                kind: resource.kind,
                name: resource.name,
                yamlContent: yamlContent
            });

            // Immediately update the cache with server response
            // Use normalized namespace (null for cluster-scoped resources marked with '-')
            const normalizedNamespace = resource.namespace !== '-' ? resource.namespace : null;
            const queryKey = ["resource_details", currentContext, normalizedNamespace, resource.group, resource.version, resource.kind, resource.name];
            qc.setQueryData(queryKey, updatedYaml);

            // Update local content with server response
            setYamlContent(updatedYaml);

            // Invalidate list queries so resource list updates
            qc.invalidateQueries({ queryKey: ["list_resources"] });

            // Show success state briefly
            setSaveSuccess(true);
            (window as any).showToast?.(`Applied changes to ${resource.kind}/${resource.name}`, 'success');

            // Close after brief delay to show success
            setTimeout(() => {
                onSuccess?.();
                onClose();
            }, 500);
        } catch (err: any) {
            setError(`Failed to apply changes: ${err.toString()}`);
        } finally {
            setIsSaving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-[#1e1e1e] border border-white/10 rounded-xl w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#252526]">
                    <div className="flex items-center gap-2">
                        <span className="text-zinc-400 text-sm">Editing</span>
                        <span className="font-semibold text-white">{resource.kind} / {resource.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        {error && (
                            <div className="flex items-center gap-1.5 text-red-400 bg-red-500/10 px-3 py-1 rounded text-xs border border-red-500/20 mr-2">
                                <AlertCircle size={12} />
                                <span className="truncate max-w-[300px]" title={error}>{error}</span>
                            </div>
                        )}
                        <button
                            onClick={handleSave}
                            disabled={isSaving || isLoading || saveSuccess}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-all ${saveSuccess
                                    ? 'bg-emerald-500 text-white'
                                    : isSaving
                                        ? 'bg-emerald-500/50 text-white cursor-wait'
                                        : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                                }`}
                        >
                            {saveSuccess ? (
                                <Check size={14} />
                            ) : isSaving ? (
                                <Loader2 size={14} className="animate-spin" />
                            ) : (
                                <Save size={14} />
                            )}
                            {saveSuccess ? 'Applied!' : isSaving ? 'Applying...' : 'Save & Apply'}
                        </button>
                        <button
                            onClick={onClose}
                            className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Editor Content */}
                <div className="flex-1 overflow-hidden relative">
                    {isLoading ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 size={32} className="text-cyan-500 animate-spin" />
                        </div>
                    ) : (
                        <Editor
                            height="100%"
                            defaultLanguage="yaml"
                            value={yamlContent}
                            onChange={(value) => setYamlContent(value || '')}
                            theme="vs-dark"
                            options={{
                                minimap: { enabled: true },
                                scrollBeyondLastLine: false,
                                fontSize: 13,
                                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                                renderWhitespace: 'selection',
                                tabSize: 2,
                            }}
                        />
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-2 border-t border-white/10 bg-[#252526] text-[10px] text-zinc-500 flex justify-between">
                    <span>Monaco Editor</span>
                    <span>YAML Mode</span>
                </div>
            </div>
        </div>
    );
}
