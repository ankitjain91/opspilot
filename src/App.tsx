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
  Loader2,
  Sparkles,
} from "lucide-react";
import { ToastProvider, useToast } from "./components/ui/Toast";
import { NotificationProvider, useNotifications } from "./components/notifications/NotificationContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { initializeConfig } from "./utils/config";

import { Dashboard } from './components/dashboard/Dashboard';
import { ClusterChatPanel } from './components/ai/ClusterChatPanel';
import { PortForwardList } from './components/cluster/deep-dive/PortForward';
import { AzurePage } from './components/azure/AzurePage';
import { ConnectionScreen } from './components/cluster/ConnectionScreen';
import { BundleDashboard, PreloadedBundleData } from './components/bundle';
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
import { useSentinel } from './components/ai/useSentinel';

// --- Terminal Tab ---
function AppContent() {
  const qc = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [showAgentWarning, setShowAgentWarning] = useState(false); // Debounced warning state
  const [showAzure, setShowAzure] = useState(false);
  const [showOfflineBundle, setShowOfflineBundle] = useState(false);
  const [bundlePath, setBundlePath] = useState<string | null>(null);
  const [preloadedBundleData, setPreloadedBundleData] = useState<PreloadedBundleData | null>(null);
  const { showToast } = useToast();
  const { clearAll } = useNotifications();

  // Global cluster chat state
  const [showClusterChat, setShowClusterChat] = useState(false);
  const [isClusterChatMinimized, setIsClusterChatMinimized] = useState(false);
  // Track if AI is processing in background (when panel is closed but still working)
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  // Track if chat panel has been mounted (to enable background processing)
  const [chatPanelMounted, setChatPanelMounted] = useState(false);

  // Handler for proactive investigations
  // Handler for proactive investigations
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);

  const handleAutoInvestigate = React.useCallback((prompt: string) => {
    setInitialPrompt(prompt);
    setShowClusterChat(true);
    setIsClusterChatMinimized(false);
  }, []);

  // Start Sentinel listener with auto-investigate handler
  const { kbProgress, sentinelStatus, reconnect: reconnectSentinel } = useSentinel(handleAutoInvestigate);

  // Initialize configuration on app startup (auto-detect agent URL, load config file, etc.)
  useEffect(() => {
    initializeConfig().catch(e => console.warn('[Config] Initialization error:', e));
  }, []);

  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail && e.detail.prompt) {
        handleAutoInvestigate(e.detail.prompt);
      }
    };
    window.addEventListener('opspilot:investigate', handler);
    return () => window.removeEventListener('opspilot:investigate', handler);
  }, []);



  const prevContextRef = useRef<string | null>(null);

  // Track document visibility for smart polling
  const [isDocumentVisible, setIsDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    const handleVisibilityChange = () => {
      const nowVisible = !document.hidden;
      setIsDocumentVisible(nowVisible);
      // Reconnect Sentinel when user returns to the app
      if (nowVisible && sentinelStatus !== 'connected') {
        console.log('[App] Document became visible, triggering Sentinel reconnect');
        reconnectSentinel();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [sentinelStatus, reconnectSentinel]);

  // Observe current context name globally (single consolidated query)
  const { data: globalCurrentContext } = useQuery({
    queryKey: ["current_context"],
    queryFn: async () => await invoke<string>("get_current_context_name"),
    refetchInterval: isDocumentVisible ? 15000 : false, // 15s when visible, disabled when hidden
    staleTime: 10000,
  });

  // Agent health check (global)
  const { data: agentHealthy } = useQuery({
    queryKey: ["agent_health"],
    queryFn: async () => {
      try {
        return await invoke<boolean>("check_agent_status");
      } catch (e) {
        console.warn("[Agent] Health check failed:", e);
        return false;
      }
    },
    refetchInterval: isDocumentVisible ? 10000 : false,
    staleTime: 5000,
  });

  // Reconnect Sentinel when context changes (ensures fresh connection)
  const prevSentinelContextRef = useRef<string | null>(null);
  useEffect(() => {
    if (globalCurrentContext && prevSentinelContextRef.current !== globalCurrentContext) {
      console.log('[App] Context changed, triggering Sentinel reconnect');
      reconnectSentinel();
      prevSentinelContextRef.current = globalCurrentContext;
    }
  }, [globalCurrentContext, reconnectSentinel]);

  // Debounce the agent warning to avoid flashing on reload/context switch
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (agentHealthy === false) {
      // Wait 5s before showing warning to allow for restarts/transient failures
      timer = setTimeout(() => setShowAgentWarning(true), 5000);
    } else {
      setShowAgentWarning(false);
    }
    return () => clearTimeout(timer);
  }, [agentHealthy]);

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


  // Always show home screen on app open - user must explicitly connect
  // (Removed auto-connect logic that was previously here)

  // Watch for context changes and toast notifications
  useEffect(() => {
    if (typeof globalCurrentContext === 'string') {
      if (prevContextRef.current && prevContextRef.current !== globalCurrentContext) {
        showToast(`Switched context to '${globalCurrentContext}'`, 'info');
        clearAll(); // Clear stale notifications from previous context
      }
      prevContextRef.current = globalCurrentContext;
    }
  }, [globalCurrentContext, showToast, clearAll]);

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
        ) : showOfflineBundle && bundlePath && preloadedBundleData ? (
          <div className="h-screen w-screen overflow-hidden">
            <BundleDashboard
              onClose={() => {
                setShowOfflineBundle(false);
                setBundlePath(null);
                setPreloadedBundleData(null);
              }}
              preloadedData={preloadedBundleData}
            />
          </div>
        ) : (
          <ConnectionScreen
            onConnect={() => setIsConnected(true)}
            onOpenAzure={() => setShowAzure(true)}
            onOpenBundle={(path, data) => {
              setBundlePath(path);
              setPreloadedBundleData(data);
              setShowOfflineBundle(true);
            }}
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

    // Parse structured errors: TYPE|CONTEXT|MESSAGE|COMMAND
    const parts = errorMessage.split('|');
    const isStructuredError = parts.length >= 3;
    const errorType = isStructuredError ? parts[0] : (isConnectionError ? "CONNECTION_ERROR" : isAuthError ? "AUTH_ERROR" : "UNKNOWN_ERROR");
    const errorContextName = isStructuredError ? parts[1] : globalCurrentContext;
    const cleanErrorMessage = isStructuredError ? parts[2] : errorMessage;
    const remediationCmd = isStructuredError && parts.length > 3 ? parts[3] : null;

    // Special handling for Azure Device Code
    const isDeviceCode = errorType === "AZURE_DEVICE_CODE";
    let deviceCodeUrl = "https://microsoft.com/devicelogin";
    let deviceCode = "";

    if (isDeviceCode) {
      // Extract code from message: "... enter the code ABC12345"
      const codeMatch = cleanErrorMessage.match(/code ([A-Z0-9]+)/);
      if (codeMatch) deviceCode = codeMatch[1];

      const urlMatch = cleanErrorMessage.match(/https:\/\/[^\s]+/);
      if (urlMatch) deviceCodeUrl = urlMatch[0];
    }

    return (
      <div className="h-screen bg-gradient-to-br from-zinc-900 to-zinc-950 flex flex-col items-center justify-center p-8">
        <div className="max-w-xl w-full">
          <div className="bg-gradient-to-br from-red-500/10 to-orange-500/5 rounded-2xl border border-red-500/20 p-8 backdrop-blur-xl shadow-2xl">
            <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center border border-red-500/30">
              <AlertCircle size={32} className="text-red-400" />
            </div>

            <h1 className="text-2xl font-bold text-white text-center mb-2">
              {(isDeviceCode || errorType === "AZURE_LOGIN_REQUIRED") ? "Authentication Required" : (errorType === "CONNECTION_ERROR" ? "Cluster Unreachable" : "Connection Failed")}
            </h1>

            <p className="text-zinc-400 text-center text-sm mb-6">
              {isDeviceCode
                ? "Microsoft requires you to sign in to access this cluster."
                : errorType === "AZURE_LOGIN_REQUIRED"
                  ? "Azure authentication is required to access this cluster."
                  : cleanErrorMessage}
            </p>

            {/* Structured Error Display */}
            {isDeviceCode ? (
              <div className="bg-blue-500/10 rounded-lg p-6 mb-6 border border-blue-500/20 flex flex-col gap-4">
                <div className="text-center">
                  <p className="text-blue-200 text-sm mb-2">1. Click to open login page:</p>
                  <a
                    href={deviceCodeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded font-medium inline-block transition-colors"
                  >
                    Open Microsoft Login
                  </a>
                </div>
                <div className="h-px bg-blue-500/20 w-full" />
                <div className="text-center">
                  <p className="text-blue-200 text-sm mb-2">2. Enter this code:</p>
                  <div className="bg-black/40 border border-blue-500/30 rounded px-4 py-3 font-mono text-xl text-white tracking-widest inline-block select-all">
                    {deviceCode}
                  </div>
                  <p className="text-xs text-blue-400 mt-2">The code will expire in 15 minutes.</p>
                </div>
              </div>
            ) : (
              <div className="bg-black/30 rounded-lg p-4 mb-6 border border-white/5">
                <p className="text-xs font-mono text-red-300 break-all">{cleanErrorMessage}</p>
                {remediationCmd && (
                  <div className="mt-2 pt-2 border-t border-white/10">
                    <p className="text-xs text-zinc-500 mb-1">Suggested command:</p>
                    <code className="block bg-black/50 p-2 rounded text-xs text-yellow-500 font-mono select-all">
                      {remediationCmd}
                    </code>
                  </div>
                )}
              </div>
            )}

            {/* Troubleshooting Fallback */}
            {!isStructuredError && isConnectionError && (
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


        {/* Global Cluster Chat Panel */}
        {showClusterChat && (
          <ClusterChatPanel
            onClose={() => setShowClusterChat(false)}
            isMinimized={isClusterChatMinimized}
            onToggleMinimize={() => setIsClusterChatMinimized(!isClusterChatMinimized)}
            currentContext={globalCurrentContext}
          />
        )}
      </div>
    );
  }



  return (
    <>
      <Dashboard
        isConnected={isConnected}
        setIsConnected={setIsConnected}
        onOpenAzure={() => {
          // Must disconnect to show the Azure Page (which lives in the !isConnected view)
          setIsConnected(false);
          setShowAzure(true);
        }}
        onDisconnect={async () => {
          // Reset UI flags first for immediate feedback
          setShowAzure(false);
          setIsConnected(false);

          // Clear caches in background
          qc.removeQueries();
          try {
            await invoke("clear_all_caches");
          } catch (e) {
            console.warn("Failed to clear backend caches:", e);
          }
          showToast('Disconnected from cluster', 'info');
        }}
        showClusterChat={showClusterChat}
        onToggleClusterChat={() => {
          setShowClusterChat(!showClusterChat);
          setIsClusterChatMinimized(false);
        }}
        sentinelStatus={sentinelStatus}
        onReconnectSentinel={reconnectSentinel}
        currentContext={globalCurrentContext || ""}
        onAutoInvestigate={handleAutoInvestigate}
      />

      {/* Agent Health Warning - Floating, Non-Blocking, Subtle */}
      {showAgentWarning && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-top-4 fade-in duration-500">
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-full bg-amber-950/80 border border-amber-500/30 backdrop-blur-md shadow-xl shadow-black/20">
            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-sm font-medium text-amber-200">
              Agent connecting...
            </span>
            <button
              className="ml-2 text-xs font-semibold text-amber-400 hover:text-amber-100 transition-colors px-2 py-1 rounded-md bg-amber-500/10 hover:bg-amber-500/20"
              onClick={() => qc.invalidateQueries({ queryKey: ["agent_health"] })}
            >
              Retry
            </button>
          </div>
        </div>
      )}
      <PortForwardList currentContext={globalCurrentContext} />


      {/* Global Cluster Chat Panel - Always mounted to enable background processing */}
      {(showClusterChat || chatPanelMounted) && (
        <ClusterChatPanel
          onClose={() => setShowClusterChat(false)}
          isMinimized={isClusterChatMinimized}
          onToggleMinimize={() => setIsClusterChatMinimized(!isClusterChatMinimized)}
          currentContext={globalCurrentContext}
          initialPrompt={initialPrompt}
          onPromptHandled={() => setInitialPrompt(null)}
          kbProgress={kbProgress}
          isHidden={!showClusterChat}
          onProcessingChange={(processing) => {
            setIsAIProcessing(processing);
            if (processing) setChatPanelMounted(true); // Keep mounted while processing
          }}
        />
      )}

      {/* Background processing indicator - shows when chat is closed but AI is working */}
      {!showClusterChat && isAIProcessing && (
        <div
          onClick={() => setShowClusterChat(true)}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-violet-500/20 to-cyan-500/20 border border-violet-500/40 rounded-xl shadow-lg cursor-pointer transition-all duration-300 group hover:scale-105 hover:border-violet-400/60 backdrop-blur-xl"
        >
          <div className="relative">
            <Loader2 size={18} className="text-violet-400 animate-spin" />
          </div>
          <span className="text-sm font-medium text-zinc-200">AI processing...</span>
          <Sparkles size={14} className="text-cyan-400" />
        </div>
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
      <ThemeProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister }}
        >
          <NotificationProvider>
            <ToastProvider>
              <AppContent />
            </ToastProvider>
          </NotificationProvider>
          <Updater />
        </PersistQueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
