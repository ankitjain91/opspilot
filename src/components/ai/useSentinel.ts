
import { useEffect, useState, useRef } from 'react';
import { useToast } from '../ui/Toast';

export interface KBProgress {
    current: number;
    total: number;
    message: string;
    context: string;
}

export function useSentinel(onInvestigate?: (prompt: string) => void) {
    const { showToast } = useToast();
    const [kbProgress, setKBProgress] = useState<KBProgress | null>(null);
    const progressThrottleRef = useRef<NodeJS.Timeout | null>(null);
    const lastProgressRef = useRef<KBProgress | null>(null);

    useEffect(() => {
        // Connect to the global events stream
        // Note: In production we might need a dynamic URL, but 8765 is the fixed sidecar port
        const eventSource = new EventSource('http://localhost:8765/events');

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'alert') {
                    // Display the proactive alert with context injection
                    showToast(
                        data.message,
                        data.severity === 'high' ? 'error' : 'info',
                        5000,
                        {
                            label: "Investigate",
                            onClick: () => {
                                if (onInvestigate) {
                                    // Construct the proactive prompt
                                    // We use the raw data to give the agent strict context
                                    const prompt = `Sentinel Alert: ${data.message}. RESOURCE: ${data.resource || 'unknown'}. Please analyze the root cause immediately.`;
                                    onInvestigate(prompt);
                                } else {
                                    console.warn("Sentinel: No investigation handler connected");
                                }
                            }
                        }
                    );

                    // Optional: Add sound or desktop notification here
                    console.log("🛡️ Sentinel Alert:", data);
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
        };

        return () => {
            eventSource.close();
            // Clear any pending throttle timeout
            if (progressThrottleRef.current) {
                clearTimeout(progressThrottleRef.current);
            }
        };
    }, [showToast, onInvestigate]);

    return { kbProgress };
}
