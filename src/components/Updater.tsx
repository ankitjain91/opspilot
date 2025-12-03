import { useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

export function Updater() {
    useEffect(() => {
        const checkUpdate = async () => {
            try {
                const update = await check();
                if (update) {
                    console.log(`Found update ${update.version} from ${update.date}`);
                    const yes = await ask(
                        `Update to ${update.version} is available!\n\nRelease notes: ${update.body}`,
                        { title: 'Update Available', kind: 'info', okLabel: 'Update', cancelLabel: 'Cancel' }
                    );

                    if (yes) {
                        await update.downloadAndInstall();
                        await relaunch();
                    }
                }
            } catch (error) {
                console.error('Failed to check for updates:', error);
            }
        };

        checkUpdate();

        // Check every hour
        const interval = setInterval(checkUpdate, 3600000);
        return () => clearInterval(interval);
    }, []);

    return null; // This component doesn't render anything visible
}
