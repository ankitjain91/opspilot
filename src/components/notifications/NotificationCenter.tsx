import React, { useState, useRef, useEffect } from 'react';
import { Bell, Check, X, Trash2, ExternalLink, AlertTriangle, Info, CheckCircle2, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useNotifications, Notification } from './NotificationContext';
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

export const NotificationCenter = () => {
    const { notifications, unreadCount, markAllAsRead, clearAll, removeNotification, markAsRead } = useNotifications();
    const [isOpen, setIsOpen] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Fetch current context for filtering
    const { data: currentContext } = useQuery({
        queryKey: ["current_context_global"],
        queryFn: async () => await invoke<string>("get_current_context_name"),
        refetchInterval: 5000,
    });

    // Filter notifications by cluster context (or show if no cluster specific)
    const filteredNotifications = notifications.filter(n => !n.cluster || n.cluster === currentContext);
    const filteredUnreadCount = filteredNotifications.filter(n => !n.read).length;

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const formatTime = (timestamp: number) => {
        const diff = Date.now() - timestamp;
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return new Date(timestamp).toLocaleDateString();
    };

    const getIcon = (type: string) => {
        switch (type) {
            case 'error': return <AlertCircle size={16} className="text-red-500 pointer-events-none" />;
            case 'warning': return <AlertTriangle size={16} className="text-amber-500 pointer-events-none" />;
            case 'success': return <CheckCircle2 size={16} className="text-emerald-500 pointer-events-none" />;
            default: return <Info size={16} className="text-blue-500 pointer-events-none" />;
        }
    };

    const bgClass = (type: string) => {
        switch (type) {
            case 'error': return 'bg-red-500/10 border-red-500/20';
            case 'warning': return 'bg-amber-500/10 border-amber-500/20';
            case 'success': return 'bg-emerald-500/10 border-emerald-500/20';
            default: return 'bg-blue-500/10 border-blue-500/20';
        }
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => {
                    setIsOpen(!isOpen);
                }}
                className={`relative p-2 rounded-lg transition-colors ${isOpen ? 'text-white bg-white/10' : 'text-zinc-400 hover:text-white hover:bg-white/10'
                    }`}
                title="Notifications"
            >
                <Bell size={20} className="pointer-events-none" />
                {filteredUnreadCount > 0 && (
                    <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-red-500 rounded-full border border-[#1e1e1e] pointer-events-none" />
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 top-full mt-2 w-[400px] max-h-[85vh] bg-[#1e1e1e] border border-zinc-800 rounded-xl shadow-2xl flex flex-col z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                    <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/80 backdrop-blur-sm sticky top-0 z-10">
                        <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-white">Notifications</h3>
                            {filteredUnreadCount > 0 && (
                                <span className="px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[10px] font-medium border border-red-500/20 pointer-events-none">
                                    {filteredUnreadCount} new
                                </span>
                            )}
                        </div>
                        <div className="flex gap-3">
                            {filteredUnreadCount > 0 && (
                                <button
                                    onClick={markAllAsRead}
                                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1 font-medium"
                                >
                                    <Check size={12} className="pointer-events-none" /> Mark all read
                                </button>
                            )}
                            {filteredNotifications.length > 0 && (
                                <button
                                    onClick={clearAll}
                                    className="text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
                                >
                                    Clear all
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="overflow-y-auto flex-1 p-2 space-y-2 custom-scrollbar">
                        {filteredNotifications.length === 0 ? (
                            <div className="p-12 text-center text-zinc-500 flex flex-col items-center gap-4">
                                <div className="w-12 h-12 rounded-full bg-zinc-800/50 flex items-center justify-center">
                                    <Bell size={24} className="opacity-20 pointer-events-none" />
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-zinc-400">No notifications</p>
                                    <p className="text-xs text-zinc-600 mt-1">
                                        {currentContext ? `No alerts for ${currentContext}` : "We'll notify you when something happens."}
                                    </p>
                                </div>
                            </div>
                        ) : (
                            filteredNotifications.map((notification) => (
                                <div
                                    key={notification.id}
                                    className={`relative group rounded-lg border transition-all duration-200 ${notification.read
                                        ? 'bg-transparent border-transparent hover:bg-white/5'
                                        : bgClass(notification.type)
                                        }`}
                                >
                                    <div className="p-3">
                                        <div className="flex gap-3">
                                            <div className="mt-0.5 shrink-0">
                                                {getIcon(notification.type)}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex justify-between items-start gap-2">
                                                    <p className={`text-sm leading-snug break-words ${notification.read ? 'text-zinc-400' : 'text-zinc-100 font-medium'
                                                        }`}>
                                                        {notification.message}
                                                    </p>
                                                    <span className="text-[10px] text-zinc-600 shrink-0 whitespace-nowrap mt-0.5 select-none">
                                                        {formatTime(notification.timestamp)}
                                                    </span>
                                                </div>

                                                {notification.resource && (
                                                    <div className="flex items-center gap-1.5 mt-1.5">
                                                        <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-600 bg-zinc-800/50 px-1.5 py-0.5 rounded pointer-events-none">
                                                            RES
                                                        </span>
                                                        <p className="text-xs font-mono text-zinc-500 truncate select-all">
                                                            {notification.resource}
                                                        </p>
                                                    </div>
                                                )}

                                                <div className="flex items-center justify-between mt-3">
                                                    <div className="flex gap-2">
                                                        {notification.action && (
                                                            <button
                                                                onClick={() => {
                                                                    if (notification.action?.onClick) {
                                                                        notification.action.onClick();
                                                                    } else if (notification.action?.type === 'investigate') {
                                                                        console.log("Triggering investigation for", notification.resource);
                                                                        window.dispatchEvent(new CustomEvent('opspilot:investigate', {
                                                                            detail: { prompt: `Sentinel Alert: ${notification.message}. RESOURCE: ${notification.resource || 'unknown'}. Please analyze the root cause immediately.` }
                                                                        }));
                                                                    }
                                                                    setIsOpen(false);
                                                                    markAsRead(notification.id);
                                                                }}
                                                                className="flex items-center gap-1.5 text-xs bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300 px-2.5 py-1.5 rounded-md font-medium transition-colors border border-blue-500/10"
                                                            >
                                                                {notification.action.label} <ExternalLink size={12} className="pointer-events-none" />
                                                            </button>
                                                        )}
                                                        {notification.details && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setExpandedId(expandedId === notification.id ? null : notification.id);
                                                                }}
                                                                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors"
                                                            >
                                                                {expandedId === notification.id ? (
                                                                    <>Hide details <ChevronUp size={12} className="pointer-events-none" /></>
                                                                ) : (
                                                                    <>Show details <ChevronDown size={12} className="pointer-events-none" /></>
                                                                )}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex flex-col gap-1 opacity-100 transition-opacity">
                                                {!notification.read && (
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); markAsRead(notification.id); }}
                                                        className="p-1.5 hover:bg-white/10 rounded-md text-zinc-500 hover:text-zinc-300 transition-colors"
                                                        title="Mark as read"
                                                    >
                                                        <Check size={14} className="pointer-events-none" />
                                                    </button>
                                                )}
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); removeNotification(notification.id); }}
                                                    className="p-1.5 hover:bg-white/10 rounded-md text-zinc-500 hover:text-red-400 transition-colors"
                                                    title="Remove"
                                                >
                                                    <Trash2 size={14} className="pointer-events-none" />
                                                </button>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Expandable Details Section */}
                                    {expandedId === notification.id && notification.details && (
                                        <div className="border-t border-white/5 bg-black/20 p-3 rounded-b-lg animate-in slide-in-from-top-2 duration-200">
                                            <pre className="text-[10px] font-mono text-zinc-400 whitespace-pre-wrap break-all bg-black/40 p-2 rounded border border-white/5 max-h-48 overflow-y-auto custom-scrollbar">
                                                {notification.details}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
