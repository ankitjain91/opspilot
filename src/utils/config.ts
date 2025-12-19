
/**
 * Configuration management for OpsPilot Frontend.
 * Handles persistence of settings like Agent Server URL.
 */

// Key for creating/accessing localStorage
export const STORAGE_KEYS = {
    AGENT_URL: 'opspilot_agent_url',
    THEME: 'opspilot_theme',
};

// Default values
export const DEFAULTS = {
    AGENT_URL: 'http://127.0.0.1:8765',
};

/**
 * Get the configured Agent Server URL.
 * Checks localStorage first, then falls back to default.
 */
export function getAgentServerUrl(): string {
    if (typeof window === 'undefined') return DEFAULTS.AGENT_URL;

    let url = localStorage.getItem(STORAGE_KEYS.AGENT_URL);
    if (!url) return DEFAULTS.AGENT_URL;

    // Ensure no trailing slash
    return url.replace(/\/$/, '');
}

/**
 * Set the Agent Server URL.
 */
export function setAgentServerUrl(url: string): void {
    if (!url) {
        localStorage.removeItem(STORAGE_KEYS.AGENT_URL);
        return;
    }
    // Remove trailing slash
    localStorage.setItem(STORAGE_KEYS.AGENT_URL, url.replace(/\/$/, ''));
}
