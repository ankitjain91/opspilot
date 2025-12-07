import React from 'react';
import { Loader2 } from 'lucide-react';

interface StatusBadgeProps {
    status?: string;
    isDeleting?: boolean;
}

export const StatusBadge = ({ status, isDeleting = false }: StatusBadgeProps) => {
    // If locally marked as deleting but API hasn't caught up, show as Terminating
    const displayStatus = isDeleting ? 'Terminating' : (status || 'Unknown');
    const showSpinner = displayStatus === 'Terminating' || displayStatus === 'ContainerCreating' || displayStatus === 'Pending' || displayStatus === 'Progressing' || displayStatus === 'Updating' || displayStatus === 'Scaling';

    const getConfig = () => {
        switch (displayStatus) {
            case 'Active':
            case 'Running':
            case 'Bound':
            case 'Ready':
            case 'Succeeded':
            case 'Available':
                return {
                    badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
                    dot: 'bg-emerald-400'
                };
            case 'Pending':
            case 'ContainerCreating':
            case 'Waiting':
            case 'Progressing':
                return {
                    badge: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
                    dot: 'bg-yellow-400'
                };
            case 'Updating':
                return {
                    badge: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
                    dot: 'bg-blue-400'
                };
            case 'Scaling':
            case 'Terminating':
                return {
                    badge: 'bg-orange-500/20 text-orange-400 border-orange-500/40',
                    dot: 'bg-orange-400'
                };
            case 'CrashLoopBackOff':
            case 'Error':
            case 'Failed':
            case 'ImagePullBackOff':
            case 'ErrImagePull':
                return {
                    badge: 'bg-red-500/20 text-red-400 border-red-500/40',
                    dot: 'bg-red-400'
                };
            default:
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
