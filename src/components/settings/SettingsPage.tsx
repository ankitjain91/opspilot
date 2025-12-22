import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { fetch } from '@tauri-apps/plugin-http';
import {
    Settings, Server, Link2, Download, FileText, AlertCircle, Check, Loader2,
    ChevronRight, ExternalLink, Terminal, Brain, Database, Puzzle,
    Bug, FolderOpen, Copy, RefreshCw, X, LogOut, Trash2, Sun, Moon, Monitor, Search, Info
} from 'lucide-react';
import { open as openExternal, Command } from '@tauri-apps/plugin-shell';
import { MCPSettings } from './MCPSettings';
import { getLogs, getLogStats, exportLogsAsText, clearLogs } from '../../utils/logger';
import { useTheme, Theme } from '../../contexts/ThemeContext';
import { getAgentServerStatus, restartServerComponent } from '../ai/agentOrchestrator';
import { getAgentServerUrl } from '../../utils/config';

interface OpsPilotConfig {
    agentServerUrl?: string;
    claudeCliPath?: string;
    embeddingEndpoint?: string;
    embeddingModel?: string;
    githubToken?: string;
    kubeconfig?: string;
    theme?: string;
}

interface JiraConfig {
    cloudId?: string;
    siteUrl?: string;
    email?: string;
    accessToken?: string;
    refreshToken?: string;
    defaultProjectKey?: string;
    connected: boolean;
}

interface JiraProject {
    key: string;
    name: string;
}

type SettingsSection = 'general' | 'agent' | 'integrations' | 'mcp' | 'diagnostics';

export function SettingsPage({ onClose }: { onClose: () => void }) {
    const [activeSection, setActiveSection] = useState<SettingsSection>('general');
    const [config, setConfig] = useState<OpsPilotConfig>({});
    const { theme, setTheme } = useTheme();
    const [jiraConfig, setJiraConfig] = useState<JiraConfig>({ connected: false });
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState<string | null>(null);
    const [agentTesting, setAgentTesting] = useState(false);
    const [agentTestMessage, setAgentTestMessage] = useState<string | null>(null);
    const [embeddingTesting, setEmbeddingTesting] = useState(false);
    const [embeddingTestMessage, setEmbeddingTestMessage] = useState<string | null>(null);

    // Diagnostics state
    const [exportingLogs, setExportingLogs] = useState(false);
    const [logExportMessage, setLogExportMessage] = useState<string | null>(null);
    const [appVersion, setAppVersion] = useState<string>('');
    const [systemInfo, setSystemInfo] = useState<any>(null);
    const [logStats, setLogStats] = useState<ReturnType<typeof getLogStats> | null>(null);

    // Agent Health state
    const [agentHealth, setAgentHealth] = useState<{
        available: boolean;
        status?: 'ok' | 'degraded';
        components?: Record<string, string>;
        error?: string;
    } | null>(null);
    const [agentHealthLoading, setAgentHealthLoading] = useState(false);
    const [restartingComponent, setRestartingComponent] = useState<string | null>(null);
    const [restartMessage, setRestartMessage] = useState<string | null>(null);

    // JIRA state
    const [jiraConnecting, setJiraConnecting] = useState(false);
    const [jiraProjects, setJiraProjects] = useState<JiraProject[]>([]);
    const [jiraProjectsLoading, setJiraProjectsLoading] = useState(false);
    const [jiraProjectSearch, setJiraProjectSearch] = useState('');
    const [jiraMessage, setJiraMessage] = useState<string | null>(null);
    const [githubTestMessage, setGithubTestMessage] = useState<string | null>(null);
    const [githubTesting, setGithubTesting] = useState(false);
    const [jiraTesting, setJiraTesting] = useState(false);

    // Load config on mount
    useEffect(() => {
        loadConfig();
        loadSystemInfo();
        loadJiraConfig();
    }, []);

    // Refresh log stats and agent health when viewing diagnostics
    useEffect(() => {
        if (activeSection === 'diagnostics') {
            setLogStats(getLogStats());
            checkAgentHealth();
        }
    }, [activeSection]);

    const checkAgentHealth = async () => {
        setAgentHealthLoading(true);
        try {
            const status = await getAgentServerStatus();
            setAgentHealth(status);
        } catch (e) {
            setAgentHealth({ available: false, error: String(e) });
        } finally {
            setAgentHealthLoading(false);
        }
    };

    const handleRestartComponent = async (component: 'sentinel') => {
        setRestartingComponent(component);
        setRestartMessage(null);
        try {
            const result = await restartServerComponent(component);
            if (result.success) {
                setRestartMessage(`${component} restarted successfully`);
                // Refresh health status
                await checkAgentHealth();
            } else {
                setRestartMessage(`Failed to restart ${component}: ${result.error || 'Unknown error'}`);
            }
        } catch (e) {
            setRestartMessage(`Error: ${e}`);
        } finally {
            setRestartingComponent(null);
            setTimeout(() => setRestartMessage(null), 5000);
        }
    };

    const loadConfig = async () => {
        try {
            const loaded = await invoke<OpsPilotConfig>('load_opspilot_config');
            setConfig(loaded || {});

            // Also load from localStorage for any client-side settings
            const localConfig = localStorage.getItem('opspilot-settings');
            if (localConfig) {
                const parsed = JSON.parse(localConfig);
                setConfig(prev => ({ ...prev, ...parsed }));
            }
        } catch (e) {
            console.error('Failed to load config:', e);
        }
    };

    const loadSystemInfo = async () => {
        try {
            const { getVersion } = await import('@tauri-apps/api/app');
            const version = await getVersion();
            setAppVersion(version);

            const specs = await invoke<any>('get_system_specs');
            setSystemInfo(specs);
        } catch (e) {
            console.error('Failed to load system info:', e);
        }
    };

    const loadJiraConfig = async () => {
        try {
            const stored = localStorage.getItem('opspilot-jira-config');
            let parsedInfo: JiraConfig = { connected: false };

            if (stored) {
                parsedInfo = JSON.parse(stored);
                // Migration: If token exists in LS, move to Keychain
                if (parsedInfo.accessToken) {
                    await invoke('store_secret', { key: 'jira_access_token', value: parsedInfo.accessToken });
                    console.log('Migrated Jira token to secure storage');
                    parsedInfo.accessToken = undefined;
                    localStorage.setItem('opspilot-jira-config', JSON.stringify(parsedInfo));
                }
            }

            // Always try to load token from Keychain
            try {
                const secret = await invoke<string | null>('retrieve_secret', { key: 'jira_access_token' });
                if (secret) {
                    parsedInfo.accessToken = secret;
                }
            } catch (e) {
                console.warn('Failed to retrieve Jira token:', e);
            }

            setJiraConfig(parsedInfo);
            if (parsedInfo.connected && parsedInfo.accessToken) {
                await loadJiraProjects(parsedInfo);
            }
        } catch (e) {
            console.error('Failed to load JIRA config:', e);
        }
    };

    const loadJiraProjects = async (config: JiraConfig) => {
        if (!config.siteUrl || !config.accessToken || !config.email) return;
        try {
            let allProjects: JiraProject[] = [];
            let startAt = 0;
            let isLast = false;

            while (!isLast) {
                const response = await fetch(`${config.siteUrl}/rest/api/3/project/search?startAt=${startAt}&maxResults=50`, {
                    headers: {
                        'Authorization': `Basic ${btoa(`${config.email}:${config.accessToken}`)}`,
                        'Accept': 'application/json'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const projects = data.values?.map((p: any) => ({ key: p.key, name: p.name })) || [];
                    allProjects = [...allProjects, ...projects];

                    if (data.isLast || !data.values || data.values.length === 0) {
                        isLast = true;
                    } else {
                        startAt += projects.length;
                    }
                } else {
                    console.error('Failed to fetch Jira projects:', await response.text());
                    isLast = true;
                }
            }

            setJiraProjects(allProjects.sort((a, b) => a.name.localeCompare(b.name)));
        } catch (e) {
            console.warn('Failed to load JIRA projects:', e);
        }
    };

    const handleJiraConnect = async () => {
        setJiraConnecting(true);
        setJiraMessage(null);
        try {
            // For JIRA Cloud with API tokens, we just need to validate the credentials
            const testConfig = { ...jiraConfig };
            if (!testConfig.siteUrl || !testConfig.email || !testConfig.accessToken) {
                setJiraMessage('Please fill in all JIRA fields');
                return;
            }

            // Test the connection
            const response = await fetch(`${testConfig.siteUrl}/rest/api/3/myself`, {
                headers: {
                    'Authorization': `Basic ${btoa(`${testConfig.email}:${testConfig.accessToken}`)}`,
                    'Accept': 'application/json'
                }
            });

            if (response.ok) {
                const user = await response.json();

                // Securely store token
                await invoke('store_secret', { key: 'jira_access_token', value: testConfig.accessToken });

                // Save config to LS without token
                const configToStore = { ...testConfig, connected: true, accessToken: undefined };
                localStorage.setItem('opspilot-jira-config', JSON.stringify(configToStore));

                // Update state with token (for current session)
                const updatedConfig = { ...testConfig, connected: true };
                setJiraConfig(updatedConfig);

                setJiraMessage(`Connected as ${user.displayName}`);
                await loadJiraProjects(updatedConfig);
            } else {
                const error = await response.text();
                setJiraMessage(`Connection failed: ${response.status} - ${error.substring(0, 100)}`);
            }
        } catch (e) {
            setJiraMessage(`Connection error: ${e}`);
        } finally {
            setJiraConnecting(false);
        }
    };

    const handleJiraDisconnect = async () => {
        setJiraConfig({ connected: false });
        setJiraProjects([]);
        localStorage.removeItem('opspilot-jira-config');
        await invoke('remove_secret', { key: 'jira_access_token' });
        setJiraMessage('Disconnected from JIRA');
    };

    const saveJiraConfig = () => {
        localStorage.setItem('opspilot-jira-config', JSON.stringify(jiraConfig));
        setJiraMessage('JIRA settings saved');
        setTimeout(() => setJiraMessage(null), 3000);
    };

    const testGitHubConnection = async () => {
        setGithubTesting(true);
        setGithubTestMessage(null);
        try {
            if (!config.githubToken) {
                setGithubTestMessage('Please enter a GitHub token first.');
                return;
            }
            const resp = await fetch('https://api.github.com/user', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${config.githubToken}`,
                    'Accept': 'application/vnd.github+json'
                }
            });
            if (resp.status === 401) {
                setGithubTestMessage('Unauthorized. Token invalid or missing scopes.');
            } else if (resp.ok) {
                const data = await resp.json();
                setGithubTestMessage(`Connected as ${data.login}`);
            } else {
                const text = await resp.text();
                setGithubTestMessage(`Failed: ${resp.status} ${text.substring(0, 120)}`);
            }
        } catch (e) {
            setGithubTestMessage(`Error: ${e}`);
        } finally {
            setGithubTesting(false);
        }
    };

    const testJiraConnection = async () => {
        setJiraTesting(true);
        try {
            const testConfig = { ...jiraConfig };
            // Load token from secure storage if not in state
            if (!testConfig.accessToken) {
                try {
                    const secret = await invoke<string | null>('retrieve_secret', { key: 'jira_access_token' });
                    if (secret) testConfig.accessToken = secret;
                } catch { }
            }
            if (!testConfig.siteUrl || !testConfig.email || !testConfig.accessToken) {
                setJiraMessage('Please ensure Site URL, Email, and Token are set.');
                return;
            }
            const response = await fetch(`${testConfig.siteUrl}/rest/api/3/myself`, {
                headers: {
                    'Authorization': `Basic ${btoa(`${testConfig.email}:${testConfig.accessToken}`)}`,
                    'Accept': 'application/json'
                }
            });
            if (response.ok) {
                const user = await response.json();
                setJiraMessage(`Connection OK: ${user.displayName}`);
            } else {
                const error = await response.text();
                setJiraMessage(`Test failed: ${response.status} - ${error.substring(0, 100)}`);
            }
        } catch (e) {
            setJiraMessage(`Test error: ${e}`);
        } finally {
            setJiraTesting(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setSaveMessage(null);
        try {
            await invoke('save_opspilot_config', { config });
            // Store a sanitized copy in localStorage (no tokens)
            const sanitized = { ...config, githubToken: undefined };
            localStorage.setItem('opspilot-settings', JSON.stringify(sanitized));
            setSaveMessage('Settings saved successfully');
            setTimeout(() => setSaveMessage(null), 3000);
        } catch (e) {
            setSaveMessage(`Failed to save: ${e}`);
        } finally {
            setSaving(false);
        }
    };

    const exportDiagnosticLogs = async () => {
        setExportingLogs(true);
        setLogExportMessage(null);

        try {
            // Collect diagnostic information
            const diagnostics: Record<string, any> = {
                timestamp: new Date().toISOString(),
                appVersion,
                systemInfo,
                config: { ...config, githubToken: config.githubToken ? '[REDACTED]' : undefined },
                localStorage: {},
                errors: [],
                logStats: getLogStats(),
                applicationLogs: getLogs()
            };

            // Collect relevant localStorage items
            const lsKeys = ['opspilot-settings', 'opspilot-llm-config', 'opspilot-mcp-servers'];
            for (const key of lsKeys) {
                const value = localStorage.getItem(key);
                if (value) {
                    try {
                        const parsed = JSON.parse(value);
                        // Redact sensitive fields
                        if (parsed.api_key) parsed.api_key = '[REDACTED]';
                        if (parsed.githubToken) parsed.githubToken = '[REDACTED]';
                        if (parsed.accessToken) parsed.accessToken = '[REDACTED]';
                        diagnostics.localStorage[key] = parsed;
                    } catch {
                        diagnostics.localStorage[key] = value;
                    }
                }
            }

            // Try to get agent status
            try {
                const agentStatus = await invoke('check_agent_status');
                diagnostics.agentStatus = agentStatus;
            } catch (e) {
                diagnostics.errors.push({ source: 'agent_status', error: String(e) });
            }

            // Try to get current context
            try {
                const context = await invoke('get_current_context_name');
                diagnostics.currentContext = context;
            } catch (e) {
                diagnostics.errors.push({ source: 'context', error: String(e) });
            }

            // Format as JSON
            const logContent = JSON.stringify(diagnostics, null, 2);

            // Ask user where to save
            const filePath = await save({
                defaultPath: `opspilot-diagnostics-${new Date().toISOString().split('T')[0]}.json`,
                filters: [{ name: 'JSON', extensions: ['json'] }]
            });

            if (filePath) {
                await writeTextFile(filePath, logContent);
                setLogExportMessage(`Diagnostics exported to ${filePath}`);
            }
        } catch (e) {
            setLogExportMessage(`Export failed: ${e}`);
        } finally {
            setExportingLogs(false);
        }
    };

    const testAgentServer = async () => {
        setAgentTesting(true);
        setAgentTestMessage(null);
        try {
            const url = (config.agentServerUrl || getAgentServerUrl()).replace(/\/$/, '');
            // Use LLM test endpoint to confirm reachability regardless of provider state
            const resp = await fetch(`${url}/llm/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: 'claude-code' })
            });
            if (resp.ok) {
                setAgentTestMessage('Agent reachable');
            } else {
                const text = await resp.text();
                setAgentTestMessage(`Unreachable or error: ${resp.status} ${text.substring(0, 100)}`);
            }
        } catch (e) {
            setAgentTestMessage(`Error: ${e}`);
        } finally {
            setAgentTesting(false);
        }
    };

    const testEmbeddingEndpoint = async () => {
        setEmbeddingTesting(true);
        setEmbeddingTestMessage(null);
        try {
            const agentUrl = (config.agentServerUrl || getAgentServerUrl()).replace(/\/$/, '');
            const endpointParam = config.embeddingEndpoint ? `&embedding_endpoint=${encodeURIComponent(config.embeddingEndpoint)}` : '';
            const modelParam = config.embeddingModel ? `&model_name=${encodeURIComponent(config.embeddingModel)}` : '';
            const resp = await fetch(`${agentUrl}/embedding-model/status?llm_endpoint=&${endpointParam}${modelParam}`);
            if (resp.ok) {
                const data = await resp.json();
                if (data?.available) {
                    setEmbeddingTestMessage('Embedding OK');
                } else {
                    const why = data?.error || 'Model/endpoint not available';
                    setEmbeddingTestMessage(`Embeddings unavailable: ${String(why).substring(0, 100)}`);
                }
            } else {
                const text = await resp.text();
                setEmbeddingTestMessage(`Failed: ${resp.status} ${text.substring(0, 100)}`);
            }
        } catch (e) {
            setEmbeddingTestMessage(`Error: ${e}`);
        } finally {
            setEmbeddingTesting(false);
        }
    };

    const copyDiagnosticsToClipboard = async () => {
        setExportingLogs(true);
        try {
            const diagnostics = {
                timestamp: new Date().toISOString(),
                appVersion,
                systemInfo,
                platform: navigator.platform,
                userAgent: navigator.userAgent
            };
            await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
            setLogExportMessage('System info copied to clipboard');
            setTimeout(() => setLogExportMessage(null), 3000);
        } catch (e) {
            setLogExportMessage(`Copy failed: ${e}`);
        } finally {
            setExportingLogs(false);
        }
    };

    const openLocalPath = async (path: string) => {
        try {
            // Use the system 'open' command on macOS to open files/folders
            const cmd = Command.create('open', [path]);
            await cmd.execute();
        } catch (e) {
            console.error('Failed to open path:', e);
            (window as any).showToast?.(`Unable to open: ${path}`, 'error');
        }
    };

    const sections: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
        { id: 'general', label: 'General', icon: <Settings size={18} /> },
        { id: 'agent', label: 'Agent & AI', icon: <Brain size={18} /> },
        { id: 'integrations', label: 'Integrations', icon: <Link2 size={18} /> },
        { id: 'mcp', label: 'MCP Servers', icon: <Puzzle size={18} /> },
        { id: 'diagnostics', label: 'Diagnostics', icon: <Bug size={18} /> },
    ];

    return (
        <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--bg-secondary)' }}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-gradient-to-br from-violet-500/20 to-purple-500/20 border border-violet-500/30">
                        <Settings className="w-5 h-5 text-violet-400" />
                    </div>
                    <div>
                        <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Settings</h1>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Configure OpsPilot preferences</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {saveMessage && (
                        <span className={`text-xs px-2 py-1 rounded ${saveMessage.includes('Failed') ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                            {saveMessage}
                        </span>
                    )}
                    <a
                        href="https://github.com/ankitjain91/opspilot/blob/main/docs/presentation-design.md"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-2 bg-white/10 hover:bg-white/20 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
                        title="View Design & Architecture on GitHub"
                    >
                        <ExternalLink size={14} />
                        Design & Architecture
                    </a>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Save Changes
                    </button>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-white transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
                {/* Sidebar Navigation */}
                <div className="w-56 p-4 space-y-1" style={{ borderRight: '1px solid var(--border-subtle)' }}>
                    {sections.map(section => (
                        <button
                            key={section.id}
                            onClick={() => setActiveSection(section.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${activeSection === section.id
                                ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                : ''
                                }`}
                            style={activeSection !== section.id ? { color: 'var(--text-secondary)' } : undefined}
                        >
                            <span className={activeSection === section.id ? 'text-violet-400' : ''} style={activeSection !== section.id ? { color: 'var(--text-muted)' } : undefined}>
                                {section.icon}
                            </span>
                            {section.label}
                        </button>
                    ))}
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-y-auto p-6">
                    {activeSection === 'general' && (
                        <div className="space-y-6 max-w-2xl">
                            <div>
                                <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>General Settings</h2>
                                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Basic application preferences</p>
                            </div>

                            {/* Theme - Hidden for now
                            <div className="space-y-3">
                                <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Theme</label>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setTheme('light')}
                                        className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border transition-all ${
                                            theme === 'light'
                                                ? 'bg-amber-500/20 border-amber-500/50 text-amber-500'
                                                : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]'
                                        }`}
                                        style={{
                                            backgroundColor: theme !== 'light' ? 'var(--bg-tertiary)' : undefined,
                                            color: theme !== 'light' ? 'var(--text-secondary)' : undefined
                                        }}
                                    >
                                        <Sun size={18} />
                                        <span className="text-sm font-medium">Light</span>
                                    </button>
                                    <button
                                        onClick={() => setTheme('dark')}
                                        className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border transition-all ${
                                            theme === 'dark'
                                                ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400'
                                                : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]'
                                        }`}
                                        style={{
                                            backgroundColor: theme !== 'dark' ? 'var(--bg-tertiary)' : undefined,
                                            color: theme !== 'dark' ? 'var(--text-secondary)' : undefined
                                        }}
                                    >
                                        <Moon size={18} />
                                        <span className="text-sm font-medium">Dark</span>
                                    </button>
                                </div>
                                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Choose your preferred color scheme</p>
                            </div>
                            */}

                            {/* Kubeconfig */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-zinc-300">Kubeconfig Path</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={config.kubeconfig || ''}
                                        onChange={(e) => setConfig({ ...config, kubeconfig: e.target.value })}
                                        placeholder="~/.kube/config (default)"
                                        className="flex-1 bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-violet-500/50 outline-none font-mono"
                                    />
                                    <button
                                        onClick={async () => {
                                            const { open } = await import('@tauri-apps/plugin-dialog');
                                            const selected = await open({ multiple: false });
                                            if (selected && typeof selected === 'string') {
                                                setConfig({ ...config, kubeconfig: selected });
                                            }
                                        }}
                                        className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm text-zinc-300 transition-colors"
                                    >
                                        <FolderOpen size={16} />
                                    </button>
                                </div>
                                <p className="text-xs text-zinc-500">Override the default kubeconfig location</p>
                            </div>

                            {/* App Info */}
                            <div className="mt-8 p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                                <h3 className="text-sm font-medium text-zinc-300 mb-3">About OpsPilot</h3>
                                <div className="space-y-2 text-xs">
                                    <div className="flex justify-between">
                                        <span className="text-zinc-500">Version</span>
                                        <span className="text-zinc-300 font-mono">{appVersion || 'Loading...'}</span>
                                    </div>
                                    {systemInfo && (
                                        <>
                                            <div className="flex justify-between">
                                                <span className="text-zinc-500">CPU</span>
                                                <span className="text-zinc-300">{systemInfo.cpu_brand}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-zinc-500">Memory</span>
                                                <span className="text-zinc-300">{(systemInfo.total_memory / (1024 * 1024 * 1024)).toFixed(1)} GB</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-zinc-500">Apple Silicon</span>
                                                <span className="text-zinc-300">{systemInfo.is_apple_silicon ? 'Yes' : 'No'}</span>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeSection === 'agent' && (
                        <div className="space-y-6 max-w-2xl">
                            <div>
                                <h2 className="text-lg font-semibold text-white mb-1">Agent & AI Settings</h2>
                                <p className="text-sm text-zinc-500">Configure AI assistant and agent server</p>
                            </div>

                            {/* Agent Server URL */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-zinc-300">Agent Server URL</label>
                                <input
                                    type="text"
                                    value={config.agentServerUrl || ''}
                                    onChange={(e) => setConfig({ ...config, agentServerUrl: e.target.value })}
                                    placeholder={`${getAgentServerUrl()} (detected)`}
                                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-violet-500/50 outline-none font-mono"
                                />
                                <div className="flex items-center gap-2 mt-1">
                                    <button
                                        onClick={testAgentServer}
                                        disabled={agentTesting}
                                        className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-zinc-300 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                                    >
                                        {agentTesting ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                                        Test Agent Server
                                    </button>
                                    {agentTestMessage && (
                                        <span className={`text-xs px-2 py-1 rounded ${agentTestMessage.startsWith('Agent reachable') ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-700 text-zinc-300'}`}>
                                            {agentTestMessage}
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-zinc-500">URL of the OpsPilot agent server. Testing confirms reachability without saving.</p>
                            </div>

                            {/* Claude CLI Path */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-zinc-300">Claude CLI Path</label>
                                <input
                                    type="text"
                                    value={config.claudeCliPath || ''}
                                    onChange={(e) => setConfig({ ...config, claudeCliPath: e.target.value })}
                                    placeholder="claude (uses PATH)"
                                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-violet-500/50 outline-none font-mono"
                                />
                                <p className="text-xs text-zinc-500">Path to the Claude CLI binary for terminal integration</p>
                            </div>

                            {/* Embedding Settings */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-zinc-300">Embedding Endpoint</label>
                                <input
                                    type="text"
                                    value={config.embeddingEndpoint || ''}
                                    onChange={(e) => setConfig({ ...config, embeddingEndpoint: e.target.value })}
                                    placeholder="Leave empty for local Ollama"
                                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-violet-500/50 outline-none font-mono"
                                />
                                <p className="text-xs text-zinc-500">Custom embedding API endpoint (OpenAI-compatible)</p>
                                <div className="flex items-center gap-2 mt-1">
                                    <button
                                        onClick={testEmbeddingEndpoint}
                                        disabled={embeddingTesting}
                                        className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-zinc-300 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                                    >
                                        {embeddingTesting ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                                        Test Embeddings
                                    </button>
                                    {embeddingTestMessage && (
                                        <span className={`text-xs px-2 py-1 rounded ${embeddingTestMessage.includes('OK') ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-700 text-zinc-300'}`}>
                                            {embeddingTestMessage}
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-zinc-300">Embedding Model</label>
                                <input
                                    type="text"
                                    value={config.embeddingModel || ''}
                                    onChange={(e) => setConfig({ ...config, embeddingModel: e.target.value })}
                                    placeholder="nomic-embed-text (default)"
                                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-violet-500/50 outline-none font-mono"
                                />
                                <p className="text-xs text-zinc-500">Model name for generating embeddings</p>
                            </div>
                        </div>
                    )}

                    {activeSection === 'integrations' && (
                        <div className="space-y-6 max-w-2xl">
                            <div>
                                <h2 className="text-lg font-semibold text-white mb-1">Integrations</h2>
                                <p className="text-sm text-zinc-500">Connect external services</p>
                            </div>

                            {/* GitHub */}
                            <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/10 space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-zinc-800">
                                            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                                            </svg>
                                        </div>
                                        <div>
                                            <h3 className="text-sm font-medium text-white">GitHub</h3>
                                            <p className="text-xs text-zinc-500">Search code across repositories</p>
                                        </div>
                                    </div>
                                    <span className={`text-xs px-2 py-1 rounded-full ${config.githubToken ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-700 text-zinc-400'}`}>
                                        {config.githubToken ? 'Connected' : 'Not configured'}
                                    </span>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs text-zinc-400">Personal Access Token</label>
                                    <input
                                        type="password"
                                        value={config.githubToken || ''}
                                        onChange={(e) => setConfig({ ...config, githubToken: e.target.value })}
                                        placeholder="ghp_xxxxxxxxxxxx"
                                        className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-violet-500/50 outline-none font-mono"
                                    />
                                    <p className="text-xs text-zinc-500">
                                        Create a token with <code className="bg-black/40 px-1 rounded">repo</code> scope at{' '}
                                        <a href="https://github.com/settings/tokens" target="_blank" rel="noopener" className="text-violet-400 hover:underline">
                                            github.com/settings/tokens
                                        </a>
                                    </p>
                                    <p className="text-[10px] text-zinc-500">
                                        Storage: Saved securely in your OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service). Not written to config files or logs.
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={testGitHubConnection}
                                            disabled={githubTesting}
                                            className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-zinc-300 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                                        >
                                            {githubTesting ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                                            Test Connection
                                        </button>
                                        {githubTestMessage && (
                                            <span className={`text-xs px-2 py-1 rounded ${githubTestMessage.startsWith('Connected') ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-700 text-zinc-300'}`}>
                                                {githubTestMessage}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* JIRA Cloud */}
                            <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/10 space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-blue-500/20">
                                            <svg className="w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.005 1.005 0 0 0 23.013 0z" />
                                            </svg>
                                        </div>
                                        <div>
                                            <h3 className="text-sm font-medium text-white">JIRA Cloud</h3>
                                            <p className="text-xs text-zinc-500">Create issues from alerts and investigations</p>
                                        </div>
                                    </div>
                                    <span className={`text-xs px-2 py-1 rounded-full ${jiraConfig.connected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-700 text-zinc-400'}`}>
                                        {jiraConfig.connected ? 'Connected' : 'Not configured'}
                                    </span>
                                </div>

                                {!jiraConfig.connected ? (
                                    <>
                                        {/* JIRA Setup Form */}
                                        <div className="space-y-3">
                                            <div className="space-y-2">
                                                <label className="text-xs text-zinc-400">JIRA Site URL</label>
                                                <input
                                                    type="text"
                                                    value={jiraConfig.siteUrl || ''}
                                                    onChange={(e) => setJiraConfig({ ...jiraConfig, siteUrl: e.target.value })}
                                                    placeholder="https://yourcompany.atlassian.net"
                                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500/50 outline-none font-mono"
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs text-zinc-400">Email Address</label>
                                                <input
                                                    type="email"
                                                    value={jiraConfig.email || ''}
                                                    onChange={(e) => setJiraConfig({ ...jiraConfig, email: e.target.value })}
                                                    placeholder="you@company.com"
                                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500/50 outline-none"
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs text-zinc-400">API Token</label>
                                                <input
                                                    type="password"
                                                    value={jiraConfig.accessToken || ''}
                                                    onChange={(e) => setJiraConfig({ ...jiraConfig, accessToken: e.target.value })}
                                                    placeholder="Your JIRA API token"
                                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500/50 outline-none font-mono"
                                                />
                                                <p className="text-xs text-zinc-500">
                                                    Create an API token at{' '}
                                                    <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener" className="text-blue-400 hover:underline">
                                                        Atlassian Account Settings
                                                    </a>
                                                </p>
                                                <p className="text-[10px] text-zinc-500">
                                                    Storage: Saved securely in your OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service). Not stored in localStorage.
                                                </p>
                                            </div>
                                        </div>

                                        <button
                                            onClick={handleJiraConnect}
                                            disabled={jiraConnecting}
                                            className="flex items-center gap-2 px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 text-sm font-medium rounded-lg transition-colors border border-blue-500/30 disabled:opacity-50"
                                        >
                                            {jiraConnecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                                            Connect to JIRA
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        {/* Connected state - show project selection */}
                                        <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                                            <div className="flex items-center gap-2 text-emerald-400 text-xs">
                                                <Check size={14} />
                                                <span>Connected to {jiraConfig.siteUrl}</span>
                                            </div>
                                        </div>

                                        <div className="space-y-3">
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <label className="text-xs text-zinc-400">Default Project</label>
                                                    <div className="relative">
                                                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                                                        <input
                                                            type="text"
                                                            placeholder="Search..."
                                                            value={jiraProjectSearch}
                                                            onChange={(e) => setJiraProjectSearch(e.target.value)}
                                                            className="bg-black/20 border border-white/10 rounded-lg px-3 py-1.5 pl-9 text-xs text-zinc-200 focus:border-blue-500/50 outline-none w-48 transition-all"
                                                            onClick={(e) => e.stopPropagation()}
                                                        />
                                                    </div>
                                                </div>
                                                <select
                                                    value={jiraConfig.defaultProjectKey || ''}
                                                    onChange={(e) => {
                                                        setJiraConfig({ ...jiraConfig, defaultProjectKey: e.target.value });
                                                    }}
                                                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500/50 outline-none cursor-pointer hover:border-white/20 transition-colors"
                                                >
                                                    <option value="">Select a project...</option>
                                                    {/* Show currently selected project even if not in list yet */}
                                                    {jiraConfig.defaultProjectKey && !jiraProjects.find(p => p.key === jiraConfig.defaultProjectKey) && (
                                                        <option value={jiraConfig.defaultProjectKey}>{jiraConfig.defaultProjectKey} (saved)</option>
                                                    )}
                                                    {jiraProjects
                                                        .filter(p =>
                                                            p.key.toLowerCase().includes(jiraProjectSearch.toLowerCase()) ||
                                                            p.name.toLowerCase().includes(jiraProjectSearch.toLowerCase())
                                                        )
                                                        .map(p => (
                                                            <option key={p.key} value={p.key}>{p.key} - {p.name}</option>
                                                        ))}
                                                </select>
                                                {jiraProjectSearch && jiraProjects.filter(p => p.key.toLowerCase().includes(jiraProjectSearch.toLowerCase()) || p.name.toLowerCase().includes(jiraProjectSearch.toLowerCase())).length === 0 && (
                                                    <p className="text-[10px] text-red-400/70 italic px-1">No projects match your search</p>
                                                )}
                                                <p className="text-xs text-zinc-500">
                                                    Issues will be created in this project by default
                                                </p>
                                            </div>
                                        </div>

                                        <div className="flex gap-2">
                                            <button
                                                onClick={saveJiraConfig}
                                                className="flex items-center gap-2 px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 text-sm font-medium rounded-lg transition-colors border border-blue-500/30"
                                            >
                                                <Check size={14} />
                                                Save Project
                                            </button>
                                            <button
                                                onClick={testJiraConnection}
                                                disabled={jiraTesting}
                                                className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-zinc-300 text-sm font-medium rounded-lg transition-colors border border-white/10 disabled:opacity-50"
                                            >
                                                {jiraTesting ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                                                Test Connection
                                            </button>
                                            <button
                                                onClick={handleJiraDisconnect}
                                                className="flex items-center gap-2 px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-300 text-sm font-medium rounded-lg transition-colors border border-red-500/30"
                                            >
                                                <LogOut size={14} />
                                                Disconnect
                                            </button>
                                        </div>
                                    </>
                                )}

                                {jiraMessage && (
                                    <div className={`p-2 rounded-lg text-xs ${jiraMessage.includes('failed') || jiraMessage.includes('error') ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                                        {jiraMessage}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeSection === 'mcp' && (
                        <div className="space-y-6">
                            <div>
                                <h2 className="text-lg font-semibold text-white mb-1">MCP Servers</h2>
                                <p className="text-sm text-zinc-500">Model Context Protocol server connections</p>
                            </div>
                            <MCPSettings />
                        </div>
                    )}

                    {activeSection === 'diagnostics' && (
                        <div className="space-y-6 max-w-2xl">
                            <div>
                                <h2 className="text-lg font-semibold text-white mb-1">Diagnostics</h2>
                                <p className="text-sm text-zinc-500">Export logs and system information for troubleshooting</p>
                            </div>

                            {/* Design & Architecture */}
                            <div className="p-4 bg-gradient-to-r from-violet-900/20 to-purple-900/20 rounded-xl border border-violet-500/20 space-y-3">
                                <div className="flex items-start gap-3">
                                    <div className="p-2 rounded-lg bg-violet-500/20">
                                        <Info className="w-5 h-5 text-violet-300" />
                                    </div>
                                    <div className="flex-1">
                                        <h3 className="text-sm font-medium text-violet-300">Design & Architecture</h3>
                                        <p className="text-xs text-zinc-400 mt-1">
                                            View the design document and architecture diagrams for a high-level overview of OpsPilot's system.
                                        </p>
                                        <div className="flex gap-2 mt-2">
                                            <a
                                                href="https://github.com/ankitjain91/opspilot/blob/main/docs/presentation-design.md"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-violet-300 text-xs font-medium rounded-lg transition-colors border border-violet-500/30"
                                            >
                                                <ExternalLink size={12} />
                                                Design Doc
                                            </a>
                                            <a
                                                href="https://github.com/ankitjain91/opspilot/tree/main/docs/diagrams"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-violet-300 text-xs font-medium rounded-lg transition-colors border border-violet-500/30"
                                            >
                                                <ExternalLink size={12} />
                                                Diagrams
                                            </a>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Agent Server Health */}
                            <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/10 space-y-4">
                                <div className="flex items-start gap-3">
                                    <div className={`p-2 rounded-lg ${agentHealth?.available ? (agentHealth.status === 'ok' ? 'bg-emerald-500/20' : 'bg-amber-500/20') : 'bg-red-500/20'}`}>
                                        <Server className={`w-5 h-5 ${agentHealth?.available ? (agentHealth.status === 'ok' ? 'text-emerald-400' : 'text-amber-400') : 'text-red-400'}`} />
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-sm font-medium text-white">Agent Server Health</h3>
                                            <button
                                                onClick={checkAgentHealth}
                                                disabled={agentHealthLoading}
                                                className="p-1.5 hover:bg-white/10 rounded text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                                                title="Refresh status"
                                            >
                                                <RefreshCw size={14} className={agentHealthLoading ? 'animate-spin' : ''} />
                                            </button>
                                        </div>
                                        <p className="text-xs text-zinc-500 mt-1">
                                            Monitor and manage the AI agent backend service
                                        </p>
                                    </div>
                                </div>

                                {/* Health Status */}
                                {agentHealth && (
                                    <div className="space-y-2">
                                        <div className="flex justify-between items-center p-2 bg-black/40 rounded text-xs">
                                            <span className="text-zinc-500">Status</span>
                                            <span className={`flex items-center gap-1.5 ${agentHealth.available ? (agentHealth.status === 'ok' ? 'text-emerald-400' : 'text-amber-400') : 'text-red-400'}`}>
                                                {agentHealth.available ? (
                                                    agentHealth.status === 'ok' ? (
                                                        <><Check size={12} /> Healthy</>
                                                    ) : (
                                                        <><AlertCircle size={12} /> Degraded</>
                                                    )
                                                ) : (
                                                    <><AlertCircle size={12} /> Unreachable</>
                                                )}
                                            </span>
                                        </div>

                                        {agentHealth.error && (
                                            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-300">
                                                {agentHealth.error}
                                            </div>
                                        )}

                                        {agentHealth.components && (
                                            <div className="space-y-1">
                                                <span className="text-xs text-zinc-500">Components</span>
                                                {Object.entries(agentHealth.components).map(([name, status]) => (
                                                    <div key={name} className="flex justify-between items-center p-2 bg-black/40 rounded text-xs">
                                                        <span className="text-zinc-400 capitalize">{name}</span>
                                                        <span className={status === 'ok' || status === 'running' ? 'text-emerald-400' : status === 'stopped' ? 'text-zinc-500' : 'text-amber-400'}>
                                                            {status}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Recovery Actions */}
                                <div className="pt-2 border-t border-white/5">
                                    <p className="text-xs text-zinc-500 mb-2">
                                        If you experience connection issues, try restarting the Sentinel monitoring component.
                                    </p>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => handleRestartComponent('sentinel')}
                                            disabled={restartingComponent === 'sentinel' || !agentHealth?.available}
                                            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 text-xs font-medium rounded-lg transition-colors border border-blue-500/30 disabled:opacity-50"
                                        >
                                            {restartingComponent === 'sentinel' ? (
                                                <Loader2 size={12} className="animate-spin" />
                                            ) : (
                                                <RefreshCw size={12} />
                                            )}
                                            Restart Sentinel
                                        </button>
                                        <button
                                            onClick={async () => {
                                                try {
                                                    await invoke('start_agent');
                                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                                    await checkAgentHealth();
                                                } catch (e) {
                                                    setRestartMessage(`Failed to start agent: ${e}`);
                                                }
                                            }}
                                            disabled={agentHealth?.available}
                                            className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 text-xs font-medium rounded-lg transition-colors border border-emerald-500/30 disabled:opacity-50"
                                        >
                                            <Terminal size={12} />
                                            Start Agent
                                        </button>
                                    </div>
                                    {restartMessage && (
                                        <div className={`mt-2 p-2 rounded-lg text-xs ${restartMessage.includes('Failed') || restartMessage.includes('Error') ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                                            {restartMessage}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Export Logs */}
                            <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/10 space-y-4">
                                <div className="flex items-start gap-3">
                                    <div className="p-2 rounded-lg bg-amber-500/20">
                                        <FileText className="w-5 h-5 text-amber-400" />
                                    </div>
                                    <div className="flex-1">
                                        <h3 className="text-sm font-medium text-white">Export Diagnostic Logs</h3>
                                        <p className="text-xs text-zinc-500 mt-1">
                                            Download a diagnostic report to share with the OpsPilot team when reporting issues.
                                            Sensitive data like API keys are automatically redacted.
                                        </p>
                                    </div>
                                </div>

                                <div className="flex gap-2">
                                    <button
                                        onClick={exportDiagnosticLogs}
                                        disabled={exportingLogs}
                                        className="flex items-center gap-2 px-4 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 text-sm font-medium rounded-lg transition-colors border border-amber-500/30 disabled:opacity-50"
                                    >
                                        {exportingLogs ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                                        Export to File
                                    </button>
                                    <button
                                        onClick={copyDiagnosticsToClipboard}
                                        disabled={exportingLogs}
                                        className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-zinc-300 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                                    >
                                        <Copy size={14} />
                                        Copy System Info
                                    </button>
                                </div>

                                {logExportMessage && (
                                    <div className={`p-2 rounded-lg text-xs ${logExportMessage.includes('failed') ? 'bg-red-500/20 text-red-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                                        {logExportMessage}
                                    </div>
                                )}
                            </div>

                            {/* Application Logs */}
                            <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/10 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-sm font-medium text-zinc-300">Application Logs</h3>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setLogStats(getLogStats())}
                                            className="p-1.5 hover:bg-white/10 rounded text-zinc-400 hover:text-white transition-colors"
                                            title="Refresh log stats"
                                        >
                                            <RefreshCw size={14} />
                                        </button>
                                        <button
                                            onClick={() => { clearLogs(); setLogStats(getLogStats()); }}
                                            className="p-1.5 hover:bg-white/10 rounded text-zinc-400 hover:text-red-400 transition-colors"
                                            title="Clear logs"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                                {logStats && (
                                    <div className="space-y-2 text-xs font-mono">
                                        <div className="flex justify-between p-2 bg-black/40 rounded">
                                            <span className="text-zinc-500">Total Entries</span>
                                            <span className="text-zinc-300">{logStats.total}</span>
                                        </div>
                                        <div className="flex justify-between p-2 bg-black/40 rounded">
                                            <span className="text-zinc-500">By Level</span>
                                            <span className="flex gap-2">
                                                <span className="text-zinc-500">{logStats.levels.debug} debug</span>
                                                <span className="text-blue-400">{logStats.levels.info} info</span>
                                                <span className="text-amber-400">{logStats.levels.warn} warn</span>
                                                <span className="text-red-400">{logStats.levels.error} error</span>
                                            </span>
                                        </div>
                                        {logStats.oldestEntry && (
                                            <div className="flex justify-between p-2 bg-black/40 rounded">
                                                <span className="text-zinc-500">Time Range</span>
                                                <span className="text-zinc-300">
                                                    {new Date(logStats.oldestEntry).toLocaleTimeString()} - {new Date(logStats.newestEntry!).toLocaleTimeString()}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}
                                <p className="text-xs text-zinc-600">
                                    Logs are included in the diagnostic export. Use "Export to File" above to save them.
                                </p>
                            </div>

                            {/* System Info */}
                            <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/10 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-sm font-medium text-zinc-300">System Information</h3>
                                    <button
                                        onClick={loadSystemInfo}
                                        className="p-1.5 hover:bg-white/10 rounded text-zinc-400 hover:text-white transition-colors"
                                    >
                                        <RefreshCw size={14} />
                                    </button>
                                </div>
                                <div className="space-y-2 text-xs font-mono">
                                    <div className="flex justify-between p-2 bg-black/40 rounded">
                                        <span className="text-zinc-500">App Version</span>
                                        <span className="text-zinc-300">{appVersion || '-'}</span>
                                    </div>
                                    {systemInfo && (
                                        <>
                                            <div className="flex justify-between p-2 bg-black/40 rounded">
                                                <span className="text-zinc-500">CPU</span>
                                                <span className="text-zinc-300">{systemInfo.cpu_brand}</span>
                                            </div>
                                            <div className="flex justify-between p-2 bg-black/40 rounded">
                                                <span className="text-zinc-500">Memory</span>
                                                <span className="text-zinc-300">{(systemInfo.total_memory / (1024 * 1024 * 1024)).toFixed(1)} GB</span>
                                            </div>
                                            <div className="flex justify-between p-2 bg-black/40 rounded">
                                                <span className="text-zinc-500">Platform</span>
                                                <span className="text-zinc-300">{systemInfo.is_apple_silicon ? 'Apple Silicon' : 'x86_64'}</span>
                                            </div>
                                        </>
                                    )}
                                    <div className="flex justify-between p-2 bg-black/40 rounded">
                                        <span className="text-zinc-500">User Agent</span>
                                        <span className="text-zinc-300 truncate max-w-[300px]" title={navigator.userAgent}>
                                            {navigator.userAgent.split(' ').slice(-2).join(' ')}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* Report Issue */}
                            <div className="p-4 bg-gradient-to-r from-violet-900/20 to-purple-900/20 rounded-xl border border-violet-500/20 space-y-3">
                                <h3 className="text-sm font-medium text-violet-300">Report an Issue</h3>
                                <p className="text-xs text-zinc-400">
                                    Found a bug or have a feature request? Open an issue on GitHub and attach your diagnostic logs.
                                </p>
                                <a
                                    href="https://github.com/anthropics/claude-code/issues"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 text-sm font-medium rounded-lg transition-colors border border-violet-500/30"
                                >
                                    <ExternalLink size={14} />
                                    Open GitHub Issues
                                </a>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
