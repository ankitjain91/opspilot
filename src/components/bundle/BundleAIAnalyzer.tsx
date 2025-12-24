import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { getAgentServerUrl } from '../../utils/config';
import {
    Brain, Loader2, AlertCircle, Sparkles, ChevronRight,
    MessageSquare, Send, X, Zap, CheckCircle, AlertTriangle,
    Target, Lightbulb, RefreshCw, Copy, Check, Database, Clock
} from 'lucide-react';
import type {
    BundleHealthSummary, BundleAlerts, BundleEvent, BundleResource
} from './types';

// ============================================================================
// PERSISTENT STORAGE
// ============================================================================

interface StoredAnalysis {
    analysis: AnalysisResult;
    messages: StoredMessage[];
    timestamp: number;
    bundleHash: string;
}

interface StoredMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number; // Store as number for JSON serialization
}

/**
 * Generate a simple hash for bundle identification.
 * Uses bundle path + health score + pod count for uniqueness.
 */
function generateBundleHash(bundlePath: string, healthScore: number, totalPods: number): string {
    const str = `${bundlePath}|${healthScore}|${totalPods}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return `bundle_analysis_${Math.abs(hash).toString(16)}`;
}

/**
 * Load stored analysis from localStorage.
 */
function loadStoredAnalysis(bundleHash: string): StoredAnalysis | null {
    try {
        const stored = localStorage.getItem(bundleHash);
        if (!stored) return null;

        const data = JSON.parse(stored) as StoredAnalysis;

        // Verify the hash matches (sanity check)
        if (data.bundleHash !== bundleHash) return null;

        return data;
    } catch (e) {
        console.error('Failed to load stored analysis:', e);
        return null;
    }
}

/**
 * Save analysis to localStorage.
 */
function saveAnalysis(bundleHash: string, analysis: AnalysisResult, messages: Message[]): void {
    try {
        const data: StoredAnalysis = {
            analysis,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
                timestamp: m.timestamp.getTime()
            })),
            timestamp: Date.now(),
            bundleHash
        };
        localStorage.setItem(bundleHash, JSON.stringify(data));
    } catch (e) {
        console.error('Failed to save analysis:', e);
    }
}

/**
 * Clear stored analysis for a bundle.
 */
function clearStoredAnalysis(bundleHash: string): void {
    try {
        localStorage.removeItem(bundleHash);
    } catch (e) {
        console.error('Failed to clear stored analysis:', e);
    }
}

// ============================================================================
// TYPES
// ============================================================================

interface BundleContext {
    healthSummary: BundleHealthSummary | null;
    alerts: BundleAlerts | null;
    events: BundleEvent[];
    overview: {
        healthScore: number;
        totalPods: number;
        failingPods: number;
        pendingPods: number;
        warningEvents: number;
        criticalAlerts: number;
    };
    namespaces: string[];
}

interface AnalysisResult {
    summary: string;
    rootCauses: {
        issue: string;
        likelihood: 'high' | 'medium' | 'low';
        explanation: string;
    }[];
    recommendations: {
        priority: 'critical' | 'high' | 'medium' | 'low';
        action: string;
        rationale: string;
    }[];
    affectedComponents: string[];
}

interface Message {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

interface BundleAIAnalyzerProps {
    bundlePath: string;
    context: BundleContext;
    onClose?: () => void;
}

// ============================================================================
// BUNDLE SUMMARY GENERATOR (Token Optimization)
// ============================================================================

/**
 * Generates a compact, token-efficient summary of the bundle state.
 * This is the KEY to minimizing LLM token usage while maximizing insight.
 *
 * Target: ~500-800 tokens for the summary, leaving room for user questions
 * and AI responses within a reasonable context window.
 */
function generateBundleSummary(context: BundleContext): string {
    const { healthSummary, alerts, events, overview, namespaces } = context;
    const lines: string[] = [];

    // Header with health score
    lines.push(`## Kubernetes Support Bundle Analysis`);
    lines.push(`Health Score: ${overview.healthScore}/100`);
    lines.push(`Namespaces: ${namespaces.length} (${namespaces.slice(0, 5).join(', ')}${namespaces.length > 5 ? '...' : ''})`);
    lines.push('');

    // Pod Status Summary (compact)
    lines.push(`### Pod Status`);
    lines.push(`Total: ${overview.totalPods} | Failing: ${overview.failingPods} | Pending: ${overview.pendingPods}`);

    // Group failing pods by issue type for efficiency
    if (healthSummary?.failing_pods?.length) {
        const byReason = new Map<string, { count: number; examples: string[] }>();

        for (const pod of healthSummary.failing_pods) {
            const reason = pod.reason || pod.status || 'Unknown';
            const existing = byReason.get(reason) || { count: 0, examples: [] };
            existing.count++;
            if (existing.examples.length < 2) {
                existing.examples.push(`${pod.namespace}/${pod.name}`);
            }
            byReason.set(reason, existing);
        }

        lines.push('');
        lines.push('Failing Pods by Reason:');
        for (const [reason, data] of byReason) {
            lines.push(`- ${reason}: ${data.count} pods (e.g., ${data.examples.join(', ')})`);
        }
    }

    // Unhealthy Deployments (compact)
    if (healthSummary?.unhealthy_deployments?.length) {
        lines.push('');
        lines.push(`### Unhealthy Deployments (${healthSummary.unhealthy_deployments.length})`);
        for (const dep of healthSummary.unhealthy_deployments.slice(0, 5)) {
            lines.push(`- ${dep.namespace}/${dep.name}: ${dep.ready_replicas}/${dep.desired_replicas} ready`);
        }
        if (healthSummary.unhealthy_deployments.length > 5) {
            lines.push(`  ... and ${healthSummary.unhealthy_deployments.length - 5} more`);
        }
    }

    // Alerts Summary (compact)
    if (alerts?.critical?.length || alerts?.warning?.length) {
        lines.push('');
        lines.push(`### Alerts`);
        lines.push(`Critical: ${alerts?.critical?.length || 0} | Warning: ${alerts?.warning?.length || 0}`);

        // Show top critical alerts
        if (alerts?.critical?.length) {
            lines.push('Critical Alerts:');
            for (const alert of alerts.critical.slice(0, 3)) {
                const ns = alert.labels['namespace'] || 'cluster';
                lines.push(`- [${ns}] ${alert.name}: ${alert.message?.slice(0, 100) || 'No message'}`);
            }
        }
    }

    // Warning Events Summary (grouped by reason)
    const warningEvents = events.filter(e => e.event_type === 'Warning');
    if (warningEvents.length > 0) {
        lines.push('');
        lines.push(`### Warning Events (${warningEvents.length} total)`);

        // Group by reason
        const byReason = new Map<string, { count: number; totalCount: number; example: string }>();
        for (const event of warningEvents) {
            const existing = byReason.get(event.reason) || { count: 0, totalCount: 0, example: '' };
            existing.count++;
            existing.totalCount += event.count;
            if (!existing.example) {
                existing.example = event.message?.slice(0, 80) || '';
            }
            byReason.set(event.reason, existing);
        }

        // Sort by frequency and show top reasons
        const sorted = [...byReason.entries()].sort((a, b) => b[1].totalCount - a[1].totalCount);
        for (const [reason, data] of sorted.slice(0, 5)) {
            lines.push(`- ${reason}: ${data.count} events (${data.totalCount} occurrences)`);
            if (data.example) {
                lines.push(`  Example: "${data.example}..."`);
            }
        }
    }

    // Pending PVCs
    if (healthSummary?.pending_pvcs?.length) {
        lines.push('');
        lines.push(`### Pending PVCs (${healthSummary.pending_pvcs.length})`);
        lines.push(healthSummary.pending_pvcs.slice(0, 5).join(', '));
    }

    return lines.join('\n');
}

/**
 * Generates a focused context for a specific issue drill-down.
 * Used when user asks about a specific pod/deployment.
 */
function generateFocusedContext(
    resourceName: string,
    resourceKind: string,
    namespace: string,
    events: BundleEvent[],
    healthSummary: BundleHealthSummary | null
): string {
    const lines: string[] = [];
    lines.push(`## Focused Analysis: ${resourceKind}/${resourceName} in ${namespace}`);
    lines.push('');

    // Get related events
    const relatedEvents = events.filter(e =>
        e.involved_object_name === resourceName ||
        e.involved_object_name?.includes(resourceName.split('-').slice(0, -1).join('-'))
    );

    if (relatedEvents.length > 0) {
        lines.push('### Related Events (most recent first):');
        const sorted = [...relatedEvents].sort((a, b) => {
            const aTime = a.last_timestamp ? new Date(a.last_timestamp).getTime() : 0;
            const bTime = b.last_timestamp ? new Date(b.last_timestamp).getTime() : 0;
            return bTime - aTime;
        });

        for (const event of sorted.slice(0, 10)) {
            lines.push(`- [${event.event_type}] ${event.reason}: ${event.message}`);
            lines.push(`  Count: ${event.count}, Last: ${event.last_timestamp || 'unknown'}`);
        }
    }

    // Get pod health info if applicable
    if (resourceKind === 'Pod' && healthSummary?.failing_pods) {
        const podInfo = healthSummary.failing_pods.find(
            p => p.name === resourceName && p.namespace === namespace
        );
        if (podInfo) {
            lines.push('');
            lines.push('### Pod Health:');
            lines.push(`Status: ${podInfo.status}`);
            lines.push(`Restarts: ${podInfo.restart_count}`);
            if (podInfo.reason) {
                lines.push(`Reason: ${podInfo.reason}`);
            }
        }
    }

    return lines.join('\n');
}

// ============================================================================
// COMPONENT
// ============================================================================

export function BundleAIAnalyzer({ bundlePath, context, onClose }: BundleAIAnalyzerProps) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
    const [showChat, setShowChat] = useState(false);
    const [isFromCache, setIsFromCache] = useState(false);
    const [cacheTimestamp, setCacheTimestamp] = useState<number | null>(null);
    const [isAIAnalysis, setIsAIAnalysis] = useState(false); // Track if this was AI or pattern-based
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom of chat
    useEffect(() => {
        if (showChat || messages.length > 0) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, showChat, isAnalyzing]);

    // Generate bundle hash for storage key
    const bundleHash = useMemo(() =>
        generateBundleHash(bundlePath, context.overview.healthScore, context.overview.totalPods),
        [bundlePath, context.overview.healthScore, context.overview.totalPods]
    );

    // Memoize the summary to avoid regenerating
    const bundleSummary = useMemo(() => generateBundleSummary(context), [context]);

    // Check if bundle has significant issues worth AI analysis
    const hasSignificantIssues = useMemo(() => {
        return context.overview.healthScore < 90 ||
            context.overview.failingPods > 0 ||
            context.overview.criticalAlerts > 0 ||
            (context.healthSummary?.unhealthy_deployments?.length ?? 0) > 0;
    }, [context]);

    // Load cached analysis on mount or run new analysis
    useEffect(() => {
        const stored = loadStoredAnalysis(bundleHash);
        if (stored) {
            // Restore from cache
            setAnalysis(stored.analysis);
            setMessages(stored.messages.map(m => ({
                ...m,
                timestamp: new Date(m.timestamp)
            })));
            setIsFromCache(true);
            setCacheTimestamp(stored.timestamp);
            setShowChat(stored.messages.length > 0);
            setIsAIAnalysis(true); // Cached results were from AI
            console.log('[BundleAI] Loaded analysis from cache, timestamp:', new Date(stored.timestamp).toLocaleString());
        } else if (!hasSignificantIssues) {
            // No significant issues - use pattern-based analysis (no AI tokens needed)
            console.log('[BundleAI] Healthy cluster, using pattern-based analysis (no AI tokens)');
            const patternResult = generatePatternBasedAnalysis(context);
            setAnalysis(patternResult);
            setIsAIAnalysis(false);
        } else {
            // Has issues - run AI analysis
            runInitialAnalysis();
        }
    }, [bundleHash, hasSignificantIssues]);

    // Save to cache when AI analysis completes
    useEffect(() => {
        if (analysis && isAIAnalysis && !isFromCache) {
            saveAnalysis(bundleHash, analysis, messages);
        }
    }, [analysis, messages, bundleHash, isFromCache, isAIAnalysis]);

    // Also save when messages update (even if from cache)
    useEffect(() => {
        if (analysis && messages.length > 0 && isAIAnalysis) {
            saveAnalysis(bundleHash, analysis, messages);
        }
    }, [messages, isAIAnalysis]);

    const runInitialAnalysis = async (forceRefresh = false) => {
        if (forceRefresh) {
            clearStoredAnalysis(bundleHash);
            setIsFromCache(false);
            setCacheTimestamp(null);
        }

        setIsAnalyzing(true);
        setError(null);

        try {
            // Call the agent server for AI analysis
            const response = await fetch(`${getAgentServerUrl()}/analyze/bundle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    summary: bundleSummary,
                    mode: 'initial_analysis',
                    health_score: context.overview.healthScore,
                    failing_pods_count: context.overview.failingPods,
                    critical_alerts_count: context.overview.criticalAlerts
                })
            });

            if (!response.ok) {
                throw new Error(`Analysis failed: ${response.statusText}`);
            }

            const result = await response.json();
            setAnalysis(result);
            setIsFromCache(false);
            setIsAIAnalysis(true);

            // Save to cache
            saveAnalysis(bundleHash, result, messages);

        } catch (err: any) {
            console.error('Bundle analysis error:', err);
            // Fallback to pattern-based analysis if AI unavailable
            const fallback = generatePatternBasedAnalysis(context);
            setAnalysis(fallback);
            setIsFromCache(false);
            setIsAIAnalysis(false);
        } finally {
            setIsAnalyzing(false);
        }
    };

    const sendMessage = async () => {
        if (!input.trim() || isAnalyzing) return;

        const userMessage: Message = {
            role: 'user',
            content: input.trim(),
            timestamp: new Date()
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsAnalyzing(true);

        try {
            // Use memoized summary (no regeneration)
            const response = await fetch(`${getAgentServerUrl()}/analyze/bundle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    summary: bundleSummary,
                    mode: 'question',
                    question: userMessage.content,
                    conversation_history: messages.map(m => ({
                        role: m.role,
                        content: m.content
                    }))
                })
            });

            if (!response.ok) {
                throw new Error(`Analysis failed: ${response.statusText}`);
            }

            const result = await response.json();

            const assistantMessage: Message = {
                role: 'assistant',
                content: result.answer || result.summary || 'I analyzed the bundle but could not generate a response.',
                timestamp: new Date()
            };

            setMessages(prev => [...prev, assistantMessage]);

        } catch (err: any) {
            const errorMessage: Message = {
                role: 'assistant',
                content: `Error: ${err.message}. The AI service may be unavailable. You can still explore the bundle data manually.`,
                timestamp: new Date()
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsAnalyzing(false);
        }
    };

    const copyToClipboard = async (text: string, index: number) => {
        await navigator.clipboard.writeText(text);
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 2000);
    };

    // Quick action buttons for common questions
    const quickActions = [
        { label: 'Root cause?', question: 'What is the most likely root cause of the failures in this cluster?' },
        { label: 'Fix priority', question: 'What should I fix first to improve cluster health?' },
        { label: 'OOM issues', question: 'Are there any memory-related issues or OOMKilled pods?' },
        { label: 'Network issues', question: 'Are there any networking or connectivity issues?' },
        { label: 'Resource limits', question: 'Are there pods with insufficient resource limits or requests?' },
    ];

    return (
        <div className="flex flex-col h-full bg-zinc-950 border-l border-white/10">
            {/* Header */}
            <div className="shrink-0 px-4 py-3 border-b border-white/10 bg-black/40">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-gradient-to-br from-purple-500/20 to-blue-500/20">
                            <Brain className="w-5 h-5 text-purple-400" />
                        </div>
                        <div>
                            <h3 className="font-semibold text-white">AI Bundle Analyzer</h3>
                            <div className="flex items-center gap-2">
                                {isFromCache && cacheTimestamp ? (
                                    <div className="flex items-center gap-1 text-xs text-emerald-400">
                                        <Database size={10} />
                                        <span>Cached</span>
                                        <span className="text-zinc-500">·</span>
                                        <Clock size={10} className="text-zinc-500" />
                                        <span className="text-zinc-500">
                                            {new Date(cacheTimestamp).toLocaleString(undefined, {
                                                month: 'short',
                                                day: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit'
                                            })}
                                        </span>
                                    </div>
                                ) : !isAIAnalysis && analysis ? (
                                    <div className="flex items-center gap-1 text-xs text-blue-400">
                                        <Zap size={10} />
                                        <span>Pattern-based (no tokens)</span>
                                    </div>
                                ) : (
                                    <p className="text-xs text-zinc-500">Token-efficient analysis</p>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => runInitialAnalysis(true)}
                            className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                            title={isFromCache ? "Re-analyze (discard cache)" : "Re-analyze"}
                        >
                            <RefreshCw size={16} className={isAnalyzing ? 'animate-spin' : ''} />
                        </button>
                        {onClose && (
                            <button
                                onClick={onClose}
                                className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                            >
                                <X size={16} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                {isAnalyzing && !analysis ? (
                    <div className="flex flex-col items-center justify-center py-12">
                        <Loader2 className="w-8 h-8 text-purple-400 animate-spin mb-4" />
                        <p className="text-zinc-400">Analyzing bundle...</p>
                        <p className="text-xs text-zinc-600 mt-1">Generating token-efficient summary</p>
                    </div>
                ) : error ? (
                    <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                        <div className="flex items-center gap-2 text-red-400 mb-2">
                            <AlertCircle size={16} />
                            <span className="font-medium">Analysis Error</span>
                        </div>
                        <p className="text-sm text-zinc-400">{error}</p>
                    </div>
                ) : analysis ? (
                    <>
                        {/* Summary Section */}
                        <div className="p-4 rounded-lg bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/20">
                            <div className="flex items-center gap-2 mb-3">
                                <Sparkles className="w-4 h-4 text-purple-400" />
                                <span className="font-medium text-white">AI Summary</span>
                            </div>
                            <p className="text-sm text-zinc-300 leading-relaxed">{analysis.summary}</p>
                        </div>

                        {/* Root Causes */}
                        {analysis.rootCauses.length > 0 && (
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-zinc-400">
                                    <Target size={14} />
                                    <span className="text-sm font-medium">Likely Root Causes</span>
                                </div>
                                {analysis.rootCauses.map((cause, i) => (
                                    <div
                                        key={i}
                                        className={`p-3 rounded-lg border ${cause.likelihood === 'high'
                                            ? 'bg-red-500/10 border-red-500/20'
                                            : cause.likelihood === 'medium'
                                                ? 'bg-orange-500/10 border-orange-500/20'
                                                : 'bg-zinc-800/50 border-white/10'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="text-sm font-medium text-white">{cause.issue}</span>
                                            <span className={`text-xs px-2 py-0.5 rounded ${cause.likelihood === 'high' ? 'bg-red-500/20 text-red-400' :
                                                cause.likelihood === 'medium' ? 'bg-orange-500/20 text-orange-400' :
                                                    'bg-zinc-700 text-zinc-400'
                                                }`}>
                                                {cause.likelihood} likelihood
                                            </span>
                                        </div>
                                        <p className="text-xs text-zinc-400">{cause.explanation}</p>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Recommendations */}
                        {analysis.recommendations.length > 0 && (
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-zinc-400">
                                    <Lightbulb size={14} />
                                    <span className="text-sm font-medium">Recommendations</span>
                                </div>
                                {analysis.recommendations.map((rec, i) => (
                                    <div
                                        key={i}
                                        className="p-3 rounded-lg bg-zinc-800/50 border border-white/10"
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className={`w-2 h-2 rounded-full ${rec.priority === 'critical' ? 'bg-red-500' :
                                                rec.priority === 'high' ? 'bg-orange-500' :
                                                    rec.priority === 'medium' ? 'bg-yellow-500' :
                                                        'bg-blue-500'
                                                }`} />
                                            <span className="text-sm font-medium text-white">{rec.action}</span>
                                        </div>
                                        <p className="text-xs text-zinc-400 ml-4">{rec.rationale}</p>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Quick Actions */}
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-zinc-400">
                                <Zap size={14} />
                                <span className="text-sm font-medium">Ask AI</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {quickActions.map((action, i) => (
                                    <button
                                        key={i}
                                        onClick={() => {
                                            setInput(action.question);
                                            setShowChat(true);
                                        }}
                                        className="px-3 py-1.5 text-xs rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-white/10 transition-colors"
                                    >
                                        {action.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Chat Section */}
                        {(showChat || messages.length > 0) && (
                            <div className="space-y-3 pt-4 border-t border-white/10">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-zinc-400">
                                        <MessageSquare size={14} />
                                        <span className="text-sm font-medium">Conversation</span>
                                    </div>
                                    {messages.length > 0 && (
                                        <button
                                            onClick={() => setMessages([])}
                                            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                                        >
                                            Clear
                                        </button>
                                    )}
                                </div>

                                {/* Messages - improved layout */}
                                <div className="space-y-4 max-h-80 overflow-y-auto custom-scrollbar pr-1">
                                    {messages.map((msg, i) => (
                                        <div
                                            key={i}
                                            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                        >
                                            <div
                                                className={`max-w-[85%] p-3 rounded-lg ${msg.role === 'user'
                                                    ? 'bg-purple-600/20 border border-purple-500/30'
                                                    : 'bg-zinc-800/70 border border-white/10'
                                                    }`}
                                            >
                                                <div className="flex items-center justify-between gap-3 mb-2">
                                                    <span className={`text-xs font-medium ${msg.role === 'user' ? 'text-purple-400' : 'text-zinc-400'
                                                        }`}>
                                                        {msg.role === 'user' ? 'You' : 'AI Assistant'}
                                                    </span>
                                                    <button
                                                        onClick={() => copyToClipboard(msg.content, i)}
                                                        className="p-1 hover:bg-white/10 rounded transition-colors opacity-60 hover:opacity-100"
                                                        title="Copy message"
                                                    >
                                                        {copiedIndex === i ? (
                                                            <Check size={12} className="text-green-400" />
                                                        ) : (
                                                            <Copy size={12} className="text-zinc-400" />
                                                        )}
                                                    </button>
                                                </div>
                                                <div className="text-sm text-zinc-200 prose prose-invert prose-sm max-w-none [&>p]:mb-2 [&>p]:last:mb-0 [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:list-decimal [&>ol]:pl-4 [&>pre]:bg-zinc-900 [&>pre]:p-2 [&>pre]:rounded-lg [&>pre]:text-xs [&>code]:bg-zinc-900/50 [&>code]:px-1 [&>code]:rounded [&>code]:text-purple-300">
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                        {msg.content}
                                                    </ReactMarkdown>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                    {isAnalyzing && (
                                        <div className="flex justify-start">
                                            <div className="flex items-center gap-2 p-3 bg-zinc-800/50 rounded-lg border border-white/10">
                                                <Loader2 size={14} className="animate-spin text-purple-400" />
                                                <span className="text-sm text-zinc-400">Analyzing bundle...</span>
                                            </div>
                                        </div>
                                    )}
                                    <div ref={messagesEndRef} />
                                </div>

                                {/* Input - improved */}
                                <div className="flex gap-2 pt-2">
                                    <input
                                        type="text"
                                        value={input}
                                        onChange={(e) => setInput(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                                        placeholder="Ask about the bundle..."
                                        className="flex-1 px-4 py-2.5 text-sm bg-zinc-800 border border-white/10 rounded-lg text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50"
                                    />
                                    <button
                                        onClick={sendMessage}
                                        disabled={!input.trim() || isAnalyzing}
                                        className="px-4 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
                                    >
                                        <Send size={16} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                ) : null}
            </div>
        </div>
    );
}

// ============================================================================
// FALLBACK PATTERN-BASED ANALYSIS
// ============================================================================

/**
 * Generates analysis using pattern matching when AI is unavailable.
 * This provides immediate value without LLM tokens.
 */
function generatePatternBasedAnalysis(context: BundleContext): AnalysisResult {
    const { healthSummary, alerts, events, overview } = context;
    const rootCauses: AnalysisResult['rootCauses'] = [];
    const recommendations: AnalysisResult['recommendations'] = [];
    const affectedComponents: string[] = [];

    // Analyze failing pods
    if (healthSummary?.failing_pods) {
        const crashLoopPods = healthSummary.failing_pods.filter(p =>
            p.reason?.includes('CrashLoopBackOff') || p.status?.includes('CrashLoopBackOff')
        );
        const oomPods = healthSummary.failing_pods.filter(p =>
            p.reason?.includes('OOMKilled') || p.status?.includes('OOMKilled')
        );
        const imagePullPods = healthSummary.failing_pods.filter(p =>
            p.reason?.includes('ImagePullBackOff') || p.reason?.includes('ErrImagePull')
        );

        if (crashLoopPods.length > 0) {
            rootCauses.push({
                issue: `${crashLoopPods.length} pods in CrashLoopBackOff`,
                likelihood: 'high',
                explanation: 'Application is crashing repeatedly. Check container logs for error messages, startup probes, and resource limits.'
            });
            recommendations.push({
                priority: 'critical',
                action: 'Review container logs for crash reasons',
                rationale: 'CrashLoopBackOff indicates the container is starting and immediately crashing'
            });
            affectedComponents.push(...crashLoopPods.map(p => `${p.namespace}/${p.name}`));
        }

        if (oomPods.length > 0) {
            rootCauses.push({
                issue: `${oomPods.length} pods killed due to OOM`,
                likelihood: 'high',
                explanation: 'Containers exceeded memory limits and were killed by the OOM killer.'
            });
            recommendations.push({
                priority: 'critical',
                action: 'Increase memory limits or optimize application memory usage',
                rationale: 'OOMKilled containers need either more memory or memory leak fixes'
            });
        }

        if (imagePullPods.length > 0) {
            rootCauses.push({
                issue: `${imagePullPods.length} pods with image pull errors`,
                likelihood: 'high',
                explanation: 'Unable to pull container images. Check image names, tags, and registry credentials.'
            });
            recommendations.push({
                priority: 'high',
                action: 'Verify image references and registry access',
                rationale: 'ImagePullBackOff usually means the image doesn\'t exist or credentials are wrong'
            });
        }
    }

    // Analyze warning events
    const warningEvents = events.filter(e => e.event_type === 'Warning');
    const failedScheduling = warningEvents.filter(e => e.reason === 'FailedScheduling');
    if (failedScheduling.length > 0) {
        const hasResourceIssue = failedScheduling.some(e =>
            e.message?.includes('Insufficient') || e.message?.includes('cpu') || e.message?.includes('memory')
        );
        if (hasResourceIssue) {
            rootCauses.push({
                issue: 'Insufficient cluster resources',
                likelihood: 'high',
                explanation: 'Pods cannot be scheduled due to lack of CPU or memory resources.'
            });
            recommendations.push({
                priority: 'high',
                action: 'Scale up cluster or reduce resource requests',
                rationale: 'The cluster doesn\'t have enough resources to schedule all requested pods'
            });
        }
    }

    // Generate summary
    let summary = `Cluster health score is ${overview.healthScore}/100. `;
    if (overview.failingPods > 0) {
        summary += `${overview.failingPods} pods are failing. `;
    }
    if (overview.criticalAlerts > 0) {
        summary += `${overview.criticalAlerts} critical alerts are firing. `;
    }
    if (rootCauses.length > 0) {
        summary += `Primary issues: ${rootCauses.map(r => r.issue).join(', ')}.`;
    } else {
        summary += 'No critical issues detected from pattern analysis.';
    }

    return {
        summary,
        rootCauses,
        recommendations,
        affectedComponents
    };
}

export default BundleAIAnalyzer;
