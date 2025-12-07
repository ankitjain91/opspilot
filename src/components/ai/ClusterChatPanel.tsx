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
import { getContextPrompt, SYSTEM_PROMPT, ITERATIVE_SYSTEM_PROMPT, CLAUDE_CODE_SYSTEM_PROMPT } from './prompts';
import { executeTool, sanitizeToolArgs, VALID_TOOLS } from './tools';

// Claude Code stream event type
interface ClaudeCodeStreamEvent {
    stream_id: string;
    event_type: 'start' | 'chunk' | 'done' | 'error';
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
    const chatEndRef = useRef<HTMLDivElement>(null);

    // Claude Code streaming state
    const [streamingContent, setStreamingContent] = useState<string>("");
    const [isStreaming, setIsStreaming] = useState(false);
    const [currentStreamId, setCurrentStreamId] = useState<string | null>(null);
    const streamUnlistenRef = useRef<UnlistenFn | null>(null);

    // Check LLM status on mount
    useEffect(() => {
        checkLLMStatus();
    }, [llmConfig]); // eslint-disable-line react-hooks/exhaustive-deps

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
                        setCurrentActivity("🖥️ Claude Code is running...");
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

    const sendMessage = async (message: string) => {
        if (!message.trim() || llmLoading) return;

        setChatHistory(prev => [...prev, { role: 'user', content: message }]);
        setUserInput("");
        setLlmLoading(true);
        setCurrentActivity("🧠 Understanding your request...");

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
                setCurrentActivity(`📚 Searching knowledge base for "${keywords}"...`);
                const { result, command } = await executeTool('SEARCH_KNOWLEDGE', keywords);
                kbResult = result;
                setChatHistory(prev => [...prev, { role: 'tool', content: kbResult, toolName: 'SEARCH_KNOWLEDGE', command }]);
            } else {
                // If no keywords, just log it internally
                console.log("Skipping KB search - no keywords in message:", message);
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
                if (routed && VALID_TOOLS.includes(routed.tool)) {
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
                }
            }

            // Get cluster health summary for context
            setCurrentActivity("📊 Loading cluster context...");
            const healthSummary = await invoke<ClusterHealthSummary>("get_cluster_health_summary");
            const context = getContextPrompt(healthSummary);

            const systemPrompt = SYSTEM_PROMPT;

            // Build tools section for prompt - just suggest which tools to use, NOT how to use them
            // The AI already knows tool syntax from SYSTEM_PROMPT
            const toolsSection = suggestedTools.length > 0
                ? `=== RECOMMENDED TOOLS FOR THIS QUERY ===
Based on your query, these tools are most likely to help:
${suggestedTools.slice(0, 3).map(t => `• ${t.name}`).join('\n')}

Start by running FIND_ISSUES or LIST_ALL to discover actual resource names, then use DESCRIBE/GET_LOGS with those names.
=== END RECOMMENDATIONS ===

`
                : '';

            // Include knowledge base results in the prompt
            const finalPrompt = `
=== KNOWLEDGE BASE RESULTS (ALREADY SEARCHED) ===
${kbResult}
=== END KNOWLEDGE BASE ===

${routedToolResult}${toolsSection}=== CLUSTER CONTEXT ===
${context}
=== END CONTEXT ===

=== USER REQUEST ===
${message}

=== CRITICAL INSTRUCTIONS ===
1. DO NOT call SEARCH_KNOWLEDGE again - it was already searched above
2. First run FIND_ISSUES or LIST_ALL to get REAL resource names from the cluster
3. Then use DESCRIBE, GET_LOGS with those REAL names (never use placeholder text)
4. NEVER use words like "retrieve", "container", "to", "get" as resource names
5. Be autonomous - gather evidence before answering
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

                    if (!VALID_TOOLS.includes(toolName)) {
                        const resultStr = `⚠️ Invalid tool: ${toolName}. Valid tools: ${VALID_TOOLS.join(', ')}`;
                        setChatHistory(prev => [...prev, { role: 'tool', content: resultStr, toolName: 'INVALID', command: 'N/A' }]);
                        continue;
                    }

                    console.log(`[Agent] Tool: ${toolName}, Args: "${toolArgs}"`);
                    setCurrentActivity(getToolActivity(toolName, toolArgs));

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
                            const toolResult = `❌ PLACEHOLDER ERROR: "${toolArgs}" contains [brackets] or <angles> which are not real names.\n\n👉 ${guidance}`;
                            setChatHistory(prev => [...prev, { role: 'tool', content: toolResult, toolName: 'ERROR', command: 'N/A' }]);
                            allToolResults.push(toolResult);
                            continue;
                        }
                    }

                    const { result, command } = await executeTool(toolName, toolArgs);

                    let finalResult = result;
                    if (autoCorrected) finalResult += '\n\n⚠️ NOTE: Argument was auto-corrected to list ALL namespaces because a placeholder was detected.';

                    setChatHistory(prev => [...prev, { role: 'tool', content: finalResult, toolName, command }]);

                    // Only include successful results in AI context
                    if (!finalResult.startsWith('❌') && !finalResult.startsWith('⚠️')) {
                        allToolResults.push(`## ${toolName}\n${finalResult}`);
                    }
                }

                // Iterative investigation loop - AI continues until done
                // Accumulate ALL results across iterations for full context
                let allAccumulatedResults = [...allToolResults];
                let iterationCount = 0;
                const maxIterations = 10; // Reduced from 30 - with better tools, we need fewer iterations
                let consecutiveErrors = 0; // Track consecutive failures

                while (iterationCount < maxIterations) {
                    setCurrentActivity(`🧠 Analyzing results... (step ${iterationCount + 1})`);

                    // Use compression to avoid context overflow
                    const compressedHistory = compressToolHistory(allAccumulatedResults, 4);
                    const analysisPrompt = `=== Investigation for: "${message}" ===\n\n${compressedHistory}\n\n=== Instructions ===\nAnalyze the evidence. If you have HIGH confidence in the root cause, provide your final answer. Otherwise, gather more data with TOOL: commands.`;

                    const analysisAnswer = await callLLM(
                        analysisPrompt,
                        ITERATIVE_SYSTEM_PROMPT,
                        chatHistory.filter(m => m.role !== 'tool')
                    );

                    // Check if AI wants more tools
                    const nextToolMatches = analysisAnswer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
                    const nextTools = Array.from(nextToolMatches);

                    if (nextTools.length === 0) {
                        // No more tools - final answer
                        setChatHistory(prev => [...prev, { role: 'assistant', content: cleanOutputForUser(analysisAnswer) }]);
                        break;
                    }

                    // Show reasoning
                    const reasoningPart = cleanOutputForUser(analysisAnswer.split('TOOL:')[0].trim());
                    if (reasoningPart) {
                        setChatHistory(prev => [...prev, {
                            role: 'assistant',
                            content: reasoningPart + '\n\n*🔄 Continuing investigation...*',
                            isActivity: true
                        }]);
                    }

                    // Execute next tools
                    const newToolResults: string[] = [];
                    let successfulToolsThisIteration = 0;
                    let errorsThisIteration = 0;

                    for (const toolMatch of nextTools) {
                        const toolName = toolMatch[1];
                        let toolArgs = sanitizeToolArgs(toolMatch[2]?.trim());

                        if (!VALID_TOOLS.includes(toolName)) {
                            setChatHistory(prev => [...prev, { role: 'tool', content: `⚠️ Invalid tool: ${toolName}`, toolName: 'INVALID', command: 'N/A' }]);
                            errorsThisIteration++;
                            continue;
                        }

                        setCurrentActivity(getToolActivity(toolName, toolArgs));

                        // Validate against placeholders (iteration)
                        const iterPlaceholderRegex = /\[.*?\]|<.*?>|\.\.\./;
                        if (toolName !== 'SEARCH_KNOWLEDGE' && toolArgs && iterPlaceholderRegex.test(toolArgs)) {
                            // Auto-correction logic matching previous logic
                            if (['GET_EVENTS', 'LIST_ALL', 'LIST_PODS', 'TOP_PODS', 'FIND_ISSUES'].includes(toolName)) {
                                if (toolName === 'LIST_ALL' || toolName === 'LIST_PODS') {
                                    const parts = (toolArgs || '').split(/\s+/);
                                    toolArgs = parts[0];
                                } else {
                                    toolArgs = undefined;
                                }
                            } else {
                                const toolResult = `❌ PLACEHOLDER ERROR: "${toolArgs}" contains [brackets] or <angles>.\n\n👉 Use FIND_ISSUES or LIST_ALL first.`;
                                setChatHistory(prev => [...prev, { role: 'tool', content: toolResult, toolName, command: 'Validation Error' }]);
                                newToolResults.push(`### ${toolName}\n${toolResult}`);
                                errorsThisIteration++;
                                continue;
                            }
                        }

                        const { result, command } = await executeTool(toolName, toolArgs);
                        setChatHistory(prev => [...prev, { role: 'tool', content: result, toolName, command }]);

                        // Track success/error based on result content
                        // Only include SUCCESSFUL results in AI context (skip errors)
                        if (result.startsWith('❌') || result.startsWith('⚠️')) {
                            errorsThisIteration++;
                            // Don't add failed results to context - AI should not see errors
                        } else {
                            successfulToolsThisIteration++;
                            // Only accumulate successful results for AI context
                            newToolResults.push(`## ${toolName}\n${result}`);
                        }
                    }

                    // Track consecutive errors - only give up after 3 consecutive failed iterations
                    if (errorsThisIteration > 0 && successfulToolsThisIteration === 0) {
                        consecutiveErrors++;
                        if (consecutiveErrors >= 3) {
                            setCurrentActivity("⚠️ Investigation hit a dead end...");
                            // Let the LLM give a final answer about what it found
                            const fallbackAnswer = await callLLM(
                                `I've encountered ${consecutiveErrors} consecutive errors while investigating. Based on what I've found so far, provide your best analysis and recommendations. Original question: "${message}"`,
                                ITERATIVE_SYSTEM_PROMPT,
                                chatHistory.filter(m => m.role !== 'tool')
                            );
                            setChatHistory(prev => [...prev, { role: 'assistant', content: cleanOutputForUser(fallbackAnswer) }]);
                            break;
                        }
                    } else {
                        consecutiveErrors = 0; // Reset on success
                    }

                    // Add new SUCCESSFUL results to accumulated history
                    // Only count as iteration if we got useful data
                    if (newToolResults.length > 0) {
                        allAccumulatedResults.push(...newToolResults);
                        iterationCount++;
                    }
                }
            } else {
                setChatHistory(prev => [...prev, { role: 'assistant', content: cleanOutputForUser(answer) }]);
            }
        } catch (err) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Error: ${err}. Check your AI settings or provider connection.` }]);
        } finally {
            setLlmLoading(false);
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
                        <p className="text-xs text-zinc-500 mb-6 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
                            {llmStatus.provider} • {llmConfig.model.split(':')[0]}
                        </p>
                        <div className="flex flex-wrap gap-2 justify-center max-w-[360px]">
                            {[
                                { icon: '🔍', text: 'Find cluster issues' },
                                { icon: '🔄', text: 'Crashlooping pods' },
                                { icon: '📊', text: 'Health overview' }
                            ].map(q => (
                                <button
                                    key={q.text}
                                    onClick={() => sendMessage(q.text)}
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
                                <div className={`absolute left-0 top-1 w-3 h-3 rounded-full ring-4 ${msg.content.startsWith('❌') ? 'bg-red-500 ring-red-500/20' :
                                    msg.content.startsWith('⚠️') ? 'bg-amber-500 ring-amber-500/20' :
                                        'bg-cyan-500 ring-cyan-500/20'
                                    }`} />
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
                                    <details className={`group ${msg.content.startsWith('❌') ? '' : 'open'}`} open={!msg.content.startsWith('❌')}>
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
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-medium text-amber-400 uppercase tracking-wider">Thinking</span>
                                            <Loader2 size={10} className="text-amber-400 animate-spin" />
                                        </div>
                                        <p className="text-xs text-zinc-400 mt-1 italic">
                                            {msg.content.replace(/\*|🔄/g, '').replace(/Investigating\.\.\.|Continuing investigation\.\.\./, '').trim() || 'Analyzing data...'}
                                        </p>
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

                        {/* Claude Code Output - Same style as assistant */}
                        {msg.role === 'claude-code' && (
                            <div className="relative pl-6 pb-4">
                                {/* Timeline dot */}
                                <div className={`absolute left-0 top-1 w-3 h-3 rounded-full ${msg.isStreaming ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500'} ring-4 ring-emerald-500/20`} />

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
                                            {msg.content ? (
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
                                            ) : msg.isStreaming ? (
                                                <div className="flex items-center gap-2 text-zinc-500">
                                                    <Loader2 size={14} className="animate-spin" />
                                                    <span className="text-sm">Waiting for response...</span>
                                                </div>
                                            ) : null}
                                            {msg.isStreaming && msg.content && (
                                                <span className="inline-block w-1.5 h-4 bg-emerald-400 animate-pulse ml-0.5" />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                ))
                }

                {/* Loading State */}
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
                                </div>
                                <p className="text-xs text-zinc-500 mt-1">{currentActivity}</p>
                            </div>
                        </div>
                    )
                }
                <div ref={chatEndRef} />
            </div >

            {/* Input */}
            < div className="relative p-4 bg-gradient-to-t from-[#16161a] to-transparent" >
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
