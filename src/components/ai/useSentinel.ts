import { useEffect, useState, useRef, useCallback } from 'react';
import { useToast } from '../ui/Toast';
import { useNotifications } from '../notifications/NotificationContext';
import { getAgentServerUrl, onAgentUrlChange } from '../../utils/config';

export interface KBProgress {
    current: number;
    total: number;
    message: string;
    context: string;
}

export type SentinelStatus = 'connected' | 'connecting' | 'disconnected';

// Robust connection settings - tuned for reliability
const INITIAL_RETRY_DELAY = 1000;  // 1 second
const MAX_RETRY_DELAY = 30000;     // 30 seconds max
const HEALTH_CHECK_INTERVAL = 10000; // Check health every 10 seconds
const CONNECTION_TIMEOUT = 20000;  // 20s timeout for initial connection
const STALE_CONNECTION_THRESHOLD = 45000; // Consider stale if no message in 45s (heartbeat should arrive every 15s)

export function useSentinel(onInvestigate?: (prompt: string) => void) {
    const { showToast } = useToast();
    const { addNotification } = useNotifications();
    const [kbProgress, setKBProgress] = useState<KBProgress | null>(null);
    const [sentinelStatus, setSentinelStatus] = useState<SentinelStatus>('connecting');

    // Refs to avoid stale closures - these never change identity
    const progressThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastProgressRef = useRef<KBProgress | null>(null);
    const onInvestigateRef = useRef(onInvestigate);
    const addNotificationRef = useRef(addNotification);
    const eventSourceRef = useRef<EventSource | null>(null);
    const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const healthCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const retryDelayRef = useRef(INITIAL_RETRY_DELAY);
    const lastMessageTimeRef = useRef<number>(Date.now()); // Initialize to now to avoid immediate stale detection
    const mountedRef = useRef(true);
    const connectionIdRef = useRef(0); // Track connection attempts to avoid stale handlers

    // Keep callback refs in sync without triggering re-renders
    useEffect(() => {
        onInvestigateRef.current = onInvestigate;
    }, [onInvestigate]);

    useEffect(() => {
        addNotificationRef.current = addNotification;
    }, [addNotification]);



    // Force reconnect - closes existing connection and starts fresh
    const forceReconnect = useCallback(() => {
        if (!mountedRef.current) return;

        // Increment connection ID to invalidate any pending handlers from old connection
        connectionIdRef.current++;
        const thisConnectionId = connectionIdRef.current;

        // Clear any pending retry
        if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
        }

        // Close existing connection
        if (eventSourceRef.current) {
            console.log('[Sentinel] Closing existing connection');
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }

        setSentinelStatus('connecting');
        const url = `${getAgentServerUrl()}/events`;
        console.log(`[Sentinel] Connecting to ${url} (attempt #${thisConnectionId})...`);

        try {
            const eventSource = new EventSource(url);
            eventSourceRef.current = eventSource;

            // Set a timeout for initial connection
            const connectionTimeout = setTimeout(() => {
                // Check if this is still the current connection attempt
                if (connectionIdRef.current !== thisConnectionId) return;
                if (!mountedRef.current) return;

                if (eventSource.readyState === EventSource.CONNECTING) {
                    console.log('[Sentinel] Connection timeout, will retry');
                    eventSource.close();
                    eventSourceRef.current = null;
                    setSentinelStatus('disconnected');
                    scheduleRetry();
                }
            }, CONNECTION_TIMEOUT);

            eventSource.onopen = () => {
                clearTimeout(connectionTimeout);
                if (connectionIdRef.current !== thisConnectionId) return;
                if (!mountedRef.current) return;

                console.log('[Sentinel] Connected successfully');
                setSentinelStatus('connected');
                retryDelayRef.current = INITIAL_RETRY_DELAY; // Reset retry delay on success
                lastMessageTimeRef.current = Date.now();
            };

            eventSource.onmessage = (event) => {
                if (connectionIdRef.current !== thisConnectionId) return;
                if (!mountedRef.current) return;

                lastMessageTimeRef.current = Date.now();

                // Only update status if we weren't already connected (avoid unnecessary re-renders)
                setSentinelStatus(prev => prev !== 'connected' ? 'connected' : prev);

                try {
                    const data = JSON.parse(event.data);

                    if (data.type === 'heartbeat') {
                        // Just a keepalive, no action needed - but we already updated lastMessageTime
                        return;
                    }

                    if (data.type === 'alert') {
                        console.log("🛡️ Sentinel Alert:", data);
                        // Use ref to get latest addNotification
                        addNotificationRef.current(
                            data.message,
                            data.severity === 'high' ? 'error' : 'warning',
                            data.resource,
                            {
                                label: "Investigate",
                                type: 'investigate',
                                onClick: () => {
                                    if (onInvestigateRef.current) {
                                        const prompt = `Sentinel Alert: ${data.message}. RESOURCE: ${data.resource || 'unknown'}. Please analyze the root cause immediately.`;
                                        onInvestigateRef.current(prompt);
                                    } else {
                                        console.warn("Sentinel: No investigation handler connected");
                                    }
                                }
                            },
                            JSON.stringify(data, null, 2),
                            data.cluster
                        );
                    } else if (data.type === 'kb_progress') {
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
                            setTimeout(() => {
                                if (mountedRef.current) setKBProgress(null);
                            }, 2000);
                            return;
                        }

                        if (!progressThrottleRef.current) {
                            setKBProgress(newProgress);
                            progressThrottleRef.current = setTimeout(() => {
                                progressThrottleRef.current = null;
                                if (lastProgressRef.current && mountedRef.current) {
                                    setKBProgress(lastProgressRef.current);
                                }
                            }, 500);
                        }
                    }
                } catch (e) {
                    console.error("[Sentinel] Failed to parse event:", e);
                }
            };

            eventSource.onerror = (e) => {
                clearTimeout(connectionTimeout);
                if (connectionIdRef.current !== thisConnectionId) return;
                if (!mountedRef.current) return;

                // Check readyState to determine what happened
                if (eventSource.readyState === EventSource.CLOSED) {
                    console.log('[Sentinel] Connection closed by server, scheduling retry');
                    eventSourceRef.current = null;
                    setSentinelStatus('disconnected');
                    scheduleRetry();
                } else if (eventSource.readyState === EventSource.CONNECTING) {
                    // Browser is auto-retrying the connection
                    console.log('[Sentinel] Connection error, browser auto-retrying...');
                    setSentinelStatus('connecting');
                } else {
                    // OPEN state but got error - unusual, force reconnect
                    console.log('[Sentinel] Error in OPEN state, forcing reconnect');
                    eventSource.close();
                    eventSourceRef.current = null;
                    setSentinelStatus('disconnected');
                    scheduleRetry();
                }
            };
        } catch (e) {
            console.error('[Sentinel] Failed to create EventSource:', e);
            setSentinelStatus('disconnected');
            scheduleRetry();
        }
    }, []);

    // Schedule a retry with exponential backoff
    const scheduleRetry = useCallback(() => {
        if (!mountedRef.current) return;

        // Clear any existing retry timeout
        if (retryTimeoutRef.current) {
            clearTimeout(retryTimeoutRef.current);
        }

        const delay = retryDelayRef.current;
        console.log(`[Sentinel] Scheduling retry in ${delay}ms`);

        retryTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
                // Exponential backoff with max cap - increase BEFORE connect attempt
                retryDelayRef.current = Math.min(retryDelayRef.current * 2, MAX_RETRY_DELAY);
                forceReconnect();
            }
        }, delay);
    }, [forceReconnect]);

    // Health check function - detects stale connections and reconnects
    const checkHealth = useCallback(async () => {
        if (!mountedRef.current) return;

        const es = eventSourceRef.current;
        const now = Date.now();
        const timeSinceLastMessage = now - lastMessageTimeRef.current;

        if (es && es.readyState === EventSource.OPEN && timeSinceLastMessage > STALE_CONNECTION_THRESHOLD) {
            console.log(`[Sentinel] Connection stale (no message in ${Math.round(timeSinceLastMessage / 1000)}s), forcing reconnect`);
            forceReconnect();
            return;
        }

        // If EventSource is closed or doesn't exist, try to reconnect via health check
        if (!es || es.readyState === EventSource.CLOSED) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);

                const response = await fetch(`${getAgentServerUrl()}/health`, {
                    method: 'GET',
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (response.ok && mountedRef.current) {
                    console.log('[Sentinel] Health OK but EventSource closed, reconnecting...');
                    retryDelayRef.current = INITIAL_RETRY_DELAY; // Reset delay since server is healthy
                    forceReconnect();
                }
            } catch (e) {
                // Health check failed - server might be down, don't change anything
                if (mountedRef.current) {
                    console.log('[Sentinel] Health check failed, server may be down');
                    setSentinelStatus('disconnected');
                }
            }
        }
    }, [forceReconnect]);

    // Listen for Agent URL changes to force reconnect
    useEffect(() => {
        return onAgentUrlChange(() => {
            console.log('[Sentinel] Agent URL changed, forcing reconnect...');
            forceReconnect();
        });
    }, [forceReconnect]);

    // Initial connection and health check setup - runs once on mount
    useEffect(() => {
        mountedRef.current = true;
        lastMessageTimeRef.current = Date.now(); // Reset on mount

        // Start connection
        forceReconnect();

        // Start periodic health checks
        healthCheckRef.current = setInterval(() => {
            checkHealth();
        }, HEALTH_CHECK_INTERVAL);

        // Also do an immediate health check after a short delay
        const initialHealthCheck = setTimeout(() => {
            checkHealth();
        }, 2000);

        return () => {
            mountedRef.current = false;

            // Increment connection ID to invalidate any pending handlers
            connectionIdRef.current++;

            // Clean up EventSource
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }

            // Clear timers
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
            }
            if (healthCheckRef.current) {
                clearInterval(healthCheckRef.current);
            }
            if (progressThrottleRef.current) {
                clearTimeout(progressThrottleRef.current);
            }
            clearTimeout(initialHealthCheck);
        };
    }, [forceReconnect, checkHealth]);

    // Expose a manual reconnect function for external use
    const reconnect = useCallback(() => {
        console.log('[Sentinel] Manual reconnect triggered');
        retryDelayRef.current = INITIAL_RETRY_DELAY; // Reset delay for manual reconnect
        forceReconnect();
    }, [forceReconnect]);

    return { kbProgress, sentinelStatus, reconnect };
}
