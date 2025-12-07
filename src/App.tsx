import React, { useState, useRef, useEffect } from "react";
// NOTE: For local development, run: npm install @tauri-apps/api
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useQueryClient, QueryClient, useQuery } from "@tanstack/react-query";
import { Updater, checkForUpdatesManually, useUpdaterState, installPendingUpdate } from "./components/Updater";
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';

import {
  MessageSquare,
  Cloud,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

import { Dashboard } from './components/dashboard/Dashboard';
import { ClusterChatPanel } from './components/ai/ClusterChatPanel';
import { PortForwardList } from './components/cluster/deep-dive/PortForward';
import { AzurePage } from './components/azure/AzurePage';
import { ConnectionScreen } from './components/cluster/ConnectionScreen';
import { ClusterStats, K8sObject } from './types/k8s';

// --- Types ---


// Combined initial data for faster first load
interface InitialClusterData {
  stats: ClusterStats;
  namespaces: string[];
  pods: K8sObject[];
  nodes: K8sObject[];
  deployments: K8sObject[];
  services: K8sObject[];
}


// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
    },
  },
});

// Create persister for localStorage
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'opspilot-cache',
});
// --- Terminal Tab ---
// --- Terminal Tab ---
function AppContent() {
  const qc = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [showAzure, setShowAzure] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type?: 'success' | 'error' | 'info' }>>([]);
  const prevContextRef = useRef<string | null>(null);

  // Global cluster chat state
  const [showClusterChat, setShowClusterChat] = useState(false);
  const [isClusterChatMinimized, setIsClusterChatMinimized] = useState(false);

  // Observe current context name globally
  const { data: globalCurrentContext } = useQuery({
    queryKey: ["current_context_boot"],
    queryFn: async () => await invoke<string>("get_current_context_name"),
    refetchInterval: 5000,
  });

  // After connection, gate UI on cluster details load
  const {
    data: bootStats,
    isLoading: bootLoading,
    isError: bootError,
    error: bootErr,
    refetch: bootRefetch,
  } = useQuery({
    queryKey: ["cluster_bootstrap", globalCurrentContext],
    queryFn: async () => await invoke<ClusterStats>("get_cluster_stats"),
    enabled: isConnected && !!globalCurrentContext,
    retry: 1,
    staleTime: 0,
  });

  // Touch bootStats to avoid unused variable lint errors
  useEffect(() => {
    if (bootStats) {
      // noop: used to mark stats availability
    }
  }, [bootStats]);

  // Global toast bus
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ message: string; type?: 'success' | 'error' | 'info' }>;
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, message: ce.detail.message, type: ce.detail.type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3000);
    };
    window.addEventListener('app:toast', handler as EventListener);
    // expose helper
    (window as any).showToast = (message: string, type?: 'success' | 'error' | 'info') => {
      window.dispatchEvent(new CustomEvent('app:toast', { detail: { message, type } }));
    };
    return () => {
      window.removeEventListener('app:toast', handler as EventListener);
    };
  }, []);

  // Check if there's already an active context on mount


  // Watch current context and toast on changes
  const { data: currentCtx } = useQuery({
    queryKey: ["current_context_global"],
    queryFn: async () => await invoke<string>("get_current_context_name"),
    refetchInterval: 5000,
  });

  // Always show home screen on app open - user must explicitly connect
  // (Removed auto-connect logic that was previously here)

  useEffect(() => {
    if (typeof currentCtx === 'string') {
      if (prevContextRef.current && prevContextRef.current !== currentCtx) {
        (window as any).showToast?.(`Switched context to '${currentCtx}'`, 'info');
      }
      prevContextRef.current = currentCtx;
    }
  }, [currentCtx]);

  if (!isConnected) {
    return (
      <>
        {showAzure ? (
          <div className="h-screen flex flex-col bg-[#1e1e1e]">
            <div className="h-14 border-b border-[#3e3e42] flex items-center justify-between px-4 bg-[#252526] shrink-0">
              <div className="flex items-center gap-2">
                <Cloud className="text-[#007acc]" size={20} />
                <h2 className="font-semibold text-white">Azure Explorer</h2>
              </div>
              <button
                onClick={() => setShowAzure(false)}
                className="text-[#858585] hover:text-white text-sm"
              >
                Back to Connections
              </button>
            </div>
            <div className="flex-1 overflow-hidden relative">
              <AzurePage onConnect={() => setIsConnected(true)} />
            </div>
          </div>
        ) : (
          <ConnectionScreen
            onConnect={() => setIsConnected(true)}
            onOpenAzure={() => setShowAzure(true)}
          />
        )}
      </>
    );
  }

  // Show error gate only on connection errors (not during loading - let Dashboard load progressively)
  if (isConnected && (!!globalCurrentContext) && bootError) {
    const errorMessage = (bootErr as any)?.message || String(bootErr) || "Unknown error";
    console.error("Boot error:", bootErr);
    const isConnectionError = errorMessage.toLowerCase().includes("connect") ||
      errorMessage.toLowerCase().includes("unreachable") ||
      errorMessage.toLowerCase().includes("timeout");
    const isAuthError = errorMessage.toLowerCase().includes("unauthorized") ||
      errorMessage.toLowerCase().includes("forbidden") ||
      errorMessage.toLowerCase().includes("certificate");

    return (
      <div className="h-screen bg-gradient-to-br from-zinc-900 to-zinc-950 flex flex-col items-center justify-center p-8">
        <div className="max-w-lg w-full">
          <div className="bg-gradient-to-br from-red-500/10 to-orange-500/5 rounded-2xl border border-red-500/20 p-8 backdrop-blur-xl shadow-2xl">
            <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center border border-red-500/30">
              <AlertCircle size={32} className="text-red-400" />
            </div>

            <h1 className="text-2xl font-bold text-white text-center mb-2">
              {isConnectionError ? "Cluster Unreachable" : isAuthError ? "Authentication Failed" : "Connection Error"}
            </h1>

            <p className="text-zinc-400 text-center text-sm mb-6">
              {isConnectionError
                ? "Unable to connect to the Kubernetes API server"
                : isAuthError
                  ? "Your credentials may have expired or are invalid"
                  : "Failed to load cluster details"}
            </p>

            <div className="bg-black/30 rounded-lg p-4 mb-6 border border-white/5">
              <p className="text-xs font-mono text-red-300 break-all">{errorMessage}</p>
            </div>

            {isConnectionError && (
              <div className="bg-blue-500/10 rounded-lg p-4 mb-6 border border-blue-500/20">
                <p className="text-xs text-blue-300 font-medium mb-2">Troubleshooting tips:</p>
                <ul className="text-xs text-blue-200/70 space-y-1 list-disc list-inside">
                  <li>Check if the cluster is running</li>
                  <li>Verify VPN connection if required</li>
                  <li>Check network/firewall settings</li>
                  <li>Try: <code className="bg-black/30 px-1 rounded">kubectl cluster-info</code></li>
                </ul>
              </div>
            )}

            {isAuthError && (
              <div className="bg-yellow-500/10 rounded-lg p-4 mb-6 border border-yellow-500/20">
                <p className="text-xs text-yellow-300 font-medium mb-2">Authentication tips:</p>
                <ul className="text-xs text-yellow-200/70 space-y-1 list-disc list-inside">
                  <li>Re-authenticate with your cloud provider</li>
                  <li>For AKS: <code className="bg-black/30 px-1 rounded">az aks get-credentials</code></li>
                  <li>For EKS: <code className="bg-black/30 px-1 rounded">aws eks update-kubeconfig</code></li>
                  <li>For GKE: <code className="bg-black/30 px-1 rounded">gcloud container clusters get-credentials</code></li>
                </ul>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => bootRefetch()}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-medium shadow-lg shadow-blue-500/20 transition-all"
              >
                <RefreshCw size={16} />
                Retry Connection
              </button>
              <button
                onClick={() => {
                  qc.removeQueries();
                  setIsConnected(false);
                }}
                className="flex-1 px-4 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 font-medium transition-all"
              >
                Change Cluster
              </button>
            </div>
          </div>

          <p className="text-center text-xs text-zinc-600 mt-4">
            Context: <span className="font-mono text-zinc-500">{globalCurrentContext}</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Global Toasts */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-3 py-2 rounded-md text-sm shadow-lg backdrop-blur bg-opacity-20 border ${t.type === 'success'
              ? 'bg-green-500/20 border-green-500/40 text-green-300'
              : t.type === 'error'
                ? 'bg-red-500/20 border-red-500/40 text-red-300'
                : 'bg-cyan-500/20 border-cyan-500/40 text-cyan-200'
              }`}
          >
            {t.message}
          </div>
        ))}
      </div>
      <Dashboard
        isConnected={isConnected}
        setIsConnected={setIsConnected}
        onDisconnect={async () => {
          // Clear ALL cached data to prevent stale data
          qc.removeQueries();
          // Also clear backend caches
          try {
            await invoke("clear_all_caches");
          } catch (e) {
            console.warn("Failed to clear backend caches:", e);
          }
          (window as any).showToast?.('Disconnected from cluster', 'info');
          setIsConnected(false);
        }}
      />
      <PortForwardList currentContext={globalCurrentContext} />

      {/* Global Floating AI Chat Button */}
      {!showClusterChat && (
        <button
          onClick={() => { setShowClusterChat(true); setIsClusterChatMinimized(false); }}
          className="fixed bottom-4 right-4 z-40 flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 rounded-full shadow-lg shadow-purple-500/30 text-white font-medium transition-all hover:scale-105"
        >
          <MessageSquare size={20} />
          <span>AI Chat</span>
        </button>
      )}

      {/* Global Cluster Chat Panel */}
      {showClusterChat && (
        <ClusterChatPanel
          onClose={() => setShowClusterChat(false)}
          isMinimized={isClusterChatMinimized}
          onToggleMinimize={() => setIsClusterChatMinimized(!isClusterChatMinimized)}
        />
      )}
    </>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen bg-black text-red-400 flex flex-col items-center justify-center p-8 text-center">
          <h1 className="text-2xl font-bold mb-4">Something went wrong.</h1>
          <pre className="bg-gray-900 p-4 rounded text-left text-xs overflow-auto max-w-2xl border border-gray-800">
            {this.state.error?.toString()}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-4 py-2 bg-cyan-600 text-white rounded hover:bg-cyan-500 shadow-lg shadow-cyan-500/30"
          >
            Reload Application
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// Wrapper to provide QueryClient context with persistence
export default function App() {
  return (
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister }}
      >
        <AppContent />
        <Updater />
      </PersistQueryClientProvider>
    </ErrorBoundary>
  );
}