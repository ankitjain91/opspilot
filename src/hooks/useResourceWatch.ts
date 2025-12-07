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

    useEffect(() => {
        if (!enabled || !resourceType || !resourceType.kind || !currentContext) {
            return;
        }

        const watchId = `watch_${resourceType.group}_${resourceType.version}_${resourceType.kind}_${namespace || 'all'}_${Date.now()}`;
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
            const watchEvent = event.payload;

            qc.setQueryData(queryKey, (oldData: K8sObject[] | undefined) => {
                if (!oldData) return [watchEvent.resource];

                switch (watchEvent.event_type) {
                    case "ADDED":
                        // Check if already exists (might be from initial sync)
                        if (oldData.some(r => r.id === watchEvent.resource.id)) {
                            return oldData.map(r => r.id === watchEvent.resource.id ? watchEvent.resource : r);
                        }
                        return [...oldData, watchEvent.resource];

                    case "MODIFIED":
                        return oldData.map(r => r.id === watchEvent.resource.id ? watchEvent.resource : r);

                    case "DELETED":
                        return oldData.filter(r => r.id !== watchEvent.resource.id);

                    default:
                        return oldData;
                }
            });
        });

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
