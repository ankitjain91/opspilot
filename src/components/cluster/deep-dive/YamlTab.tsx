
import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { Save, Search, Loader2, AlertCircle, Copy, Check } from 'lucide-react';
import { useToast } from '../../ui/Toast';
import { K8sObject } from '../../../types/k8s';

// Pre-initialize Monaco loader on module load
let monacoInitialized = false;
let monacoInitPromise: Promise<void> | null = null;

const initMonaco = async () => {
    if (monacoInitialized) return;
    if (monacoInitPromise) return monacoInitPromise;

    monacoInitPromise = (async () => {
        const mod = await import('@monaco-editor/react');
        mod.loader.config({
            paths: {
                vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs'
            }
        });
        await mod.loader.init();
        monacoInitialized = true;
    })();

    return monacoInitPromise;
};

// Lazy load Monaco with proper initialization
const Editor = lazy(() =>
    initMonaco().then(() => import('@monaco-editor/react').then(mod => ({ default: mod.default })))
);

// Error boundary wrapper for Monaco Editor
class MonacoErrorBoundary extends React.Component<
    { children: React.ReactNode; onError: (err: Error) => void },
    { hasError: boolean }
> {
    constructor(props: { children: React.ReactNode; onError: (err: Error) => void }) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error: Error) {
        this.props.onError(error);
    }

    render() {
        if (this.state.hasError) {
            return null; // Parent will show fallback
        }
        return this.props.children;
    }
}

// Wrapped editor with error boundary
function ErrorBoundaryEditor({
    content,
    setContent,
    onMount,
    onError,
}: {
    content: string;
    setContent: (val: string) => void;
    onMount: (editor: any) => void;
    onError: (err: Error) => void;
}) {
    return (
        <MonacoErrorBoundary onError={onError}>
            <Editor
                height="100%"
                defaultLanguage="yaml"
                value={content}
                onChange={(val) => setContent(val || "")}
                onMount={onMount}
                theme="vs-dark"
                loading={
                    <div className="flex items-center justify-center h-full">
                        <Loader2 className="animate-spin text-cyan-500" size={24} />
                    </div>
                }
                options={{
                    minimap: { enabled: false },
                    fontSize: 12,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                }}
            />
        </MonacoErrorBoundary>
    );
}

export function YamlTab({ resource, currentContext }: { resource: K8sObject, currentContext?: string }) {
    const { showToast } = useToast();
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editorError, setEditorError] = useState<Error | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [copied, setCopied] = useState(false);
    const editorRef = useRef<any>(null);
    const decorationsRef = useRef<string[]>([]);
    const qc = useQueryClient();

    // Fetch full resource details as YAML
    const { data: yamlContent, isLoading } = useQuery({
        queryKey: ["resource_details", currentContext, resource.namespace, resource.group, resource.version, resource.kind, resource.name],
        queryFn: async () => {
            // Always fetch fresh YAML from backend (backend returns proper YAML format)
            return await invoke<string>("get_resource_details", {
                req: {
                    group: resource.group,
                    version: resource.version,
                    kind: resource.kind,
                    namespace: resource.namespace !== "-" ? resource.namespace : null
                },
                name: resource.name
            });
        },
        staleTime: 30000,
    });

    const [content, setContent] = useState("");

    // Update content when yamlContent loads
    useEffect(() => {
        if (yamlContent) {
            setContent(yamlContent);
        }
    }, [yamlContent]);

    // Search Logic
    useEffect(() => {
        if (!editorRef.current) return;

        const editor = editorRef.current;
        const model = editor.getModel();

        if (!searchQuery) {
            decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
            return;
        }

        const matches = model.findMatches(searchQuery, false, false, false, null, true);

        if (matches.length > 0) {
            // Highlight all matches
            const newDecorations = matches.map((match: any) => ({
                range: match.range,
                options: {
                    isWholeLine: false,
                    className: 'myContentClass', // We'll rely on inline styles or global css if needed, but monaco supports inlineClassName
                    inlineClassName: 'bg-yellow-500/40 text-white font-bold'
                }
            }));

            decorationsRef.current = editor.deltaDecorations(decorationsRef.current, newDecorations);

            // Scroll to first match
            editor.revealRangeInCenter(matches[0].range);
        } else {
            decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
        }
    }, [searchQuery]);

    const handleEditorDidMount = (editor: any) => {
        editorRef.current = editor;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="animate-spin text-[#007acc]" size={24} />
            </div>
        );
    }

    const handleSave = async () => {
        setIsSaving(true);
        setError(null);
        setSaveSuccess(false);
        try {
            // Use empty string for cluster-scoped resources (namespace is "-")
            const ns = resource.namespace === "-" ? "" : resource.namespace;
            await invoke("apply_yaml", {
                namespace: ns,
                kind: resource.kind,
                name: resource.name,
                yamlContent: content
            });

            // Invalidate queries to refresh data
            qc.invalidateQueries({ queryKey: ["resources"] });
            qc.invalidateQueries({ queryKey: ["resource_details"] });
            qc.invalidateQueries({ queryKey: ["list_resources"] });
            qc.invalidateQueries({ queryKey: ["discovery"] }); // In case CRDs changed

            // Show success feedback
            setSaveSuccess(true);
            showToast(`Resource ${resource.name} updated successfully`, "success");
            setTimeout(() => setSaveSuccess(false), 3000);
        } catch (err: any) {
            setError(err.toString());
            showToast(`Failed to update resource: ${err}`, "error");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] border border-[#3e3e42] rounded overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-[#252526] border-b border-[#3e3e42]">
                <div className="flex items-center gap-4">
                    <span className="text-xs text-[#858585]">Edits are applied via Server-Side Apply</span>
                    <div className="relative">
                        <Search size={12} className="absolute left-2 top-1.5 text-gray-500" />
                        <input
                            type="text"
                            placeholder="Search in YAML..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="bg-[#1e1e1e] border border-[#3e3e42] rounded pl-7 pr-2 py-1 text-xs text-[#cccccc] focus:outline-none focus:border-[#007acc]"
                        />
                    </div>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setContent(yamlContent || "")}
                        className="px-3 py-1 text-xs text-[#cccccc] hover:bg-[#3e3e42] rounded transition-colors"
                        disabled={isSaving}
                    >
                        Reset
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving || saveSuccess}
                        className={`px-3 py-1 text-xs rounded transition-colors disabled:opacity-50 flex items-center gap-2 ${saveSuccess
                            ? 'bg-emerald-600 text-white'
                            : 'bg-[#007acc] hover:bg-[#0062a3] text-white'
                            }`}
                    >
                        {isSaving ? (
                            <Loader2 className="animate-spin" size={12} />
                        ) : saveSuccess ? (
                            <Check size={12} />
                        ) : (
                            <Save size={12} />
                        )}
                        {saveSuccess ? 'Applied!' : 'Save'}
                    </button>
                </div>
            </div>

            {error && (
                <div className="bg-[#f48771]/10 text-[#f48771] px-4 py-2 text-xs border-b border-[#f48771]/20">
                    Error: {error}
                </div>
            )}

            <div className="flex-1 relative">
                {editorError ? (
                    <div className="flex flex-col h-full">
                        <div className="flex items-center gap-2 p-2 bg-yellow-500/10 border-b border-yellow-500/20">
                            <AlertCircle size={14} className="text-yellow-400" />
                            <span className="text-xs text-yellow-300">Monaco editor failed to load. Using simple editor.</span>
                            <button
                                onClick={() => setEditorError(null)}
                                className="ml-auto px-2 py-0.5 text-xs bg-zinc-800 hover:bg-zinc-700 rounded transition-colors text-zinc-300"
                            >
                                Retry Monaco
                            </button>
                        </div>
                        <textarea
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            className="flex-1 w-full bg-[#1e1e1e] text-[#d4d4d4] font-mono text-xs p-4 resize-none focus:outline-none"
                            style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}
                            spellCheck={false}
                        />
                    </div>
                ) : (
                    <Suspense fallback={
                        <div className="flex items-center justify-center h-full">
                            <Loader2 className="animate-spin text-cyan-500" size={24} />
                        </div>
                    }>
                        <ErrorBoundaryEditor
                            content={content}
                            setContent={setContent}
                            onMount={handleEditorDidMount}
                            onError={(err) => setEditorError(err)}
                        />
                    </Suspense>
                )}
            </div>
        </div>
    );
}
