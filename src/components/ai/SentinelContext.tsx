import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNotifications } from '../notifications/NotificationContext';
import { getAgentServerUrl, onAgentUrlChange } from '../../utils/config';

export interface KBProgress {
    current: number;
    total: number;
    message: string;
    context: string;
}

export type SentinelStatus = 'connected' | 'connecting' | 'disconnected' | 'error'; // Added 'error'

interface SentinelContextType {
    status: SentinelStatus;
    kbProgress: KBProgress | null;
    reconnect: () => void;
    registerInvestigator: (handler: (prompt: string) => void) => () => void;
}

const SentinelContext = createContext<SentinelContextType | null>(null);

// Robust connection settings
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30000;
const HEALTH_CHECK_INTERVAL = 10000;
const CONNECTION_TIMEOUT = 20000;
const STALE_CONNECTION_THRESHOLD = 45000;

export function SentinelProvider({ children }: { children: React.ReactNode }) {
    const { addNotification } = useNotifications();
    const [kbProgress, setKBProgress] = useState<KBProgress | null>(null);
    const [status, setStatus] = useState<SentinelStatus>('connecting');

    // State refs
    const progressThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastProgressRef = useRef<KBProgress | null>(null);
    const investigatorsRef = useRef<Set<(prompt: string) => void>>(new Set());
    const addNotificationRef = useRef(addNotification);
    const eventSourceRef = useRef<EventSource | null>(null);
    const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const healthCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const retryDelayRef = useRef(INITIAL_RETRY_DELAY);
    const lastMessageTimeRef = useRef<number>(Date.now());
    const connectionIdRef = useRef(0);

    // Update refs
    useEffect(() => {
        addNotificationRef.current = addNotification;
    }, [addNotification]);

    const registerInvestigator = useCallback((handler: (prompt: string) => void) => {
        investigatorsRef.current.add(handler);
        return () => {
            investigatorsRef.current.delete(handler);
        };
    }, []);

    const notifyInvestigators = useCallback((prompt: string) => {
        if (investigatorsRef.current.size === 0) {
            console.warn("[Sentinel] No investigators registered for alert");
            return;
        }
        investigatorsRef.current.forEach(handler => handler(prompt));
    }, []);


    const forceReconnect = useCallback(() => {
        // Increment connection ID to invalidate old handlers
        connectionIdRef.current++;
        const thisConnectionId = connectionIdRef.current;

        // Clear existing retry
        if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
        }

        // Close existing
        if (eventSourceRef.current) {
            console.log('[Sentinel] Closing existing connection');
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }

        setStatus('connecting');
        const url = `${getAgentServerUrl()}/events`;
        console.log(`[Sentinel] Connecting to ${url} (attempt #${thisConnectionId})...`);

        try {
            const eventSource = new EventSource(url);
            eventSourceRef.current = eventSource;

            // Connection timeout safety
            const connectionTimeout = setTimeout(() => {
                if (connectionIdRef.current !== thisConnectionId) return;

                if (eventSource.readyState === EventSource.CONNECTING) {
                    console.log('[Sentinel] Connection timeout, will retry');
                    eventSource.close();
                    eventSourceRef.current = null;
                    setStatus('disconnected');
                    scheduleRetry();
                }
            }, CONNECTION_TIMEOUT);

            eventSource.onopen = () => {
                clearTimeout(connectionTimeout);
                if (connectionIdRef.current !== thisConnectionId) return;

                console.log('[Sentinel] Connected successfully');
                setStatus('connected');
                retryDelayRef.current = INITIAL_RETRY_DELAY;
                lastMessageTimeRef.current = Date.now();
            };

            eventSource.onmessage = (event) => {
                if (connectionIdRef.current !== thisConnectionId) return;
                lastMessageTimeRef.current = Date.now();

                setStatus(prev => prev !== 'connected' ? 'connected' : prev);

                try {
                    const data = JSON.parse(event.data);

                    if (data.type === 'heartbeat') return;

                    if (data.type === 'alert') {
                        console.log("🛡️ Sentinel Alert:", data.message);
                        addNotificationRef.current(
                            data.message,
                            data.severity === 'high' ? 'error' : 'warning',
                            data.resource,
                            {
                                label: "Investigate",
                                type: 'investigate',
                                onClick: () => {
                                    console.log(`[Sentinel] Investigation triggered for ${data.resource}`);
                                    const prompt = `Sentinel Alert: ${data.message}. RESOURCE: ${data.resource || 'unknown'}. Please analyze the root cause immediately.`;
                                    notifyInvestigators(prompt);
                                }
                            },
                            JSON.stringify(data, null, 2),
                            data.cluster
                        );
                    } else if (data.type === 'kb_progress') {
                        handleKBProgress(data);
                    }
                } catch (e) {
                    console.error("[Sentinel] Failed to parse event:", e);
                }
            };

            eventSource.onerror = (e) => {
                clearTimeout(connectionTimeout);
                if (connectionIdRef.current !== thisConnectionId) return;

                console.warn(`[Sentinel] EventSource error:`, e);

                if (eventSource.readyState === EventSource.CLOSED) {
                    setStatus('disconnected');
                    scheduleRetry();
                } else {
                    // Force refresh on error
                    eventSource.close();
                    eventSourceRef.current = null;
                    setStatus('error');
                    scheduleRetry();
                }
            };

        } catch (e) {
            console.error('[Sentinel] Failed to create EventSource:', e);
            setStatus('error');
            scheduleRetry();
        }
    }, [notifyInvestigators]); // Dependencies

    const handleKBProgress = useCallback((data: any) => {
        const newProgress = {
            current: data.current,
            total: data.total,
            message: data.message,
            context: data.context
        };
        lastProgressRef.current = newProgress;

        if (data.current === data.total) {
            if (progressThrottleRef.current) {
                clearTimeout(progressThrottleRef.current);
                progressThrottleRef.current = null;
            }
            setKBProgress(newProgress);
            setTimeout(() => setKBProgress(null), 2000);
            return;
        }

        if (!progressThrottleRef.current) {
            setKBProgress(newProgress);
            progressThrottleRef.current = setTimeout(() => {
                progressThrottleRef.current = null;
                if (lastProgressRef.current) setKBProgress(lastProgressRef.current);
            }, 500);
        }
    }, []);

    const scheduleRetry = useCallback(() => {
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);

        const delay = retryDelayRef.current;
        console.log(`[Sentinel] Scheduling retry in ${delay}ms`);

        retryTimeoutRef.current = setTimeout(() => {
            retryDelayRef.current = Math.min(retryDelayRef.current * 2, MAX_RETRY_DELAY);
            forceReconnect();
        }, delay);
    }, [forceReconnect]);

    // Use ref for status to avoid dependency cycles in checkHealth
    const statusRef = useRef(status);
    useEffect(() => { statusRef.current = status; }, [status]);

    const checkHealth = useCallback(async () => {
        const es = eventSourceRef.current;
        const now = Date.now();
        const timeSinceLastMessage = now - lastMessageTimeRef.current;
        const currentStatus = statusRef.current;

        if (es && es.readyState === EventSource.OPEN && timeSinceLastMessage > STALE_CONNECTION_THRESHOLD) {
            console.log(`[Sentinel] Connection stale, forcing reconnect`);
            forceReconnect();
            return;
        }

        if (!es || es.readyState === EventSource.CLOSED) {
            try {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 3000);
                const response = await fetch(`${getAgentServerUrl()}/health`, {
                    method: 'GET', signal: controller.signal
                });

                if (response.ok) {
                    console.log('[Sentinel] Health OK, reconnecting socket...');
                    retryDelayRef.current = INITIAL_RETRY_DELAY;
                    forceReconnect();
                }
            } catch (e) {
                if (currentStatus !== 'disconnected' && currentStatus !== 'error') {
                    setStatus('disconnected');
                }
            }
        }
    }, [forceReconnect]); // Removed status dependency


    // Lifecycle - Mount only!
    useEffect(() => {
        // Initial connect
        forceReconnect();

        // Start health check
        healthCheckRef.current = setInterval(checkHealth, HEALTH_CHECK_INTERVAL);

        const unlisten = onAgentUrlChange(() => {
            console.log('[Sentinel] URL changed, reconnecting...');
            retryDelayRef.current = INITIAL_RETRY_DELAY;
            forceReconnect();
        });

        return () => {
            unlisten();
            if (eventSourceRef.current) eventSourceRef.current.close();
            if (healthCheckRef.current) clearInterval(healthCheckRef.current);
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        };
    }, []); // Empty dependency array to run ONCE on mount

    const value = useMemo(() => ({
        status,
        kbProgress,
        reconnect: () => {
            retryDelayRef.current = INITIAL_RETRY_DELAY;
            forceReconnect();
        },
        registerInvestigator
    }), [status, kbProgress, registerInvestigator, forceReconnect]);

    return (
        <SentinelContext.Provider value={value}>
            {children}
        </SentinelContext.Provider>
    );
}

export function useSentinelContext() {
    const context = useContext(SentinelContext);
    if (!context) {
        throw new Error('useSentinelContext must be used within a SentinelProvider');
    }
    return context;
}
