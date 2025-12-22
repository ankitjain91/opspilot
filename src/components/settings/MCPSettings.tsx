import { useState, useEffect } from 'react';
import { Plus, Trash2, Power, Terminal, AlertCircle, Loader2, Play, CheckCircle2, X, Box, Database, Pencil, FolderOpen, Key, Link, ShieldCheck, ShieldAlert, AlertTriangle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

interface McpServer {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    connected: boolean;
    error?: string;
    autoConnect?: boolean;
}

export function MCPSettings() {
    const [servers, setServers] = useState<McpServer[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [npxAvailable, setNpxAvailable] = useState<boolean | null>(null);
    const [globalInfoDismissed, setGlobalInfoDismissed] = useState(false);
    const [quickTestName, setQuickTestName] = useState<string | null>(null);
    const [quickTestMsg, setQuickTestMsg] = useState<string | null>(null);
    const [quickTestOk, setQuickTestOk] = useState<boolean | null>(null);
    const [formState, setFormState] = useState<Partial<McpServer>>({
        name: '',
        command: '',
        args: [],
        env: {}
    });

    const [isAdding, setIsAdding] = useState(false);
    const [connecting, setConnecting] = useState<string | null>(null);
    const [uvxAvailable, setUvxAvailable] = useState<boolean | null>(null);

    // Test Connection State
    const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [testMessage, setTestMessage] = useState<string | null>(null);

    const [showLogsFor, setShowLogsFor] = useState<string | null>(null);

    // --- Data Loading ---
    useEffect(() => {
        const loadServers = async () => {
            const saved = localStorage.getItem('opspilot-mcp-servers');
            if (saved) {
                try {
                    const parsed = JSON.parse(saved);
                    const safe = parsed.filter((s: McpServer) => {
                        const c = (s.command || '').toLowerCase();
                        const a = (s.args || []).join(' ').toLowerCase();
                        return !(c.includes('calc') || c === 'open');
                    });

                    // Sync connected state with backend
                    let connectedNames: string[] = [];
                    try {
                        connectedNames = await invoke<string[]>('list_connected_mcp_servers');
                    } catch (e) {
                        console.warn("Could not fetch connected MCP servers:", e);
                    }

                    setServers(safe.map((s: McpServer) => ({
                        ...s,
                        connected: connectedNames.includes(s.name),
                        error: connectedNames.includes(s.name) ? undefined : s.error
                    })));
                } catch (e) {
                    console.error("Failed to load MCP servers", e);
                }
            }
        };
        loadServers();
    }, []);

    // Preflight uvx
    useEffect(() => {
        invoke<boolean>('check_command_exists', { command: 'uvx' })
            .then(() => setUvxAvailable(true))
            .catch(() => setUvxAvailable(false));
        invoke<boolean>('check_command_exists', { command: 'npx' })
            .then(() => setNpxAvailable(true))
            .catch(() => setNpxAvailable(false));
    }, []);

    const saveServers = (updated: McpServer[]) => {
        setServers(updated);
        localStorage.setItem('opspilot-mcp-servers', JSON.stringify(updated));
    };

    // --- Actions ---

    const handleConnect = async (server: McpServer) => {
        setConnecting(server.name);
        try {
            await invoke('connect_mcp_server', {
                name: server.name,
                command: server.command,
                args: server.args,
                env: server.env
            });
            saveServers(servers.map(s => s.name === server.name ? { ...s, connected: true, error: undefined } : s));
        } catch (err) {
            saveServers(servers.map(s => s.name === server.name ? { ...s, connected: false, error: String(err) } : s));
        }
        setConnecting(null);
    };

    const handleDisconnect = async (server: McpServer) => {
        try {
            await invoke('disconnect_mcp_server', { name: server.name });
            saveServers(servers.map(s => s.name === server.name ? { ...s, connected: false } : s));
        } catch (err) {
            console.error(err);
        }
    };

    const handleSaveForm = () => {
        if (!formState.name || !formState.command) return;

        const newServer: McpServer = {
            name: formState.name,
            command: formState.command,
            args: formState.args || [],
            env: formState.env || {},
            connected: false,
            autoConnect: false
        };

        if (editingId) {
            const updated = servers.map(s => s.name === editingId ? { ...newServer, connected: s.connected } : s);
            saveServers(updated);
            if (servers.find(s => s.name === editingId)?.connected) {
                handleDisconnect(servers.find(s => s.name === editingId)!);
            }
        } else {
            saveServers([...servers, newServer]);
        }

        resetForm();
    };

    const handleTestConnection = async () => {
        if (!formState.name || !formState.command) {
            setTestStatus('error');
            setTestMessage('Name and Command are required.');
            return;
        }

        // Validation for placeholders
        if (formState.args?.some(a => a.includes('YOUR_ORG_NAME'))) {
            setTestStatus('error');
            setTestMessage('⚠️ Configuration Error:\n\nPlease replace "YOUR_ORG_NAME" in the Arguments field with your actual Azure DevOps organization name.');
            return;
        }

        setTestStatus('testing');
        setTestMessage(null);

        const existing = servers.find(s => s.name === formState.name);
        if (existing?.connected) {
            try { await invoke('disconnect_mcp_server', { name: formState.name }); } catch (e) { console.warn("Disconnect failed during test prep", e); }
        }

        try {
            await invoke('connect_mcp_server', {
                name: formState.name,
                command: formState.command,
                args: formState.args || [],
                env: formState.env || {}
            });
            setTestStatus('success');
            setTestMessage('Connection successful! Server is ready.');
        } catch (err: any) {
            setTestStatus('error');
            // Clean up common useless error prefixes
            const msg = String(err).replace('Error: ', '').replace('Command failed: ', '');
            setTestMessage(msg);
        }
    };

    const resetForm = () => {
        setEditingId(null);
        setIsAdding(false);
        setFormState({ name: '', command: '', args: [], env: {} });
        setTestStatus('idle');
        setTestMessage(null);
    };

    const startEditing = (server: McpServer) => {
        setEditingId(server.name);
        setFormState({ ...server });
        setIsAdding(false);
        setTestStatus('idle');
        setTestMessage(null);
    };

    const handleFilePick = async (key: string) => {
        try {
            const selected = await open({
                multiple: false,
                directory: key.toLowerCase().includes('dir'),
            });
            if (selected && typeof selected === 'string') {
                setFormState(prev => ({
                    ...prev,
                    env: { ...prev.env, [key]: selected }
                }));
            }
        } catch (e) {
            console.error("File picker failed", e);
        }
    };

    // --- Safety Checks ---
    const isOfficial = (command: string, args: string[]) => {
        const full = `${command} ${args.join(' ')}`.toLowerCase();
        // Official Microsoft / Model Context Protocol packages
        if (full.includes('@modelcontextprotocol') || full.includes('mcp-server-')) return true;
        // Official Azure DevOps package
        if (full.includes('@azure-devops/mcp')) return true;
        // Official Google
        if (full.includes('gcp-mcp-server')) return true;

        return false;
    };

    // --- Presets ---
    const PRESET_SERVERS: McpServer[] = [
        { name: 'kubernetes', command: 'uvx', args: ['mcp-server-kubernetes'], env: { KUBECONFIG: '~/.kube/config' }, connected: false, autoConnect: true },
        { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '' }, connected: false, autoConnect: false },
        { name: 'gitlab', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'], env: { GITLAB_TOKEN: '', GITLAB_API_URL: 'https://gitlab.com/api/v4' }, connected: false, autoConnect: false },
        // OFFICIAL Microsoft Azure DevOps Server
        { name: 'azure-devops', command: 'npx', args: ['-y', '@azure-devops/mcp', 'YOUR_ORG_NAME'], env: {}, connected: false, autoConnect: false },
        { name: 'slack', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '' }, connected: false, autoConnect: false },
        { name: 'gcp', command: 'uvx', args: ['gcp-mcp-server'], env: { GOOGLE_APPLICATION_CREDENTIALS: '' }, connected: false, autoConnect: false },
        { name: 'postgres', command: 'uvx', args: ['mcp-server-postgres', 'postgresql://user:pass@host:5432/db'], env: {}, connected: false, autoConnect: false },
        { name: 'sqlite', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', 'test.db'], env: {}, connected: false, autoConnect: true },
        { name: 'git', command: 'uvx', args: ['mcp-server-git'], env: {}, connected: false, autoConnect: true },
        { name: 'time', command: 'uvx', args: ['mcp-server-time'], env: {}, connected: false, autoConnect: true },
    ];

    // --- UI Helpers ---
    const [activeTab, setActiveTab] = useState<'connected' | 'explore'>('connected');

    const getServerIcon = (name: string) => {
        const n = name.toLowerCase();
        if (n.includes('github') || n.includes('git')) return <Box size={18} className="text-white" />;
        if (n.includes('azure')) return <Box size={18} className="text-blue-400" />;
        if (n.includes('kube')) return <Box size={18} className="text-blue-300" />;
        if (n.includes('gcp') || n.includes('google')) return <Box size={18} className="text-red-400" />;
        if (n.includes('postgres') || n.includes('sql')) return <Database size={18} className="text-blue-200" />;
        return <Terminal size={18} className="text-zinc-400" />;
    };

    // --- FORM COMPONENT ---
    const renderForm = () => (
        <div className="bg-gradient-to-br from-violet-900/10 to-indigo-900/10 border border-violet-500/20 rounded-xl p-4 space-y-4 animate-in fade-in slide-in-from-top-2">
            <h4 className="text-sm font-medium text-white flex items-center gap-2">
                <div className="p-1 rounded bg-violet-500/20"><Pencil size={14} className="text-violet-300" /></div>
                {editingId ? `Edit ${editingId}` : 'New Connection'}
            </h4>

            {!editingId && (
                <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                        <label className="text-[10px] text-zinc-400 uppercase tracking-wider font-semibold">Name</label>
                        <input type="text" placeholder="github" value={formState.name} onChange={e => setFormState({ ...formState, name: e.target.value })} className="w-full bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-violet-500/50 outline-none" />
                    </div>
                </div>
            )}

            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                    <label className="text-[10px] text-zinc-400 uppercase tracking-wider font-semibold">Command</label>
                    <input type="text" placeholder="uvx" value={formState.command} onChange={e => setFormState({ ...formState, command: e.target.value })} className="w-full bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-violet-500/50 outline-none font-mono" />
                </div>
                <div className="space-y-1">
                    <label className="text-[10px] text-zinc-400 uppercase tracking-wider font-semibold">Args</label>
                    <input type="text" placeholder="mcp-server-name" value={(formState.args || []).join(' ')} onChange={e => setFormState({ ...formState, args: e.target.value.split(' ') })} className="w-full bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-violet-500/50 outline-none font-mono" />
                </div>
            </div>

            <div className="space-y-2">
                <label className="text-[10px] text-zinc-400 uppercase tracking-wider font-semibold">Configuration (Environment)</label>
                <p className="text-[10px] text-zinc-500">
                    Secrets (token/key/password) are masked here and saved with your connection in app settings. They are not stored in the OS keychain.
                    For higher security, consider using system environment variables or files managed outside the app.
                </p>
                <div className="space-y-2 bg-black/40 rounded-lg p-2 border border-white/5 max-h-[200px] overflow-y-auto">
                    {Object.entries(formState.env || {}).map(([key, value]) => {
                        const isPath = /config|path|file|credential/i.test(key);
                        const isSecret = /token|secret|password|key/i.test(key);
                        return (
                            <div key={key} className="flex flex-col gap-1 pb-2 border-b border-white/5 last:border-0 last:pb-0">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded" title={key}>{key}</span>
                                    <button onClick={() => { const n = { ...formState.env }; delete n[key]; setFormState({ ...formState, env: n }); }} className="text-zinc-600 hover:text-red-400"><Trash2 size={12} /></button>
                                </div>
                                <div className="flex gap-2">
                                    <div className="relative flex-1">
                                        <div className="absolute left-2 top-1.5 text-zinc-600">
                                            {isSecret ? <Key size={12} /> : isPath ? <FolderOpen size={12} /> : <Terminal size={12} />}
                                        </div>
                                        <input
                                            type={isSecret ? "password" : "text"}
                                            value={value}
                                            onChange={e => { const n = { ...formState.env }; n[key] = e.target.value; setFormState({ ...formState, env: n }); }}
                                            className="w-full bg-transparent border border-white/10 rounded px-2 pl-7 py-1 text-xs text-white focus:border-violet-500/50 outline-none font-mono placeholder-zinc-700"
                                            placeholder="Value..."
                                        />
                                    </div>
                                    {isPath && (
                                        <button onClick={() => handleFilePick(key)} className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-[10px] text-zinc-300 font-medium whitespace-nowrap transition-colors">
                                            Browse...
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                    <div className="flex gap-2 pt-1 mt-1">
                        <input id="new-env-key" type="text" placeholder="NEW_VAR" className="flex-1 bg-transparent text-[10px] text-zinc-400 font-mono uppercase focus:text-white outline-none"
                            onKeyDown={(e) => { if (e.key === 'Enter') { const k = e.currentTarget.value.trim(); if (k) { setFormState({ ...formState, env: { ...formState.env, [k]: '' } }); e.currentTarget.value = ''; } } }}
                        />
                        <button onClick={() => { const el = document.getElementById('new-env-key') as HTMLInputElement; if (el.value) { setFormState({ ...formState, env: { ...formState.env, [el.value]: '' } }); el.value = ''; } }} className="text-[10px] text-violet-400 font-medium">+ Add</button>
                    </div>
                </div>
            </div>

            {/* Test Status Area */}
            {testStatus !== 'idle' && (
                <div className={`p-2.5 rounded-lg text-xs border ${testStatus === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-300'} animate-in fade-in slide-in-from-top-1`}>
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 font-medium">
                                {testStatus === 'testing' && <Loader2 size={12} className="animate-spin" />}
                                {testStatus === 'success' && <CheckCircle2 size={12} />}
                                {testStatus === 'error' && <AlertCircle size={12} />}
                                {testStatus === 'testing' ? 'Testing Connection...' : testStatus === 'success' ? 'Connection Successful' : 'Connection Failed'}
                            </div>
                            {testStatus === 'error' && testMessage && (
                                <button
                                    onClick={() => navigator.clipboard.writeText(testMessage)}
                                    className="p-1 hover:bg-black/20 rounded text-[10px] uppercase font-bold tracking-wider opacity-70 hover:opacity-100 transition-all"
                                    title="Copy error to clipboard"
                                >
                                    Copy Error
                                </button>
                            )}
                        </div>
                        {testMessage && (
                            <div className="ml-1 pl-2 border-l-2 border-current/20 max-h-[150px] overflow-y-auto custom-scrollbar">
                                <p className="font-mono text-[10px] break-all whitespace-pre-wrap opacity-90 leading-relaxed selection:bg-white/20">
                                    {testMessage}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-white/5">
                <button onClick={resetForm} className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-white/5">Cancel</button>
                <button
                    onClick={handleTestConnection}
                    disabled={testStatus === 'testing' || !formState.name}
                    className="px-3 py-1.5 rounded-lg bg-zinc-700/50 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-white/5 flex items-center gap-1.5"
                >
                    {testStatus === 'testing' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                    Test
                </button>
                <button onClick={handleSaveForm} className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium shadow-lg shadow-violet-900/20">
                    {editingId ? 'Save Changes' : 'Add Connection'}
                </button>
            </div>
        </div>
    );

    return (
        <div className="space-y-4 h-full flex flex-col">
            {!globalInfoDismissed && (
                <div className="p-3 bg-white/5 border border-white/10 rounded-xl">
                    <div className="flex items-start justify-between">
                        <div className="space-y-1">
                            <h4 className="text-sm font-semibold text-white">Quick Start</h4>
                            <ul className="text-[11px] text-zinc-400 list-disc ml-4 space-y-1">
                                <li>Ensure tooling: uvx {uvxAvailable ? <span className="text-emerald-400 font-medium">available</span> : <span className="text-red-400">missing</span>}, npx {npxAvailable ? <span className="text-emerald-400 font-medium">available</span> : <span className="text-red-400">missing</span>}</li>
                                <li>Add a server via Presets or Custom.</li>
                                <li>Fill required environment values (tokens, paths).</li>
                                <li>Use <span className="font-semibold">Test</span> to validate, then Connect.</li>
                                <li>Enable <span className="font-semibold">Auto-connect</span> to start with the app.</li>
                            </ul>
                        </div>
                        <button onClick={() => setGlobalInfoDismissed(true)} className="text-zinc-500 hover:text-white"><X size={16} /></button>
                    </div>
                </div>
            )}
            <div className="flex items-center gap-1 bg-black/20 p-1 rounded-xl border border-white/5 mx-1">
                <button onClick={() => setActiveTab('connected')} className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${activeTab === 'connected' ? 'bg-white/10 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}>My Connections ({servers.length})</button>
                <button onClick={() => setActiveTab('explore')} className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${activeTab === 'explore' ? 'bg-white/10 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}>Explore Presets</button>
            </div>

            <div className="flex-1 overflow-y-auto px-1 space-y-3">
                {activeTab === 'connected' && (
                    <div className="space-y-3">
                        {!isAdding && !editingId && (
                            <div className="flex justify-end px-1">
                                <button onClick={() => { setIsAdding(true); setFormState({ name: '', command: '', args: [], env: {} }); }} className="flex items-center gap-1.5 px-2 py-1 bg-violet-600/20 hover:bg-violet-600/30 text-violet-300 rounded-lg text-[10px] font-medium transition-colors border border-violet-500/20">
                                    <Plus size={12} /> Add Custom
                                </button>
                            </div>
                        )}

                        {isAdding && !editingId && renderForm()}

                        {servers.map(server => {
                            const official = isOfficial(server.command, server.args);
                            if (editingId === server.name) return <div key={server.name}>{renderForm()}</div>;
                            return (
                                <div key={server.name} className={`relative group border rounded-xl overflow-hidden transition-all duration-300 ${server.connected ? 'bg-gradient-to-br from-[#131b18] to-[#0f1512] border-emerald-500/30 shadow-lg shadow-emerald-900/10' : 'bg-[#16161a] border-white/5 hover:border-white/10'}`}>
                                    <div className="p-4 flex items-start justify-between">
                                        <div className="flex items-start gap-4 flex-1">
                                            <div className={`mt-1 p-2.5 rounded-xl border ${server.connected ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/5 border-white/5'}`}>
                                                {getServerIcon(server.name)}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <h4 className="text-sm font-semibold text-white">{server.name}</h4>
                                                    <div className={`w-1.5 h-1.5 rounded-full ${server.connected ? 'bg-emerald-500' : server.error ? 'bg-red-500' : 'bg-zinc-600'}`} />
                                                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full border flex items-center gap-0.5 ${official ? 'bg-blue-500/10 border-blue-500/20 text-blue-300' : 'bg-amber-500/10 border-amber-500/20 text-amber-300'}`}>
                                                        {official ? <ShieldCheck size={8} /> : <ShieldAlert size={8} />}
                                                        {official ? 'Official' : 'Community'}
                                                    </span>
                                                </div>
                                                <p className="text-[10px] text-zinc-500 font-mono mt-0.5 truncate w-full" title={`${server.command} ${server.args.join(' ')}`}>
                                                    {server.command} {server.args.join(' ')}
                                                </p>

                                                {!official && (
                                                    <div className="mt-2 flex items-start gap-1.5 p-1.5 rounded bg-amber-500/5 border border-amber-500/10">
                                                        <AlertTriangle size={10} className="text-amber-500 mt-0.5" />
                                                        <p className="text-[9px] text-amber-200/80 leading-tight">
                                                            Community package. Verify trust source.
                                                        </p>
                                                    </div>
                                                )}

                                                <div className="mt-3 flex items-center gap-3">
                                                    <span className={`text-[10px] font-medium ${server.connected ? 'text-emerald-400' : server.error ? 'text-red-400' : 'text-zinc-500'}`}>
                                                        {connecting === server.name ? 'Connecting...' : server.connected ? 'Active' : server.error ? 'Failed' : 'Ready'}
                                                    </span>
                                                    {server.error && (
                                                        <button onClick={() => setShowLogsFor(server.name)} className="text-[10px] text-red-400 underline hover:text-red-300 cursor-pointer flex items-center gap-0.5"><AlertCircle size={10} /> View Error</button>
                                                    )}
                                                    <div className="flex items-center gap-2">
                                                        <label className="flex items-center gap-1 text-[10px] text-zinc-400">
                                                            <input
                                                                type="checkbox"
                                                                checked={!!server.autoConnect}
                                                                onChange={(e) => {
                                                                    const updated = servers.map(s => s.name === server.name ? { ...s, autoConnect: e.target.checked } : s);
                                                                    saveServers(updated);
                                                                }}
                                                            />
                                                            Auto-connect
                                                        </label>
                                                        <button
                                                            onClick={async () => {
                                                                setQuickTestName(server.name);
                                                                setQuickTestMsg(null);
                                                                setQuickTestOk(null);
                                                                try {
                                                                    await invoke('connect_mcp_server', { name: server.name, command: server.command, args: server.args, env: server.env });
                                                                    // Disconnect if it was not previously connected
                                                                    if (!server.connected) {
                                                                        try { await invoke('disconnect_mcp_server', { name: server.name }); } catch {}
                                                                    }
                                                                    setQuickTestOk(true);
                                                                    setQuickTestMsg('Connection successful');
                                                                } catch (err: any) {
                                                                    setQuickTestOk(false);
                                                                    const msg = String(err).replace('Error: ', '').replace('Command failed: ', '');
                                                                    setQuickTestMsg(msg);
                                                                }
                                                            }}
                                                            className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[10px] text-zinc-300 border border-white/10"
                                                        >
                                                            Test
                                                        </button>
                                                    </div>
                                                    {quickTestName === server.name && quickTestMsg && (
                                                        <span className={`text-[10px] px-2 py-0.5 rounded ${quickTestOk ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{quickTestMsg}</span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <button onClick={() => startEditing(server)} disabled={server.connected} className="h-8 w-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors disabled:opacity-30" title={server.connected ? "Disconnect to edit" : "Configure"}>
                                                <Pencil size={14} />
                                            </button>
                                            <button onClick={() => server.connected ? handleDisconnect(server) : handleConnect(server)} disabled={connecting === server.name || editingId !== null} className={`h-8 w-8 flex items-center justify-center rounded-lg transition-all ${server.connected ? 'bg-emerald-500/10 text-emerald-400 hover:bg-red-500/20 hover:text-red-400' : 'bg-white/5 text-zinc-400 hover:bg-emerald-500/20 hover:text-emerald-300'}`}>
                                                {connecting === server.name ? <Loader2 size={16} className="animate-spin" /> : <Power size={16} />}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {activeTab === 'explore' && (
                    <div className="space-y-3 animate-in slide-in-from-right-2 duration-300">
                        <div className="grid grid-cols-1 gap-2">
                            {PRESET_SERVERS.map(preset => {
                                const isAdded = servers.some(s => s.name === preset.name);
                                const official = isOfficial(preset.command, preset.args);
                                return (
                                    <div key={preset.name} className="p-3 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl transition-all flex items-center justify-between group">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-lg bg-black/40 flex items-center justify-center border border-white/5 shadow-inner text-lg">
                                                {getServerIcon(preset.name)}
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <h4 className="text-sm font-medium text-white capitalize">{preset.name.replace('-', ' ')}</h4>
                                                    {official && <ShieldCheck size={12} className="text-blue-400" />}
                                                </div>
                                                <div className="flex items-center gap-2 mt-0.5">
                                                    <code className="text-[9px] px-1 py-0.5 bg-black/30 rounded text-zinc-400 font-mono">
                                                        {preset.name === 'kubernetes' ? 'mcp-server-kubernetes' : `npx ${preset.args[1] || ''}`}
                                                    </code>
                                                </div>
                                            </div>
                                        </div>
                                        <button
                                            disabled={isAdded}
                                            onClick={() => {
                                                setFormState({ ...preset, connected: false });
                                                setEditingId(null);
                                                setIsAdding(true);
                                                setActiveTab('connected');
                                            }}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${isAdded ? 'bg-transparent text-emerald-500 cursor-default' : 'bg-white/10 hover:bg-violet-600 hover:text-white text-zinc-300'}`}
                                        >
                                            {isAdded ? 'Installed' : 'Add'}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Logs Modal */}
            {showLogsFor && (
                <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-200">
                    <div className="w-full max-w-md bg-[#16161a] border border-white/10 rounded-2xl shadow-2xl flex flex-col max-h-[80%]">
                        <div className="p-4 border-b border-white/10 flex justify-between items-center">
                            <h3 className="text-sm font-semibold text-white">Diagnostic Logs: {showLogsFor}</h3>
                            <button onClick={() => setShowLogsFor(null)} className="text-zinc-500 hover:text-white"><X size={16} /></button>
                        </div>
                        <div className="p-4 overflow-y-auto font-mono text-xs text-zinc-300 space-y-2">
                            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-300 break-words">
                                {servers.find(s => s.name === showLogsFor)?.error || 'Unknown error occurred.'}
                            </div>
                            <div className="p-3 bg-black/40 rounded-lg text-zinc-400">
                                <p className="mb-1 text-zinc-500 uppercase text-[10px] tracking-wider font-semibold">Troubleshooting:</p>
                                <ul className="list-disc ml-4 space-y-1">
                                    <li>If authentication failed, check your tokens in the "Configure" menu.</li>
                                    <li>Use the "Browse" button to ensure file paths (like kubeconfig) are correct.</li>
                                    <li>For node servers, ensure <code>npm/npx</code> is in your PATH.</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
