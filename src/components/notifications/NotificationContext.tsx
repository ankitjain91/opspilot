import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface Notification {
    id: string;
    message: string;
    type: NotificationType;
    timestamp: number;
    read: boolean;
    resource?: string;
    details?: string;
    cluster?: string;
    action?: {
        label: string;
        type?: string;
        onClick?: () => void;
    };
}

interface NotificationContextType {
    notifications: Notification[];
    unreadCount: number;
    addNotification: (message: string, type: NotificationType, resource?: string, action?: { label: string, onClick?: () => void, type?: string }, details?: string, cluster?: string) => void;
    markAsRead: (id: string) => void;
    markAllAsRead: () => void;
    clearAll: () => void;
    removeNotification: (id: string) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const useNotifications = () => {
    const context = useContext(NotificationContext);
    if (!context) {
        throw new Error('useNotifications must be used within a NotificationProvider');
    }
    return context;
};

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [notifications, setNotifications] = useState<Notification[]>(() => {
        try {
            const saved = localStorage.getItem('opspilot-notifications');
            return saved ? JSON.parse(saved) : [];
        } catch (e) {
            return [];
        }
    });

    // Persist to localStorage
    useEffect(() => {
        // Strip out non-serializable onClick before saving if needed, but JSON.stringify does that automatically (omits functions)
        // We rely on 'type' to rehydrate actions if needed.
        localStorage.setItem('opspilot-notifications', JSON.stringify(notifications));
    }, [notifications]);

    const unreadCount = notifications.filter(n => !n.read).length;

    const addNotification = useCallback((message: string, type: NotificationType, resource?: string, action?: { label: string, onClick?: () => void, type?: string }, details?: string, cluster?: string) => {
        const newNotification: Notification = {
            id: Math.random().toString(36).substr(2, 9),
            message,
            type,
            timestamp: Date.now(),
            read: false,
            resource,
            action,
            details,
            cluster
        };
        setNotifications(prev => [newNotification, ...prev].slice(0, 50)); // Keep last 50
    }, []);

    const markAsRead = useCallback((id: string) => {
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    }, []);

    const markAllAsRead = useCallback(() => {
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    }, []);

    const clearAll = useCallback(() => {
        setNotifications([]);
    }, []);

    const removeNotification = useCallback((id: string) => {
        setNotifications(prev => prev.filter(n => n.id !== id));
    }, []);

    return (
        <NotificationContext.Provider value={{
            notifications,
            unreadCount,
            addNotification,
            markAsRead,
            markAllAsRead,
            clearAll,
            removeNotification
        }}>
            {children}
        </NotificationContext.Provider>
    );
};
