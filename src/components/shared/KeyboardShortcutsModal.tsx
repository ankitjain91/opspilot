/**
 * Keyboard Shortcuts Help Modal
 * Shows all available keyboard shortcuts grouped by category
 */

import React from 'react';
import { X, Keyboard } from 'lucide-react';
import { KeyboardShortcut, formatShortcut, groupShortcutsByCategory, modKey } from '../../hooks/useKeyboardShortcuts';

interface KeyboardShortcutsModalProps {
    isOpen: boolean;
    onClose: () => void;
    shortcuts: KeyboardShortcut[];
}

export function KeyboardShortcutsModal({ isOpen, onClose, shortcuts }: KeyboardShortcutsModalProps) {
    if (!isOpen) return null;

    const grouped = groupShortcutsByCategory(shortcuts);
    const categories = Object.keys(grouped);

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
            onClick={onClose}
        >
            <div
                className="bg-zinc-900/95 border border-white/10 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden animate-in zoom-in-95 duration-200"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/20 rounded-lg">
                            <Keyboard size={20} className="text-indigo-400" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-white">Keyboard Shortcuts</h2>
                            <p className="text-xs text-zinc-500">Press {modKey}+? to toggle this help</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto max-h-[calc(80vh-80px)]">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {categories.map(category => (
                            <div key={category} className="space-y-2">
                                <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3">
                                    {category}
                                </h3>
                                <div className="space-y-1">
                                    {grouped[category].map((shortcut, idx) => (
                                        <div
                                            key={idx}
                                            className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-white/5 transition-colors"
                                        >
                                            <span className="text-sm text-zinc-300">{shortcut.description}</span>
                                            <kbd className="px-2 py-1 text-xs font-mono bg-zinc-800 border border-zinc-700 rounded text-zinc-300 whitespace-nowrap">
                                                {formatShortcut(shortcut)}
                                            </kbd>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-3 border-t border-white/5 bg-white/[0.02]">
                    <p className="text-[10px] text-zinc-600 text-center">
                        Press <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-400 font-mono">Esc</kbd> to close
                    </p>
                </div>
            </div>
        </div>
    );
}
