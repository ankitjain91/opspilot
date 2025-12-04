import { useEffect, useState, useCallback } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

type UpdaterState = 'idle' | 'checking' | 'downloading' | 'up-to-date';

// Global state for manual triggers
let manualCheckCallback: (() => void) | null = null;

export function checkForUpdatesManually() {
    if (manualCheckCallback) {
        manualCheckCallback();
    }
}

export function Updater() {
    const [state, setState] = useState<UpdaterState>('checking');
    const [showUpToDate, setShowUpToDate] = useState(false);

    const checkUpdate = useCallback(async (isManual = false) => {
        setState('checking');
        try {
            const update = await check();
            if (update) {
                console.log(`Found update ${update.version} from ${update.date}`);
                const yes = await ask(
                    `Update to ${update.version} is available!\n\nRelease notes: ${update.body}`,
                    { title: 'Update Available', kind: 'info', okLabel: 'Update', cancelLabel: 'Cancel' }
                );

                if (yes) {
                    setState('downloading');
                    await update.downloadAndInstall();
                    await relaunch();
                } else {
                    setState('idle');
                }
            } else {
                if (isManual) {
                    // Show "up to date" message for manual checks
                    setState('up-to-date');
                    setShowUpToDate(true);
                    await message('You are running the latest version!', { title: 'Up to Date', kind: 'info' });
                    setShowUpToDate(false);
                }
                setState('idle');
            }
        } catch (error) {
            console.error('Failed to check for updates:', error);
            if (isManual) {
                await message(`Failed to check for updates: ${error}`, { title: 'Update Error', kind: 'error' });
            }
            setState('idle');
        }
    }, []);

    useEffect(() => {
        // Register the manual check callback
        manualCheckCallback = () => checkUpdate(true);

        // Initial check on startup
        checkUpdate(false);

        // Check every hour
        const interval = setInterval(() => checkUpdate(false), 3600000);

        return () => {
            clearInterval(interval);
            manualCheckCallback = null;
        };
    }, [checkUpdate]);

    if (state === 'idle' && !showUpToDate) return null;

    const messages: Record<UpdaterState, string> = {
        'idle': '',
        'checking': 'Checking for updates...',
        'downloading': 'Downloading update...',
        'up-to-date': 'You are up to date!'
    };

    return (
        <div style={{
            position: 'fixed',
            bottom: '20px',
            left: '20px',
            background: state === 'up-to-date' ? 'rgba(34, 197, 94, 0.9)' : 'rgba(139, 92, 246, 0.9)',
            color: 'white',
            padding: '8px 16px',
            borderRadius: '8px',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            zIndex: 9999,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
            {state !== 'up-to-date' && (
                <div style={{
                    width: '14px',
                    height: '14px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: 'white',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                }} />
            )}
            {state === 'up-to-date' && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            )}
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            {messages[state]}
        </div>
    );
}
