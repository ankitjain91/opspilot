import React, { useState, useEffect, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
    Terminal,
    Loader2,
    Bot,
    User,
    Sparkles,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ClaudeOutputParser, ParsedBlock, mergeTextBlocks, stripAnsi } from '../claudeParser';
import { ToolCallBlock } from './ToolCallBlock';
import { DiffBlock } from './DiffBlock';
import { ClaudeThinkingBlock } from './ClaudeThinkingBlock';

// Types for parsed Claude Code messages
export interface ClaudeCodeMessage {
    id: string;
    type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking' | 'status';
    content: string;
    timestamp: Date;
    toolName?: string;
    command?: string;
    isStreaming?: boolean;
}

interface ClaudeCodeChatViewProps {
    userMessages: Array<{ content: string; timestamp: Date }>;
    onSendMessage?: (message: string) => void;
    className?: string;
}

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
        case 'text':
        default:
            // Render text as markdown
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

// Main Chat View Component
export function ClaudeCodeChatView({
    userMessages,
    className
}: ClaudeCodeChatViewProps) {
    // Parsed blocks from Claude output
    const [blocks, setBlocks] = useState<ParsedBlock[]>([]);
    const [currentBlock, setCurrentBlock] = useState<ParsedBlock | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [showRawTerminal, setShowRawTerminal] = useState(false);
    const [rawOutput, setRawOutput] = useState('');

    // User messages displayed in chat
    const [displayedUserMessages, setDisplayedUserMessages] = useState<Array<{
        id: string;
        content: string;
        timestamp: Date;
    }>>([]);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const parserRef = useRef<ClaudeOutputParser | null>(null);
    const messageIdCounter = useRef(0);

    // Initialize parser
    useEffect(() => {
        parserRef.current = new ClaudeOutputParser();
        return () => {
            parserRef.current = null;
        };
    }, []);

    // Generate unique message ID
    const genId = () => `msg-${++messageIdCounter.current}-${Date.now()}`;

    // Scroll to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [blocks, currentBlock]);

    // Add user messages to the chat
    useEffect(() => {
        if (userMessages.length > 0) {
            const lastUserMsg = userMessages[userMessages.length - 1];
            // Check if we already have this message
            const exists = displayedUserMessages.some(m =>
                m.content === lastUserMsg.content &&
                Math.abs(m.timestamp.getTime() - lastUserMsg.timestamp.getTime()) < 1000
            );

            if (!exists) {
                setDisplayedUserMessages(prev => [...prev, {
                    id: genId(),
                    content: lastUserMsg.content,
                    timestamp: lastUserMsg.timestamp
                }]);
                setIsProcessing(true);
                // Reset parser for new conversation turn
                if (parserRef.current) {
                    // Don't reset - keep accumulated blocks
                    // parserRef.current.reset();
                }
            }
        }
    }, [userMessages, displayedUserMessages]);

    // Listen for terminal data from Claude Code
    useEffect(() => {
        const unlistenPromise = listen<string>('agent:terminal:data', (event) => {
            const data = event.payload;
            setRawOutput(prev => prev + data);

            // Parse with our enhanced parser
            if (parserRef.current) {
                const newBlocks = parserRef.current.processChunk(data);
                if (newBlocks.length > 0) {
                    setBlocks(prev => [...prev, ...newBlocks]);
                }
                setCurrentBlock(parserRef.current.getCurrentBlock());
            }

            // Detect completion patterns
            const stripped = stripAnsi(data);
            if (stripped.includes('[Claude Session') ||
                stripped.includes('> ') ||
                stripped.includes('❯') ||
                stripped.match(/^\s*$/m)) {
                // Might be done - check if no active block
                if (parserRef.current && !parserRef.current.getCurrentBlock()) {
                    setIsProcessing(false);
                }
            }
        });

        return () => {
            unlistenPromise.then(unlisten => unlisten());
        };
    }, []);

    // Merge text blocks for cleaner display
    const mergedBlocks = useMemo(() => mergeTextBlocks(blocks), [blocks]);

    // Group blocks by user message (simple grouping: all blocks after a user message until next user message)
    const groupedContent = useMemo(() => {
        const groups: Array<{
            userMessage?: typeof displayedUserMessages[0];
            blocks: ParsedBlock[];
        }> = [];

        let currentGroup: typeof groups[0] = { blocks: [] };
        let blockIndex = 0;

        for (const userMsg of displayedUserMessages) {
            // Save previous group if it has content
            if (currentGroup.userMessage || currentGroup.blocks.length > 0) {
                groups.push(currentGroup);
            }

            // Start new group with user message
            currentGroup = { userMessage: userMsg, blocks: [] };

            // Add blocks that came after this user message (by timestamp)
            while (blockIndex < mergedBlocks.length &&
                mergedBlocks[blockIndex].timestamp >= userMsg.timestamp) {
                currentGroup.blocks.push(mergedBlocks[blockIndex]);
                blockIndex++;
            }
        }

        // Add remaining blocks to current group
        while (blockIndex < mergedBlocks.length) {
            currentGroup.blocks.push(mergedBlocks[blockIndex]);
            blockIndex++;
        }

        // Push final group
        if (currentGroup.userMessage || currentGroup.blocks.length > 0) {
            groups.push(currentGroup);
        }

        return groups;
    }, [displayedUserMessages, mergedBlocks]);

    return (
        <div className={`flex flex-col overflow-hidden ${className || ''} bg-transparent`}>
            {/* Minimal Toolbar for View Toggle (Optional, can be improved later) */}
            <div className="shrink-0 flex items-center justify-end px-3 py-1.5 border-b border-white/5 bg-black/20">
                <button
                    onClick={() => setShowRawTerminal(!showRawTerminal)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] transition-colors ${showRawTerminal
                            ? 'bg-violet-500/20 text-violet-300'
                            : 'bg-zinc-800/50 text-zinc-400 hover:text-zinc-300'
                        }`}
                >
                    <Terminal size={10} />
                    {showRawTerminal ? 'Chat View' : 'Raw Terminal'}
                </button>
            </div>

            {/* Content Area - scrollable */}
            <div className="flex-1 min-h-0 overflow-y-auto p-0 pb-4 space-y-0">
                {showRawTerminal ? (
                    // Raw Terminal Output
                    <div className="font-mono text-xs text-zinc-300 whitespace-pre-wrap bg-black/40 p-4 min-h-full">
                        {rawOutput || <span className="text-zinc-500">Waiting for output...</span>}
                    </div>
                ) : (
                    // Chat View
                    <div className="pt-4">
                        {displayedUserMessages.length === 0 && blocks.length === 0 && !isProcessing && (
                            <div className="flex flex-col items-center justify-center pt-12 px-6 text-center">
                                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 flex items-center justify-center mb-4 border border-violet-500/20">
                                    <Sparkles size={24} className="text-violet-400" />
                                </div>
                                <h3 className="text-sm font-medium text-zinc-300 mb-1">Claude Code Ready</h3>
                                <p className="text-xs text-zinc-500 max-w-xs">
                                    Ask me to investigate issues, run commands, or analyze your cluster using the 10x Agent capabilities.
                                </p>
                            </div>
                        )}

                        {/* Render grouped content */}
                        {groupedContent.map((group, groupIdx) => (
                            <div key={groupIdx} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                                {/* User message */}
                                {group.userMessage && (
                                    <div className="relative pl-6 pb-4">
                                        <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-violet-500 ring-4 ring-violet-500/20" />
                                        <div className="absolute left-[5px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-violet-500/50 to-transparent" />
                                        <div className="ml-2">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-[10px] font-medium text-violet-400 uppercase tracking-wider">Task</span>
                                            </div>
                                            <div className="bg-gradient-to-br from-violet-600/20 to-fuchsia-600/20 rounded-lg px-3 py-2 border border-violet-500/30">
                                                <p className="text-sm text-white">{group.userMessage.content}</p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Assistant blocks */}
                                {group.blocks.length > 0 && (
                                    <div className="relative pl-6 pb-4">
                                        <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20" />
                                        <div className="ml-2">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="text-[10px] font-medium text-emerald-400 uppercase tracking-wider">Claude</span>
                                                <Sparkles size={10} className="text-emerald-400" />
                                            </div>
                                            <div className="space-y-2">
                                                {group.blocks.map((block) => (
                                                    <div key={block.id} className="animate-in fade-in duration-200">
                                                        <RenderBlock block={block} />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}

                        {/* Current streaming block */}
                        {currentBlock && (
                            <div className="relative pl-6 pb-4 animate-in fade-in duration-200">
                                <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20 animate-pulse" />
                                <div className="ml-2">
                                    <RenderBlock block={currentBlock} />
                                </div>
                            </div>
                        )}

                        {/* Processing indicator */}
                        {isProcessing && !currentBlock && (
                            <div className="relative pl-6 pb-4 animate-in fade-in duration-300">
                                <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-violet-500 ring-4 ring-violet-500/20 animate-pulse" />
                                <div className="ml-2">
                                    <div className="flex items-center gap-2 text-violet-400">
                                        <Loader2 size={12} className="animate-spin" />
                                        <span className="text-xs font-medium">Processing...</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>
                )}
            </div>
        </div>
    );
}
