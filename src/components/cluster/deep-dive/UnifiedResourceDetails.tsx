import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import {
    Activity, Box, Network,
    CheckCircle2, AlertCircle, RefreshCw,
    Search, Tag, Settings,
    Loader2, Info, ArrowUp, ArrowDown, Play, Gauge, RotateCcw,
    ChevronUp, ChevronDown, ChevronsUp, ChevronsDown,
    LayoutDashboard, ScrollText, Terminal as TerminalIcon, Calendar, Edit, Trash2
} from 'lucide-react';

import { OverviewTab } from './OverviewTab';
import { LogsTab } from './LogsTab';
import { TerminalTab } from './TerminalTab';
import { EventsTab } from './EventsTab';
import { ConfigMapDetails } from './ConfigMapDetails';
import { SecretDetails } from './SecretDetails';
import { YamlEditorModal } from './YamlEditorModal';
import { DeleteConfirmationModal } from '../../shared/DeleteConfirmationModal'; // Correct import path

import { useToast } from '../../ui/Toast';
import { K8sObject } from '../../../types/k8s';
import { StatusBadge } from '../../shared/StatusBadge';

interface UnifiedDetailsProps {
    resource: K8sObject;
    fullObject: any;
    currentContext?: string;
    loading: boolean;
    error?: Error | null;
    onClose?: () => void; // Optional close handler if deep dive is modal
    onNavigateResource?: (kind: string, name: string, namespace: string, apiVersion?: string) => void; // Navigate to related resource
}

// Simple global cache to persist tab state across navigation for the current session
const PROVISIONAL_TAB_CACHE: Record<string, any> = {};

export function UnifiedResourceDetails({ resource, fullObject, currentContext, loading, error, onClose, onNavigateResource }: UnifiedDetailsProps) {
    const resourceId = resource.id || `${resource.namespace}/${resource.kind}/${resource.name}`;

    const [activeTab, setActiveTab] = useState<'overview' | 'logs' | 'terminal' | 'events'>(() => {
        return PROVISIONAL_TAB_CACHE[resourceId] || 'overview';
    });

    // Update cache when tab changes
    useEffect(() => {
        PROVISIONAL_TAB_CACHE[resourceId] = activeTab;
    }, [activeTab, resourceId]);

    const [isRestarting, setIsRestarting] = useState(false);
    const [isScaling, setIsScaling] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [triggerAnalysis, setTriggerAnalysis] = useState<{ container: string } | null>(null);

    const { showToast, dismissToast } = useToast();
    const qc = useQueryClient();

    // Data Extraction
    const safeFullObject = fullObject || {};
    const spec = safeFullObject.spec || {};
    const status = safeFullObject.status || {};
    const metadata = safeFullObject.metadata || {};

    // Derived Types
    const kind = resource.kind.toLowerCase();
    const isPod = kind === 'pod';
    const isWorkload = kind === 'deployment' || kind === 'statefulset' || kind === 'daemonset';

    // Workload Actions Logic
    const canRestart = isWorkload;
    const canScale = kind === 'deployment' || kind === 'statefulset';

    // Optimistic Replicas State
    const [optimisticReplicas, setOptimisticReplicas] = useState<number | null>(null);
    useEffect(() => {
        if (spec.replicas !== undefined) {
            setOptimisticReplicas(spec.replicas);
        }
    }, [spec.replicas]);

    // HANDLERS

    const handlePatch = async (path: string[], value: any) => {
        // Construct nested patch object
        const patch: any = {};
        let current = patch;
        for (let i = 0; i < path.length - 1; i++) {
            current[path[i]] = {};
            current = current[path[i]];
        }
        current[path[path.length - 1]] = value;

        try {
            const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;

            await invoke("patch_resource", {
                namespace: resource.namespace,
                kind: resource.kind,
                name: resource.name,
                apiVersion: apiVersion,
                patchData: patch
            });
            showToast('Property updated successfully', 'success');
        } catch (e) {
            console.error("Patch failed", e);
            showToast(`Patch failed: ${String(e)}`, 'error');
        }
    };

    const handleScale = async (limit: number) => {
        if (isScaling) return;
        const current = spec.replicas ?? 1;
        const newReplicas = Math.max(0, current + limit);

        // Optimistic update - show new replicas immediately
        setOptimisticReplicas(newReplicas);
        setIsScaling(true);

        try {
            await invoke("scale_resource", {
                namespace: resource.namespace,
                kind: resource.kind,
                name: resource.name,
                replicas: newReplicas
            });

            // Invalidate list queries so the resource list updates immediately
            qc.invalidateQueries({ queryKey: ["list_resources"] });

            showToast(`Scaled to ${newReplicas} replicas`, 'success');
        } catch (e) {
            // Revert optimistic update on failure
            setOptimisticReplicas(current);
            console.error("Scale failed", e);
            showToast(`Scale failed: ${String(e)}`, 'error');
        } finally {
            setIsScaling(false);
        }
    };

    const handleRestart = async () => {
        setIsRestarting(true);
        const toastId = showToast('Initiating rollout restart...', 'loading', 0);
        try {
            const now = new Date().toISOString();
            const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version;
            await invoke("patch_resource", {
                namespace: resource.namespace,
                kind: resource.kind,
                name: resource.name,
                apiVersion,
                patchData: {
                    apiVersion, kind: resource.kind,
                    spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": now } } } }
                }
            });

            // Invalidate queries so list updates show restarting pods
            qc.invalidateQueries({ queryKey: ["list_resources"] });

            dismissToast(toastId);
            showToast('Restart initiated successfully', 'success');
        } catch (e) {
            console.error("Restart failed", e);
            dismissToast(toastId);
            showToast(`Restart failed: ${String(e)}`, 'error', 5000);
        } finally {
            setIsRestarting(false);
        }
    };

    const handleDeleteRequest = () => {
        setDeleteModalOpen(true);
    };

    const handleDeleteConfirm = async () => {
        const resourceKind = resource.kind;
        const resourceName = resource.name;
        showToast(`Deleting ${resourceKind} '${resourceName}'...`, 'info');
        try {
            await invoke("delete_resource", {
                req: { group: resource.group, version: resource.version, kind: resource.kind, namespace: resource.namespace === '-' ? null : resource.namespace },
                name: resource.name
            });
            showToast(`${resourceKind} '${resourceName}' deleted`, 'success');
            setDeleteModalOpen(false);
            onClose?.(); // Close drawer if prop provided
        } catch (err) {
            showToast(`Failed to delete: ${err}`, 'error');
        }
    };

    // Specialized Views
    if (kind === 'configmap' && !loading) return <ConfigMapDetails resource={resource} fullObject={fullObject} />;
    if (kind === 'secret' && !loading) return <SecretDetails resource={resource} fullObject={fullObject} />;

    if (error) {
        return (
            <div className="flex h-full items-center justify-center flex-col text-red-400 space-y-4 p-8 text-center">
                <AlertCircle size={40} />
                <div className="space-y-1">
                    <h3 className="font-bold text-lg text-red-300">Failed to load resource details</h3>
                    <p className="text-sm opacity-80 max-w-md">{String(error)}</p>
                </div>
                <button
                    onClick={() => window.dispatchEvent(new CustomEvent("lenskiller:reload"))}
                    className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-300 rounded-md transition-colors text-sm font-medium"
                >
                    Retry
                </button>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center space-y-4 flex-col text-zinc-500">
                <Loader2 size={32} className="animate-spin text-cyan-500" />
                <span className="text-xs tracking-widest uppercase">Loading Resources...</span>
            </div>
        );
    }

    // Show a warning if data failed to load but we have no explicit error
    if (!fullObject && !loading && !error) {
        console.warn("[UnifiedResourceDetails] No fullObject received after loading completed. Resource may not exist or API returned empty.", resource);
    }

    return (
        <div className="flex flex-col h-full bg-[#0f0f12] text-zinc-200">
            {/* 1. HEADER (Sticky) */}
            <div className="flex flex-col border-b border-white/5 bg-[#0f0f12] shrink-0 sticky top-0 z-20">
                {/* Top Row: Identity & Actions */}
                <div className="flex items-center justify-between px-6 py-4">
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                            <StatusBadge status={resource.status} />
                            <h1 className="text-xl font-bold text-white tracking-tight">{resource.name}</h1>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-zinc-500 font-mono">
                            <span>{resource.kind}</span>
                            <span>•</span>
                            <span>{resource.namespace}</span>
                        </div>
                    </div>

                    {/* Action Bar */}
                    <div className="flex items-center gap-2">
                        {canScale && (
                            <div className="flex items-center gap-2 bg-white/5 rounded-lg p-1 mr-2 border border-white/10">
                                <span className="text-xs font-mono px-2 text-zinc-400">
                                    replicas: <span className="text-white">{status.readyReplicas || 0}/{optimisticReplicas ?? spec.replicas ?? 0}</span>
                                </span>
                                <div className="w-px h-4 bg-white/10" />
                                <button disabled={isScaling} onClick={() => handleScale(-1)} className="p-1 hover:text-white text-zinc-500 transition-colors disabled:opacity-50">
                                    {isScaling ? <Loader2 size={14} className="animate-spin" /> : <ArrowDown size={14} />}
                                </button>
                                <button disabled={isScaling} onClick={() => handleScale(1)} className="p-1 hover:text-white text-zinc-500 transition-colors disabled:opacity-50">
                                    {isScaling ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />}
                                </button>
                            </div>
                        )}

                        <button
                            onClick={handleRestart}
                            disabled={!canRestart || isRestarting}
                            className={`p-2 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors border border-transparent hover:border-white/10 ${!canRestart ? 'hidden' : ''}`}
                            title="Restart"
                        >
                            <RotateCcw size={18} className={isRestarting ? 'animate-spin' : ''} />
                        </button>

                        <button
                            onClick={() => setEditorOpen(true)}
                            className="p-2 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors border border-transparent hover:border-white/10"
                            title="Edit YAML"
                        >
                            <Edit size={18} />
                        </button>

                        <button
                            onClick={handleDeleteRequest}
                            className="p-2 rounded-lg hover:bg-red-500/10 text-zinc-400 hover:text-red-400 transition-colors border border-transparent hover:border-red-500/20"
                            title="Delete"
                        >
                            <Trash2 size={18} />
                        </button>
                    </div>
                </div>

                {/* Tab Navigation */}
                <div className="flex items-center gap-6 px-6 relative">
                    {[
                        { id: 'overview', label: 'Overview', icon: LayoutDashboard },
                        { id: 'logs', label: 'Logs', icon: ScrollText, hidden: !isPod },
                        { id: 'terminal', label: 'Terminal', icon: TerminalIcon, hidden: !isPod },
                        { id: 'events', label: 'Events', icon: Calendar }
                    ].map((tab) => {
                        if (tab.hidden) return null;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id as any)}
                                className={`flex items-center gap-2 pb-3 text-sm font-medium transition-colors relative ${isActive ? 'text-cyan-400' : 'text-zinc-500 hover:text-zinc-300'
                                    }`}
                            >
                                <tab.icon size={16} />
                                {tab.label}
                                {isActive && (
                                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.5)]" />
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* 2. MAIN CONTENT AREA */}
            <div className="flex-1 overflow-hidden relative bg-[#0f0f12]">
                {activeTab === 'overview' && (
                    <div className="absolute inset-0 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800 p-6">
                        <OverviewTab
                            resource={resource}
                            fullObject={fullObject}
                            currentContext={currentContext}
                            onViewLogs={() => setActiveTab('logs')}
                            onAnalyzeLogs={(container) => {
                                setTriggerAnalysis({ container });
                                setActiveTab('logs');
                            }}
                            onUpdate={handlePatch}
                            onNavigateResource={onNavigateResource}
                        />
                    </div>
                )}

                {activeTab === 'logs' && isPod && (
                    <LogsTab
                        resource={resource}
                        fullObject={fullObject}
                        autoAnalyzeContainer={triggerAnalysis?.container}
                        onAnalysisStarted={() => setTriggerAnalysis(null)}
                    />
                )}

                {activeTab === 'terminal' && isPod && (
                    <TerminalTab
                        namespace={resource.namespace}
                        name={resource.name}
                        podSpec={spec}
                    />
                )}

                {activeTab === 'events' && (
                    <EventsTab resource={resource} />
                )}
            </div>

            {/* Modals */}
            <YamlEditorModal
                isOpen={editorOpen}
                onClose={() => setEditorOpen(false)}
                resource={resource}
            />
            {deleteModalOpen && (
                <DeleteConfirmationModal
                    isOpen={deleteModalOpen}
                    resourceName={resource.name}
                    onConfirm={handleDeleteConfirm}
                    onClose={() => setDeleteModalOpen(false)}
                />
            )}
        </div>
    );
}
