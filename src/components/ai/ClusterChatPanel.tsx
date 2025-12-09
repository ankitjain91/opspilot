import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Loader2, Send, Sparkles, X, Minimize2, Maximize2, Minus, Settings, ChevronDown, AlertCircle, StopCircle, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LLMConfig, LLMStatus, ClusterHealthSummary } from '../../types/ai';
import { fixMarkdownHeaders } from '../../utils/markdown';
import { loadLLMConfig } from './utils';
import { LLMSettingsPanel } from './LLMSettingsPanel';
import {
    ITERATIVE_SYSTEM_PROMPT, CLAUDE_CODE_SYSTEM_PROMPT, QUICK_MODE_SYSTEM_PROMPT, buildPlanPrompt, buildReflectionPrompt
} from './prompts';
import {
    executeTool, VALID_TOOLS, registerMcpTools, isValidTool, listRegisteredMcpTools
} from './tools';
import {
    ToolOutcome, PlaybookProgress, PlanStep, InvestigationPlan,
    ResourceDiscoveryCache, DEFAULT_ITERATION_CONFIG, isEmptyResult, compressToolHistorySemantic
} from './types';
import {
    extractCommandsFromResponse,
    extractSuggestions,
    extractLearningMetadata,
} from './agentUtils';
import { Playbook } from './playbooks';

// Learning types for investigation recording
interface ToolRecord {
    tool: string;
    args: string | null;
    status: string;
    useful: boolean;
    duration_ms: number;
}

// Helper to record investigation outcome for learning
export async function recordInvestigationForLearning(
    question: string,
    toolHistory: ToolOutcome[],
    confidence: { level: string; score: number },
    hypotheses: Array<{ id: string; description: string; status: string }>,
    rootCause: string | null,
    durationMs: number,
    wasAborted: boolean
) {
    try {
        const toolsUsed: ToolRecord[] = toolHistory.map(t => ({
            tool: t.tool,
            args: t.args || null,
            status: t.status,
            useful: t.useful,
            duration_ms: 0, // Not tracked per-tool currently
        }));

        const resolution = wasAborted ? 'aborted' :
            confidence.level === 'HIGH' ? 'solved' :
                confidence.level === 'MEDIUM' ? 'partial' : 'inconclusive';

        const confirmedHypotheses = hypotheses
            .filter(h => h.status === 'confirmed')
            .map(h => h.description);

        const refutedHypotheses = hypotheses
            .filter(h => h.status === 'refuted')
            .map(h => h.description);

        await invoke('record_investigation_outcome', {
            question,
            toolsUsed,
            resolution,
            rootCause,
            confidenceScore: confidence.score,
            durationMs,
            hypothesesConfirmed: confirmedHypotheses,
            hypothesesRefuted: refutedHypotheses,
        });
        console.log('[Learning] Recorded investigation outcome');
    } catch (err) {
        console.warn('[Learning] Failed to record outcome:', err);
    }
}

// extractSuggestions is now imported from ./agentUtils

const KNOWN_MCP_SERVERS = [
    { name: 'azure-devops', command: 'npx', args: ['-y', '@azure-devops/mcp', 'YOUR_ORG_NAME'], env: {}, connected: false, autoConnect: false },
    { name: 'kubernetes', command: 'uvx', args: ['mcp-server-kubernetes'], env: { KUBECONFIG: '~/.kube/config' }, autoConnect: true },
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

// Cluster-wide AI Chat Panel component - Global floating chat
export function ClusterChatPanel({ onClose, isMinimized, onToggleMinimize }: { onClose: () => void, isMinimized: boolean, onToggleMinimize: () => void }) {
    const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant' | 'tool' | 'claude-code', content: string, toolName?: string, command?: string, isActivity?: boolean, isStreaming?: boolean }>>([]);
    const [userInput, setUserInput] = useState("");
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
                setEmbeddingMessage(`Knowledge base unavailable: ${err}`);
            }
        };

        setupEmbeddingListener();

        return () => {
            if (unlistenFn) unlistenFn();
        };
    }, []);

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
                console.warn(`[MCP] Removing legacy/broken server config: ${s.name}`);
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
                const fullCmdString = `${s.command} ${(s.args || []).join(' ')}`.toLowerCase();
                if (fullCmdString.includes('calc') || fullCmdString.includes('calculator') || s.command === 'open') {
                    console.warn(`[MCP] Purging unsafe command from config: ${s.command} ${(s.args || []).join(' ')}`);
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
                    console.log(`[MCP] Auto-connected to ${s.name}`);
                    connectedCount++;
                } catch (err) {
                    console.warn(`[MCP] Auto-connect failed for ${s.name}:`, err);
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
                // Check Claude Code CLI availability
                const ccStatus = await invoke<{ available: boolean; version: string | null; error: string | null }>("check_claude_code_status");
                setLlmStatus({
                    connected: ccStatus.available,
                    provider: 'claude-code',
                    model: ccStatus.version || 'claude-code-cli',
                    available_models: [],
                    error: ccStatus.error,
                });
            } else {
                const status = await invoke<LLMStatus>("check_llm_status", { config: llmConfig });
                setLlmStatus(status);
            }
        } catch (err) {
            setLlmStatus({
                connected: false,
                provider: llmConfig.provider,
                model: llmConfig.model,
                available_models: [],
                error: String(err),
            });
        } finally {
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
            'GET_NAMESPACE': args ? `📁 Inspecting namespace ${args}...` : '📁 Inspecting namespace...',
            'LIST_FINALIZERS': args ? `🔗 Finding finalizers in ${args}...` : '🔗 Finding stuck finalizers...',
        };
        return toolDescriptions[toolName] || `⚙️ Executing ${toolName}...`;
    };

    // NOTE: Knowledge base search is now triggered BY THE LLM when it decides it's needed
    // via the SEARCH_KNOWLEDGE tool. No automatic pre-search - LLM is the intelligent orchestrator.

    const advancePlaybookProgress = (
        progress: PlaybookProgress | undefined,
        playbook: Playbook | null,
        outcome: ToolOutcome
    ): PlaybookProgress | undefined => {
        if (!progress || !playbook) return progress;
        // Only advance on successful/useful steps (avoid empty/error)
        if (outcome.status !== 'success' && !(outcome.status === 'partial' && outcome.useful)) return progress;

        const expectedStep = playbook.steps[progress.completedSteps];
        if (expectedStep && expectedStep.tool.toUpperCase() === outcome.tool.toUpperCase()) {
            const nextCompleted = progress.completedSteps + 1;
            return {
                ...progress,
                completedSteps: nextCompleted,
                currentStepIndex: Math.min(nextCompleted, playbook.steps.length - 1),
            };
        }
        return progress;
    };

    const getResourceKindFromArgs = (args: string | undefined, defaultKind: string = 'Pod'): string => {
        if (!args) return defaultKind;
        const parts = args.trim().split(/\s+/);
        return parts[0] || defaultKind;
    };

    const runAutoDiscoveryForPlaceholders = async (
        kind: string,
        notes: string[],
        signatures: Set<string>,
        resultsAccumulator?: Array<{ toolName: string; content: string; timestamp: number }>
    ) => {
        const discoverTool = 'LIST_ALL';
        const discoverArgs = kind || 'Pod';
        const signature = `${discoverTool}:${discoverArgs}`;
        if (signatures.has(signature)) return;

        setCurrentActivity(`📊 Auto-discovering ${discoverArgs} names (placeholder detected)...`);
        const { result, command } = await executeTool(discoverTool, discoverArgs);
        setChatHistory(prev => [...prev, { role: 'tool', content: result, toolName: discoverTool, command }]);
        recordToolExecution(notes, signatures, discoverTool, discoverArgs, result);
        if (resultsAccumulator && !result.startsWith('❌') && !result.startsWith('⚠️')) {
            resultsAccumulator.push({ toolName: discoverTool, content: result, timestamp: Date.now() });
        }
    };

    const parsePlanSteps = (text: string): PlanStep[] => {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const steps: PlanStep[] = [];
        const planRegex = /^-?\s*TOOL:\s*([A-Z_]+)(?:\s+(.+?))?(?:\s*\|\s*Reason:\s*(.+))?$/i;
        for (const line of lines) {
            const match = planRegex.exec(line);
            if (match) {
                steps.push({
                    tool: match[1].toUpperCase(),
                    args: match[2],
                    rationale: match[3],
                    status: 'pending',
                });
            }
        }
        return steps;
    };

    const updatePlanProgress = (plan: InvestigationPlan | undefined, outcome: ToolOutcome): InvestigationPlan | undefined => {
        if (!plan) return plan;
        const idx = plan.currentStep;
        if (!plan.steps[idx]) return plan;
        const expected = plan.steps[idx];
        if (expected.tool === outcome.tool && (expected.args ? outcome.args?.startsWith(expected.args) : true)) {
            const updatedSteps = [...plan.steps];
            updatedSteps[idx] = { ...expected, status: 'done' };
            const nextIdx = Math.min(idx + 1, updatedSteps.length);
            return { ...plan, steps: updatedSteps, currentStep: nextIdx };
        }
        return plan;
    };

    const shouldReplanFromEvidence = (content: string): boolean => {
        const triggers = [
            /crashloop|back[-\s]?off|oomkilled/i,
            /pending|unschedul/i,
            /503|504|connection refused|timeout/i,
        ];
        return triggers.some(r => r.test(content));
    };

    const extractResourcesFromResult = (toolName: string, content: string): Array<{ kind: string; namespace: string; name: string }> => {
        const resources: Array<{ kind: string; namespace: string; name: string }> = [];
        const nsNameRegex = /([a-z0-9.-]+)\/([a-z0-9.-]+)/gi;
        let match;
        while ((match = nsNameRegex.exec(content)) !== null) {
            const namespace = match[1];
            const name = match[2];
            if (namespace && name) {
                const kind =
                    toolName === 'LIST_ALL' ? (content.toLowerCase().includes('pod') ? 'Pod' : 'Resource') :
                        toolName === 'FIND_ISSUES' ? 'Pod' : 'Resource';
                resources.push({ kind, namespace, name });
            }
            if (resources.length >= 20) break;
        }
        return resources;
    };

    const suggestResourceFromCache = (cache: ResourceDiscoveryCache, kind: string): string | null => {
        const names = cache.getResourceNames(kind);
        return names.length > 0 ? names[0] : null;
    };

    // Compress long tool history to avoid context overflow
    // Keep last N results detailed, summarize older ones
    const compressToolHistory = (toolResults: string[], keepDetailedCount: number = 3): string => {
        if (toolResults.length <= keepDetailedCount) {
            return toolResults.join('\n\n---\n\n');
        }

        const older = toolResults.slice(0, -keepDetailedCount);
        const recent = toolResults.slice(-keepDetailedCount);

        // Summarize older results (first 200 chars each)
        const olderSummary = older.map((r, i) => {
            const toolMatch = r.match(/^##\s*(\w+)/);
            const toolName = toolMatch ? toolMatch[1] : `Tool ${i + 1}`;
            const content = r.replace(/^##\s*\w+\s*/, '').trim();
            const summary = content.length > 200 ? content.slice(0, 200) + '...' : content;
            return `**${toolName}**: ${summary}`;
        }).join('\n');

        return `=== Earlier Results (summarized) ===\n${olderSummary}\n\n=== Recent Results (detailed) ===\n${recent.join('\n\n---\n\n')}`;
    };

    const SCRATCHPAD_MAX_LINES = 12;
    // Dynamic iteration budget - can be extended for productive investigations
    const MAX_INVESTIGATION_STEPS = DEFAULT_ITERATION_CONFIG.MAX_ITERATIONS;  // 12 max
    const BASE_INVESTIGATION_STEPS = DEFAULT_ITERATION_CONFIG.BASE_ITERATIONS; // 6 base
    const MIN_PRODUCTIVE_TOOLS = DEFAULT_ITERATION_CONFIG.MIN_PRODUCTIVE_TOOLS; // 2 required for progress

    const formatScratchpad = (notes: string[]): string => {
        if (notes.length === 0) return 'No tools executed yet.';
        const recent = notes.slice(-SCRATCHPAD_MAX_LINES);
        const trimmed = recent.map(n => n.length > 200 ? `${n.slice(0, 200)}...` : n);
        return trimmed.join('\n');
    };

    const buildScratchpadEntry = (toolName: string, toolArgs: string | undefined, result: string): string => {
        const firstLine = (result.split('\n').find(l => l.trim()) || '').trim();
        const preview = firstLine.length > 180 ? `${firstLine.slice(0, 180)}...` : firstLine;
        return `- ${toolName}${toolArgs ? ` ${toolArgs}` : ''} → ${preview || 'completed'}`;
    };

    const recordToolExecution = (notes: string[], signatures: Set<string>, toolName: string, toolArgs: string | undefined, result: string) => {
        const signature = `${toolName}:${(toolArgs || '').trim()}`;
        signatures.add(signature);
        if (!result.startsWith('❌') && !result.startsWith('⚠️')) {
            notes.push(buildScratchpadEntry(toolName, toolArgs, result));
        }
    };

    const buildClusterCatalog = (health: ClusterHealthSummary): string => {
        const namespaces = new Set<string>();
        const crashloopPods = health.crashloop_pods.map(p => `${p.namespace}/${p.name}`);
        const unhealthyDeployments = health.unhealthy_deployments.map(d => `${d.namespace}/${d.name}`);
        health.critical_issues.forEach(i => namespaces.add(i.namespace));
        health.warnings.forEach(i => namespaces.add(i.namespace));
        health.crashloop_pods.forEach(p => namespaces.add(p.namespace));
        health.unhealthy_deployments.forEach(d => namespaces.add(d.namespace));

        const nsList = Array.from(namespaces).filter(Boolean).sort();

        const sections = [];
        if (nsList.length > 0) {
            sections.push(`Namespaces: ${nsList.join(', ')}`);
        }
        if (crashloopPods.length > 0) {
            sections.push(`CrashLoop pods (${crashloopPods.length}): ${crashloopPods.slice(0, 20).join(', ')}`);
        }
        if (unhealthyDeployments.length > 0) {
            sections.push(`Unhealthy deployments (${unhealthyDeployments.length}): ${unhealthyDeployments.slice(0, 20).join(', ')}`);
        }
        if (health.critical_issues.length > 0) {
            sections.push(`Critical issues (${health.critical_issues.length}): ${health.critical_issues.slice(0, 15).map(i => `${i.resource_kind} ${i.namespace}/${i.resource_name}`).join(', ')}`);
        }
        return sections.length > 0 ? sections.join('\n') : 'No catalog items extracted yet.';
    };

    // Helper to parse suggested actions from AI response
    const parseSuggestedActions = (text: string): [string, string[]] => {
        const parts = text.split(/SUGGESTED_ACTIONS:/i);
        if (parts.length < 2) return [text.trim(), []];

        const suggestionBlock = parts[1];
        const suggestions = suggestionBlock
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('-'))
            .map(line => line.replace(/^-\s*"|"$|^-\s*/g, '')) // Remove bullets and quotes
            .filter(s => s.length > 0)
            .slice(0, 4); // Limit to 4

        return [parts[0].trim(), suggestions];
    };

    const summarizeFindings = async (
        userMessage: string,
        accumulatedResults: string[],
        scratchpad: string[]
    ): Promise<string> => {
        if (accumulatedResults.length === 0) return '';

        const compressedHistory = compressToolHistory(accumulatedResults, 4);
        const prompt = `=== Investigation Summary ===
User goal: "${userMessage}"

=== Tool Evidence (summarized) ===
${compressedHistory}

=== Scratchpad (executed tools) ===
${formatScratchpad(scratchpad)}

Provide a concise root cause + specific evidence + safe next action (read-only).`;

        return await callLLM(
            prompt,
            ITERATIVE_SYSTEM_PROMPT,
            chatHistory.filter(m => m.role !== 'tool')
        );
    };

    // Filter out internal prompts from user-visible output
    const cleanOutputForUser = (text: string): string => {
        return text
            // Remove === sections that are internal
            .replace(/=== CRITICAL INSTRUCTIONS ===[\s\S]*?(?===|$)/gi, '')
            .replace(/=== KNOWLEDGE BASE[\s\S]*?=== END KNOWLEDGE BASE ===/gi, '')
            .replace(/=== CLUSTER CONTEXT[\s\S]*?=== END CONTEXT ===/gi, '')
            .replace(/=== USER REQUEST[\s\S]*?(?===|$)/gi, '')
            .replace(/=== PRE-EXECUTED[\s\S]*?=== END PRE-EXECUTED[\s\S]*?===/gi, '')
            .replace(/=== RECOMMENDED TOOLS[\s\S]*?=== END RECOMMENDATIONS ===/gi, '')
            // Clean up extra whitespace
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    };

    // Helper to call LLM - routes to Claude Code CLI or regular API
    const callLLM = async (prompt: string, systemPrompt: string, conversationHistory: Array<{ role: string; content: string }>): Promise<string> => {
        if (llmConfig.provider === 'claude-code') {
            // Build conversation context for Claude Code
            const historyStr = conversationHistory
                .slice(-10) // Last 10 messages for context
                .map(m => `${m.role.toUpperCase()}: ${m.content}`)
                .join('\n\n');

            const fullPrompt = historyStr ? `${historyStr}\n\nUSER: ${prompt}` : prompt;

            return await invoke<string>("call_claude_code", {
                prompt: fullPrompt,
                systemPrompt,
            });
        } else {
            return await invoke<string>("call_llm", {
                config: llmConfig,
                prompt,
                systemPrompt,
                conversationHistory,
            });
        }
    };

    // Tool router - quick LLM call to pick the RIGHT tool for a query
    // Returns the tool name and suggested arguments
    const routeToTool = async (query: string, suggestedTools: Array<{ name: string, description: string, confidence: number }>): Promise<{ tool: string, args: string } | null> => {
        // Filter tools with decent confidence (> 0.4)
        const validSuggestions = suggestedTools.filter(t => t.confidence > 0.4);

        // Format suggestions with their relevance/confidence
        const suggestionText = validSuggestions.length > 0
            ? validSuggestions.slice(0, 4).map(t => `- ${t.name} (Relevance: ${(t.confidence * 100).toFixed(0)}%) - ${t.description}`).join('\n')
            : "No specific tool matches found.";

        const toolList = `Available tools:
- CLUSTER_HEALTH: Get overall cluster status (no args)
- FIND_ISSUES: Scan for problems (no args)
- LIST_ALL <kind>: List resources (e.g., LIST_ALL Pod, LIST_ALL Deployment)
- DESCRIBE <kind> <namespace> <name>: Get resource details
- GET_LOGS <namespace> <pod>: Get pod logs
- GET_EVENTS [namespace]: Get cluster events
- GET_CROSSPLANE: Check Crossplane resources (no args)
- GET_ISTIO: Check Istio mesh (no args)
- GET_UIPATH: Check UiPath pods (no args)
- GET_UIPATH_CRD: List CustomerCluster/ManagementCluster CRDs (no args)
- GET_CAPI: Check Cluster API resources (no args)
- GET_CASTAI: Check CAST AI (no args)
- GET_WEBHOOKS: List admission webhooks (no args)
- VCLUSTER_CMD <ns> <vcluster> <kubectl cmd>: Run command inside vCluster
- RUN_KUBECTL <command>: Run arbitrary kubectl command with bash pipes
- LIST_FINALIZERS <namespace>: Find stuck finalizers

Highly Relevant Tools for this query:
${suggestionText}`;

        const routerPrompt = `User wants: "${query}"

${toolList}

Which ONE tool should I use FIRST? Respond with ONLY the tool call in format:
TOOL: <NAME> [args if needed]

Example responses:
- TOOL: GET_UIPATH_CRD
- TOOL: VCLUSTER_CMD taasvstst management-cluster get pods -A
- TOOL: LIST_ALL Pod`;

        try {
            const response = await invoke<string>("call_llm", {
                config: llmConfig,
                prompt: routerPrompt,
                systemPrompt: "You are a tool router. Pick the single best tool for the query. Response format: TOOL: <NAME> [args]",
                conversationHistory: [],
            });

            // Parse the response
            const match = response.match(/TOOL:\s*(\w+)\s*(.*)?/i);
            if (match) {
                return { tool: match[1].toUpperCase(), args: (match[2] || '').trim() };
            }
        } catch (e) {
            console.warn("Tool routing failed:", e);
        }
        return null;
    };

    // Streaming call for Claude Code with terminal-like experience
    const callClaudeCodeStreaming = useCallback(async (prompt: string, systemPrompt: string): Promise<void> => {
        const streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        setCurrentStreamId(streamId);
        setStreamingContent("");
        setIsStreaming(true);

        // Add a streaming message placeholder to chat
        setChatHistory(prev => [...prev, {
            role: 'claude-code',
            content: '',
            isStreaming: true
        }]);

        return new Promise((resolve, reject) => {
            let accumulatedContent = "";

            // Set up event listener
            listen<ClaudeCodeStreamEvent>('claude-code-stream', (event) => {
                const data = event.payload;
                if (data.stream_id !== streamId) return;

                switch (data.event_type) {
                    case 'start':
                        setCurrentActivity("🖥️ Waiting for Claude API response...");
                        // Start a timer to update the message if it takes too long
                        setTimeout(() => {
                            setCurrentActivity(prev =>
                                prev?.includes("Waiting") ? "🖥️ Claude is thinking... (this may take 15-30s)" : prev
                            );
                        }, 5000);
                        break;

                    case 'progress':
                        // Progress updates from Claude CLI (stderr) - show what Claude is doing
                        if (data.content) {
                            const progressText = data.content.trim();
                            // Extract meaningful progress info
                            if (progressText.includes('Running') || progressText.includes('Searching') ||
                                progressText.includes('Reading') || progressText.includes('Executing')) {
                                setCurrentActivity(`🖥️ ${progressText.slice(0, 60)}${progressText.length > 60 ? '...' : ''}`);
                            } else if (progressText.length > 0 && progressText.length < 100) {
                                setCurrentActivity(`🖥️ Claude Code: ${progressText}`);
                            }
                        }
                        break;

                    case 'chunk':
                        accumulatedContent += data.content;
                        setStreamingContent(accumulatedContent);
                        // Update the streaming message in chat history
                        setChatHistory(prev => {
                            const newHistory = [...prev];
                            const lastIndex = newHistory.length - 1;
                            if (lastIndex >= 0 && newHistory[lastIndex].role === 'claude-code') {
                                newHistory[lastIndex] = {
                                    ...newHistory[lastIndex],
                                    content: accumulatedContent,
                                };
                            }
                            return newHistory;
                        });
                        break;

                    case 'done':
                        setIsStreaming(false);
                        setCurrentStreamId(null);
                        // Mark the message as complete
                        setChatHistory(prev => {
                            const newHistory = [...prev];
                            const lastIndex = newHistory.length - 1;
                            if (lastIndex >= 0 && newHistory[lastIndex].role === 'claude-code') {
                                newHistory[lastIndex] = {
                                    ...newHistory[lastIndex],
                                    content: accumulatedContent,
                                    isStreaming: false,
                                };
                            }
                            return newHistory;
                        });
                        if (streamUnlistenRef.current) {
                            streamUnlistenRef.current();
                            streamUnlistenRef.current = null;
                        }
                        resolve();
                        break;

                    case 'error':
                        setIsStreaming(false);
                        setCurrentStreamId(null);
                        setChatHistory(prev => {
                            const newHistory = [...prev];
                            const lastIndex = newHistory.length - 1;
                            if (lastIndex >= 0 && newHistory[lastIndex].role === 'claude-code') {
                                newHistory[lastIndex] = {
                                    ...newHistory[lastIndex],
                                    content: accumulatedContent + `\n\n❌ Error: ${data.content}`,
                                    isStreaming: false,
                                };
                            }
                            return newHistory;
                        });
                        if (streamUnlistenRef.current) {
                            streamUnlistenRef.current();
                            streamUnlistenRef.current = null;
                        }
                        reject(new Error(data.content));
                        break;
                }
            }).then(unlisten => {
                streamUnlistenRef.current = unlisten;
            });

            // Invoke the streaming command
            invoke("call_claude_code_stream", {
                prompt,
                systemPrompt,
                streamId,
            }).catch(err => {
                setIsStreaming(false);
                reject(err);
            });
        });
    }, []);

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
        const investigationStartTime = Date.now();
        const toolResults: Array<{ toolName: string; content: string; timestamp?: number; command?: string }> = [];

        // Helper to finalize response and record learning outcome
        const finalizeAndRecord = (aiResponse: string) => {
            const { cleanedResponse, suggestions } = extractSuggestions(aiResponse);
            setChatHistory(prev => [...prev, { role: 'assistant', content: cleanedResponse }]);
            if (suggestions.length > 0) setSuggestedActions(suggestions);

            // Extract investigation metadata for learning
            const { level, score, rootCause, hypotheses } = extractLearningMetadata(aiResponse);

            // 4. Tool Outcomes
            const recordedHistory: ToolOutcome[] = toolResults.map(r => ({
                tool: r.toolName,
                args: r.toolName === 'RUN_KUBECTL' ? r.content.split('\n')[0] : undefined, // loose heuristic
                result: r.content,
                status: r.content.startsWith('❌') ? 'error' : 'success',
                timestamp: r.timestamp || Date.now(),
                useful: !r.content.startsWith('❌') && !r.content.startsWith('⚠️') && !isEmptyResult(r.content),
                errorMessage: r.content.startsWith('❌') ? r.content : undefined
            }));

            // Record asynchronously
            if (recordedHistory.length > 0 || rootCause) {
                recordInvestigationForLearning(
                    message,
                    recordedHistory,
                    { level, score },
                    hypotheses,
                    rootCause,
                    Date.now() - investigationStartTime,
                    false
                ).catch(err => console.warn('[Learning] Failed to process record:', err));
            }

            setLlmLoading(false);
            setInvestigationProgress(null);
        };
        setCurrentActivity("🧠 Understanding your request...");
        const executedTools = new Set<string>();
        const scratchpadNotes: string[] = [];
        const kbSearchQueries = new Set<string>();
        const resourceCache = new ResourceDiscoveryCache();

        const runKnowledgeSearch = async (query: string) => {
            const trimmed = query.trim();
            const normalized = trimmed.toLowerCase();
            if (!trimmed || trimmed.length < 8 || kbSearchQueries.has(normalized)) return null;

            kbSearchQueries.add(normalized);
            setCurrentActivity(`📚 Searching knowledge base for "${trimmed.slice(0, 80)}"...`);
            const { result, command } = await executeTool('SEARCH_KNOWLEDGE', trimmed);
            setChatHistory(prev => [...prev, { role: 'tool', content: result, toolName: 'SEARCH_KNOWLEDGE', command }]);
            recordToolExecution(scratchpadNotes, executedTools, 'SEARCH_KNOWLEDGE', trimmed, result);
            return { result, command };
        };

        try {
            // For Claude Code, use direct streaming with kubectl access
            if (llmConfig.provider === 'claude-code') {
                // Get cluster health summary for context
                setCurrentActivity("📊 Loading cluster context...");
                const healthSummary = await invoke<ClusterHealthSummary>("get_cluster_health_summary");

                // Build context without the TOOL: instructions (Claude Code uses kubectl directly)
                const clusterContext = `
CLUSTER OVERVIEW:
- Nodes: ${healthSummary.total_nodes} total, ${healthSummary.ready_nodes} ready${healthSummary.not_ready_nodes.length > 0 ? `, NOT READY: ${healthSummary.not_ready_nodes.join(', ')}` : ''}
- Pods: ${healthSummary.total_pods} total, ${healthSummary.running_pods} running, ${healthSummary.pending_pods} pending, ${healthSummary.failed_pods} failed
- Deployments: ${healthSummary.total_deployments} total, ${healthSummary.healthy_deployments} healthy
- Resource Usage: CPU ${healthSummary.cluster_cpu_percent.toFixed(1)}%, Memory ${healthSummary.cluster_memory_percent.toFixed(1)}%

${healthSummary.critical_issues.length > 0 ? `CRITICAL ISSUES (${healthSummary.critical_issues.length}):
${healthSummary.critical_issues.slice(0, 30).map(i => `- [${i.resource_kind}] ${i.namespace}/${i.resource_name}: ${i.message}`).join('\n')}` : 'No critical issues.'}

${healthSummary.warnings.length > 0 ? `WARNINGS (${healthSummary.warnings.length}):
${healthSummary.warnings.slice(0, 30).map(i => `- [${i.resource_kind}] ${i.namespace}/${i.resource_name}: ${i.message}`).join('\n')}` : ''}

${healthSummary.crashloop_pods.length > 0 ? `CRASHLOOPING PODS (${healthSummary.crashloop_pods.length}):
${healthSummary.crashloop_pods.slice(0, 20).map(p => `- ${p.namespace}/${p.name}: ${p.restart_count} restarts, reason: ${p.reason}`).join('\n')}` : ''}

${healthSummary.unhealthy_deployments.length > 0 ? `UNHEALTHY DEPLOYMENTS (${healthSummary.unhealthy_deployments.length}):
${healthSummary.unhealthy_deployments.slice(0, 20).map(d => `- ${d.namespace}/${d.name}: ${d.ready}/${d.desired} ready - ${d.reason}`).join('\n')}` : ''}
`.trim();

                const claudeCodePrompt = `=== CURRENT CLUSTER STATE ===
${clusterContext}

=== USER REQUEST ===
${message}

Investigate using kubectl commands. Remember: READ-ONLY mode - do not run any commands that modify the cluster.`;

                setCurrentActivity("🖥️ Starting Claude Code...");
                await callClaudeCodeStreaming(claudeCodePrompt, CLAUDE_CODE_SYSTEM_PROMPT);
                setLlmLoading(false);
                return;
            }

            // ===== SIMPLE AGENT MODE =====
            // No pre-loading, no tools, no KB - just pure LLM ↔ kubectl execution
            // User asks → LLM responds with kubectl → We execute → LLM analyzes → Repeat

            // Get current kube context for display
            let kubeContext = "unknown";
            try {
                kubeContext = await invoke<string>("get_current_context_name");
            } catch (e) {
                console.warn('[Agent] Could not get kube context:', e);
            }

            const userPrompt = `User: ${message}`;

            setCurrentActivity(`🔍 Investigating in context: ${kubeContext}`);

            const conversation: { role: string; content: string }[] = chatHistory
                .filter(h => h.role === 'user' || (h.role === 'assistant' && !h.isActivity))
                .map(h => ({ role: h.role, content: h.content }));

            // First LLM call - just pass user message, no pre-loaded context
            const firstResponse = await callLLM(userPrompt, QUICK_MODE_SYSTEM_PROMPT, conversation);

            // DEBUG: Log LLM response to see what it's actually returning
            console.log('[Agent] LLM first response:', firstResponse.slice(0, 500));

            // Extract commands using shared utility function (tested)
            const commandsToRun = extractCommandsFromResponse(firstResponse);

            // DEBUG: Log extracted commands
            console.log('[Agent] Commands extracted:', commandsToRun);

            // No commands = casual/knowledge response - just return it
            if (commandsToRun.length === 0) {
                console.log('[Agent] No commands found - returning as-is');
                finalizeAndRecord(firstResponse);
                return;
            }

            // Commands requested - execute them
            // toolResults is defined at the top
            let iterations = 0;
            let unproductiveCount = 0;
            const failedCommands: string[] = []; // Track failed commands to prevent retries
            const executedCommands: string[] = []; // Human-readable list of executed commands
            const executedCommandSignatures = new Set<string>(); // Normalized signatures for dedup
            const MAX_ITERATIONS = 20;
            const MAX_UNPRODUCTIVE = 3; // Stop after 3 unproductive iterations

            // Normalize command signature for consistent duplicate detection
            const normalizeSignature = (tool: string, args?: string): string => {
                const normalizedArgs = (args || '')
                    .trim()
                    .replace(/\s+/g, ' ')  // Collapse whitespace
                    .toLowerCase();
                return `${tool.toUpperCase()}:${normalizedArgs}`;
            };

            // Helper to check if user cancelled
            const isCancelled = () => abortControllerRef.current?.signal.aborted ?? false;

            const runTool = async (tool: string, args?: string): Promise<{ content: string; isError: boolean; isDuplicate: boolean }> => {
                if (isCancelled()) return { content: '[Cancelled]', isError: false, isDuplicate: false };

                // Check for duplicate command using normalized signature
                const cmdSignature = normalizeSignature(tool, args);
                if (executedCommandSignatures.has(cmdSignature)) {
                    console.log('[Agent] Skipping duplicate command:', cmdSignature);
                    unproductiveCount++; // Duplicate counts as unproductive
                    return { content: '[Duplicate - already executed]', isError: false, isDuplicate: true };
                }
                executedCommandSignatures.add(cmdSignature);
                executedCommands.push(`kubectl ${args || tool}`); // Track human-readable command

                const { result, command } = await executeTool(tool, args || '');
                const content = result.length > 4000 ? result.slice(0, 4000) + '\n... (truncated)' : result;

                // Check if this command failed (error indicators)
                const isError = result.toLowerCase().includes('error:') ||
                                result.includes('NotFound') ||
                                result.includes("the server doesn't have a resource type") ||
                                result.includes('command not found') ||
                                result.includes('No resources found');

                if (isError) {
                    failedCommands.push(`${command || args}: ${result.slice(0, 100)}`);
                }

                setChatHistory(prev => [...prev, { role: 'tool', content, toolName: tool, command }]);
                recordToolExecution(scratchpadNotes, executedTools, tool, args, content);
                toolResults.push({ toolName: tool, content, timestamp: Date.now(), command });
                return { content, isError, isDuplicate: false };
            };

            // Execute ONLY the first command from initial response (ONE COMMAND PER TURN rule)
            const firstCmd = commandsToRun[0];
            if (firstCmd) {
                if (isCancelled()) {
                    console.log('[Agent] Cancelled by user');
                    return;
                }
                setCurrentActivity(`⚡ [${kubeContext}] kubectl ${firstCmd.args?.slice(0, 40) || firstCmd.tool}...`);
                await runTool(firstCmd.tool, firstCmd.args);
                iterations++;
            }

            // Check cancellation before LLM analysis
            if (isCancelled()) {
                console.log('[Agent] Cancelled before analysis');
                return;
            }

            // Simple analysis - no tools or KB, just kubectl
            setCurrentActivity(`💬 [${kubeContext}] Analyzing results...`);
            // OPTIMIZATION: Smart context compression - recent results get full content, older get summaries
            const formatResultsForLLM = (results: typeof toolResults, maxRecent = 3, recentSize = 1200, olderSize = 300) => {
                return results.map((t, i) => {
                    const cmd = `$ kubectl ${t.command || t.toolName}`;
                    const isRecent = i >= results.length - maxRecent;
                    const limit = isRecent ? recentSize : olderSize;
                    const content = t.content.length > limit
                        ? t.content.slice(0, limit) + `\n... (${t.content.length - limit} chars truncated)`
                        : t.content;
                    return `${cmd}\n${content}`;
                }).join('\n\n---\n\n');
            };
            const summaryContext = formatResultsForLLM(toolResults);

            // Build explicit lists of what's been done
            const executedList = executedCommands.length > 0
                ? `\n✅ COMMANDS ALREADY EXECUTED (DO NOT REPEAT):\n${executedCommands.map(c => `- ${c}`).join('\n')}\n`
                : '';
            const failedList = failedCommands.length > 0
                ? `\n⛔ FAILED COMMANDS (DO NOT RETRY):\n${failedCommands.map(c => `- ${c}`).join('\n')}\n`
                : '';

            const analyzePrompt = `User asked: "${message}"
${executedList}${failedList}
Results from commands:
${summaryContext}

⚠️ STOP AND CHECK before outputting a command:
1. Is this command in the ALREADY EXECUTED list above? → If yes, DO NOT output it
2. Is the resource type in the FAILED list? → If yes, DO NOT try variations of it
3. Do you have enough info to answer? → If yes, provide **Answer** instead of more commands

If you need more info, output exactly ONE new command:
$ kubectl <your-command-here>

If you have enough info, provide your answer:
**Answer**: [Direct answer]
**Root Cause**: [If troubleshooting]
**Fix**: [What would fix it]`;

            const analysisResponse = await callLLM(analyzePrompt, QUICK_MODE_SYSTEM_PROMPT, conversation);

            // ===== SIMPLE AUTONOMOUS AGENT LOOP =====
            // LLM decides what to do, we execute kubectl, repeat until LLM has answer
            let moreCommands = extractCommandsFromResponse(analysisResponse);

            // No commands = LLM is ready to answer
            if (moreCommands.length === 0) {
                finalizeAndRecord(analysisResponse);
                return;
            }

            // Simple agent loop: execute ONE command → show results to LLM → repeat
            const MAX_AGENT_ITERATIONS = 15;
            while (moreCommands.length > 0 && iterations < MAX_AGENT_ITERATIONS && unproductiveCount < MAX_UNPRODUCTIVE && !isCancelled()) {
                // Execute ONLY ONE command per turn (as per system prompt rules)
                const cmd = moreCommands[0];
                if (iterations >= MAX_AGENT_ITERATIONS || isCancelled()) break;

                setCurrentActivity(`⚡ [${kubeContext}] kubectl ${cmd.args?.slice(0, 40) || cmd.tool}...`);
                const { content, isError, isDuplicate } = await runTool(cmd.tool, cmd.args);
                iterations++;

                // Track unproductive iterations (errors, duplicates, empty results)
                const isUnproductive = isError || isDuplicate || content.trim().length < 50;
                if (isUnproductive) {
                    unproductiveCount++;
                    console.log(`[Agent] Unproductive iteration ${unproductiveCount}/${MAX_UNPRODUCTIVE}`);
                } else {
                    unproductiveCount = 0; // Reset on productive result
                }

                // Check for loop/stall condition
                if (unproductiveCount >= MAX_UNPRODUCTIVE) {
                    console.log('[Agent] Too many unproductive iterations, forcing final answer');
                    break;
                }

                if (isCancelled()) {
                    console.log('[Agent] Cancelled');
                    return;
                }

                // Show LLM all results and ask what's next (with smart compression)
                setCurrentActivity(`🧠 [${kubeContext}] Analyzing...`);
                const allResults = formatResultsForLLM(toolResults);

                // Build explicit lists for this iteration
                const updatedExecutedList = executedCommands.length > 0
                    ? `\n✅ COMMANDS ALREADY EXECUTED (DO NOT REPEAT ANY OF THESE):\n${executedCommands.map(c => `- ${c}`).join('\n')}\n`
                    : '';
                const updatedFailedList = failedCommands.length > 0
                    ? `\n⛔ FAILED COMMANDS (DO NOT RETRY):\n${failedCommands.map(c => `- ${c}`).join('\n')}\n`
                    : '';

                const nextPrompt = `User asked: "${message}"
${updatedExecutedList}${updatedFailedList}
Results from ${iterations} commands:
${allResults}

⚠️ STOP AND CHECK before outputting a command:
1. Is this command in the ALREADY EXECUTED list above? → DO NOT output it
2. Is the resource type in the FAILED list? → DO NOT try variations
3. Have you run ${iterations} commands already? Consider if you have enough info
4. Would this command give you NEW information? → If not, don't run it

If you have enough info, provide your answer NOW:
**Answer**: [Direct answer]
**Root Cause**: [If troubleshooting]
**Fix**: [What would fix it]

If you absolutely need ONE more piece of info:
$ kubectl <new-command-not-in-list-above>`;

                const nextResponse = await callLLM(nextPrompt, QUICK_MODE_SYSTEM_PROMPT, conversation);
                moreCommands = extractCommandsFromResponse(nextResponse);

                // No more commands = LLM has the answer
                if (moreCommands.length === 0) {
                    finalizeAndRecord(nextResponse);
                    return;
                }
            }

            // Max iterations or unproductive loop - ask for final answer
            if (iterations >= MAX_AGENT_ITERATIONS || unproductiveCount >= MAX_UNPRODUCTIVE) {
                const reason = unproductiveCount >= MAX_UNPRODUCTIVE
                    ? `Investigation stalled (${unproductiveCount} unproductive attempts)`
                    : `Reached max iterations (${iterations})`;
                console.log(`[Agent] ${reason}, requesting final answer`);

                setCurrentActivity(`💬 [${kubeContext}] Finalizing...`);
                const allResults = formatResultsForLLM(toolResults, 4, 1000, 200); // More recent, smaller chunks for final
                const finalFailedContext = failedCommands.length > 0
                    ? `\n⛔ Failed commands: ${failedCommands.length}\n`
                    : '';

                const finalPrompt = `User asked: "${message}"

You've run ${iterations} commands. ${reason}.
${finalFailedContext}
Here's everything gathered:
${allResults}

You MUST provide your final answer now. Do NOT output any more commands.
Structure as:
**Answer**: [Direct answer to user's question]
**Root Cause**: [If applicable - what you found]
**Fix**: [What would fix it - describe only]`;
                const finalResponse = await callLLM(finalPrompt, QUICK_MODE_SYSTEM_PROMPT, conversation);
                finalizeAndRecord(finalResponse);
                return;
            }
        } catch (err: any) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Error: ${err}. Check your AI settings or provider connection.` }]);
        } finally {
            setLlmLoading(false);
            setInvestigationProgress(null);
        }
    };

    // If minimized, show just a small pill
    if (isMinimized) {
        return (
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
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    className="ml-1 p-1 rounded-full hover:bg-white/20 text-white/70 hover:text-white transition-all opacity-0 group-hover:opacity-100"
                >
                    <X size={14} />
                </button>
            </div>
        );
    }

    return (
        <div className={`fixed ${isExpanded ? 'inset-4' : 'bottom-4 right-4 w-[480px] h-[640px]'} z-50 flex flex-col bg-gradient-to-b from-[#1a1a2e] to-[#16161a] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 transition-all duration-300 overflow-hidden`}>
            {/* Decorative background effects */}
            <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-purple-500/10 via-fuchsia-500/5 to-transparent pointer-events-none" />
            <div className="absolute -top-24 -right-24 w-48 h-48 bg-purple-500/20 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

            {/* Header */}
            <div className="relative flex items-center justify-between px-4 py-3.5 border-b border-white/5 backdrop-blur-sm">
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-xl blur-sm opacity-60" />
                        <div className="relative p-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500">
                            <Sparkles size={16} className="text-white" />
                        </div>
                    </div>
                    <div>
                        <h3 className="font-semibold text-white text-sm tracking-tight">AI Assistant</h3>
                        <button
                            onClick={() => setShowSettings(true)}
                            className="text-[10px] text-zinc-400 hover:text-zinc-300 flex items-center gap-1.5 transition-colors group"
                        >
                            <div className={`w-1.5 h-1.5 rounded-full ${llmStatus?.connected ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-red-400 shadow-sm shadow-red-400/50'}`} />
                            <span>{llmConfig.provider === 'ollama' ? 'Ollama' : llmConfig.provider === 'openai' ? 'OpenAI' : llmConfig.provider === 'anthropic' ? 'Anthropic' : 'Custom'}</span>
                            <span className="text-zinc-500">•</span>
                            <span className="text-zinc-500 group-hover:text-zinc-400">{llmConfig.model.split(':')[0]}</span>
                            <ChevronDown size={10} className="text-zinc-500" />
                        </button>
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setShowSettings(true)}
                        className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all"
                        title="Settings"
                    >
                        <Settings size={15} />
                    </button>
                    <button
                        onClick={onToggleMinimize}
                        className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all"
                        title="Minimize"
                    >
                        <Minus size={15} />
                    </button>
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all"
                        title={isExpanded ? "Restore" : "Expand"}
                    >
                        {isExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    </button>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-red-500/10 text-zinc-400 hover:text-red-400 transition-all"
                        title="Close"
                    >
                        <X size={15} />
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
                    />
                </div>
            )}

            {/* Messages */}
            <div className="relative flex-1 overflow-y-auto p-4 space-y-4">
                {/* Loading state while checking LLM */}
                {checkingLLM && chatHistory.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-16">
                        <div className="relative">
                            <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-full blur-xl opacity-30 animate-pulse" />
                            <Loader2 className="relative w-10 h-10 animate-spin text-purple-400" />
                        </div>
                        <p className="mt-4 text-sm text-zinc-400 animate-pulse">Connecting to AI...</p>
                    </div>
                )}

                {/* Show setup prompt if LLM not connected */}
                {!checkingLLM && !llmStatus?.connected && chatHistory.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-12 px-6">
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
                    </div>
                )}

                {/* Normal chat welcome screen - only show when LLM is ready */}
                {!checkingLLM && llmStatus?.connected && chatHistory.length === 0 && (
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

                {chatHistory.map((msg, i) => (
                    <div key={i} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                        {/* User Message - Task/Query */}
                        {msg.role === 'user' && (
                            <div className="relative pl-6 pb-4">
                                {/* Timeline dot */}
                                <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-violet-500 ring-4 ring-violet-500/20" />
                                {/* Timeline line */}
                                <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-violet-500/50 to-transparent" />

                                <div className="ml-2">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] font-medium text-violet-400 uppercase tracking-wider">Task</span>
                                    </div>
                                    <div className="bg-gradient-to-br from-violet-600/20 to-fuchsia-600/20 rounded-lg px-3 py-2 border border-violet-500/30">
                                        <p className="text-sm text-white">{msg.content}</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Tool Execution - Agentic Style */}
                        {/* Hide completely failed calls from user - they don't need to see internal errors */}
                        {msg.role === 'tool' && !msg.content.startsWith('❌') && (
                            <div className="relative pl-6 pb-3">
                                {/* Timeline dot - color based on success/error */}
                                <div className={`absolute left - 0 top - 1 w - 3 h - 3 rounded - full ring - 4 ${msg.content.startsWith('❌') ? 'bg-red-500 ring-red-500/20' :
                                    msg.content.startsWith('⚠️') ? 'bg-amber-500 ring-amber-500/20' :
                                        'bg-cyan-500 ring-cyan-500/20'
                                    } `} />
                                {/* Timeline line */}
                                <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-cyan-500/50 to-transparent" />

                                <div className="ml-2 space-y-2">
                                    {/* Tool call header with status */}
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[10px] font-medium text-cyan-400 uppercase tracking-wider">Tool</span>
                                        <span className="text-xs font-mono text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded">{msg.toolName}</span>
                                        {msg.content.startsWith('❌') && <span className="text-[10px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded">FAILED</span>}
                                        {msg.content.startsWith('⚠️') && <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded">WARNING</span>}
                                        {!msg.content.startsWith('❌') && !msg.content.startsWith('⚠️') && (
                                            <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">SUCCESS</span>
                                        )}
                                    </div>

                                    {/* Command - compact */}
                                    {msg.command && (
                                        <code className="text-[11px] text-emerald-400/70 font-mono block truncate">$ {msg.command}</code>
                                    )}

                                    {/* Results - more compact for errors, expandable for success */}
                                    <details className={`group ${msg.content.startsWith('❌') ? '' : 'open'} `} open={!msg.content.startsWith('❌')}>
                                        <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-300 select-none flex items-center gap-1">
                                            <ChevronDown size={10} className="group-open:rotate-0 -rotate-90 transition-transform" />
                                            {msg.content.startsWith('❌') ? 'Show error details' : 'Output'}
                                        </summary>
                                        <div className="bg-[#0d1117] rounded-lg border border-[#21262d] overflow-hidden mt-1">
                                            <div className="px-3 py-2 max-h-[180px] overflow-y-auto">
                                                <ReactMarkdown
                                                    remarkPlugins={[remarkGfm]}
                                                    components={{
                                                        p: ({ children }) => <p className="text-xs text-zinc-300 my-1 leading-relaxed">{children}</p>,
                                                        strong: ({ children }) => <strong className="text-emerald-300 font-semibold">{children}</strong>,
                                                        code: ({ children }) => <code className="text-[11px] bg-black/40 px-1 py-0.5 rounded text-cyan-300 font-mono">{children}</code>,
                                                        pre: ({ children }) => <pre className="text-[11px] bg-black/40 p-2 rounded overflow-x-auto my-1 font-mono text-zinc-300">{children}</pre>,
                                                        ul: ({ children }) => <ul className="text-xs list-none ml-0 my-1 space-y-0.5">{children}</ul>,
                                                        li: ({ children }) => <li className="text-zinc-400 before:content-['•'] before:text-cyan-500 before:mr-2">{children}</li>,
                                                        h2: ({ children }) => <h2 className="text-xs font-semibold text-cyan-300 mt-2 mb-1 uppercase tracking-wider">{children}</h2>,
                                                        table: ({ children }) => <table className="text-xs w-full border-collapse">{children}</table>,
                                                        th: ({ children }) => <th className="text-left text-zinc-400 border-b border-zinc-700 pb-1 pr-4">{children}</th>,
                                                        td: ({ children }) => <td className="text-zinc-300 border-b border-zinc-800 py-1 pr-4">{children}</td>,
                                                    }}
                                                >
                                                    {msg.content}
                                                </ReactMarkdown>
                                            </div>
                                        </div>
                                    </details>
                                </div>
                            </div>
                        )}

                        {/* Assistant Response - Thinking/Analysis */}
                        {msg.role === 'assistant' && (
                            (msg.isActivity || msg.content.includes('🔄 Investigating') || msg.content.includes('Continuing investigation')) ? (
                                <div className="relative pl-6 pb-3">
                                    {/* Timeline dot - pulsing */}
                                    <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-amber-500 ring-4 ring-amber-500/20 animate-pulse" />
                                    {/* Timeline line */}
                                    <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-amber-500/50 to-transparent" />

                                    <div className="ml-2">
                                        <details className="group" open>
                                            <summary className="flex items-center gap-2 cursor-pointer list-none">
                                                <span className="text-[10px] font-medium text-amber-400 uppercase tracking-wider">Reasoning</span>
                                                <Loader2 size={10} className="text-amber-400 animate-spin" />
                                                <ChevronDown size={12} className="text-amber-400/60 ml-auto group-open:rotate-180 transition-transform" />
                                            </summary>
                                            <div className="mt-2 bg-amber-500/5 rounded-lg border border-amber-500/20 px-3 py-2">
                                                <div className="prose prose-invert prose-sm max-w-none text-xs">
                                                    <ReactMarkdown
                                                        remarkPlugins={[remarkGfm]}
                                                        components={{
                                                            p: ({ children }) => <p className="text-[12px] text-zinc-400 my-1 leading-relaxed">{children}</p>,
                                                            strong: ({ children }) => <strong className="text-amber-300 font-semibold">{children}</strong>,
                                                            em: ({ children }) => <em className="text-zinc-500 italic">{children}</em>,
                                                            ul: ({ children }) => <ul className="text-[12px] list-none ml-0 my-1 space-y-0.5">{children}</ul>,
                                                            li: ({ children }) => <li className="text-zinc-400 before:content-['•'] before:text-amber-500 before:mr-1.5">{children}</li>,
                                                            h1: ({ children }) => <h1 className="text-[12px] font-bold text-amber-300 mt-2 mb-1">{children}</h1>,
                                                            h2: ({ children }) => <h2 className="text-[12px] font-bold text-amber-300 mt-2 mb-1">{children}</h2>,
                                                            h3: ({ children }) => <h3 className="text-[12px] font-semibold text-amber-300 mt-1.5 mb-0.5">{children}</h3>,
                                                            code: ({ children }) => <code className="text-[10px] bg-black/30 px-1 py-0.5 rounded text-cyan-300 font-mono">{children}</code>,
                                                        }}
                                                    >
                                                        {msg.content.replace(/\*🔄 Investigating\.\.\.\*|\*🔄 Continuing investigation.*\*$/gm, '').trim()}
                                                    </ReactMarkdown>
                                                </div>
                                            </div>
                                        </details>
                                    </div>
                                </div>
                            ) : (
                                <div className="relative pl-6 pb-4">
                                    {/* Timeline dot */}
                                    <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20" />

                                    <div className="ml-2">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="text-[10px] font-medium text-emerald-400 uppercase tracking-wider">Analysis Complete</span>
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
                                                    {fixMarkdownHeaders(msg.content)}
                                                </ReactMarkdown>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )
                        )}

                        {/* Claude Code Output - Only show when we have content (the activity indicator handles the waiting state) */}
                        {msg.role === 'claude-code' && (msg.content || !msg.isStreaming) && (
                            <div className="relative pl-6 pb-4">
                                {/* Timeline dot */}
                                <div className={`absolute left - 0 top - 1 w - 3 h - 3 rounded - full ${msg.isStreaming ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500'} ring - 4 ring - emerald - 500 / 20`} />

                                <div className="ml-2">
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-[10px] font-medium text-emerald-400 uppercase tracking-wider">
                                            {msg.isStreaming ? 'Claude Code' : 'Analysis Complete'}
                                        </span>
                                        {msg.isStreaming && <Loader2 size={10} className="text-emerald-400 animate-spin" />}
                                        {!msg.isStreaming && <Sparkles size={10} className="text-emerald-400" />}
                                    </div>
                                    <div className="bg-[#0d1117] rounded-lg border border-[#21262d] overflow-hidden">
                                        <div className="px-4 py-3 prose prose-invert prose-sm max-w-none max-h-[500px] overflow-y-auto">
                                            {msg.content && (
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
                                                    {fixMarkdownHeaders(msg.content)}
                                                </ReactMarkdown>
                                            )}
                                            {msg.isStreaming && msg.content && (
                                                <span className="inline-block w-1.5 h-4 bg-emerald-400 animate-pulse ml-0.5" />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                ))}

                {/* Loading State with Cancel Button */}
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
                                        className="ml-auto px-2 py-1 text-[10px] font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 rounded-md border border-red-500/30 hover:border-red-500/50 transition-all flex items-center gap-1 disabled:opacity-50"
                                        title="Stop analysis"
                                    >
                                        <StopCircle size={12} />
                                        {isCancelling ? 'Stopping...' : 'Stop'}
                                    </button>
                                </div>
                                <p className="text-xs text-zinc-500 mt-1">{currentActivity}</p>

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
                    )
                }
                <div ref={chatEndRef} />
            </div >

            {/* Suggested Actions Chips */}
            {suggestedActions.length > 0 && !llmLoading && (
                <div className="px-4 pb-2 flex flex-wrap gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {suggestedActions.map((action, i) => (
                        <button
                            key={i}
                            onClick={() => sendMessage(action)}
                            className="text-xs px-3 py-1.5 bg-violet-500/10 border border-violet-500/30 hover:bg-violet-500/20 hover:border-violet-500/50 text-violet-300 rounded-full transition-all flex items-center gap-1.5 group"
                        >
                            <Sparkles size={10} className="text-violet-400 group-hover:animate-pulse" />
                            {action}
                        </button>
                    ))}
                </div>
            )}

            {/* Input */}
            <div className="relative p-4 bg-gradient-to-t from-[#16161a] to-transparent">
                <form onSubmit={(e) => { e.preventDefault(); sendMessage(userInput); }} className="flex items-center gap-2 p-1.5 bg-white/5 border border-white/10 rounded-full shadow-lg shadow-black/20 backdrop-blur-md focus-within:border-violet-500/30 focus-within:bg-white/10 transition-all duration-300">
                    <input
                        type="text"
                        value={userInput}
                        onChange={(e) => setUserInput(e.target.value)}
                        disabled={llmLoading}
                        placeholder="Ask about your cluster..."
                        className="flex-1 px-4 py-2 bg-transparent border-none text-white text-sm placeholder-zinc-500 focus:outline-none min-w-0"
                    />
                    <button
                        type="submit"
                        disabled={llmLoading || !userInput.trim()}
                        className="p-2.5 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-500 text-white transition-all duration-200 shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 disabled:shadow-none hover:scale-105 disabled:hover:scale-100 flex-shrink-0"
                    >
                        <Send size={16} className={llmLoading ? 'animate-pulse' : ''} />
                    </button>
                </form>

            </div >
        </div >
    );
}
