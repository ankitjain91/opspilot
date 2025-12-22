/**
 * Configuration management for OpsPilot Frontend.
 *
 * Configuration is loaded in priority order:
 * 1. Environment variables (OPSPILOT_*)
 * 2. Config file (~/.opspilot.json or .opspilot.json in project root)
 * 3. localStorage (user settings from UI)
 * 4. Smart defaults (auto-detect where possible)
 *
 * This ensures the app works out-of-the-box with minimal user configuration.
 */

import { invoke } from '@tauri-apps/api/core';

// Storage keys for localStorage
export const STORAGE_KEYS = {
    AGENT_URL: 'opspilot_agent_url',
    CLAUDE_CLI_PATH: 'opspilot_claude_cli_path',
    EMBEDDING_ENDPOINT: 'opspilot_embedding_endpoint',
    THEME: 'opspilot_theme',
    CONFIG_SOURCE: 'opspilot_config_source', // Track where config came from
    PROJECT_MAPPINGS: 'opspilot_project_mappings', // New: Smart Code Discovery
};

// Default values
export const DEFAULTS = {
    AGENT_URL: 'http://127.0.0.1:8765',
    CLAUDE_CLI_PATH: 'claude',
    EMBEDDING_ENDPOINT: 'http://127.0.0.1:11434',
    EMBEDDING_MODEL: 'nomic-embed-text',
};

// Config file structure
export interface OpsPilotConfig {
    agentServerUrl?: string;
    claudeCliPath?: string;
    embeddingEndpoint?: string;
    embeddingModel?: string;
    githubToken?: string;
    kubeconfig?: string;
    theme?: 'light' | 'dark';
    project_mappings?: Array<{ image_pattern: string; local_path: string; }>;
}

// Cache for loaded config
let cachedConfig: OpsPilotConfig | null = null;
let configLoadPromise: Promise<OpsPilotConfig> | null = null;

// Reactive URL Cache
let activeAgentUrl: string = DEFAULTS.AGENT_URL;
const urlListeners: Set<(url: string) => void> = new Set();

/**
 * Subscribe to Agent URL changes.
 */
export function onAgentUrlChange(callback: (url: string) => void): () => void {
    urlListeners.add(callback);
    callback(activeAgentUrl);
    return () => urlListeners.delete(callback);
}

function notifyUrlChange(newUrl: string) {
    if (newUrl === activeAgentUrl) return;
    activeAgentUrl = newUrl;
    console.log(`[Config] Agent URL updated: ${newUrl}`);
    urlListeners.forEach(cb => cb(newUrl));
}

/**
 * Load configuration from file via Tauri backend.
 * Looks for .opspilot.json in home directory and current project.
 */
async function loadConfigFile(): Promise<OpsPilotConfig> {
    if (cachedConfig) return cachedConfig;
    if (configLoadPromise) return configLoadPromise;

    configLoadPromise = (async () => {
        try {
            const config = await invoke<OpsPilotConfig>('load_opspilot_config');
            cachedConfig = config || {};
            return cachedConfig;
        } catch (e) {
            console.debug('No config file found, using defaults:', e);
            cachedConfig = {};
            return cachedConfig;
        }
    })();

    return configLoadPromise;
}

/**
 * Get environment variable value (via Tauri).
 * Returns null if not set.
 */
async function getEnvVar(name: string): Promise<string | null> {
    try {
        const value = await invoke<string | null>('get_env_var', { name });
        return value || null;
    } catch {
        return null;
    }
}

/**
 * Configuration source tracking for debugging.
 */
export type ConfigSource = 'env' | 'file' | 'localStorage' | 'default' | 'auto-detected';

interface ConfigValue<T> {
    value: T;
    source: ConfigSource;
}

/**
 * Get the configured Agent Server URL.
 * Priority: localStorage > Default
 * 
 * NOTE: This is the synchronous version. Users should prefer getAgentServerUrlAsync
 * for more robust detection on startup.
 */
/**
 * Get the configured Agent Server URL.
 * Priority: Memory Cache > localStorage > Default
 */
export function getAgentServerUrl(): string {
    if (typeof window === 'undefined') return DEFAULTS.AGENT_URL;

    // We clean the URL to ensure no trailing slashes
    const stored = localStorage.getItem(STORAGE_KEYS.AGENT_URL);
    const url = activeAgentUrl || stored || DEFAULTS.AGENT_URL;
    return url.trim().replace(/\/+$/, '');
}

/**
 * Async version that checks all config sources and updates the cache.
 */
export async function getAgentServerUrlAsync(): Promise<ConfigValue<string>> {
    let finalUrl = DEFAULTS.AGENT_URL;
    let finalSource: ConfigSource = 'default';

    // 1. Check environment variable
    const envUrl = await getEnvVar('OPSPILOT_AGENT_URL');
    if (envUrl) {
        finalUrl = envUrl;
        finalSource = 'env';
    } else {
        // 2. Check config file
        const config = await loadConfigFile();
        if (config.agentServerUrl) {
            finalUrl = config.agentServerUrl;
            finalSource = 'file';
        } else {
            // 3. Try auto-detection (check broadcast file)
            const autoDetected = await autoDetectAgentUrl();
            if (autoDetected) {
                finalUrl = autoDetected;
                finalSource = 'auto-detected';
            } else if (typeof window !== 'undefined') {
                // 4. Check localStorage
                const stored = localStorage.getItem(STORAGE_KEYS.AGENT_URL);
                if (stored) {
                    finalUrl = stored;
                    finalSource = 'localStorage';
                }
            }
        }
    }

    const value = finalUrl.replace(/\/$/, '');
    notifyUrlChange(value);
    return { value, source: finalSource };
}

/**
 * Try to auto-detect the agent server URL by checking common locations.
 */
async function autoDetectAgentUrl(): Promise<string | null> {
    const urlsToTry = [
        'http://127.0.0.1:8765',
        'http://localhost:8765',
    ];

    // 0. Try to read from agent_port file (most reliable) with retries for startup delay
    for (let i = 0; i < 5; i++) {
        try {
            const serverInfo = await invoke<{ port: number, url: string }>('read_server_info_file');
            if (serverInfo && serverInfo.port) {
                console.log(`[Config] Found server info file: port ${serverInfo.port} (attempt ${i + 1})`);
                const detectedUrl = serverInfo.url || `http://127.0.0.1:${serverInfo.port}`;
                urlsToTry.unshift(detectedUrl);
                // If we found it via file, prioritize it and break early from info check
                break;
            }
        } catch (e) {
            // Only wait if it's not the last attempt
            if (i < 4) await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Also try to get network URL from agent
    for (const url of [...new Set(urlsToTry)]) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);

            const response = await fetch(`${url}/health`, {
                method: 'GET',
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                // Agent is running, try to get network URL
                try {
                    const infoResp = await fetch(`${url}/info`);
                    if (infoResp.ok) {
                        const info = await infoResp.json();
                        if (info.network_url) {
                            return info.network_url;
                        }
                    }
                } catch {
                    // Fall back to the URL that worked
                }
                return url;
            }
        } catch {
            // Try next URL
        }
    }

    return null;
}

/**
 * Set the Agent Server URL in localStorage.
 */
export function setAgentServerUrl(url: string): void {
    if (!url) {
        localStorage.removeItem(STORAGE_KEYS.AGENT_URL);
        return;
    }
    localStorage.setItem(STORAGE_KEYS.AGENT_URL, url.replace(/\/$/, ''));
}

/**
 * Get the Claude CLI path.
 * Priority: ENV > Config File > localStorage > Default
 */
export async function getClaudeCliPathAsync(): Promise<ConfigValue<string>> {
    // 1. Check environment variable
    const envPath = await getEnvVar('OPSPILOT_CLAUDE_CLI_PATH');
    if (envPath) {
        return { value: envPath, source: 'env' };
    }

    // 2. Check config file
    const config = await loadConfigFile();
    if (config.claudeCliPath) {
        return { value: config.claudeCliPath, source: 'file' };
    }

    // 3. Check localStorage
    if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(STORAGE_KEYS.CLAUDE_CLI_PATH);
        if (stored) {
            return { value: stored, source: 'localStorage' };
        }
    }

    // 4. Default
    return { value: DEFAULTS.CLAUDE_CLI_PATH, source: 'default' };
}

/**
 * Get the embedding endpoint URL.
 * Priority: ENV > Config File > localStorage > Default
 */
export async function getEmbeddingEndpointAsync(): Promise<ConfigValue<string>> {
    // 1. Check environment variable
    const envEndpoint = await getEnvVar('OPSPILOT_EMBEDDING_ENDPOINT');
    if (envEndpoint) {
        return { value: envEndpoint.replace(/\/$/, ''), source: 'env' };
    }

    // 2. Check config file
    const config = await loadConfigFile();
    if (config.embeddingEndpoint) {
        return { value: config.embeddingEndpoint.replace(/\/$/, ''), source: 'file' };
    }

    // 3. Check localStorage
    if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(STORAGE_KEYS.EMBEDDING_ENDPOINT);
        if (stored) {
            return { value: stored.replace(/\/$/, ''), source: 'localStorage' };
        }
    }

    // 4. Default
    return { value: DEFAULTS.EMBEDDING_ENDPOINT, source: 'default' };
}

/**
 * Get project source mappings.
 * Priority: localStorage > Config File > Default ([])
 */
export async function getProjectMappings(): Promise<{ image_pattern: string; local_path: string; }[]> {
    // 1. Check localStorage (primary source for UI-configured mappings)
    if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(STORAGE_KEYS.PROJECT_MAPPINGS);
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                console.warn("Failed to parse project mappings from localStorage", e);
            }
        }
    }

    // 2. Check config file
    const config = await loadConfigFile();
    if (config.project_mappings) {
        return config.project_mappings;
    }

    // 3. Default
    return [];
}

/**
 * Get all configuration with sources (for settings UI display).
 */
export async function getAllConfigWithSources(): Promise<{
    agentUrl: ConfigValue<string>;
    claudeCliPath: ConfigValue<string>;
    embeddingEndpoint: ConfigValue<string>;
}> {
    const [agentUrl, claudeCliPath, embeddingEndpoint] = await Promise.all([
        getAgentServerUrlAsync(),
        getClaudeCliPathAsync(),
        getEmbeddingEndpointAsync(),
    ]);

    return { agentUrl, claudeCliPath, embeddingEndpoint };
}

/**
 * Initialize configuration on app startup.
 * Auto-detects and caches values for faster subsequent access.
 */
export async function initializeConfig(): Promise<void> {
    try {
        // Pre-load config file
        await loadConfigFile();

        // Auto-detect agent URL and cache it
        const agentConfig = await getAgentServerUrlAsync();
        if (agentConfig.source === 'auto-detected' || agentConfig.source === 'env' || agentConfig.source === 'file') {
            // Save to localStorage for faster access next time
            localStorage.setItem(STORAGE_KEYS.AGENT_URL, agentConfig.value);
            localStorage.setItem(STORAGE_KEYS.CONFIG_SOURCE, agentConfig.source);
        }

        console.log(`[OpsPilot Config] Agent URL: ${agentConfig.value} (source: ${agentConfig.source})`);
    } catch (e) {
        console.warn('[OpsPilot Config] Initialization failed, using defaults:', e);
    }
}

/**
 * Clear cached configuration (useful when settings change).
 */
export function clearConfigCache(): void {
    cachedConfig = null;
    configLoadPromise = null;
}

/**
 * Export config to a shareable format (for team sharing).
 */
export async function exportConfig(): Promise<string> {
    const config = await getAllConfigWithSources();
    const exportData: OpsPilotConfig = {
        agentServerUrl: config.agentUrl.value,
        claudeCliPath: config.claudeCliPath.value,
        embeddingEndpoint: config.embeddingEndpoint.value,
    };
    return JSON.stringify(exportData, null, 2);
}

/**
 * Import config from a JSON string.
 */
export function importConfig(jsonString: string): void {
    try {
        const config: OpsPilotConfig = JSON.parse(jsonString);
        if (config.agentServerUrl) {
            setAgentServerUrl(config.agentServerUrl);
        }
        if (config.claudeCliPath) {
            localStorage.setItem(STORAGE_KEYS.CLAUDE_CLI_PATH, config.claudeCliPath);
        }
        if (config.embeddingEndpoint) {
            localStorage.setItem(STORAGE_KEYS.EMBEDDING_ENDPOINT, config.embeddingEndpoint);
        }
        clearConfigCache();
    } catch (e) {
        throw new Error(`Invalid config JSON: ${e}`);
    }
}
