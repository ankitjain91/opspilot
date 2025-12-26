/**
 * GlobalSearch - Search across all bundle resources
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, X, FileText, Loader2, Command } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useBundleContext } from '../BundleContext';
import { BundleSearchResult } from '../types';

interface GlobalSearchProps {
    isOpen: boolean;
    onClose: () => void;
}

export function GlobalSearch({ isOpen, onClose }: GlobalSearchProps) {
    const { bundle } = useBundleContext();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<BundleSearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const searchTimeout = useRef<NodeJS.Timeout>();

    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) {
            setQuery('');
            setResults([]);
            setSelectedIndex(0);
        }
    }, [isOpen]);

    const performSearch = useCallback(async (searchQuery: string) => {
        if (!bundle || searchQuery.length < 2) {
            setResults([]);
            return;
        }

        setLoading(true);
        try {
            const searchResults = await invoke<BundleSearchResult[]>('search_bundle', {
                bundlePath: bundle.path,
                query: searchQuery
            });
            setResults(searchResults);
            setSelectedIndex(0);
        } catch (err) {
            console.error('Search failed:', err);
            setResults([]);
        } finally {
            setLoading(false);
        }
    }, [bundle]);

    const handleQueryChange = useCallback((value: string) => {
        setQuery(value);
        if (searchTimeout.current) {
            clearTimeout(searchTimeout.current);
        }
        searchTimeout.current = setTimeout(() => {
            performSearch(value);
        }, 300);
    }, [performSearch]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && results[selectedIndex]) {
            // Could navigate to the resource here
            console.log('Selected:', results[selectedIndex]);
        }
    }, [onClose, results, selectedIndex]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={onClose}
            />

            {/* Search Panel */}
            <div className="relative w-full max-w-2xl bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden">
                {/* Search Input */}
                <div className="flex items-center gap-3 p-4 border-b border-zinc-800">
                    <Search size={20} className="text-zinc-500" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={e => handleQueryChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search resources, configs, secrets..."
                        className="flex-1 bg-transparent text-white text-lg placeholder:text-zinc-600 focus:outline-none"
                    />
                    {loading && <Loader2 size={20} className="text-purple-400 animate-spin" />}
                    <button
                        onClick={onClose}
                        className="p-1 rounded hover:bg-zinc-800 text-zinc-500"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Results */}
                <div className="max-h-96 overflow-auto">
                    {query.length < 2 ? (
                        <div className="p-8 text-center text-zinc-500">
                            <Command size={32} className="mx-auto mb-3 opacity-50" />
                            <div className="text-sm">Type at least 2 characters to search</div>
                            <div className="text-xs mt-1 text-zinc-600">
                                Search through all YAML files in the bundle
                            </div>
                        </div>
                    ) : results.length === 0 && !loading ? (
                        <div className="p-8 text-center text-zinc-500">
                            <Search size={32} className="mx-auto mb-3 opacity-50" />
                            <div className="text-sm">No results found for "{query}"</div>
                        </div>
                    ) : (
                        <div className="py-2">
                            {results.map((result, index) => (
                                <div
                                    key={result.file_path}
                                    className={`px-4 py-3 cursor-pointer transition-colors ${
                                        index === selectedIndex
                                            ? 'bg-purple-500/20'
                                            : 'hover:bg-zinc-800/50'
                                    }`}
                                    onClick={() => {
                                        console.log('Selected:', result);
                                    }}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                                            {result.resource_type}
                                        </span>
                                        <span className="text-sm font-medium text-white">
                                            {result.name}
                                        </span>
                                        {result.namespace && (
                                            <span className="text-xs text-zinc-500">
                                                {result.namespace}
                                            </span>
                                        )}
                                    </div>
                                    {result.match_snippet && (
                                        <div className="mt-1 text-xs text-zinc-400 font-mono truncate">
                                            {result.match_field && (
                                                <span className="text-purple-400">{result.match_field}: </span>
                                            )}
                                            {result.match_snippet}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-2 border-t border-zinc-800 flex items-center gap-4 text-[10px] text-zinc-600">
                    <span><kbd className="px-1 py-0.5 rounded bg-zinc-800">↑↓</kbd> Navigate</span>
                    <span><kbd className="px-1 py-0.5 rounded bg-zinc-800">Enter</kbd> Select</span>
                    <span><kbd className="px-1 py-0.5 rounded bg-zinc-800">Esc</kbd> Close</span>
                    {results.length > 0 && (
                        <span className="ml-auto">{results.length} results</span>
                    )}
                </div>
            </div>
        </div>
    );
}
