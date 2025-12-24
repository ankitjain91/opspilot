

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Send, Sparkles, X, Minimize2, Maximize2, Minus, Settings, ChevronDown, AlertCircle, StopCircle, RefreshCw, Terminal, CheckCircle2, XCircle, Trash2, Github, Copy, Check, Search, Bug } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, UnlistenFn } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import { ToolMessage } from './chat/ToolMessage';
import { ThinkingMessage } from './chat/ThinkingMessage';
import { InvestigationTimeline } from './chat/InvestigationTimeline';
import { AgentStatusHeader } from './chat/AgentStatusHeader';
import { StreamingProgressCard, AgentPhase, CommandExecution } from './chat/StreamingProgressCard';
import remarkGfm from 'remark-gfm';
import { LLMConfig, LLMStatus, ClusterHealthSummary } from '../../types/ai';
import { fixMarkdownHeaders } from '../../utils/markdown';
import { stripAnsi } from '../../utils/ansi';
import { loadLLMConfig } from './utils';
import { getAgentServerUrl } from '../../utils/config';
import { LLMSettingsPanel } from './LLMSettingsPanel';
import { SearchCodeDialog } from './SearchCodeDialog';
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

import { runAgentLoop, AgentStep, LLMOptions, getClaudeUsage, ClaudeUsageData, getAgentServerStatus, restartServerComponent } from './agentOrchestrator';
import { PlanProgressUI } from './PlanProgressUI';
import { formatFailingPods } from './kubernetesFormatter';
import { KBProgress } from './useSentinel';
import { createJiraIssue, isJiraConnected, formatInvestigationForJira, getJiraIssueUrl, ResourceDebugContext } from '../../utils/jira';
import { useToast } from '../ui/Toast';

// ... (Known MCP Servers constant omitted for brevity, it is unchanged)
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



// Helper to group messages into interactions
function groupMessages(history: any[]) {
    const groups: any[] = [];
    let currentGroup: any = null;

    // Filter function to hide verbose internal reasoning
    const shouldShowAsStep = (msg: any) => {
        // Always show tool executions (actual commands)
        if (msg.role === 'tool') return true;

        // For assistant messages, filter out internal reasoning
        if (msg.role === 'assistant') {
            const content = msg.content || '';
            // Hide verbose internal states
            if (content.includes('PLANNING:') ||
                content.includes('EXECUTING:') ||
                content.includes('REASONING CHAIN') ||
                content.includes('DONE') ||
                content.includes('VERIFIED:') ||
                content.includes('CONTINUE:') ||
                content.includes('SOLVED:') ||
                content.includes('WARN')) {
                return false;
            }
            // Show meaningful thinking/investigation messages
            return msg.isActivity ||
                content.includes('🧠 Thinking') ||
                content.includes('🧠 Supervisor') ||
                content.includes('🔄 Investigating') ||
                content.includes('Continuing investigation');
        }
        return false;
    };

    history.forEach((msg) => {
        if (msg.role === 'user') {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = { type: 'interaction', user: msg, steps: [], answer: null };
        } else if (shouldShowAsStep(msg)) {
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
    resourceContext,
    initialPrompt,
    onPromptHandled,
    kbProgress,
    isHidden = false,
    onProcessingChange
}: {
    onClose?: () => void,
    isMinimized?: boolean,
    onToggleMinimize?: () => void,
    currentContext?: string,
    embedded?: boolean,
    resourceContext?: { kind: string; name: string; namespace: string } & Partial<ResourceDebugContext>,
    initialPrompt?: string | null,
    onPromptHandled?: () => void,
    kbProgress?: KBProgress | null,
    /** When true, the panel is mounted but invisible (for background processing) */
    isHidden?: boolean,
    /** Callback when processing state changes (for background tracking) */
    onProcessingChange?: (isProcessing: boolean) => void
}) {
    const messagesContainerRef = useRef<HTMLDivElement>(null);

    // Trigger auto-investigation if initialPrompt is provided
    useEffect(() => {
        if (initialPrompt && !userInput && !llmLoading) {
            // Wait briefly for mount
            setTimeout(() => {
                sendMessage(initialPrompt);
                if (onPromptHandled) onPromptHandled();
            }, 100);
        }
    }, [initialPrompt]);

    // Unique storage key for resource-specific chats
    const storageKey = resourceContext
        ? `ops-pilot-chat-${resourceContext.namespace}-${resourceContext.kind}-${resourceContext.name}`
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
    const [claudeUsage, setClaudeUsage] = useState<ClaudeUsageData | null>(null);
    const [currentActivity, setCurrentActivity] = useState("Analyzing cluster data...");
    const [isExpanded, setIsExpanded] = useState(false);

    // Notify parent of processing state changes (for background processing)
    useEffect(() => {
        onProcessingChange?.(llmLoading);
    }, [llmLoading, onProcessingChange]);
    const [llmConfig, setLlmConfig] = useState<LLMConfig>(loadLLMConfig);
    const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null);
    const [checkingLLM, setCheckingLLM] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [suggestedActions, setSuggestedActions] = useState<string[]>([]);
    const [fastMode, setFastMode] = useState<boolean>(true); // Default to Fast Mode (true)

    // Connection error state for retry UI
    const [connectionError, setConnectionError] = useState<{ message: string; canRetry: boolean } | null>(null);
    const [retryingConnection, setRetryingConnection] = useState(false);

    // Fetch Claude usage periodically
    useEffect(() => {
        if (llmConfig.provider !== 'claude-code') {
            setClaudeUsage(null);
            return;
        }

        const fetchUsage = async () => {
            const usage = await getClaudeUsage();
            setClaudeUsage(usage);
        };

        fetchUsage();
        const interval = setInterval(fetchUsage, 60000); // Every minute
        return () => clearInterval(interval);
    }, [llmConfig.provider]);

    // Chat State managed above (chatHistory)
    const [investigationPlan, setInvestigationPlan] = useState<InvestigationPlan | null>(null);

    // Persistent Session Thread ID
    const [threadId, setThreadId] = useState<string>(() => {
        const saved = localStorage.getItem('agent_thread_id');
        // Check if crypto global is available (browser context)
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return saved || crypto.randomUUID();
        }
        return saved || 'session-' + Math.random().toString(36).substr(2, 9);
    });

    // Save thread_id to ensure persistence across reloads
    useEffect(() => {
        if (threadId) {
            localStorage.setItem('agent_thread_id', threadId);
        }
    }, [threadId]);

    const handleClearHistory = useCallback(() => {
        setChatHistory([]);
        setInvestigationPlan(null);
        setInvestigationProgress(null);
        setPhaseTimeline([]);
        setRankedHypotheses([]);
        setApprovalContext(null);
        setGoalVerification(null);
        setExtendedMode(null);

        // Rotate thread_id
        let newThreadId = '';
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            newThreadId = crypto.randomUUID();
        } else {
            newThreadId = 'session-' + Math.random().toString(36).substr(2, 9);
        }
        setThreadId(newThreadId);
        localStorage.setItem('agent_thread_id', newThreadId);
    }, []);

    // Retry connection handler
    const handleRetryConnection = useCallback(async () => {
        setRetryingConnection(true);
        setConnectionError(null);
        try {
            // First check status
            const status = await getAgentServerStatus();
            if (!status.available) {
                // Try to start the agent
                await invoke('start_agent');
                // Wait for it to come up
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            // Check status again
            const newStatus = await getAgentServerStatus();
            if (newStatus.available) {
                setChatHistory(prev => [...prev, { role: 'assistant', content: `✅ **Reconnected**: Agent server is now available. You can continue your conversation.` }]);
            } else {
                setConnectionError({
                    message: 'Agent server is still unavailable. Try again or check Settings > Diagnostics.',
                    canRetry: true
                });
            }
        } catch (e) {
            setConnectionError({
                message: `Retry failed: ${e}. Check Settings > Diagnostics for more options.`,
                canRetry: true
            });
        } finally {
            setRetryingConnection(false);
        }
    }, []);

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

    // Ref to hold sendMessage for use in callbacks defined before it
    const sendMessageRef = useRef<(msg: string, context?: string, toolSubset?: string) => void>(() => { });

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
    const [searchingGitHub, setSearchingGitHub] = useState<string | null>(null);
    const [searchDialogState, setSearchDialogState] = useState<{ isOpen: boolean; query: string; groupIdx: number | null }>({
        isOpen: false,
        query: "",
        groupIdx: null
    });

    // Hardware Specs
    const [systemSpecs, setSystemSpecs] = useState<{ cpu_brand: string; total_memory: number; is_apple_silicon: boolean; } | null>(null);

    // Model Download Progress State
    const [downloadProgress, setDownloadProgress] = useState<{ status: string; percent?: number; completed?: number; total?: number } | null>(null);
    const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);

    // Plan execution state (ReAct pattern)
    const [currentPlan, setCurrentPlan] = useState<any[] | null>(null);

    // Streaming progress state for StreamingProgressCard
    const [streamingPhase, setStreamingPhase] = useState<AgentPhase | null>(null);
    const commandHistoryRef = useRef<CommandExecution[]>([]);
    const [planTotalSteps, setPlanTotalSteps] = useState<number>(0);

    // New enriched investigation signals from backend
    const [phaseTimeline, setPhaseTimeline] = useState<Array<{ name: string; timestamp?: string }>>([]);
    const [rankedHypotheses, setRankedHypotheses] = useState<Array<{ title: string; confidence?: number }>>([]);
    const [approvalContext, setApprovalContext] = useState<{ command?: string; reason?: string; risk?: string; impact?: string } | null>(null);
    const [coverageGaps, setCoverageGaps] = useState<Array<string>>([]);
    const [agentHints, setAgentHints] = useState<Array<string>>([]);
    const [goalVerification, setGoalVerification] = useState<{ met: boolean; reason: string } | null>(null);
    const [autoExtendEnabled, setAutoExtendEnabled] = useState<boolean>(true);
    const [extendedMode, setExtendedMode] = useState<{ preferred_checks?: string[]; prefer_mcp_tools?: boolean } | null>(null);

    // GitHub integration state
    const [githubConfigured, setGithubConfigured] = useState<boolean>(false);


    // Helper to generate human-readable command summaries
    const generateCommandSummary = (command: string, output: string): string => {
        if (!output || output.trim() === '') return 'No output';

        const lines = output.split('\n').filter(l => l.trim());

        // Count resources for kubectl get commands
        if (command.includes('get')) {
            const dataLines = lines.filter(l =>
                !l.startsWith('NAME') &&
                !l.startsWith('NAMESPACE') &&
                !l.startsWith('No resources') &&
                l.trim() !== ''
            );
            if (dataLines.length > 0) {
                return `Found ${dataLines.length} resource(s)`;
            }
            if (output.includes('No resources found')) {
                return 'No resources found';
            }
        }

        // Look for errors
        if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
            return 'Command failed - see raw output';
        }

        // Look for CrashLoopBackOff
        if (output.includes('CrashLoopBackOff')) {
            const count = (output.match(/CrashLoopBackOff/g) || []).length;
            return `Found ${count} pod(s) in CrashLoopBackOff`;
        }

        // Default: first non-empty line (truncated)
        const firstLine = lines[0];
        return firstLine ? firstLine.substring(0, 80) + (firstLine.length > 80 ? '...' : '') : 'Command executed';
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

    // Helper to call LLM - routes to Claude Code CLI or regular API
    const callLLM = useCallback(async (
        prompt: string,
        systemPrompt: string,
        conversationHistory: Array<{ role: string; content: string }>,
        options?: LLMOptions
    ): Promise<string> => {
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
            thread_id: threadId, // Pass the persistent thread ID
        });
    }, [llmConfig, threadId]);

    // Fetch MCP tools
    const fetchMcpTools = useCallback(async () => {
        try {
            const tools = await invoke<any[]>("list_mcp_tools");
            registerMcpTools(tools);
        } catch (e) {
            console.error("Failed to list MCP tools:", e);
        }
    }, []);

    // Check LLM Status
    const checkLLMStatus = useCallback(async () => {
        setCheckingLLM(true);
        try {
            let status = await invoke<LLMStatus>("check_llm_status", { config: llmConfig });

            // Check if connection is OK but model is missing
            // Removed ollama specific checks
            setLlmStatus(status);
            setCheckingLLM(false);
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
    }, [llmConfig]);

    // Check LLM status and fetch MCP tools on mount
    useEffect(() => {
        checkLLMStatus();
        fetchMcpTools();
    }, [llmConfig, checkLLMStatus, fetchMcpTools]); // eslint-disable-line react-hooks/exhaustive-deps

    // Check GitHub configuration on mount and when settings close
    useEffect(() => {
        const checkGithubConfig = async () => {
            try {
                const resp = await fetch(`${getAgentServerUrl()}/github-config`);
                if (resp.ok) {
                    const data = await resp.json();
                    setGithubConfigured(data.configured === true);
                }
            } catch {
                setGithubConfigured(false);
            }
        };
        // Re-check when settings panel closes (showSettings goes from true to false)
        if (!showSettings) {
            checkGithubConfig();
        }
    }, [showSettings]);

    // Initialize embedding model and listen for status events
    // ... (Embedding useEffect unchanged)
    useEffect(() => {
        let unlistenFn: UnlistenFn | null = null;
        const setupEmbeddingListener = async () => {
            // ... (existing logic) ...
        };
        // For brevity in this replacement, we assume the existing logic is preserved if we don't touch it.
        // Wait, I am replacing the WHOLE file content from line 1 to 2179 ???
        // NO, the tool description says "The output of this tool call will be the file contents from StartLine to EndLine (inclusive)".
        // But `replace_file_content` replaces a contiguous block.
        // So I must provide the *exact* original content for `TargetContent`.
        // The file is huge. Simple replace is risky if I don't have exact content match.
        // I should use `multi_replace_file_content` or `replace_file_content` on a smaller chunk.
        // The instruction was "Replace global agent:terminal:data listener".
        // The original listener is around lines 358-400.
    }, []);

    // ... (rest of the file)


    // Function to fetch a welcome dad joke from the LLM
    const fetchNewWelcomeJoke = useCallback(async () => {
        if (loadingWelcomeJoke) return;
        setLoadingWelcomeJoke(true);
        try {
            const response = await invoke<string>('llm_chat', {
                messages: [{
                    role: 'user',
                    content: 'Generate ONE short, funny dad joke specifically about Kubernetes, Docker, Helm, or Cloud Native engineering. Just the joke itself, no introduction. Keep it under 100 characters. Include one relevant emoji. Be creative and avoid common ones!'
                }],
                config: llmConfig,
                systemPrompt: 'You are a witty DevOps engineer who loves dad jokes. Respond with ONLY the joke, nothing else. Never repeat the same joke twice.',
                maxTokens: 100,
                thread_id: threadId, // Pass the persistent thread ID
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
                "Why did the developer go broke? Because he used up all his cache! 💸",
                "How do you comfort a JavaScript bug? You console it!  console.log('hugs') 🫂",
                "Why did the SRE cross the road? To get to the other availability zone! 🛣️",
                "What's a pirate's favorite Kubernetes resource? A Deplooyyyyyment! 🏴‍☠️",
                "Why was the computer cold? It left its Windows open! 🥶",
                "Why did the functions stop calling each other? Because they had constant arguments! 😠",
                "What is a cloud engineer's favorite song? 'Killing Me Softly with His Ping' 🎶",
                "Why don't bachelors like Git? They are afraid to commit! 💍",
                "What do you call a networking diagram that implies everything is fine? A lie-agram! 🤥",
                "Why did the database administrator leave his wife? She had one-to-many relationships! 💔",
                "How does a Kubernetes pod introduce itself? 'I'm just a small piece of a bigger deployment!' 👋",
                "Why was the web server shy? It couldn't find its host header! 😳",
                "What did the router say to the doctor? 'It hurts when IP!' 🩺",
                "Why do Java developers wear glasses? Because they don't C#! 👓",
                "What's a Linux user's favorite game? sudo ku! 🧩",
                "Why did the edge server break up with the core server? There was too much latency in the relationship! ⏱️"
            ];
            setWelcomeJoke(fallbacks[Math.floor(Math.random() * fallbacks.length)]);
        }
        setLoadingWelcomeJoke(false);
    }, [llmConfig, loadingWelcomeJoke, threadId]);

    // Search GitHub for code related to the issue
    const initSearchGitHub = useCallback((userQuery: string, answerContent: string, groupIdx: number) => {
        // Extract key terms for initial suggestion
        const extractKeyTerms = (text: string): string[] => {
            const terms: string[] = [];
            const patterns = [
                /(?:error|exception|failed|crash)[\w\s]*?[:]\s*([^\n.]+)/gi,
                /pod[s]?\s+([a-z0-9-]+)/gi,
                /service[s]?\s+([a-z0-9-]+)/gi,
                /deployment[s]?\s+([a-z0-9-]+)/gi,
                /container[s]?\s+([a-z0-9-]+)/gi,
                /image[s]?\s+([a-z0-9.:/-]+)/gi,
                /(?:NullPointer|OutOfMemory|Connection|Timeout|Auth)\w*Exception/gi,
            ];
            for (const pattern of patterns) {
                const matches = text.matchAll(pattern);
                for (const match of matches) {
                    if (match[1]) terms.push(match[1].trim());
                    else if (match[0]) terms.push(match[0].trim());
                }
            }
            return [...new Set(terms)].slice(0, 5);
        };

        const keyTerms = extractKeyTerms(answerContent);
        const initialQuery = keyTerms.length > 0
            ? `${keyTerms.join(', ')}`
            : userQuery.slice(0, 100);

        setSearchDialogState({
            isOpen: true,
            query: initialQuery,
            groupIdx
        });
    }, []);

    const executeSearchGitHub = useCallback(async (query: string) => {
        const { groupIdx } = searchDialogState;
        setSearchDialogState(prev => ({ ...prev, isOpen: false }));

        if (groupIdx === null || searchingGitHub) return;

        setSearchingGitHub(`group-${groupIdx}`);

        const displayMessage = `Searching Codebase for: ${query}`;
        const hiddenInstructions = `Search local repositories for code related to: ${query}\n\nUse restricted local search tools (grep, find) to find relevant code. Do NOT run kubectl.`;

        // Trigger analysis with clean UI message + hidden instructions + tool restrictions
        await sendMessageRef.current(displayMessage, hiddenInstructions, "code_search");

        setSearchingGitHub(null);
    }, [searchDialogState, searchingGitHub]);

    // ... (scrollToBottom, etc.) ...

    // Auto-scroll to bottom
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

    // ... (Existing useEffects for MCP, LLMStatus etc - Omitted for brevity in edit block as they are unchanged) ...


    // ... (helper functions) ...

    const sendMessage = async (message: string, hiddenContext?: string, toolSubset?: string) => {
        if (!message.trim() || llmLoading) return;

        // Create new abort controller for this request
        abortControllerRef.current = new AbortController();

        setChatHistory(prev => [...prev, { role: 'user', content: message }]);
        setUserInput("");
        setLlmLoading(true);
        setSuggestedActions([]);

        // Claude Code mode uses the local terminal instead


        // ===== HIERARCHICAL SUPERVISOR-WORKER AGENT =====
        // Replaces the old single-loop logic with the Orchestrator
        // See: agentOrchestrator.ts for the Supervisor/Scout/Specialist logic
        try {
            setCurrentActivity("🚀 Initializing Supervisor Agent...");

            // Initialize streaming progress UI
            commandHistoryRef.current = [];
            setStreamingPhase({
                phase: 'planning',
                message: 'Creating investigation plan...',
                commandHistory: []
            });

            // Create abort controller for this request
            const controller = new AbortController();
            abortControllerRef.current = controller;

            // Convert chat history to agent context for conversation continuity
            // Pass last 10 messages to maintain good context across app restarts
            const contextHistory: AgentStep[] = chatHistory
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .slice(-10) // Last 10 messages for good context continuity
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
                    `• Namespace: ${resourceContext.namespace} \n` +
                    (resourceContext.phase ? `• Phase: ${resourceContext.phase} \n` : '') +
                    (resourceContext.status ? `• Status: ${resourceContext.status} \n` : '') +
                    `\n` +
                    (resourceContext.conditions ? `• Conditions: ${resourceContext.conditions.map(c => `${c.type}=${c.status}`).join(', ')} \n` : '') +
                    (resourceContext.containerStatuses ? `• Containers: ${resourceContext.containerStatuses.map(c => `${c.name} (${c.state}, restarts: ${c.restartCount})`).join(', ')} \n` : '') +
                    (resourceContext.events ? `• Recent Events: ${resourceContext.events.map(e => `[${e.type}] ${e.reason}: ${e.message}`).join(' | ')} \n` : '') +
                    `\n` +
                    `CRITICAL INSTRUCTIONS: \n` +
                    `1. ALL user queries imply THIS specific resource unless explicitly stated otherwise.\n` +
                    `2. example: "why is it failing?" → check logs / events for ${resourceContext.name}.\n` +
                    `3. example: "show logs" → fetch logs for ${resourceContext.name}.\n` +
                    `4. DO NOT search for other pods or resources unless the user explicitly names them.\n` +
                    `5. If the user asks a general question, answer it in the context of ${resourceContext.name}.\n` +
                    `6. You are "immersed" in this resource. Do not broaden scope unnecessarily.`;

                // Prepend to context as a system-like USER instruction
                contextHistory.unshift({
                    role: 'USER',
                    content: resourceContextMsg
                });
            }





            const result = await runAgentLoop(
                // Current input - combine visible message with hidden context for the agent
                hiddenContext ? `${message.trim()}\n\n${hiddenContext}` : message.trim(),
                // LLM Executor (Brain - Planner/Analyst)
                // Options are passed from agentOrchestrator with role-specific temp/max_tokens
                {
                    callLLM: async (prompt: string, systemPrompt: string, options: any) => {
                        return await callLLM(prompt, systemPrompt, [], options);
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
                                thread_id: threadId, // Pass the persistent thread ID
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
                    // Capture backend suggestions emitted via orchestrator
                    if (msg.startsWith('[SUGGESTIONS]')) {
                        try {
                            const jsonStr = msg.replace('[SUGGESTIONS] ', '').trim();
                            const suggestions = JSON.parse(jsonStr);
                            if (Array.isArray(suggestions)) {
                                setSuggestedActions(suggestions);
                            }
                        } catch (_) {
                            // ignore parse errors
                        }
                    }
                    // Update streaming phase based on progress message
                    const lowerMsg = msg.toLowerCase();
                    if (lowerMsg.includes('reasoning') || lowerMsg.includes('planning') || lowerMsg.includes('translating')) {
                        setStreamingPhase(prev => prev ? { ...prev, phase: 'planning', message: msg } : null);
                    } else if (lowerMsg.includes('analyzing') || lowerMsg.includes('reflecting') || lowerMsg.includes('investigating')) {
                        setStreamingPhase(prev => prev ? { ...prev, phase: 'analyzing', message: msg } : null);
                    } else if (lowerMsg.includes('executing') || lowerMsg.includes('running')) {
                        setStreamingPhase(prev => prev ? { ...prev, phase: 'executing', message: msg } : null);
                    }
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
                                    if (!met && autoExtendEnabled && !llmLoading) {
                                        setTimeout(() => {
                                            if (goalVerification && goalVerification.met) return;
                                            sendMessage('[EXTEND] Extend investigation automatically: collect missing signals, diversify commands, use MCP tools if available, and re-evaluate hypotheses.');
                                        }, 500);
                                    }
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
                            // For Python commands, we don't need to prepend the command as PythonCodeBlock handles it
                            if (command && command.startsWith('python:')) {
                                content = json.output;
                            } else {
                                // ToolMessage component handles command display in header/body.
                                // Don't duplicate it in the content.
                                content = json.output;
                            }

                            // Track command in streaming progress
                            const existingIdx = commandHistoryRef.current.findIndex(c => c.command === json.command && c.status === 'running');

                            if (existingIdx !== -1) {
                                // Update existing running command
                                if (json.output) {
                                    commandHistoryRef.current[existingIdx] = {
                                        ...commandHistoryRef.current[existingIdx],
                                        status: 'success',
                                        output: json.output,
                                        summary: generateCommandSummary(json.command, json.output)
                                    };
                                }
                            } else {
                                // Add new command
                                // If output is empty, it's a 'command_selected' event -> running
                                // If output is present, it's a 'command_output' event -> success (or we missed the start event)
                                const isRunning = !json.output && step.content.includes('"output":""');

                                // Check for exact duplicate (same command, same output, recently added) to prevent strict-mode double-renders
                                const lastCmd = commandHistoryRef.current[commandHistoryRef.current.length - 1];
                                const isDuplicate = lastCmd && lastCmd.command === json.command && lastCmd.output === json.output && (Date.now() - lastCmd.timestamp < 1000);

                                if (!isDuplicate) {
                                    const cmdExecution: CommandExecution = {
                                        command: json.command,
                                        status: isRunning ? 'running' : 'success',
                                        output: json.output,
                                        summary: isRunning ? 'Executing...' : generateCommandSummary(json.command, json.output),
                                        timestamp: Date.now()
                                    };
                                    commandHistoryRef.current.push(cmdExecution);
                                }
                            }

                            setStreamingPhase(prev => prev ? {
                                ...prev,
                                phase: 'executing',
                                message: 'Running kubectl commands...',
                                currentStep: json.command,
                                commandHistory: [...commandHistoryRef.current]
                            } : null);
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

                        // 1. Consolidate consecutive "Thinking" messages (SUPERVISOR)
                        if (step.role === 'SUPERVISOR' && last && last.role === 'assistant' && (last.content.includes('🧠 Thinking') || last.content.includes('🧠 Supervisor'))) {
                            return [
                                ...prev.slice(0, -1),
                                { ...last, content: last.content + "\n\n" + step.content }
                            ];
                        }

                        // 2. Consolidate consecutive Command messages (SCOUT)
                        // If we just added a "Running" command, and now we get the "Output/Success" for the same command, update it.
                        if (step.role === 'SCOUT' && last && last.role === 'tool' && last.command === command) {
                            return [
                                ...prev.slice(0, -1),
                                {
                                    ...last,
                                    content: contentToShow, // Update content with output
                                    // command is same
                                    toolName // Update toolname if changed
                                }
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
                undefined, // onPlanCreated (handled by onPlanUpdate)
                (plan, currentStep, totalSteps) => {
                    // Plan Updated (Live State)
                    setCurrentPlan(plan);
                    setPlanTotalSteps(totalSteps);
                    setInvestigationPlan(prev => {
                        if (!prev) return null;
                        return { ...prev, steps: plan };
                    });

                    // Update streaming phase with progress
                    setStreamingPhase(prev => prev ? {
                        ...prev,
                        stepsCompleted: currentStep,
                        totalSteps: totalSteps,
                        commandHistory: commandHistoryRef.current
                    } : null);
                },
                undefined, // onStepCompleted
                undefined, // onStepFailed
                () => {
                    // Plan complete - clear after a delay
                    setTimeout(() => {
                        setCurrentPlan(null);
                        setPlanTotalSteps(0);
                    }, 3000);
                },
                {
                    thread_id: threadId,
                    fastMode: fastMode,
                    resourceContext: resourceContext ? `${resourceContext.kind}/${resourceContext.name} namespace:${resourceContext.namespace}` : undefined
                } // baseParams
            );

            // Post-process final response to format kubectl output
            let formattedResult = result;

            // Detect if response contains raw kubectl pod list output
            if (result.includes('NAMESPACE') && result.includes('READY') && result.includes('STATUS') && result.includes('RESTARTS')) {
                const formatted = formatFailingPods(result);
                formattedResult = formatted.markdown;
            }

            // Fallback if the agent returned an empty final response
            if (!formattedResult || !String(formattedResult).trim()) {
                const stepsCount = Array.isArray(currentPlan) ? currentPlan.length : 0;
                const toolsUsed = (chatHistory.filter(m => m.role === 'tool').length);
                formattedResult = `Investigation completed, but no final answer was provided.\n\nSummary:\n- Steps executed: ${stepsCount > 0 ? stepsCount : 'n/a'}\n- Tools used: ${toolsUsed}\n\nIf you want me to continue, click Extend investigation or ask a specific follow-up (e.g., 'show warning events' or 'list failing pods').`;
            }

            // Set streaming phase to complete
            setStreamingPhase({
                phase: 'complete',
                message: 'Investigation complete',
                commandHistory: commandHistoryRef.current
            });

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

            // Set streaming phase to error
            setStreamingPhase({
                phase: 'error',
                message: errorMsg || 'An error occurred',
                commandHistory: commandHistoryRef.current
            });

            // Provider-specific error messages
            if (errorMsg.includes("404")) {
                setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ **API Error (404)**: Endpoint not found. Check your base URL and model name in Settings. Current: ${llmConfig.base_url} / ${llmConfig.model}` }]);
            } else if (errorMsg.includes("401") || errorMsg.includes("403") || errorMsg.includes("Unauthorized")) {
                setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ **Authentication Failed**: Check your API key in Settings.` }]);
            } else if (errorMsg.includes("connection") || errorMsg.includes("ECONNREFUSED") || errorMsg.includes("timeout") || errorMsg.includes("Unreachable") || errorMsg.includes("unavailable")) {
                // Set connection error state for retry UI
                setConnectionError({
                    message: `Cannot reach the agent server. It may still be starting up (~10s on first launch).`,
                    canRetry: true
                });
                setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ **Connection Failed**: Cannot reach the agent server. Use the retry button below to reconnect.` }]);
            } else {
                setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Agent error: ${e}` }]);
            }
            setLlmLoading(false);
        } finally {
            setLlmLoading(false);
            setInvestigationProgress(null);
            // Clear streaming phase after a delay to allow user to see final state
            setTimeout(() => setStreamingPhase(null), 3000);
        }
    };

    // Adaptive Knowledge Base: Mark as Solution
    const [markedSolutions, setMarkedSolutions] = useState<Set<number>>(new Set());

    const { showToast } = useToast();

    const handleCreateJiraIssue = async (userInput: string, aiAnswer: string) => {
        try {
            // Build resource debug context from current resourceContext prop
            let debugContext: ResourceDebugContext | undefined;
            if (resourceContext) {
                debugContext = {
                    kind: resourceContext.kind,
                    name: resourceContext.name,
                    namespace: resourceContext.namespace,
                };
            }

            // Extract any tool outputs/commands from the conversation for additional context
            const recentToolOutputs = chatHistory
                .filter(msg => msg.role === 'tool' && msg.content)
                .slice(-5) // Last 5 tool outputs
                .map(msg => {
                    const name = msg.toolName || 'tool';
                    const output = msg.content.slice(0, 500); // Truncate long outputs
                    return `[${name}]: ${output}${msg.content.length > 500 ? '...' : ''}`;
                })
                .join('\n\n');

            // Include tool outputs in findings if available
            let enhancedFindings = aiAnswer;
            if (recentToolOutputs) {
                enhancedFindings += `\n\nh3. Tool Outputs from Investigation\n{code}\n${recentToolOutputs}\n{code}`;
            }

            // Create title with resource context if available
            const titlePrefix = resourceContext
                ? `[${resourceContext.kind}/${resourceContext.name}]`
                : '[AI Analysis]';
            const titleSummary = userInput.slice(0, 50) + (userInput.length > 50 ? '...' : '');

            const jiraInput = formatInvestigationForJira(
                `${titlePrefix} ${titleSummary}`,
                `User Question: ${userInput}`,
                enhancedFindings,
                currentContext,
                debugContext
            );

            showToast('Creating JIRA issue...', 'info');
            const issue = await createJiraIssue(jiraInput);
            const url = getJiraIssueUrl(issue.key);

            showToast(
                <div className="flex flex-col gap-1">
                    <span>JIRA issue created: {issue.key}</span>
                    {url && (
                        <a href={url} target="_blank" rel="noreferrer" className="text-cyan-400 underline text-[10px]">
                            View in JIRA
                        </a>
                    )}
                </div>,
                "success"
            );
        } catch (err) {
            console.error('Failed to create JIRA issue:', err);
            showToast(`Failed to create JIRA issue: ${err}`, 'error');
        }
    };

    const handleMarkSolution = async (index: number, query: string, solution: string) => {
        if (markedSolutions.has(index)) return;

        try {
            await fetch(`${getAgentServerUrl()}/knowledge/solution`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
                    solution,
                    kube_context: currentContext || undefined
                })
            });
            setMarkedSolutions(prev => {
                const newSet = new Set(prev);
                newSet.add(index);
                return newSet;
            });
        } catch (e) {
            console.error("Failed to mark solution:", e);
        }
    };

    // Keep ref updated so searchGitHub can call it
    sendMessageRef.current = sendMessage;

    // Handle User Approval/Denial
    const handleApproval = async (approved: boolean) => {
        if (!approvalContext) return;

        // 1. Update UI state immediately
        const prevContext = approvalContext;
        setApprovalContext(null);

        setChatHistory(prev => [...prev, {
            role: 'assistant',
            content: approved
                ? `✅ **Approved**: Executing \`${prevContext.command || 'action'}\`...`
                : `❌ **Denied**: Cancelled \`${prevContext.command || 'action'}\`.`
        }]);

        // If denied, we define the behavior (usually just stop, or verify.py handles denied state if we proceed)
        // With backend-only agent, we MUST call back with approved=False if we want the graph to know.

        setLlmLoading(true);
        setCurrentActivity(approved ? "🚀 Executing approved action..." : "🛑 Processing denial...");

        try {
            // Re-enter the agent loop with the approved flag
            // We reuse the existing executors logic from sendMessage
            await runAgentLoop(
                approved ? "User approved execution." : "User declined execution.",
                // LLM Executor
                {
                    callLLM: async (prompt: string, systemPrompt: string, options: any) => {
                        return await invoke('call_llm', {
                            model: options?.model || 'opspilot-brain',
                            prompt,
                            systemPrompt,
                            temperature: options?.temperature || 0.7,
                            thread_id: threadId,
                        });
                    },
                    callLLMStream: async () => { }
                },
                // Fast Executor
                async (prompt: string, systemPrompt: string, options: any) => {
                    // Fallback to brain model logic if no executor
                    const config = llmConfig.executor_model ? { ...llmConfig, model: llmConfig.executor_model } : llmConfig;
                    return await invoke<string>("call_llm", {
                        config,
                        prompt,
                        systemPrompt,
                        conversationHistory: [],
                        thread_id: threadId,
                    });
                },
                // Progress
                (msg) => setCurrentActivity(msg),
                // Step
                (step) => {
                    // Reuse step handling logic partially? 
                    // To avoid code duplication we should extract this, but for now we simplify:
                    // We only care about displaying main output or new approvals
                    setChatHistory(prev => {
                        // ... simplistic append ...
                        return [...prev, {
                            role: step.role === 'SUPERVISOR' ? 'assistant' : 'tool',
                            content: step.role === 'SUPERVISOR' ? `🧠 ${step.content}` : step.content
                        }];
                    });

                    // IMPORTANT: We need to parse backend events too (like done, or another approval)
                    // The runAgentLoop calls this callback with structured events too?
                    // Actually runAgentLoop in agentOrchestrator handles the parsing and calls onStep with simplified content.
                    // BUT it calls onApprovalRequired separately if we pass it!
                },
                [], // context history (not critical for resume)
                abortControllerRef.current?.signal,
                currentContext,
                { endpoint: llmConfig.base_url, provider: llmConfig.provider, model: llmConfig.model },
                listRegisteredMcpTools(),
                undefined,
                (plan, currentStep, totalSteps) => {
                    setCurrentPlan(plan);
                    setPlanTotalSteps(totalSteps);
                },
                undefined,
                undefined,
                () => {
                    setTimeout(() => setCurrentPlan(null), 3000);
                },
                {
                    thread_id: threadId,
                    approved: approved,
                    onApprovalRequired: (context) => {
                        setApprovalContext(context);
                        setChatHistory(prev => [...prev, { role: 'assistant', content: `🚨 **Approval Needed**: ${context.reason}` }]);
                    }
                }
            );
        } catch (e: any) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Error during execution: ${e.message}` }]);
        } finally {
            setLlmLoading(false);
            setCurrentActivity("");
        }
    };

    // If hidden (for background processing), don't render any visible UI
    // The component stays mounted to continue processing
    if (isHidden) {
        return null;
    }

    // If minimized, show just a small pill (only if not embedded) - Elegant Apple Style
    if (isMinimized && !embedded) {
        return createPortal(
            <div
                onClick={onToggleMinimize}
                className="fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-2.5 bg-zinc-900/80 border border-white/10 rounded-2xl shadow-xl cursor-pointer transition-all duration-200 group hover:bg-zinc-800/80 hover:border-white/15 backdrop-blur-2xl"
            >
                <div className="relative">
                    <Sparkles size={16} className="text-indigo-400" />
                    <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                </div>
                <span className="text-zinc-200 font-medium text-sm">AI Assistant</span>
                {chatHistory.length > 0 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-zinc-400 font-medium">{chatHistory.filter(m => m.role === 'assistant').length}</span>
                )}
                <button
                    onClick={(e) => { e.stopPropagation(); onClose?.(); }}
                    className="ml-1 p-1.5 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-zinc-300 transition-all"
                >
                    <X size={14} />
                </button>
            </div>,
            document.body
        );
    }

    const panelContent = (
        <div className={embedded
            ? "flex flex-col h-full w-full bg-zinc-950 border-l border-white/5 relative overflow-hidden"
            : `fixed ${isExpanded ? 'inset-4' : 'bottom-4 right-4 w-[480px] h-[640px]'} z-50 flex flex-col bg-zinc-900/95 border border-white/10 rounded-2xl shadow-2xl transition-all duration-300 overflow-hidden backdrop-blur-2xl`
        }>
            {/* Subtle gradient background */}
            <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />

            {/* Header - Elegant Apple Style */}
            <div className="relative z-50 flex items-center justify-between px-4 py-3 border-b border-white/5 bg-white/[0.02] shrink-0 backdrop-blur-xl">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="relative shrink-0">
                        <div className="p-2 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600">
                            <Sparkles size={14} className="text-white" />
                        </div>
                    </div>
                    <div className="min-w-0">
                        <h3 className="font-semibold text-zinc-100 text-sm tracking-tight truncate">AI Assistant</h3>
                        <div className="flex items-center gap-2 flex-wrap">
                            <button
                                onClick={() => setShowSettings(true)}
                                className="text-[10px] text-zinc-500 hover:text-zinc-400 flex items-center gap-1.5 transition-colors group"
                            >
                                <div className={`w-1.5 h-1.5 rounded-full ${llmStatus?.connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
                                <span className="truncate">{llmConfig.provider === 'codex-cli' ? 'Codex (OpenAI)' : 'Claude Code'}</span>
                                <ChevronDown size={10} className="text-zinc-600 shrink-0" />
                            </button>
                            {extendedMode && (
                                <span
                                    className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300"
                                    title={`Extended mode • Checks: ${extendedMode.preferred_checks?.join(', ') || 'broader coverage'}${extendedMode.prefer_mcp_tools ? ' • Prefers MCP tools' : ''}`}
                                >
                                    Extended
                                </span>
                            )}
                            {currentContext && (
                                <span className="text-[10px] text-zinc-400 flex items-center gap-1 truncate max-w-[150px]" title={`Kubernetes Context: ${currentContext}`}>
                                    <span className="text-zinc-600">→</span>
                                    <span className="truncate">{currentContext}</span>
                                </span>
                            )}
                            {claudeUsage && (
                                <span className="text-[10px] text-zinc-500 font-medium" title={claudeUsage.cost_info || 'Token usage this session'}>
                                    • {claudeUsage.subscription_type === 'max'
                                        ? `${(claudeUsage.session_tokens.total_tokens / 1000).toFixed(1)}K tokens`
                                        : claudeUsage.cost_info || `${claudeUsage.session_tokens.total_tokens.toLocaleString()} tokens`}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                {/* Header Actions */}
                <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1 border border-white/10 shrink-0 ml-2">
                    <button
                        onClick={() => {
                            setChatHistory([]);
                            localStorage.removeItem('ops-pilot-chat-history');
                            setCurrentPlan(null);
                            setPlanTotalSteps(0);
                            setInvestigationProgress(null);
                            setPhaseTimeline([]);
                            setRankedHypotheses([]);
                            setCoverageGaps([]);
                            setAgentHints([]);
                            setGoalVerification(null);
                            setApprovalContext(null);
                            setExtendedMode(null);
                            // Rotate thread_id to start fresh session
                            const newThreadId = crypto.randomUUID();
                            setThreadId(newThreadId);
                            localStorage.setItem('agent_thread_id', newThreadId);
                        }}
                        className="p-2 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all border border-transparent hover:border-rose-500/30"
                        title="Clear Chat History"
                    >
                        <Trash2 size={14} />
                    </button>
                    {llmLoading && (
                        <>
                            <div className="w-px h-4 bg-white/10 mx-0.5" />
                            <button
                                onClick={cancelAnalysis}
                                disabled={isCancelling}
                                className="p-2 text-rose-400 hover:text-rose-300 hover:bg-white/5 rounded-lg transition-all disabled:opacity-50"
                                title={isCancelling ? "Stopping..." : "Stop Generation"}
                            >
                                <StopCircle size={14} className={isCancelling ? "animate-spin" : ""} />
                            </button>
                        </>
                    )}
                    <div className="w-px h-4 bg-white/10 mx-0.5" />
                    <button
                        onClick={() => setShowSettings(true)}
                        className="p-2 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-all"
                        title="Settings"
                    >
                        <Settings size={14} />
                    </button>
                    <div className="w-px h-4 bg-white/10 mx-0.5" />
                    <button
                        onClick={onToggleMinimize}
                        className="p-2 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-all"
                        title="Minimize"
                    >
                        <Minus size={14} />
                    </button>
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="p-2 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-all"
                        title={isExpanded ? "Restore" : "Expand"}
                    >
                        {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-rose-500/10 text-zinc-500 hover:text-rose-400 transition-all"
                        title="Close"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Settings Panel Modal */}
            {showSettings && createPortal(
                <>
                    {/* Backdrop */}
                    <div
                        className="fixed inset-0 bg-black/70 backdrop-blur-md z-[59] flex items-center justify-center p-4 animate-in fade-in duration-200"
                        onClick={() => setShowSettings(false)}
                    >
                        {/* Modal Container */}
                        <div
                            className="relative w-full max-w-2xl max-h-[90vh] bg-gradient-to-br from-[#1a1a2e] via-[#16161a] to-[#1a1a2e] rounded-3xl shadow-2xl border border-white/10 overflow-hidden animate-in zoom-in-95 duration-300"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Subtle gradient overlay */}
                            <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />

                            {/* Content */}
                            <div className="relative z-10 overflow-y-auto max-h-[90vh]">
                                <LLMSettingsPanel
                                    config={llmConfig}
                                    onConfigChange={(newConfig) => {
                                        setLlmConfig(newConfig);
                                        setShowSettings(false);
                                    }}
                                    onClose={() => setShowSettings(false)}
                                    systemSpecs={systemSpecs}
                                    kbProgress={kbProgress}
                                />
                            </div>
                        </div>
                    </div>
                </>,
                document.body
            )}

            {/* Messages - Elegant Scrollable Area */}
            <div
                ref={messagesContainerRef}
                className={`flex-1 min-h-0 scroll-smooth overflow-y-auto px-5 py-4 space-y-5 relative z-10`}
            >
                {/* Loading state while checking LLM */}
                {checkingLLM && chatHistory.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-24 px-6">
                        <div className="relative mb-6">
                            <div className="w-12 h-12 border-2 border-zinc-700 border-t-indigo-400 rounded-full animate-spin" />
                            <div className="absolute inset-0 flex items-center justify-center">
                                <Sparkles size={16} className="text-indigo-400" />
                            </div>
                        </div>
                        <h3 className="text-base font-medium text-zinc-200 mb-2">Initializing AI...</h3>
                        <p className="text-sm text-zinc-500 text-center max-w-xs">
                            Checking connection and model status.
                        </p>
                    </div>
                )}


                {/* Show setup prompt if Claude Code not connected */}
                {
                    !checkingLLM && (!llmStatus?.connected || !!llmStatus?.error) && chatHistory.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-12 px-6 max-w-lg mx-auto w-full">
                            <div className="relative mb-6">
                                <div className="w-16 h-16 rounded-2xl bg-zinc-800 flex items-center justify-center border border-white/10">
                                    <Terminal size={28} className="text-zinc-400" />
                                </div>
                            </div>
                            <h3 className="text-lg font-semibold text-zinc-100 mb-2">
                                {llmConfig.provider === 'codex-cli' ? 'Codex Setup Required' : 'Claude Code Setup Required'}
                            </h3>
                            <p className="text-sm text-zinc-500 text-center mb-4 max-w-[320px]">
                                {llmStatus?.error || (llmConfig.provider === 'codex-cli'
                                    ? 'OpsPilot uses Codex (via OpenAI) for AI investigations.'
                                    : 'OpsPilot uses Claude Code for AI investigations.')}
                            </p>
                            <div className="w-full bg-zinc-900/50 rounded-xl border border-white/10 p-4 mb-4 text-left space-y-2">
                                {llmConfig.provider === 'codex-cli' ? (
                                    <>
                                        <div className="text-[11px] text-zinc-400 flex items-start gap-2">
                                            <span className="text-zinc-500 font-medium">1.</span>
                                            <span>Install: <code className="bg-white/10 px-1.5 py-0.5 rounded text-zinc-300">npm install -g @openai/codex-cli</code></span>
                                        </div>
                                        <div className="text-[11px] text-zinc-400 flex items-start gap-2">
                                            <span className="text-zinc-500 font-medium">2.</span>
                                            <span>Login: <code className="bg-white/10 px-1.5 py-0.5 rounded text-zinc-300">codex login</code></span>
                                        </div>
                                        <div className="text-[11px] text-zinc-400 flex items-start gap-2">
                                            <span className="text-zinc-500 font-medium">3.</span>
                                            <span>Restart OpsPilot</span>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="text-[11px] text-zinc-400 flex items-start gap-2">
                                            <span className="text-zinc-500 font-medium">1.</span>
                                            <span>Install: <code className="bg-white/10 px-1.5 py-0.5 rounded text-zinc-300">npm install -g @anthropic-ai/claude-code</code></span>
                                        </div>
                                        <div className="text-[11px] text-zinc-400 flex items-start gap-2">
                                            <span className="text-zinc-500 font-medium">2.</span>
                                            <span>Login: <code className="bg-white/10 px-1.5 py-0.5 rounded text-zinc-300">claude login</code></span>
                                        </div>
                                        <div className="text-[11px] text-zinc-400 flex items-start gap-2">
                                            <span className="text-zinc-500 font-medium">3.</span>
                                            <span>Restart OpsPilot</span>
                                        </div>
                                    </>
                                )}
                            </div>
                            <button
                                onClick={checkLLMStatus}
                                className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-medium text-sm transition-all flex items-center gap-2"
                            >
                                <RefreshCw size={14} className="group-hover:rotate-180 transition-transform duration-500" />
                                Check Again
                            </button>
                        </div>
                    )
                }

                {/* Normal chat welcome screen - Clean Style */}
                {
                    !checkingLLM && llmStatus?.connected && !llmStatus?.error && chatHistory.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-10 px-6">
                            {/* Logo container */}
                            <div className="relative mb-6">
                                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                                    <Sparkles size={28} className="text-white" />
                                </div>
                            </div>
                            <h3 className="text-xl font-semibold text-zinc-100 mb-2">AI Assistant Ready</h3>
                            {loadingWelcomeJoke ? (
                                <p className="text-sm text-zinc-500 text-center mb-1 max-w-[320px] italic">
                                    Thinking...
                                </p>
                            ) : welcomeJoke ? (
                                <div className="flex items-center gap-2 mb-1">
                                    <p className="text-sm text-zinc-400 text-center max-w-[320px] italic">
                                        {welcomeJoke}
                                    </p>
                                    <button
                                        onClick={fetchNewWelcomeJoke}
                                        className="p-1.5 text-zinc-600 hover:text-zinc-400 hover:bg-white/5 rounded-lg transition-all"
                                        title="Get another joke"
                                    >
                                        <RefreshCw size={14} />
                                    </button>
                                </div>
                            ) : (
                                <p className="text-sm text-zinc-500 text-center mb-1 max-w-[300px]">
                                    Ask me anything about your cluster's health, resources, or issues.
                                </p>
                            )}
                            <p className="text-xs text-zinc-600 text-center mt-2 max-w-[300px]">What can I help you debug today?</p>
                            <div className="flex flex-col items-center gap-1 mb-6">
                                <p className="text-xs text-zinc-500 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                    {llmStatus.provider === 'codex-cli' ? 'Codex (OpenAI) • o1-preview' :
                                        llmStatus.provider === 'claude-code' ? 'Claude Code' :
                                            `${llmStatus.provider} • ${(llmStatus.model || llmConfig.model).split(':')[0]}`}
                                </p>
                                {/* Embedding model status indicator */}
                                {embeddingStatus && (
                                    <p className={`text-[10px] flex items-center gap-1.5 ${embeddingStatus === 'loading' ? 'text-amber-400' :
                                        embeddingStatus === 'ready' ? 'text-zinc-500' :
                                            'text-red-400'
                                        }`}>
                                        {embeddingStatus === 'loading' && (
                                            <>
                                                <Loader2 size={10} className="animate-spin" />
                                                {embeddingMessage || 'Loading knowledge base...'}
                                            </>
                                        )}
                                        {embeddingStatus === 'ready' && (
                                            <>
                                                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
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
                            <div className="flex flex-wrap gap-2 justify-center max-w-[400px]">
                                {[
                                    { icon: '🔍', text: 'Scan Issues', cmd: 'Find cluster issues' },
                                    { icon: '🚀', text: 'Auto-Diagnose', cmd: 'Perform an autonomous deep dive on the cluster health. Use the Autonomous Playbook.' },
                                    { icon: '🔄', text: 'Crash Analysis', cmd: 'Crashlooping pods' },
                                    { icon: '📊', text: 'Health Status', cmd: 'Health overview' }
                                ].map(q => (
                                    <button
                                        key={q.text}
                                        onClick={() => sendMessage(q.cmd)}
                                        className="px-3 py-2 text-[11px] font-medium bg-white/5 hover:bg-white/10 text-zinc-300 rounded-lg transition-all border border-white/10 hover:border-white/15 flex items-center gap-2"
                                    >
                                        <span className="text-sm">{q.icon}</span>
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

                {/* Standard Chat UI for non-Claude-Code providers */}
                {
                    /* Standard Chat History View */
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
                            const isActive = i === groupedHistory.length - 1 && !group.answer;
                            return (
                                <div key={i}>
                                    {isActive && streamingPhase ? (
                                        <div className="pl-6 pb-4">
                                            <StreamingProgressCard phase={streamingPhase} />
                                        </div>
                                    ) : (
                                        <InvestigationTimeline
                                            steps={group.steps}
                                            isActive={false}
                                        />
                                    )}
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
                                    <div className="relative pl-8 pb-4 group/user">
                                        <div className="absolute left-0 top-1.5 w-3 h-3 rounded-full bg-indigo-500 z-10" />
                                        <div className="absolute left-[5px] top-5 bottom-0 w-px bg-zinc-800" />

                                        <div className="ml-2">
                                            <div className="flex items-center gap-2 mb-1.5">
                                                <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">You</span>
                                            </div>
                                            <div className="inline-block max-w-[90%] bg-indigo-500/15 border border-indigo-500/20 rounded-2xl rounded-bl-md px-4 py-3 break-words">
                                                <p className="text-[14px] text-zinc-200 leading-relaxed break-words">{group.user.content}</p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Timeline */}
                                {isInvestigating && streamingPhase ? (
                                    <div className="pl-6 pb-4">
                                        <StreamingProgressCard phase={streamingPhase} />
                                    </div>
                                ) : group.steps && group.steps.length > 0 ? (
                                    <InvestigationTimeline
                                        steps={group.steps}
                                        isActive={false}
                                    />
                                ) : null}

                                {/* Final Answer - Elegant Assistant Bubble */}
                                {group.answer && (
                                    <div className="relative pl-8 pb-4 group/answer">
                                        <div className="absolute left-0 top-1.5 w-3 h-3 rounded-full bg-emerald-500 z-10" />
                                        <div className="absolute left-[5px] top-5 bottom-0 w-px bg-zinc-800" />

                                        <div className="ml-2">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">AI Assistant</span>
                                                <Sparkles size={10} className="text-zinc-600" />
                                            </div>
                                            <div className="bg-white/[0.03] border border-white/5 rounded-2xl rounded-tl-md overflow-hidden">

                                                <div className="px-5 py-4 prose prose-invert prose-sm max-w-none break-words overflow-x-hidden">
                                                    <ReactMarkdown
                                                        remarkPlugins={[remarkGfm]}
                                                        components={{
                                                            p: ({ children }) => <p className="text-[14px] text-zinc-300 my-3 leading-relaxed opacity-90 break-words">{children}</p>,
                                                            strong: ({ children }) => <strong className="text-white font-bold tracking-tight">{children}</strong>,
                                                            em: ({ children }) => <em className="text-zinc-400 italic font-medium">{children}</em>,
                                                            code: ({ children }) => <code className="text-[12px] bg-white/5 border border-white/10 px-1.5 py-0.5 rounded text-emerald-400 font-mono shadow-inner break-all">{children}</code>,
                                                            pre: ({ children }) => <pre className="text-[12px] bg-black/60 p-4 rounded-xl overflow-x-auto my-4 border border-white/5 shadow-inner font-mono leading-relaxed">{children}</pre>,
                                                            ul: ({ children }) => <ul className="text-[14px] list-none ml-0 my-3 space-y-2.5">{children}</ul>,
                                                            ol: ({ children }) => <ol className="text-[14px] list-decimal ml-5 my-3 space-y-2.5 text-zinc-400">{children}</ol>,
                                                            li: ({ children }) => (
                                                                <li className="text-zinc-300 flex items-start group/li transition-all duration-300 min-w-0">
                                                                    <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500/40 group-hover/li:bg-emerald-500 mt-2 mr-3 transition-colors shadow-sm" />
                                                                    <span className="min-w-0 break-words">{children}</span>
                                                                </li>
                                                            ),
                                                            h1: ({ children }) => <h1 className="text-lg font-bold text-white mt-6 mb-4 flex items-center gap-3 border-b border-white/10 pb-3">{children}</h1>,
                                                            h2: ({ children }) => <h2 className="text-base font-bold text-emerald-300 mt-6 mb-3 flex items-center gap-2.5"><span className="w-2 h-2 rounded bg-emerald-400" />{children}</h2>,
                                                            h3: ({ children }) => <h3 className="text-sm font-bold text-zinc-200 mt-5 mb-2.5 uppercase tracking-widest">{children}</h3>,
                                                            blockquote: ({ children }) => <blockquote className="border-l-4 border-indigo-500/30 bg-indigo-500/5 pl-4 py-2 pr-2 my-4 italic text-zinc-400 rounded-r-lg">{children}</blockquote>,
                                                        }}
                                                    >
                                                        {fixMarkdownHeaders(group.answer.content)}
                                                    </ReactMarkdown>
                                                    {group.answer.isStreaming && group.answer.content && (
                                                        <span className="inline-block w-2 h-5 bg-emerald-400 animate-pulse ml-1 align-middle" />
                                                    )}

                                                    {/* Mark as Solution Button */}
                                                    {!group.answer.isStreaming && group.user && (
                                                        <div className="mt-3 flex justify-end items-center gap-3 border-t border-white/5 pt-2">
                                                            {isJiraConnected() && (
                                                                <button
                                                                    onClick={() => handleCreateJiraIssue(group.user?.content || '', group.answer?.content || '')}
                                                                    className="text-[10px] flex items-center gap-1.5 px-2 py-1 rounded text-zinc-500 hover:text-amber-400 hover:bg-white/5 transition-all"
                                                                    title="Create JIRA Issue from this analysis"
                                                                >
                                                                    <Bug size={12} className="opacity-70" />
                                                                    Create JIRA Issue
                                                                </button>
                                                            )}
                                                            <button
                                                                onClick={() => handleMarkSolution(i, group.user?.content || '', group.answer?.content || '')}
                                                                className={`text-[10px] flex items-center gap-1.5 px-2 py-1 rounded transition-all ${markedSolutions.has(i)
                                                                    ? 'text-emerald-400 bg-emerald-500/10 cursor-default'
                                                                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}`}
                                                                title={markedSolutions.has(i) ? "Saved to Knowledge Base" : "Mark as Solution (improves future answers)"}
                                                                disabled={markedSolutions.has(i)}
                                                            >
                                                                {markedSolutions.has(i) ? <CheckCircle2 size={12} /> : <CheckCircle2 size={12} className="opacity-50" />}
                                                                {markedSolutions.has(i) ? 'Solution Saved' : 'Mark as Solution'}
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })
                }

                {/* Loading State - Elegant Processing Animation */}
                {
                    llmLoading && (
                        <div className="relative pl-8 pb-4 animate-in fade-in slide-in-from-bottom-3 duration-300">
                            <div className="absolute left-0 top-1.5 w-3 h-3 rounded-full bg-indigo-500 z-10 animate-pulse" />
                            <div className="absolute left-[5px] top-5 bottom-0 w-px bg-zinc-800" />

                            <div className="ml-2">
                                <div className="flex items-center gap-3 mb-3">
                                    <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                                        Processing
                                        <span className="flex gap-1">
                                            <span className="w-1 h-1 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                                            <span className="w-1 h-1 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                                            <span className="w-1 h-1 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                                        </span>
                                    </span>

                                    {/* Action button - Stop Generation */}
                                    <button
                                        onClick={cancelAnalysis}
                                        disabled={isCancelling}
                                        className="ml-auto flex items-center gap-2 px-3 py-1.5 text-[10px] font-medium text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/15 border border-rose-500/20 transition-all rounded-lg disabled:opacity-50"
                                    >
                                        <StopCircle size={12} className={isCancelling ? "animate-spin" : ""} />
                                        {isCancelling ? 'Stopping...' : 'Stop'}
                                    </button>
                                </div>

                                {!streamingPhase && (
                                    <div className="bg-white/[0.03] border border-white/5 rounded-2xl rounded-tl-md px-4 py-3">
                                        <p className="text-[13px] text-zinc-400 flex items-center gap-2">
                                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                                            {currentActivity}
                                        </p>
                                    </div>
                                )}

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
                            <div className="rounded-lg p-3 border bg-indigo-500/10 border-indigo-500/30">
                                <div className="text-[10px] font-medium text-zinc-300 mb-1">Mode</div>
                                <div className="text-[11px] text-indigo-300">Extended Investigation</div>
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
                                <div className="mt-2 flex items-center gap-2">
                                    {!goalVerification.met && (
                                        <button
                                            onClick={() => sendMessage('[EXTEND] Please extend investigation: collect missing signals (nodes/pods/events/resource-usage), try MCP tools if available, broaden command diversity, and re-evaluate hypotheses.')}
                                            className="px-3 py-1.5 text-[11px] rounded-md bg-indigo-600/20 border border-indigo-500/40 hover:bg-indigo-600/30 text-indigo-200 transition-all"
                                        >
                                            Extend investigation
                                        </button>
                                    )}
                                    <label className="text-[10px] text-zinc-400 flex items-center gap-1">
                                        <input type="checkbox" checked={autoExtendEnabled} onChange={(e) => setAutoExtendEnabled(e.target.checked)} />
                                        Auto-extend if NOT MET
                                    </label>
                                </div>
                            </div>
                        )}
                        {phaseTimeline.length > 0 && (
                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] p-3">
                                <div className="text-[10px] font-medium text-zinc-300 mb-2">Phases</div>
                                <div className="flex flex-wrap gap-1">
                                    {phaseTimeline.map((p, idx) => (
                                        <span key={idx} className="px-2 py-1 text-[10px] rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-300">{p.name}</span>
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
                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] p-3 animate-in fade-in slide-in-from-bottom-2 shadow-lg shadow-black/40">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <div className="text-[10px] font-bold text-amber-400 mb-1.5 flex items-center gap-1.5 uppercase tracking-wider">
                                            <AlertCircle size={12} />
                                            Approval Needed
                                        </div>
                                        {approvalContext.reason && (<div className="text-[11px] text-zinc-300 mb-1.5 leading-relaxed"><span className="text-zinc-500 font-medium">Reason:</span> {approvalContext.reason}</div>)}
                                        {approvalContext.command && (<div className="text-[11px] text-zinc-300 mb-1.5"><span className="text-zinc-500 font-medium">Action:</span> <code className="bg-black/40 px-1.5 py-0.5 rounded text-amber-200/90 font-mono border border-amber-500/20 shadow-sm ml-1">{approvalContext.command}</code></div>)}
                                        {approvalContext.risk && (<div className="text-[11px] text-zinc-300"><span className="text-zinc-500 font-medium">Risk:</span> {approvalContext.risk}</div>)}
                                    </div>
                                </div>
                                <div className="flex items-center gap-3 mt-3">
                                    <button
                                        onClick={() => handleApproval(true)}
                                        disabled={llmLoading}
                                        className="flex-1 px-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/50 text-emerald-400 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-emerald-900/20 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-wide"
                                    >
                                        <CheckCircle2 size={14} />
                                        Approve & Execute
                                    </button>
                                    <button
                                        onClick={() => handleApproval(false)}
                                        disabled={llmLoading}
                                        className="flex-1 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 hover:border-red-500/50 text-red-400 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-red-900/20 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-wide"
                                    >
                                        <XCircle size={14} />
                                        Deny
                                    </button>
                                </div>
                            </div>
                        )}
                        {agentHints.length > 0 && (
                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] p-3">
                                <div className="text-[10px] font-medium text-zinc-300 mb-2">Hints</div>
                                <ul className="space-y-1">
                                    {agentHints.map((h, i) => (<li key={i} className="text-[11px] text-indigo-300">{h}</li>))}
                                </ul>
                                <div className="mt-2">
                                    <button
                                        onClick={() => sendMessage('[EXTEND] Apply hint and extend: act on emitted hint, expand coverage, use alternate tools, and reassess hypotheses.')}
                                        className="px-3 py-1.5 text-[11px] rounded-md bg-indigo-600/20 border border-indigo-500/40 hover:bg-indigo-600/30 text-indigo-200 transition-all"
                                    >
                                        Apply hint and extend
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Suggested Actions */}
            {suggestedActions.length > 0 && !llmLoading && (
                <div className="px-4 pb-2 flex flex-wrap gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {suggestedActions.map((action, i) => (
                        <button
                            key={i}
                            onClick={() => sendMessage(action)}
                            className="px-3 py-1.5 text-[11px] font-medium bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/15 text-zinc-300 rounded-lg transition-all flex items-center gap-1.5"
                        >
                            <Sparkles size={10} className="text-zinc-500" />
                            {action}
                        </button>
                    ))}
                </div>
            )}

            {/* Agent Activity Header (Persistent when loading) */}
            {llmLoading && (
                <div className="px-5 py-2 animate-in slide-in-from-bottom-2 duration-300">
                    <AgentStatusHeader
                        activity={currentActivity}
                        phase={streamingPhase?.phase}
                        provider={llmStatus?.provider || llmConfig.provider}
                        progress={investigationProgress?.iteration ? (investigationProgress.iteration / investigationProgress.maxIterations) * 100 : undefined}
                    />
                </div>
            )}

            {/* GitHub Code Search Action Bar */}
            {(() => {
                // Find the last completed interaction with an answer
                const lastInteraction = [...groupedHistory].reverse().find(
                    g => g.type === 'interaction' && g.answer && !g.answer.isStreaming
                );
                if (!lastInteraction || llmLoading) return null;

                return (
                    <div className="px-4 py-2 bg-[#16161a] border-t border-white/5 flex items-center justify-center gap-2">
                        <button
                            onClick={() => initSearchGitHub(lastInteraction.user?.content || '', lastInteraction.answer?.content || '', groupedHistory.indexOf(lastInteraction))}
                            disabled={searchingGitHub !== null}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-full transition-all disabled:opacity-50 text-purple-300 hover:text-purple-200 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 hover:border-purple-500/50`}
                            title="Search local code repositories for context"
                        >
                            {searchingGitHub !== null ? (
                                <Loader2 size={12} className="animate-spin" />
                            ) : (
                                <Search size={12} />
                            )}
                            <span>
                                {searchingGitHub !== null ? 'Searching Code...' : 'Search Code...'}
                            </span>
                        </button>
                    </div>
                );
            })()}

            {/* Search Dialog */}
            {/* Search Dialog */}
            <SearchCodeDialog
                isOpen={searchDialogState.isOpen}
                onClose={() => setSearchDialogState(prev => ({ ...prev, isOpen: false }))}
                onSearch={executeSearchGitHub}
                initialQuery={searchDialogState.query}
            />

            {/* Input - Elegant Apple Style */}
            <div className="relative z-20 p-4 bg-zinc-950/50 border-t border-white/5">
                {/* Connection Error Banner with Retry */}
                {connectionError && (
                    <div className="flex items-center gap-3 mb-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                        <AlertCircle size={16} className="text-red-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                            <p className="text-xs text-red-300">{connectionError.message}</p>
                        </div>
                        {connectionError.canRetry && (
                            <button
                                onClick={handleRetryConnection}
                                disabled={retryingConnection}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
                            >
                                {retryingConnection ? (
                                    <Loader2 size={12} className="animate-spin" />
                                ) : (
                                    <RefreshCw size={12} />
                                )}
                                Retry
                            </button>
                        )}
                        <button
                            onClick={() => setConnectionError(null)}
                            className="p-1 text-red-400/60 hover:text-red-300 transition-colors flex-shrink-0"
                        >
                            <X size={14} />
                        </button>
                    </div>
                )}

                {/* Active Context Banner */}
                {resourceContext && (
                    <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-md">
                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                        <span className="text-xs text-indigo-300 font-medium">Context: <span className="text-indigo-200">{resourceContext.kind}/{resourceContext.name}</span></span>
                        <button
                            onClick={() => { /* Ideally clear context, but it comes from props currently */ }}
                            className="ml-auto text-indigo-400 hover:text-indigo-200"
                        >
                            <Minimize2 size={12} />
                        </button>
                    </div>
                )}
                <form onSubmit={(e) => { e.preventDefault(); sendMessage(userInput); }} className="flex items-center gap-2 p-1 bg-white/5 border border-white/10 rounded-xl focus-within:border-white/20 focus-within:bg-white/[0.07] transition-all duration-200">
                    <button
                        type="button"
                        onClick={() => setFastMode(!fastMode)}
                        className={`group relative p-2.5 rounded-lg transition-all duration-200 flex-shrink-0 border flex items-center justify-center ${fastMode
                            ? 'bg-amber-500/10 border-amber-500/20 text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/40 shadow-[0_0_10px_rgba(245,158,11,0.1)]'
                            : 'bg-zinc-800/30 border-white/5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/80 hover:border-white/10'}`}
                    >
                        {fastMode ? <Sparkles size={14} className="fill-amber-400" /> : <Sparkles size={14} />}

                        {/* Tooltip on Hover */}
                        <div className="absolute bottom-full left-0 mb-3 w-[260px] p-3 bg-zinc-900 border border-white/10 rounded-xl shadow-xl backdrop-blur-xl opacity-0 translate-y-2 pointer-events-none group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 z-50">
                            <div className="flex items-center gap-2 mb-1">
                                <Sparkles size={12} className={fastMode ? "text-amber-400" : "text-zinc-400"} />
                                <span className={`text-xs font-bold ${fastMode ? "text-amber-400" : "text-zinc-300"}`}>
                                    {fastMode ? "Fast Mode: Active" : "Fast Mode: Off"}
                                </span>
                            </div>
                            <p className="text-[11px] text-zinc-400 leading-relaxed">
                                {fastMode
                                    ? "Optimized for speed. Skips deep knowledge base search for quick answers."
                                    : "Deep investigation mode. Uses full knowledge base and repository context (slower)."}
                            </p>
                            <div className="absolute -bottom-1 left-4 w-2 h-2 bg-zinc-900 border-b border-r border-white/10 rotate-45"></div>
                        </div>
                    </button>
                    <input
                        type="text"
                        value={userInput}
                        onChange={(e) => setUserInput(e.target.value)}
                        disabled={llmLoading || !llmStatus?.connected || !!llmStatus?.error}
                        placeholder={
                            (!llmStatus?.connected || !!llmStatus?.error)
                                ? "Setup required..."
                                : "Ask anything..."
                        }
                        className="flex-1 px-4 py-2.5 bg-transparent border-none text-zinc-100 text-sm placeholder-zinc-600 focus:outline-none min-w-0 disabled:cursor-not-allowed disabled:text-zinc-600"
                    />
                    <button
                        type="submit"
                        disabled={llmLoading || !userInput.trim() || !llmStatus?.connected || !!llmStatus?.error}
                        className="p-2.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed disabled:bg-zinc-700 flex-shrink-0"
                    >
                        <Send size={14} className={llmLoading ? 'animate-pulse' : ''} />
                    </button>
                </form>
            </div>
        </div>
    );

    if (embedded) return panelContent;
    return createPortal(panelContent, document.body);
}
