

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Send, Sparkles, X, Minimize2, Maximize2, Minus, Settings, ChevronDown, AlertCircle, StopCircle, RefreshCw, Terminal, CheckCircle2, XCircle, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import { ToolMessage } from './chat/ToolMessage';
import { ThinkingMessage } from './chat/ThinkingMessage';
import { InvestigationTimeline } from './chat/InvestigationTimeline';
import remarkGfm from 'remark-gfm';
import { LLMConfig, LLMStatus, ClusterHealthSummary } from '../../types/ai';
import { fixMarkdownHeaders } from '../../utils/markdown';
import { loadLLMConfig } from './utils';
import { LLMSettingsPanel } from './LLMSettingsPanel';
import { OllamaSetupInstructions } from './OllamaSetupInstructions';
import {
    executeTool, VALID_TOOLS, registerMcpTools, isValidTool, listRegisteredMcpTools
} from './tools';
import {
    ToolOutcome, PlanStep, InvestigationPlan,
    ResourceDiscoveryCache, DEFAULT_ITERATION_CONFIG, isEmptyResult, compressToolHistorySemantic
} from './types';
import {
    extractCommandsFromResponse,
    extractSuggestions,
    extractLearningMetadata,
    recordInvestigationForLearning,
} from './agentUtils';

import { runAgentLoop, AgentStep, LLMOptions } from './agentOrchestrator';
import { PlanProgressUI } from './PlanProgressUI';
import { formatFailingPods } from './kubernetesFormatter';

const KNOWN_MCP_SERVERS = [
    { name: 'azure-devops', command: 'npx', args: ['-y', '@azure-devops/mcp', 'YOUR_ORG_NAME'], env: {}, connected: false, autoConnect: false },
    { name: 'kubernetes', command: 'uvx', args: ['mcp-server-kubernetes'], env: { KUBECONFIG: '~/.kube/config' }, autoConnect: false },
    { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '...' }, autoConnect: false },
    { name: 'gitlab', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'], env: { GITLAB_TOKEN: '...', GITLAB_API_URL: 'https://gitlab.com/api/v4' }, autoConnect: false },
    { name: 'git', command: 'uvx', args: ['mcp-server-git'], env: {}, autoConnect: true },
    { name: 'slack', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '...' }, autoConnect: false },
    { name: 'gcp', command: 'uvx', args: ['gcp-mcp-server'], env: { GOOGLE_APPLICATION_CREDENTIALS: '~/.config/gcloud/application_default_credentials.json' }, autoConnect: false },
    { name: 'postgres', command: 'uvx', args: ['mcp-server-postgres', 'postgresql://user:pass@host:5432/db'], env: {}, autoConnect: false },
    { name: 'sqlite', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', 'test.db'], env: {}, autoConnect: false },
    { name: 'time', command: 'uvx', args: ['mcp-server-time'], env: {}, autoConnect: true },
    // Shell MCP server for bash/shell command execution - secure with directory restrictions
    { name: 'shell', command: 'uvx', args: ['mcp-shell-server'], env: {}, autoConnect: false },
];

// ... (imports/interfaces unchanged)

// ... (inside component) ...


// Claude Code stream event type
interface ClaudeCodeStreamEvent {
    stream_id: string;
    event_type: 'start' | 'chunk' | 'done' | 'error' | 'progress';
    content: string;
}

// Helper to group messages into interactions
function groupMessages(history: any[]) {
    const groups: any[] = [];
    let currentGroup: any = null;

    history.forEach((msg) => {
        if (msg.role === 'user') {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = { type: 'interaction', user: msg, steps: [], answer: null };
        } else if (msg.role === 'tool' || (msg.role === 'assistant' && (msg.isActivity || msg.content?.includes('🧠 Thinking') || msg.content?.includes('🧠 Supervisor') || msg.content?.includes('🔄 Investigating') || msg.content?.includes('Continuing investigation')))) {
            if (currentGroup) {
                currentGroup.steps.push(msg);
            } else {
                if (groups.length === 0 || groups[groups.length - 1].type !== 'system_steps') {
                    groups.push({ type: 'system_steps', steps: [msg] });
                } else {
                    groups[groups.length - 1].steps.push(msg);
                }
            }
        } else if (msg.role === 'assistant') {
            if (currentGroup && !currentGroup.answer) {
                currentGroup.answer = msg;
            } else {
                groups.push({ type: 'raw', msg });
            }
        } else {
            groups.push({ type: 'raw', msg });
        }
    });

    if (currentGroup) groups.push(currentGroup);
    return groups;
}

// Cluster-wide AI Chat Panel component - Global floating chat
export function ClusterChatPanel({
    onClose,
    isMinimized,
    onToggleMinimize,
    currentContext,
    embedded = false,
    resourceContext
}: {
    onClose?: () => void,
    isMinimized?: boolean,
    onToggleMinimize?: () => void,
    currentContext?: string,
    embedded?: boolean,
    resourceContext?: { kind: string; name: string; namespace: string }
}) {
    const messagesContainerRef = useRef<HTMLDivElement>(null);

    // Unique storage key for resource-specific chats
    const storageKey = resourceContext
        ? `ops - pilot - chat - ${resourceContext.namespace} -${resourceContext.kind} -${resourceContext.name} `
        : 'ops-pilot-chat-history';

    const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant' | 'tool' | 'claude-code', content: string, toolName?: string, command?: string, isActivity?: boolean, isStreaming?: boolean }>>(() => {
        try {
            const saved = localStorage.getItem(storageKey);
            if (!saved) return [];
            const parsed = JSON.parse(saved);
            // Sanitize history: ensure no message is stuck in 'streaming' state on reload
            return parsed.map((msg: any) => ({ ...msg, isStreaming: false }));
        } catch (e) {
            console.warn('Failed to load chat history:', e);
            return [];
        }
    });
    const [userInput, setUserInput] = useState("");

    // Group messages for better UI presentation (timeline)
    const groupedHistory = useMemo(() => groupMessages(chatHistory), [chatHistory]);

    const [llmLoading, setLlmLoading] = useState(false);
    const [currentActivity, setCurrentActivity] = useState("Analyzing cluster data...");
    const [isExpanded, setIsExpanded] = useState(false);
    const [llmConfig, setLlmConfig] = useState<LLMConfig>(loadLLMConfig);
    const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null);
    const [checkingLLM, setCheckingLLM] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [suggestedActions, setSuggestedActions] = useState<string[]>([]);
    const chatEndRef = useRef<HTMLDivElement>(null);

    // Claude Code streaming state
    const [streamingContent, setStreamingContent] = useState<string>("");
    const [isStreaming, setIsStreaming] = useState(false);
    const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
    const streamUnlistenRef = useRef<UnlistenFn | null>(null);

    // Embedding model status (for knowledge base)
    const [embeddingStatus, setEmbeddingStatus] = useState<'loading' | 'ready' | 'error' | null>(null);
    const [embeddingMessage, setEmbeddingMessage] = useState<string>('');

    // Cancel/abort controller for long-running requests
    const abortControllerRef = useRef<AbortController | null>(null);
    const [isCancelling, setIsCancelling] = useState(false);

    // Investigation chain-of-thought state (visible to user)
    const [investigationProgress, setInvestigationProgress] = useState<{
        iteration: number;
        maxIterations: number;
        phase: string;
        confidence: { level: string; score: number };
        hypotheses: Array<{ id: string; description: string; status: string }>;
        toolsExecuted: number;
        usefulEvidence: number;
    } | null>(null);

    // Welcome joke fetched from LLM
    const [welcomeJoke, setWelcomeJoke] = useState<string | null>(null);
    const [loadingWelcomeJoke, setLoadingWelcomeJoke] = useState(false);

    // Hardware Specs
    const [systemSpecs, setSystemSpecs] = useState<{ cpu_brand: string; total_memory: number; is_apple_silicon: boolean; } | null>(null);

    // Model Download Progress State
    const [downloadProgress, setDownloadProgress] = useState<{ status: string; percent?: number; completed?: number; total?: number } | null>(null);
    const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);

    // Plan execution state (ReAct pattern)
    const [currentPlan, setCurrentPlan] = useState<any[] | null>(null);
    const [planTotalSteps, setPlanTotalSteps] = useState<number>(0);

    // New enriched investigation signals from backend
    const [phaseTimeline, setPhaseTimeline] = useState<Array<{ name: string; timestamp?: string }>>([]);
    const [rankedHypotheses, setRankedHypotheses] = useState<Array<{ title: string; confidence?: number }>>([]);
    const [approvalContext, setApprovalContext] = useState<{ command?: string; reason?: string; risk?: string; impact?: string } | null>(null);
    const [coverageGaps, setCoverageGaps] = useState<Array<string>>([]);
    const [agentHints, setAgentHints] = useState<Array<string>>([]);
    const [goalVerification, setGoalVerification] = useState<{ met: boolean; reason: string } | null>(null);
    const [extendedMode, setExtendedMode] = useState<{ preferred_checks?: string[]; prefer_mcp_tools?: boolean } | null>(null);

    // Check LLM status and fetch MCP tools on mount
    useEffect(() => {
        checkLLMStatus();
        fetchMcpTools();
    }, [llmConfig]); // eslint-disable-line react-hooks/exhaustive-deps

    // Initialize embedding model and listen for status events
    useEffect(() => {
        let unlistenFn: UnlistenFn | null = null;

        const setupEmbeddingListener = async () => {
            // Listen for embedding model status events
            unlistenFn = await listen<{ status: string; message: string }>('embedding-model-status', (event) => {
                const { status, message } = event.payload;
                setEmbeddingStatus(status as 'loading' | 'ready' | 'error');
                setEmbeddingMessage(message);
            });

            // Trigger model initialization (downloads ~25MB on first use)
            setEmbeddingStatus('loading');
            setEmbeddingMessage('Loading knowledge base...');
            try {
                await invoke('init_embedding_model');
                // If no event was fired, mark as ready
                setEmbeddingStatus('ready');
                setEmbeddingMessage('Knowledge base ready');
            } catch (err) {
                console.warn('Embedding model init failed:', err);
                setEmbeddingStatus('error');
                setEmbeddingMessage(`Knowledge base unavailable: ${err} `);
            }
        };

        setupEmbeddingListener();

        return () => {
            if (unlistenFn) unlistenFn();
        };
    }, []);

    // Check LLM status and fetch MCP tools on mount
    useEffect(() => {
        checkLLMStatus();
        fetchMcpTools();

        // Get hardware specs to recommend model
        invoke<{ cpu_brand: string; total_memory: number; is_apple_silicon: boolean; }>("get_system_specs")
            .then(specs => {
                setSystemSpecs(specs);
                console.log("[System] Hardware detected:", specs);
            })
            .catch(err => console.warn("[System] Failed to get specs:", err));
    }, [llmConfig]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-fetch MCP tools when settings panel is closed (user might have added servers)
    useEffect(() => {
        if (!showSettings) {
            fetchMcpTools();
        }
    }, [showSettings]);

    // Function to fetch a welcome dad joke from the LLM
    const fetchNewWelcomeJoke = useCallback(async () => {
        if (loadingWelcomeJoke) return;
        setLoadingWelcomeJoke(true);
        try {
            const response = await invoke<string>('llm_chat', {
                messages: [{
                    role: 'user',
                    content: 'Generate ONE short, funny dad joke about Kubernetes, containers, DevOps, or programming. Just the joke itself, no introduction or explanation. Keep it under 100 characters. Include one relevant emoji. Be creative and different each time!'
                }],
                config: llmConfig,
                systemPrompt: 'You are a witty DevOps engineer who loves dad jokes. Respond with ONLY the joke, nothing else. Never repeat the same joke twice.',
                maxTokens: 100
            });
            setWelcomeJoke(response.trim());
        } catch (err) {
            console.warn('Failed to fetch welcome joke:', err);
            // Fallback to a static joke
            const fallbacks = [
                "Why do Kubernetes pods make terrible comedians? Their jokes keep crashing! 🎤",
                "Why do programmers prefer dark mode? Because light attracts bugs! 🐛",
                "What's a pod's favorite dance? The crash loop shuffle! 💃",
                "Why did the container go to therapy? It had too many issues with its parent image! 🐳",
                "What do you call a Kubernetes cluster with trust issues? A secret manager! 🤫",
            ];
            setWelcomeJoke(fallbacks[Math.floor(Math.random() * fallbacks.length)]);
        }
        setLoadingWelcomeJoke(false);
    }, [llmConfig, loadingWelcomeJoke]);

    // Auto-scroll to bottom when chat updates
    const scrollToBottom = () => {
        if (messagesContainerRef.current) {
            const { scrollHeight, clientHeight } = messagesContainerRef.current;
            messagesContainerRef.current.scrollTo({
                top: scrollHeight - clientHeight,
                behavior: 'smooth'
            });
        }
    };

    useEffect(() => {
        scrollToBottom();
    }, [chatHistory, currentActivity, investigationProgress, llmLoading, streamingContent, embeddingMessage]);

    // Persist chat history
    useEffect(() => {
        try {
            // Compress highly redundant history before saving if needed, but for now just save
            // Limit to last 50 messages to avoid quota limits
            const historyToSave = chatHistory.slice(-50);
            localStorage.setItem(storageKey, JSON.stringify(historyToSave));
        } catch (e) {
            console.warn('Failed to save chat history:', e);
        }
    }, [chatHistory, storageKey]);

    // Fetch welcome joke when LLM becomes connected
    useEffect(() => {
        if (llmStatus?.connected && !welcomeJoke && !loadingWelcomeJoke && chatHistory.length === 0) {
            fetchNewWelcomeJoke();
        }
    }, [llmStatus?.connected, welcomeJoke, loadingWelcomeJoke, chatHistory.length, fetchNewWelcomeJoke]);

    // Auto-add well-known MCP servers (Azure, Azure DevOps, Kubernetes, GCP, GitHub) and connect if available
    useEffect(() => {
        const saved = localStorage.getItem('opspilot-mcp-servers');
        let servers: any[] = [];
        try {
            servers = saved ? JSON.parse(saved) : [];
        } catch (err) {
            console.warn("Failed to parse saved MCP servers", err);
        }

        // Merge with defaults, preferring saved config but REPAIRING broken package names
        const merged = KNOWN_MCP_SERVERS.map(known => {
            const saved = servers.find((s: any) => s.name === known.name);
            if (saved) {
                // STRICT SAFETY: Force disable auto-connect for interactive/cloud services
                // This ensures they never auto-start without explicit user action, regardless of past config
                const isInteractive = ['github', 'gitlab', 'azure-devops', 'slack', 'gcp', 'postgres'].includes(known.name);
                const safeAutoConnect = isInteractive ? false : (saved.autoConnect !== undefined ? saved.autoConnect : known.autoConnect);

                let updated = { ...saved, autoConnect: safeAutoConnect };

                // AUTO-REPAIR: Fix broken package names or commands

                // Fix: Auto-migrate Node.js based servers to use 'npx'
                if (['github', 'slack', 'gitlab'].includes(known.name) && saved.command === 'uvx') {
                    console.log(`[MCP] Migrating ${known.name} to npx packaged version`);
                    updated = { ...updated, command: known.command, args: known.args };
                }

                // Fix: Migrate legacy Azure DevOps to official Microsoft package
                if (updated.name === 'azure-devops' && (updated.args.join(' ').includes('ryancardin') || updated.command === 'uvx')) {
                    console.log(`[MCP] Migrating Azure DevOps to official Microsoft package`);
                    // We attempt to preserve the org if it was in the env, otherwise default
                    const oldOrg = updated.env?.AZURE_DEVOPS_ORG || '';
                    const orgName = oldOrg.split('/').pop() || 'YOUR_ORG_NAME'; // rough heuristic extracting 'yourorg' from url
                    updated = { ...updated, command: 'npx', args: ['-y', '@azure-devops/mcp', orgName], env: {} }; // Clear env as it's interactive auth or different
                }

                // Fix: Legacy GCP package name
                if (updated.args && updated.args[0] === 'mcp-server-gcp') {
                    updated = { ...updated, args: ['gcp-mcp-server', ...updated.args.slice(1)] };
                }

                // Fix: Ensure SQLite has correct args if missing
                if (updated.name === 'sqlite' && (!updated.args || !updated.args.includes('--db-path'))) {
                    updated = { ...updated, args: known.args };
                }

                return updated;
            }
            return known;
        }).concat(servers.filter((s: any) => !KNOWN_MCP_SERVERS.find(k => k.name === s.name)));

        // Filter out completely invalid/non-existent packages that might have been added
        const cleaned = merged.filter((s: any) => {
            // Purge known broken/legacy implementations that cause startup crashes
            if (['redis', 'mysql', 'snowflake', 'aws', 'azure'].includes(s.name)) {
                console.warn(`[MCP] Removing legacy / broken server config: ${s.name} `);
                return false;
            }
            // Ensure 'azure-devops' is the correct one
            if (s.name === 'azure-devops' && s.args && s.args[0] === 'mcp-server-azure-devops') return false;

            return true;
        });

        const preflightAndConnect = async () => {
            // Check for uvx (always valid for python servers)
            try {
                await invoke('check_command_exists', { command: 'uvx' });
            } catch (err) {
                console.warn('[MCP] uvx not available.', err);
            }
            // Check for npx (for Node servers like github)
            try {
                await invoke('check_command_exists', { command: 'npx' });
            } catch (err) {
                console.warn('[MCP] npx not available.', err);
            }

            // Save the repaired config back to storage if we changed anything effectively
            if (JSON.stringify(cleaned) !== JSON.stringify(servers)) {
                localStorage.setItem('opspilot-mcp-servers', JSON.stringify(cleaned));
            }

            // Connect to servers sequentially (await each connection properly)
            const serversToConnect = cleaned.filter((s: any) => {
                const fullCmdString = `${s.command} ${(s.args || []).join(' ')} `.toLowerCase();
                if (fullCmdString.includes('calc') || fullCmdString.includes('calculator') || s.command === 'open') {
                    console.warn(`[MCP] Purging unsafe command from config: ${s.command} ${(s.args || []).join(' ')} `);
                    return false;
                }
                return s.autoConnect;
            });

            let connectedCount = 0;
            for (const s of serversToConnect) {
                try {
                    await invoke('connect_mcp_server', {
                        name: s.name,
                        command: s.command,
                        args: s.args,
                        env: s.env || {}
                    });
                    console.log(`[MCP] Auto - connected to ${s.name} `);
                    connectedCount++;
                } catch (err) {
                    console.warn(`[MCP] Auto - connect failed for ${s.name}: `, err);
                }
            }

            // Fetch MCP tools AFTER all connections are established
            if (connectedCount > 0) {
                console.log(`[MCP] Refreshing tools after ${connectedCount} server connections...`);
                try {
                    const tools = await invoke<any[]>("list_mcp_tools");
                    registerMcpTools(tools);
                    console.log(`[MCP] Loaded ${tools.length} tools from connected servers`);
                } catch (e) {
                    console.error("[MCP] Failed to refresh tools:", e);
                }
            }
        };

        preflightAndConnect();
    }, []);





    const fetchMcpTools = async () => {
        try {
            const tools = await invoke<any[]>("list_mcp_tools");
            registerMcpTools(tools);
        } catch (e) {
            console.error("Failed to list MCP tools:", e);
        }
    };

    const checkLLMStatus = async () => {
        setCheckingLLM(true);
        try {
            if (llmConfig.provider === 'claude-code') {
                const ccStatus = await invoke<{ available: boolean; version: string | null; error: string | null }>("check_claude_code_status");
                setLlmStatus({
                    connected: ccStatus.available,
                    provider: 'claude-code',
                    model: ccStatus.version || 'claude-code-cli',
                    available_models: [],
                    error: ccStatus.error,
                });
            } else {
                let status = await invoke<LLMStatus>("check_llm_status", { config: llmConfig });

                // Check if connection is OK but model is missing
                if (llmConfig.provider === 'ollama' && status.connected && status.error?.includes('not found')) {
                    const isLocalhost = llmConfig.base_url.includes('localhost') || llmConfig.base_url.includes('127.0.0.1');

                    // Prioritize verifying if any other models exist on the remote server
                    if (!isLocalhost && status.available_models && status.available_models.length > 0) {
                        // REMOTE: Auto-fallback to first available model
                        // This prevents forcing a download on a remote server that might be read-only
                        const fallbackModel = status.available_models[0];
                        console.log(`[Auto - Heal] Remote server detected.Fallback to existing model: ${fallbackModel} `);

                        // Update config to use the available model
                        setLlmConfig(prev => ({ ...prev, model: fallbackModel }));
                        // The effect will reload status automatically.
                        // We return early to let the re-render handle the new status.
                        return;
                    } else if (isLocalhost) {
                        // LOCAL: Request confirmation to download
                        console.log('[Auto-Heal] Local model not found, requesting confirmation...');
                        setShowDownloadConfirm(true);
                        setCheckingLLM(false);
                    } else {
                        // Remote but NO models at all? Or remote but we can't switch? Show the error.
                        setLlmStatus(status);
                        setCheckingLLM(false);
                    }
                } else {
                    setLlmStatus(status);
                    setCheckingLLM(false);
                }
            }
        } catch (err) {
            setLlmStatus({
                connected: false,
                provider: llmConfig.provider,
                model: llmConfig.model,
                available_models: [],
                error: String(err),
            });
            setCheckingLLM(false);
        }
    };

    // Auto-scroll to bottom
    useEffect(() => {
        if (chatEndRef.current) {
            chatEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, [chatHistory]);

    // Get a user-friendly description of what the tool does
    const getToolActivity = (toolName: string, args?: string): string => {
        const toolDescriptions: Record<string, string> = {
            'CLUSTER_HEALTH': '🔍 Checking cluster health...',
            'GET_EVENTS': args ? `📋 Fetching events for ${args}...` : '📋 Fetching cluster events...',
            'LIST_ALL': args ? `📊 Listing ${args} resources...` : '📊 Listing resources...',
            'DESCRIBE': args ? `🔬 Describing ${args}...` : '🔬 Getting resource details...',
            'GET_LOGS': args ? `📜 Fetching logs for ${args}...` : '📜 Fetching pod logs...',
            'TOP_PODS': args ? `📈 Checking pod metrics in ${args}...` : '📈 Checking pod resource usage...',
            'FIND_ISSUES': '🔎 Scanning for cluster issues...',
            'SEARCH_KNOWLEDGE': args ? `📚 Searching knowledge base for "${args}"...` : '📚 Searching knowledge base...',
            'GET_ENDPOINTS': args ? `🌐 Getting endpoints for ${args}...` : '🌐 Getting service endpoints...',
            'GET_NAMESPACE': args ? `📁 Inspecting namespace $ { args }...` : '📁 Inspecting namespace...',
            'LIST_FINALIZERS': args ? `🔗 Finding finalizers in ${args}...` : '🔗 Finding stuck finalizers...',
        };
        return toolDescriptions[toolName] || `⚙️ Executing ${toolName}...`;
    };

    // NOTE: Knowledge base search is now triggered BY THE LLM when it decides it's needed
    // via the SEARCH_KNOWLEDGE tool. No automatic pre-search - LLM is the intelligent orchestrator.


    // Helper to call LLM - routes to Claude Code CLI or regular API
    const callLLM = async (
        prompt: string,
        systemPrompt: string,
        conversationHistory: Array<{ role: string; content: string }>,
        options?: LLMOptions
    ): Promise<string> => {
        if (llmConfig.provider === 'claude-code') {
            // Build conversation context for Claude Code
            const historyStr = conversationHistory
                .slice(-10) // Last 10 messages for context
                .map(m => `${m.role.toUpperCase()}: ${m.content} `)
                .join('\n\n');

            const fullPrompt = historyStr ? `${historyStr} \n\nUSER: ${prompt} ` : prompt;

            return await invoke<string>("call_claude_code", {
                prompt: fullPrompt,
                systemPrompt,
            });
        } else {
            // Merge options with config (options override config values)
            const configWithOptions = options ? {
                ...llmConfig,
                temperature: options.temperature ?? llmConfig.temperature,
                max_tokens: options.max_tokens ?? llmConfig.max_tokens,
                model: options.model ?? llmConfig.model,
            } : llmConfig;

            return await invoke<string>("call_llm", {
                config: configWithOptions,
                prompt,
                systemPrompt,
                conversationHistory,
            });
        }
    };



    // Cancel ongoing analysis
    const cancelAnalysis = useCallback(() => {
        setIsCancelling(true);
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        // Add cancellation message to chat
        setChatHistory(prev => [...prev, {
            role: 'assistant',
            content: '⚠️ Analysis cancelled by user.'
        }]);
        setLlmLoading(false);
        setIsCancelling(false);
        setCurrentActivity("");
    }, []);

    const sendMessage = async (message: string) => {
        if (!message.trim() || llmLoading) return;

        // Create new abort controller for this request
        abortControllerRef.current = new AbortController();

        setChatHistory(prev => [...prev, { role: 'user', content: message }]);
        setUserInput("");
        setLlmLoading(true);
        setSuggestedActions([]);

        try {
            // ===== HIERARCHICAL SUPERVISOR-WORKER AGENT =====
            // Replaces the old single-loop logic with the Orchestrator
            // See: agentOrchestrator.ts for the Supervisor/Scout/Specialist logic
            try {
                setCurrentActivity("🚀 Initializing Supervisor Agent...");

                // Create abort controller for this request
                const controller = new AbortController();
                abortControllerRef.current = controller;

                // Convert RECENT chat history to agent context (only last 3 messages for follow-up context)
                // Each new question starts mostly fresh - don't carry over old investigations
                const contextHistory: AgentStep[] = chatHistory
                    .filter(m => m.role === 'user' || m.role === 'assistant')
                    .slice(-3) // Only last 3 messages for minimal context
                    .map(m => ({
                        role: m.role === 'user' ? 'USER' as const :
                            m.role === 'tool' ? 'SCOUT' as const :
                                'SUPERVISOR' as const, // Map general assistant to Supervisor for context
                        content: m.content
                    }));

                // Inject Resource Context if available
                if (resourceContext) {
                    const resourceContextMsg = `CONTEXT LOCK: ACTIVE RESOURCE DEEP DIVE\n` +
                        `You are currently analyzing a specific resource in the Deep Dive Drawer: \n` +
                        `• Kind: ${resourceContext.kind} \n` +
                        `• Name: ${resourceContext.name} \n` +
                        `• Namespace: ${resourceContext.namespace} \n\n` +
                        `CRITICAL INSTRUCTIONS: \n` +
                        `1. ALL user queries imply THIS specific resource unless explicitly stated otherwise.\n` +
                        `2. example: "why is it failing?" → check logs / events for ${resourceContext.name}.\n` +
                        `3. example: "show logs" → fetch logs for ${resourceContext.name}.\n` +
                        `4. DO NOT search for other pods or resources unless the user explicitly names them.\n` +
                        `5. If the user asks a general question, answer it in the context of ${resourceContext.name}.\n` +
                        `6. You are "immersed" in this resource.Do not broaden scope unnecessarily.`;

                    // Prepend to context as a system-like USER instruction
                    contextHistory.unshift({
                        role: 'USER',
                        content: resourceContextMsg
                    });
                }

                // SPECIAL HANDLING: CLAUDE CODE CLI
                // If using Claude Code, bypass the Python agent loop entirely.
                // The CLI is an autonomous agent itself.
                if (llmConfig.provider === 'claude-code') {
                    setCurrentActivity("🤖 Handing over to Claude Code CLI...");

                    const historyStr = chatHistory
                        .filter(m => m.role === 'user' || m.role === 'assistant')
                        .slice(-6)
                        .map(m => `${m.role.toUpperCase()}: ${m.content} `)
                        .join('\n\n');

                    const fullPrompt = historyStr ? `${historyStr} \n\nUSER: ${message.trim()} ` : message.trim();

                    // Call the Rust command directly (streaming supported via call_claude_code_stream, but using blocking call for now per existing patterns or upgrading to stream?)
                    // The existing code at lines 507 used 'call_claude_code'.
                    // Wait, lines 507 were inside 'callLLM'. 
                    // Here we are replacing 'runAgentLoop' which expects a Promise<string> but also handles UI updates.

                    // STREAMING IMPLEMENTATION
                    // Generate a unique stream ID
                    const streamId = `claude - ${Date.now()} `;

                    // Add an initial placeholder message
                    setChatHistory(prev => [...prev, {
                        role: 'assistant',
                        content: '',
                        isStreaming: true
                    }]);
                    setLlmLoading(true);
                    setCurrentActivity("🤖 Claude Code is thinking...");

                    // Setup listener
                    // Note: In Tauri v2, listen returns a Promise<UnlistenFn>
                    const unlisten = await listen<ClaudeCodeStreamEvent>('claude-code-stream', (event) => {
                        if (event.payload.stream_id !== streamId) return;

                        if (event.payload.event_type === 'chunk') {
                            setChatHistory(prev => {
                                const last = prev[prev.length - 1];
                                if (last.role === 'assistant' && last.isStreaming) {
                                    return [
                                        ...prev.slice(0, -1),
                                        { ...last, content: last.content + event.payload.content }
                                    ];
                                }
                                return prev;
                            });
                        } else if (event.payload.event_type === 'done') {
                            setChatHistory(prev => {
                                const last = prev[prev.length - 1];
                                if (last.role === 'assistant' && last.isStreaming) {
                                    return [
                                        ...prev.slice(0, -1),
                                        { ...last, isStreaming: false }
                                    ];
                                }
                                return prev;
                            });
                            setLlmLoading(false);
                            setCurrentActivity("");
                        } else if (event.payload.event_type === 'error') {
                            setChatHistory(prev => {
                                const last = prev[prev.length - 1];
                                if (last.role === 'assistant' && last.isStreaming) {
                                    return [
                                        ...prev.slice(0, -1),
                                        { ...last, content: last.content + `\n\n❌ Error: ${event.payload.content} `, isStreaming: false }
                                    ];
                                }
                                return prev;
                            });
                            setLlmLoading(false);
                            setCurrentActivity("");
                        }
                    });

                    // Start the stream
                    // Start the stream
                    try {
                        await invoke("call_claude_code_stream", {
                            prompt: fullPrompt,
                            kubeContext: currentContext || null,
                            streamId: streamId
                        });
                    } catch (e) {
                        console.error("Failed to start stream", e);
                        setLlmLoading(false);
                    } finally {
                        unlisten();
                    }

                    return;
                }

                const result = await runAgentLoop(
                    // Current input
                    message.trim(),
                    // LLM Executor (Brain - Planner/Analyst)
                    // Options are passed from agentOrchestrator with role-specific temp/max_tokens
                    {
                        callLLM: async (prompt: string, systemPrompt: string, options: any) => {
                            return await invoke('call_llm', {
                                model: options?.model || 'opspilot-brain',
                                prompt,
                                systemPrompt,
                                temperature: options?.temperature || 0.7
                            });
                        },
                        callLLMStream: async (prompt: string, systemPrompt: string, options: any) => {
                            return; // Stream not supported in this context yet
                        }
                    },
                    // Fast Executor (Muscle - Executor)
                    // Uses executor_model if configured, otherwise falls back to main model
                    async (prompt: string, systemPrompt: string, options: any) => {
                        if (llmConfig.executor_model) {
                            // Use the dedicated executor model for fast CLI translation
                            // Merge options with executor config
                            const executorConfig = {
                                ...llmConfig,
                                model: llmConfig.executor_model,
                                temperature: options?.temperature ?? llmConfig.temperature,
                                max_tokens: options?.max_tokens ?? llmConfig.max_tokens,
                            };
                            try {
                                return await invoke<string>("call_llm", {
                                    config: executorConfig,
                                    prompt,
                                    systemPrompt,
                                    conversationHistory: [],
                                });
                            } catch (e) {
                                console.warn("Executor model failed, using Brain model:", e);
                                return await callLLM(prompt, systemPrompt, [], options);
                            }
                        }
                        // No executor_model configured - use the Brain model
                        return await callLLM(prompt, systemPrompt, [], options);
                    },
                    // Progress callback
                    (msg) => {
                        setCurrentActivity(msg);
                    },
                    // Streaming step callback
                    (step) => {
                        // Add intermediate steps to history so they appear in UI
                        let content = step.content;
                        // Map internal roles to user-friendly names
                        let toolName = step.role === 'SCOUT' ? 'Terminal' : step.role;
                        let command = undefined;

                        // Try to interpret structured backend event payloads
                        try {
                            const maybe = JSON.parse(step.content);
                            if (maybe && typeof maybe === 'object' && maybe.type) {
                                switch (maybe.type) {
                                    case 'phase': {
                                        const name = maybe.phase || maybe.name || 'phase';
                                        const timestamp = maybe.timestamp;
                                        setPhaseTimeline(prev => [...prev, { name, timestamp }]);
                                        setChatHistory(prev => [...prev, { role: 'assistant', content: `Phase: ${name}` }]);
                                        return; // handled
                                    }
                                    case 'hypotheses': {
                                        const list = Array.isArray(maybe.items) ? maybe.items : (Array.isArray(maybe.hypotheses) ? maybe.hypotheses : []);
                                        const normalized = list.map((h: any) => ({ title: h.title || h.name || String(h), confidence: h.confidence }));
                                        setRankedHypotheses(normalized);
                                        setChatHistory(prev => [...prev, { role: 'assistant', content: `Hypotheses updated (${normalized.length})` }]);
                                        return;
                                    }
                                    case 'approval_needed': {
                                        setApprovalContext({ command: maybe.command, reason: maybe.reason, risk: maybe.risk, impact: maybe.impact });
                                        setChatHistory(prev => [...prev, { role: 'assistant', content: `Approval needed: ${maybe.reason || 'See details'}` }]);
                                        return;
                                    }
                                    case 'coverage': {
                                        const missing = Array.isArray(maybe.missing) ? maybe.missing : [];
                                        setCoverageGaps(missing);
                                        setChatHistory(prev => [...prev, { role: 'assistant', content: `Coverage gaps: ${missing.join(', ') || 'none'}` }]);
                                        return;
                                    }
                                    case 'hint': {
                                        const text = maybe.message || maybe.hint;
                                        if (text) {
                                            setAgentHints(prev => [...prev, text]);
                                            setChatHistory(prev => [...prev, { role: 'assistant', content: `Hint: ${text}` }]);
                                        }
                                        return;
                                    }
                                    case 'verification': {
                                        const met = !!maybe.met;
                                        const reason = maybe.reason || '';
                                        setGoalVerification({ met, reason });
                                        setChatHistory(prev => [...prev, { role: 'assistant', content: `Goal status: ${met ? 'MET' : 'NOT MET'} — ${reason}` }]);
                                        return;
                                    }
                                    case 'plan_bias': {
                                        setExtendedMode({ preferred_checks: maybe.preferred_checks || [], prefer_mcp_tools: !!maybe.prefer_mcp_tools });
                                        setChatHistory(prev => [...prev, { role: 'assistant', content: `Extended mode: prioritizing ${Array.isArray(maybe.preferred_checks) ? maybe.preferred_checks.join(', ') : 'broader coverage'}${maybe.prefer_mcp_tools ? ' + MCP tools' : ''}` }]);
                                        return;
                                    }
                                    default: {
                                        // fall through to normal handling
                                    }
                                }
                            }
                        } catch { /* not JSON, continue */ }

                        // Parse Scout JSON for better display
                        if (step.role === 'SCOUT') {
                            try {
                                const json = JSON.parse(step.content);
                                command = json.command;
                                content = `\`$ ${json.command}\`\n\n${json.output}`;
                            } catch (e) { /* keep raw content */ }
                        }

                        // Filter UI visibility based on user preference:
                        // 1. SUPERVISOR -> Show as "Thinking"
                        // 2. SCOUT -> Show as Tool (Terminal)
                        // 3. SPECIALIST -> Show as Tool (MCP)

                        const uiRole = step.role === 'SUPERVISOR' ? 'assistant' : 'tool';

                        let contentToShow = content;
                        if (step.role === 'SUPERVISOR') {
                            contentToShow = `🧠 Thinking: ${step.content}`;
                        } else if (step.role === 'SPECIALIST') {
                            // Ensure SPECIALIST content (MCP Tools) is shown
                            // We can strip the "**Using Tool**:" prefix if we want cleaner UI, but it's fine for now
                            contentToShow = step.content;
                            toolName = 'External Tool';
                        }

                        // Add to UI immediately
                        setChatHistory(prev => {
                            const last = prev[prev.length - 1];
                            // Consolidate consecutive "Thinking" messages
                            if (step.role === 'SUPERVISOR' && last && last.role === 'assistant' && (last.content.includes('🧠 Thinking') || last.content.includes('🧠 Supervisor'))) {
                                return [
                                    ...prev.slice(0, -1),
                                    { ...last, content: last.content + "\n\n" + step.content }
                                ];
                            }
                            return [...prev, {
                                role: uiRole,
                                content: contentToShow,
                                toolName,
                                command
                            }];
                        });
                    },
                    // Pass conversation context (User + Assistant only, exclude tools/activity)
                    contextHistory,
                    // Pass abort signal for cancellation
                    controller.signal,
                    // Pass current Kubernetes context
                    currentContext,
                    // Pass LLM config for Python agent
                    {
                        endpoint: llmConfig.base_url,
                        provider: llmConfig.provider,
                        model: llmConfig.model,
                        executor_model: llmConfig.executor_model || undefined
                    },
                    // Pass available MCP tools for the agent to use
                    listRegisteredMcpTools(),
                    // Plan event callbacks
                    (plan, totalSteps) => {
                        // Plan created
                        setCurrentPlan(plan);
                        setPlanTotalSteps(totalSteps);
                    },
                    (step, planSummary) => {
                        // Step completed - update plan
                        setCurrentPlan(prev => {
                            if (!prev) return prev;
                            return prev.map(s =>
                                s.step === step ? { ...s, status: 'completed' } : s
                            );
                        });
                    },
                    (step, error) => {
                        // Step failed - update plan
                        setCurrentPlan(prev => {
                            if (!prev) return prev;
                            return prev.map(s =>
                                s.step === step ? { ...s, status: 'failed' } : s
                            );
                        });
                    },
                    () => {
                        // Plan complete - clear after a delay
                        setTimeout(() => {
                            setCurrentPlan(null);
                            setPlanTotalSteps(0);
                        }, 3000);
                    }
                );

                // Post-process final response to format kubectl output
                let formattedResult = result;

                // Detect if response contains raw kubectl pod list output
                if (result.includes('NAMESPACE') && result.includes('READY') && result.includes('STATUS') && result.includes('RESTARTS')) {
                    const formatted = formatFailingPods(result);
                    formattedResult = formatted.markdown;
                }

                setChatHistory(prev => [...prev, { role: 'assistant', content: formattedResult }]);
                setLlmLoading(false);
            } catch (e: any) {
                // Handle cancellation gracefully
                if (e?.message === 'CANCELLED' || abortControllerRef.current?.signal.aborted) {
                    console.log("Agent loop cancelled by user");
                    setLlmLoading(false);
                    return;
                }
                console.error("Agent Loop Failed:", e);
                const errorMsg = String(e || '');

                // Provider-specific error messages
                if (llmConfig.provider === 'ollama' && (errorMsg.includes("not found") || errorMsg.includes("404"))) {
                    setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ **Model Missing**: Model "${llmConfig.model}" is not installed. Run \`ollama pull ${llmConfig.model}\` or select an available model in Settings.` }]);
                } else if (errorMsg.includes("404")) {
                    setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ **API Error (404)**: Endpoint not found. Check your base URL and model name in Settings. Current: ${llmConfig.base_url} / ${llmConfig.model}` }]);
                } else if (errorMsg.includes("401") || errorMsg.includes("403") || errorMsg.includes("Unauthorized")) {
                    setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ **Authentication Failed**: Check your API key in Settings.` }]);
                } else if (errorMsg.includes("connection") || errorMsg.includes("ECONNREFUSED") || errorMsg.includes("timeout")) {
                    setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ **Connection Failed**: Cannot reach ${llmConfig.base_url}. Is the server running?` }]);
                } else {
                    setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Agent error: ${e}` }]);
                }
                setLlmLoading(false);
            }
        } catch (err: any) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Error: ${err}. Check your AI settings or provider connection.` }]);
        } finally {
            setLlmLoading(false);
            setInvestigationProgress(null);
        }
    };

    // If minimized, show just a small pill (only if not embedded)
    if (isMinimized && !embedded) {
        return createPortal(
            <div
                onClick={onToggleMinimize}
                className="fixed bottom-4 right-4 z-50 flex items-center gap-2.5 px-5 py-2.5 bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 hover:from-violet-500 hover:via-purple-500 hover:to-fuchsia-500 rounded-2xl shadow-xl shadow-purple-500/25 cursor-pointer transition-all duration-300 group hover:scale-105 hover:shadow-purple-500/40"
            >
                <div className="relative">
                    <Sparkles size={18} className="text-white" />
                    <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                </div>
                <span className="text-white font-semibold text-sm tracking-tight">AI Assistant</span>
                {chatHistory.length > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/20 text-white font-medium backdrop-blur-sm">{chatHistory.filter(m => m.role === 'assistant').length}</span>
                )}
                <button
                    onClick={(e) => { e.stopPropagation(); onClose?.(); }}
                    className="ml-1 p-1 rounded-full hover:bg-white/20 text-white/70 hover:text-white transition-all opacity-70 hover:opacity-100"
                >
                    <X size={14} />
                </button>
            </div>,
            document.body
        );
    }

    const panelContent = (
        <div className={embedded
            ? "flex flex-col h-full w-full bg-[#111113] border-l border-white/5 relative"
            : `fixed ${isExpanded ? 'inset-4' : 'bottom-4 right-4 w-[480px] h-[640px]'} z-50 flex flex-col bg-gradient-to-b from-[#1a1a2e] to-[#16161a] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 transition-all duration-300 overflow-hidden`
        }>
            {/* Decorative background effects */}
            <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-purple-500/10 via-fuchsia-500/5 to-transparent pointer-events-none" />
            <div className="absolute -top-24 -right-24 w-48 h-48 bg-purple-500/20 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

            {/* Header */}
            <div className="relative z-50 flex items-center justify-between px-4 py-3.5 border-b border-white/10 bg-[#16161a] shrink-0 shadow-md">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="relative shrink-0">
                        <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-xl blur-sm opacity-60" />
                        <div className="relative p-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500">
                            <Sparkles size={16} className="text-white" />
                        </div>
                    </div>
                    <div className="min-w-0">
                        <h3 className="font-semibold text-white text-sm tracking-tight truncate">AI Assistant</h3>
                        <div className="flex items-center gap-2 flex-wrap">
                            <button
                                onClick={() => setShowSettings(true)}
                                className="text-[10px] text-zinc-400 hover:text-zinc-300 flex items-center gap-1.5 transition-colors group"
                            >
                                <div className={`w-1.5 h-1.5 rounded-full ${llmStatus?.connected ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-red-400 shadow-sm shadow-red-400/50'}`} />
                                <span className="truncate">{llmConfig.provider === 'ollama' ? 'Ollama' : llmConfig.provider === 'openai' ? 'OpenAI' : llmConfig.provider === 'anthropic' ? 'Anthropic' : 'Custom'}</span>
                                <span className="text-zinc-500">•</span>
                                <span className="text-zinc-500 group-hover:text-zinc-400 truncate">{llmConfig.model.split(':')[0]}</span>
                                <ChevronDown size={10} className="text-zinc-500 shrink-0" />
                            </button>
                            {extendedMode && (
                                <span
                                    className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/30 text-violet-300"
                                    title={`Extended mode • Checks: ${extendedMode.preferred_checks?.join(', ') || 'broader coverage'}${extendedMode.prefer_mcp_tools ? ' • Prefers MCP tools' : ''}`}
                                >
                                    Extended
                                </span>
                            )}
                            {currentContext && (
                                <span className="text-[10px] text-cyan-400/80 flex items-center gap-1 truncate max-w-[150px]" title={`Kubernetes Context: ${currentContext}`}>
                                    <span className="text-zinc-500">→</span>
                                    <span className="truncate">{currentContext}</span>
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                {/* Header Actions */}
                <div className="flex items-center gap-1.5 bg-[#27272a] rounded-lg p-1 border border-white/20 shadow-md shrink-0 ml-2">
                    <button
                        onClick={() => {
                            setChatHistory([]);
                            localStorage.removeItem('ops-pilot-chat-history');
                        }}
                        className="p-1.5 text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-md transition-all"
                        title="Clear Chat History"
                    >
                        <Trash2 size={14} />
                    </button>
                    {llmLoading && (
                        <>
                            <div className="w-px h-3 bg-white/10 mx-0.5" />
                            <button
                                onClick={cancelAnalysis}
                                disabled={isCancelling}
                                className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-md transition-all disabled:opacity-50"
                                title={isCancelling ? "Stopping..." : "Stop Generation"}
                            >
                                <StopCircle size={14} className={isCancelling ? "animate-spin" : ""} />
                            </button>
                        </>
                    )}
                    <div className="w-px h-3 bg-white/10 mx-0.5" />
                    <button
                        onClick={() => setShowSettings(true)}
                        className="p-1.5 rounded-md hover:bg-white/10 text-zinc-300 hover:text-white transition-all"
                        title="Settings"
                    >
                        <Settings size={14} />
                    </button>
                    <div className="w-px h-3 bg-white/10 mx-0.5" />
                    <button
                        onClick={onToggleMinimize}
                        className="p-1.5 rounded-md hover:bg-white/10 text-zinc-300 hover:text-white transition-all"
                        title="Minimize"
                    >
                        <Minus size={14} />
                    </button>
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="p-1.5 rounded-md hover:bg-white/10 text-zinc-300 hover:text-white transition-all"
                        title={isExpanded ? "Restore" : "Expand"}
                    >
                        {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-md hover:bg-red-500/20 text-zinc-300 hover:text-red-400 transition-all"
                        title="Close"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>

            {/* Settings Panel Modal */}
            {showSettings && (
                <div className="absolute inset-0 z-50 bg-gradient-to-b from-[#1a1a2e] to-[#16161a] rounded-2xl overflow-y-auto">
                    <LLMSettingsPanel
                        config={llmConfig}
                        onConfigChange={(newConfig) => {
                            setLlmConfig(newConfig);
                            setShowSettings(false);
                        }}
                        onClose={() => setShowSettings(false)}
                        systemSpecs={systemSpecs}
                    />
                </div>
            )}

            {/* Messages */}
            <div
                ref={messagesContainerRef}
                className="relative flex-1 min-h-0 overflow-y-auto p-4 space-y-4 scroll-smooth"
            >
                {/* Loading state while checking LLM */}
                {checkingLLM && chatHistory.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-24 px-6">
                        <div className="relative mb-8">
                            <div className="absolute inset-0 bg-violet-500/30 blur-xl rounded-full animate-pulse" />
                            <div className="relative w-16 h-16 border-4 border-violet-500/30 border-t-violet-400 rounded-full animate-spin" />
                            <div className="absolute inset-0 flex items-center justify-center">
                                <Sparkles size={20} className="text-violet-200 animate-pulse" />
                            </div>
                        </div>
                        <h3 className="text-lg font-semibold text-white mb-2 animate-pulse">Initializing AI...</h3>
                        <p className="text-sm text-zinc-400 text-center max-w-xs">
                            Checking connection and model status. <br />
                            <span className="text-xs text-zinc-500 mt-2 block opacity-80">(This may take a moment if downloading)</span>
                        </p>
                    </div>
                )}


                {/* Show setup prompt if LLM not connected OR if there is an error (like model missing) */}
                {
                    !checkingLLM && (!llmStatus?.connected || !!llmStatus?.error) && chatHistory.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-12 px-6 max-w-lg mx-auto w-full">
                            {llmConfig.provider === 'ollama' ? (
                                <div className="w-full bg-zinc-900/50 rounded-2xl border border-white/10 overflow-hidden shadow-2xl">
                                    <OllamaSetupInstructions
                                        status={llmStatus ? {
                                            ollama_running: llmStatus.connected,
                                            model_available: !llmStatus.error?.includes('not found') && !llmStatus.error?.includes('missing'),
                                            available_models: llmStatus.available_models || [],
                                            model_name: llmConfig.model,
                                            error: llmStatus.error
                                        } : null}
                                        onRetry={checkLLMStatus}
                                    />
                                </div>
                            ) : (
                                <>
                                    <div className="relative mb-6">
                                        <div className="absolute inset-0 bg-gradient-to-br from-orange-500 to-red-500 rounded-2xl blur-xl opacity-20" />
                                        <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-orange-500/20 to-red-500/20 flex items-center justify-center border border-orange-500/20 backdrop-blur-sm">
                                            <AlertCircle size={36} className="text-orange-400" />
                                        </div>
                                    </div>
                                    <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Setup Required</h3>
                                    <p className="text-sm text-zinc-400 text-center mb-1 max-w-[280px]">{llmStatus?.error || 'Configure your AI provider to start chatting.'}</p>
                                    <p className="text-xs text-zinc-500 mb-6 font-mono">{llmConfig.provider} • {llmConfig.model}</p>
                                    <button
                                        onClick={() => setShowSettings(true)}
                                        className="group px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-semibold text-sm transition-all duration-300 flex items-center gap-2 shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:scale-105"
                                    >
                                        <Settings size={16} className="group-hover:rotate-90 transition-transform duration-300" />
                                        Configure AI
                                    </button>
                                </>
                            )}
                        </div>
                    )
                }

                {/* Normal chat welcome screen - only show when LLM is ready AND NO ERROR */}
                {
                    !checkingLLM && llmStatus?.connected && !llmStatus?.error && chatHistory.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-10 px-6">
                            <div className="relative mb-6">
                                <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-cyan-500 rounded-2xl blur-xl opacity-20 animate-pulse" />
                                <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 flex items-center justify-center border border-violet-500/20 backdrop-blur-sm">
                                    <Sparkles size={36} className="text-violet-400" />
                                </div>
                            </div>
                            <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Hey there! 👋</h3>
                            {loadingWelcomeJoke ? (
                                <p className="text-sm text-zinc-400 text-center mb-1 max-w-[320px] italic animate-pulse">
                                    Thinking of something funny...
                                </p>
                            ) : welcomeJoke ? (
                                <div className="flex items-center gap-2 mb-1">
                                    <p className="text-sm text-zinc-300 text-center max-w-[320px] italic">
                                        {welcomeJoke}
                                    </p>
                                    <button
                                        onClick={fetchNewWelcomeJoke}
                                        className="p-1.5 text-zinc-500 hover:text-violet-400 hover:bg-violet-500/10 rounded-lg transition-all"
                                        title="Get another joke"
                                    >
                                        <RefreshCw size={14} />
                                    </button>
                                </div>
                            ) : (
                                <p className="text-sm text-zinc-400 text-center mb-1 max-w-[300px]">
                                    Ask me anything about your cluster's health, resources, or issues.
                                </p>
                            )}
                            <p className="text-xs text-zinc-500 text-center mt-2 max-w-[300px]">What can I help you debug today?</p>
                            <div className="flex flex-col items-center gap-1 mb-6">
                                <p className="text-xs text-zinc-500 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
                                    {llmStatus.provider} • {llmConfig.model.split(':')[0]}
                                </p>
                                {/* Embedding model status indicator */}
                                {embeddingStatus && (
                                    <p className={`text - [10px] flex items - center gap - 1.5 ${embeddingStatus === 'loading' ? 'text-amber-400' :
                                        embeddingStatus === 'ready' ? 'text-zinc-500' :
                                            'text-red-400'
                                        } `}>
                                        {embeddingStatus === 'loading' && (
                                            <>
                                                <Loader2 size={10} className="animate-spin" />
                                                {embeddingMessage || 'Loading knowledge base...'}
                                            </>
                                        )}
                                        {embeddingStatus === 'ready' && (
                                            <>
                                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/50" />
                                                Knowledge base ready
                                            </>
                                        )}
                                        {embeddingStatus === 'error' && (
                                            <>
                                                <AlertCircle size={10} />
                                                KB unavailable
                                            </>
                                        )}
                                    </p>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-2 justify-center max-w-[360px]">
                                {[
                                    { icon: '🔍', text: 'Find cluster issues' },
                                    { icon: '🚀', text: 'Auto-Diagnose Cluster' },
                                    { icon: '🔄', text: 'Crashlooping pods' },
                                    { icon: '📊', text: 'Health overview' }
                                ].map(q => (
                                    <button
                                        key={q.text}
                                        onClick={() => sendMessage(q.text === 'Auto-Diagnose Cluster' ? 'Perform an autonomous deep dive on the cluster health. Use the Autonomous Playbook.' : q.text)}
                                        className="px-3.5 py-2 text-xs bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white rounded-xl transition-all border border-white/5 hover:border-white/10 flex items-center gap-2"
                                    >
                                        <span>{q.icon}</span>
                                        {q.text}
                                    </button>
                                ))}
                            </div>
                        </div>


                    )}

                {/* Plan Progress UI - Show when plan is active */}
                {currentPlan && currentPlan.length > 0 && (
                    <PlanProgressUI
                        plan={currentPlan}
                        totalSteps={planTotalSteps}
                        className="mb-4"
                    />
                )}

                {
                    groupedHistory.map((group, i) => {
                        if (group.type === 'raw') {
                            // Fallback for raw messages (likely system or orphaned)
                            return (
                                <div key={i} className="pl-6 pb-2">
                                    <ThinkingMessage content={group.msg.content} isLatest={false} />
                                </div>
                            );
                        }
                        if (group.type === 'system_steps') {
                            return (
                                <div key={i}>
                                    <InvestigationTimeline
                                        steps={group.steps}
                                        isActive={i === groupedHistory.length - 1 && !group.answer}
                                    />
                                </div>
                            )
                        }

                        // Interaction Group
                        const isLastGroup = i === groupedHistory.length - 1;
                        const isInvestigating = isLastGroup && !group.answer;

                        return (
                            <div key={i} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                                {/* User Message */}
                                {group.user && (
                                    <div className="relative pl-6 pb-4">
                                        <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-violet-500 ring-4 ring-violet-500/20" />
                                        <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-violet-500/50 to-transparent" />
                                        <div className="ml-2">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-[10px] font-medium text-violet-400 uppercase tracking-wider">Task</span>
                                            </div>
                                            <div className="bg-gradient-to-br from-violet-600/20 to-fuchsia-600/20 rounded-lg px-3 py-2 border border-violet-500/30">
                                                <p className="text-sm text-white">{group.user.content}</p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Timeline */}
                                {group.steps && group.steps.length > 0 && (
                                    <InvestigationTimeline
                                        steps={group.steps}
                                        isActive={isInvestigating}
                                    />
                                )}

                                {/* Final Answer */}
                                {group.answer && (
                                    <div className="relative pl-6 pb-4">
                                        <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20" />
                                        <div className="ml-2">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="text-[10px] font-medium text-emerald-400 uppercase tracking-wider">Answer</span>
                                                <Sparkles size={10} className="text-emerald-400" />
                                            </div>
                                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] overflow-hidden">
                                                <div className="px-4 py-3 prose prose-invert prose-sm max-w-none">
                                                    <ReactMarkdown
                                                        remarkPlugins={[remarkGfm]}
                                                        components={{
                                                            p: ({ children }) => <p className="text-[13px] text-zinc-300 my-1.5 leading-relaxed">{children}</p>,
                                                            strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                                                            em: ({ children }) => <em className="text-zinc-400 not-italic">{children}</em>,
                                                            code: ({ children }) => <code className="text-[11px] bg-black/40 px-1.5 py-0.5 rounded text-cyan-300 font-mono">{children}</code>,
                                                            pre: ({ children }) => <pre className="text-[11px] bg-black/40 p-2.5 rounded-lg overflow-x-auto my-2 font-mono">{children}</pre>,
                                                            ul: ({ children }) => <ul className="text-[13px] list-none ml-0 my-1.5 space-y-1">{children}</ul>,
                                                            ol: ({ children }) => <ol className="text-[13px] list-decimal ml-4 my-1.5 space-y-1">{children}</ol>,
                                                            li: ({ children }) => <li className="text-zinc-300 before:content-['→'] before:text-emerald-500 before:mr-2 before:font-bold">{children}</li>,
                                                            h1: ({ children }) => <h1 className="text-sm font-bold text-white mt-4 mb-2 flex items-center gap-2 border-b border-zinc-700 pb-2">{children}</h1>,
                                                            h2: ({ children }) => <h2 className="text-sm font-bold text-emerald-300 mt-4 mb-2 flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{children}</h2>,
                                                            h3: ({ children }) => <h3 className="text-sm font-semibold text-cyan-300 mt-3 mb-1.5">{children}</h3>,
                                                            blockquote: ({ children }) => <blockquote className="border-l-2 border-amber-500 pl-3 my-2 text-amber-200/80 italic">{children}</blockquote>,
                                                        }}
                                                    >
                                                        {fixMarkdownHeaders(group.answer.content)}
                                                    </ReactMarkdown>
                                                    {group.answer.isStreaming && group.answer.content && (
                                                        <span className="inline-block w-1.5 h-4 bg-emerald-400 animate-pulse ml-0.5" />
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })
                }    {/* Loading State with Cancel Button */}
                {
                    llmLoading && (
                        <div className="relative pl-6 pb-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                            {/* Timeline dot - pulsing */}
                            <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-violet-500 ring-4 ring-violet-500/20 animate-pulse" />
                            <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-violet-500/50 to-transparent" />

                            <div className="ml-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-medium text-violet-400 uppercase tracking-wider">Processing</span>
                                    <div className="flex gap-1">
                                        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                                        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                                        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                                    </div>
                                    {/* Cancel button */}
                                    <button
                                        onClick={cancelAnalysis}
                                        disabled={isCancelling}
                                        className="ml-auto px-3 py-1.5 text-[10px] font-bold text-red-400 hover:text-red-300 bg-zinc-900 border border-red-500/40 hover:border-red-500 hover:bg-red-500/10 rounded-md shadow-sm transition-all flex items-center gap-2 disabled:opacity-50 uppercase tracking-wider"
                                        title="Stop analysis"
                                    >
                                        <StopCircle size={14} className={isCancelling ? "animate-spin" : ""} />
                                        {isCancelling ? 'STOPPING...' : 'STOP GENERATING'}
                                    </button>
                                </div>
                                <p className="text-sm text-zinc-300 mt-2 font-medium">{currentActivity}</p>

                                {/* Investigation Chain of Thought Panel */}
                                {investigationProgress && (
                                    <div className="mt-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
                                        {/* Progress Bar */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                                <div
                                                    className={`h - full transition - all duration - 300 ${investigationProgress.confidence.level === 'HIGH' ? 'bg-green-500' :
                                                        investigationProgress.confidence.level === 'MEDIUM' ? 'bg-yellow-500' : 'bg-red-500'
                                                        } `}
                                                    style={{ width: `${investigationProgress.confidence.score}% ` }}
                                                />
                                            </div>
                                            <span className={`text - [10px] font - mono font - bold ${investigationProgress.confidence.level === 'HIGH' ? 'text-green-400' :
                                                investigationProgress.confidence.level === 'MEDIUM' ? 'text-yellow-400' : 'text-red-400'
                                                } `}>
                                                {investigationProgress.confidence.level} ({investigationProgress.confidence.score}%)
                                            </span>
                                        </div>

                                        {/* Stats Row */}
                                        <div className="flex items-center gap-4 text-[10px] text-zinc-400 mb-2">
                                            <span>Step {investigationProgress.iteration}/{investigationProgress.maxIterations}</span>
                                            <span>Phase: {investigationProgress.phase}</span>
                                            <span>Evidence: {investigationProgress.usefulEvidence}</span>
                                        </div>

                                        {/* Hypotheses */}
                                        {investigationProgress.hypotheses.length > 0 && (
                                            <div className="space-y-1">
                                                <div className="text-[10px] font-medium text-zinc-300">Hypotheses:</div>
                                                {investigationProgress.hypotheses.slice(0, 3).map(h => (
                                                    <div key={h.id} className="flex items-center gap-2 text-[10px]">
                                                        <span className={`w - 2 h - 2 rounded - full ${h.status === 'confirmed' ? 'bg-green-500' :
                                                            h.status === 'refuted' ? 'bg-red-500' :
                                                                'bg-yellow-500 animate-pulse'
                                                            } `} />
                                                        <span className={`font - mono ${h.status === 'confirmed' ? 'text-green-400' :
                                                            h.status === 'refuted' ? 'text-red-400 line-through' :
                                                                'text-zinc-300'
                                                            } `}>
                                                            {h.id}: {h.description.slice(0, 50)}{h.description.length > 50 ? '...' : ''}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                <div ref={chatEndRef} />
            </div>

            {/* Side insights panel for phases/hypotheses/coverage/approval/hints */}
            {(phaseTimeline.length > 0 || rankedHypotheses.length > 0 || coverageGaps.length > 0 || approvalContext || agentHints.length > 0 || extendedMode) && (
                <div className="px-4 pb-3 bg-[#16161a] border-t border-white/5">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {extendedMode && (
                            <div className="rounded-lg p-3 border bg-violet-500/10 border-violet-500/30">
                                <div className="text-[10px] font-medium text-zinc-300 mb-1">Mode</div>
                                <div className="text-[11px] text-violet-300">Extended Investigation</div>
                                {(extendedMode.preferred_checks && extendedMode.preferred_checks.length > 0) && (
                                    <div className="text-[11px] text-zinc-300 mt-1">Checks: {extendedMode.preferred_checks.join(', ')}</div>
                                )}
                                {extendedMode.prefer_mcp_tools && (
                                    <div className="text-[11px] text-zinc-300 mt-1">Prefers MCP Tools</div>
                                )}
                            </div>
                        )}
                        {goalVerification && (
                            <div className={`rounded-lg p-3 border ${goalVerification.met ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-rose-500/10 border-rose-500/30'}`}>
                                <div className="text-[10px] font-medium text-zinc-300 mb-1">Goal</div>
                                <div className={`text-[11px] ${goalVerification.met ? 'text-emerald-300' : 'text-rose-300'}`}>
                                    {goalVerification.met ? 'MET' : 'NOT MET'}
                                </div>
                                {goalVerification.reason && (
                                    <div className="text-[11px] text-zinc-300 mt-1">{goalVerification.reason}</div>
                                )}
                                {!goalVerification.met && (
                                    <div className="mt-2">
                                        <button
                                            onClick={() => sendMessage('[EXTEND] Please extend investigation: collect missing signals (nodes/pods/events/resource-usage), try MCP tools if available, broaden command diversity, and re-evaluate hypotheses.')}
                                            className="px-3 py-1.5 text-[11px] rounded-md bg-violet-600/20 border border-violet-500/40 hover:bg-violet-600/30 text-violet-200 transition-all"
                                        >
                                            Extend investigation
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                        {phaseTimeline.length > 0 && (
                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] p-3">
                                <div className="text-[10px] font-medium text-zinc-300 mb-2">Phases</div>
                                <div className="flex flex-wrap gap-1">
                                    {phaseTimeline.map((p, idx) => (
                                        <span key={idx} className="px-2 py-1 text-[10px] rounded-full bg-violet-500/10 border border-violet-500/30 text-violet-300">{p.name}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                        {rankedHypotheses.length > 0 && (
                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] p-3">
                                <div className="text-[10px] font-medium text-zinc-300 mb-2">Hypotheses</div>
                                <ul className="space-y-1">
                                    {rankedHypotheses.map((h, i) => (
                                        <li key={i} className="text-[11px] text-zinc-300">{h.title}{typeof h.confidence === 'number' ? ` (${Math.round(h.confidence * 100)}%)` : ''}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {coverageGaps.length > 0 && (
                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] p-3">
                                <div className="text-[10px] font-medium text-zinc-300 mb-2">Coverage Gaps</div>
                                <ul className="space-y-1">
                                    {coverageGaps.map((c, i) => (<li key={i} className="text-[11px] text-amber-300">{c}</li>))}
                                </ul>
                            </div>
                        )}
                        {approvalContext && (
                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] p-3">
                                <div className="text-[10px] font-medium text-zinc-300 mb-1">Approval Needed</div>
                                {approvalContext.reason && (<div className="text-[11px] text-zinc-300"><span className="text-zinc-400">Reason:</span> {approvalContext.reason}</div>)}
                                {approvalContext.command && (<div className="text-[11px] text-zinc-300 mt-1"><span className="text-zinc-400">Command:</span> <code className="bg-black/40 px-1 rounded">{approvalContext.command}</code></div>)}
                                {approvalContext.risk && (<div className="text-[11px] text-zinc-300 mt-1"><span className="text-zinc-400">Risk:</span> {approvalContext.risk}</div>)}
                                {approvalContext.impact && (<div className="text-[11px] text-zinc-300 mt-1"><span className="text-zinc-400">Impact:</span> {approvalContext.impact}</div>)}
                            </div>
                        )}
                        {agentHints.length > 0 && (
                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] p-3">
                                <div className="text-[10px] font-medium text-zinc-300 mb-2">Hints</div>
                                <ul className="space-y-1">
                                    {agentHints.map((h, i) => (<li key={i} className="text-[11px] text-cyan-300">{h}</li>))}
                                </ul>
                                <div className="mt-2">
                                    <button
                                        onClick={() => sendMessage('[EXTEND] Apply hint and extend: act on emitted hint, expand coverage, use alternate tools, and reassess hypotheses.')}
                                        className="px-3 py-1.5 text-[11px] rounded-md bg-cyan-600/20 border border-cyan-500/40 hover:bg-cyan-600/30 text-cyan-200 transition-all"
                                    >
                                        Apply hint and extend
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Suggested Actions Chips */}
            {suggestedActions.length > 0 && !llmLoading && (
                <div className="px-4 pb-2 flex flex-wrap gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {suggestedActions.map((action, i) => (
                        <button
                            key={i}
                            onClick={() => sendMessage(action)}
                            className="px-3.5 py-1.5 text-xs bg-violet-500/10 border border-violet-500/30 hover:bg-violet-500/20 hover:border-violet-500/50 text-violet-300 rounded-full transition-all flex items-center gap-1.5 group"
                        >
                            <Sparkles size={10} className="text-violet-400 group-hover:animate-pulse" />
                            {action}
                        </button>
                    ))}
                </div>
            )}

            {/* Input */}
            <div className="relative z-20 p-4 bg-[#16161a] border-t border-white/5">
                <form onSubmit={(e) => { e.preventDefault(); sendMessage(userInput); }} className="flex items-center gap-2 p-1.5 bg-white/5 border border-white/10 rounded-full shadow-lg shadow-black/20 backdrop-blur-md focus-within:border-violet-500/30 focus-within:bg-white/10 transition-all duration-300">
                    <input
                        type="text"
                        value={userInput}
                        onChange={(e) => setUserInput(e.target.value)}
                        disabled={llmLoading || !llmStatus?.connected || !!llmStatus?.error}
                        placeholder={(!llmStatus?.connected || !!llmStatus?.error) ? "Setup required to chat..." : "Ask about your cluster..."}
                        className="flex-1 px-4 py-2 bg-transparent border-none text-white text-sm placeholder-zinc-500 focus:outline-none min-w-0 disabled:cursor-not-allowed disabled:text-zinc-600"
                    />
                    <button
                        type="submit"
                        disabled={llmLoading || !userInput.trim() || !llmStatus?.connected || !!llmStatus?.error}
                        className="p-2.5 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-500 text-white transition-all duration-200 shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 disabled:shadow-none hover:scale-105 disabled:hover:scale-100 flex-shrink-0"
                    >
                        <Send size={16} className={llmLoading ? 'animate-pulse' : ''} />
                    </button>
                </form>
            </div>
        </div>
    );

    if (embedded) return panelContent;
    return createPortal(panelContent, document.body);
}
