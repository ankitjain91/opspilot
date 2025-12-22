import { useEffect } from 'react';
import { useSentinelContext } from './SentinelContext';
export type { KBProgress, SentinelStatus } from './SentinelContext';

export function useSentinel(onInvestigate?: (prompt: string) => void) {
    const { status: sentinelStatus, kbProgress, reconnect, registerInvestigator } = useSentinelContext();

    useEffect(() => {
        if (onInvestigate) {
            return registerInvestigator(onInvestigate);
        }
    }, [onInvestigate, registerInvestigator]);

    return { kbProgress, sentinelStatus, reconnect };
}
