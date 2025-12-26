/**
 * ResourceDetailPanel - Shows detailed YAML and info for selected resource
 */

import { useState, useEffect, useCallback } from 'react';
import { X, Copy, Check, FileText, Tag, Clock, AlertTriangle, ChevronDown } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useBundleContext } from '../BundleContext';
import { BundleResource } from '../types';

function ConditionRow({ condition }: { condition: any }) {
    const isOk = condition.status === 'True';
    return (
        <div className={`p-2 rounded text-xs ${
            isOk ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'
        }`}>
            <div className="flex items-center justify-between">
                <span className={`font-medium ${isOk ? 'text-green-400' : 'text-red-400'}`}>
                    {condition.condition_type}
                </span>
                <span className={isOk ? 'text-green-400' : 'text-red-400'}>
                    {condition.status}
                </span>
            </div>
            {condition.reason && (
                <div className="text-zinc-500 mt-1">Reason: {condition.reason}</div>
            )}
            {condition.message && (
                <div className="text-zinc-400 mt-1 break-all">{condition.message}</div>
            )}
        </div>
    );
}

export function ResourceDetailPanel() {
    const { bundle, selectedResource, setSelectedResource, events } = useBundleContext();
    const [yaml, setYaml] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [activeTab, setActiveTab] = useState<'overview' | 'yaml' | 'events'>('overview');

    const loadYaml = useCallback(async () => {
        if (!bundle || !selectedResource) return;
        setLoading(true);
        try {
            const content = await invoke<string>('read_bundle_resource_yaml', {
                bundlePath: bundle.path,
                filePath: selectedResource.file_path
            });
            setYaml(content);
        } catch (err) {
            setYaml(`Error loading YAML: ${err}`);
        } finally {
            setLoading(false);
        }
    }, [bundle, selectedResource]);

    useEffect(() => {
        if (selectedResource && activeTab === 'yaml' && !yaml) {
            loadYaml();
        }
    }, [selectedResource, activeTab, yaml, loadYaml]);

    useEffect(() => {
        setYaml(null);
        setActiveTab('overview');
    }, [selectedResource]);

    const handleCopy = useCallback(async () => {
        if (yaml) {
            await navigator.clipboard.writeText(yaml);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }, [yaml]);

    if (!selectedResource) return null;

    const relatedEvents = events.filter(e =>
        e.involved_object_name === selectedResource.name &&
        e.involved_object_kind === selectedResource.kind &&
        (e.namespace === selectedResource.namespace || !selectedResource.namespace)
    );

    const isFailing = ['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff'].includes(
        selectedResource.status_phase || ''
    );

    return (
        <div className="fixed inset-y-0 right-0 w-[500px] bg-zinc-950 border-l border-zinc-800 flex flex-col z-50 shadow-2xl">
            {/* Header */}
            <div className="p-4 border-b border-zinc-800 flex items-start justify-between">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400">
                            {selectedResource.kind}
                        </span>
                        {selectedResource.status_phase && (
                            <span className={`text-xs px-2 py-0.5 rounded ${
                                isFailing
                                    ? 'bg-red-500/20 text-red-400'
                                    : 'bg-green-500/20 text-green-400'
                            }`}>
                                {selectedResource.status_phase}
                            </span>
                        )}
                    </div>
                    <h3 className="text-lg font-medium text-white mt-2 break-all">
                        {selectedResource.name}
                    </h3>
                    <div className="text-xs text-zinc-500 mt-1">
                        {selectedResource.namespace || 'cluster-scoped'} • {selectedResource.api_version}
                    </div>
                </div>
                <button
                    onClick={() => setSelectedResource(null)}
                    className="p-2 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
                >
                    <X size={18} />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-zinc-800">
                {(['overview', 'yaml', 'events'] as const).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                            activeTab === tab
                                ? 'text-purple-400 border-b-2 border-purple-500'
                                : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                    >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                        {tab === 'events' && relatedEvents.length > 0 && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/20 text-yellow-400">
                                {relatedEvents.length}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4">
                {activeTab === 'overview' && (
                    <div className="space-y-4">
                        {/* Labels */}
                        {Object.keys(selectedResource.labels).length > 0 && (
                            <div>
                                <div className="text-xs font-medium text-zinc-500 mb-2 flex items-center gap-1">
                                    <Tag size={12} />
                                    Labels
                                </div>
                                <div className="flex gap-1 flex-wrap">
                                    {Object.entries(selectedResource.labels).map(([k, v]) => (
                                        <span
                                            key={k}
                                            className="px-2 py-1 rounded text-xs bg-zinc-800 text-zinc-300"
                                            title={`${k}=${v}`}
                                        >
                                            <span className="text-zinc-500">{k.split('/').pop()}:</span> {v}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Conditions */}
                        {selectedResource.conditions.length > 0 && (
                            <div>
                                <div className="text-xs font-medium text-zinc-500 mb-2 flex items-center gap-1">
                                    <AlertTriangle size={12} />
                                    Conditions
                                </div>
                                <div className="space-y-2">
                                    {selectedResource.conditions.map((c, i) => (
                                        <ConditionRow key={i} condition={c} />
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* File Path */}
                        <div>
                            <div className="text-xs font-medium text-zinc-500 mb-2 flex items-center gap-1">
                                <FileText size={12} />
                                Source File
                            </div>
                            <div className="text-xs text-zinc-400 font-mono bg-zinc-900 p-2 rounded break-all">
                                {selectedResource.file_path}
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'yaml' && (
                    <div className="relative">
                        <button
                            onClick={handleCopy}
                            className="absolute top-2 right-2 p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors z-10"
                            title="Copy YAML"
                        >
                            {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                        </button>
                        {loading ? (
                            <div className="text-center py-8 text-zinc-500">Loading YAML...</div>
                        ) : (
                            <pre className="text-xs text-zinc-300 font-mono bg-zinc-900 p-4 rounded overflow-auto max-h-[calc(100vh-300px)] whitespace-pre-wrap">
                                {yaml}
                            </pre>
                        )}
                    </div>
                )}

                {activeTab === 'events' && (
                    <div className="space-y-2">
                        {relatedEvents.length === 0 ? (
                            <div className="text-center py-8 text-zinc-500">
                                No events found for this resource
                            </div>
                        ) : (
                            relatedEvents.map((event, i) => (
                                <div
                                    key={i}
                                    className={`p-3 rounded border ${
                                        event.event_type === 'Warning'
                                            ? 'bg-yellow-500/5 border-yellow-500/20'
                                            : 'bg-zinc-900 border-zinc-800'
                                    }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                                            event.event_type === 'Warning'
                                                ? 'bg-yellow-500/20 text-yellow-400'
                                                : 'bg-blue-500/20 text-blue-400'
                                        }`}>
                                            {event.reason}
                                        </span>
                                        {event.count > 1 && (
                                            <span className="text-xs text-zinc-600">×{event.count}</span>
                                        )}
                                    </div>
                                    <div className="text-sm text-zinc-300 mt-2">{event.message}</div>
                                    {event.last_timestamp && (
                                        <div className="text-xs text-zinc-600 mt-2 flex items-center gap-1">
                                            <Clock size={10} />
                                            {new Date(event.last_timestamp).toLocaleString()}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
