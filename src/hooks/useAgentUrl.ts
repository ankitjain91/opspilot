import { useState, useEffect } from 'react';
import { getAgentServerUrl, onAgentUrlChange } from '../utils/config';

/**
 * Hook to get the current Agent Server URL and listen for changes.
 * This ensures components reactively update if the agent restarts on a new port.
 */
export function useAgentUrl(): string {
    const [url, setUrl] = useState(getAgentServerUrl());

    useEffect(() => {
        return onAgentUrlChange((newUrl) => {
            setUrl(newUrl);
        });
    }, []);

    return url;
}
