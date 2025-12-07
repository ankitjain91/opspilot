import React, { useState, useRef, useEffect } from 'react';
import { AlertCircle } from 'lucide-react';

interface DeleteConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    resourceName: string;
}

export function DeleteConfirmationModal({ isOpen, onClose, onConfirm, resourceName }: DeleteConfirmationModalProps) {
    const [inputValue, setInputValue] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setInputValue("");
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isOpen]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (inputValue === resourceName) {
            onConfirm();
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
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
                        <label className="block text-sm font-medium text-gray-400 mb-2">
                            Resource name
                        </label>
                        <input
                            ref={inputRef}
                            type="text"
                            value={inputValue}
                            onChange={e => setInputValue(e.target.value)}
                            className="w-full px-3 py-2 bg-black border border-gray-800 rounded-md text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500"
                            placeholder={resourceName}
                            autoComplete="off"
                        />
                    </div>

                    <div className="flex gap-3 justify-end">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white rounded-md transition-all"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={inputValue !== resourceName}
                            className="px-4 py-2 bg-red-600 text-white rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-red-700 disabled:hover:bg-red-600"
                        >
                            Delete Resource
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
