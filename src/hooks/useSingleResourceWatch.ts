import { useState, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ResourceWatchEvent } from '../types/k8s';

interface ResourceWatchTarget {
    group: string;
    version: string;
    kind: string;
    namespace: string | null;
    name: string;
}

export function useSingleResourceWatch(
    target: ResourceWatchTarget | null | undefined,
    currentContext: string | undefined,
    enabled: boolean = true
) {
    const qc = useQueryClient();
    const [isWatching, setIsWatching] = useState(false);
    const watchIdRef = useRef<string | null>(null);

    useEffect(() => {
        if (!enabled || !target || !target.name || !currentContext) {
            return;
        }

        const watchId = `watch_single_${target.group}_${target.kind}_${target.namespace}_${target.name}_${Date.now()}`;
        watchIdRef.current = watchId;
        setIsWatching(true);

        const queryKey = ["resource_details", currentContext, target.namespace, target.group, target.version, target.kind, target.name];

        // Start the watch
        invoke("start_resource_watch", {
            req: {
                group: target.group,
                version: target.version,
                kind: target.kind,
                namespace: target.namespace,
                name: target.name,
                include_raw: true
            },
            watchId
        }).catch(err => {
            console.error("Failed to start single resource watch:", err);
            setIsWatching(false);
        });

        // Listen for watch events
        const unlistenWatch = listen<ResourceWatchEvent>(`resource_watch:${watchId}`, (event) => {
            const watchEvent = event.payload;

            if ((watchEvent.event_type === "MODIFIED" || watchEvent.event_type === "ADDED") && watchEvent.resource.raw_json) {
                // Update the details cache with the new full JSON
                qc.setQueryData(queryKey, watchEvent.resource.raw_json);
            }
        });

        // Listen for watch end
        const unlistenEnd = listen(`resource_watch_end:${watchId}`, () => {
            setIsWatching(false);
        });

        // Cleanup
        return () => {
            unlistenWatch.then(fn => fn());
            unlistenEnd.then(fn => fn());
            invoke("stop_resource_watch", { watchId }).catch(() => { });
            setIsWatching(false);
        };
    }, [target?.group, target?.version, target?.kind, target?.namespace, target?.name, currentContext, enabled, qc]);

    return { isWatching };
}
