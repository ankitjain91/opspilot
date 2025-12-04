import { useEffect, useState, useCallback } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdaterState = 'idle' | 'checking' | 'update-available' | 'downloading' | 'up-to-date' | 'error';

// Global state for external components
let globalState: UpdaterState = 'idle';
let globalSetState: ((state: UpdaterState) => void) | null = null;
let pendingUpdate: Update | null = null;
let manualCheckCallback: (() => void) | null = null;

export function getUpdaterState(): UpdaterState {
    return globalState;
}

export function checkForUpdatesManually() {
    if (manualCheckCallback) {
        manualCheckCallback();
    }
}

export function installPendingUpdate() {
    if (pendingUpdate && globalSetState) {
        globalSetState('downloading');
        pendingUpdate.downloadAndInstall().then(() => {
            relaunch();
        }).catch((err) => {
            console.error('Failed to install update:', err);
            globalSetState?.('error');
        });
    }
}

interface UpdaterProps {
    onStateChange?: (state: UpdaterState) => void;
}

export function Updater({ onStateChange }: UpdaterProps) {
    const [state, setState] = useState<UpdaterState>('checking');

    // Sync global state
    useEffect(() => {
        globalState = state;
        globalSetState = setState;
        onStateChange?.(state);
    }, [state, onStateChange]);

    const checkUpdate = useCallback(async (isManual = false) => {
        setState('checking');
        try {
            const update = await check();
            if (update) {
                console.log(`Found update ${update.version} from ${update.date}`);
                pendingUpdate = update;
                setState('update-available');

                const yes = await ask(
                    `Update to ${update.version} is available!\n\nRelease notes: ${update.body}`,
                    { title: 'Update Available', kind: 'info', okLabel: 'Update', cancelLabel: 'Later' }
                );

                if (yes) {
                    setState('downloading');
                    await update.downloadAndInstall();
                    await relaunch();
                }
                // Keep state as 'update-available' if user clicks Later
            } else {
                pendingUpdate = null;
                if (isManual) {
                    setState('up-to-date');
                    await message('You are running the latest version!', { title: 'Up to Date', kind: 'info' });
                    setTimeout(() => setState('idle'), 2000);
                } else {
                    setState('idle');
                }
            }
        } catch (error) {
            console.error('Failed to check for updates:', error);
            pendingUpdate = null;
            if (isManual) {
                setState('error');
                await message(`Failed to check for updates: ${error}`, { title: 'Update Error', kind: 'error' });
                setTimeout(() => setState('idle'), 2000);
            } else {
                setState('idle');
            }
        }
    }, []);

    useEffect(() => {
        manualCheckCallback = () => checkUpdate(true);
        checkUpdate(false);
        const interval = setInterval(() => checkUpdate(false), 3600000);
        return () => {
            clearInterval(interval);
            manualCheckCallback = null;
        };
    }, [checkUpdate]);

    // Toast notification
    if (state === 'idle') return null;
    if (state === 'update-available') return null; // Button will show the indicator

    const config: Record<string, { bg: string; message: string; icon: 'spinner' | 'check' | 'error' }> = {
        'checking': { bg: 'rgba(139, 92, 246, 0.9)', message: 'Checking for updates...', icon: 'spinner' },
        'downloading': { bg: 'rgba(139, 92, 246, 0.9)', message: 'Downloading update...', icon: 'spinner' },
        'up-to-date': { bg: 'rgba(34, 197, 94, 0.9)', message: 'You are up to date!', icon: 'check' },
        'error': { bg: 'rgba(239, 68, 68, 0.9)', message: 'Update check failed', icon: 'error' },
    };

    const { bg, message: msg, icon } = config[state] || config['checking'];

    return (
        <div style={{
            position: 'fixed',
            bottom: '20px',
            left: '20px',
            background: bg,
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
            {icon === 'spinner' && (
                <div style={{
                    width: '14px',
                    height: '14px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: 'white',
                    borderRadius: '50%',
                    animation: 'updater-spin 1s linear infinite',
                }} />
            )}
            {icon === 'check' && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            )}
            {icon === 'error' && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
            )}
            <style>{`@keyframes updater-spin { to { transform: rotate(360deg); } }`}</style>
            {msg}
        </div>
    );
}

// Hook for components that want to subscribe to updater state
export function useUpdaterState() {
    const [state, setState] = useState<UpdaterState>(globalState);

    useEffect(() => {
        const interval = setInterval(() => {
            if (globalState !== state) {
                setState(globalState);
            }
        }, 100);
        return () => clearInterval(interval);
    }, [state]);

    return state;
}
