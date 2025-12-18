/**
 * Claude Code Panel - Integrated Claude Code CLI wrapper with rich UI
 * Similar to Opcode.sh - parses Claude Code output and renders it nicely
 *
 * Uses non-interactive mode (-p) with streaming JSON output for reliable communication
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    Send,
    Loader2,
    Bot,
    User,
    Sparkles,
    Terminal,
    History,
    X,
    Trash2,
    Settings,
    Shield,
    ShieldCheck,
    ShieldOff,
    ShieldAlert
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ClaudeOutputParser, ParsedBlock, mergeTextBlocks, stripAnsi } from './claudeParser';
import { ToolCallBlock } from './chat/ToolCallBlock';
import { DiffBlock } from './chat/DiffBlock';
import { ClaudeThinkingBlock } from './chat/ClaudeThinkingBlock';
import { SessionBrowser } from './SessionBrowser';

// Claude Code streaming JSON message types
// Note: Claude Code CLI uses a simpler format than the Anthropic API
interface ClaudeStreamMessage {
    type: 'system' | 'assistant' | 'user' | 'result';
    subtype?: 'init' | 'success' | 'error';
    // System init message
    session_id?: string;
    tools?: string[];
    model?: string;
    // Assistant message
    message?: {
        role?: string;
        content?: Array<{ type: string; text?: string; name?: string; input?: any; id?: string }>;
    };
    // Result message
    result?: string;
    is_error?: boolean;
    duration_ms?: number;
    total_cost_usd?: number;
}

interface ClaudeCodePanelProps {
    currentContext?: string;
    className?: string;
    onClose?: () => void;
    embedded?: boolean;
}

// Permission modes for Claude Code
type ClaudePermissionMode = 'acceptEdits' | 'plan' | 'bypassPermissions' | 'default';

const PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, { label: string; description: string }> = {
    'acceptEdits': { label: 'Accept Edits', description: 'Auto-accept file edits, prompt for dangerous ops' },
    'plan': { label: 'Read Only', description: 'No file modifications allowed' },
    'bypassPermissions': { label: 'Bypass All', description: 'Skip all permission checks (unsafe)' },
    'default': { label: 'Default', description: 'Normal permission prompts' },
};

// Render a parsed block using appropriate component
function RenderBlock({ block }: { block: ParsedBlock }) {
    switch (block.type) {
        case 'tool_call':
        case 'tool_result':
            return <ToolCallBlock block={block} />;
        case 'diff':
            return <DiffBlock block={block} />;
        case 'thinking':
            return <ClaudeThinkingBlock block={block} />;
        case 'error':
            return (
                <div className="my-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
                    <pre className="text-xs font-mono text-red-300 whitespace-pre-wrap">
                        {block.content}
                    </pre>
                </div>
            );
        case 'status':
            return (
                <div className="my-2 flex items-center gap-2 text-xs text-emerald-400">
                    <Sparkles size={12} />
                    <span>{block.content}</span>
                </div>
            );
        case 'trust_prompt':
            // We render this specially in the main component if it's the *latest* block, 
            // but here we can render a static "Permission Request" for history.
            return (
                <div className="my-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <div className="flex items-center gap-2 text-amber-300 font-medium text-xs mb-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                        Security Check
                    </div>
                    <pre className="text-[10px] font-mono text-amber-200/80 whitespace-pre-wrap">
                        {block.content.replace(/[│─┌┐┘└├┤┬┴┼]/g, '').replace(/^\s*[\r\n]/gm, '')}
                    </pre>
                </div>
            );
        case 'text':
        default:
            if (!block.content.trim()) return null;
            return (
                <div className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            p: ({ children }) => (
                                <p className="text-[13px] text-zinc-300 my-1.5 leading-relaxed">{children}</p>
                            ),
                            strong: ({ children }) => (
                                <strong className="text-white font-semibold">{children}</strong>
                            ),
                            code: ({ children }) => (
                                <code className="text-[11px] bg-black/40 px-1.5 py-0.5 rounded text-cyan-300 font-mono">
                                    {children}
                                </code>
                            ),
                            pre: ({ children }) => (
                                <pre className="text-[11px] bg-black/40 p-2.5 rounded-lg overflow-x-auto my-2 font-mono">
                                    {children}
                                </pre>
                            ),
                            ul: ({ children }) => (
                                <ul className="text-[13px] list-none ml-0 my-1.5 space-y-1">{children}</ul>
                            ),
                            li: ({ children }) => (
                                <li className="text-zinc-300 before:content-['→'] before:text-emerald-500 before:mr-2">
                                    {children}
                                </li>
                            ),
                        }}
                    >
                        {block.content}
                    </ReactMarkdown>
                </div>
            );
    }
}

interface UserMessage {
    id: string;
    content: string;
    timestamp: Date;
}

export function ClaudeCodePanel({ currentContext, className, onClose, embedded = false }: ClaudeCodePanelProps) {
    // Session state
    const [isSessionActive, setIsSessionActive] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);

    // Permission settings - default to bypassPermissions for K8s operations
    // This is safe because the user is explicitly using this panel to run kubectl commands
    const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode>('bypassPermissions');
    const [showSettings, setShowSettings] = useState(false);

    // UI state
    const [userInput, setUserInput] = useState('');
    const [showRawTerminal, setShowRawTerminal] = useState(false);
    const [showSessionBrowser, setShowSessionBrowser] = useState(false);
    const [rawOutput, setRawOutput] = useState('');

    // Parsed content
    const [blocks, setBlocks] = useState<ParsedBlock[]>([]);
    const [currentBlock, setCurrentBlock] = useState<ParsedBlock | null>(null);
    const [userMessages, setUserMessages] = useState<UserMessage[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);

    // Refs
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const parserRef = useRef<ClaudeOutputParser | null>(null);
    const processingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const messageIdCounter = useRef(0);

    // Initialize parser
    useEffect(() => {
        parserRef.current = new ClaudeOutputParser();
        return () => {
            parserRef.current = null;
        };
    }, []);

    const genId = () => `msg-${++messageIdCounter.current}-${Date.now()}`;

    // Scroll to bottom on new content (using scrollTo to prevent parent window scrolling)
    useEffect(() => {
        if (messagesEndRef.current?.parentElement) {
            const container = messagesEndRef.current.parentElement;
            // Use instant scroll for better UX during typing/streaming, smooth only for large jumps? 
            // Actually smooth is fine but we must ensure we don't scroll the body.
            container.scrollTo({
                top: container.scrollHeight,
                behavior: 'smooth'
            });
        }
    }, [blocks, currentBlock, userMessages]);

    // Streaming text accumulator for content_block_delta messages
    const streamingTextRef = useRef<string>('');
    const currentToolRef = useRef<{ name: string; input: any } | null>(null);

    // Listen for streaming JSON from Claude Code (non-interactive mode)
    // Claude Code CLI outputs: system (init), assistant (message), result (final)
    useEffect(() => {
        const unlistenStream = listen<string>('claude:stream', (event) => {
            const jsonLine = event.payload;
            setRawOutput(prev => prev + jsonLine + '\n');

            try {
                const msg: ClaudeStreamMessage = JSON.parse(jsonLine);

                // Handle Claude Code CLI output format
                switch (msg.type) {
                    case 'system':
                        // System init message - session started
                        if (msg.subtype === 'init') {
                            setIsProcessing(true);
                            // Show immediate feedback - Claude is thinking
                            setCurrentBlock({
                                id: `thinking-${Date.now()}`,
                                type: 'thinking',
                                content: `Using ${msg.model || 'Claude'}...`,
                                status: 'running',
                                timestamp: new Date(),
                                isStreaming: true
                            });
                            console.log('Claude session:', msg.session_id, 'Model:', msg.model);
                        }
                        break;

                    case 'assistant':
                        // Clear thinking indicator when we get actual content
                        setCurrentBlock(null);

                        // Full assistant message with content array
                        if (msg.message?.content && Array.isArray(msg.message.content)) {
                            for (const block of msg.message.content) {
                                if (block.type === 'text' && block.text) {
                                    // Text response
                                    setBlocks(prev => [...prev, {
                                        id: `block-${Date.now()}-${Math.random()}`,
                                        type: 'text',
                                        content: block.text!,
                                        timestamp: new Date()
                                    }]);
                                } else if (block.type === 'tool_use') {
                                    // Tool call - show the tool being invoked
                                    const inputStr = block.input ?
                                        (typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)) : '';
                                    setBlocks(prev => [...prev, {
                                        id: block.id || `tool-${Date.now()}`,
                                        type: 'tool_call',
                                        toolName: block.name,
                                        content: inputStr,
                                        status: 'running',
                                        timestamp: new Date(),
                                        isStreaming: true
                                    }]);
                                }
                            }
                        }
                        break;

                    case 'user':
                        // Tool result from Claude Code execution
                        // This message type contains the output of tool calls
                        if (msg.message?.content && Array.isArray(msg.message.content)) {
                            for (const block of msg.message.content) {
                                if (block.type === 'tool_result') {
                                    const toolUseId = (block as any).tool_use_id;
                                    const resultContent = (block as any).content || '';
                                    const isError = (block as any).is_error || false;

                                    // Update the matching tool call with result and add result block
                                    setBlocks(prev => {
                                        const updated = [...prev];
                                        // Find the tool call by ID and update it
                                        for (let i = updated.length - 1; i >= 0; i--) {
                                            if (updated[i].id === toolUseId ||
                                                (updated[i].type === 'tool_call' && updated[i].status === 'running')) {
                                                updated[i] = {
                                                    ...updated[i],
                                                    status: isError ? 'error' : 'success',
                                                    isStreaming: false
                                                };
                                                // Add tool result as separate block
                                                updated.push({
                                                    id: `result-${toolUseId || Date.now()}`,
                                                    type: 'tool_result',
                                                    toolName: updated[i].toolName,
                                                    content: resultContent,
                                                    status: isError ? 'error' : 'success',
                                                    timestamp: new Date()
                                                });
                                                break;
                                            }
                                        }
                                        return updated;
                                    });
                                }
                            }
                        }
                        break;

                    case 'result':
                        // Final result message - just mark processing complete
                        // Don't add result text since assistant message already has it
                        setIsProcessing(false);
                        setCurrentBlock(null);
                        if (processingTimeoutRef.current) {
                            clearTimeout(processingTimeoutRef.current);
                            processingTimeoutRef.current = null;
                        }

                        // Only show result if it's an error
                        if (msg.is_error && msg.result) {
                            setBlocks(prev => [...prev, {
                                id: `error-${Date.now()}`,
                                type: 'error',
                                content: msg.result!,
                                timestamp: new Date()
                            }]);
                        }
                        break;
                }
            } catch (e) {
                // Not valid JSON - might be plain text output
                console.debug('Non-JSON output from Claude:', jsonLine);
            }
        });

        const unlistenStatus = listen<string>('claude:status', (event) => {
            const status = event.payload;
            if (status === 'starting') {
                setIsProcessing(true);
                setIsSessionActive(true);
            } else if (status === 'completed') {
                setIsProcessing(false);
                if (processingTimeoutRef.current) {
                    clearTimeout(processingTimeoutRef.current);
                    processingTimeoutRef.current = null;
                }
            }
        });

        const unlistenError = listen<string>('claude:error', (event) => {
            const error = event.payload;
            setRawOutput(prev => prev + `[ERROR] ${error}\n`);
            setBlocks(prev => [...prev, {
                id: `error-${Date.now()}`,
                type: 'error',
                content: error,
                timestamp: new Date()
            }]);
        });

        return () => {
            unlistenStream.then(unlisten => unlisten());
            unlistenStatus.then(unlisten => unlisten());
            unlistenError.then(unlisten => unlisten());
        };
    }, []);

    // Start a new Claude session (now just marks as ready - no persistent session needed)
    const startSession = async () => {
        setIsConnecting(true);
        try {
            // Clear previous state
            setBlocks([]);
            setUserMessages([]);
            setRawOutput('');
            streamingTextRef.current = '';
            currentToolRef.current = null;
            if (parserRef.current) {
                parserRef.current.reset();
            }

            // With non-interactive mode, no persistent session needed
            // Each call to call_claude_code spawns a fresh process
            setIsSessionActive(true);
        } catch (err) {
            console.error('Failed to initialize Claude:', err);
        } finally {
            setIsConnecting(false);
        }
    };

    // Send a message to Claude using non-interactive mode
    const sendMessage = async () => {
        const message = userInput.trim();
        if (!message || isProcessing) return;

        // DON'T clear blocks - keep conversation history
        // Only reset streaming state
        setCurrentBlock(null);
        streamingTextRef.current = '';
        currentToolRef.current = null;

        // Add to user messages
        setUserMessages(prev => [...prev, {
            id: genId(),
            content: message,
            timestamp: new Date()
        }]);

        setUserInput('');
        setIsProcessing(true);
        setIsSessionActive(true);

        // Set a safety timeout - Claude Code can take a while for complex tasks
        if (processingTimeoutRef.current) {
            clearTimeout(processingTimeoutRef.current);
        }
        processingTimeoutRef.current = setTimeout(() => {
            setIsProcessing(false);
        }, 120000); // 2 minute timeout for complex operations

        try {
            // Call Claude in non-interactive mode
            // The backend spawns `claude -p --output-format stream-json --permission-mode <mode>`
            await invoke('call_claude_code', {
                prompt: message,
                systemPrompt: currentContext ? `Current Kubernetes context: ${currentContext}` : '',
                permissionMode: permissionMode,
                // For K8s operations, allow common tools
                allowedTools: null // null means all tools allowed within permission mode
            });
        } catch (err) {
            console.error('Failed to send message:', err);
            setBlocks(prev => [...prev, {
                id: `error-${Date.now()}`,
                type: 'error',
                content: `Failed to communicate with Claude: ${err}`,
                timestamp: new Date()
            }]);
            setIsProcessing(false);
            if (processingTimeoutRef.current) {
                clearTimeout(processingTimeoutRef.current);
                processingTimeoutRef.current = null;
            }
        }
    };

    // Handle keyboard shortcuts
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // Clear chat
    const clearChat = () => {
        setBlocks([]);
        setUserMessages([]);
        setRawOutput('');
        setCurrentBlock(null);
        streamingTextRef.current = '';
        currentToolRef.current = null;
        if (parserRef.current) {
            parserRef.current.reset();
        }
    };

    // Handle session resume from browser
    const handleResumeSession = (_projectPath: string) => {
        setShowSessionBrowser(false);
        setIsSessionActive(true);
        // Clear previous state
        setBlocks([]);
        setUserMessages([]);
        setRawOutput('');
        setCurrentBlock(null);
        streamingTextRef.current = '';
        currentToolRef.current = null;
        if (parserRef.current) {
            parserRef.current.reset();
        }
    };

    // Merge text blocks for cleaner display
    const mergedBlocks = useMemo(() => mergeTextBlocks(blocks), [blocks]);

    // Simple approach: show user messages in order, then all response blocks after the last one
    // This works because each call to Claude is independent (non-interactive mode)
    const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;

    return (
        <div className={`flex flex-col h-full ${embedded ? '' : 'bg-[#0a0a0f]'} ${className || ''}`}>
            {/* Header - Only show when not embedded (parent provides header) */}
            {!embedded && (
                <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 flex items-center justify-center border border-violet-500/30">
                            <Bot size={18} className="text-violet-400" />
                        </div>
                        <div>
                            <h2 className="text-sm font-medium text-white">Claude Code</h2>
                            <div className="flex items-center gap-2">
                                {isSessionActive ? (
                                    <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                        Connected
                                    </span>
                                ) : (
                                    <span className="text-[10px] text-zinc-500">Not connected</span>
                                )}
                                {currentContext && (
                                    <span className="text-[10px] text-zinc-600">• {currentContext}</span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-1">
                        {/* Permission mode indicator */}
                        <div className="relative">
                            <button
                                onClick={() => setShowSettings(!showSettings)}
                                className={`p-2 rounded-lg transition-colors flex items-center gap-1.5 ${showSettings ? 'bg-violet-500/20 text-violet-300' : 'hover:bg-zinc-800 text-zinc-400'}`}
                                title={`Permission: ${PERMISSION_MODE_LABELS[permissionMode].label}`}
                            >
                                {permissionMode === 'acceptEdits' && <ShieldCheck size={16} className="text-emerald-400" />}
                                {permissionMode === 'plan' && <Shield size={16} className="text-blue-400" />}
                                {permissionMode === 'bypassPermissions' && <ShieldOff size={16} className="text-red-400" />}
                                {permissionMode === 'default' && <ShieldAlert size={16} className="text-amber-400" />}
                            </button>

                            {/* Settings dropdown */}
                            {showSettings && (
                                <div className="absolute right-0 top-full mt-1 w-56 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 py-1">
                                    <div className="px-3 py-2 border-b border-zinc-800">
                                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Permission Mode</span>
                                    </div>
                                    {(Object.keys(PERMISSION_MODE_LABELS) as ClaudePermissionMode[]).map((mode) => (
                                        <button
                                            key={mode}
                                            onClick={() => {
                                                setPermissionMode(mode);
                                                setShowSettings(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left hover:bg-zinc-800 transition-colors flex items-center gap-2 ${permissionMode === mode ? 'bg-zinc-800' : ''}`}
                                        >
                                            {mode === 'acceptEdits' && <ShieldCheck size={14} className="text-emerald-400" />}
                                            {mode === 'plan' && <Shield size={14} className="text-blue-400" />}
                                            {mode === 'bypassPermissions' && <ShieldOff size={14} className="text-red-400" />}
                                            {mode === 'default' && <ShieldAlert size={14} className="text-amber-400" />}
                                            <div>
                                                <div className="text-xs text-white">{PERMISSION_MODE_LABELS[mode].label}</div>
                                                <div className="text-[10px] text-zinc-500">{PERMISSION_MODE_LABELS[mode].description}</div>
                                            </div>
                                            {permissionMode === mode && (
                                                <span className="ml-auto text-emerald-400">✓</span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Session browser toggle */}
                        <button
                            onClick={() => setShowSessionBrowser(!showSessionBrowser)}
                            className={`p-2 rounded-lg transition-colors ${showSessionBrowser ? 'bg-violet-500/20 text-violet-300' : 'hover:bg-zinc-800 text-zinc-400'
                                }`}
                            title="Previous sessions"
                        >
                            <History size={16} />
                        </button>

                        {/* Raw terminal toggle */}
                        <button
                            onClick={() => setShowRawTerminal(!showRawTerminal)}
                            className={`p-2 rounded-lg transition-colors ${showRawTerminal ? 'bg-violet-500/20 text-violet-300' : 'hover:bg-zinc-800 text-zinc-400'
                                }`}
                            title={showRawTerminal ? 'Chat view' : 'Raw terminal'}
                        >
                            <Terminal size={16} />
                        </button>

                        {/* Clear chat */}
                        <button
                            onClick={clearChat}
                            className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 transition-colors"
                            title="Clear chat"
                        >
                            <Trash2 size={16} />
                        </button>

                        {/* Close button */}
                        {onClose && (
                            <button
                                onClick={onClose}
                                className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 transition-colors"
                            >
                                <X size={16} />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Embedded mode toolbar - minimal controls (Sessions & Clear) */}
            {embedded && (
                <div className="shrink-0 flex items-center justify-end px-3 py-1.5 border-b border-white/5 bg-black/20">
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setShowSessionBrowser(!showSessionBrowser)}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] transition-colors ${showSessionBrowser ? 'bg-violet-500/20 text-violet-300' : 'bg-zinc-800/50 text-zinc-400 hover:text-zinc-300'
                                }`}
                            title="Previous sessions"
                        >
                            <History size={10} />
                            History
                        </button>
                        <button
                            onClick={() => setShowRawTerminal(!showRawTerminal)}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] transition-colors ${showRawTerminal ? 'bg-violet-500/20 text-violet-300' : 'bg-zinc-800/50 text-zinc-400 hover:text-zinc-300'
                                }`}
                            title={showRawTerminal ? 'Chat view' : 'Raw terminal'}
                        >
                            <Terminal size={10} />
                            {showRawTerminal ? 'Chat' : 'Terminal'}
                        </button>
                        <button
                            onClick={clearChat}
                            className="p-1.5 rounded hover:bg-rose-500/10 text-zinc-400 hover:text-rose-400 transition-colors"
                            title="Clear chat"
                        >
                            <Trash2 size={10} />
                        </button>
                    </div>
                </div>
            )}

            {/* Main content area - flex row for sidebar + chat */}
            <div className="flex-1 flex min-h-0">
                {/* Session browser sidebar */}
                {showSessionBrowser && (
                    <div className="w-64 border-r border-zinc-800 overflow-y-auto shrink-0">
                        <SessionBrowser
                            onResumeSession={handleResumeSession}
                            className="h-full"
                        />
                    </div>
                )}

                {/* Chat/Terminal area - column layout */}
                <div className="flex-1 flex flex-col min-w-0 min-h-0">
                    {/* Messages - scrollable area */}
                    <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-4">
                        {showRawTerminal ? (
                            // Raw terminal output (for debugging)
                            <div className="font-mono text-xs text-zinc-300 whitespace-pre-wrap bg-black/40 rounded-lg p-4 min-h-[300px]">
                                {rawOutput || <span className="text-zinc-500">Waiting for output...</span>}
                            </div>
                        ) : (
                            // Chat view
                            <>
                                {/* Empty state - show when no user messages sent yet */}
                                {userMessages.length === 0 && (
                                    <div className="flex flex-col items-center justify-center h-full text-center py-12">
                                        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 flex items-center justify-center mb-4 border border-violet-500/30">
                                            <Sparkles size={28} className="text-violet-400" />
                                        </div>
                                        <h3 className="text-lg font-medium text-white mb-2">Claude Code</h3>
                                        <p className="text-sm text-zinc-500 max-w-sm mb-6">
                                            An AI assistant powered by Claude. Ask questions about your codebase, run commands, edit files, and more.
                                        </p>
                                        {isConnecting && (
                                            <div className="flex items-center gap-2 text-violet-400">
                                                <Loader2 size={16} className="animate-spin" />
                                                <span className="text-sm">Starting session...</span>
                                            </div>
                                        )}
                                        {isSessionActive && !isConnecting && (
                                            <div className="flex items-center gap-2 text-emerald-400">
                                                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                                <span className="text-sm">Ready - type a message below</span>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* User message - show the last one */}
                                {lastUserMessage && (
                                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                                        <div className="relative pl-6 pb-4">
                                            <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-violet-500 ring-4 ring-violet-500/20" />
                                            <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-violet-500/50 to-transparent" />
                                            <div className="ml-2">
                                                <div className="bg-gradient-to-br from-violet-600/20 to-fuchsia-600/20 rounded-lg px-3 py-2 border border-violet-500/30">
                                                    <p className="text-sm text-white whitespace-pre-wrap">{lastUserMessage.content}</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Response blocks */}
                                {mergedBlocks.length > 0 && (
                                    <div className="relative pl-6 pb-4">
                                        <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20" />
                                        <div className="ml-2">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Sparkles size={10} className="text-emerald-400" />
                                            </div>
                                            <div className="space-y-2">
                                                {mergedBlocks.map((block) => (
                                                    <div key={block.id} className="animate-in fade-in duration-200">
                                                        <RenderBlock block={block} />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Current streaming block - only show when user has sent messages */}
                                {userMessages.length > 0 && currentBlock && (
                                    <div className="relative pl-6 pb-4 animate-in fade-in duration-200">
                                        <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20 animate-pulse" />
                                        <div className="ml-2">
                                            <RenderBlock block={currentBlock} />
                                        </div>
                                    </div>
                                )}

                                {/* Processing indicator */}
                                {userMessages.length > 0 && isProcessing && !currentBlock && (
                                    <div className="relative pl-6 pb-4 animate-in fade-in duration-300">
                                        <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-violet-500 ring-4 ring-violet-500/20 animate-pulse" />
                                        <div className="ml-2">
                                            <div className="flex items-center gap-2 text-violet-400">
                                                <Loader2 size={12} className="animate-spin" />
                                                <span className="text-xs font-medium">Claude is working...</span>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div ref={messagesEndRef} />
                            </>
                        )}
                    </div>

                    {/* Input area */}
                    <div className="relative z-20 p-4 bg-[#16161a] border-t border-white/5">
                        <div className={`flex items-center gap-2 p-1.5 bg-white/5 border border-white/10 rounded-full shadow-lg shadow-black/20 backdrop-blur-md transition-all duration-300 ${isConnecting ? 'opacity-50 cursor-not-allowed' : 'focus-within:border-violet-500/30 focus-within:bg-white/10'}`}>
                            <textarea
                                ref={inputRef}
                                value={userInput}
                                onChange={(e) => setUserInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={isSessionActive ? "Ask Claude anything..." : "Start a session to begin..."}
                                disabled={isConnecting}
                                rows={1}
                                className="flex-1 px-4 py-2 bg-transparent border-none text-white text-sm placeholder-zinc-500 focus:outline-none min-w-0 resize-none disabled:cursor-not-allowed"
                                style={{ minHeight: '40px', maxHeight: '120px' }}
                            />
                            <button
                                onClick={() => sendMessage()}
                                disabled={!userInput.trim() || isProcessing || isConnecting}
                                className="p-2.5 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-500 text-white transition-all duration-200 shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 disabled:shadow-none hover:scale-105 disabled:hover:scale-100 flex-shrink-0"
                            >
                                {isProcessing ? (
                                    <Loader2 size={16} className="animate-spin" />
                                ) : (
                                    <Send size={16} />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
