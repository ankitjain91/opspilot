
import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Loader2, Code2, FolderOpen, Settings, Trash2, Plus } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

interface SearchCodeDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSearch: (query: string) => void;
    initialQuery: string;
}

type ViewMode = 'search' | 'manage';

export function SearchCodeDialog({ isOpen, onClose, onSearch, initialQuery }: SearchCodeDialogProps) {
    const [query, setQuery] = useState(initialQuery);
    const [viewMode, setViewMode] = useState<ViewMode>('search');
    const [localRepos, setLocalRepos] = useState<string[]>([]);
    const [isLoadingRepos, setIsLoadingRepos] = useState(false);

    // Search focus
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (isOpen) {
            setQuery(initialQuery);
            fetchLocalRepos();
            // Default to search mode, but if no repos, maybe show management hint? 
            // For now, straight to search is fine, or if 0 repos, show empty state in search
            setViewMode('search');

            setTimeout(() => {
                if (textareaRef.current) {
                    textareaRef.current.focus();
                    textareaRef.current.select();
                }
            }, 100);
        }
    }, [isOpen, initialQuery]);

    const fetchLocalRepos = async () => {
        setIsLoadingRepos(true);
        try {
            // We use the raw fetch/invoke wrapper if available, or just standard fetch since we are in a webview
            // Assuming we have a helper or just use fetch for the python backend
            // In other components, we see standard fetch being used for python endpoints typically?
            // Actually server.py endpoints are usually accessed via 127.0.0.1:1422 (vite) -> python port?
            // Wait, standard Tauri app structure usually has frontend on one port and backend on another?
            // In this app, `agentOrchestrator.ts` uses `BASE_URL = 'http://localhost:8000'`.
            // I should use that or look for a helper. `ClusterChatPanel` uses `fetch`.

            const res = await fetch('http://localhost:8765/local-repos-config');
            if (res.ok) {
                const data = await res.json();
                setLocalRepos(data.local_repos || []);
            }
        } catch (e) {
            console.error("Failed to fetch local repos", e);
        } finally {
            setIsLoadingRepos(false);
        }
    };

    const saveLocalRepos = async (repos: string[]) => {
        try {
            await fetch('http://localhost:8765/local-repos-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ local_repos: repos })
            });
            setLocalRepos(repos);
        } catch (e) {
            console.error("Failed to save local repos", e);
        }
    };

    const handleAddRepo = async () => {
        try {
            const selected = await open({
                multiple: true,
                directory: true,
            });

            if (selected) {
                const newPaths = Array.isArray(selected) ? selected : [selected];
                // Filter duplicates
                const unique = [...new Set([...localRepos, ...newPaths])];
                await saveLocalRepos(unique);
            }
        } catch (e) {
            console.error("Failed to open folder picker", e);
        }
    };

    const handleRemoveRepo = async (path: string) => {
        const updated = localRepos.filter(r => r !== path);
        await saveLocalRepos(updated);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div
                className="w-full max-w-lg bg-zinc-900 border border-purple-500/20 rounded-xl shadow-2xl shadow-purple-500/10 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="p-4 border-b border-white/5 flex items-center justify-between bg-white/5">
                    <div className="flex items-center gap-2 text-purple-300">
                        <Code2 size={18} />
                        <h2 className="font-bold text-sm">
                            {viewMode === 'search' ? 'Search Codebase' : 'Manage Repositories'}
                        </h2>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setViewMode(viewMode === 'search' ? 'manage' : 'search')}
                            className={`p-1.5 rounded-lg transition-colors ${viewMode === 'manage' ? 'bg-purple-500/20 text-purple-200' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
                            title="Manage Repositories"
                        >
                            <Settings size={16} />
                        </button>
                        <div className="w-px h-4 bg-white/10 mx-1" />
                        <button onClick={onClose} className="p-1.5 text-zinc-500 hover:text-white transition-colors">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="p-5 flex-1 overflow-y-auto min-h-[300px]">

                    {viewMode === 'search' && (
                        <div className="space-y-4 h-full flex flex-col">
                            {localRepos.length === 0 ? (
                                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border border-dashed border-zinc-700 rounded-xl bg-black/20">
                                    <div className="w-12 h-12 bg-zinc-800 rounded-full flex items-center justify-center mb-3">
                                        <FolderOpen className="text-zinc-500" />
                                    </div>
                                    <h3 className="text-zinc-300 font-medium mb-1">No repositories configured</h3>
                                    <p className="text-zinc-500 text-xs mb-4 max-w-[200px]">
                                        Add local repository folders to enable code search capabilities.
                                    </p>
                                    <button
                                        onClick={() => setViewMode('manage')}
                                        className="px-4 py-2 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 text-xs font-medium rounded-lg transition-colors"
                                    >
                                        Configure Repos
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <p className="text-zinc-400 text-xs leading-relaxed">
                                        The agent will use <span className="text-zinc-300 font-mono text-[10px] bg-white/5 px-1 py-0.5 rounded">grep</span> and other local tools to search your configured repositories ({localRepos.length}).
                                    </p>

                                    <div className="space-y-1">
                                        <div className="relative">
                                            <div className="absolute top-3 left-3 text-zinc-500">
                                                <Search size={16} />
                                            </div>
                                            <textarea
                                                ref={textareaRef}
                                                value={query}
                                                onChange={(e) => setQuery(e.target.value)}
                                                className="w-full h-32 bg-black/40 border border-white/10 rounded-lg p-3 pl-10 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all resize-none font-mono leading-relaxed"
                                                placeholder="e.g. NullPointerException in PaymentService.java or error 'connection refused'"
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && !e.shiftKey) {
                                                        e.preventDefault();
                                                        if (query.trim()) onSearch(query);
                                                    }
                                                }}
                                            />
                                        </div>
                                        <div className="flex justify-between items-center text-[10px] text-zinc-500 px-1">
                                            <span>Markdown supported</span>
                                            <span>CMD+Enter to search</span>
                                        </div>
                                    </div>

                                    <div className="mt-auto pt-2">
                                        <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar opacity-60 hover:opacity-100 transition-opacity">
                                            {localRepos.map((repo, i) => (
                                                <div key={i} className="shrink-0 text-[10px] px-2 py-1 bg-white/5 rounded border border-white/5 text-zinc-400 truncate max-w-[150px]" title={repo}>
                                                    {repo.split(/[/\\]/).pop()}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {viewMode === 'manage' && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <p className="text-zinc-400 text-xs">
                                    Agent will search these directories for code context.
                                </p>
                                <button
                                    onClick={handleAddRepo}
                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-lg transition-colors shadow-lg shadow-purple-900/20"
                                >
                                    <Plus size={14} />
                                    Add Folder
                                </button>
                            </div>

                            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                                {isLoadingRepos ? (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader2 size={20} className="text-purple-500 animate-spin" />
                                    </div>
                                ) : localRepos.length === 0 ? (
                                    <div className="text-center py-10 border border-dashed border-zinc-800 rounded-lg bg-black/20">
                                        <p className="text-zinc-500 text-xs">No repositories added yet.</p>
                                    </div>
                                ) : (
                                    localRepos.map((path, idx) => (
                                        <div key={path} className="group flex items-center justify-between p-3 bg-black/40 border border-white/5 hover:border-white/10 rounded-lg transition-colors">
                                            <div className="flex items-center gap-3 overflow-hidden">
                                                <FolderOpen size={16} className="text-purple-400 shrink-0" />
                                                <div className="flex flex-col min-w-0">
                                                    <span className="text-xs text-zinc-200 font-medium truncate" title={path}>
                                                        {path.split(/[/\\]/).pop()}
                                                    </span>
                                                    <span className="text-[10px] text-zinc-600 truncate font-mono">
                                                        {path}
                                                    </span>
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => handleRemoveRepo(path)}
                                                className="p-1.5 text-zinc-600 group-hover:text-red-400 hover:bg-red-500/10 rounded-md transition-all opacity-0 group-hover:opacity-100"
                                                title="Remove"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}

                </div>

                {/* Footer */}
                {viewMode === 'search' && (
                    <div className="p-4 border-t border-white/5 bg-black/20 flex justify-end gap-2">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => {
                                if (query.trim()) onSearch(query);
                            }}
                            disabled={!query.trim() || localRepos.length === 0}
                            className="px-4 py-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg shadow-lg shadow-purple-900/20 transition-all flex items-center gap-2"
                        >
                            <Search size={14} />
                            Run Search
                        </button>
                    </div>
                )}

                {viewMode === 'manage' && (
                    <div className="p-4 border-t border-white/5 bg-black/20 flex justify-end gap-2">
                        <button
                            onClick={() => setViewMode('search')}
                            className="px-4 py-2 text-xs font-medium text-white bg-zinc-700 hover:bg-zinc-600 rounded-lg transition-colors"
                        >
                            Done
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
