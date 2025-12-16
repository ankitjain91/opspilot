import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { X, CheckCircle2, AlertCircle, Info, Loader2 } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info' | 'loading';

export interface Toast {
    id: string;
    message: string;
    type: ToastType;
    duration?: number;
    action?: {
        label: string;
        onClick: () => void;
    };
}

interface ToastContextType {
    showToast: (message: string, type?: ToastType, duration?: number, action?: { label: string, onClick: () => void }) => string;
    dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
};

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismissToast = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const showToast = useCallback((message: string, type: ToastType = 'info', duration = 3000, action?: { label: string, onClick: () => void }) => {
        const id = Math.random().toString(36).substr(2, 9);
        setToasts(prev => [...prev, { id, message, type, duration, action }]);

        if (duration > 0 && !action) { // Don't auto-dismiss if there is an action (or make it longer)
            setTimeout(() => dismissToast(id), duration);
        } else if (duration > 0 && action) {
            // Give more time for action to be clicked
            setTimeout(() => dismissToast(id), duration * 3);
        }
        return id;
    }, [dismissToast]);

    return (
        <ToastContext.Provider value={{ showToast, dismissToast }}>
            {children}
            <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
                {toasts.map(toast => (
                    <div
                        key={toast.id}
                        className={`pointer-events-auto flex items-center gap-3 p-3 rounded-lg shadow-lg border backdrop-blur-md transition-all animate-in slide-in-from-bottom-5 fade-in duration-300 ${toast.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-200' :
                            toast.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-200' :
                                toast.type === 'loading' ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-200' :
                                    'bg-zinc-800/90 border-zinc-700 text-zinc-200'
                            }`}
                    >
                        {toast.type === 'success' && <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />}
                        {toast.type === 'error' && <AlertCircle size={16} className="text-red-500 shrink-0" />}
                        {toast.type === 'info' && <Info size={16} className="text-zinc-500 shrink-0" />}
                        {toast.type === 'loading' && <Loader2 size={16} className="text-cyan-500 animate-spin shrink-0" />}


                        <p className="text-sm font-medium flex-1 leading-snug">{toast.message}</p>

                        {toast.action && (
                            <button
                                onClick={() => {
                                    toast.action?.onClick();
                                    dismissToast(toast.id);
                                }}
                                className="px-3 py-1 bg-white/10 hover:bg-white/20 text-xs font-semibold rounded border border-white/10 transition-colors mr-1"
                            >
                                {toast.action.label}
                            </button>
                        )}

                        <button
                            onClick={() => dismissToast(toast.id)}
                            className="p-1 hover:bg-white/10 rounded-md transition-colors opacity-70 hover:opacity-100"
                        >
                            <X size={14} />
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
};
