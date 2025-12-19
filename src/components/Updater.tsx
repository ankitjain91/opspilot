import { useEffect, useState, useCallback } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
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
    const [showModal, setShowModal] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<{ version: string; body: string } | null>(null);
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [downloadProgress, setDownloadProgress] = useState(0);

    // Sync global state
    useEffect(() => {
        globalState = state;
        globalSetState = setState;
        onStateChange?.(state);
    }, [state, onStateChange]);

    const handleUpdate = useCallback(async () => {
        if (!pendingUpdate) return;
        setShowModal(false);
        setState('downloading');
        setShowToast(true);
        setDownloadProgress(0);

        let downloaded = 0;
        let total = 0;

        try {
            await pendingUpdate.downloadAndInstall((event) => {
                console.log('[Updater] Event:', event);
                switch (event.event) {
                    case 'Started':
                        total = event.data.contentLength || 0;
                        console.log('[Updater] Started. Total:', total);
                        if (total === 0) {
                            setDownloadProgress(-1);
                        } else {
                            setDownloadProgress(1);
                        }
                        break;
                    case 'Progress':
                        downloaded += event.data.chunkLength;
                        if (total > 0) {
                            setDownloadProgress(Math.round((downloaded / total) * 100));
                        }
                        break;
                    case 'Finished':
                        setDownloadProgress(100);
                        break;
                }
            });
            await relaunch();
        } catch (err) {
            console.error('Failed to install update:', err);
            setState('error');
            setErrorMessage(String(err));
        }
    }, []);

    const handleLater = useCallback(() => {
        setShowModal(false);
        // Keep state as 'update-available' so the badge shows
    }, []);

    const checkUpdate = useCallback(async (isManual = false) => {
        console.log('[Updater] Starting update check, manual:', isManual);
        setState('checking');
        setErrorMessage(''); // Clear previous error message
        if (isManual) setShowToast(true);

        try {
            const update = await check();
            console.log('[Updater] Check result:', update ? `v${update.version}` : 'no update');

            if (update) {
                pendingUpdate = update;
                setState('update-available');
                setUpdateInfo({ version: update.version, body: update.body || 'See release notes on GitHub' });
                setShowModal(true);
                setShowToast(true);
            } else {
                pendingUpdate = null;
                if (isManual) {
                    setState('up-to-date');
                    setShowToast(true);
                    setTimeout(() => {
                        setState('idle');
                        setShowToast(false);
                    }, 3000);
                } else {
                    setState('idle');
                    setShowToast(false);
                }
            }
        } catch (error: any) {
            console.error('[Updater] Failed to check for updates:', error);
            // Store the actual error message
            const msg = error?.message || error?.toString() || 'Unknown error';
            setErrorMessage(msg);

            pendingUpdate = null;
            if (isManual) {
                setState('error');
                setShowToast(true);
                setTimeout(() => {
                    setState('idle');
                    setShowToast(false);
                }, 3000);
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

        // Skip auto-check in development mode
        // if (import.meta.env.DEV) {
        //     console.log('[Updater] Skipping auto-check in development mode');
        //     return () => {
        //         checkUpdateFn = null;
        //     };
        // }

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

    const toastConfig: Record<string, { bg: string; message: string; icon: 'spinner' | 'check' | 'error' | 'update' }> = {
        'idle': { bg: 'rgba(139, 92, 246, 0.9)', message: 'Ready', icon: 'check' },
        'checking': { bg: 'rgba(139, 92, 246, 0.9)', message: 'Checking for updates...', icon: 'spinner' },
        'update-available': { bg: 'rgba(168, 85, 247, 0.95)', message: 'Update available!', icon: 'update' },
        'downloading': { bg: 'rgba(139, 92, 246, 0.9)', message: 'Downloading update...', icon: 'spinner' },
        'up-to-date': { bg: 'rgba(34, 197, 94, 0.9)', message: 'You are up to date!', icon: 'check' },
        'error': { bg: 'rgba(239, 68, 68, 0.9)', message: 'Update check failed', icon: 'error' },
    };

    const { bg, message: msg, icon } = toastConfig[state] || toastConfig['checking'];

    return (
        <>
            {/* Update Modal */}
            {showModal && updateInfo && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.7)',
                        backdropFilter: 'blur(4px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                    }}
                    onClick={handleLater}
                >
                    <div
                        style={{
                            background: 'linear-gradient(135deg, #1a1a2e 0%, #16162a 100%)',
                            borderRadius: '16px',
                            padding: '24px',
                            maxWidth: '420px',
                            width: '90%',
                            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(139, 92, 246, 0.2)',
                            border: '1px solid rgba(139, 92, 246, 0.3)',
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                            <div style={{
                                width: '40px',
                                height: '40px',
                                borderRadius: '10px',
                                background: 'linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}>
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                            </div>
                            <div>
                                <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'white' }}>
                                    Update Available
                                </h2>
                                <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.6)' }}>
                                    Version {updateInfo.version}
                                </p>
                            </div>
                        </div>

                        {/* Body */}
                        <div style={{
                            background: 'rgba(0, 0, 0, 0.3)',
                            borderRadius: '8px',
                            padding: '12px',
                            marginBottom: '20px',
                            maxHeight: '150px',
                            overflowY: 'auto',
                        }}>
                            <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.8)', lineHeight: 1.5 }}>
                                {updateInfo.body}
                            </p>
                        </div>

                        {/* Buttons */}
                        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                            <button
                                onClick={handleLater}
                                style={{
                                    padding: '10px 20px',
                                    borderRadius: '8px',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    background: 'transparent',
                                    color: 'rgba(255,255,255,0.8)',
                                    fontSize: '14px',
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                }}
                                onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                                onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                            >
                                Later
                            </button>
                            <button
                                onClick={handleUpdate}
                                style={{
                                    padding: '10px 24px',
                                    borderRadius: '8px',
                                    border: 'none',
                                    background: 'linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%)',
                                    color: 'white',
                                    fontSize: '14px',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                    boxShadow: '0 4px 12px rgba(139, 92, 246, 0.4)',
                                }}
                                onMouseOver={e => e.currentTarget.style.transform = 'translateY(-1px)'}
                                onMouseOut={e => e.currentTarget.style.transform = 'translateY(0)'}
                            >
                                Update Now
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Toast notification */}
            {(showToast || state === 'downloading') && state !== 'idle' && !showModal && (
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span>{state === 'downloading' ? (downloadProgress >= 0 ? `Downloading... ${downloadProgress}%` : 'Downloading update...') : msg}</span>
                        {state === 'downloading' && downloadProgress >= 0 && (
                            <div style={{
                                width: '100%',
                                height: '4px',
                                background: 'rgba(255,255,255,0.2)',
                                borderRadius: '2px',
                                marginTop: '2px',
                                overflow: 'hidden'
                            }}>
                                <div style={{
                                    width: `${downloadProgress}%`,
                                    height: '100%',
                                    background: 'white',
                                    transition: 'width 0.2s ease-out'
                                }} />
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
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
