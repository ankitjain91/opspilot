import React from 'react';
import { Loader2 } from 'lucide-react';

interface StatusBadgeProps {
    status?: string;
    isDeleting?: boolean;
}

export const StatusBadge = ({ status, isDeleting = false }: StatusBadgeProps) => {
    // If locally marked as deleting but API hasn't caught up, show as Terminating
    const displayStatus = isDeleting ? 'Terminating' : (status || '-');

    // Check for spinner states
    const showSpinner = displayStatus === 'Terminating' ||
        displayStatus === 'ContainerCreating' ||
        displayStatus === 'Pending' ||
        displayStatus === 'Progressing' ||
        displayStatus === 'Updating' ||
        displayStatus === 'Scaling' ||
        displayStatus === 'Attaching';

    // Helper to check if status contains replica info like "2/3 Ready"
    const isPartialReady = displayStatus.includes('/') && displayStatus.includes('Ready');
    const isFullyReady = isPartialReady && (() => {
        const match = displayStatus.match(/^(\d+)\/(\d+)/);
        return match && match[1] === match[2];
    })();

    const getConfig = () => {
        // Handle "-" (no status) - neutral gray, no dot
        if (displayStatus === '-') {
            return {
                badge: 'bg-zinc-800/50 text-zinc-500 border-zinc-700/50',
                dot: 'hidden'
            };
        }

        // Handle "X/Y Ready" format
        if (isPartialReady) {
            if (isFullyReady) {
                return {
                    badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
                    dot: 'bg-emerald-400'
                };
            } else {
                return {
                    badge: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
                    dot: 'bg-yellow-400'
                };
            }
        }

        // Handle "X Active" format (CronJobs)
        if (displayStatus.includes(' Active')) {
            return {
                badge: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
                dot: 'bg-blue-400'
            };
        }

        // Handle HPA "X/Y" format
        if (/^\d+\/\d+$/.test(displayStatus)) {
            return {
                badge: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40',
                dot: 'bg-cyan-400'
            };
        }

        // Handle Endpoints "N addr" format
        if (displayStatus.endsWith(' addr')) {
            return {
                badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
                dot: 'bg-emerald-400'
            };
        }

        // Handle "N Ready" format (EndpointSlice)
        if (/^\d+ Ready$/.test(displayStatus)) {
            return {
                badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
                dot: 'bg-emerald-400'
            };
        }

        switch (displayStatus) {
            // Success states
            case 'Active':
            case 'Running':
            case 'Bound':
            case 'Ready':
            case 'Succeeded':
            case 'Available':
            case 'Complete':
            case 'Attached':
            case 'Synced':
            case 'Healthy':
            case 'Scheduled':
                return {
                    badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
                    dot: 'bg-emerald-400'
                };

            // Warning/pending states
            case 'Pending':
            case 'ContainerCreating':
            case 'Waiting':
            case 'Progressing':
            case 'Attaching':
            case 'Released':
                return {
                    badge: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
                    dot: 'bg-yellow-400'
                };

            // Info/updating states
            case 'Updating':
            case 'Syncing':
            case 'OutOfSync':
                return {
                    badge: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
                    dot: 'bg-blue-400'
                };

            // Transitional states
            case 'Scaling':
            case 'Terminating':
            case 'Suspended':
                return {
                    badge: 'bg-orange-500/20 text-orange-400 border-orange-500/40',
                    dot: 'bg-orange-400'
                };

            // Error states
            case 'CrashLoopBackOff':
            case 'Error':
            case 'Failed':
            case 'ImagePullBackOff':
            case 'ErrImagePull':
            case 'NotReady':
            case 'Degraded':
            case 'Unknown':
            case 'Missing':
            case 'No addresses':
            case 'Empty':
                return {
                    badge: 'bg-red-500/20 text-red-400 border-red-500/40',
                    dot: 'bg-red-400'
                };

            // Service types (neutral info)
            case 'ClusterIP':
            case 'NodePort':
            case 'ExternalName':
            case 'LoadBalancer':
                return {
                    badge: 'bg-purple-500/20 text-purple-400 border-purple-500/40',
                    dot: 'bg-purple-400'
                };

            // Annotated LoadBalancer pending state
            case 'LoadBalancer (pending)':
                return {
                    badge: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
                    dot: 'bg-yellow-400'
                };

            default:
                // Check for "Not*" prefix patterns (e.g., "NotBound", "NotAttached")
                if (displayStatus.startsWith('Not')) {
                    return {
                        badge: 'bg-red-500/20 text-red-400 border-red-500/40',
                        dot: 'bg-red-400'
                    };
                }
                return {
                    badge: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/40',
                    dot: 'bg-zinc-400'
                };
        }
    };

    const config = getConfig();

    return (
        <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${config.badge} inline-flex items-center gap-1`}>
            {showSpinner ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
            ) : (
                <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
            )}
            {displayStatus}
        </span>
    );
};
