/**
 * BundleContext - Shared state for Bundle Investigator
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    SupportBundle, BundleResource, BundleEvent, BundleAlerts,
    BundleHealthSummary, BundleLogFile, BundleNodeInfo, NamespaceSummary, ViewType
} from './types';

interface BundleContextType {
    // Bundle data
    bundle: SupportBundle | null;
    resources: Record<string, BundleResource[]>;
    events: BundleEvent[];
    alerts: BundleAlerts | null;
    health: BundleHealthSummary | null;
    nodes: BundleNodeInfo[];
    logs: BundleLogFile[];
    namespaces: NamespaceSummary[];
    argoApps: any[];
    storageClasses: any[];
    pvs: any[];
    crds: any[];

    // UI state
    loading: boolean;
    error: string | null;
    activeView: ViewType;
    selectedNamespace: string | null;
    selectedResource: BundleResource | null;
    searchQuery: string;

    // Actions
    loadBundle: (path: string) => Promise<void>;
    closeBundle: () => void;
    setActiveView: (view: ViewType) => void;
    setSelectedNamespace: (ns: string | null) => void;
    setSelectedResource: (res: BundleResource | null) => void;
    setSearchQuery: (query: string) => void;
    refreshData: () => Promise<void>;
}

const BundleContext = createContext<BundleContextType | null>(null);

export function useBundleContext() {
    const context = useContext(BundleContext);
    if (!context) {
        throw new Error('useBundleContext must be used within BundleProvider');
    }
    return context;
}

interface BundleProviderProps {
    children: ReactNode;
    initialPath?: string;
    onClose?: () => void;
}

export function BundleProvider({ children, initialPath, onClose }: BundleProviderProps) {
    // Bundle data state
    const [bundle, setBundle] = useState<SupportBundle | null>(null);
    const [resources, setResources] = useState<Record<string, BundleResource[]>>({});
    const [events, setEvents] = useState<BundleEvent[]>([]);
    const [alerts, setAlerts] = useState<BundleAlerts | null>(null);
    const [health, setHealth] = useState<BundleHealthSummary | null>(null);
    const [nodes, setNodes] = useState<BundleNodeInfo[]>([]);
    const [logs, setLogs] = useState<BundleLogFile[]>([]);
    const [namespaces, setNamespaces] = useState<NamespaceSummary[]>([]);
    const [argoApps, setArgoApps] = useState<any[]>([]);
    const [storageClasses, setStorageClasses] = useState<any[]>([]);
    const [pvs, setPvs] = useState<any[]>([]);
    const [crds, setCrds] = useState<any[]>([]);

    // UI state
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeView, setActiveView] = useState<ViewType>('overview');
    const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null);
    const [selectedResource, setSelectedResource] = useState<BundleResource | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    const loadBundle = useCallback(async (path: string) => {
        setLoading(true);
        setError(null);

        try {
            // Load bundle metadata
            const bundleData = await invoke<SupportBundle>('load_support_bundle', { path });
            setBundle(bundleData);

            // Load all data in parallel
            const [
                eventsData,
                alertsData,
                healthData,
                nodesData,
                logsData,
                namespacesData,
                argoData,
                scData,
                pvsData,
                crdsData,
                allResources
            ] = await Promise.all([
                invoke<BundleEvent[]>('get_bundle_events', { bundlePath: path }).catch(() => []),
                invoke<BundleAlerts>('get_bundle_alerts', { bundlePath: path }).catch(() => null),
                invoke<BundleHealthSummary>('get_bundle_health_summary', { bundlePath: path }).catch(() => null),
                invoke<BundleNodeInfo[]>('get_bundle_nodes', { bundlePath: path }).catch(() => []),
                invoke<BundleLogFile[]>('list_bundle_logs', { bundlePath: path }).catch(() => []),
                invoke<NamespaceSummary[]>('get_bundle_namespace_summary', { bundlePath: path }).catch(() => []),
                invoke<any[]>('get_bundle_argocd_apps', { bundlePath: path }).catch(() => []),
                invoke<any[]>('get_bundle_storage_classes', { bundlePath: path }).catch(() => []),
                invoke<any[]>('get_bundle_pvs', { bundlePath: path }).catch(() => []),
                invoke<any[]>('get_bundle_crds', { bundlePath: path }).catch(() => []),
                invoke<Record<string, BundleResource[]>>('get_all_bundle_resources', { bundlePath: path }).catch(() => ({}))
            ]);

            setEvents(eventsData);
            setAlerts(alertsData);
            setHealth(healthData);
            setNodes(nodesData);
            setLogs(logsData);
            setNamespaces(namespacesData);
            setArgoApps(argoData);
            setStorageClasses(scData);
            setPvs(pvsData);
            setCrds(crdsData);
            setResources(allResources);

        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    const closeBundle = useCallback(() => {
        invoke('close_support_bundle').catch(() => {});
        setBundle(null);
        setResources({});
        setEvents([]);
        setAlerts(null);
        setHealth(null);
        setNodes([]);
        setLogs([]);
        setNamespaces([]);
        setArgoApps([]);
        setStorageClasses([]);
        setPvs([]);
        setCrds([]);
        setActiveView('overview');
        setSelectedNamespace(null);
        setSelectedResource(null);
        setSearchQuery('');
        // Call the parent's onClose to return to connection screen
        onClose?.();
    }, [onClose]);

    const refreshData = useCallback(async () => {
        if (bundle?.path) {
            await loadBundle(bundle.path);
        }
    }, [bundle?.path, loadBundle]);

    const value: BundleContextType = {
        bundle,
        resources,
        events,
        alerts,
        health,
        nodes,
        logs,
        namespaces,
        argoApps,
        storageClasses,
        pvs,
        crds,
        loading,
        error,
        activeView,
        selectedNamespace,
        selectedResource,
        searchQuery,
        loadBundle,
        closeBundle,
        setActiveView,
        setSelectedNamespace,
        setSelectedResource,
        setSearchQuery,
        refreshData
    };

    return (
        <BundleContext.Provider value={value}>
            {children}
        </BundleContext.Provider>
    );
}
