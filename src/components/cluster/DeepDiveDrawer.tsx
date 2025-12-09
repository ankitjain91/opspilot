
import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import {
    Eye, FileText, Terminal as TerminalIcon, Activity, FileCode,
    Maximize2, Minimize2, X, Trash2, EthernetPort, ChevronLeft, ChevronRight
} from 'lucide-react';
import yaml from 'js-yaml';
import { K8sObject } from '../../types/k8s';
import { Tab } from '../../types/ui';
import { TabButton } from './deep-dive/shared';
import { OverviewTab } from './deep-dive/OverviewTab';
import { LogsTab } from './deep-dive/LogsTab';
import { EventsTab } from './deep-dive/EventsTab';
import { YamlTab } from './deep-dive/YamlTab';
import { TerminalTab } from './deep-dive/TerminalTab';
import { PortForwardModal } from './deep-dive/PortForward';
import { ResourceContextMenu } from '../shared/ResourceContextMenu';
import { DeleteConfirmationModal } from '../shared/DeleteConfirmationModal';

interface DeepDiveDrawerProps {
    tabs: Tab[];
    activeTabId: string;
    onTabChange: (tabId: string) => void;
    onTabClose: (tabId: string) => void;
    onCloseAll: () => void;
    onDelete: () => void;
    currentContext?: string;
}

export function DeepDiveDrawer({ tabs, activeTabId, onTabChange, onTabClose, onCloseAll, onDelete, currentContext }: DeepDiveDrawerProps) {
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
    const { data: resourceYaml, error: detailsError, isLoading: detailsLoading } = useQuery({
        queryKey: ["resource_details", currentContext, resource?.namespace, resource?.group, resource?.version, resource?.kind, resource?.name],
        queryFn: async () => {
            if (!resource) return null;
            return await invoke<string>("get_resource_details", {
                req: {
                    group: resource.group,
                    version: resource.version,
                    kind: resource.kind,
                    namespace: resource.namespace !== "-" ? resource.namespace : null
                },
                name: resource.name
            });
        },
        enabled: !!resource,
        staleTime: 10000,
    });

    // Parse YAML (or JSON) into an object for detail views; keep YAML string for YamlTab
    const fullObject = useMemo(() => {
        if (!resourceYaml) return null;
        try {
            return yaml.load(resourceYaml) as any;
        } catch (err) {
            console.error('Failed to parse resource details', err);
            return null;
        }
    }, [resourceYaml]);

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
            onDelete();
            onTabClose(activeTabId);
        } catch (err) {
            console.error("Delete failed:", err);
            if ((window as any).showToast) {
                (window as any).showToast(`Delete failed: ${err}`, 'error');
            }
        }
    };

    if (!resource) return null;

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

    return (
        <>
            <aside
                className="fixed top-0 right-0 bottom-0 bg-[#0a0a0b] border-l border-zinc-800 shadow-2xl z-50 flex flex-col transition-all duration-75"
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
                <div className="flex items-center bg-zinc-900 border-b border-zinc-800 shrink-0">
                    {/* Tab Navigation Arrows */}
                    {tabs.length > 4 && (
                        <button
                            onClick={() => currentIndex > 0 && onTabChange(tabs[currentIndex - 1].id)}
                            disabled={currentIndex === 0}
                            className="p-2 text-zinc-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronLeft size={14} />
                        </button>
                    )}

                    {/* Tabs */}
                    <div className="flex-1 flex items-center overflow-x-auto no-scrollbar">
                        {tabs.map((tab, index) => (
                            <button
                                key={tab.id}
                                onClick={() => onTabChange(tab.id)}
                                className={`group flex items-center gap-2 px-3 py-2 min-w-0 max-w-[180px] border-r border-zinc-800 transition-all ${
                                    tab.id === activeTabId
                                        ? 'bg-[#0a0a0b] text-white'
                                        : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                                }`}
                            >
                                <span className={`w-2 h-2 rounded-full shrink-0 ${getStatusColor(tab.resource.status)}`} />
                                <div className="flex flex-col items-start min-w-0 flex-1">
                                    <span className="text-xs font-medium truncate w-full">{tab.resource.name}</span>
                                    <span className="text-[9px] text-zinc-500 truncate w-full">{tab.kind}</span>
                                </div>
                                <span
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onTabClose(tab.id);
                                    }}
                                    className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-700 hover:text-red-400 transition-all shrink-0"
                                >
                                    <X size={12} />
                                </span>
                                {/* Alt+number hint */}
                                {index < 9 && tab.id === activeTabId && (
                                    <span className="text-[8px] text-zinc-600 shrink-0">Alt+{index + 1}</span>
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Tab Navigation Arrows */}
                    {tabs.length > 4 && (
                        <button
                            onClick={() => currentIndex < tabs.length - 1 && onTabChange(tabs[currentIndex + 1].id)}
                            disabled={currentIndex === tabs.length - 1}
                            className="p-2 text-zinc-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronRight size={14} />
                        </button>
                    )}

                    {/* Close All button */}
                    {tabs.length > 1 && (
                        <button
                            onClick={onCloseAll}
                            className="px-2 py-1 mx-1 text-[10px] text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-all"
                            title="Close all tabs (Ctrl+Shift+W)"
                        >
                            Close All
                        </button>
                    )}
                </div>

                {/* Current Resource Header */}
                <div className="h-11 border-b border-zinc-800 flex items-center justify-between px-4 bg-gradient-to-r from-zinc-900/50 to-transparent shrink-0">
                    <div className="flex items-center gap-3 overflow-hidden">
                        <div className={`w-2.5 h-2.5 rounded-full ${getStatusColor(resource.status)} shadow-lg`}
                             style={{ boxShadow: `0 0 8px ${resource.status === 'Running' ? '#10b981' : resource.status === 'Pending' ? '#eab308' : resource.status === 'Failed' ? '#ef4444' : '#71717a'}` }} />
                        <div className="flex flex-col overflow-hidden">
                            <h3 className="font-semibold truncate text-sm text-white flex items-center gap-2">
                                {resource.name}
                                {detailsLoading && <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />}
                            </h3>
                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{kind} • {resource.namespace}</span>
                        </div>
                    </div>

                    <div className="flex gap-1 items-center">
                        {kind === 'Pod' && (
                            <button
                                onClick={() => setShowPortForward(true)}
                                className="p-1.5 text-zinc-500 hover:text-cyan-400 hover:bg-cyan-500/10 rounded transition-colors"
                                title="Port Forward"
                            >
                                <EthernetPort size={14} />
                            </button>
                        )}

                        <button
                            onClick={() => setDrawerWidth(drawerWidth === 650 ? window.innerWidth - 100 : 650)}
                            className="p-1.5 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded transition-colors"
                            title={drawerWidth > 650 ? "Restore" : "Maximize"}
                        >
                            {drawerWidth > 650 ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>

                        <button
                            onClick={handleDelete}
                            className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                            title="Delete Resource"
                        >
                            <Trash2 size={14} />
                        </button>

                        <div className="w-px h-4 bg-zinc-800 mx-1" />

                        <button
                            onClick={() => onTabClose(activeTabId)}
                            className="p-1.5 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded transition-colors"
                            title="Close (Esc)"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>

                {/* Content Tabs (Overview, Logs, Events, YAML) */}
                <div className="flex border-b border-zinc-800 px-4 gap-4 shrink-0 bg-zinc-900/50 overflow-x-auto no-scrollbar">
                    <TabButton active={activeContentTab === "overview"} onClick={() => setActiveContentTab("overview")} icon={<Eye size={14} />} label="Overview" />
                    {(kind === 'Pod' || kind === 'Deployment' || kind === 'Service') && (
                        <TabButton active={activeContentTab === "logs"} onClick={() => setActiveContentTab("logs")} icon={<FileText size={14} />} label="Logs" />
                    )}
                    {kind === 'Pod' && (
                        <TabButton active={activeContentTab === "terminal"} onClick={() => setActiveContentTab("terminal")} icon={<TerminalIcon size={14} />} label="Terminal" />
                    )}
                    <TabButton active={activeContentTab === "events"} onClick={() => setActiveContentTab("events")} icon={<Activity size={14} />} label="Events" />
                    <TabButton active={activeContentTab === "yaml"} onClick={() => setActiveContentTab("yaml")} icon={<FileCode size={14} />} label="YAML" />
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-auto bg-[#0a0a0b] relative">
                    {activeContentTab === "overview" && (
                        <div className="h-full overflow-y-auto p-4">
                            <OverviewTab
                                resource={resource}
                                fullObject={fullObject}
                                loading={detailsLoading}
                                error={detailsError as Error | undefined}
                                onDelete={onDelete}
                                currentContext={currentContext}
                            />
                        </div>
                    )}

                    {activeContentTab === "logs" && fullObject && (
                        <LogsTab resource={resource} fullObject={fullObject} />
                    )}

                    {activeContentTab === "events" && (
                        <EventsTab resource={resource} />
                    )}

                    {activeContentTab === "terminal" && fullObject && (
                        <div className="h-full p-2 bg-[#1e1e1e]">
                            <TerminalTab namespace={resource.namespace} name={resource.name} podSpec={fullObject.spec} />
                        </div>
                    )}

                    {activeContentTab === "yaml" && (
                        <div className="h-full p-0">
                            <YamlTab resource={resource} currentContext={currentContext} />
                        </div>
                    )}
                </div>

                {/* Keyboard hints footer */}
                <div className="h-6 bg-zinc-900/80 border-t border-zinc-800 flex items-center justify-center gap-4 text-[9px] text-zinc-600 shrink-0">
                    <span><kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-500">Esc</kbd> Close</span>
                    <span><kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-500">Ctrl+[</kbd>/<kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-500">]</kbd> Prev/Next</span>
                    <span><kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-500">Alt+1-9</kbd> Switch Tab</span>
                </div>
            </aside>
        </>
    );
}
