/**
 * Agent Orchestrator - Wrapper for K8s Agent
 *
 * This module provides the interface between the UI (ClusterChatPanel)
 * and the agent backend.
 *
 * ARCHITECTURE CHANGE (Dec 2025):
 * Only the Python LangGraph backend is supported. The local TypeScript agent
 * has been removed to ensure consistent intelligence and avoid outdated fallbacks.
 */

// =============================================================================
// TYPES (Exported for UI compatibility)
// =============================================================================

export interface LLMOptions {
    temperature?: number;
    max_tokens?: number;
    model?: string;
    format?: string;
}

export interface AgentStep {
    role: 'SUPERVISOR' | 'SCOUT' | 'SPECIALIST' | 'USER';
    content: string;
}

interface PythonAgentRequest {
    query: string;
    kube_context: string;
    llm_endpoint: string;
    llm_provider: string;
    llm_model: string;
    executor_model: string;
    embedding_model?: string;
    api_key?: string;
    conversation_history: Array<{ role: string, content: string }>;
    approved_command?: boolean;
}

// =============================================================================
// PYTHON LANGGRAPH SERVER
// =============================================================================

import { invoke } from '@tauri-apps/api/core';
import { formatKubectlOutput } from './kubernetesFormatter';
import { DEFAULT_LLM_CONFIG } from './constants';
import { LLMConfig } from '../../types/ai';
import {
    discoverClusterCapabilities,
    buildClusterContextString,
    getAIDrivenAlternatives,
    createAIInvestigationPlan
} from './aiDrivenUtils';

import { getAgentServerUrl, getProjectMappings } from '../../utils/config';

// =============================================================================
// RESILIENT FETCH UTILITIES
// =============================================================================

/**
 * Fetch with automatic retry and timeout.
 * Returns null on failure instead of throwing.
 */
async function resilientFetch(
    url: string,
    options: RequestInit = {},
    config: { retries?: number; timeout?: number; retryDelay?: number } = {}
): Promise<Response | null> {
    const { retries = 2, timeout = 5000, retryDelay = 500 } = config;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            // If we got a response (even 500), return it
            return response;
        } catch (e: any) {
            const isLastAttempt = attempt === retries;

            if (e.name === 'AbortError') {
                console.warn(`[AgentOrchestrator] Request to ${url} timed out (attempt ${attempt + 1}/${retries + 1})`);
            } else {
                console.warn(`[AgentOrchestrator] Request to ${url} failed (attempt ${attempt + 1}/${retries + 1}):`, e.message);
            }

            if (!isLastAttempt) {
                await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
            }
        }
    }

    return null;
}

/**
 * Check if agent server is reachable and get its status.
 */
export async function getAgentServerStatus(): Promise<{
    available: boolean;
    status?: 'ok' | 'degraded';
    components?: Record<string, string>;
    error?: string;
}> {
    try {
        const response = await resilientFetch(`${getAgentServerUrl()}/status`, { method: 'GET' }, { retries: 1, timeout: 3000 });

        if (!response) {
            return { available: false, error: 'Server unreachable' };
        }

        if (response.ok) {
            const data = await response.json();
            return {
                available: true,
                status: data.status,
                components: data.components,
            };
        } else {
            // Server responded but with error - it's still "available" but degraded
            const errorData = await response.json().catch(() => ({}));
            return {
                available: true,
                status: 'degraded',
                error: errorData.detail || `HTTP ${response.status}`,
            };
        }
    } catch (e: any) {
        return { available: false, error: e.message };
    }
}

/**
 * Restart a specific server component (user-triggered recovery).
 */
export async function restartServerComponent(component: 'sentinel'): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
        const response = await resilientFetch(
            `${getAgentServerUrl()}/restart-${component}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            { retries: 1, timeout: 10000 }
        );

        if (!response) {
            return { success: false, error: 'Server unreachable' };
        }

        const data = await response.json();
        return data;
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

/**
 * Trigger background KB preloading for a context.
 * Call this when user switches contexts to warm the cache before they ask questions.
 * Also updates the Sentinel to monitor the correct cluster.
 *
 * This function is RESILIENT:
 * - Uses retries with exponential backoff
 * - Never throws - always returns gracefully
 * - Logs warnings but doesn't block the UI
 */
export async function preloadKBForContext(kubeContext: string): Promise<void> {
    try {
        // Update KB preload (with retry)
        const preloadPromise = resilientFetch(
            `${getAgentServerUrl()}/preload`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kube_context: kubeContext }),
            },
            { retries: 2, timeout: 5000 }
        );

        // Update Sentinel context (with retry)
        const sentinelPromise = resilientFetch(
            `${getAgentServerUrl()}/sentinel/context`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kube_context: kubeContext }),
            },
            { retries: 2, timeout: 5000 }
        );

        const [preloadResponse, sentinelResponse] = await Promise.all([preloadPromise, sentinelPromise]);

        if (preloadResponse?.ok) {
            const data = await preloadResponse.json();
            console.log(`[AgentOrchestrator] KB preload triggered for ${kubeContext}:`, data);
        } else if (preloadResponse) {
            // Got a response but it wasn't ok - log but don't fail
            console.warn(`[AgentOrchestrator] KB preload returned ${preloadResponse.status}`);
        }

        if (sentinelResponse?.ok) {
            const data = await sentinelResponse.json();
            console.log(`[AgentOrchestrator] Sentinel context updated to ${kubeContext}:`, data);
        } else if (sentinelResponse) {
            console.warn(`[AgentOrchestrator] Sentinel context update returned ${sentinelResponse.status}`);
        }
    } catch (e) {
        // This should rarely happen due to resilientFetch, but handle anyway
        console.debug('[AgentOrchestrator] KB preload/Sentinel update failed (agent may not be running):', e);
    }
}

async function checkPythonAgentAvailable(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);

        const response = await fetch(`${getAgentServerUrl()}/health`, {
            method: 'GET',
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Token usage data from Claude.
 */
export interface ClaudeUsageData {
    session_tokens: {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        total_tokens: number;
    };
    cost_info: string | null;
    subscription_type: 'max' | 'api' | 'unknown';
}

/**
 * Fetch current Claude usage status from the backend.
 */
export async function getClaudeUsage(): Promise<ClaudeUsageData | null> {
    try {
        const response = await fetch(`${getAgentServerUrl()}/claude/usage`);
        if (response.ok) {
            const data = await response.json();
            return data.usage || null;
        }
    } catch (e) {
        console.debug('[AgentOrchestrator] Failed to fetch Claude usage:', e);
    }
    return null;
}

/**
 * MCP Server configuration to pass to Claude.
 */
interface McpServerConfig {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
}

/**
 * Get connected MCP servers from localStorage.
 */
function getConnectedMcpServers(): McpServerConfig[] {
    try {
        const saved = localStorage.getItem('opspilot-mcp-servers');
        if (!saved) return [];

        const servers = JSON.parse(saved) as Array<{
            name: string;
            command: string;
            args: string[];
            env: Record<string, string>;
            connected: boolean;
        }>;

        // Only return connected servers
        return servers
            .filter((s) => s.connected)
            .map((s) => ({
                name: s.name,
                command: s.command,
                args: s.args || [],
                env: s.env || {}
            }));
    } catch (e) {
        console.warn('[AgentOrchestrator] Failed to load MCP servers:', e);
        return [];
    }
}

/**
 * Direct Claude Code agent - bypasses LangGraph for faster responses.
 * Uses single Claude Code call with tool execution.
 */
async function runDirectAgent(
    query: string,
    kubeContext: string,
    llmProvider: string,
    onProgress?: (msg: string) => void,
    onStep?: (step: AgentStep) => void,
    abortSignal?: AbortSignal,
    toolSubset?: string, // "code_search", "k8s_only", etc.
    fastMode: boolean = false,
    resourceContext?: string
): Promise<string> {
    // Get connected MCP servers to pass to Claude
    const mcpServers = getConnectedMcpServers();
    if (mcpServers.length > 0) {
        console.log('[AgentOrchestrator] Passing MCP servers to Claude:', mcpServers.map(s => s.name));
    }

    const response = await fetch(`${getAgentServerUrl()}/analyze-direct`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
            query,
            kube_context: kubeContext || '',
            llm_provider: llmProvider,
            tool_subset: toolSubset,
            fast_mode: fastMode,
            resource_context: resourceContext,
            mcp_servers: mcpServers
        }),
        signal: abortSignal,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Direct agent error (${response.status}): ${text}`);
    }

    if (!response.body) throw new Error("No response body received");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let finalResponse = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const eventData = JSON.parse(line.slice(6));

                    switch (eventData.type) {
                        case 'progress':
                            onProgress?.(eventData.message);
                            break;
                        case 'thinking':
                            // Claude is reasoning - emit as SUPERVISOR step
                            onStep?.({
                                role: 'SUPERVISOR',
                                content: eventData.content || 'Thinking...'
                            });
                            break;
                        case 'command_selected':
                            // Command about to run - emit with empty output to show "Running" state
                            onStep?.({
                                role: 'SCOUT',
                                content: JSON.stringify({
                                    command: eventData.command,
                                    output: ''  // Empty output signals "executing" to UI
                                })
                            });
                            break;
                        case 'command_output':
                            // Command completed - emit with actual output
                            onStep?.({
                                role: 'SCOUT',
                                content: JSON.stringify({
                                    command: eventData.command,
                                    output: eventData.output
                                })
                            });
                            break;
                        case 'done':
                            finalResponse = eventData.final_response || '';
                            // Emit IS_SOLUTION marker if present
                            if (eventData.is_solution) {
                                onStep?.({
                                    role: 'SPECIALIST',
                                    content: '[IS_SOLUTION]'
                                });
                            }
                            // Emit suggested next steps if available
                            if (eventData.suggested_next_steps?.length > 0) {
                                onStep?.({
                                    role: 'SPECIALIST',
                                    content: `[SUGGESTIONS]${JSON.stringify(eventData.suggested_next_steps)}`
                                });
                            }
                            break;
                        case 'error':
                            throw new Error(eventData.message);
                        case 'investigation_plan':
                            // Code search investigation plan - display in UI
                            onStep?.({
                                role: 'SUPERVISOR',
                                content: `[INVESTIGATION_PLAN]${eventData.plan || eventData.raw || ''}`
                            });
                            break;
                        case 'search_result':
                            // Code search result with confidence
                            onStep?.({
                                role: 'SPECIALIST',
                                content: `[SEARCH_RESULT:${eventData.confidence || 0}%]${eventData.raw || ''}`
                            });
                            break;
                        case 'command_blocked':
                            // Security: Command was blocked - show warning to user
                            onStep?.({
                                role: 'SCOUT',
                                content: JSON.stringify({
                                    command: eventData.command,
                                    output: `🛡️ BLOCKED: ${eventData.reason}\n${eventData.message || 'This command was blocked for security reasons.'}`
                                })
                            });
                            break;
                        case 'command_approval_required':
                            // Command requires user approval (future)
                            onStep?.({
                                role: 'SCOUT',
                                content: JSON.stringify({
                                    command: eventData.command,
                                    output: `⏸️ APPROVAL REQUIRED: ${eventData.reason}\nThis command needs your approval to run.`
                                })
                            });
                            break;
                    }
                } catch (e) {
                    // Ignore parse errors for malformed lines
                }
            }
        }
    }

    return finalResponse || 'No response generated';
}


async function ensureAgentRunning(): Promise<boolean> {
    // First check if already running
    if (await checkPythonAgentAvailable()) {
        return true;
    }

    // Try to start it via Tauri command
    console.log('[AgentOrchestrator] Agent not available, attempting to start...');
    try {
        const result = await invoke('start_agent');
        console.log('[AgentOrchestrator] start_agent result:', result);

        // Wait for it to become available (up to 8 seconds)
        for (let i = 0; i < 16; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (await checkPythonAgentAvailable()) {
                console.log('[AgentOrchestrator] Agent started successfully after', (i + 1) * 500, 'ms');
                return true;
            }
            if (i % 4 === 3) {
                console.log('[AgentOrchestrator] Still waiting for agent...', (i + 1) * 500, 'ms');
            }
        }
        console.error('[AgentOrchestrator] Agent failed to become available after 8 seconds');
    } catch (e: any) {
        console.error('[AgentOrchestrator] Failed to start agent:', e?.message || e);
    }

    return false;
}

async function runPythonAgent(
    query: string,
    kubeContext: string,
    llmEndpoint: string,
    llmProvider: string,
    llmModel: string,
    executorModel: string,
    apiKey: string | undefined,
    onProgress?: (msg: string) => void,
    onStep?: (step: AgentStep) => void,
    abortSignal?: AbortSignal,
    mcpTools?: any[],
    initialHistory: Array<{ role: string, content: string }> = [],
    onPlanCreated?: (plan: any[], totalSteps: number) => void,
    onPlanUpdate?: (plan: any[], currentStep: number, totalSteps: number) => void,
    onStepCompleted?: (step: number, planSummary: string) => void,
    onStepFailed?: (step: number, error: string) => void,
    onPlanComplete?: (totalSteps: number) => void,
    threadId?: string,
    embeddingModel?: string,
    approvedCommand?: boolean,
    onApprovalRequired?: (context: any) => void,
    toolSubset?: string,
    fastMode: boolean = false,
    resourceContext?: string
): Promise<string> {
    // Pre-flight check: ensure the Python agent is running (auto-start if needed)
    onProgress?.('🔍 Checking agent server...');
    const isAvailable = await ensureAgentRunning();
    if (!isAvailable) {
        throw new Error("[X] **Agent Server Unavailable**: The Python sidecar failed to start. Please restart the app and check the console for errors.");
    }

    // FAST PATH: Use direct agent if fastMode is requested OR for specific providers
    if (fastMode || llmProvider === 'claude-code' || llmProvider === 'codex-cli') {
        console.log(`[AgentOrchestrator] Using direct agent (Fast Mode: ${fastMode})`);
        onProgress?.(fastMode ? '⚡ Fast Investigation...' : '▶️ Direct investigation...');
        return await runDirectAgent(query, kubeContext, llmProvider, onProgress, onStep, abortSignal, toolSubset, fastMode, resourceContext);
    }

    onProgress?.('🧠 Reasoning...');

    // State for the agent loop
    let currentHistory: any[] = [];
    let currentToolOutput: any | null = null;

    // Safety break
    let loopCount = 0;
    const MAX_LOOPS = 10;

    // Retrieve project mappings (Smart Code Discovery)
    const projectMappings = await getProjectMappings();

    while (loopCount < MAX_LOOPS) {
        loopCount++;

        const request: PythonAgentRequest & { mcp_tools?: any[], tool_output?: any, history: any[], thread_id?: string, project_mappings?: any[] } = {
            query,
            kube_context: kubeContext || '',
            llm_endpoint: llmEndpoint,
            llm_provider: llmProvider,
            llm_model: llmModel,
            executor_model: executorModel,
            embedding_model: embeddingModel,
            project_mappings: projectMappings,
            api_key: apiKey,
            conversation_history: initialHistory || [],
            mcp_tools: mcpTools || [],
            history: currentHistory,
            thread_id: threadId,
            approved_command: approvedCommand
        };

        try {
            const response = await fetch(`${getAgentServerUrl()}/analyze`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
                body: JSON.stringify(request),
                signal: abortSignal,
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Python agent error (${response.status}): ${text}`);
            }

            if (!response.body) throw new Error("No response body received");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let finalResponse = '';
            let toolCallRequest = null;
            let currentServerHistory = null;
            let lastError: string | null = null; // Track last error but don't fail immediately

            while (true) {
                let done: boolean;
                let value: Uint8Array | undefined;

                try {
                    const result = await reader.read();
                    done = result.done;
                    value = result.value;
                } catch (readError: any) {
                    // Stream read failed - could be network issue or server died
                    throw new Error(`Stream read failed: ${readError?.message || 'Connection interrupted'}`);
                }

                // Process final chunk before breaking (critical for receiving 'done' event with final_response)
                if (done && !value) break;

                const chunk = decoder.decode(value, { stream: !done });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const eventData = JSON.parse(line.slice(6));

                            switch (eventData.type) {
                                case 'progress':
                                    onProgress?.(eventData.message);
                                    break;
                                case 'intent':
                                    onProgress?.(eventData.message);
                                    break;
                                case 'reflection':
                                    onStep?.({
                                        role: eventData.assessment === 'PLANNING' ? 'SUPERVISOR' : 'SCOUT',
                                        content: `**${eventData.assessment}**: ${eventData.reasoning}`
                                    });
                                    break;
                                case 'command_selected':
                                    onStep?.({
                                        role: 'SCOUT',
                                        content: JSON.stringify({
                                            command: eventData.command,
                                            output: "" // Empty output signals "executing" state to the UI
                                        })
                                    });
                                    break;
                                case 'command_output':
                                    // Auto-format kubectl outputs for better readability
                                    const rawOutput = eventData.error ? `Error: ${eventData.error}\nOutput: ${eventData.output}` : eventData.output;
                                    let formattedOutput = rawOutput;

                                    // Try to format kubectl output (but skip if it's a Python command)
                                    if (eventData.command && eventData.command.includes('kubectl') && !eventData.command.startsWith('python:') && !eventData.error) {
                                        const formatted = formatKubectlOutput(eventData.command, eventData.output);
                                        formattedOutput = formatted.markdown;
                                    }

                                    onStep?.({
                                        role: 'SCOUT',
                                        content: JSON.stringify({
                                            command: eventData.command,
                                            output: formattedOutput
                                        })
                                    });
                                    break;
                                case 'plan_created':
                                    onPlanCreated?.(eventData.plan, eventData.total_steps);
                                    break;
                                case 'plan_update':
                                    onPlanUpdate?.(eventData.plan, eventData.current_step, eventData.total_steps);
                                    break;
                                case 'step_completed':
                                    onStepCompleted?.(eventData.step, eventData.plan_summary);
                                    break;
                                case 'step_failed':
                                    onStepFailed?.(eventData.step, eventData.error);
                                    break;
                                case 'plan_complete':
                                    onPlanComplete?.(eventData.total_steps);
                                    break;
                                case 'tool_call_request':
                                    toolCallRequest = eventData;
                                    currentServerHistory = eventData.history;
                                    onStep?.({
                                        role: 'SPECIALIST',
                                        content: `**Using Tool**: \`${eventData.tool}\`\nArguments: ${JSON.stringify(eventData.args)}`
                                    });
                                    break;
                                case 'done':
                                    if (eventData.final_response) {
                                        finalResponse = eventData.final_response;
                                    }
                                    // Emit proactive suggestions to the UI if present
                                    if (eventData.suggested_next_steps && Array.isArray(eventData.suggested_next_steps)) {
                                        try {
                                            onProgress?.(`[SUGGESTIONS] ${JSON.stringify(eventData.suggested_next_steps)}`);
                                        } catch (_) {
                                            // Non-fatal if suggestions fail to emit
                                        }
                                    }
                                    // Emit is_solution flag to UI for "Mark as Solution" button visibility
                                    if (eventData.is_solution) {
                                        onProgress?.('[IS_SOLUTION]');
                                    }
                                    break;
                                case 'error':
                                    // Store error but don't throw immediately - agent may recover
                                    lastError = eventData.message;
                                    onProgress?.(`[WARN] ${eventData.message}`);
                                    break;
                                case 'approval_needed':
                                    onApprovalRequired?.(eventData);
                                    break;
                            }
                        } catch (e: any) {
                            // Ignore parse errors for incomplete SSE chunks (common with streaming)
                        }
                    }
                }

                // After processing chunk, if stream is done, break
                if (done) break;
            }

            // If we got a tool call request, execute it and LOOP
            if (toolCallRequest) {
                const requestedTool = toolCallRequest.tool; // e.g. "github__get_issue"
                const toolDef = mcpTools?.find((t: any) => t.name === requestedTool);

                let toolResult = "";
                let toolError = null;

                if (!toolDef) {
                    toolResult = "";
                    toolError = `Tool '${requestedTool}' not found in available tools list.`;
                } else {
                    try {
                        onProgress?.(`[TOOL] Running ${toolDef.original_name}...`);
                        const result = await invoke('call_mcp_tool', {
                            serverName: toolDef.server,
                            toolName: toolDef.original_name,
                            args: toolCallRequest.args
                        });

                        // MCP Check: The result object usually has { content: [ { type: 'text', text: '...' } ] }
                        // We need to verify if 'call_mcp_tool' returns the raw value or wrapped
                        // The Rust 'call_mcp_tool' returns Result<Value, String>.
                        // Assuming it returns the MCP 'CallToolResult' object.

                        toolResult = JSON.stringify(result, null, 2);

                        onStep?.({
                            role: 'SPECIALIST',
                            content: `**Tool Result**: \n\`\`\`json\n${toolResult.substring(0, 500)}${toolResult.length > 500 ? '...' : ''}\n\`\`\``
                        });

                    } catch (e: any) {
                        toolResult = "";
                        toolError = String(e);
                        onStep?.({
                            role: 'SPECIALIST',
                            content: `**Tool Failed**: ${toolError}`
                        });
                    }
                }

                // Prepare next iteration
                currentHistory = currentServerHistory || currentHistory;
                currentToolOutput = {
                    tool: requestedTool,
                    output: toolResult,
                    error: toolError
                };

                // CONTINUE LOOP
                continue;
            }

            // If no tool call, we are done
            // If we have a final response, return it (even if there were errors during retries)
            if (finalResponse) {
                return finalResponse;
            }

            // No final response - if there was an error, throw it
            if (lastError) {
                throw new Error(`Agent Server: ${lastError}`);
            }

            return "Agent completed without a final response.";

        } catch (error: any) {
            if (error.name === 'AbortError') throw new Error("Request cancelled by user");

            // Should we retry on network error? Probably not for now.
            const errorMsg = error.message?.toLowerCase() || '';
            if (errorMsg.includes('fetch failed') || errorMsg.includes('econnrefused')) {
                throw new Error("[X] **Agent Server Unreachable**: The Python sidecar is not running.");
            }
            throw error;
        }
    }

    return "Agent loop limit reached (max 10 turns). Stopping to prevent infinite loops.";
}

// =============================================================================
// CONFIGURATION MANAGEMENT - NO HARDCODED DEFAULTS
// =============================================================================

// Load LLM configuration from user settings
// Falls back to DEFAULT_LLM_CONFIG (Claude Code) if user hasn't configured
async function loadLLMConfiguration(): Promise<LLMConfig> {
    try {
        // Try to load from user settings file
        const userConfig = await invoke<LLMConfig | null>('load_llm_config');
        if (userConfig) {
            console.log('[LLM Config] Loaded user configuration:', userConfig.provider, userConfig.model);
            return userConfig;
        }
    } catch (e) {
        console.warn('[LLM Config] Failed to load user config:', e);
    }

    // Use Claude Code default configuration
    console.log('[LLM Config] Using default Claude Code configuration');
    return DEFAULT_LLM_CONFIG;
}

// =============================================================================
// LEGACY COMPATIBILITY LAYER
// Replaces runAgentLoop with direct Python calls
// =============================================================================

export async function runAgentLoop(
    userGoal: string,
    _llmExecutor: any, // Ignored
    _fastLlmExecutor: any, // Ignored
    onProgress?: (msg: string) => void,
    onStep?: (step: AgentStep) => void,
    _initialHistory?: any[], // Ignored
    abortSignal?: AbortSignal,
    kubeContext?: string,
    llmConfig?: { endpoint?: string; provider?: string; model?: string; executor_model?: string; api_key?: string },
    mcpTools?: any[],
    onPlanCreated?: (plan: any[], totalSteps: number) => void,
    onPlanUpdate?: (plan: any[], currentStep: number, totalSteps: number) => void,
    onStepCompleted?: (step: number, planSummary: string) => void,
    onStepFailed?: (step: number, error: string) => void,
    onPlanComplete?: (totalSteps: number) => void,
    baseParams?: { thread_id?: string; approved?: boolean; onApprovalRequired?: (context: any) => void; tool_subset?: string; fastMode?: boolean; resourceContext?: string }
): Promise<string> {

    try {
        // Load configuration from settings - NO HARDCODED DEFAULTS
        const config = await loadLLMConfiguration();

        // Use provided config or loaded config (fail if neither available)
        const endpoint = llmConfig?.endpoint || config.base_url;
        const provider = llmConfig?.provider || config.provider;
        const model = llmConfig?.model || config.model;
        const executorModel = llmConfig?.executor_model || config.executor_model || model;
        const apiKey = llmConfig?.api_key || config.api_key || undefined;

        if (!endpoint || !model) {
            throw new Error('LLM configuration required. Please configure LLM settings first.');
        }

        return await runPythonAgent(
            userGoal,
            kubeContext || '',
            endpoint,
            provider,
            model,
            executorModel,
            apiKey,
            onProgress,
            onStep,
            abortSignal,
            mcpTools,
            _initialHistory || [],
            onPlanCreated,
            onPlanUpdate, // Pass to runPythonAgent
            onStepCompleted,
            onStepFailed,
            onPlanComplete,
            baseParams?.thread_id,
            config.embedding_model || undefined,
            baseParams?.approved,
            baseParams?.onApprovalRequired,
            baseParams?.tool_subset,
            baseParams?.fastMode,
            baseParams?.resourceContext
        );


    } catch (error: any) {
        if (error.message === "Request cancelled by user") {
            throw error;
        }
        console.error('Python Agent Fatal Error:', error);
        throw new Error(`Agent Failed: ${error.message}`);
    }
}
