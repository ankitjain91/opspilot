import { useEffect, useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

export function Updater() {
    const [isChecking, setIsChecking] = useState(true);
    const [isDownloading, setIsDownloading] = useState(false);

    useEffect(() => {
        const checkUpdate = async () => {
            setIsChecking(true);
            try {
                const update = await check();
                if (update) {
                    console.log(`Found update ${update.version} from ${update.date}`);
                    const yes = await ask(
                        `Update to ${update.version} is available!\n\nRelease notes: ${update.body}`,
                        { title: 'Update Available', kind: 'info', okLabel: 'Update', cancelLabel: 'Cancel' }
                    );

                    if (yes) {
                        setIsDownloading(true);
                        await update.downloadAndInstall();
                        await relaunch();
                    }
                }
            } catch (error) {
                console.error('Failed to check for updates:', error);
            } finally {
                setIsChecking(false);
            }
        };

        checkUpdate();

        // Check every hour
        const interval = setInterval(checkUpdate, 3600000);
        return () => clearInterval(interval);
    }, []);

    if (!isChecking && !isDownloading) return null;

    return (
        <div style={{
            position: 'fixed',
            bottom: '20px',
            left: '20px',
            background: 'rgba(139, 92, 246, 0.9)',
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
            <div style={{
                width: '14px',
                height: '14px',
                border: '2px solid rgba(255,255,255,0.3)',
                borderTopColor: 'white',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            {isDownloading ? 'Downloading update...' : 'Checking for updates...'}
        </div>
    );
}
