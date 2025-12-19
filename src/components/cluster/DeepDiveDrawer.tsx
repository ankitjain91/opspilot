
import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import {
    Eye, FileText, Terminal as TerminalIcon, Activity,
    Maximize2, Minimize2, X, Trash2, EthernetPort, ChevronLeft, ChevronRight, FileCode, MessageSquare
} from 'lucide-react';
import { ClusterChatPanel } from '../ai/ClusterChatPanel';
import { useToast } from '../ui/Toast';
import yaml from 'js-yaml';
import { K8sObject } from '../../types/k8s';
import { Tab } from '../../types/ui';
import { TabButton } from './deep-dive/shared';
import { UnifiedResourceDetails } from './deep-dive/UnifiedResourceDetails';
import { YamlTab } from './deep-dive/YamlTab';
import { TerminalTab } from './deep-dive/TerminalTab';
import { PortForwardModal } from './deep-dive/PortForward';
import { ResourceContextMenu } from '../shared/ResourceContextMenu';
import { DeleteConfirmationModal } from '../shared/DeleteConfirmationModal';
import { useSingleResourceWatch } from '../../hooks/useSingleResourceWatch';

interface DeepDiveDrawerProps {
    tabs: Tab[];
    activeTabId: string;
    onTabChange: (tabId: string) => void;
    onTabClose: (tabId: string) => void;
    onCloseAll: () => void;
    onDelete: () => void;
    currentContext?: string;
    onOpenResource?: (kind: string, name: string, namespace: string, apiVersion?: string) => void; // Navigate to related resource
}

export function DeepDiveDrawer({ tabs, activeTabId, onTabChange, onTabClose, onCloseAll, onDelete, currentContext, onOpenResource }: DeepDiveDrawerProps) {
    const { showToast } = useToast();
    // Track content tab per resource tab (preserves state when switching)
    const [contentTabsMap, setContentTabsMap] = useState<Record<string, string>>({});
    const [drawerWidth, setDrawerWidth] = useState(650);
    const [isResizing, setIsResizing] = useState(false);
    const [showPortForward, setShowPortForward] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    const activeTab = tabs.find(t => t.id === activeTabId);
    const resource = activeTab?.resource;
    const kind = activeTab?.kind || '';

    // Get current content tab for active resource (default to overview)
    const activeContentTab = contentTabsMap[activeTabId] || "overview";

    // Set content tab for current resource
    const setActiveContentTab = (tab: string) => {
        setContentTabsMap(prev => ({ ...prev, [activeTabId]: tab }));
    };

    // Resize logic
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizing) {
                const newWidth = window.innerWidth - e.clientX;
                setDrawerWidth(Math.max(500, Math.min(newWidth, window.innerWidth - 100)));
            }
        };
        const handleMouseUp = () => setIsResizing(false);

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing]);

    // Keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // ESC to close current tab
            if (e.key === 'Escape') {
                onTabClose(activeTabId);
                return;
            }
            // Ctrl/Cmd + W to close current tab
            if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
                e.preventDefault();
                onTabClose(activeTabId);
                return;
            }
            // Ctrl/Cmd + [ or ] to navigate tabs
            if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) {
                e.preventDefault();
                const currentIndex = tabs.findIndex(t => t.id === activeTabId);
                if (e.key === '[' && currentIndex > 0) {
                    onTabChange(tabs[currentIndex - 1].id);
                } else if (e.key === ']' && currentIndex < tabs.length - 1) {
                    onTabChange(tabs[currentIndex + 1].id);
                }
                return;
            }
            // Alt + number to switch to specific tab
            if (e.altKey && e.key >= '1' && e.key <= '9') {
                e.preventDefault();
                const index = parseInt(e.key) - 1;
                if (index < tabs.length) {
                    onTabChange(tabs[index].id);
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeTabId, tabs, onTabClose, onTabChange]);


    // Fetch full details for current resource
    // Fetch YAML once and derive structured object so we don't get cache collisions with YamlTab
    const normalizedNamespace = resource?.namespace !== "-" ? resource?.namespace : null;

    const { data: resourceYaml, error: detailsError, isLoading: detailsLoading, isFetching } = useQuery({
        queryKey: ["resource_details", currentContext, normalizedNamespace, resource?.group, resource?.version, resource?.kind, resource?.name],
        queryFn: async () => {
            console.log('[DeepDiveDrawer] Fetching resource details for:', resource?.name);
            if (!resource) return null;
            const result = await invoke<string>("get_resource_details", {
                req: {
                    group: resource.group,
                    version: resource.version,
                    kind: resource.kind,
                    namespace: normalizedNamespace
                },
                name: resource.name
            });
            console.log('[DeepDiveDrawer] Received resource details, length:', result?.length);
            return result;
        },
        enabled: !!resource,
        staleTime: 30000, // Keep data fresh for 30s
        gcTime: 60000, // Keep in cache for 1 minute after last use
        retry: 2,
        refetchOnWindowFocus: false,
        refetchOnMount: false, // Don't refetch when component remounts
        refetchOnReconnect: false,
    });

    // Parse YAML (or JSON) into an object for detail views; keep YAML string for YamlTab
    // Note: Initial fetch returns YAML, but watch updates return JSON. Handle both.
    const fullObject = useMemo(() => {
        if (!resourceYaml) return null;
        try {
            let obj: any;

            // Try JSON first (from watch updates), then fall back to YAML (from initial fetch)
            try {
                obj = JSON.parse(resourceYaml);
            } catch {
                obj = yaml.load(resourceYaml) as any;
            }

            // Guard: Ensure loaded object matches current resource request to prevent stale data
            if (obj?.metadata?.name && resource?.name && obj.metadata.name !== resource.name) {
                console.warn("[DeepDiveDrawer] Name mismatch, ignoring stale data:", obj.metadata.name, "vs", resource.name);
                return null;
            }
            return obj;
        } catch (err) {
            console.error('Failed to parse resource details', err);
            return null;
        }
    }, [resourceYaml, resource?.name]);

    console.log("[DeepDiveDrawer Debug] Render state:", {
        resName: resource?.name,
        detailsLoading,
        hasError: !!detailsError,
        hasFullObject: !!fullObject
    });

    // Live Watch - re-enabled with improved cache handling
    // The hook now uses functional updates and prevents empty data from overwriting valid data
    useSingleResourceWatch(
        resource ? {
            group: resource.group,
            version: resource.version,
            kind: resource.kind,
            namespace: resource.namespace !== "-" ? resource.namespace : null,
            name: resource.name
        } : null,
        currentContext,
        !!resource // enabled
    );

    const handleDelete = () => {
        setShowDeleteModal(true);
    };

    const confirmDelete = async () => {
        if (!resource) return;
        const group = resource.group || "";
        const version = resource.version || "v1";

        try {
            await invoke("delete_resource", {
                group,
                version,
                kind,
                namespace: resource.namespace !== "-" ? resource.namespace : null,
                name: resource.name
            });
            showToast(`${resource.kind} ${resource.name} deleted successfully`, "success");
            onDelete();
            onTabClose(activeTabId);
        } catch (err) {
            console.error("Delete failed:", err);
            showToast(`Delete failed: ${err}`, 'error');
        }
    };

    if (!resource) return null;

    // State for minimization
    const [isMinimized, setIsMinimized] = useState(false);

    const getStatusColor = (status?: string) => {
        switch (status) {
            case 'Running': return 'bg-emerald-500';
            case 'Pending': return 'bg-yellow-500';
            case 'Failed': return 'bg-red-500';
            case 'Succeeded': return 'bg-cyan-500';
            default: return 'bg-zinc-500';
        }
    };

    const currentIndex = tabs.findIndex(t => t.id === activeTabId);

    // Minimized "Dock" View
    if (isMinimized) {
        return (
            <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 items-end">
                <div className="bg-[#0f0f12] border border-white/10 rounded-lg shadow-2xl p-3 flex items-center gap-4 animate-in slide-in-from-bottom-5 fade-in duration-200">
                    <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${getStatusColor(resource.status)} animate-pulse`} />
                        <div className="flex flex-col">
                            <span className="text-sm font-bold text-white">{resource.name}</span>
                            <span className="text-[10px] text-zinc-500 font-mono">{resource.kind} • {resource.namespace}</span>
                        </div>
                    </div>

                    <div className="h-6 w-px bg-white/10 mx-1" />

                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setIsMinimized(false)}
                            className="p-1.5 hover:bg-white/10 rounded text-cyan-400 hover:text-cyan-300 transition-colors"
                            title="Restore"
                        >
                            <Maximize2 size={16} />
                        </button>
                        <button
                            onClick={() => onTabClose(activeTabId)}
                            className="p-1.5 hover:bg-red-500/10 rounded text-zinc-500 hover:text-red-400 transition-colors"
                            title="Close"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>
                {tabs.length > 1 && (
                    <div className="bg-black/40 backdrop-blur-md border border-white/5 rounded-full px-3 py-1 text-[10px] text-zinc-400">
                        +{tabs.length - 1} other tabs
                    </div>
                )}
            </div>
        );
    }

    return (
        <>
            <aside
                className="fixed top-0 right-0 bottom-0 bg-[#0f0f12]/95 backdrop-blur-xl border-l border-white/10 shadow-2xl shadow-black z-50 flex flex-col transition-all duration-75"
                style={{ width: `${drawerWidth}px` }}
            >
                {/* Resize Handle */}
                <div
                    className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-cyan-500/50 transition-colors z-30"
                    onMouseDown={() => setIsResizing(true)}
                />

                {/* PortForward Modal */}
                <PortForwardModal
                    isOpen={showPortForward}
                    onClose={() => setShowPortForward(false)}
                    namespace={resource.namespace}
                    podName={resource.name}
                />

                {/* Delete Confirmation Modal */}
                <DeleteConfirmationModal
                    isOpen={showDeleteModal}
                    onClose={() => setShowDeleteModal(false)}
                    onConfirm={confirmDelete}
                    resourceName={resource.name}
                />

                {/* Resource Tabs - Browser-style tabs at top */}
                <div className="flex items-center justify-between bg-black/40 border-b border-white/5 shrink-0 backdrop-blur-md pr-2">
                    <div className="flex items-center flex-1 min-w-0 overflow-hidden">
                        {/* Tab Navigation Arrows */}
                        {tabs.length > 4 && (
                            <button
                                onClick={() => currentIndex > 0 && onTabChange(tabs[currentIndex - 1].id)}
                                disabled={currentIndex === 0}
                                className="p-2 text-zinc-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                            >
                                <ChevronLeft size={14} />
                            </button>
                        )}

                        {/* Tabs Scroll Area */}
                        <div className="flex items-center overflow-x-auto no-scrollbar mask-linear-fade">
                            {tabs.map((tab, index) => (
                                <button
                                    key={tab.id}
                                    onClick={() => onTabChange(tab.id)}
                                    className={`group flex items-center gap-2 px-3 py-2.5 min-w-[120px] max-w-[180px] border-r border-white/5 transition-all ${tab.id === activeTabId
                                        ? 'bg-[#0f0f12]/80 text-white shadow-inner'
                                        : 'bg-transparent text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                                        }`}
                                >
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusColor(tab.resource.status)} shadow-[0_0_8px_rgba(0,0,0,0.5)]`} />
                                    <div className="flex flex-col items-start min-w-0 flex-1">
                                        <span className="text-xs font-medium truncate w-full">{tab.resource.name}</span>
                                        <span className="text-[9px] text-zinc-600 truncate w-full group-hover:text-zinc-500">{tab.kind}</span>
                                    </div>
                                    <span
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onTabClose(tab.id);
                                        }}
                                        className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all shrink-0"
                                    >
                                        <X size={12} />
                                    </span>
                                </button>
                            ))}
                        </div>

                        {/* Tab Navigation Arrows */}
                        {tabs.length > 4 && (
                            <button
                                onClick={() => currentIndex < tabs.length - 1 && onTabChange(tabs[currentIndex + 1].id)}
                                disabled={currentIndex === tabs.length - 1}
                                className="p-2 text-zinc-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                            >
                                <ChevronRight size={14} />
                            </button>
                        )}
                    </div>

                    {/* Window Actions - Now Static part of header */}
                    <div className="flex items-center gap-1 pl-2 border-l border-white/5 bg-black/20 h-full py-1">
                        {/* Close All */}
                        {tabs.length > 1 && (
                            <button
                                onClick={onCloseAll}
                                className="px-2 py-1 mx-1 text-[10px] text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-all whitespace-nowrap"
                                title="Close all tabs (Ctrl+Shift+W)"
                            >
                                Close All
                            </button>
                        )}

                        {kind === 'Pod' && (
                            <button
                                onClick={() => setShowPortForward(true)}
                                className="p-1.5 text-zinc-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded transition-colors"
                                title="Port Forward"
                            >
                                <EthernetPort size={14} />
                            </button>
                        )}

                        <button
                            onClick={() => setActiveContentTab(activeContentTab === 'chat' ? 'overview' : 'chat')}
                            className={`p-1.5 rounded transition-colors ${activeContentTab === 'chat' ? 'text-violet-400 bg-violet-500/10' : 'text-zinc-400 hover:text-white hover:bg-white/10'}`}
                            title="Toggle AI Chat"
                        >
                            <MessageSquare size={14} />
                        </button>

                        <button
                            onClick={() => setActiveContentTab(activeContentTab === 'yaml' ? 'overview' : 'yaml')}
                            className={`p-1.5 rounded transition-colors ${activeContentTab === 'yaml' ? 'text-cyan-400 bg-cyan-500/10' : 'text-zinc-400 hover:text-white hover:bg-white/10'}`}
                            title="Toggle YAML View"
                        >
                            <FileCode size={14} />
                        </button>

                        <div className="w-px h-3 bg-white/10 mx-1" />

                        {/* Minimize Button - NEW */}
                        <button
                            onClick={() => setIsMinimized(true)}
                            className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                            title="Minimize to Dock"
                        >
                            <Minimize2 size={14} />
                        </button>

                        {/* Maximize/Restore Button - Updated Logic */}
                        <button
                            onClick={() => setDrawerWidth(drawerWidth === 650 ? window.innerWidth - 100 : 650)}
                            className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                            title={drawerWidth > 650 ? "Restore Width" : "Maximize Width"}
                        >
                            <Maximize2 size={14} />
                        </button>

                        <button
                            onClick={handleDelete}
                            className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                            title="Delete Resource"
                        >
                            <Trash2 size={14} />
                        </button>

                        <div className="w-px h-3 bg-white/10 mx-1" />

                        <button
                            onClick={() => onTabClose(activeTabId)}
                            className="p-1.5 text-zinc-400 hover:text-white hover:bg-white hover:bg-red-500 hover:text-white rounded transition-colors"
                            title="Close (Esc)"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>

                {/* Main Unified View */}

                {/* Content Area */}
                <div className="flex-1 overflow-hidden relative">
                    {activeContentTab === 'yaml' ? (
                        <div className="h-full p-0 bg-[#0f0f12]">
                            <YamlTab resource={resource} currentContext={currentContext} />
                        </div>
                    ) : activeContentTab === 'chat' ? (
                        <div className="h-full p-0 bg-[#16161a]">
                            <ClusterChatPanel
                                embedded={true}
                                resourceContext={{
                                    kind: resource.kind,
                                    name: resource.name,
                                    namespace: resource.namespace
                                }}
                                currentContext={currentContext}
                                onClose={() => setActiveContentTab('overview')}
                            />
                        </div>
                    ) : (
                        <UnifiedResourceDetails
                            key={resource.id || `${resource.kind}-${resource.name}`}
                            resource={resource}
                            fullObject={fullObject}
                            currentContext={currentContext}
                            loading={detailsLoading}
                            error={detailsError as Error | null}
                            onNavigateResource={onOpenResource}
                        />
                    )}
                </div>

                {/* Keyboard hints footer */}
                <div className="h-6 bg-black/40 border-t border-white/5 flex items-center justify-center gap-6 text-[9px] text-zinc-600 shrink-0 backdrop-blur-md">
                    <span><kbd className="px-1 py-0.5 bg-white/5 rounded text-zinc-400 font-sans">Esc</kbd> Close</span>
                    <span><kbd className="px-1 py-0.5 bg-white/5 rounded text-zinc-400 font-sans">Ctrl+[</kbd>/<kbd className="px-1 py-0.5 bg-white/5 rounded text-zinc-400 font-sans">]</kbd> Prev/Next</span>
                    <span><kbd className="px-1 py-0.5 bg-white/5 rounded text-zinc-400 font-sans">Alt+1-9</kbd> Switch Tab</span>
                </div>
            </aside>
        </>
    );
}
