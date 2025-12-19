
import { useEffect, useState, useRef } from 'react';
import { useToast } from '../ui/Toast';
import { useNotifications } from '../notifications/NotificationContext';

export interface KBProgress {
    current: number;
    total: number;
    message: string;
    context: string;
}

export type SentinelStatus = 'connected' | 'connecting' | 'disconnected';

export function useSentinel(onInvestigate?: (prompt: string) => void) {
    const { showToast } = useToast();
    const { addNotification } = useNotifications();
    const [kbProgress, setKBProgress] = useState<KBProgress | null>(null);
    const [sentinelStatus, setSentinelStatus] = useState<SentinelStatus>('connecting');
    const progressThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastProgressRef = useRef<KBProgress | null>(null);
    const onInvestigateRef = useRef(onInvestigate);

    useEffect(() => {
        onInvestigateRef.current = onInvestigate;
    }, [onInvestigate]);

    useEffect(() => {
        // Connect to the global events stream
        // Note: In production we might need a dynamic URL, but 8765 is the fixed sidecar port
        const eventSource = new EventSource('http://localhost:8765/events');

        eventSource.onopen = () => {
            setSentinelStatus('connected');
        };

        eventSource.onmessage = (event) => {
            // Any message means we're connected
            setSentinelStatus('connected');
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'alert') {
                    // Optional: Add sound or desktop notification here
                    console.log("🛡️ Sentinel Alert:", data);

                    // Add to persistent notification history
                    addNotification(
                        data.message,
                        data.severity === 'high' ? 'error' : 'warning',
                        data.resource,
                        {
                            label: "Investigate",
                            type: 'investigate',
                            onClick: () => {
                                if (onInvestigateRef.current) {
                                    // Construct the proactive prompt
                                    const prompt = `Sentinel Alert: ${data.message}. RESOURCE: ${data.resource || 'unknown'}. Please analyze the root cause immediately.`;
                                    onInvestigateRef.current(prompt);
                                } else {
                                    console.warn("Sentinel: No investigation handler connected");
                                }
                            }
                        },
                        JSON.stringify(data, null, 2), // Pass full details
                        data.cluster // Pass cluster context
                    );
                } else if (data.type === 'kb_progress') {
                    // CRD loading progress - throttle updates to prevent flicker
                    const newProgress = {
                        current: data.current,
                        total: data.total,
                        message: data.message,
                        context: data.context
                    };

                    lastProgressRef.current = newProgress;

                    // Always show immediately if complete
                    if (data.current === data.total) {
                        if (progressThrottleRef.current) {
                            clearTimeout(progressThrottleRef.current);
                        }
                        setKBProgress(newProgress);
                        setTimeout(() => setKBProgress(null), 2000);
                        return;
                    }

                    // Throttle intermediate updates to max 2 per second
                    if (!progressThrottleRef.current) {
                        setKBProgress(newProgress);
                        progressThrottleRef.current = setTimeout(() => {
                            progressThrottleRef.current = null;
                            // Update with latest progress if it changed
                            if (lastProgressRef.current) {
                                setKBProgress(lastProgressRef.current);
                            }
                        }, 500);
                    }
                }
            } catch (e) {
                console.error("Failed to parse Sentinel event:", e);
            }
        };

        eventSource.onerror = (err) => {
            // SSE often disconnects on reload/sleep, silent reconnect logic is built-in to browser
            // but we log here for debugging
            console.debug("Sentinel SSE connection lost/retry", err);
            // EventSource will auto-reconnect, mark as connecting
            setSentinelStatus(eventSource.readyState === EventSource.CLOSED ? 'disconnected' : 'connecting');
        };

        return () => {
            eventSource.close();
            // Clear any pending throttle timeout
            if (progressThrottleRef.current) {
                clearTimeout(progressThrottleRef.current);
            }
        };
    }, [showToast, addNotification]); // Removed onInvestigate from dependency

    return { kbProgress, sentinelStatus };
}
