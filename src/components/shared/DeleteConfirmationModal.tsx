import React, { useState, useRef, useEffect } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

interface DeleteConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => Promise<void> | void;
    resourceName: string;
}

export function DeleteConfirmationModal({ isOpen, onClose, onConfirm, resourceName }: DeleteConfirmationModalProps) {
    const [inputValue, setInputValue] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setInputValue("");
            setIsLoading(false);
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isOpen]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (inputValue === resourceName) {
            setIsLoading(true);
            try {
                await onConfirm();
                onClose();
            } catch (err) {
                console.error("Delete confirmation failed", err);
                setIsLoading(false);
            }
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={isLoading ? undefined : onClose}>
            <div
                className="w-full max-w-md bg-gradient-to-br from-gray-900 to-black border border-red-500/30 rounded-lg shadow-2xl shadow-red-500/20 overflow-hidden animate-in fade-in zoom-in-95 duration-200"
                onClick={e => e.stopPropagation()}
            >
                <div className="p-6 border-b border-gray-800">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 rounded-full bg-red-500/10">
                            <AlertCircle className="text-red-400" size={24} />
                        </div>
                        <h2 className="text-xl font-bold text-white">Delete Resource</h2>
                    </div>
                    <p className="text-gray-400 text-sm">
                        This action cannot be undone. Type <span className="font-mono text-red-400 font-semibold">{resourceName}</span> to confirm deletion.
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div>
                        <input
                            ref={inputRef}
                            type="text"
                            value={inputValue}
                            onChange={e => setInputValue(e.target.value)}
                            placeholder="Type resource name to confirm"
                            className="w-full bg-black/50 border border-red-500/30 rounded px-3 py-2 text-white placeholder-gray-600 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-all font-mono text-sm"
                            disabled={isLoading}
                        />
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                            disabled={isLoading}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={inputValue !== resourceName || isLoading}
                            className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded font-medium transition-all shadow-lg shadow-red-900/20 flex items-center gap-2"
                        >
                            {isLoading ? <Loader2 size={16} className="animate-spin" /> : null}
                            {isLoading ? 'Deleting...' : 'Delete Resource'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
