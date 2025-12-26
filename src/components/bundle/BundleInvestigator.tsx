/**
 * BundleInvestigator - Main wrapper component
 * Combines sidebar navigation with view content
 */

import { useEffect, useState } from 'react';
import {
    LayoutDashboard, Layers, Box, Calendar, FileText,
    HardDrive, GitBranch, Server, X, RefreshCw, FolderOpen, Search, Puzzle, Sparkles, Upload
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { BundleProvider, useBundleContext } from './BundleContext';
import { ViewType } from './types';
import { OverviewView } from './views/OverviewView';
import { NamespacesView } from './views/NamespacesView';
import { WorkloadsView } from './views/WorkloadsView';
import { EventsView } from './views/EventsView';
import { LogsView } from './views/LogsView';
import { StorageView } from './views/StorageView';
import { ArgoView } from './views/ArgoView';
import { NodesView } from './views/NodesView';
import { CRDsView } from './views/CRDsView';
import { ResourceDetailPanel } from './views/ResourceDetailPanel';
import { GlobalSearch } from './views/GlobalSearch';
import { AIAnalysisPanel } from './views/AIAnalysisPanel';

interface NavItem {
    id: ViewType;
    label: string;
    icon: any;
    badge?: number;
    badgeColor?: string;
}

function Sidebar({ onOpenSearch, onOpenAI }: { onOpenSearch: () => void; onOpenAI: () => void }) {
    const {
        bundle, activeView, setActiveView, events, alerts,
        namespaces, nodes, argoApps, logs, crds, closeBundle, loading, refreshData
    } = useBundleContext();

    const warningEvents = events.filter(e => e.event_type === 'Warning').length;
    const criticalAlerts = alerts?.critical?.length || 0;

    const navItems: NavItem[] = [
        { id: 'overview', label: 'Overview', icon: LayoutDashboard },
        {
            id: 'namespaces', label: 'Namespaces', icon: Layers,
            badge: namespaces.length
        },
        { id: 'workloads', label: 'Workloads', icon: Box },
        {
            id: 'events', label: 'Events', icon: Calendar,
            badge: warningEvents > 0 ? warningEvents : undefined,
            badgeColor: 'bg-yellow-500'
        },
        {
            id: 'logs', label: 'Logs', icon: FileText,
            badge: logs.length
        },
        {
            id: 'nodes', label: 'Nodes', icon: Server,
            badge: nodes.length
        },
        { id: 'storage', label: 'Storage', icon: HardDrive },
        {
            id: 'argocd', label: 'ArgoCD', icon: GitBranch,
            badge: argoApps.length > 0 ? argoApps.length : undefined
        },
        {
            id: 'crds', label: 'CRDs', icon: Puzzle,
            badge: crds.length > 0 ? crds.length : undefined
        }
    ];

    const bundleName = bundle?.path.split('/').pop() || 'Bundle';

    return (
        <div className="w-56 bg-zinc-950 border-r border-zinc-800 flex flex-col">
            {/* Header */}
            <div className="p-4 border-b border-zinc-800">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <FolderOpen size={16} className="text-purple-400" />
                        <span className="text-sm font-medium text-white truncate" title={bundleName}>
                            {bundleName.length > 16 ? bundleName.slice(0, 16) + '...' : bundleName}
                        </span>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={refreshData}
                            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
                            title="Refresh"
                            disabled={loading}
                        >
                            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                        </button>
                        <button
                            onClick={closeBundle}
                            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 transition-colors"
                            title="Close bundle"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
                {bundle && (
                    <div className="text-[10px] text-zinc-600 mt-1">
                        {bundle.total_resources} resources • {namespaces.length} namespaces
                    </div>
                )}

                {/* Search Button */}
                <button
                    onClick={onOpenSearch}
                    className="mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-700 hover:border-zinc-600 transition-colors text-left"
                >
                    <Search size={14} className="text-zinc-500" />
                    <span className="text-xs text-zinc-500 flex-1">Search bundle...</span>
                    <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">⌘K</kbd>
                </button>
            </div>

            {/* Navigation */}
            <nav className="flex-1 p-2 space-y-0.5 overflow-auto">
                {navItems.map(item => {
                    const Icon = item.icon;
                    const isActive = activeView === item.id;

                    return (
                        <button
                            key={item.id}
                            onClick={() => setActiveView(item.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                                isActive
                                    ? 'bg-purple-600/20 text-purple-300'
                                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300'
                            }`}
                        >
                            <Icon size={16} />
                            <span className="flex-1 text-left">{item.label}</span>
                            {item.badge !== undefined && (
                                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                    item.badgeColor || 'bg-zinc-800'
                                } ${item.badgeColor ? 'text-white' : 'text-zinc-500'}`}>
                                    {item.badge}
                                </span>
                            )}
                        </button>
                    );
                })}
            </nav>

            {/* AI Analysis Button */}
            <div className="p-2 border-t border-zinc-800">
                <button
                    onClick={onOpenAI}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-purple-600/20 to-pink-600/20 border border-purple-500/30 hover:border-purple-500/50 transition-colors text-left"
                >
                    <Sparkles size={14} className="text-purple-400" />
                    <span className="text-xs text-purple-300 font-medium">AI Analysis</span>
                </button>
            </div>

            {/* Footer Stats */}
            <div className="p-3 border-t border-zinc-800">
                <div className="grid grid-cols-2 gap-2">
                    <div className={`p-2 rounded text-center ${
                        criticalAlerts > 0 ? 'bg-red-500/10' : 'bg-zinc-800/50'
                    }`}>
                        <div className={`text-lg font-bold ${
                            criticalAlerts > 0 ? 'text-red-400' : 'text-zinc-400'
                        }`}>
                            {criticalAlerts}
                        </div>
                        <div className="text-[10px] text-zinc-500">Critical</div>
                    </div>
                    <div className={`p-2 rounded text-center ${
                        warningEvents > 0 ? 'bg-yellow-500/10' : 'bg-zinc-800/50'
                    }`}>
                        <div className={`text-lg font-bold ${
                            warningEvents > 0 ? 'text-yellow-400' : 'text-zinc-400'
                        }`}>
                            {warningEvents}
                        </div>
                        <div className="text-[10px] text-zinc-500">Warnings</div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function ViewContent() {
    const { activeView, loading, error } = useBundleContext();

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                    <RefreshCw size={32} className="mx-auto mb-4 text-purple-400 animate-spin" />
                    <div className="text-zinc-400">Loading bundle data...</div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="text-center text-red-400">
                    <div className="text-lg font-medium">Error loading bundle</div>
                    <div className="text-sm mt-2">{error}</div>
                </div>
            </div>
        );
    }

    const views: Record<ViewType, JSX.Element> = {
        overview: <OverviewView />,
        namespaces: <NamespacesView />,
        workloads: <WorkloadsView />,
        events: <EventsView />,
        logs: <LogsView />,
        storage: <StorageView />,
        argocd: <ArgoView />,
        nodes: <NodesView />,
        crds: <CRDsView />
    };

    return (
        <div className="flex-1 overflow-auto bg-zinc-900/30">
            {views[activeView]}
        </div>
    );
}

function BundleInvestigatorContent({ path }: { path: string }) {
    const { bundle, loadBundle } = useBundleContext();
    const [searchOpen, setSearchOpen] = useState(false);
    const [aiOpen, setAIOpen] = useState(false);
    const [aiMinimized, setAIMinimized] = useState(false);

    useEffect(() => {
        if (path && !bundle) {
            loadBundle(path);
        }
    }, [path, bundle, loadBundle]);

    // Keyboard shortcut for search
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setSearchOpen(true);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    return (
        <div className="flex h-full bg-zinc-950">
            <Sidebar
                onOpenSearch={() => setSearchOpen(true)}
                onOpenAI={() => setAIOpen(true)}
            />
            <ViewContent />
            <ResourceDetailPanel />
            <GlobalSearch isOpen={searchOpen} onClose={() => setSearchOpen(false)} />

            {/* AI Analysis - Full Panel or Minimized Pill */}
            {aiMinimized ? (
                <button
                    onClick={() => { setAIMinimized(false); setAIOpen(true); }}
                    className="fixed bottom-6 right-6 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-full shadow-lg shadow-purple-500/20 flex items-center gap-2 transition-all hover:scale-105 z-40"
                >
                    <Sparkles size={16} />
                    <span className="text-sm font-medium">AI Analysis</span>
                </button>
            ) : (
                <AIAnalysisPanel
                    isOpen={aiOpen}
                    onClose={() => setAIOpen(false)}
                    onMinimize={() => { setAIMinimized(true); setAIOpen(false); }}
                />
            )}
        </div>
    );
}

interface BundleInvestigatorProps {
    path?: string;
    onClose?: () => void;
}

function BundlePicker({ onSelectPath, onClose }: { onSelectPath: (path: string) => void; onClose?: () => void }) {
    const [loading, setLoading] = useState(false);

    const handleSelectBundle = async () => {
        setLoading(true);
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: 'Select Support Bundle Directory'
            });
            if (selected && typeof selected === 'string') {
                onSelectPath(selected);
            }
        } catch (err) {
            console.error('Failed to open bundle:', err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="h-full bg-zinc-950 flex items-center justify-center">
            <div className="text-center max-w-md mx-auto p-8">
                <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center">
                    <FolderOpen size={40} className="text-purple-400" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-3">
                    Open Support Bundle
                </h2>
                <p className="text-zinc-400 mb-8">
                    Select a Kubernetes support bundle directory to analyze cluster state,
                    events, logs, and resources offline.
                </p>
                <div className="space-y-3">
                    <button
                        onClick={handleSelectBundle}
                        disabled={loading}
                        className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium transition-colors disabled:opacity-50"
                    >
                        {loading ? (
                            <RefreshCw size={18} className="animate-spin" />
                        ) : (
                            <Upload size={18} />
                        )}
                        Select Bundle Directory
                    </button>
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="w-full px-6 py-3 rounded-lg border border-zinc-700 hover:border-zinc-600 text-zinc-400 hover:text-zinc-300 font-medium transition-colors"
                        >
                            Cancel
                        </button>
                    )}
                </div>
                <p className="text-xs text-zinc-600 mt-6">
                    Supports extracted support bundle directories containing Kubernetes manifests,
                    events, and logs.
                </p>
            </div>
        </div>
    );
}

export function BundleInvestigator({ path: initialPath, onClose }: BundleInvestigatorProps) {
    const [bundlePath, setBundlePath] = useState<string | null>(initialPath || null);

    if (!bundlePath) {
        return (
            <BundlePicker
                onSelectPath={setBundlePath}
                onClose={onClose}
            />
        );
    }

    return (
        <BundleProvider onClose={onClose}>
            <BundleInvestigatorContent path={bundlePath} />
        </BundleProvider>
    );
}

export default BundleInvestigator;
