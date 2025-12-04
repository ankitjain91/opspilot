import { useEffect, useState, useCallback } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdaterState = 'idle' | 'checking' | 'update-available' | 'downloading' | 'up-to-date' | 'error';

// Global state for external components
let globalState: UpdaterState = 'idle';
let globalSetState: ((state: UpdaterState) => void) | null = null;
let pendingUpdate: Update | null = null;
let checkUpdateFn: ((isManual: boolean) => Promise<void>) | null = null;

export function getUpdaterState(): UpdaterState {
    return globalState;
}

export async function checkForUpdatesManually() {
    console.log('[Updater] Manual check triggered, current state:', globalState);
    if (checkUpdateFn) {
        await checkUpdateFn(true);
    } else {
        console.error('[Updater] checkUpdateFn not initialized');
        // Fallback: show error message
        try {
            await message('Update checker not ready. Please try again.', { title: 'Update', kind: 'warning' });
        } catch (e) {
            console.error('[Updater] Failed to show message:', e);
        }
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
    const [state, setState] = useState<UpdaterState>('idle');
    const [showToast, setShowToast] = useState(false);

    // Sync global state
    useEffect(() => {
        globalState = state;
        globalSetState = setState;
        onStateChange?.(state);
    }, [state, onStateChange]);

    const checkUpdate = useCallback(async (isManual = false) => {
        console.log('[Updater] Starting update check, manual:', isManual);
        setState('checking');
        if (isManual) setShowToast(true);

        try {
            const update = await check();
            console.log('[Updater] Check result:', update ? `v${update.version}` : 'no update');

            if (update) {
                pendingUpdate = update;
                setState('update-available');
                setShowToast(true);

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
                    setShowToast(true);
                    await message('You are running the latest version!', { title: 'Up to Date', kind: 'info' });
                    setTimeout(() => {
                        setState('idle');
                        setShowToast(false);
                    }, 2000);
                } else {
                    setState('idle');
                    setShowToast(false);
                }
            }
        } catch (error) {
            console.error('[Updater] Failed to check for updates:', error);
            pendingUpdate = null;
            if (isManual) {
                setState('error');
                setShowToast(true);
                await message(`Failed to check for updates: ${error}`, { title: 'Update Error', kind: 'error' });
                setTimeout(() => {
                    setState('idle');
                    setShowToast(false);
                }, 2000);
            } else {
                setState('idle');
                setShowToast(false);
            }
        }
    }, []);

    useEffect(() => {
        // Register the check function globally
        checkUpdateFn = checkUpdate;
        console.log('[Updater] Component mounted, checkUpdateFn registered');

        // Initial check on startup (silent)
        checkUpdate(false);

        // Check every hour
        const interval = setInterval(() => checkUpdate(false), 3600000);

        return () => {
            clearInterval(interval);
            checkUpdateFn = null;
            console.log('[Updater] Component unmounted');
        };
    }, [checkUpdate]);

    // Toast notification - show when checking, downloading, up-to-date, error, or update-available
    if (!showToast && state === 'idle') return null;
    if (state === 'update-available' && !showToast) return null; // Button will show the indicator

    const config: Record<string, { bg: string; message: string; icon: 'spinner' | 'check' | 'error' | 'update' }> = {
        'idle': { bg: 'rgba(139, 92, 246, 0.9)', message: 'Ready', icon: 'check' },
        'checking': { bg: 'rgba(139, 92, 246, 0.9)', message: 'Checking for updates...', icon: 'spinner' },
        'update-available': { bg: 'rgba(168, 85, 247, 0.95)', message: 'Update available!', icon: 'update' },
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
            padding: '10px 16px',
            borderRadius: '10px',
            fontSize: '13px',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            zIndex: 9999,
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            border: '1px solid rgba(255,255,255,0.1)',
        }}>
            {icon === 'spinner' && (
                <div style={{
                    width: '16px',
                    height: '16px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: 'white',
                    borderRadius: '50%',
                    animation: 'updater-spin 1s linear infinite',
                }} />
            )}
            {icon === 'check' && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            )}
            {icon === 'error' && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
            )}
            {icon === 'update' && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
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
