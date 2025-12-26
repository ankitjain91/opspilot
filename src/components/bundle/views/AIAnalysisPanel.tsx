/**
 * AIAnalysisPanel - AI-powered bundle analysis chat using Claude CLI
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, Send, X, Loader2, AlertTriangle, CheckCircle, RefreshCw, Terminal, Settings, ExternalLink, Trash2, Minimize2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useBundleContext } from '../BundleContext';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

interface AIAnalysisPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onMinimize?: () => void;
}

type ClaudeStatus = 'checking' | 'ready' | 'not-installed' | 'not-logged-in';

export function AIAnalysisPanel({ isOpen, onClose, onMinimize }: AIAnalysisPanelProps) {
    const { bundle, events, alerts, nodes, namespaces, resources, health } = useBundleContext();
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus>('checking');
    const [showSetup, setShowSetup] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Check Claude CLI status on mount
    useEffect(() => {
        if (!isOpen) return;
        checkClaudeStatus();
    }, [isOpen]);

    const checkClaudeStatus = async () => {
        setClaudeStatus('checking');
        try {
            // Check if claude CLI exists and is logged in
            const cmd = Command.create('claude-check', ['--version']);
            const result = await cmd.execute();

            if (result.code !== 0) {
                setClaudeStatus('not-installed');
                return;
            }

            // Quick login check - try a simple command
            const loginCmd = Command.create('claude-login-check', ['-p', '--output-format', 'json', 'echo test']);
            const loginResult = await loginCmd.execute();

            if (loginResult.stderr?.includes('not logged in') || loginResult.stderr?.includes('authenticate')) {
                setClaudeStatus('not-logged-in');
            } else {
                setClaudeStatus('ready');
            }
        } catch {
            // If command doesn't exist at all
            setClaudeStatus('not-installed');
        }
    };

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const buildContext = useCallback(() => {
        if (!bundle) return '';

        const warningEvents = events.filter(e => e.event_type === 'Warning');
        const criticalAlerts = alerts?.critical || [];

        // Count resources by type
        const resourceCounts: Record<string, number> = {};
        Object.values(resources).forEach(resList => {
            resList.forEach(r => {
                resourceCounts[r.kind] = (resourceCounts[r.kind] || 0) + 1;
            });
        });

        // Find failing pods
        const failingPods = Object.values(resources)
            .flat()
            .filter(r => r.kind === 'Pod' && ['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff'].includes(r.status_phase || ''));

        return `
Kubernetes Support Bundle Analysis Context:
- Bundle: ${bundle.path.split('/').pop()}
- Total Resources: ${bundle.total_resources}
- Namespaces: ${namespaces.length} (${namespaces.map(n => n.name).join(', ')})
- Nodes: ${nodes.length}

Resource Counts:
${Object.entries(resourceCounts).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}

Issues Summary:
- Warning Events: ${warningEvents.length}
- Critical Alerts: ${criticalAlerts.length}
- Failing Pods: ${failingPods.length}

${warningEvents.length > 0 ? `Top Warning Events:\n${warningEvents.slice(0, 5).map(e => `  - ${e.reason}: ${e.message.slice(0, 100)}`).join('\n')}` : ''}

${criticalAlerts.length > 0 ? `Critical Alerts:\n${criticalAlerts.slice(0, 5).map(a => `  - ${a.name}: ${a.message || ''}`).join('\n')}` : ''}

${failingPods.length > 0 ? `Failing Pods:\n${failingPods.slice(0, 5).map(p => `  - ${p.namespace}/${p.name}: ${p.status_phase}`).join('\n')}` : ''}
        `.trim();
    }, [bundle, events, alerts, nodes, namespaces, resources]);

    const sendMessage = useCallback(async () => {
        if (!input.trim() || loading || !bundle) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: input.trim(),
            timestamp: new Date()
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setLoading(true);

        try {
            const context = buildContext();
            const response = await invoke<string>('ai_analyze_bundle', {
                bundlePath: bundle.path,
                query: input.trim(),
                context
            });

            const assistantMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: response,
                timestamp: new Date()
            };

            setMessages(prev => [...prev, assistantMessage]);
        } catch (err) {
            const errorMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: `Error: ${err}. Make sure an AI model is configured in settings.`,
                timestamp: new Date()
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setLoading(false);
        }
    }, [input, loading, bundle, buildContext]);

    const runAutoAnalysis = useCallback(async () => {
        if (!bundle || analyzing) return;

        setAnalyzing(true);
        const analysisMessage: Message = {
            id: Date.now().toString(),
            role: 'assistant',
            content: 'Analyzing bundle for issues...',
            timestamp: new Date()
        };
        setMessages([analysisMessage]);

        try {
            const context = buildContext();
            const response = await invoke<string>('ai_analyze_bundle', {
                bundlePath: bundle.path,
                query: 'Analyze this Kubernetes cluster support bundle and identify the top issues, potential root causes, and recommended fixes. Focus on critical issues first.',
                context
            });

            setMessages([{
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: response,
                timestamp: new Date()
            }]);
        } catch (err) {
            setMessages([{
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: `Error running analysis: ${err}. Make sure an AI model is configured in settings.`,
                timestamp: new Date()
            }]);
        } finally {
            setAnalyzing(false);
        }
    }, [bundle, analyzing, buildContext]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    if (!isOpen) return null;

    // Setup panel when Claude CLI isn't ready
    const SetupPanel = () => (
        <div className="p-6 space-y-6">
            <div className="text-center">
                <Terminal size={48} className="mx-auto mb-4 text-purple-400" />
                <h3 className="text-lg font-bold text-white mb-2">Claude CLI Setup</h3>
                <p className="text-sm text-zinc-400">
                    Bundle AI analysis uses Claude CLI with your Claude subscription.
                </p>
            </div>

            <div className="space-y-4">
                {claudeStatus === 'not-installed' && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
                        <div className="flex items-start gap-3">
                            <AlertTriangle size={20} className="text-amber-400 shrink-0 mt-0.5" />
                            <div>
                                <div className="font-medium text-amber-300 mb-1">Claude CLI Not Installed</div>
                                <div className="text-xs text-zinc-400 mb-3">
                                    Install Claude CLI to use AI analysis:
                                </div>
                                <code className="block bg-black/40 px-3 py-2 rounded text-xs text-emerald-300 font-mono">
                                    npm install -g @anthropic-ai/claude-code
                                </code>
                            </div>
                        </div>
                    </div>
                )}

                {claudeStatus === 'not-logged-in' && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
                        <div className="flex items-start gap-3">
                            <AlertTriangle size={20} className="text-amber-400 shrink-0 mt-0.5" />
                            <div>
                                <div className="font-medium text-amber-300 mb-1">Not Logged In</div>
                                <div className="text-xs text-zinc-400 mb-3">
                                    Run this command in your terminal to log in:
                                </div>
                                <code className="block bg-black/40 px-3 py-2 rounded text-xs text-emerald-300 font-mono">
                                    claude login
                                </code>
                            </div>
                        </div>
                    </div>
                )}

                <div className="bg-zinc-800/50 rounded-xl p-4">
                    <h4 className="text-sm font-medium text-white mb-2">About Claude CLI</h4>
                    <ul className="space-y-2 text-xs text-zinc-400">
                        <li className="flex items-start gap-2">
                            <CheckCircle size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                            Uses your Claude Pro/Team subscription
                        </li>
                        <li className="flex items-start gap-2">
                            <CheckCircle size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                            No API key required
                        </li>
                        <li className="flex items-start gap-2">
                            <CheckCircle size={14} className="text-emerald-400 shrink-0 mt-0.5" />
                            Secure local processing
                        </li>
                    </ul>
                </div>

                <div className="flex gap-2">
                    <button
                        onClick={checkClaudeStatus}
                        className="flex-1 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
                    >
                        <RefreshCw size={14} />
                        Check Again
                    </button>
                    <a
                        href="https://claude.ai/claude-code"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium transition-colors flex items-center gap-2"
                    >
                        Learn More <ExternalLink size={12} />
                    </a>
                </div>
            </div>
        </div>
    );

    return (
        <div className="fixed inset-y-0 right-0 w-[450px] bg-zinc-950 border-l border-zinc-800 flex flex-col z-40 shadow-2xl">
            {/* Header */}
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                        <Sparkles size={18} className="text-purple-400" />
                        <span className="font-medium text-white">AI Analysis</span>
                    </div>
                    {/* Claude Status Badge */}
                    {claudeStatus === 'checking' && (
                        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 text-[10px]">
                            <Loader2 size={10} className="animate-spin" />
                            Checking...
                        </div>
                    )}
                    {claudeStatus === 'ready' && (
                        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px]">
                            <CheckCircle size={10} />
                            Claude Ready
                        </div>
                    )}
                    {(claudeStatus === 'not-installed' || claudeStatus === 'not-logged-in') && (
                        <button
                            onClick={() => setShowSetup(true)}
                            className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] hover:bg-amber-500/30 transition-colors"
                        >
                            <AlertTriangle size={10} />
                            Setup Required
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    {/* Clear Chat */}
                    {messages.length > 0 && (
                        <button
                            onClick={() => setMessages([])}
                            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-colors"
                            title="Clear chat"
                        >
                            <Trash2 size={14} />
                        </button>
                    )}
                    <button
                        onClick={() => setShowSetup(!showSetup)}
                        className={`p-1.5 rounded transition-colors ${showSetup ? 'bg-purple-600 text-white' : 'hover:bg-zinc-800 text-zinc-400'}`}
                        title="Claude CLI Setup"
                    >
                        <Settings size={14} />
                    </button>
                    <button
                        onClick={runAutoAnalysis}
                        disabled={analyzing || claudeStatus !== 'ready'}
                        className="px-2.5 py-1 rounded-lg text-[10px] font-medium bg-purple-600 hover:bg-purple-700 text-white transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                        {analyzing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                        Analyze
                    </button>
                    {/* Minimize to pill */}
                    {onMinimize && (
                        <button
                            onClick={onMinimize}
                            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
                            title="Minimize"
                        >
                            <Minimize2 size={14} />
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
                        title="Close"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>

            {/* Show setup panel if needed */}
            {showSetup ? (
                <div className="flex-1 overflow-auto">
                    <SetupPanel />
                </div>
            ) : claudeStatus !== 'ready' && claudeStatus !== 'checking' ? (
                <div className="flex-1 overflow-auto">
                    <SetupPanel />
                </div>
            ) : (
                <>

            {/* Quick Questions */}
            <div className="p-3 border-b border-zinc-800 flex gap-2 flex-wrap">
                {[
                    'What are the critical issues?',
                    'Why are pods failing?',
                    'Storage problems?',
                    'Network issues?'
                ].map(q => (
                    <button
                        key={q}
                        onClick={() => {
                            setInput(q);
                            setTimeout(() => sendMessage(), 100);
                        }}
                        className="px-2 py-1 rounded text-[10px] bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
                    >
                        {q}
                    </button>
                ))}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-auto p-4 space-y-4">
                {messages.length === 0 ? (
                    <div className="text-center py-8 text-zinc-500">
                        <Sparkles size={32} className="mx-auto mb-3 opacity-50" />
                        <div className="text-sm">Ask questions about your bundle</div>
                        <div className="text-xs mt-1">or click Auto-Analyze for a full report</div>
                    </div>
                ) : (
                    messages.map(msg => (
                        <div
                            key={msg.id}
                            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            <div className={`max-w-[85%] rounded-xl p-3 ${
                                msg.role === 'user'
                                    ? 'bg-purple-600 text-white'
                                    : 'bg-zinc-800 text-zinc-200'
                            }`}>
                                {msg.role === 'user' ? (
                                    <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
                                ) : (
                                    <div
                                        className="text-sm prose prose-invert prose-sm max-w-none
                                            prose-headings:text-white prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-2
                                            prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                                            prose-p:my-2 prose-p:leading-relaxed
                                            prose-ul:my-2 prose-ul:pl-4 prose-ol:my-2 prose-ol:pl-4
                                            prose-li:my-0.5 prose-li:marker:text-purple-400
                                            prose-code:bg-black/40 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-emerald-300 prose-code:text-xs prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
                                            prose-strong:text-white prose-strong:font-semibold
                                            prose-a:text-purple-400 prose-a:no-underline hover:prose-a:underline
                                            prose-blockquote:border-l-purple-500 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-zinc-400
                                            prose-hr:border-zinc-700 prose-hr:my-3
                                            prose-table:text-xs prose-th:text-left prose-th:text-zinc-300 prose-td:text-zinc-400
                                        "
                                        style={{
                                            wordBreak: 'break-word',
                                            overflowWrap: 'anywhere'
                                        }}
                                    >
                                        <ReactMarkdown
                                            remarkPlugins={[remarkGfm]}
                                            components={{
                                                pre: ({ children }) => (
                                                    <pre className="bg-black/40 p-3 rounded-lg my-2 overflow-x-auto" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                                        {children}
                                                    </pre>
                                                ),
                                                code: ({ className, children, ...props }) => {
                                                    const isInline = !className;
                                                    return isInline ? (
                                                        <code className="bg-black/40 px-1.5 py-0.5 rounded text-emerald-300 text-xs font-mono" style={{ wordBreak: 'break-all' }} {...props}>
                                                            {children}
                                                        </code>
                                                    ) : (
                                                        <code className="text-emerald-300 text-xs font-mono block" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }} {...props}>
                                                            {children}
                                                        </code>
                                                    );
                                                }
                                            }}
                                        >
                                            {msg.content}
                                        </ReactMarkdown>
                                    </div>
                                )}
                                <div className={`text-[10px] mt-2 ${
                                    msg.role === 'user' ? 'text-purple-200' : 'text-zinc-500'
                                }`}>
                                    {msg.timestamp.toLocaleTimeString()}
                                </div>
                            </div>
                        </div>
                    ))
                )}
                {loading && (
                    <div className="flex justify-start">
                        <div className="bg-zinc-800 rounded-xl p-3 flex items-center gap-2">
                            <Loader2 size={14} className="animate-spin text-purple-400" />
                            <span className="text-sm text-zinc-400">Analyzing...</span>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-4 border-t border-zinc-800">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask about the bundle..."
                        className="flex-1 px-4 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                        disabled={loading || claudeStatus !== 'ready'}
                    />
                    <button
                        onClick={sendMessage}
                        disabled={!input.trim() || loading || claudeStatus !== 'ready'}
                        className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white transition-colors disabled:opacity-50"
                    >
                        <Send size={16} />
                    </button>
                </div>
            </div>
            </>
            )}
        </div>
    );
}
