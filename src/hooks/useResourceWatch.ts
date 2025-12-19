import { useState, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { NavResource, ResourceWatchEvent, K8sObject } from '../types/k8s';

export function useResourceWatch(
    resourceType: NavResource | null,
    namespace: string | null,
    currentContext: string | undefined,
    enabled: boolean = true
) {
    const qc = useQueryClient();
    const [isWatching, setIsWatching] = useState(false);
    const [syncComplete, setSyncComplete] = useState(false);
    const watchIdRef = useRef<string | null>(null);
    const eventBufferRef = useRef<ResourceWatchEvent[]>([]);
    const lastFlushRef = useRef<number>(0);

    useEffect(() => {
        if (!enabled || !resourceType || !resourceType.kind || !currentContext) {
            return;
        }

        const rawWatchId = `watch_${resourceType.group}_${resourceType.version}_${resourceType.kind}_${namespace || 'all'}_${Date.now()}`;
        // Tauri event names must be alphanumeric with -, /, :, _. No dots allowed.
        const watchId = rawWatchId.replace(/[^a-zA-Z0-9-/_]/g, '_');
        watchIdRef.current = watchId;
        setIsWatching(true);
        setSyncComplete(false);

        const queryKey = ["list_resources", currentContext, resourceType.group || "", resourceType.version || "", resourceType.kind || "", namespace === null ? "All Namespaces" : namespace];

        // Start the watch
        invoke("start_resource_watch", {
            req: {
                group: resourceType.group,
                version: resourceType.version,
                kind: resourceType.kind,
                namespace: namespace
            },
            watchId
        }).catch(err => {
            console.error("Failed to start resource watch:", err);
            setIsWatching(false);
        });

        // Listen for watch events
        const unlistenWatch = listen<ResourceWatchEvent>(`resource_watch:${watchId}`, (event) => {
            eventBufferRef.current.push(event.payload);
        });

        // Flush Buffer Effect (10fps for UI updates)
        const interval = setInterval(() => {
            if (eventBufferRef.current.length === 0) return;

            const batch = eventBufferRef.current.splice(0, eventBufferRef.current.length);
            console.log(`[useResourceWatch] Flushing batch of ${batch.length} events for ${resourceType.kind}`);

            qc.setQueryData(queryKey, (oldData: K8sObject[] | undefined) => {
                if (!oldData) return batch.map(e => e.resource);

                let newData = [...oldData];

                // Process batch - use a Map for O(1) deduplication within the batch
                const updates = new Map<string, ResourceWatchEvent>();
                batch.forEach(e => updates.set(e.resource.id, e));

                updates.forEach((event) => {
                    switch (event.event_type) {
                        case "ADDED":
                        case "MODIFIED":
                            const index = newData.findIndex(r => r.id === event.resource.id);
                            if (index >= 0) {
                                newData[index] = event.resource;
                            } else {
                                newData.push(event.resource);
                            }
                            break;
                        case "DELETED":
                            newData = newData.filter(r => r.id !== event.resource.id);
                            break;
                    }
                });

                return newData;
            });
        }, 100);

        // Listen for sync complete
        const unlistenSync = listen(`resource_watch_sync:${watchId}`, () => {
            setSyncComplete(true);
        });

        // Listen for watch end
        const unlistenEnd = listen(`resource_watch_end:${watchId}`, () => {
            setIsWatching(false);
            setSyncComplete(false);
        });

        // Cleanup
        return () => {
            clearInterval(interval);
            unlistenWatch.then(fn => fn());
            unlistenSync.then(fn => fn());
            unlistenEnd.then(fn => fn());
            invoke("stop_resource_watch", { watchId }).catch(() => { });
            setIsWatching(false);
            setSyncComplete(false);
        };
    }, [resourceType?.group, resourceType?.version, resourceType?.kind, namespace, currentContext, enabled, qc]);

    return { isWatching, syncComplete };
}
