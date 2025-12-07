
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, AlertCircle, CheckCircle2, HelpCircle, Activity, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { K8sObject } from '../../../types/k8s';
import { fixMarkdownHeaders } from '../../../utils/markdown';

export function EventsTab({ resource }: { resource: K8sObject }) {
    const [analyzingEvent, setAnalyzingEvent] = useState<string | null>(null);
    const [expandedExplanations, setExpandedExplanations] = useState<Record<number, string>>({});
    const [analyzingAll, setAnalyzingAll] = useState(false);
    const [analysisResult, setAnalysisResult] = useState<string | null>(null);

    const { data: events, isLoading, refetch, isRefetching } = useQuery({
        queryKey: ["resource_events", resource.namespace, resource.name, resource.group, resource.version, resource.kind],
        queryFn: async () => {
            // Pass UID to filter events correctly
            return await invoke<any[]>("list_events", {
                namespace: resource.namespace,
                name: resource.name,
                uid: resource.id
            });
        },
        refetchInterval: 5000,
    });

    const analyzeEvent = async (event: any, index: number) => {
        if (expandedExplanations[index]) {
            // Toggle off
            const newExps = { ...expandedExplanations };
            delete newExps[index];
            setExpandedExplanations(newExps);
            return;
        }

        setAnalyzingEvent(event.metadata.uid || String(index));
        try {
            const prompt = `Analyze this Kubernetes event and explain what it means in simple terms. Suggest if any action is needed:\n\nPayload: ${JSON.stringify(event)}`;
            const explanation = await invoke<string>("analyze_text", { text: prompt, context: "Event Analysis" });
            setExpandedExplanations(prev => ({ ...prev, [index]: explanation }));
        } catch (err) {
            console.error(err);
        } finally {
            setAnalyzingEvent(null);
        }
    };

    const analyzeAllEvents = async () => {
        if (!events || events.length === 0) return;
        setAnalyzingAll(true);
        setAnalysisResult(null);
        try {
            const prompt = `Analyze these Kubernetes events as a sequence and provide a summary of what is happening to the resource. Identify any patterns of errors:\n\n${JSON.stringify(events.slice(0, 20))}`;
            const result = await invoke<string>("analyze_text", { text: prompt, context: "Full Event Log Analysis" });
            setAnalysisResult(result);
        } catch (err) {
            console.error(err);
        } finally {
            setAnalyzingAll(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-[#858585] gap-2">
                <Loader2 className="animate-spin text-[#007acc]" size={24} />
                <span className="text-xs">Loading events...</span>
            </div>
        );
    }

    if (!events || events.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-[#858585] gap-2">
                <Activity size={32} className="opacity-20" />
                <span className="text-sm">No events found for this resource.</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] border border-[#3e3e42] rounded overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-[#252526] border-b border-[#3e3e42]">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">{events.length} Events</span>
                    {isRefetching && <Loader2 size={10} className="animate-spin text-[#007acc]" />}
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => refetch()}
                        className="p-1.5 text-[#cccccc] hover:bg-[#3e3e42] rounded transition-colors"
                        title="Refresh Events"
                    >
                        <RefreshCw size={12} className={isRefetching ? "animate-spin" : ""} />
                    </button>
                    <button
                        onClick={analyzeAllEvents}
                        disabled={analyzingAll}
                        className="flex items-center gap-1.5 px-3 py-1 bg-[#865fc9]/20 text-[#d2a8ff] hover:bg-[#865fc9]/30 text-xs rounded transition-colors border border-[#865fc9]/30 disabled:opacity-50"
                    >
                        {analyzingAll ? <Loader2 size={10} className="animate-spin" /> : <Activity size={12} />}
                        Analyze All
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-4">
                {/* All Events Analysis Result */}
                {analysisResult && (
                    <div className="bg-[#1e1e1e] border border-purple-500/30 rounded p-4 mb-4 relative group">
                        <h4 className="flex items-center gap-2 text-xs font-bold text-purple-400 uppercase tracking-wider mb-2">
                            <Activity size={14} /> AI Analysis
                        </h4>
                        <div className="text-xs text-[#cccccc] leading-relaxed">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixMarkdownHeaders(analysisResult)}</ReactMarkdown>
                        </div>
                        <button
                            onClick={() => setAnalysisResult(null)}
                            className="absolute top-2 right-2 p-1 text-[#858585] hover:text-white rounded hover:bg-[#3e3e42]"
                        >
                            <ChevronUp size={12} />
                        </button>
                    </div>
                )}

                {/* Event List */}
                {events.map((event: any, i: number) => (
                    <div key={event.metadata.uid || i} className="flex flex-col gap-2 p-3 bg-[#252526] border border-[#3e3e42] rounded hover:border-[#505050] transition-colors">
                        <div className="flex items-start gap-3">
                            {event.type === 'Warning' ? (
                                <AlertCircle size={16} className="text-[#f48771] shrink-0 mt-0.5" />
                            ) : (
                                <CheckCircle2 size={16} className="text-[#89d185] shrink-0 mt-0.5" />
                            )}
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between mb-0.5">
                                    <span className="text-xs font-semibold text-white truncate">{event.reason}</span>
                                    <span className="text-[10px] text-[#858585] whitespace-nowrap ml-2">
                                        {event.count > 1 && <span className="mr-2 px-1.5 py-0.5 bg-[#3e3e42] rounded text-[#cccccc]">{event.count}x</span>}
                                        {/* Use event.lastTimestamp or formatting function */}
                                        {event.lastTimestamp || event.eventTime || '-'}
                                    </span>
                                </div>
                                <p className="text-xs text-[#cccccc] leading-relaxed break-words">{event.message}</p>
                                <div className="flex items-center justify-between mt-2">
                                    <div className="text-[10px] text-[#858585]">
                                        Source: <span className="text-[#cccccc]">{event.source?.component || '-'}</span>
                                    </div>
                                    <button
                                        onClick={() => analyzeEvent(event, i)}
                                        disabled={analyzingEvent === (event.metadata.uid || String(i))}
                                        className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded transition-colors ${expandedExplanations[i] ? 'bg-[#865fc9]/20 text-[#d2a8ff]' : 'text-[#858585] hover:text-[#d2a8ff] hover:bg-[#3e3e42]'}`}
                                    >
                                        {analyzingEvent === (event.metadata.uid || String(i)) ? (
                                            <Loader2 size={10} className="animate-spin" />
                                        ) : (
                                            <HelpCircle size={10} />
                                        )}
                                        {expandedExplanations[i] ? 'Hide Explanation' : 'Explain'}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* AI Explanation */}
                        {expandedExplanations[i] && (
                            <div className="ml-7 mt-1 p-3 bg-[#1e1e1e] border border-purple-500/20 rounded relative animate-in slide-in-from-top-2">
                                <div className="absolute -left-1.5 top-4 w-1.5 h-1.5 bg-[#1e1e1e] border-l border-t border-purple-500/20 transform -rotate-45" />
                                <h5 className="text-[10px] font-bold text-purple-400 uppercase tracking-wider mb-1">AI Explanation</h5>
                                <div className="prose prose-invert max-w-none">
                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        components={{
                                            p: ({ children }) => <p className="text-[11px] text-[#cccccc] leading-relaxed mb-1.5 last:mb-0">{children}</p>,
                                            ul: ({ children }) => <ul className="list-disc ml-4 my-1.5 space-y-0.5">{children}</ul>,
                                            ol: ({ children }) => <ol className="list-decimal ml-4 my-1.5 space-y-0.5">{children}</ol>,
                                            li: ({ children }) => <li className="text-[#cccccc] text-[11px]">{children}</li>,
                                            code: ({ className, children }) => {
                                                const isBlock = className?.includes('language-');
                                                if (isBlock) {
                                                    return <code className="text-[#cccccc] text-[10px]">{children}</code>;
                                                }
                                                return <code className="bg-[#2d2d30] px-1.5 py-0.5 rounded text-[#ce9178] text-[10px]">{children}</code>;
                                            },
                                            pre: ({ children }) => <pre className="bg-[#0d1117] p-2.5 rounded border border-[#3e3e42] my-2 text-[10px] overflow-x-auto">{children}</pre>,
                                            strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                                            em: ({ children }) => <em className="italic text-purple-300">{children}</em>,
                                            a: ({ href, children }) => <a href={href} className="text-cyan-400 hover:text-cyan-300 underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                                            blockquote: ({ children }) => <blockquote className="border-l-2 border-purple-500 pl-3 my-2 text-[#999]">{children}</blockquote>,
                                            hr: () => <hr className="border-[#3e3e42] my-3" />,
                                            table: ({ children }) => <table className="border-collapse my-2 text-[10px] w-full">{children}</table>,
                                            th: ({ children }) => <th className="border border-[#3e3e42] px-2 py-1 bg-[#2d2d30] text-white font-semibold">{children}</th>,
                                            td: ({ children }) => <td className="border border-[#3e3e42] px-2 py-1">{children}</td>,
                                        }}
                                    >
                                        {fixMarkdownHeaders(expandedExplanations[i])}
                                    </ReactMarkdown>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
