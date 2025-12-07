import { useState, useEffect } from 'react';

// Format age as relative time
export const formatAge = (isoDate: string): string => {
    const now = Date.now();
    const created = new Date(isoDate).getTime();
    const diffMs = now - created;

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return `${days}d${hours % 24}h`;
    } else if (hours > 0) {
        return `${hours}h${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
};

// Hook to trigger periodic re-renders for live age updates
export function useLiveAge(intervalMs: number = 1000): number {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setTick(t => t + 1), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return tick;
}
