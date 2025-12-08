import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, Send, Sparkles, X, Minimize2, Maximize2, Minus, Settings, ChevronDown, AlertCircle, StopCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LLMConfig, LLMStatus, ClusterHealthSummary } from '../../types/ai';
import { fixMarkdownHeaders } from '../../utils/markdown';
import { loadLLMConfig } from './utils';
import { LLMSettingsPanel } from './LLMSettingsPanel';
import {
    getContextPrompt, SYSTEM_PROMPT, ITERATIVE_SYSTEM_PROMPT, CLAUDE_CODE_SYSTEM_PROMPT,
    AUTONOMOUS_INVESTIGATION_PROMPT, buildInvestigationPrompt, buildInitialAutonomousPrompt,
    getPlaybookGuidanceForQuery, formatConfidenceDisplay, generateInvestigationSummary, buildPlanPrompt, buildReflectionPrompt
} from './prompts';
import {
    executeTool, sanitizeToolArgs, VALID_TOOLS, registerMcpTools, isValidTool, listRegisteredMcpTools,
    executeToolWithTracking, formatFailedToolsContext, autoCorrectToolArgs, containsPlaceholder,
    getPlaceholderGuidance, executeToolsBatch
} from './tools';
import {
    InvestigationState, ToolOutcome, ToolOutcomeStatus, createInvestigationState, calculateConfidence,
    shouldContinueInvestigation, calculateRemainingBudget, DEFAULT_TIMEOUT_CONFIG,
    DEFAULT_ITERATION_CONFIG, evaluateToolOutcome, ToolCircuitBreaker,
    compressToolHistorySemantic, categorizeError, getRecoverySuggestions,
    groupToolsForParallelExecution, ResourceDiscoveryCache,
    extractHypotheses, extractEvidencePoints, formatHypothesesForPrompt,
    suggestToolsForHypothesis, PlaybookProgress, PlanStep, InvestigationPlan
} from './types';
import { getAlternatives, Playbook } from './playbooks';

// Learning types for investigation recording
interface ToolRecord {
    tool: string;
    args: string | null;
    status: string;
    useful: boolean;
    duration_ms: number;
}

// Helper to record investigation outcome for learning
async function recordInvestigationForLearning(
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

    // Extract keywords from user message for knowledge base search
    const extractKeywords = (message: string): string => {
        // Common Kubernetes-related keywords to look for
        const k8sKeywords = [
            'pod', 'pods', 'deployment', 'deployments', 'service', 'services', 'node', 'nodes',
            'crash', 'crashing', 'crashloop', 'crashloopbackoff', 'error', 'errors', 'failed', 'failing',
            'pending', 'stuck', 'terminating', 'oom', 'oomkilled', 'memory', 'cpu', 'resource',
            'image', 'imagepull', 'imagepullbackoff', 'pull', 'registry', 'secret', 'secrets',
            'configmap', 'volume', 'pvc', 'pv', 'storage', 'mount', 'network', 'networking',
            'dns', 'endpoint', 'endpoints', 'ingress', 'loadbalancer', 'clusterip', 'nodeport',
            'rbac', 'permission', 'forbidden', 'unauthorized', 'serviceaccount', 'role',
            'namespace', 'finalizer', 'finalizers', 'delete', 'deletion', 'scale', 'replica',
            'restart', 'restarts', 'logs', 'events', 'describe', 'health', 'unhealthy', 'ready',
            'notready', 'scheduling', 'schedule', 'taint', 'toleration', 'affinity', 'selector'
        ];

        const words = message.toLowerCase().split(/\s+/);
        const matched = words.filter(w => k8sKeywords.some(kw => w.includes(kw)));

        // If no K8s keywords found
        if (matched.length === 0) {
            // For short queries (< 5 words) without specific K8s terms, skip KB search
            // This prevents "continue", "hello", "fix it" from triggering search
            if (words.length < 5) {
                return '';
            }

            const stopWords = [
                'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'why', 'how', 'when', 'where',
                'which', 'who', 'my', 'your', 'this', 'that', 'it', 'and', 'or', 'but', 'in', 'on',
                'at', 'to', 'for', 'of', 'with', 'by', 'do', 'does', 'did', 'can', 'could', 'should',
                'would', 'will', 'continue', 'investigate', 'investigation', 'checking', 'check',
                'please', 'thanks', 'thank', 'ok', 'okay', 'yes', 'no', 'go', 'ahead', 'next', 'step'
            ];
            const significant = words.filter(w => w.length > 2 && !stopWords.includes(w));

            // If after filtering stop words we have nothing meaningful, return empty
            if (significant.length === 0) return '';

            return significant.slice(0, 4).join(' ');
        }

        return matched.slice(0, 4).join(' ');
    };

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

            // MANDATORY: Always search knowledge base first (for non-Claude Code providers)
            // But only if we have meaningful keywords (skips "continue", "yes", etc)
            const keywords = extractKeywords(message);
            let kbResult = '';

            if (keywords.length > 0) {
                const kbSearch = await runKnowledgeSearch(keywords);
                kbResult = kbSearch?.result || '';
            } else {
                // If no keywords, just log it internally
                console.log("Skipping KB search - no keywords in message:", message);
            }

            // Get cluster health summary once for reuse
            setCurrentActivity("📊 Loading cluster context...");
            const healthSummary = await invoke<ClusterHealthSummary>("get_cluster_health_summary");

            // Generate investigation plan up front
            setCurrentActivity("📝 Drafting investigation plan...");
            let generatedPlan: InvestigationPlan | undefined;
            try {
                const planPrompt = buildPlanPrompt(message, healthSummary, kbResult, '');
                const planAnswer = await callLLM(
                    planPrompt,
                    AUTONOMOUS_INVESTIGATION_PROMPT,
                    chatHistory.filter(m => m.role !== 'claude-code')
                );
                const steps = parsePlanSteps(planAnswer);
                if (steps.length > 0) {
                    generatedPlan = { steps, currentStep: 0, generatedAt: Date.now() };
                    scratchpadNotes.push(`=== Plan ===\n${steps.map((s, i) => `${i + 1}. ${s.tool}${s.args ? ` ${s.args}` : ''} ${s.rationale ? `| ${s.rationale}` : ''}`).join('\n')}`);
                }
            } catch (e) {
                console.warn("Plan generation failed:", e);
            }

            // Get tool suggestions based on semantic match to query
            setCurrentActivity("🔧 Matching relevant tools...");
            interface ToolSuggestion {
                name: string;
                description: string;
                confidence: number;
            }
            let suggestedTools: ToolSuggestion[] = [];
            try {
                suggestedTools = await invoke<ToolSuggestion[]>("suggest_tools_for_query", { query: message });
            } catch (e) {
                console.warn("Tool suggestion failed:", e);
            }

            // START SMART TOOL ROUTING
            let routedToolResult = '';
            // Only route if we have high-confidence matches (> 40%)
            const strongMatches = suggestedTools.filter(t => t.confidence > 0.4);

            if (strongMatches.length > 0) {
                setCurrentActivity("🎯 Routing to best tool...");
                const routed = await routeToTool(message, strongMatches);
                if (routed && isValidTool(routed.tool)) {
                    setCurrentActivity(`🔧 Running ${routed.tool}...`);
                    const { result, command } = await executeTool(routed.tool, routed.args);
                    routedToolResult = `=== PRE-EXECUTED TOOL RESULT ===
Tool: ${routed.tool} ${routed.args}
${command ? `Command: ${command}` : ''}
Result:
${result}
=== END PRE-EXECUTED RESULT ===

`;
                    setChatHistory(prev => [...prev, { role: 'tool', content: result, toolName: routed.tool, command }]);
                    recordToolExecution(scratchpadNotes, executedTools, routed.tool, routed.args, result);

                    // Update discovery cache from routed tool results
                    const discovered = extractResourcesFromResult(routed.tool, result);
                    if (discovered.length > 0) {
                        resourceCache.addResources(routed.tool === 'LIST_ALL' ? (routed.args || 'Resource') : 'Resource', discovered.map(d => ({ ...d, timestamp: Date.now() })));
                    }
                }
            }

            // Get cluster health summary for context (already fetched)
            const context = getContextPrompt(healthSummary);
            const catalog = buildClusterCatalog(healthSummary);

            // Use the autonomous investigation prompt for more aggressive tool usage
            const systemPrompt = AUTONOMOUS_INVESTIGATION_PROMPT;

            // Build tools section for prompt - emphasize RUNNING tools, not explaining them
            const toolsSection = suggestedTools.length > 0
                ? `=== RECOMMENDED STARTING TOOLS ===
${suggestedTools.slice(0, 3).map(t => `• ${t.name}`).join('\n')}

YOU MUST START WITH: TOOL: FIND_ISSUES
Then use DESCRIBE/GET_LOGS with the actual resource names from the results.
=== END RECOMMENDATIONS ===

`
                : `=== ACTION REQUIRED ===
YOU MUST START WITH: TOOL: FIND_ISSUES
This will discover what problems exist in the cluster.
=== END ===

`;

            const mcpTools = listRegisteredMcpTools();
            const mcpSection = mcpTools.length > 0 ? `=== AVAILABLE MCP TOOLS ===
${mcpTools.slice(0, 20).map(t => `• ${t.name} (${t.server}) - ${t.description || 'No description'}`).join('\n')}
=== END MCP TOOLS ===

` : '';

            const scratchpadSection = `=== INVESTIGATION SCRATCHPAD ===
${formatScratchpad(scratchpadNotes)}
=== END SCRATCHPAD ===

`;

            // Include knowledge base results in the prompt
            const finalPrompt = `
=== KNOWLEDGE BASE RESULTS (ALREADY SEARCHED) ===
${kbResult}
=== END KNOWLEDGE BASE ===

${routedToolResult}${toolsSection}${mcpSection}${scratchpadSection}=== CLUSTER CONTEXT ===
${context}
=== END CONTEXT ===

=== CLUSTER CATALOG ===
${catalog}
=== END CATALOG ===

=== USER REQUEST ===
${message}

=== HYPOTHESIS-DRIVEN INVESTIGATION ===
Based on the user's request, form 1-2 initial hypotheses about potential causes.
Then run tools (FIND_ISSUES, DESCRIBE, GET_LOGS, etc.) to gather evidence.

MANDATORY RESPONSE FORMAT:
**Initial Hypotheses:**
- H1: [Most likely cause based on symptoms] → Status: INVESTIGATING
- H2: [Alternative possibility] → Status: INVESTIGATING

**Investigation Plan:**
TOOL: FIND_ISSUES
TOOL: DESCRIBE <kind> <namespace> <name>

=== CRITICAL RULES ===
1. Your FIRST output MUST be actual tool invocations like "TOOL: FIND_ISSUES"
2. MANDATORY START: TOOL: FIND_ISSUES (discovers actual resource names)
3. NEVER use placeholders like [pod-name] - use REAL names from results
4. After FIND_ISSUES, run DESCRIBE/GET_LOGS with actual names found
5. If you only explain without running tools, you are FAILING
6. Track hypothesis status as you gather evidence (INVESTIGATING → CONFIRMED/REFUTED)

Example good response:
**Initial Hypotheses:**
- H1: Pods are crash-looping due to OOM → Status: INVESTIGATING
- H2: Image pull failure blocking deployment → Status: INVESTIGATING

TOOL: FIND_ISSUES
`;

            setCurrentActivity("🤔 Thinking...");
            const answer = await callLLM(
                finalPrompt,
                systemPrompt,
                chatHistory.filter(m => m.role !== 'claude-code')
            );

            // Check for tool usage
            const toolMatches = answer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
            const tools = Array.from(toolMatches);

            // Extract initial hypotheses from first response (used later in investigation loop)
            const initialHypotheses = extractHypotheses(answer, []);

            if (tools.length > 0) {
                // Show initial reasoning before tool execution (filter out raw TOOL: lines, and specific system instructions)
                const initialReasoning = cleanOutputForUser(answer.split(/TOOL:/)[0].trim());
                if (initialReasoning) {
                    setChatHistory(prev => [...prev, {
                        role: 'assistant',
                        content: initialReasoning + '\n\n*🔄 Investigating...*',
                        isActivity: true
                    }]);
                }

                let allToolResults: string[] = [];

                for (const toolMatch of tools) {
                    const toolName = toolMatch[1];
                    let toolArgs: string | undefined = sanitizeToolArgs(toolMatch[2]?.trim());

                    const signature = `${toolName}:${toolArgs || ''}`;
                    if (executedTools.has(signature)) {
                        const skipMsg = `⚠️ Skipping ${toolName}${toolArgs ? ` ${toolArgs}` : ''} (already executed this session).`;
                        setChatHistory(prev => [...prev, { role: 'tool', content: skipMsg, toolName, command: 'Skipped duplicate' }]);
                        continue;
                    }

                    if (!isValidTool(toolName)) {
                        const resultStr = `⚠️ Invalid tool: ${toolName}. Valid tools: ${VALID_TOOLS.join(', ')} + any active MCP tools`;
                        setChatHistory(prev => [...prev, { role: 'tool', content: resultStr, toolName: 'INVALID', command: 'N/A' }]);
                        continue;
                    }

                    console.log(`[Agent] Tool: ${toolName}, Args: "${toolArgs}"`);
                    setCurrentActivity(getToolActivity(toolName, toolArgs));

                    // If required args are missing, auto-discover names instead of emitting usage warnings
                    const missingArgs =
                        (toolName === 'DESCRIBE' && (!toolArgs || toolArgs.split(/\s+/).length < 3)) ||
                        (toolName === 'GET_LOGS' && (!toolArgs || toolArgs.split(/\s+/).length < 2));
                    if (missingArgs) {
                        const kind = getResourceKindFromArgs(toolArgs, 'Pod');
                        const info = `❌ ${toolName} needs actual names (no placeholders, full args). Auto-discovering ${kind}...`;
                        setChatHistory(prev => [...prev, { role: 'tool', content: info, toolName, command: 'Auto-discovery' }]);
                        allToolResults.push(info);
                        await runAutoDiscoveryForPlaceholders(kind, scratchpadNotes, executedTools);
                        continue;
                    }

                    // Validate against placeholders using Regex (skip for SEARCH_KNOWLEDGE)
                    const placeholderRegex = /\[.*?\]|<.*?>|\.\.\./;
                    let autoCorrected = false;

                    if (toolName !== 'SEARCH_KNOWLEDGE' && toolArgs && placeholderRegex.test(toolArgs)) {
                        // Auto-correct for tools that can work without args (list all)
                        if (['GET_EVENTS', 'LIST_ALL', 'TOP_PODS', 'FIND_ISSUES'].includes(toolName)) {
                            console.log(`[Agent] Auto-correcting placeholder in ${toolName} - clearing args`);
                            // For LIST_ALL, keep the resource kind but remove namespace placeholder
                            if (toolName === 'LIST_ALL') {
                                const parts = toolArgs.split(/\s+/);
                                toolArgs = parts[0]; // Keep just the resource kind (Pod, Deployment, etc.)
                            } else {
                                toolArgs = undefined; // Clear the args to list all
                            }
                            autoCorrected = true;
                        } else {
                            // Provide specific guidance based on what they were trying to do
                            let guidance = 'Run TOOL: FIND_ISSUES to see problem resources, or TOOL: LIST_ALL Pod to see all pods.';
                            if (toolName === 'DESCRIBE') {
                                guidance = 'First run TOOL: LIST_ALL Pod (or the resource type you need) to find the exact name.';
                            } else if (toolName === 'GET_LOGS') {
                                guidance = 'First run TOOL: LIST_ALL Pod to find the exact pod name and namespace.';
                            }
                            const toolResult = `❌ PLACEHOLDER ERROR: "${toolArgs}" contains [brackets] or <angles> which are not real names.\n\n👉 ${guidance}\n\nAuto-fixing by discovering real resource names...`;
                            setChatHistory(prev => [...prev, { role: 'tool', content: toolResult, toolName: 'ERROR', command: 'N/A' }]);
                            allToolResults.push(toolResult);

                            // Auto-run discovery to unblock investigation
                            const kind = getResourceKindFromArgs(toolArgs, 'Pod');
                            await runAutoDiscoveryForPlaceholders(kind, scratchpadNotes, executedTools);
                            continue;
                        }
                    }

                    const { result, command } = await executeTool(toolName, toolArgs);

                    let finalResult = result;
                    if (autoCorrected) finalResult += '\n\n⚠️ NOTE: Argument was auto-corrected to list ALL namespaces because a placeholder was detected.';

                    setChatHistory(prev => [...prev, { role: 'tool', content: finalResult, toolName, command }]);
                    recordToolExecution(scratchpadNotes, executedTools, toolName, toolArgs, finalResult);

                    // Only include successful results in AI context
                    if (!finalResult.startsWith('❌') && !finalResult.startsWith('⚠️')) {
                        allToolResults.push(`## ${toolName}\n${finalResult}`);
                    }
                }
                // If every tool attempt failed or had missing args, auto-run FIND_ISSUES to unblock
                const successfulInitial = allToolResults.some(r => !r.startsWith('❌') && !r.startsWith('⚠️'));
                if (!successfulInitial) {
                    const info = '⚠️ All initial TOOL commands failed/missing args. Auto-running FIND_ISSUES to discover real resource names.';
                    setChatHistory(prev => [...prev, { role: 'assistant', content: info, isActivity: true }]);
                    const { result, command } = await executeTool('FIND_ISSUES', undefined);
                    setChatHistory(prev => [...prev, { role: 'tool', content: result, toolName: 'FIND_ISSUES', command }]);
                    recordToolExecution(scratchpadNotes, executedTools, 'FIND_ISSUES', undefined, result);
                    if (!result.startsWith('❌') && !result.startsWith('⚠️')) {
                        allToolResults.push(`## FIND_ISSUES\n${result}`);
                    }
                }

                // =================================================================
                // ENHANCED AUTONOMOUS INVESTIGATION LOOP
                // =================================================================
                // Features:
                // - Proper investigation state tracking
                // - Tool failure feedback to LLM (so it learns from mistakes)
                // - Dynamic iteration budget (extends for productive investigations)
                // - Smart unproductive tracking (not just errors)
                // - Playbook-guided investigation
                // - Timeout handling
                // =================================================================

                // Initialize investigation state
                const investigationState: InvestigationState = createInvestigationState(message);
                investigationState.toolHistory = [];
                investigationState.phase = 'gathering';
                if (generatedPlan) {
                    investigationState.plan = generatedPlan;
                }

                // Apply initial hypotheses if extracted from first response
                if (initialHypotheses.length > 0) {
                    investigationState.hypotheses = initialHypotheses;
                    investigationState.scratchpadNotes.push(
                        `=== Initial Hypotheses ===\n${formatHypothesesForPrompt(initialHypotheses)}`
                    );
                }

                // Get playbook guidance if available
                const { guidance: playbookGuidance, playbook: matchedPlaybook } = getPlaybookGuidanceForQuery(message, healthSummary);
                if (matchedPlaybook) {
                    // Track playbook progress based on tools already executed (in order)
                    const inOrderSteps = matchedPlaybook.steps;
                    let initialCompleted = 0;
                    for (const step of inOrderSteps) {
                        const signature = `${step.tool.toUpperCase()}:`;
                        const hasRun = Array.from(executedTools).some(sig => sig.toUpperCase().startsWith(signature));
                        if (hasRun) {
                            initialCompleted++;
                        } else {
                            break; // require contiguous leading steps to count as completed
                        }
                    }

                    investigationState.playbook = {
                        name: matchedPlaybook.name,
                        totalSteps: matchedPlaybook.steps.length,
                        completedSteps: initialCompleted,
                        currentStepIndex: Math.min(initialCompleted, Math.max(matchedPlaybook.steps.length - 1, 0)),
                    };
                    investigationState.activePlaybook = matchedPlaybook.name;
                } else {
                    investigationState.playbook = undefined;
                    investigationState.activePlaybook = undefined;
                }

                // Pre-populate resource cache from FIND_ISSUES if we ran it
                for (const result of allToolResults) {
                    if (result.includes('FIND_ISSUES') || result.includes('LIST_ALL')) {
                        const resources = extractResourcesFromResult('LIST_ALL', result).map(r => ({ ...r, timestamp: Date.now() }));
                        if (resources.length > 0) {
                            resourceCache.addResources('Resource', resources);
                        }
                    }
                }

                // Track failed tools for feedback loop
                const failedToolOutcomes: ToolOutcome[] = [];

                // Circuit breaker for repeatedly failing tools
                const circuitBreaker = new ToolCircuitBreaker();

                // Accumulate ALL results across iterations for full context
                // Store as objects for semantic compression
                let allAccumulatedResults: Array<{ toolName: string; content: string; timestamp: number }> =
                    allToolResults.map(r => {
                        const match = r.match(/^## (\w+)\n([\s\S]*)$/);
                        return match
                            ? { toolName: match[1], content: match[2], timestamp: Date.now() }
                            : { toolName: 'UNKNOWN', content: r, timestamp: Date.now() };
                    });
                let currentMaxIterations = BASE_INVESTIGATION_STEPS; // Start with base, can extend

                // Investigation timeout
                const investigationStartTime = Date.now();
                const TOTAL_TIMEOUT = DEFAULT_TIMEOUT_CONFIG.TOTAL_INVESTIGATION;

                while (investigationState.iteration < currentMaxIterations) {
                    // Check timeout
                    if (Date.now() - investigationStartTime > TOTAL_TIMEOUT) {
                        setCurrentActivity("⏱️ Investigation timeout - providing best analysis...");
                        const timeoutAnswer = await callLLM(
                            `Investigation timed out after ${Math.round(TOTAL_TIMEOUT / 1000)}s. Based on evidence gathered, provide your best analysis.

Evidence collected:
${compressToolHistorySemantic(allAccumulatedResults, 3, 300)}

Original question: "${message}"`,
                            AUTONOMOUS_INVESTIGATION_PROMPT,
                            chatHistory.filter(m => m.role !== 'tool')
                        );
                        const [cleanedAnswer, actions] = parseSuggestedActions(cleanOutputForUser(timeoutAnswer));
                        setChatHistory(prev => [...prev, { role: 'assistant', content: cleanedAnswer }]);
                        setSuggestedActions(actions);
                        break;
                    }

                    // Calculate confidence and update activity
                    const confidence = calculateConfidence(investigationState);
                    const stepsRemaining = currentMaxIterations - investigationState.iteration;
                    const usefulTools = investigationState.toolHistory.filter(t => t.useful).length;

                    // Update investigation progress for UI visibility
                    setInvestigationProgress({
                        iteration: investigationState.iteration + 1,
                        maxIterations: currentMaxIterations,
                        phase: investigationState.phase,
                        confidence: { level: confidence.level, score: confidence.score },
                        hypotheses: investigationState.hypotheses.map(h => ({
                            id: h.id,
                            description: h.description,
                            status: h.status
                        })),
                        toolsExecuted: investigationState.toolHistory.length,
                        usefulEvidence: usefulTools,
                    });

                    // Early termination only when HIGH confidence AND enough useful evidence
                    if (confidence.level === 'HIGH' && usefulTools >= 3) {
                        setCurrentActivity(`✅ HIGH confidence reached - concluding investigation`);
                        // Let LLM provide final answer
                    }

                    // Enhanced progress visualization
                    const elapsedS = Math.round((Date.now() - investigationStartTime) / 1000);
                    setCurrentActivity(
                        `🧠 Analyzing... (${investigationState.iteration + 1}/${currentMaxIterations}) | ` +
                        `Confidence: ${confidence.level} | Evidence: ${usefulTools} | ${elapsedS}s`
                    );

                    // Build analysis prompt with failed tools context (feedback loop!)
                    const failedToolsContext = formatFailedToolsContext(failedToolOutcomes.slice(-5)); // Last 5 failures
                    // Use semantic compression for better context prioritization
                    const compressedHistory = compressToolHistorySemantic(allAccumulatedResults, 4, 300);

                    const analysisPrompt = buildInvestigationPrompt(
                        message,
                        investigationState,
                        [compressedHistory],
                        failedToolsContext,
                        playbookGuidance
                    );

                    const analysisAnswer = await callLLM(
                        analysisPrompt,
                        AUTONOMOUS_INVESTIGATION_PROMPT,
                        chatHistory.filter(m => m.role !== 'tool')
                    );

                    // Extract and track hypotheses from the response
                    investigationState.hypotheses = extractHypotheses(
                        analysisAnswer,
                        investigationState.hypotheses
                    );

                    // Log hypothesis tracking
                    if (investigationState.hypotheses.length > 0) {
                        const hypothesisSummary = formatHypothesesForPrompt(investigationState.hypotheses);
                        investigationState.scratchpadNotes.push(`=== Hypotheses (iter ${investigationState.iteration + 1}) ===\n${hypothesisSummary}`);
                    }

                    // Reflection: If the AI is stuck or making unproductive moves, force a reflection step.
                    const isLooping = investigationState.toolHistory.length > 5 &&
                        investigationState.toolHistory.slice(-3).every(t => t.tool === investigationState.toolHistory[investigationState.toolHistory.length - 4]?.tool);

                    if (investigationState.unproductiveIterations && investigationState.unproductiveIterations >= 2 || isLooping) {
                        setCurrentActivity("🤔 Reflecting on unproductive investigation...");
                        const reflectionPrompt = buildReflectionPrompt(message, investigationState, allAccumulatedResults);
                        const reflectionAnswer = await callLLM(
                            reflectionPrompt,
                            AUTONOMOUS_INVESTIGATION_PROMPT,
                            chatHistory.filter(m => m.role !== 'tool')
                        );
                        investigationState.scratchpadNotes.push(`=== Reflection (iter ${investigationState.iteration + 1}) ===\n${reflectionAnswer}`);
                        investigationState.unproductiveIterations = 0;
                    }

                    // Check if AI wants more tools
                    const nextToolMatches = analysisAnswer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
                    const nextTools = Array.from(nextToolMatches);

                    // If a playbook is active, prioritize the next playbook step first
                    let prioritizedTools: Array<RegExpExecArray | [string, string, string | undefined]> = nextTools;
                    // Plan-first: run pending plan step if exists
                    if (investigationState.plan && investigationState.plan.currentStep < investigationState.plan.steps.length) {
                        const pendingStep = investigationState.plan.steps[investigationState.plan.currentStep];
                        if (pendingStep && pendingStep.status === 'pending') {
                            const hasPlan = nextTools.find(t => t[1].toUpperCase() === pendingStep.tool.toUpperCase());
                            if (!hasPlan) {
                                prioritizedTools = [
                                    ['TOOL', pendingStep.tool, pendingStep.args],
                                    ...prioritizedTools,
                                ];
                            }
                        }
                    }
                    if (matchedPlaybook && investigationState.playbook) {
                        const nextStep = matchedPlaybook.steps[investigationState.playbook.completedSteps];
                        if (nextStep) {
                            const hasNext = nextTools.find(t => t[1].toUpperCase() === nextStep.tool.toUpperCase());
                            if (!hasNext) {
                                // Prepend the expected playbook step if not already requested
                                prioritizedTools = [
                                    ['TOOL', nextStep.tool, nextStep.args],
                                    ...prioritizedTools,
                                ];
                            }
                        }
                    }

                    if (nextTools.length === 0) {
                        if (confidence.level !== 'HIGH') {
                            // Re-plan with WEB_SEARCH to broaden options instead of stopping
                            try {
                                const recoveryPlanPrompt = buildPlanPrompt(message, healthSummary, kbResult, playbookGuidance);
                                const planAnswer = await callLLM(
                                    recoveryPlanPrompt + '\nInclude WEB_SEARCH for unknown errors.',
                                    AUTONOMOUS_INVESTIGATION_PROMPT,
                                    chatHistory.filter(m => m.role !== 'tool')
                                );
                                const steps = parsePlanSteps(planAnswer);
                                if (steps.length > 0) {
                                    investigationState.plan = { steps, currentStep: 0, generatedAt: Date.now() };
                                    investigationState.scratchpadNotes.push(`=== Plan Refreshed(recovery) ===\n${steps.map((s, i) => `${i + 1}. ${s.tool}${s.args ? ` ${s.args}` : ''}${s.rationale ? ` | ${s.rationale}` : ''}`).join('\n')} `);
                                    continue; // Try executing refreshed plan
                                }
                            } catch (e) {
                                console.warn("Recovery re-plan failed:", e);
                            }
                        }

                        // No more tools - provide final answer
                        investigationState.phase = 'concluding';
                        const [cleanedAnswer, actions] = parseSuggestedActions(cleanOutputForUser(analysisAnswer));
                        setChatHistory(prev => [...prev, { role: 'assistant', content: cleanedAnswer }]);
                        setSuggestedActions(actions);

                        // Record investigation outcome for learning
                        const finalConfidence = calculateConfidence(investigationState);
                        const confirmedH = investigationState.hypotheses.find(h => h.status === 'confirmed');
                        recordInvestigationForLearning(
                            message,
                            investigationState.toolHistory,
                            finalConfidence,
                            investigationState.hypotheses,
                            confirmedH?.description || null,
                            Date.now() - investigationStartTime,
                            false
                        );
                        break;
                    }

                    // Show reasoning before tool execution (with hypothesis status)
                    const reasoningPart = cleanOutputForUser(analysisAnswer.split('TOOL:')[0].trim());
                    const confirmedHypotheses = investigationState.hypotheses.filter(h => h.status === 'confirmed');
                    const hypothesisStatus = confirmedHypotheses.length > 0
                        ? `\n\n✅ * Confirmed: ${confirmedHypotheses[0].description}* `
                        : '';

                    if (reasoningPart) {
                        setChatHistory(prev => [...prev, {
                            role: 'assistant',
                            content: reasoningPart + hypothesisStatus + `\n\n *🔄 Continuing investigation... (${stepsRemaining} steps remaining)* `,
                            isActivity: true
                        }]);
                    }

                    // Execute next tools with enhanced tracking
                    const newToolResults: Array<{ toolName: string; content: string; timestamp: number }> = [];
                    let usefulToolsThisIteration = 0;
                    let failedToolsThisIteration = 0;
                    const iterationEvidence: string[] = [];

                    for (const toolMatch of prioritizedTools) {
                        const toolName = toolMatch[1];
                        const rawArgs = Array.isArray(toolMatch) ? toolMatch[2] : toolMatch[2];
                        let toolArgs = sanitizeToolArgs(rawArgs?.toString().trim());

                        const signature = `${toolName}:${toolArgs || ''} `;
                        if (executedTools.has(signature)) {
                            setChatHistory(prev => [...prev, {
                                role: 'tool',
                                content: `⚠️ Skipping ${toolName}${toolArgs ? ` ${toolArgs}` : ''} (already executed).`,
                                toolName,
                                command: 'Skipped duplicate'
                            }]);
                            continue;
                        }

                        if (!isValidTool(toolName)) {
                            const invalidMsg = `⚠️ Invalid tool: ${toolName}.Valid: ${VALID_TOOLS.slice(0, 5).join(', ')}...`;
                            setChatHistory(prev => [...prev, { role: 'tool', content: invalidMsg, toolName: 'INVALID', command: 'N/A' }]);
                            failedToolsThisIteration++;
                            continue;
                        }

                        // Check circuit breaker - skip tools that are temporarily disabled
                        const circuitCheck = circuitBreaker.canExecute(toolName);
                        if (!circuitCheck.allowed) {
                            setChatHistory(prev => [...prev, {
                                role: 'tool',
                                content: `⚠️ ${circuitCheck.reason} `,
                                toolName,
                                command: 'Circuit breaker open'
                            }]);
                            // Suggest alternatives
                            const alternatives = getAlternatives(toolName, toolArgs);
                            if (alternatives.length > 0) {
                                setChatHistory(prev => [...prev, {
                                    role: 'assistant',
                                    content: `💡 Try alternatives: ${alternatives.slice(0, 3).join(', ')} `,
                                    isActivity: true
                                }]);
                            }
                            continue;
                        }

                        setCurrentActivity(getToolActivity(toolName, toolArgs));

                        // If required args are missing, auto-discover names instead of emitting usage warnings
                        const missingArgs =
                            (toolName === 'DESCRIBE' && (!toolArgs || toolArgs.split(/\s+/).length < 3)) ||
                            (toolName === 'GET_LOGS' && (!toolArgs || toolArgs.split(/\s+/).length < 2));
                        if (missingArgs) {
                            const kind = getResourceKindFromArgs(toolArgs, 'Pod');
                            const cached = suggestResourceFromCache(resourceCache, kind);
                            if (cached) {
                                toolArgs = cached;
                                const info = `✅ Auto - filled ${toolName} with ${cached} from discovery cache.`;
                                setChatHistory(prev => [...prev, { role: 'assistant', content: info, isActivity: true }]);
                            } else {
                                const info = `❌ ${toolName} needs actual names(no placeholders, full args).Auto - discovering ${kind}...`;
                                setChatHistory(prev => [...prev, { role: 'tool', content: info, toolName, command: 'Auto-discovery' }]);

                                // Record in failed tools for feedback loop
                                failedToolOutcomes.push({
                                    tool: toolName,
                                    args: toolArgs,
                                    result: info,
                                    status: 'error',
                                    timestamp: Date.now(),
                                    useful: false,
                                    errorMessage: 'Missing required args',
                                    alternatives: getAlternatives(toolName, toolArgs),
                                });
                                failedToolsThisIteration++;

                                await runAutoDiscoveryForPlaceholders(kind, scratchpadNotes, executedTools, newToolResults);

                                // If the playbook expects this step, re-queue it after discovery
                                if (matchedPlaybook && investigationState.playbook) {
                                    const nextStep = matchedPlaybook.steps[investigationState.playbook.completedSteps];
                                    if (nextStep && nextStep.tool.toUpperCase() === toolName.toUpperCase()) {
                                        prioritizedTools.unshift(['TOOL', nextStep.tool, nextStep.args]);
                                    }
                                }
                                continue;
                            }
                        }

                        // Enhanced placeholder detection with better guidance + auto-discovery
                        if (toolName !== 'SEARCH_KNOWLEDGE' && toolArgs && containsPlaceholder(toolArgs)) {
                            const correction = autoCorrectToolArgs(toolName, toolArgs);

                            if (correction.corrected) {
                                toolArgs = correction.newArgs;
                                console.log(`[Agent] Auto - corrected ${toolName}: ${correction.message} `);
                            } else {
                                // Can't auto-correct - provide specific guidance and auto-discover names
                                const guidance = getPlaceholderGuidance(toolName, toolArgs);
                                const toolResult = `❌ PLACEHOLDER ERROR: "${toolArgs}" is not a real resource name.

                        ${guidance}
                    Auto - fixing by discovering real resource names...`;
                                setChatHistory(prev => [...prev, { role: 'tool', content: toolResult, toolName, command: 'Validation Error' }]);

                                // Record in failed tools for feedback loop
                                failedToolOutcomes.push({
                                    tool: toolName,
                                    args: toolArgs,
                                    result: toolResult,
                                    status: 'error',
                                    timestamp: Date.now(),
                                    useful: false,
                                    errorMessage: 'Placeholder argument',
                                    alternatives: getAlternatives(toolName, toolArgs),
                                });
                                failedToolsThisIteration++;

                                // Auto-run discovery to unblock investigation
                                const kind = getResourceKindFromArgs(toolArgs, 'Pod');
                                await runAutoDiscoveryForPlaceholders(kind, scratchpadNotes, executedTools, newToolResults);

                                // After discovery, if tool requires DESCRIBE/GET_LOGS, auto-queue the playbook step again
                                if (matchedPlaybook && investigationState.playbook) {
                                    const nextStep = matchedPlaybook.steps[investigationState.playbook.completedSteps];
                                    if (nextStep && nextStep.tool.toUpperCase() === toolName.toUpperCase()) {
                                        prioritizedTools.unshift(['TOOL', nextStep.tool, nextStep.args]);
                                    }
                                }
                                continue;
                            }
                        }

                        // Execute tool with outcome tracking and error categorization
                        const { result, outcome, errorCategory, recoverySuggestions } = await executeToolWithTracking(toolName, toolArgs);
                        investigationState.toolHistory.push(outcome);
                        investigationState.plan = updatePlanProgress(investigationState.plan, outcome);
                        investigationState.playbook = advancePlaybookProgress(investigationState.playbook, matchedPlaybook, outcome);

                        setChatHistory(prev => [...prev, { role: 'tool', content: result.result, toolName, command: result.command }]);
                        recordToolExecution(scratchpadNotes, executedTools, toolName, toolArgs, result.result);

                        // Track outcome for iteration evaluation and circuit breaker
                        if (outcome.status === 'error' || outcome.status === 'empty') {
                            failedToolsThisIteration++;
                            failedToolOutcomes.push(outcome);
                            circuitBreaker.recordFailure(toolName); // Update circuit breaker

                            // Enhanced error tracking with categorization
                            const errorInfo = errorCategory
                                ? `FAILED(${errorCategory}): ${toolName} ${toolArgs || ''} → ${outcome.errorMessage || 'empty result'} `
                                : `FAILED: ${toolName} ${toolArgs || ''} → ${outcome.errorMessage || 'empty result'} `;
                            investigationState.scratchpadNotes.push(errorInfo);

                            // Show recovery suggestions for specific error types
                            if (recoverySuggestions && recoverySuggestions.length > 0 && errorCategory !== 'empty_result') {
                                setChatHistory(prev => [...prev, {
                                    role: 'assistant',
                                    content: `💡 ** Recovery suggestion:** ${recoverySuggestions[0]} `,
                                    isActivity: true
                                }]);
                            }
                        } else if (outcome.useful) {
                            usefulToolsThisIteration++;
                            circuitBreaker.recordSuccess(toolName); // Reset circuit breaker
                            newToolResults.push({ toolName, content: result.result, timestamp: Date.now() });

                            // Refresh plan if new evidence suggests a different path
                            if (investigationState.plan && shouldReplanFromEvidence(result.result)) {
                                try {
                                    const replanPrompt = buildPlanPrompt(message, healthSummary, kbResult, playbookGuidance);
                                    const planAnswer = await callLLM(
                                        replanPrompt,
                                        AUTONOMOUS_INVESTIGATION_PROMPT,
                                        chatHistory.filter(m => m.role !== 'claude-code')
                                    );
                                    const steps = parsePlanSteps(planAnswer);
                                    if (steps.length > 0) {
                                        investigationState.plan = { steps, currentStep: 0, generatedAt: Date.now() };
                                        investigationState.scratchpadNotes.push(`=== Plan Refreshed ===\n${steps.map((s, i) => `${i + 1}. ${s.tool}${s.args ? ` ${s.args}` : ''}${s.rationale ? ` | ${s.rationale}` : ''}`).join('\n')} `);
                                    }
                                } catch (e) {
                                    console.warn("Plan refresh failed:", e);
                                }
                            }

                            // Extract key evidence points from tool result
                            const evidencePoints = extractEvidencePoints(result.result, toolName);
                            if (evidencePoints.length > 0) {
                                iterationEvidence.push(...evidencePoints.slice(0, 3));
                                investigationState.scratchpadNotes.push(
                                    `✓ ${toolName} ${toolArgs || ''} → Evidence: ${evidencePoints.slice(0, 2).join('; ')} `
                                );
                                // Attach evidence to active hypotheses
                                for (const h of investigationState.hypotheses.filter(h => h.status === 'investigating')) {
                                    h.evidence.push(...evidencePoints.slice(0, 2));
                                }
                            } else {
                                investigationState.scratchpadNotes.push(
                                    `✓ ${toolName} ${toolArgs || ''} → found useful evidence`
                                );
                            }
                        } else {
                            // Success but not necessarily useful - still record as success
                            circuitBreaker.recordSuccess(toolName);
                            newToolResults.push({ toolName, content: result.result, timestamp: Date.now() });
                        }
                    }

                    // Opportunistic knowledge base search using fresh evidence/hypotheses
                    const evidenceForKb = iterationEvidence.find(e => /error|fail|backoff|oom|denied|timeout|refused|crash/i.test(e))
                        || iterationEvidence[0];
                    if (evidenceForKb) {
                        const kbQuery = evidenceForKb.replace(/^\[[^\]]+\]\s*/, '').slice(0, 140);
                        const kbSearch = await runKnowledgeSearch(kbQuery);
                        if (kbSearch) {
                            newToolResults.push({ toolName: 'SEARCH_KNOWLEDGE', content: kbSearch.result, timestamp: Date.now() });
                        }
                    } else if (investigationState.hypotheses.length > 0) {
                        const investigatingHypo = investigationState.hypotheses.find(h => h.status === 'investigating');
                        if (investigatingHypo) {
                            const kbQuery = investigatingHypo.description.slice(0, 140);
                            const kbSearch = await runKnowledgeSearch(kbQuery);
                            if (kbSearch) {
                                newToolResults.push({ toolName: 'SEARCH_KNOWLEDGE', content: kbSearch.result, timestamp: Date.now() });
                            }
                        }
                    }

                    // Smart unproductive tracking - requires SUBSTANTIAL progress
                    if (usefulToolsThisIteration >= MIN_PRODUCTIVE_TOOLS) {
                        investigationState.consecutiveUnproductive = 0;
                        investigationState.unproductiveIterations = 0;
                        investigationState.phase = 'investigating';

                        // Grant bonus iteration for productive investigation
                        if (investigationState.iteration >= BASE_INVESTIGATION_STEPS - 1 &&
                            currentMaxIterations < MAX_INVESTIGATION_STEPS) {
                            currentMaxIterations = Math.min(currentMaxIterations + 2, MAX_INVESTIGATION_STEPS);
                            setCurrentActivity(`🎯 Productive investigation - extended budget to ${currentMaxIterations} steps`);
                        }
                    } else if (failedToolsThisIteration > 0 && usefulToolsThisIteration === 0) {
                        // All tools failed or returned empty - increment unproductive counter
                        investigationState.consecutiveUnproductive++;
                        investigationState.unproductiveIterations = (investigationState.unproductiveIterations || 0) + 1;

                        if (investigationState.consecutiveUnproductive >= 3) {
                            setCurrentActivity("⚠️ Investigation stalled - trying different approach...");

                            // Generate smart tool suggestions based on hypotheses
                            const smartSuggestions: string[] = [];
                            for (const h of investigationState.hypotheses.filter(h => h.status === 'investigating')) {
                                smartSuggestions.push(...suggestToolsForHypothesis(h));
                            }
                            const uniqueSuggestions = [...new Set(smartSuggestions)].slice(0, 5);
                            const smartSuggestionsText = uniqueSuggestions.length > 0
                                ? `\n\nSMART SUGGESTIONS(based on your hypotheses): \n${uniqueSuggestions.map(s => `TOOL: ${s}`).join('\n')} `
                                : '';

                            // Before giving up, try to recover with a targeted prompt
                            const recoveryPrompt = `Investigation has stalled after ${investigationState.consecutiveUnproductive} unproductive iterations.

FAILED APPROACHES(do NOT repeat):
${formatFailedToolsContext(failedToolOutcomes)}

EVIDENCE GATHERED:
${compressToolHistorySemantic(allAccumulatedResults, 2, 300)}

CURRENT HYPOTHESES:
${formatHypothesesForPrompt(investigationState.hypotheses)}
${smartSuggestionsText}

                    TASK: Either:
                    1. Try a DIFFERENT approach with TOOL: commands(use suggestions above or alternatives)
                    2. If you have ANY evidence, provide a partial analysis with Confidence: LOW

Original question: "${message}"`;

                            const recoveryAnswer = await callLLM(
                                recoveryPrompt,
                                AUTONOMOUS_INVESTIGATION_PROMPT,
                                chatHistory.filter(m => m.role !== 'tool')
                            );

                            // Check if recovery attempt has new tools
                            const recoveryTools = Array.from(recoveryAnswer.matchAll(/TOOL:\s*(\w+)/g));
                            if (recoveryTools.length === 0) {
                                // No recovery possible - provide final answer
                                const [cleanedAnswer, actions] = parseSuggestedActions(cleanOutputForUser(recoveryAnswer));
                                setChatHistory(prev => [...prev, { role: 'assistant', content: cleanedAnswer }]);
                                setSuggestedActions(actions);
                                break;
                            }

                            // Reset for one more try
                            investigationState.consecutiveUnproductive = 1;
                            investigationState.unproductiveIterations = 1;
                        }
                    }

                    // Add new results to accumulated history
                    if (newToolResults.length > 0) {
                        allAccumulatedResults.push(...newToolResults);
                    }

                    investigationState.iteration++;
                }

                // Finalize with a concise summary that cites tool evidence
                if (allAccumulatedResults.length > 0) {
                    // Convert to string format for summarization
                    const resultsAsStrings = allAccumulatedResults.map(r => `## ${r.toolName} \n${r.content} `);
                    const finalSummary = await summarizeFindings(message, resultsAsStrings, scratchpadNotes);
                    if (finalSummary) {
                        const [cleanedAnswer, actions] = parseSuggestedActions(cleanOutputForUser(finalSummary));
                        // Append investigation summary stats
                        const investigationSummaryStats = generateInvestigationSummary(investigationState);
                        const fullAnswer = cleanedAnswer + '\n' + investigationSummaryStats;
                        setChatHistory(prev => [...prev, { role: 'assistant', content: fullAnswer }]);
                        setSuggestedActions(actions);
                    }
                }
            } else {
                const [cleanedAnswer, actions] = parseSuggestedActions(cleanOutputForUser(answer));
                setChatHistory(prev => [...prev, { role: 'assistant', content: cleanedAnswer }]);
                setSuggestedActions(actions);
            }
        } catch (err: any) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Error: ${err}. Check your AI settings or provider connection.` }]);
        } finally {
            setLlmLoading(false);
            setInvestigationProgress(null); // Clear investigation state when done
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
                        <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Ready to Help</h3>
                        <p className="text-sm text-zinc-400 text-center mb-1 max-w-[300px]">Ask me anything about your cluster's health, resources, or issues.</p>
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
