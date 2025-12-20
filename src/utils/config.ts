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
 * Priority: ENV > Config File > localStorage > Auto-detect > Default
 */
export function getAgentServerUrl(): string {
    if (typeof window === 'undefined') return DEFAULTS.AGENT_URL;

    const stored = localStorage.getItem(STORAGE_KEYS.AGENT_URL);
    if (stored) return stored.replace(/\/$/, '');

    return DEFAULTS.AGENT_URL;
}

/**
 * Async version that checks all config sources.
 */
export async function getAgentServerUrlAsync(): Promise<ConfigValue<string>> {
    // 1. Check environment variable
    const envUrl = await getEnvVar('OPSPILOT_AGENT_URL');
    if (envUrl) {
        return { value: envUrl.replace(/\/$/, ''), source: 'env' };
    }

    // 2. Check config file
    const config = await loadConfigFile();
    if (config.agentServerUrl) {
        return { value: config.agentServerUrl.replace(/\/$/, ''), source: 'file' };
    }

    // 3. Check localStorage
    if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(STORAGE_KEYS.AGENT_URL);
        if (stored) {
            return { value: stored.replace(/\/$/, ''), source: 'localStorage' };
        }
    }

    // 4. Try auto-detection (check if agent is running)
    const autoDetected = await autoDetectAgentUrl();
    if (autoDetected) {
        return { value: autoDetected, source: 'auto-detected' };
    }

    // 5. Fall back to default
    return { value: DEFAULTS.AGENT_URL, source: 'default' };
}

/**
 * Try to auto-detect the agent server URL by checking common locations.
 */
async function autoDetectAgentUrl(): Promise<string | null> {
    const urlsToTry = [
        'http://127.0.0.1:8765',
        'http://localhost:8765',
    ];

    // 0. Try to read from server-info.json (most reliable)
    try {
        const { readTextFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
        const homeDir = await invoke<string>('get_home_dir'); // We need backend helper or just standard path
        // Tauri 2.0 fs plugin uses BaseDirectory enum or absolute paths if configured
        // We'll try to read from ~/.opspilot/server-info.json using absolute path

        // Since we don't have easy absolute path access in frontend without backend help,
        // let's try a backend invoke to get the content if possible, OR
        // use the network scan fallback which is robust.

        // Actually best way: invoke a command to read the info file
        const serverInfo = await invoke<{ port: number, pid: number }>('read_server_info_file');
        if (serverInfo && serverInfo.port) {
            console.log(`[Config] Found server info file: port ${serverInfo.port}`);
            urlsToTry.unshift(`http://127.0.0.1:${serverInfo.port}`);
        }
    } catch (e) {
        // Ignore file read errors (maybe file doesn't exist yet)
    }

    // Also try to get network URL from agent
    for (const url of urlsToTry) {
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
