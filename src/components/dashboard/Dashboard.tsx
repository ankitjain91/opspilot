
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import {
    Activity,
    AlertCircle,
    ArrowLeft,
    Box,
    ChevronDown,
    ChevronRight,
    Cloud,
    FileCog,
    Filter,
    FolderOpen,
    GitBranch,
    HardDrive,
    Info,
    Layers,
    LayoutDashboard,
    Loader2,
    LogOutIcon,
    MessageSquare,
    Network,
    Package,
    PieChart,
    Puzzle,
    RefreshCw,
    Search,
    Server,
    Shield,
    Terminal as TerminalIcon,
    X,
    Download,
    Settings
} from 'lucide-react';

import { NavResource, NavGroup, K8sObject, InitialClusterData } from '../../types/k8s';
import { Tab } from '../../types/ui';
import { CommandPalette } from '../shared/CommandPalette';
import { SidebarGroup, SidebarSection } from '../layout/Sidebar';
import { LocalTerminalTab } from '../tools/LocalTerminalTab';
import { AzurePage } from '../azure/AzurePage';
import { HelmReleases } from '../tools/HelmReleases';
import { ArgoCDWebView } from '../tools/ArgoCDWebView';
import { ResourceList } from '../cluster/ResourceList';
import { ClusterCockpit } from './ClusterCockpit';
import { CustomResourceHealth } from '../cluster/CustomResourceHealth';
import { DeepDiveDrawer } from '../cluster/DeepDiveDrawer';
import { DeleteConfirmationModal } from '../shared/DeleteConfirmationModal';
import Loading from '../Loading';
import { useUpdaterState, installPendingUpdate, checkForUpdatesManually } from '../Updater';
import { NotificationCenter } from '../notifications/NotificationCenter';
import { useKeyboardShortcuts, KeyboardShortcut } from '../../hooks/useKeyboardShortcuts';
import { KeyboardShortcutsModal } from '../shared/KeyboardShortcutsModal';
import { SettingsPage } from '../settings/SettingsPage';

// Define PersistQueryClientProvider in App, so queryClient is available via hook

import { SentinelStatus } from '../ai/useSentinel';

interface DashboardProps {
    onDisconnect: () => void;
    isConnected: boolean;
    setIsConnected: (v: boolean) => void;
    onOpenAzure?: () => void;
    showClusterChat?: boolean;
    onToggleClusterChat?: () => void;
    sentinelStatus?: SentinelStatus;
    onReconnectSentinel?: () => void;
    currentContext: string;
    onAutoInvestigate?: (prompt: string) => void;
}

export function Dashboard({ onDisconnect, onOpenAzure, showClusterChat, onToggleClusterChat, sentinelStatus, onReconnectSentinel, currentContext, onAutoInvestigate }: DashboardProps) {
    const [activeRes, setActiveRes] = useState<NavResource | null>(null);
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [resourceToDelete, setResourceToDelete] = useState<K8sObject | null>(null);
    const updaterState = useUpdaterState();
    const [appVersion, setAppVersion] = useState<string>("");

    // Fetch app version on mount
    useEffect(() => {
        getVersion().then(setAppVersion).catch(() => setAppVersion(""));
    }, []);

    // Resizable UI State
    const [sidebarWidth, setSidebarWidth] = useState(280);
    const [terminalHeight, setTerminalHeight] = useState(350);
    const [isResizingSidebar, setIsResizingSidebar] = useState(false);
    const [isResizingTerminal, setIsResizingTerminal] = useState(false);

    const [selectedNamespace, setSelectedNamespace] = useState<string>("All Namespaces");
    const [searchQuery, setSearchQuery] = useState(""); // Search State
    const [sidebarSearchQuery, setSidebarSearchQuery] = useState(""); // Sidebar search
    const [isCmdPaletteOpen, setIsCmdPaletteOpen] = useState(false); // Command Palette State
    const [isTerminalOpen, setIsTerminalOpen] = useState(false); // Local Terminal State
    const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false); // Keyboard shortcuts help
    const [isSettingsOpen, setIsSettingsOpen] = useState(false); // Settings page
    const [hasOpenedArgoCD, setHasOpenedArgoCD] = useState(false); // Track if ArgoCD has been opened

    // Lazy load ArgoCD state
    useEffect(() => {
        if (activeRes?.kind === "ArgoCD") {
            setHasOpenedArgoCD(true);
        }
    }, [activeRes]);

    const qc = useQueryClient();
    const searchInputRef = useRef<HTMLInputElement>(null);

    const selectedObj = tabs.find(t => t.id === activeTabId)?.resource || null;

    const handleOpenResource = (obj: K8sObject) => {
        const tabId = `${obj.namespace}-${obj.name}-${obj.kind}`;
        const existingTab = tabs.find(t => t.id === tabId);

        if (existingTab) {
            setActiveTabId(tabId);
        } else {
            const newTab: Tab = {
                id: tabId,
                resource: obj,
                kind: obj.kind
            };
            setTabs(prev => [...prev, newTab]);
            setActiveTabId(tabId);
        }
    };

    // Handler for navigating to a related resource from ResourceChainCard
    const handleOpenRelatedResource = (kind: string, name: string, namespace: string, apiVersion?: string) => {
        // Parse apiVersion (e.g., "apps/v1" -> group="apps", version="v1")
        // Core resources have no group (e.g., "v1" -> group="", version="v1")
        let group = '';
        let version = 'v1';

        if (apiVersion) {
            const parts = apiVersion.split('/');
            if (parts.length === 2) {
                group = parts[0];  // e.g., "apps" from "apps/v1"
                version = parts[1];
            } else {
                version = parts[0]; // e.g., "v1"
            }
        }

        // Create a minimal K8sObject for the related resource
        const relatedObj: K8sObject = {
            id: `${namespace}-${name}-${kind}`,
            name,
            namespace,
            kind,
            status: 'Unknown', // Will be updated when details are fetched
            age: '',
            group,
            version,
            raw_json: ''
        };
        handleOpenResource(relatedObj);
    };

    const handleCloseTab = (tabId: string | null) => {
        if (!tabId) return;

        setTabs(prev => {
            const filtered = prev.filter(t => t.id !== tabId);
            if (activeTabId === tabId && filtered.length > 0) {
                setActiveTabId(filtered[filtered.length - 1].id);
            } else if (filtered.length === 0) {
                setActiveTabId(null);
            }
            return filtered;
        });
    };

    // Fetch Current Context Name
    // Fetch Current Context Name - Managed by App.tsx now
    // const { data: currentContext } = useQuery({ ... });

    // Context Switcher State
    const [isContextDropdownOpen, setIsContextDropdownOpen] = useState(false);
    const [isSwitchingContext, setIsSwitchingContext] = useState(false);
    const [contextSwitchTarget, setContextSwitchTarget] = useState<string | null>(null);
    const [contextSearchQuery, setContextSearchQuery] = useState("");

    // Fetch all contexts for context switcher
    const { data: allContexts } = useQuery({
        queryKey: ["all_contexts"],
        queryFn: async () => {
            const result = await invoke<{ name: string; cluster: string; user: string }[]>("list_contexts", { customPath: null });
            return result;
        },
        staleTime: 1000 * 60 * 5,
    });

    // Handle context switch
    const handleSwitchContext = async (contextName: string) => {
        if (contextName === currentContext) {
            setIsContextDropdownOpen(false);
            return;
        }

        setIsSwitchingContext(true);
        setContextSwitchTarget(contextName);
        setIsContextDropdownOpen(false);

        try {
            // Clear backend caches
            await invoke("clear_all_caches");

            // Set the new context
            await invoke("set_kube_config", { path: null, context: contextName });

            // Trigger background KB preload for faster first query
            import('../ai/agentOrchestrator').then(({ preloadKBForContext }) => {
                preloadKBForContext(contextName);
            });

            // Optimistically update the global context immediately for instant UI feedback
            qc.setQueryData(["current_context"], contextName);

            // Invalidate all queries to refetch with new context
            await qc.invalidateQueries();

            (window as any).showToast?.(`Switched to ${contextName}`, 'success');
        } catch (e) {
            console.error("Failed to switch context:", e);
            (window as any).showToast?.(`Failed to switch context: ${e}`, 'error');
            setContextSwitchTarget(null);
        } finally {
            setIsSwitchingContext(false);
        }
    };

    // vcluster detection
    const isInsideVcluster = currentContext?.startsWith('vcluster_') || false;
    const [isDisconnectingVcluster, setIsDisconnectingVcluster] = useState(false);

    const getVclusterInfo = () => {
        if (!isInsideVcluster || !currentContext) return null;
        const parts = currentContext.split('_');
        if (parts.length >= 4) {
            return {
                name: parts[1],
                namespace: parts[2],
                hostContext: parts.slice(3).join('_')
            };
        }
        return null;
    };

    const handleDisconnectVcluster = async () => {
        const info = getVclusterInfo();
        if (!info) return;
        setIsDisconnectingVcluster(true);
        try {
            await invoke("disconnect_vcluster", { name: info.name, namespace: info.namespace });
            await qc.invalidateQueries({ queryKey: ["current_context"] });
        } catch (err) {
            console.error("Failed to disconnect from vcluster:", err);
        } finally {
            setIsDisconnectingVcluster(false);
        }
    };

    const vclusterInfo = getVclusterInfo();

    // Track previous context to detect changes
    const prevContextRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (prevContextRef.current && currentContext && prevContextRef.current !== currentContext) {
            // Context changed - remove all cached data except current_context query
            console.log(`Context changed from ${prevContextRef.current} to ${currentContext}, clearing cache`);
            qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "current_context" });
            // Clear component state that holds resources from the old context
            setTabs([]);
            setActiveTabId(null);
            setActiveRes(null);
            setSelectedNamespace("All Namespaces");
            setSearchQuery("");
            // NOTE: Don't reset hasOpenedArgoCD here - the ArgoCDWebView component
            // has its own context change detection and will reconnect automatically.
            // Unmounting/remounting causes unnecessary reconnection flicker.
        }
        // Trigger background KB preload on initial load and context changes
        if (currentContext && prevContextRef.current !== currentContext) {
            import('../ai/agentOrchestrator').then(({ preloadKBForContext }) => {
                preloadKBForContext(currentContext);
            });
        }
        if (currentContext) {
            prevContextRef.current = currentContext;
        }
    }, [currentContext, qc]);

    // Define all keyboard shortcuts
    const keyboardShortcuts: KeyboardShortcut[] = useMemo(() => [
        // Navigation
        {
            key: 'k',
            modifiers: ['cmd'],
            description: 'Open command palette',
            category: 'Navigation',
            action: () => setIsCmdPaletteOpen(open => !open),
            global: true
        },
        {
            key: 'f',
            modifiers: ['cmd'],
            description: 'Focus search / filter',
            category: 'Navigation',
            action: () => searchInputRef.current?.focus(),
            global: true
        },
        {
            key: 'Escape',
            modifiers: [],
            description: 'Close modal / panel',
            category: 'Navigation',
            action: () => {
                if (isShortcutsModalOpen) setIsShortcutsModalOpen(false);
                else if (isCmdPaletteOpen) setIsCmdPaletteOpen(false);
                else if (activeTabId) setActiveTabId(null);
            },
            global: true
        },
        {
            key: '/',
            modifiers: ['cmd'],
            description: 'Show keyboard shortcuts',
            category: 'Navigation',
            action: () => setIsShortcutsModalOpen(open => !open),
            global: true
        },

        // Tools
        {
            key: '`',
            modifiers: ['cmd'],
            description: 'Toggle terminal',
            category: 'Tools',
            action: () => setIsTerminalOpen(open => !open),
            global: true
        },
        {
            key: 'j',
            modifiers: ['cmd'],
            description: 'Toggle AI assistant',
            category: 'Tools',
            action: () => onToggleClusterChat?.(),
            global: true
        },

        // Actions
        {
            key: 'r',
            modifiers: ['cmd'],
            description: 'Refresh current view',
            category: 'Actions',
            action: () => qc.invalidateQueries(),
            global: true
        },
    ], [isShortcutsModalOpen, isCmdPaletteOpen, activeTabId, onToggleClusterChat, qc]);

    // Register keyboard shortcuts
    useKeyboardShortcuts(keyboardShortcuts);

    // Listen for event to open terminal with Claude Code
    const [pendingClaudeCommand, setPendingClaudeCommand] = useState(false);
    useEffect(() => {
        const unlisten = listen('open-terminal-with-claude', () => {
            console.log('[Dashboard] Received open-terminal-with-claude event');
            setIsTerminalOpen(true);
            setPendingClaudeCommand(true);
        });
        return () => { unlisten.then(fn => fn()); };
    }, []);

    // Handle Resizing
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizingSidebar) {
                setSidebarWidth(Math.max(200, Math.min(600, e.clientX)));
            }
            if (isResizingTerminal) {
                setTerminalHeight(Math.max(150, Math.min(800, window.innerHeight - e.clientY)));
            }
        };

        const handleMouseUp = () => {
            setIsResizingSidebar(false);
            setIsResizingTerminal(false);
            document.body.style.cursor = 'default';
        };

        if (isResizingSidebar || isResizingTerminal) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = isResizingSidebar ? 'col-resize' : 'row-resize';
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
        };
    }, [isResizingSidebar, isResizingTerminal]);

    // 1. Fetch Discovery (Nav Structure) Sidebar Structure - scoped to current context
    const { data: navStructure, isLoading: isDiscovering, isError: isDiscoveryError, error: discoveryError, refetch: refetchDiscovery } = useQuery({
        queryKey: ["discovery", currentContext],
        queryFn: async () => await invoke<NavGroup[]>("discover_api_resources"),
        enabled: !!currentContext,
        staleTime: 1000 * 60 * 5, // 5 minutes - API resources rarely change
        gcTime: 1000 * 60 * 30, // Keep in memory for 30 minutes
    });

    // 1b. Fetch initial cluster data in parallel - this populates caches for instant navigation
    const { data: initialData } = useQuery({
        queryKey: ["initial_cluster_data", currentContext],
        queryFn: async () => {
            const data = await invoke<InitialClusterData>("get_initial_cluster_data");

            // Pre-populate React Query caches with the fetched data for instant navigation
            qc.setQueryData(["cluster_stats"], data.stats);
            qc.setQueryData(["namespaces", currentContext], data.namespaces);
            qc.setQueryData(["list_resources", currentContext, "", "v1", "Pod", "All Namespaces"], data.pods);
            qc.setQueryData(["list_resources", currentContext, "", "v1", "Node", "All Namespaces"], data.nodes);
            qc.setQueryData(["list_resources", currentContext, "apps", "v1", "Deployment", "All Namespaces"], data.deployments);
            qc.setQueryData(["list_resources", currentContext, "", "v1", "Service", "All Namespaces"], data.services);

            return data;
        },
        enabled: !!currentContext,
        staleTime: 30000, // 30 seconds
        gcTime: 1000 * 60 * 5, // 5 minutes
    });

    // Clear context switch target once data is loaded for new context
    useEffect(() => {
        if (contextSwitchTarget && currentContext === contextSwitchTarget && initialData) {
            setContextSwitchTarget(null);
        }
    }, [contextSwitchTarget, currentContext, initialData]);

    // Invalidate discovery on context change
    useEffect(() => {
        if (currentContext) {
            try {
                qc.invalidateQueries({ queryKey: ["discovery", currentContext] });
            } catch { }
        }
    }, [currentContext, qc]);

    // 1a. Fetch CRDs separately for progressive hydration of Custom Resources
    const { data: crdGroups, isLoading: isCrdLoading } = useQuery({
        queryKey: ["crd-groups", currentContext],
        queryFn: async () => {
            // CRD fetching is now integrated into discover_api_resources
            // Returning empty object to disable separate fetching until cleaned up
            return {};
            /* 
            try {
                const crds = await invoke<any[]>("list_crds");
                ...
            } catch (e) { ... } 
            */
        },
        enabled: !!currentContext,
        staleTime: 1000 * 60 * 5,
    });

    useEffect(() => {
        const handler = () => {
            console.log("Reload event received, invalidating all queries");
            qc.invalidateQueries();
            refetchDiscovery();
        };
        window.addEventListener("lenskiller:reload", handler);
        return () => window.removeEventListener("lenskiller:reload", handler);
    }, [refetchDiscovery, qc]);

    // Default to Cluster Overview
    useEffect(() => {
        if (navStructure && !activeRes) {
            setActiveRes(null);
        }
    }, [navStructure]);

    // State for expanded groups
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
        const saved = localStorage.getItem('opspilot-expanded-groups');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch { }
        }
        return {
            "Cluster": false,
            "Workloads": false,
            "Network": false,
            "Config": false,
            "Storage": false,
            "Access Control": false,
            "IaC": false,
            "Virtual Clusters": true,
            "Custom Resources": false
        };
    });

    const toggleGroup = (group: string) => {
        setExpandedGroups(prev => {
            const newState = { ...prev, [group]: !prev[group] };
            localStorage.setItem('opspilot-expanded-groups', JSON.stringify(newState));
            return newState;
        });
    };

    // Grouping Logic
    const groupedResources = useMemo(() => {
        if (!navStructure) return {};

        const groups: Record<string, any[]> = {
            "Cluster": [],
            "Workloads": [],
            "Config": [],
            "Network": [],
            "Storage": [],
            "Access Control": []
        };

        const mappings: Record<string, string> = {
            "Node": "Cluster",
            "Namespace": "Cluster",
            "Event": "Cluster",
            "Pod": "Workloads",
            "Deployment": "Workloads",
            "StatefulSet": "Workloads",
            "DaemonSet": "Workloads",
            "Job": "Workloads",
            "CronJob": "Workloads",
            "ReplicaSet": "Workloads",
            "ConfigMap": "Config",
            "Secret": "Config",
            "ResourceQuota": "Config",
            "HorizontalPodAutoscaler": "Config",
            "Service": "Network",
            "Ingress": "Network",
            "NetworkPolicy": "Network",
            "Endpoint": "Network",
            "PersistentVolumeClaim": "Storage",
            "PersistentVolume": "Storage",
            "StorageClass": "Storage",
            "ServiceAccount": "Access Control",
            "Role": "Access Control",
            "RoleBinding": "Access Control",
            "ClusterRole": "Access Control",
            "ClusterRoleBinding": "Access Control"
        };

        navStructure.forEach(group => {
            if (group.title === "Custom Resources") return;
            group.items.forEach(item => {
                const targetGroup = mappings[item.kind];
                if (targetGroup) {
                    groups[targetGroup].push(item);
                } else {
                    const apiGroup = group.title;
                    if (!groups[apiGroup]) {
                        groups[apiGroup] = [];
                    }
                    groups[apiGroup].push(item);
                }
            });
        });

        if (crdGroups) {
            Object.entries(crdGroups).forEach(([apiGroup, items]) => {
                if (!groups[apiGroup]) groups[apiGroup] = [];
                const existingKinds = new Set(groups[apiGroup].map(i => i.kind));
                (items as any[]).forEach((i: any) => {
                    if (!existingKinds.has(i.kind)) {
                        const normalized = { ...i, title: i.title ?? i.kind };
                        groups[apiGroup].push(normalized);
                    }
                });
            });
        }

        Object.keys(groups).forEach(groupName => {
            const seen = new Set<string>();
            groups[groupName] = groups[groupName]
                .map(item => ({ ...item, title: item.title ?? item.kind }))
                .filter(item => {
                    const key = (item.title || '').toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
        });

        return groups;
    }, [navStructure, crdGroups]);

    // Filter grouped resources based on sidebar search
    const filteredGroupedResources = useMemo(() => {
        if (!sidebarSearchQuery.trim()) return groupedResources;

        const query = sidebarSearchQuery.toLowerCase();
        const filtered: Record<string, any[]> = {};

        Object.entries(groupedResources).forEach(([groupName, items]) => {
            const matchingItems = (items || []).filter(item => {
                const title = (item?.title ?? item?.kind ?? "").toLowerCase();
                const kind = (item?.kind ?? "").toLowerCase();
                return (
                    title.includes(query) ||
                    kind.includes(query) ||
                    groupName.toLowerCase().includes(query)
                );
            });

            if (matchingItems.length > 0) {
                filtered[groupName] = matchingItems;
            }
        });

        return filtered;
    }, [groupedResources, sidebarSearchQuery]);

    // 2. Fetch Namespaces for Filter
    const { data: namespaces } = useQuery({
        queryKey: ["namespaces", currentContext],
        queryFn: async () => {
            try {
                const res = await invoke<K8sObject[]>("list_resources", {
                    req: { group: "", version: "v1", kind: "Namespace", namespace: null }
                });
                const list = res.map(n => n.name).filter(Boolean);
                return Array.from(new Set(list)).sort();
            } catch (e) {
                console.error('Failed to fetch namespaces:', e);
                return [] as string[];
            }
        },
        staleTime: 1000 * 60 * 2,
        initialData: initialData?.namespaces?.sort(),
    });

    // 2.1 Check if ArgoCD exists in the cluster
    const { data: argocdExists } = useQuery({
        queryKey: ["argocd_exists", currentContext],
        queryFn: async () => {
            try {
                return await invoke<boolean>("check_argocd_exists");
            } catch {
                return false;
            }
        },
        staleTime: 1000 * 60 * 5, // 5 minutes - ArgoCD install status rarely changes
        retry: false,
    });

    // 2.5 Background Prefetching
    useEffect(() => {
        if (!navStructure || !currentContext) return;

        const prefetch = async () => {
            console.log("Starting background prefetch...");
            const allItems = navStructure.flatMap(group => group.items);
            const alreadyFetched = ["Pod", "Node", "Deployment", "Service"];
            const priorityKinds = ["ConfigMap", "Secret", "Ingress", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"];
            const priorityItems = allItems.filter(item =>
                priorityKinds.includes(item.kind) && !alreadyFetched.includes(item.kind)
            );
            const otherItems = allItems.filter(item =>
                !priorityKinds.includes(item.kind) && !alreadyFetched.includes(item.kind)
            );
            const sortedItems = [...priorityItems, ...otherItems];

            const batchSize = 10;
            for (let i = 0; i < sortedItems.length; i += batchSize) {
                const batch = sortedItems.slice(i, i + batchSize);
                await Promise.all(
                    batch.map(item =>
                        qc.prefetchQuery({
                            queryKey: ["list_resources", currentContext, item.group || "", item.version || "", item.kind || "", "All Namespaces"],
                            queryFn: async () => {
                                return await invoke<K8sObject[]>("list_resources", {
                                    req: {
                                        group: item.group,
                                        version: item.version,
                                        kind: item.kind,
                                        namespace: null
                                    }
                                });
                            },
                            staleTime: 30000,
                        })
                    )
                );
            }
            console.log("Background prefetch complete.");
        };

        const timer = setTimeout(prefetch, 500);
        return () => clearTimeout(timer);
    }, [navStructure, currentContext, qc]);

    const deleteMutation = useMutation({
        mutationFn: async (obj: K8sObject) => {
            if (!activeRes) return;
            (window as any).showToast?.(`Deleting ${activeRes.kind} '${obj.name}'...`, 'info');
            await invoke("delete_resource", {
                req: { group: activeRes.group, version: activeRes.version, kind: activeRes.kind, namespace: obj.namespace === "-" ? null : obj.namespace },
                name: obj.name
            });
            return { kind: activeRes.kind, name: obj.name };
        },
        onSuccess: (data) => {
            if (data) {
                // Note: For resources with finalizers, this just initiates deletion
                // The resource may enter "Terminating" state before being fully removed
                (window as any).showToast?.(`${data.kind} '${data.name}' deletion initiated`, 'success');
            }
            qc.invalidateQueries({ queryKey: ["list_resources"] });
            if (activeTabId) {
                handleCloseTab(activeTabId);
            }
        },
        onError: (err, obj) => {
            (window as any).showToast?.(`Failed to delete '${obj.name}': ${err}`, 'error');
        }
    });

    if (isDiscoveryError) {
        return (
            <div className="h-screen bg-[#1e1e1e] text-[#cccccc] flex flex-col items-center justify-center p-8">
                <div className="bg-[#f48771]/10 p-8 rounded-xl border border-[#f48771]/20 max-w-md text-center">
                    <AlertCircle size={40} className="text-[#f48771] mx-auto mb-4" />
                    <h3 className="text-lg font-bold text-white mb-2">Discovery Failed</h3>
                    <p className="text-[#f48771] text-sm mb-6">{discoveryError?.toString()}</p>
                    <div className="flex gap-3 justify-center">
                        <button
                            onClick={onDisconnect}
                            className="bg-[#3e3e42] hover:bg-[#4a4a4a] text-white px-4 py-2 rounded transition-colors text-sm"
                        >
                            Go Back
                        </button>
                        <button
                            onClick={() => onOpenAzure?.()}
                            className="bg-[#007acc] hover:bg-[#0098ff] text-white px-4 py-2 rounded transition-colors text-sm flex items-center gap-2"
                        >
                            <Cloud size={14} />
                            Open Azure Explorer
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Show loading state when waiting for context or discovery
    // Don't show "No Data Found" until we've actually tried to discover with a valid context
    if (!navStructure && !isDiscovering) {
        // If we don't have a context yet, show loading (context is still being fetched)
        if (!currentContext) {
            return (
                <div className="h-screen flex flex-col items-center justify-center p-8" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
                    <Loader2 size={40} className="animate-spin text-cyan-500 mb-4" />
                    <h3 className="text-lg font-medium mb-2">Connecting to cluster...</h3>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Fetching cluster context</p>
                </div>
            );
        }

        // Context exists but no data - show error
        return (
            <div className="h-screen bg-[#1e1e1e] text-[#cccccc] flex flex-col items-center justify-center p-8">
                <AlertCircle size={40} className="text-[#f48771] mb-4" />
                <h3 className="text-lg font-bold text-white mb-2">No Data Found</h3>
                <p className="text-[#858585] text-sm mb-6">Discovery completed but returned no structure.</p>
                <div className="flex gap-3 justify-center">
                    <button
                        onClick={onDisconnect}
                        className="bg-[#3e3e42] hover:bg-[#4a4a4a] text-white px-4 py-2 rounded transition-colors text-sm"
                    >
                        Go Back
                    </button>
                    <button
                        onClick={() => onOpenAzure?.()}
                        className="bg-[#007acc] hover:bg-[#0098ff] text-white px-4 py-2 rounded transition-colors text-sm flex items-center gap-2"
                    >
                        <Cloud size={14} />
                        Open Azure Explorer
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-screen font-sans overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
            <CommandPalette
                isOpen={isCmdPaletteOpen}
                onClose={() => setIsCmdPaletteOpen(false)}
                navStructure={navStructure}
                onNavigate={(res) => {
                    setActiveRes(res);
                    setActiveTabId(null);
                    setSearchQuery("");
                }}
            />

            {/* Sidebar */}
            <aside
                className="fixed top-0 bottom-0 left-0 z-30 flex flex-col glass-panel"
                style={{ width: sidebarWidth, borderRight: '1px solid var(--border-subtle)' }}
            >
                {/* Sidebar Resize Handle */}
                <div
                    className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-500/50 transition-colors z-40"
                    onMouseDown={() => setIsResizingSidebar(true)}
                />
                {/* Sidebar Header */}
                <div className="h-14 flex items-center justify-between px-4 shrink-0 backdrop-blur-sm" style={{ borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-hover)' }}>
                    <div className="flex items-center gap-3 overflow-hidden">
                        <img src="/icon.png" alt="OpsPilot" className="w-8 h-8 rounded-lg shadow-lg shadow-cyan-500/20 shrink-0" />
                        <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="font-bold text-sm tracking-tight truncate" style={{ color: 'var(--text-primary)' }}>OpsPilot</span>
                                {appVersion && (
                                    <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>v{appVersion}</span>
                                )}
                            </div>
                            <button
                                onClick={() => setIsContextDropdownOpen(!isContextDropdownOpen)}
                                className="flex items-center gap-1.5 rounded px-1 -mx-1 py-0.5 transition-colors group"
                                style={{ backgroundColor: 'transparent' }}
                                title="Click to switch context"
                            >
                                <div className={`w-1.5 h-1.5 rounded-full ${isSwitchingContext ? 'bg-yellow-400 animate-pulse' : 'bg-emerald-400'} shadow-[0_0_6px_rgba(52,211,153,0.6)]`} />
                                <span className="text-[10px] truncate font-medium" style={{ color: 'var(--text-tertiary)' }}>{currentContext || "Unknown"}</span>
                                <ChevronDown size={10} className={`transition-transform ${isContextDropdownOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
                            </button>
                        </div>
                    </div>
                    <button
                        onClick={updaterState === 'update-available' ? installPendingUpdate : checkForUpdatesManually}
                        className={`p-1.5 rounded-md transition-all relative ${updaterState === 'update-available'
                            ? 'text-purple-400 bg-purple-500/20 animate-pulse shadow-[0_0_12px_rgba(168,85,247,0.5)]'
                            : updaterState === 'checking'
                                ? 'text-purple-400'
                                : 'text-zinc-500 hover:text-purple-400 hover:bg-purple-500/10'
                            }`}
                        title={updaterState === 'update-available' ? 'Update Available - Click to Install' : 'Check for Updates'}
                    >
                        {updaterState === 'checking' ? (
                            <RefreshCw size={16} className="animate-spin" />
                        ) : updaterState === 'update-available' ? (
                            <>
                                <Download size={16} />
                                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-purple-500 rounded-full animate-ping" />
                                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-purple-400 rounded-full" />
                            </>
                        ) : (
                            <Download size={16} />
                        )}
                    </button>
                </div>

                {/* Sidebar Search Bar */}
                <div className="px-3 pt-3 pb-2 flex items-center gap-2">
                    <div className="relative group flex-1">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500 group-focus-within:text-cyan-400 transition-colors">
                            <Search size={14} />
                        </div>
                        <input
                            type="text"
                            placeholder="Search resources..."
                            value={sidebarSearchQuery}
                            onChange={(e) => setSidebarSearchQuery(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 text-sm rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all"
                            style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                        />
                        {sidebarSearchQuery && (
                            <button
                                onClick={() => setSidebarSearchQuery("")}
                                className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-500 hover:text-white transition-colors"
                            >
                                <X size={14} />
                            </button>
                        )}
                    </div>

                    <button
                        onClick={async () => {
                            try {
                                await invoke("clear_discovery_cache");
                                await qc.invalidateQueries({ queryKey: ["nav_structure"] });
                                window.location.reload();
                            } catch (e) {
                                console.error("Failed to refresh discovery:", e);
                            }
                        }}
                        className="p-2 rounded-md transition-colors"
                        style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
                        title="Refresh Discovery Cache"
                    >
                        <RefreshCw size={14} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto py-2 px-3 space-y-6 custom-scrollbar">
                    {/* Cluster Overview Button */}
                    {(!sidebarSearchQuery || "cluster".includes(sidebarSearchQuery.toLowerCase()) || "overview".includes(sidebarSearchQuery.toLowerCase()) || "dashboard".includes(sidebarSearchQuery.toLowerCase())) && (
                        <div className="mb-1">
                            <button
                                onClick={() => {
                                    setActiveRes(null);
                                    setActiveTabId(null);
                                    setSearchQuery("");
                                }}
                                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-all group ${activeRes === null ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-lg shadow-cyan-500/30" : "text-zinc-400 hover:text-white hover:bg-white/5"}`}
                            >
                                <div className="flex items-center gap-2.5">
                                    <LayoutDashboard size={18} className={activeRes === null ? "text-white" : "text-cyan-400 group-hover:text-cyan-300"} />
                                    <span>Cluster Overview</span>
                                </div>
                            </button>
                        </div>
                    )}

                    {/* Custom Resource Health Button */}
                    {(!sidebarSearchQuery || "crossplane".includes(sidebarSearchQuery.toLowerCase()) || "custom".includes(sidebarSearchQuery.toLowerCase()) || "resource".includes(sidebarSearchQuery.toLowerCase()) || "cr".includes(sidebarSearchQuery.toLowerCase()) || "health".includes(sidebarSearchQuery.toLowerCase())) && (
                        <div className="mb-1">
                            <button
                                onClick={() => {
                                    setActiveRes({ kind: "CustomResourceHealth", group: "internal", version: "v1", namespaced: false, title: "CR Health" });
                                    setActiveTabId(null);
                                    setSearchQuery("");
                                }}
                                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-all group ${activeRes?.kind === "CustomResourceHealth" ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg shadow-purple-500/30" : "text-zinc-400 hover:text-white hover:bg-white/5"}`}
                            >
                                <div className="flex items-center gap-2.5">
                                    <Layers size={18} className={activeRes?.kind === "CustomResourceHealth" ? "text-white" : "text-purple-400 group-hover:text-purple-300"} />
                                    <span>CR Health</span>
                                </div>
                            </button>
                        </div>
                    )}

                    {/* Helm Releases Button */}
                    {(!sidebarSearchQuery || "helm".includes(sidebarSearchQuery.toLowerCase()) || "release".includes(sidebarSearchQuery.toLowerCase())) && (
                        <div className="mb-1">
                            <button
                                onClick={() => {
                                    setActiveRes({ kind: "HelmReleases", group: "helm", version: "v1", namespaced: false, title: "Releases" });
                                    setActiveTabId(null);
                                    setSearchQuery("");
                                }}
                                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-all group ${activeRes?.kind === "HelmReleases" ? "bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg shadow-purple-500/30" : "text-zinc-400 hover:text-white hover:bg-white/5"}`}
                            >
                                <div className="flex items-center gap-2.5">
                                    <Package size={18} className={activeRes?.kind === "HelmReleases" ? "text-white" : "text-purple-400 group-hover:text-purple-300"} />
                                    <span>Helm Releases</span>
                                </div>
                            </button>
                        </div>
                    )}

                    {/* Argo CD Button - Only show if ArgoCD is installed */}
                    {argocdExists && (!sidebarSearchQuery || "argo".includes(sidebarSearchQuery.toLowerCase()) || "application".includes(sidebarSearchQuery.toLowerCase()) || "gitops".includes(sidebarSearchQuery.toLowerCase())) && (
                        <div className="mb-1">
                            <button
                                onClick={() => {
                                    setActiveRes({ kind: "ArgoCD", group: "argoproj.io", version: "v1alpha1", namespaced: false, title: "Argo CD" });
                                    setActiveTabId(null);
                                    setSearchQuery("");
                                }}
                                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-all group ${activeRes?.kind === "ArgoCD" ? "bg-gradient-to-r from-orange-600 to-red-600 text-white shadow-lg shadow-orange-500/30" : "text-zinc-400 hover:text-white hover:bg-white/5"}`}
                            >
                                <div className="flex items-center gap-2.5">
                                    <GitBranch size={18} className={activeRes?.kind === "ArgoCD" ? "text-white" : "text-orange-400 group-hover:text-orange-300"} />
                                    <span>Argo CD</span>
                                </div>
                            </button>
                        </div>
                    )}

                    {/* Sidebar Skeleton while discovering */}
                    {isDiscovering && (
                        <div className="space-y-4 animate-pulse">
                            {["Cluster", "Workloads", "Config", "Network", "Storage"].map((title) => (
                                <div key={title} className="space-y-1.5">
                                    <div className="flex items-center gap-2 px-2 py-1.5">
                                        <div className="w-4 h-4 bg-zinc-800 rounded" />
                                        <div className="h-3 bg-zinc-800 rounded w-20" />
                                    </div>
                                    <div className="pl-6 space-y-1">
                                        {[1, 2, 3].map((i) => (
                                            <div key={i} className="h-7 bg-zinc-900/50 rounded mx-2" />
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Render Groups */}
                    {!navStructure || isDiscovering ? null : (
                        ["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "IaC"].map(grp => (
                            filteredGroupedResources[grp] && (
                                <SidebarGroup
                                    key={grp}
                                    title={grp}
                                    // Mapping icons for groups
                                    icon={grp === "Cluster" ? Server :
                                        grp === "Workloads" ? PieChart :
                                            grp === "Config" ? FileCog :
                                                grp === "Network" ? Network :
                                                    grp === "Storage" ? HardDrive :
                                                        grp === "Access Control" ? Shield :
                                                            grp === "IaC" ? Cloud : Box}
                                    items={filteredGroupedResources[grp]}
                                    activeRes={activeRes}
                                    onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
                                    isOpen={expandedGroups[grp]}
                                    onToggle={() => toggleGroup(grp)}
                                />
                            )
                        ))
                    )}

                    {/* Custom Resources Section */}
                    {!navStructure || isDiscovering ? null : Object.keys(filteredGroupedResources).some(g => !["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "IaC"].includes(g)) && (
                        <SidebarSection
                            title="Custom Resources"
                            icon={Puzzle}
                            isOpen={expandedGroups["Custom Resources"]}
                            onToggle={() => toggleGroup("Custom Resources")}
                        >
                            {isCrdLoading && Object.keys(filteredGroupedResources).filter(g => !["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "IaC"].includes(g)).length === 0 && (
                                <div className="px-3 py-2">
                                    <Loading size={14} label="Loading Custom Resources…" />
                                </div>
                            )}
                            {Object.keys(filteredGroupedResources)
                                .filter(g => !["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "IaC"].includes(g))
                                .sort()
                                .map(groupTitle => (
                                    <SidebarGroup
                                        key={groupTitle}
                                        title={groupTitle}
                                        icon={FolderOpen}
                                        items={filteredGroupedResources[groupTitle]}
                                        activeRes={activeRes}
                                        onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
                                        isOpen={expandedGroups[groupTitle]}
                                        onToggle={() => toggleGroup(groupTitle)}
                                    />
                                ))}
                        </SidebarSection>
                    )}
                </div>

                {/* User Profile / Context / Tools */}
                <div className="p-3 border-t border-white/5 flex flex-col gap-1.5 bg-white/5 backdrop-blur-md">
                    <button
                        onClick={onToggleClusterChat}
                        className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-all group ${showClusterChat ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg shadow-purple-500/30" : "text-zinc-400 hover:text-white hover:bg-white/5"}`}
                    >
                        <div className="flex items-center gap-2.5">
                            <MessageSquare className={showClusterChat ? "text-white" : "text-purple-400 group-hover:text-purple-300"} size={18} />
                            <span>AI Assistant</span>
                        </div>
                        {showClusterChat && <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
                    </button>

                    <button
                        onClick={() => setIsTerminalOpen(!isTerminalOpen)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-md transition-all ${isTerminalOpen ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-500/30' : 'text-zinc-400 hover:text-white hover:bg-white/5'}`}
                    >
                        <TerminalIcon size={18} className={isTerminalOpen ? "text-white" : "text-emerald-400"} />
                        <span>Terminal</span>
                    </button>

                    <button
                        onClick={() => setIsSettingsOpen(true)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 rounded-md transition-all group"
                    >
                        <Settings size={18} className="text-zinc-500 group-hover:text-zinc-300" />
                        <span>Settings</span>
                    </button>

                    <button
                        onClick={async () => {
                            qc.removeQueries();
                            try {
                                await invoke("clear_discovery_cache");
                            } catch (e) {
                                console.error("Failed to clear discovery cache:", e);
                            }
                            onDisconnect();
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-all group"
                    >
                        <LogOutIcon size={18} className="group-hover:text-red-400" />
                        <span>Disconnect</span>
                    </button>
                </div>
            </aside >

            {/* Local Terminal Drawer */}
            {
                isTerminalOpen && (
                    <div
                        className="absolute bottom-0 left-0 right-0 bg-black border-t border-gray-800 z-40 flex flex-col shadow-2xl shadow-green-500/10 animate-in slide-in-from-bottom-10"
                        style={{ height: terminalHeight, left: sidebarWidth }}
                    >
                        <div
                            className="absolute top-0 left-0 right-0 h-1 cursor-row-resize hover:bg-gradient-to-r hover:from-green-500 hover:to-emerald-500 transition-all z-50"
                            onMouseDown={() => setIsResizingTerminal(true)}
                        />

                        <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
                            <span className="text-sm font-bold text-[#cccccc] flex items-center gap-2">
                                <TerminalIcon size={16} />
                                Local Terminal
                            </span>
                            <button onClick={() => setIsTerminalOpen(false)} className="text-[#858585] hover:text-white">
                                <X size={16} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-hidden p-2">
                            <LocalTerminalTab
                                initialCommand={pendingClaudeCommand ? 'claude' : undefined}
                                onCommandSent={() => setPendingClaudeCommand(false)}
                            />
                        </div>
                    </div>
                )
            }

            {/* Main Content */}
            <main
                className="flex-1 flex flex-col min-w-0 bg-[#09090b] relative transition-all duration-300 ease-in-out"
                style={{
                    marginLeft: sidebarWidth,
                    paddingBottom: isTerminalOpen ? terminalHeight : 0
                }}
            >
                {/* Context Switching Loading Overlay */}
                {(isSwitchingContext || contextSwitchTarget) && (
                    <div className="absolute inset-0 z-50 bg-[#09090b]/95 backdrop-blur-sm flex flex-col items-center justify-center">
                        <div className="flex flex-col items-center gap-4 p-8 rounded-2xl bg-zinc-900/80 border border-white/10 shadow-2xl">
                            <div className="relative">
                                <div className="w-16 h-16 rounded-full border-4 border-zinc-700 border-t-cyan-500 animate-spin" />
                                <Server className="absolute inset-0 m-auto w-6 h-6 text-cyan-400" />
                            </div>
                            <div className="text-center">
                                <h3 className="text-lg font-semibold text-white mb-1">Switching Context</h3>
                                <p className="text-sm text-zinc-400">
                                    Connecting to <span className="text-cyan-400 font-medium">{contextSwitchTarget || currentContext}</span>
                                </p>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-zinc-500">
                                <Loader2 size={12} className="animate-spin" />
                                <span>Loading cluster data...</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Sticky vcluster Banner */}
                {isInsideVcluster && vclusterInfo && (
                    <div className="sticky top-0 z-30 bg-gradient-to-r from-purple-900/80 via-purple-800/70 to-purple-900/80 backdrop-blur-sm border-b border-purple-500/30 px-4 py-2 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <Box className="w-4 h-4 text-purple-400" />
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-purple-200">Virtual Cluster:</span>
                                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-500/30 text-purple-200 border border-purple-500/40">
                                    {vclusterInfo.name}
                                </span>
                                <span className="text-xs text-purple-400/70">
                                    in {vclusterInfo.namespace} on {vclusterInfo.hostContext}
                                </span>
                            </div>
                        </div>
                        <button
                            onClick={handleDisconnectVcluster}
                            disabled={isDisconnectingVcluster}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 hover:border-purple-500/60 text-purple-200 text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isDisconnectingVcluster ? (
                                <>
                                    <Loader2 size={12} className="animate-spin" />
                                    Disconnecting...
                                </>
                            ) : (
                                <>
                                    <LogOutIcon size={12} />
                                    Back to Host
                                </>
                            )}
                        </button>
                    </div>
                )}

                {/* Persistent ArgoCD View - Rendered outside conditional to stay mounted */}
                {argocdExists && hasOpenedArgoCD && (
                    <div
                        className={`absolute inset-0 z-10 bg-zinc-950 ${activeRes?.kind === "ArgoCD" ? "flex flex-col" : "hidden"}`}
                        style={{ display: activeRes?.kind === "ArgoCD" ? 'flex' : 'none' }}
                    >
                        <ArgoCDWebView
                            onClose={() => setActiveRes(null)}
                            kubeContext={currentContext}
                        />
                    </div>
                )}

                {activeRes?.kind === "CustomResourceHealth" ? (
                    <div className="flex-1 min-h-0 overflow-y-auto">
                        <CustomResourceHealth
                            currentContext={currentContext}
                            onOpenResource={handleOpenRelatedResource}
                            onAutoInvestigate={onAutoInvestigate}
                        />
                    </div>
                ) : activeRes?.kind === "HelmReleases" ? (
                    <HelmReleases currentContext={currentContext} />
                ) : activeRes?.kind === "ArgoCD" ? (
                    // ArgoCD is rendered persistently above - just show empty container here
                    <div className="flex-1" />
                ) : (
                    <>
                        {/* Header */}
                        <header className="h-14 glass-header flex items-center justify-between px-6 sticky top-0 z-20">
                            <div className="flex items-center gap-4">
                                {/* Back to Cockpit button - only show when viewing resources */}
                                {activeRes && (
                                    <button
                                        onClick={() => {
                                            setActiveRes(null);
                                            setActiveTabId(null);
                                            setSearchQuery("");
                                        }}
                                        className="flex items-center gap-1.5 px-2 py-1.5 -ml-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-all group"
                                        title="Back to Cluster Overview"
                                    >
                                        <ArrowLeft size={16} className="group-hover:-translate-x-0.5 transition-transform" />
                                        <LayoutDashboard size={14} className="text-cyan-400" />
                                    </button>
                                )}
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="text-zinc-500 font-medium">{activeRes?.group || "Core"}</span>
                                    <ChevronRight size={14} className="text-zinc-700" />
                                    <span className="font-semibold text-zinc-100 tracking-tight">{activeRes?.title}</span>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                {/* Sentinel Status - Compact indicator with info popover, clickable to reconnect */}
                                <div className="relative group/sentinel">
                                    <button
                                        onClick={() => {
                                            if (sentinelStatus !== 'connected' && onReconnectSentinel) {
                                                onReconnectSentinel();
                                            }
                                        }}
                                        className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium transition-all ${sentinelStatus === 'connected'
                                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 cursor-help'
                                            : sentinelStatus === 'connecting'
                                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 cursor-wait'
                                                : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/50 hover:bg-zinc-700/50 hover:text-zinc-400 cursor-pointer'
                                            }`}
                                        title={sentinelStatus !== 'connected' ? 'Click to reconnect' : 'Sentinel is active'}
                                    >
                                        <Shield size={12} className={sentinelStatus === 'connecting' ? 'animate-pulse' : ''} />
                                        <span className="hidden sm:inline">
                                            {sentinelStatus === 'connected' ? 'Sentinel' : sentinelStatus === 'connecting' ? 'Connecting' : 'Offline'}
                                        </span>
                                        <div className={`w-1.5 h-1.5 rounded-full ${sentinelStatus === 'connected' ? 'bg-emerald-400' :
                                            sentinelStatus === 'connecting' ? 'bg-amber-400 animate-pulse' :
                                                'bg-zinc-600'
                                            }`} />
                                        <Info size={10} className="opacity-50 group-hover/sentinel:opacity-100 transition-opacity" />
                                    </button>
                                    {/* Info Popover */}
                                    <div className="absolute top-full right-0 mt-2 w-64 p-3 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl opacity-0 invisible group-hover/sentinel:opacity-100 group-hover/sentinel:visible transition-all duration-200 z-50">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Shield size={14} className="text-emerald-400" />
                                            <span className="text-xs font-bold text-white">Sentinel Watchdog</span>
                                        </div>
                                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                                            {sentinelStatus === 'connected'
                                                ? 'Actively monitoring Kubernetes events. You\'ll be notified of pod crashes, OOM kills, scheduling failures, and other cluster issues automatically.'
                                                : sentinelStatus === 'connecting'
                                                    ? 'Connecting to the Kubernetes event stream...'
                                                    : 'Not connected. Click to reconnect. Sentinel monitors Warning events from your cluster and alerts you to issues proactively.'}
                                        </p>
                                        <div className={`mt-2 text-[10px] flex items-center gap-1.5 ${sentinelStatus === 'connected' ? 'text-emerald-400' :
                                            sentinelStatus === 'connecting' ? 'text-amber-400' :
                                                'text-zinc-500'
                                            }`}>
                                            <div className={`w-1.5 h-1.5 rounded-full ${sentinelStatus === 'connected' ? 'bg-emerald-400' :
                                                sentinelStatus === 'connecting' ? 'bg-amber-400 animate-pulse' :
                                                    'bg-zinc-600'
                                                }`} />
                                            {sentinelStatus === 'connected' ? 'Active' : sentinelStatus === 'connecting' ? 'Connecting...' : 'Offline - Click to reconnect'}
                                        </div>
                                    </div>
                                </div>
                                <NotificationCenter />
                                <div className="relative group">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500 group-focus-within:text-cyan-400 transition-colors">
                                        <Search size={14} />
                                    </div>
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        placeholder="Filter resources..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="bg-zinc-900/50 border border-white/10 text-zinc-200 text-xs rounded-full focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500/50 block w-48 pl-9 p-2 placeholder:text-zinc-600 focus:outline-none transition-all focus:w-64"
                                    />
                                </div>

                                <div className="relative group">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                                        <Filter size={14} />
                                    </div>
                                    <select
                                        value={selectedNamespace}
                                        onChange={(e) => setSelectedNamespace(e.target.value)}
                                        className="bg-zinc-900/50 border border-white/10 text-zinc-200 text-xs rounded-full focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500/50 block w-40 pl-9 pr-8 p-2 appearance-none focus:outline-none cursor-pointer hover:bg-zinc-800 transition-all"
                                    >
                                        <option value="">All Namespaces</option>
                                        {namespaces?.map(ns => (
                                            <option key={ns} value={ns}>{ns}</option>
                                        ))}
                                    </select>
                                    <div className="absolute inset-y-0 right-0 pr-2 flex items-center pointer-events-none text-zinc-500">
                                        <ChevronDown size={14} />
                                    </div>
                                </div>
                            </div>
                        </header>

                        {/* Content */}
                        <div className="flex-1 overflow-hidden relative">
                            {activeRes?.kind === "Azure" ? (
                                <AzurePage onConnect={() => setActiveRes(null)} />
                            ) : activeRes?.kind === "HelmReleases" ? (
                                <HelmReleases currentContext={currentContext} />
                            ) : activeRes?.kind === "ArgoCD" ? (
                                // Placeholder to keep the switch logic happy, but actual view is rendered above
                                <div className="h-full w-full bg-zinc-950" />
                            ) : activeRes ? (
                                !navStructure || isDiscovering ? (
                                    <div className="h-full flex items-center justify-center"><Loading size={32} label="Loading resources..." /></div>
                                ) : (
                                    <ResourceList
                                        resourceType={activeRes}
                                        onSelect={handleOpenResource}
                                        namespaceFilter={selectedNamespace}
                                        searchQuery={searchQuery}
                                        currentContext={currentContext}
                                    />
                                )
                            ) : (
                                <ClusterCockpit
                                    key={currentContext} // Force remount on context change to clear local state
                                    navStructure={navStructure}
                                    onNavigate={(res) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
                                    currentContext={currentContext}
                                />
                            )}
                        </div>
                    </>
                )}
            </main>

            {/* Deep Dive Drawer with integrated tabs */}
            {
                tabs.length > 0 && activeTabId && (
                    <DeepDiveDrawer
                        tabs={tabs}
                        activeTabId={activeTabId}
                        onTabChange={setActiveTabId}
                        onTabClose={handleCloseTab}
                        onCloseAll={() => {
                            setTabs([]);
                            setActiveTabId(null);
                        }}
                        onDelete={() => {
                            const obj = tabs.find(t => t.id === activeTabId)?.resource;
                            if (obj) {
                                setResourceToDelete(obj);
                                setIsDeleteModalOpen(true);
                            }
                        }}
                        currentContext={currentContext}
                        onOpenResource={handleOpenRelatedResource}
                    />
                )
            }

            {/* Delete Confirmation Modal */}
            <DeleteConfirmationModal
                isOpen={isDeleteModalOpen}
                onClose={() => {
                    setIsDeleteModalOpen(false);
                    setResourceToDelete(null);
                }}
                onConfirm={() => {
                    if (resourceToDelete) {
                        deleteMutation.mutate(resourceToDelete);
                    }
                }}
                resourceName={resourceToDelete?.name || ""}
            />

            {/* Keyboard Shortcuts Help Modal */}
            <KeyboardShortcutsModal
                isOpen={isShortcutsModalOpen}
                onClose={() => setIsShortcutsModalOpen(false)}
                shortcuts={keyboardShortcuts}
            />

            {/* Settings Page Modal */}
            {isSettingsOpen && (
                <div className="fixed inset-0 z-[9999] backdrop-blur-sm flex items-center justify-center p-8" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
                    <div className="w-full max-w-4xl h-[85vh] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200" style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
                        <SettingsPage onClose={() => setIsSettingsOpen(false)} />
                    </div>
                </div>
            )}

            {/* Context Switcher Dropdown */}
            {isContextDropdownOpen && (
                <>
                    <div
                        className="fixed inset-0 z-[9998]"
                        onClick={() => { setIsContextDropdownOpen(false); setContextSearchQuery(""); }}
                    />
                    <div className="fixed left-4 top-14 z-[9999] w-80 max-h-[400px] bg-[#1e1e1e] border border-zinc-600 rounded-lg shadow-2xl flex flex-col">
                        <div className="bg-[#252525] border-b border-zinc-700 px-3 py-2.5 shrink-0 rounded-t-lg">
                            <span className="text-xs font-medium text-zinc-400">Switch Context</span>
                        </div>
                        {/* Search Input */}
                        <div className="px-3 py-2 border-b border-zinc-700 shrink-0">
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-zinc-500">
                                    <Search size={14} />
                                </div>
                                <input
                                    type="text"
                                    placeholder="Search contexts..."
                                    value={contextSearchQuery}
                                    onChange={(e) => setContextSearchQuery(e.target.value)}
                                    autoFocus
                                    className="w-full pl-8 pr-3 py-1.5 bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm rounded focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 placeholder:text-zinc-600"
                                />
                                {contextSearchQuery && (
                                    <button
                                        onClick={() => setContextSearchQuery("")}
                                        className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-zinc-500 hover:text-white"
                                    >
                                        <X size={12} />
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="py-1 overflow-y-auto flex-1">
                            {(() => {
                                const filteredContexts = allContexts?.filter(ctx =>
                                    ctx.name.toLowerCase().includes(contextSearchQuery.toLowerCase()) ||
                                    ctx.cluster?.toLowerCase().includes(contextSearchQuery.toLowerCase())
                                ) || [];

                                if (filteredContexts.length === 0) {
                                    return (
                                        <div className="px-3 py-4 text-sm text-zinc-500 text-center">
                                            {contextSearchQuery ? `No contexts matching "${contextSearchQuery}"` : "No contexts found"}
                                        </div>
                                    );
                                }

                                return filteredContexts.map((ctx) => (
                                    <button
                                        key={ctx.name}
                                        onClick={() => { handleSwitchContext(ctx.name); setContextSearchQuery(""); }}
                                        className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${ctx.name === currentContext
                                            ? 'bg-cyan-500/20 text-cyan-400'
                                            : 'text-zinc-300 hover:bg-zinc-700'
                                            }`}
                                    >
                                        {ctx.name === currentContext && (
                                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                                        )}
                                        <div className="flex flex-col min-w-0 flex-1">
                                            <span className="truncate font-medium">{ctx.name}</span>
                                            {ctx.cluster && ctx.cluster !== ctx.name && (
                                                <span className="text-[10px] text-zinc-500 truncate">{ctx.cluster}</span>
                                            )}
                                        </div>
                                    </button>
                                ));
                            })()}
                        </div>
                        {allContexts && allContexts.length > 5 && (
                            <div className="px-3 py-1.5 border-t border-zinc-700 text-[10px] text-zinc-500 text-center shrink-0">
                                {allContexts.length} contexts available
                            </div>
                        )}
                    </div>
                </>
            )}
        </div >
    );
}
