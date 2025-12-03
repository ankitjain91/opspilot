
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
// NOTE: For local development, run: npm install @tauri-apps/api
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useQuery, useMutation, useQueryClient, QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import Editor from '@monaco-editor/react';
import { Virtuoso } from "react-virtuoso";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Filter,
  FolderOpen,
  Layers,
  Package,
  Plug,
  Search,
  Settings,
  Terminal as TerminalIcon,
  Trash2,
  X,
  Check,
  ServerOff,
  FileCode,
  Loader2,
  Cloud,
  FileCog,
  Network,
  HardDrive,
  Shield,
  PieChart,
  Server,
  Puzzle,
  RefreshCw,
  LogOut as LogOutIcon,
  Maximize2,
  Minimize2,
  Cpu,
  Eye,
  List,
  Tags,
  Save,
  LayoutDashboard,
  Globe,
  Sparkles
} from "lucide-react";
// Topology view removed per user request
import Loading from './components/Loading';

// --- Types ---
interface NavResource {
  kind: string;
  group: string;
  version: string;
  namespaced: boolean;
  title: string;
}

interface NavGroup {
  title: string;
  items: NavResource[];
}

interface K8sObject {
  id: string;
  name: string;
  namespace: string;
  status: string;
  kind: string;
  group: string;
  version: string;
  age: string;
  raw_json: string;
  // Pod-specific fields (optional)
  ready?: string;
  restarts?: number;
  node?: string;
  ip?: string;
}

interface K8sEvent {
  message: string;
  reason: string;
  type_: string;
  age: string;
  count: number;
}

interface ClusterStats {
  nodes: number;
  pods: number;
  deployments: number;
  services: number;
  namespaces: number;
}

// Combined initial data for faster first load
interface InitialClusterData {
  stats: ClusterStats;
  namespaces: string[];
  pods: K8sObject[];
  nodes: K8sObject[];
  deployments: K8sObject[];
  services: K8sObject[];
}

interface ResourceMetrics {
  name: string;
  namespace: string;
  cpu: string;
  memory: string;
  cpu_nano: number;
  memory_bytes: number;
  cpu_limit_nano?: number;
  memory_limit_bytes?: number;
  cpu_percent?: number;
  memory_percent?: number;
  timestamp: number;
}

interface AzureSubscription {
  id: string;
  name: string;
  state: string;
  isDefault: boolean;
  clusters: AksCluster[];
}

interface AksCluster {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  powerState: {
    code: string;
  };
}

// Icon Helper
const getCategoryIcon = (title: string) => {
  switch (title) {
    case "Workloads": return <Cpu size={18} />;
    case "Network": return <Network size={18} />;
    case "Storage": return <HardDrive size={18} />;
    case "Config": return <FileCode size={18} />;
    case "Access Control": return <Shield size={18} />;
    case "Cluster": return <Server size={18} />;
    default: return <Layers size={18} />;
  }
};

// Format age as relative time
const formatAge = (isoDate: string): string => {
  const now = Date.now();
  const created = new Date(isoDate).getTime();
  const diffMs = now - created;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
};

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

function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="h-screen bg-[#0f0f12] text-white flex flex-col items-center justify-center relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-blue-600/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-purple-600/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="z-10 flex flex-col items-center">
        <div className="relative mb-8">
          <div className="absolute inset-0 bg-blue-500/20 blur-xl rounded-full animate-pulse" />
          <Loader2 className="animate-spin text-blue-500 relative z-10" size={48} />
        </div>
        <h2 className="text-2xl font-bold mb-2 tracking-tight">OpsPilot</h2>
        <p className="text-gray-400 animate-pulse font-medium">{message}</p>
      </div>
    </div>
  );
}

// --- Terminal Tab ---
// --- Terminal Tab ---
function TerminalTab({ namespace, name, podSpec }: { namespace: string, name: string, podSpec: any }) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionId = useMemo(() => `session-${Math.random().toString(36).substr(2, 9)}`, []);

  const [selectedContainer, setSelectedContainer] = useState<string>("");
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // Extract containers from spec
  const containers = useMemo(() => [
    ...(podSpec?.containers || []).map((c: any) => c.name),
    ...(podSpec?.initContainers || []).map((c: any) => c.name)
  ], [podSpec]);

  // Set default container
  useEffect(() => {
    if (containers.length > 0 && !selectedContainer) {
      setSelectedContainer(containers[0]);
    }
  }, [containers, selectedContainer]);

  const handleDisconnect = useCallback(async () => {
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    setIsConnected(false);
    setIsConnecting(false);
    // Ideally we should also tell backend to kill the session, 
    // but the backend `start_exec` might not have a kill command exposed easily yet 
    // other than dropping the channel. 
    // For now, we just clean up frontend.
  }, []);

  const handleConnect = useCallback(() => {
    if (!terminalRef.current || !selectedContainer) return;

    setIsConnecting(true);

    // Initialize xterm
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#264f78',
      }
    });

    const fitAddon = new FitAddon();
    const webglAddon = new WebglAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webglAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    // Handle WebGL context loss
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln(`\x1b[33mConnecting to container '${selectedContainer}'...\x1b[0m`);

    // Start Exec Session
    invoke("start_exec", { namespace, name, container: selectedContainer, sessionId })
      .then(() => {
        term.writeln(`\x1b[32mConnected!\x1b[0m`);
        term.focus();
        setIsConnected(true);
        setIsConnecting(false);
      })
      .catch(err => {
        term.writeln(`\x1b[31mFailed to connect: ${err} \x1b[0m`);
        setIsConnected(false);
        setIsConnecting(false);
      });

    // Handle Input
    term.onData(data => {
      invoke("send_exec_input", { sessionId, data }).catch(console.error);
    });

    // Handle Output
    const unlisten = listen<string>(`term_output:${sessionId}`, (event) => {
      term.write(event.payload);
    });

    // Handle Resize
    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);

    // Cleanup function for this connection attempt
    return () => {
      unlisten.then(f => f());
      window.removeEventListener("resize", handleResize);
    };
  }, [namespace, name, selectedContainer, sessionId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (xtermRef.current) {
        xtermRef.current.dispose();
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center gap-2 shrink-0 bg-[#252526] p-1 rounded border border-[#3e3e42]">
        <div className="flex items-center gap-2 px-2">
          <label className="text-[10px] uppercase font-bold text-[#858585]">Container:</label>
          <div className="relative">
            <select
              value={selectedContainer}
              onChange={(e) => setSelectedContainer(e.target.value)}
              disabled={isConnected || isConnecting}
              className="bg-[#1e1e1e] border border-[#3e3e42] text-[#cccccc] text-xs rounded pl-2 pr-6 py-1 appearance-none focus:border-[#007acc] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed min-w-[150px]"
            >
              {containers.map((c: string) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[#858585]">
              <ChevronDown size={10} />
            </div>
          </div>
        </div>

        <div className="h-4 w-px bg-[#3e3e42]" />

        {!isConnected ? (
          <button
            onClick={handleConnect}
            disabled={isConnecting || !selectedContainer}
            className="flex items-center gap-1.5 px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isConnecting ? <Loading size={10} label="" /> : <TerminalIcon size={12} />}
            Connect
          </button>
        ) : (
          <button
            onClick={handleDisconnect}
            className="flex items-center gap-1.5 px-3 py-1 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded transition-colors"
          >
            <X size={12} />
            Disconnect
          </button>
        )}

        {isConnected && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[#4ec9b0] px-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4ec9b0] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#4ec9b0]"></span>
            </span>
            Live Session
          </span>
        )}
      </div>

      <div className="flex-1 bg-[#1e1e1e] p-2 rounded-md border border-[#3e3e42] overflow-hidden relative">
        {!isConnected && !isConnecting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500 z-10">
            <TerminalIcon size={48} className="mb-4 opacity-20" />
            <p className="text-sm">Select a container and click Connect</p>
          </div>
        )}
        <div ref={terminalRef} className="h-full w-full" />
      </div>
    </div>
  );
}

// --- Metrics Chart Component ---
function MetricsChart({ resourceKind, namespace, name }: { resourceKind: string, namespace: string, name: string }) {
  const [metricsHistory, setMetricsHistory] = useState<ResourceMetrics[]>([]);

  const { data: currentMetrics } = useQuery({
    queryKey: ["metrics_chart", resourceKind, namespace, name],
    queryFn: async () => {
      const allMetrics = await invoke<ResourceMetrics[]>("get_resource_metrics", {
        kind: resourceKind,
        namespace: resourceKind === "Pod" ? namespace : null
      });
      return allMetrics.find(m => m.name === name);
    },
    enabled: resourceKind === "Pod" || resourceKind === "Node",
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (currentMetrics) {
      setMetricsHistory(prev => {
        const updated = [...prev, currentMetrics];
        // Keep last 60 data points (5 minutes at 5s intervals)
        return updated.slice(-60);
      });
    }
  }, [currentMetrics]);

  const getPercentageColor = (percent?: number) => {
    if (!percent) return '#6b7280'; // gray-500
    if (percent >= 90) return '#f87171'; // red-400
    if (percent >= 70) return '#fbbf24'; // yellow-400
    return '#34d399'; // green-400
  };

  const chartData = metricsHistory.map(m => ({
    time: new Date(m.timestamp).toLocaleTimeString(),
    cpu: (m.cpu_nano / 1_000_000).toFixed(2), // Convert to millicores
    memory: (m.memory_bytes / (1024 * 1024)).toFixed(2), // Convert to Mi
    cpuPercent: m.cpu_percent || 0,
    memoryPercent: m.memory_percent || 0,
  }));

  if (metricsHistory.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm bg-gradient-to-br from-gray-900 to-black rounded-lg border border-gray-800">
        Collecting metrics data...
      </div>
    );
  }

  const latest = metricsHistory[metricsHistory.length - 1];
  const cpuColor = getPercentageColor(latest.cpu_percent);
  const memoryColor = getPercentageColor(latest.memory_percent);

  return (
    <div className="space-y-4">
      {/* Current Usage with Percentage Indicators */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gradient-to-br from-gray-900 to-black p-4 rounded-lg border border-gray-800 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Cpu size={16} className="text-green-400" />
              <span className="text-gray-400 text-xs uppercase font-bold">CPU Usage</span>
            </div>
            {latest.cpu_percent !== undefined && (
              <div
                className="px-2 py-1 rounded text-xs font-bold shadow-sm"
                style={{
                  backgroundColor: `${cpuColor}30`,
                  color: cpuColor,
                  border: `1px solid ${cpuColor}60`
                }}
              >
                {latest.cpu_percent.toFixed(1)}%
              </div>
            )}
          </div>
          <div className="text-white text-2xl font-semibold">{latest.cpu}</div>
          {latest.cpu_limit_nano && (
            <div className="text-gray-500 text-xs mt-1">
              Limit: {(latest.cpu_limit_nano / 1_000_000_000).toFixed(2)} cores
            </div>
          )}
          {latest.cpu_percent !== undefined && (
            <div className="mt-2 h-2 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full transition-all duration-500 shadow-sm"
                style={{
                  width: `${Math.min(latest.cpu_percent, 100)}%`,
                  backgroundColor: cpuColor,
                  boxShadow: `0 0 8px ${cpuColor}80`
                }}
              />
            </div>
          )}
        </div>

        <div className="bg-gradient-to-br from-gray-900 to-black p-4 rounded-lg border border-gray-800 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-orange-400" />
              <span className="text-gray-400 text-xs uppercase font-bold">Memory Usage</span>
            </div>
            {latest.memory_percent !== undefined && (
              <div
                className="px-2 py-1 rounded text-xs font-bold shadow-sm"
                style={{
                  backgroundColor: `${memoryColor}30`,
                  color: memoryColor,
                  border: `1px solid ${memoryColor}60`
                }}
              >
                {latest.memory_percent.toFixed(1)}%
              </div>
            )}
          </div>
          <div className="text-white text-2xl font-semibold">{latest.memory}</div>
          {latest.memory_limit_bytes && (
            <div className="text-gray-500 text-xs mt-1">
              Limit: {(latest.memory_limit_bytes / (1024 * 1024 * 1024)).toFixed(2)} Gi
            </div>
          )}
          {latest.memory_percent !== undefined && (
            <div className="mt-2 h-2 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full transition-all duration-500 shadow-sm"
                style={{
                  width: `${Math.min(latest.memory_percent, 100)}%`,
                  backgroundColor: memoryColor,
                  boxShadow: `0 0 8px ${memoryColor}80`
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Time Series Charts */}
      <div className="bg-gradient-to-br from-gray-900 to-black p-4 rounded-lg border border-gray-800 shadow-lg">
        <h4 className="text-purple-400 text-xs uppercase font-bold mb-4">Resource Usage Over Time</h4>
        <div className="grid grid-cols-1 gap-6">
          {/* CPU Chart */}
          <div>
            <div className="text-gray-400 text-xs mb-2 font-semibold">CPU (millicores)</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="time"
                  stroke="#6b7280"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: '#6b7280' }}
                />
                <YAxis
                  stroke="#6b7280"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: '#6b7280' }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#000000',
                    border: '1px solid #374151',
                    borderRadius: '8px',
                    fontSize: '12px',
                    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.5)'
                  }}
                  labelStyle={{ color: '#ffffff' }}
                />
                <Line
                  type="monotone"
                  dataKey="cpu"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                  name="CPU (m)"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Memory Chart */}
          <div>
            <div className="text-gray-400 text-xs mb-2 font-semibold">Memory (MiB)</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="time"
                  stroke="#6b7280"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: '#6b7280' }}
                />
                <YAxis
                  stroke="#6b7280"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: '#6b7280' }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#000000',
                    border: '1px solid #374151',
                    borderRadius: '8px',
                    fontSize: '12px',
                    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.5)'
                  }}
                  labelStyle={{ color: '#ffffff' }}
                />
                <Line
                  type="monotone"
                  dataKey="memory"
                  stroke="#fb923c"
                  strokeWidth={2}
                  dot={false}
                  name="Memory (Mi)"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Local Terminal Tab ---
function LocalTerminalTab() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionId = useMemo(() => `local-${Math.random().toString(36).substr(2, 9)}`, []);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Initialize xterm
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 16,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#264f78',
      }
    });

    const fitAddon = new FitAddon();
    const webglAddon = new WebglAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webglAddon);

    term.open(terminalRef.current);

    // Wait for terminal to be fully rendered before fitting
    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch (e) {
        console.warn("Failed to fit terminal on initial load:", e);
      }
    }, 50);

    // Handle WebGL context loss
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Start Local Shell Session
    invoke("start_local_shell", { sessionId })
      .then(() => {
        term.writeln("\x1b[32mStarting local shell...\x1b[0m");
        term.focus();
      })
      .catch(err => {
        term.writeln(`\x1b[31mFailed to start shell: ${err}\x1b[0m`);
      });

    // Handle Input
    term.onData(data => {
      invoke("send_shell_input", { sessionId, data }).catch(console.error);
    });

    // Handle Output
    const unlisten = listen<string>(`shell_output:${sessionId}`, (event) => {
      term.write(event.payload);
    });

    // Handle Resize
    const handleResize = () => {
      try {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          const { cols, rows } = xtermRef.current;
          invoke("resize_shell", { sessionId, rows, cols }).catch(console.error);
        }
      } catch (e) {
        console.warn("Failed to resize terminal:", e);
      }
    };
    window.addEventListener("resize", handleResize);

    // Initial resize with delay
    setTimeout(handleResize, 150);

    return () => {
      unlisten.then(f => f());
      term.dispose();
      window.removeEventListener("resize", handleResize);
    };
  }, [sessionId]);

  return (
    <div className="h-full bg-[#1e1e1e] p-0 overflow-hidden">
      <div ref={terminalRef} className="h-full w-full" />
    </div>
  );
}

function ConnectionScreen({ onConnect, onOpenAzure }: { onConnect: () => void, onOpenAzure: () => void }) {
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"local" | "azure">("local");
  const qc = useQueryClient();

  const { data: contexts, isLoading } = useQuery({
    queryKey: ["kube_contexts", customPath],
    queryFn: async () => {
      const result = await invoke<{ name: string }[]>("list_contexts", { customPath });
      return result.map(c => c.name);
    },
  });

  const { data: currentContext } = useQuery({
    queryKey: ["current_context", customPath],
    queryFn: async () => await invoke<string>("get_current_context_name", { customPath }),
  });

  const filteredContexts = useMemo(() => {
    if (!contexts) return [];
    if (!searchQuery) return contexts;
    return contexts.filter(c => c.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [contexts, searchQuery]);

  const connectMutation = useMutation({
    mutationFn: async (context: string) => {
      console.log("Starting connection to:", context);

      // Reset all state and release locks first
      try {
        console.log("Resetting backend state...");
        await Promise.race([
          invoke("reset_state"),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Reset timeout")), 1000)
          )
        ]);
        console.log("Backend state reset");
      } catch (err) {
        console.warn("Failed to reset state (continuing anyway):", err);
      }

      // Try to set the context with a timeout
      try {
        console.log("Setting context...");
        await Promise.race([
          invoke("set_kube_config", { context, path: customPath }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 5000)
          )
        ]);
        console.log("Context set successfully");
      } catch (err) {
        console.warn("Failed to set context (will use current):", err);
        // Continue anyway - the app will use the current context
      }

      return Promise.resolve();
    },
    onSuccess: () => {
      console.log("Connection successful, calling onConnect");
      // Invalidate ALL cached data to prevent showing stale data from previous cluster
      qc.invalidateQueries({ queryKey: ["current_context"] });
      qc.invalidateQueries({ queryKey: ["current_context_boot"] });
      qc.invalidateQueries({ queryKey: ["current_context_global"] });
      qc.invalidateQueries({ queryKey: ["discovery"] });
      qc.invalidateQueries({ queryKey: ["namespaces"] });
      qc.invalidateQueries({ queryKey: ["cluster_stats"] });
      qc.invalidateQueries({ queryKey: ["vclusters"] });
      qc.invalidateQueries({ queryKey: ["list_resources"] });
      qc.invalidateQueries({ queryKey: ["resource"] });
      qc.invalidateQueries({ queryKey: ["crd-groups"] });
      // Clear all queries to be safe
      qc.clear();
      onConnect();
    },
    onError: (error: Error) => {
      console.error("Connection error:", error);
    }
  });

  // Add error state for connection failures
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Wrap mutation to handle error state
  const handleConnect = (ctx: string) => {
    setConnectionError(null);
    connectMutation.mutate(ctx, {
      onError: (err) => {
        setConnectionError(err.message);
      }
    });
  };

  const handleFileSelect = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Kubeconfig',
          extensions: ['yaml', 'yml', 'config', 'kubeconfig']
        }]
      });

      if (selected && typeof selected === 'string') {
        setCustomPath(selected);
      }
    } catch (err) {
      console.error("Failed to open file dialog", err);
    }
  };

  if (isLoading) return <LoadingScreen message="Loading Kubeconfig..." />;

  return (
    <div className="h-screen w-full bg-[#09090b] flex items-center justify-center relative overflow-hidden">
      {/* Animated Background */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-[-30%] left-[-20%] w-[70%] h-[70%] bg-gradient-to-br from-purple-600/20 via-purple-900/10 to-transparent rounded-full blur-[100px] animate-pulse" style={{ animationDuration: '8s' }} />
        <div className="absolute bottom-[-30%] right-[-20%] w-[70%] h-[70%] bg-gradient-to-tl from-cyan-600/20 via-blue-900/10 to-transparent rounded-full blur-[100px] animate-pulse" style={{ animationDuration: '10s' }} />
        <div className="absolute top-[20%] right-[10%] w-[40%] h-[40%] bg-gradient-to-bl from-blue-600/10 to-transparent rounded-full blur-[80px] animate-pulse" style={{ animationDuration: '12s' }} />
      </div>

      {/* Grid Pattern Overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_50%_50%_at_50%_50%,black_40%,transparent_100%)]" />

      <div className="w-full max-w-2xl z-10 animate-in fade-in zoom-in-95 duration-700 px-4">
        {/* Hero Section */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/20 mb-6">
            <Sparkles size={14} className="text-cyan-400" />
            <span className="text-xs font-medium text-cyan-300">Kubernetes Management Made Simple</span>
          </div>

          <div className="w-24 h-24 mx-auto mb-6 relative group">
            <div className="absolute inset-0 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-3xl blur-xl opacity-50 group-hover:opacity-75 transition-all duration-700 group-hover:scale-110" />
            <div className="absolute inset-0 bg-gradient-to-br from-cyan-400 to-blue-500 rounded-3xl opacity-20 animate-ping" style={{ animationDuration: '3s' }} />
            <div className="relative w-full h-full bg-gradient-to-br from-cyan-500 via-blue-500 to-blue-600 rounded-3xl flex items-center justify-center shadow-2xl border border-white/20">
              <Layers className="text-white drop-shadow-lg" size={48} />
            </div>
          </div>

          <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">
            Welcome to <span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">OpsPilot</span>
          </h1>
          <p className="text-zinc-400 text-base max-w-md mx-auto">
            Connect to your Kubernetes clusters and manage resources with ease
          </p>
        </div>

        {/* Connection Options Card */}
        <div className="glass-panel border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-xl bg-black/40">
          {/* Tab Selector */}
          <div className="flex border-b border-white/5">
            <button
              onClick={() => setActiveTab("local")}
              className={`flex-1 px-6 py-4 text-sm font-medium transition-all relative ${activeTab === "local" ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              <div className="flex items-center justify-center gap-2">
                <FileCode size={18} />
                <span>Local Kubeconfig</span>
              </div>
              {activeTab === "local" && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-500 to-blue-500" />
              )}
            </button>
            <button
              onClick={() => setActiveTab("azure")}
              className={`flex-1 px-6 py-4 text-sm font-medium transition-all relative ${activeTab === "azure" ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              <div className="flex items-center justify-center gap-2">
                <Cloud size={18} />
                <span>Azure AKS</span>
              </div>
              {activeTab === "azure" && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-purple-500" />
              )}
            </button>
          </div>

          {activeTab === "local" ? (
            <div className="p-6 space-y-5">
              {/* Kubeconfig Path */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                  <FileCode size={12} />
                  Kubeconfig File
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 bg-zinc-900/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-zinc-300 truncate flex items-center hover:border-white/20 transition-colors group">
                    <span className="truncate opacity-70 group-hover:opacity-100 transition-opacity">{customPath || "~/.kube/config"}</span>
                  </div>
                  <button
                    onClick={handleFileSelect}
                    className="bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-3 rounded-xl border border-white/10 transition-all hover:shadow-lg hover:shadow-cyan-500/10 active:scale-95 flex items-center gap-2"
                    title="Browse for kubeconfig file"
                  >
                    <FolderOpen size={18} />
                    <span className="text-sm font-medium">Browse</span>
                  </button>
                </div>
              </div>

              {/* Search */}
              <div className="relative">
                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search contexts..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-zinc-900/50 border border-white/10 rounded-xl pl-11 pr-4 py-3 text-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/50 transition-all placeholder:text-zinc-600"
                />
                {contexts && (
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-600">
                    {filteredContexts.length} context{filteredContexts.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {/* Error Message */}
              {connectionError && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                  <AlertCircle size={18} className="shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{connectionError}</span>
                </div>
              )}

              {/* Context List */}
              <div className="bg-zinc-900/30 rounded-xl border border-white/5 overflow-hidden">
                <div className="max-h-[280px] overflow-y-auto custom-scrollbar p-2 space-y-1">
                  {filteredContexts.map(ctx => (
                    <button
                      key={ctx}
                      onClick={() => handleConnect(ctx)}
                      disabled={connectMutation.isPending}
                      className={`w-full text-left px-4 py-3.5 rounded-xl text-sm transition-all border group relative overflow-hidden
                        ${connectMutation.isPending ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5 active:scale-[0.99]'}
                        ${ctx === currentContext ? 'bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border-cyan-500/30' : 'border-transparent hover:border-white/10'}
                      `}
                    >
                      <div className="flex items-center justify-between relative z-10">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-2.5 h-2.5 rounded-full shrink-0 transition-all ${ctx === currentContext ? 'bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.6)]' : 'bg-zinc-600 group-hover:bg-zinc-400'}`} />
                          <span className={`font-medium truncate ${ctx === currentContext ? 'text-cyan-100' : 'text-zinc-300 group-hover:text-white'}`}>
                            {ctx}
                          </span>
                          {ctx === currentContext && (
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                              Active
                            </span>
                          )}
                        </div>
                        {connectMutation.isPending && connectMutation.variables === ctx ? (
                          <Loader2 size={18} className="animate-spin text-cyan-400" />
                        ) : (
                          <ChevronRight size={16} className={`transition-all ${ctx === currentContext ? 'text-cyan-400' : 'text-zinc-600 group-hover:text-zinc-400 group-hover:translate-x-0.5'}`} />
                        )}
                      </div>
                    </button>
                  ))}

                  {filteredContexts.length === 0 && (
                    <div className="py-12 flex flex-col items-center justify-center text-zinc-500 gap-3">
                      <ServerOff size={32} className="opacity-40" />
                      <div className="text-center">
                        <p className="text-sm font-medium">No contexts found</p>
                        <p className="text-xs text-zinc-600 mt-1">Try a different kubeconfig file</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Azure Tab Content */
            <div className="p-8">
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/30 flex items-center justify-center">
                  <Cloud size={40} className="text-blue-400" />
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Connect to Azure AKS</h3>
                <p className="text-zinc-400 text-sm mb-6 max-w-sm mx-auto">
                  Browse and connect to your Azure Kubernetes Service clusters directly from your subscriptions
                </p>
                <button
                  onClick={onOpenAzure}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-medium transition-all shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Globe size={18} />
                  Open Azure Explorer
                </button>

                <div className="mt-8 pt-6 border-t border-white/5">
                  <p className="text-xs text-zinc-600 mb-4">Features</p>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="p-3 rounded-lg bg-white/5">
                      <div className="text-blue-400 mb-1">
                        <Server size={20} className="mx-auto" />
                      </div>
                      <p className="text-xs text-zinc-400">Multi-subscription</p>
                    </div>
                    <div className="p-3 rounded-lg bg-white/5">
                      <div className="text-green-400 mb-1">
                        <Check size={20} className="mx-auto" />
                      </div>
                      <p className="text-xs text-zinc-400">Auto-credentials</p>
                    </div>
                    <div className="p-3 rounded-lg bg-white/5">
                      <div className="text-purple-400 mb-1">
                        <Layers size={20} className="mx-auto" />
                      </div>
                      <p className="text-xs text-zinc-400">Resource groups</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="px-6 py-3 bg-zinc-900/50 border-t border-white/5 flex items-center justify-between">
            <p className="text-[10px] text-zinc-600 font-mono">OpsPilot v1.0.0</p>
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Ready
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommandPalette({
  isOpen,
  onClose,
  navStructure,
  onNavigate
}: {
  isOpen: boolean,
  onClose: () => void,
  navStructure: NavGroup[] | undefined,
  onNavigate: (res: NavResource) => void
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Flatten navigation items for search
  const items = useMemo(() => {
    if (!navStructure) return [];
    return navStructure.flatMap(group =>
      group.items.map(item => ({
        ...item,
        category: group.title
      }))
    );
  }, [navStructure]);

  const filteredItems = useMemo(() => {
    if (!query) return items.slice(0, 10); // Show top 10 by default
    return items.filter((item: any) =>
      item.title.toLowerCase().includes(query.toLowerCase()) ||
      item.kind.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 10);
  }, [items, query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, filteredItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        onNavigate(filteredItems[selectedIndex]);
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-gradient-to-br from-gray-900 to-black border border-gray-800 rounded-lg shadow-2xl shadow-purple-500/20 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center px-4 py-3 border-b border-gray-800 gap-3">
          <Search size={18} className="text-gray-500" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent border-none outline-none text-white placeholder-gray-500 text-sm"
            placeholder="Type a command or search..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="flex gap-1">
            <span className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded border border-gray-700">ESC</span>
          </div>
        </div>

        <div className="max-h-[300px] overflow-y-auto py-2">
          {filteredItems.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">No results found.</div>
          ) : (
            filteredItems.map((item: any, index: number) => (
              <button
                key={`${item.group}/${item.kind}`}
                className={`w-full text-left px-4 py-2 flex items-center justify-between text-sm transition-all ${index === selectedIndex ? "bg-cyan-600 text-white" : "text-gray-300 hover:bg-gray-800"
                  }`}
                onClick={() => {
                  onNavigate(item);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div className="flex items-center gap-2">
                  {getCategoryIcon(item.category)}
                  <span>{item.title}</span>
                </div>
                <span className={`text-xs ${index === selectedIndex ? "text-white/70" : "text-gray-500"}`}>
                  {item.category}
                </span>
              </button >
            ))
          )}
        </div >

        <div className="px-4 py-2 bg-gray-900 border-t border-gray-800 text-[10px] text-gray-500 flex justify-between">
          <span>Navigate with <span className="font-mono">↑↓</span></span>
          <span>Select with <span className="font-mono">↵</span></span>
        </div>
      </div >
    </div >
  );
}

// --- Sidebar Group Component ---
const SidebarGroup = ({ title, icon: Icon, items, activeRes, onSelect, isOpen, onToggle }: any) => {
  if (items.length === 0) return null;

  const groupColors: Record<string, string> = {
    "Cluster": "text-blue-400 group-hover:text-blue-300",
    "Workloads": "text-purple-400 group-hover:text-purple-300",
    "Config": "text-yellow-400 group-hover:text-yellow-300",
    "Network": "text-green-400 group-hover:text-green-300",
    "Storage": "text-orange-400 group-hover:text-orange-300",
    "Access Control": "text-red-400 group-hover:text-red-300",
  };

  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 text-base font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition-all group"
      >
        <div className="flex items-center gap-2.5">
          <Icon size={18} className={groupColors[title] || "text-cyan-400 group-hover:text-cyan-300"} />
          <span>{title}</span>
        </div>
        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>

      {isOpen && (
        <div className="mt-1 ml-3 pl-3 border-l border-gray-700 space-y-0.5">
          {items.map((res: any) => (
            <button
              key={`${res.group}/${res.kind}`}
              onClick={() => onSelect(res)}
              className={`w-full text-left px-3 py-2 text-base rounded-md transition-all flex items-center gap-2.5 ${activeRes?.kind === res.kind
                ? "bg-gradient-to-r from-purple-600/80 to-blue-600/80 text-white font-medium shadow-lg shadow-purple-500/20"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
            >
              {res.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Sidebar Section Component (for nesting) ---
const SidebarSection = ({ title, icon: Icon, isOpen, onToggle, children }: any) => {
  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 text-base font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition-all group"
      >
        <div className="flex items-center gap-2.5">
          <Icon size={18} className="text-pink-400 group-hover:text-pink-300" />
          <span>{title}</span>
        </div>
        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>

      {isOpen && (
        <div className="mt-1 ml-3 pl-3 border-l border-gray-700 space-y-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

// --- Delete Confirmation Modal ---
function DeleteConfirmationModal({ isOpen, onClose, onConfirm, resourceName }: { isOpen: boolean, onClose: () => void, onConfirm: () => void, resourceName: string }) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setInputValue("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue === resourceName) {
      onConfirm();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-gradient-to-br from-gray-900 to-black border border-red-500/30 rounded-lg shadow-2xl shadow-red-500/20 overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6 border-b border-gray-800">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-full bg-red-500/10">
              <AlertCircle className="text-red-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-white">Delete Resource</h2>
          </div>
          <p className="text-gray-400 text-sm">
            This action cannot be undone. Type <span className="font-mono text-red-400 font-semibold">{resourceName}</span> to confirm deletion.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-2">
              Resource name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              className="w-full px-3 py-2 bg-black border border-gray-800 rounded-md text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500"
              placeholder={resourceName}
              autoComplete="off"
            />
          </div>

          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white rounded-md transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={inputValue !== resourceName}
              className="px-4 py-2 bg-red-600 text-white rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-red-700 disabled:hover:bg-red-600"
            >
              Delete Resource
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ClusterOverview({
  onNavigate,
  navStructure,
  vclusters,
  vclustersLoading,
  vclustersFetching,
  isDiscovering
}: {
  onNavigate: (res: NavResource) => void,
  navStructure?: NavGroup[],
  vclusters?: any[],
  vclustersLoading?: boolean,
  vclustersFetching?: boolean,
  isDiscovering?: boolean
}) {
  const { data: stats, isLoading, isError, error } = useQuery({
    queryKey: ["cluster_stats"],
    queryFn: async () => await invoke<ClusterStats>("get_cluster_stats"),
    staleTime: 30000, // Cache for 30 seconds
    refetchInterval: 60000, // Refetch every 60 seconds (reduced from 30)
  });

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center p-20 text-red-400">
        <AlertCircle size={48} className="mb-4" />
        <p className="text-lg">Failed to load cluster stats</p>
        <p className="text-sm text-gray-500 mt-2">{String(error)}</p>
      </div>
    );
  }

  const findResourceType = (kind: string): NavResource | null => {
    if (!navStructure) {
      console.warn('navStructure not loaded yet');
      return null;
    }
    for (const group of navStructure) {
      const found = group.items.find(item => item.kind.toLowerCase() === kind.toLowerCase());
      if (found) {
        console.log(`Found resource type for ${kind}:`, found);
        return found;
      }
    }
    console.warn(`Resource type not found for: ${kind}`);
    return null;
  };

  // Stat card component with loading state
  const StatCard = ({ kind, label, value, color, icon: Icon }: {
    kind: string, label: string, value?: number, color: string, icon: any
  }) => {
    const colorClasses: Record<string, { border: string, text: string, bg: string, hover: string }> = {
      blue: { border: 'hover:border-blue-500', text: 'text-blue-400', bg: 'bg-blue-500/10', hover: 'group-hover:text-blue-300' },
      green: { border: 'hover:border-green-500', text: 'text-green-400', bg: 'bg-green-500/10', hover: 'group-hover:text-green-300' },
      purple: { border: 'hover:border-purple-500', text: 'text-purple-400', bg: 'bg-purple-500/10', hover: 'group-hover:text-purple-300' },
      orange: { border: 'hover:border-orange-500', text: 'text-orange-400', bg: 'bg-orange-500/10', hover: 'group-hover:text-orange-300' },
      yellow: { border: 'hover:border-yellow-500', text: 'text-yellow-400', bg: 'bg-yellow-500/10', hover: 'group-hover:text-yellow-300' },
    };
    const c = colorClasses[color];

    return (
      <button
        onClick={() => {
          const resourceType = findResourceType(kind);
          if (resourceType) onNavigate(resourceType);
        }}
        disabled={isDiscovering}
        className={`bg-gradient-to-br from-gray-900 to-black p-6 rounded-lg border border-gray-800 flex items-center justify-between ${c.border} hover:shadow-lg transition-all cursor-pointer group disabled:opacity-70 disabled:cursor-wait`}
      >
        <div className="text-left">
          <h3 className={`text-gray-400 text-sm font-medium uppercase tracking-wider mb-1 ${c.hover} transition-colors`}>{label}</h3>
          {isLoading ? (
            <div className="h-9 w-16 bg-gray-800 rounded animate-pulse" />
          ) : (
            <span className={`text-3xl font-bold ${c.text} ${c.hover} transition-colors`}>{value ?? 0}</span>
          )}
        </div>
        <div className={`p-3 rounded-full ${c.bg} group-hover:scale-105 transition-all`}>
          <Icon className={`${c.text} w-8 h-8 group-hover:scale-110 transition-transform`} />
        </div>
      </button>
    );
  };

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-300 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white mb-2">Cluster Overview</h1>
          <p className="text-gray-400">High-level summary of your cluster resources.</p>
        </div>
        {isDiscovering && (
          <div className="flex items-center gap-2 text-sm text-cyan-400">
            <Loader2 size={16} className="animate-spin" />
            <span>Discovering resources...</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <StatCard kind="Node" label="Nodes" value={stats?.nodes} color="blue" icon={Server} />
        <StatCard kind="Pod" label="Pods" value={stats?.pods} color="green" icon={Layers} />
        <StatCard kind="Deployment" label="Deployments" value={stats?.deployments} color="purple" icon={Package} />
        <StatCard kind="Service" label="Services" value={stats?.services} color="orange" icon={Network} />
        <StatCard kind="Namespace" label="Namespaces" value={stats?.namespaces} color="yellow" icon={FolderOpen} />
      </div>

      {/* Virtual Clusters (vcluster) */}
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-bold text-white mb-1 flex items-center gap-2">
            <Layers size={20} className="text-cyan-400" />
            Virtual Clusters (vcluster)
          </h2>
          <p className="text-gray-400 text-sm">Virtual Kubernetes clusters running in this cluster</p>
        </div>

        {(vclustersLoading || vclustersFetching) ? (
          <div className="bg-gradient-to-br from-purple-900/20 to-blue-900/20 backdrop-blur-sm rounded-lg p-8 border border-purple-500/30">
            <div className="flex items-center justify-center gap-3">
              <svg className="animate-spin h-5 w-5 text-purple-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="text-gray-400">Loading virtual clusters...</span>
            </div>
          </div>
        ) : vclusters && vclusters.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {vclusters.map((vc: any) => {
              const vclusterName = vc.vclusterName || vc.name;
              return (
                <div
                  key={vc.id}
                  className="bg-gradient-to-br from-gray-900 to-black p-4 rounded-lg border border-cyan-500/30 hover:border-cyan-500 hover:shadow-lg hover:shadow-cyan-500/30 transition-all"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-white text-sm truncate mb-1">{vclusterName}</h3>
                      <span className="text-xs text-gray-500">Namespace: {vc.namespace}</span>
                    </div>
                    <StatusBadge status={vc.status} />
                  </div>

                  <VclusterConnectButton name={vclusterName} namespace={vc.namespace} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4 text-center text-gray-500 text-sm">
            No vclusters detected in this cluster
          </div>
        )}
      </div>
    </div>
  );
}

function VclusterConnectButton({ name, namespace }: { name: string, namespace: string }) {
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const qc = useQueryClient();
  // Handle Reload button: invalidate queries globally when event fires
  useEffect(() => {
    const handler = () => {
      try {
        qc.invalidateQueries();
      } catch { }
    };
    window.addEventListener("lenskiller:reload", handler);
    return () => window.removeEventListener("lenskiller:reload", handler);
  }, [qc]);
  return (
    <div>
      <button
        onClick={async () => {
          try {
            setConnecting(true);
            const result = await invoke("connect_vcluster", {
              name,
              namespace
            });
            console.log('vcluster connect success:', result);
            setConnected(true);
            // Toast notify
            if ((window as any).showToast) {
              (window as any).showToast(`Connected to vcluster '${name}' in namespace '${namespace}'`, 'success');
            }
            // Soft refresh: invalidate relevant queries so UI reflects new context
            await qc.invalidateQueries({ queryKey: ["current_context"] });
            await qc.invalidateQueries({ queryKey: ["cluster_stats"] });
            await qc.invalidateQueries({ queryKey: ["vclusters"] });
            await qc.invalidateQueries({ queryKey: ["discovery"] });
            await qc.invalidateQueries({ queryKey: ["namespaces"] });
            // Also refetch any resource lists that depend on context
            await qc.invalidateQueries({ predicate: (q) => Array.isArray(q.queryKey) && q.queryKey.includes("list_resources") });
          } catch (err) {
            console.error('vcluster connect error:', err);
            if ((window as any).showToast) {
              (window as any).showToast(`Failed to connect: ${err}`, 'error');
            }
            alert(`Error: ${err}\n\nTo connect manually, run:\nvcluster connect ${name} -n ${namespace}`);
          } finally {
            setConnecting(false);
          }
        }}
        disabled={connecting}
        className={`w-full mt-3 px-3 py-2 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 ${connecting ? 'bg-cyan-800 text-white cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-700 text-white'}`}
      >
        {connecting ? (
          <>
            <Loader2 className="animate-spin" size={14} />
            Connecting...
          </>
        ) : (
          <>
            <Plug size={14} />
            Connect to vcluster
          </>
        )}
      </button>
      {connected && (
        <div className="mt-2 text-xs flex items-center gap-2 text-green-400">
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.707a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 10-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" /></svg>
          Connected to {name}. Refreshing data...
        </div>
      )}
    </div>
  );
}

// Resource list component - shows all resources of a given type
function ResourceList({ resourceType, onSelect, namespaceFilter, searchQuery, currentContext }: { resourceType: NavResource, onSelect: (obj: K8sObject) => void, namespaceFilter: string, searchQuery: string, currentContext?: string }) {
  // Defensive guard: ensure resourceType is valid
  if (!resourceType || !resourceType.kind) {
    return <div className="h-full flex items-center justify-center"><Loading size={24} label="Loading" /></div>;
  }
  const { data: resources, isLoading: isListLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["list_resources", currentContext, resourceType.group || "", resourceType.version || "", resourceType.kind || "", namespaceFilter],
    queryFn: async () => await invoke<K8sObject[]>("list_resources", {
      req: {
        group: resourceType.group,
        version: resourceType.version,
        kind: resourceType.kind,
        namespace: namespaceFilter === "All Namespaces" ? null : namespaceFilter
      }
    }),
    staleTime: 10000, // Consider data fresh for 10 seconds
    gcTime: 1000 * 60 * 5, // Keep in cache for 5 minutes
    refetchInterval: 30000, // Refetch every 30 seconds (reduced frequency)
    refetchOnWindowFocus: false,
  });

  // Listen for global reloads and refetch
  useEffect(() => {
    const handler = () => {
      refetch();
    };
    window.addEventListener("lenskiller:reload", handler);
    return () => window.removeEventListener("lenskiller:reload", handler);
  }, [refetch]);

  const kindLower = (resourceType.kind || '').toLowerCase();
  const isPod = kindLower === 'pod';
  const isNode = kindLower === 'node';

  // Fetch metrics for pods and nodes
  const { data: metricsData } = useQuery({
    queryKey: ["list_metrics", currentContext, resourceType.kind || "", namespaceFilter],
    queryFn: async () => {
      try {
        return await invoke<ResourceMetrics[]>("get_resource_metrics", {
          kind: resourceType.kind,
          namespace: isPod ? (namespaceFilter === "All Namespaces" ? null : namespaceFilter) : null
        });
      } catch (e) {
        console.warn("Metrics not available:", e);
        return [];
      }
    },
    enabled: isPod || isNode,
    staleTime: 10000,
    refetchInterval: 30000,
  });

  const metricsMap = useMemo(() => {
    const map = new Map<string, ResourceMetrics>();
    if (metricsData) {
      metricsData.forEach(m => map.set(`${m.namespace || ''}/${m.name}`, m));
    }
    return map;
  }, [metricsData]);

  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  const filteredResources = useMemo(() => {
    if (!resources) return [];
    let filtered = resources.filter(r => {
      const nsMatch = namespaceFilter === "All Namespaces" || r.namespace === namespaceFilter;
      const searchMatch = !searchQuery || r.name.toLowerCase().includes(searchQuery.toLowerCase());
      return nsMatch && searchMatch;
    });

    // Apply sorting
    if (sortConfig) {
      filtered = [...filtered].sort((a, b) => {
        let aVal: any = a[sortConfig.key as keyof K8sObject];
        let bVal: any = b[sortConfig.key as keyof K8sObject];

        // Special handling for different data types
        if (sortConfig.key === 'age') {
          aVal = new Date(a.age).getTime();
          bVal = new Date(b.age).getTime();
        } else if (sortConfig.key === 'restarts') {
          aVal = a.restarts ?? 0;
          bVal = b.restarts ?? 0;
        } else if (sortConfig.key === 'ready') {
          // Parse ready string like "1/1" to compare
          const [aReady, aTotal] = (a.ready || '0/0').split('/').map(Number);
          const [bReady, bTotal] = (b.ready || '0/0').split('/').map(Number);
          aVal = aTotal > 0 ? aReady / aTotal : 0;
          bVal = bTotal > 0 ? bReady / bTotal : 0;
        } else if (sortConfig.key === 'cpu' || sortConfig.key === 'memory') {
          // For nodes, namespace is "-" in resource list but "" in metrics
          const aNs = a.namespace === '-' ? '' : (a.namespace || '');
          const bNs = b.namespace === '-' ? '' : (b.namespace || '');
          const aMetrics = metricsMap.get(`${aNs}/${a.name}`);
          const bMetrics = metricsMap.get(`${bNs}/${b.name}`);
          aVal = sortConfig.key === 'cpu' ? (aMetrics?.cpu_nano ?? 0) : (aMetrics?.memory_bytes ?? 0);
          bVal = sortConfig.key === 'cpu' ? (bMetrics?.cpu_nano ?? 0) : (bMetrics?.memory_bytes ?? 0);
        }

        // String comparison for text fields
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          return sortConfig.direction === 'asc'
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal);
        }

        // Numeric comparison
        if (sortConfig.direction === 'asc') {
          return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        } else {
          return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
        }
      });
    }

    return filtered;
  }, [resources, namespaceFilter, searchQuery, sortConfig, metricsMap]);

  const handleSort = (key: string) => {
    setSortConfig(current => {
      if (!current || current.key !== key) {
        return { key, direction: 'asc' };
      }
      if (current.direction === 'asc') {
        return { key, direction: 'desc' };
      }
      return null; // Reset sorting
    });
  };

  const SortableHeader = ({ label, sortKey }: { label: string; sortKey: string }) => {
    const isActive = sortConfig?.key === sortKey;
    const direction = sortConfig?.direction;
    return (
      <div
        onClick={() => handleSort(sortKey)}
        className="flex items-center gap-1 cursor-pointer hover:text-cyan-400 transition-all select-none"
      >
        <span>{label}</span>
        <div className="flex flex-col">
          <ChevronDown
            size={10}
            className={`-mb-1 ${isActive && direction === 'asc' ? 'text-cyan-400' : 'text-gray-700'}`}
            style={{ transform: 'rotate(180deg)' }}
          />
          <ChevronDown
            size={10}
            className={`${isActive && direction === 'desc' ? 'text-cyan-400' : 'text-gray-700'}`}
          />
        </div>
      </div>
    );
  };

  // Show loading state
  // Guard: don't render anything until resources are loaded
  if (!resources) {
    return <Loading fullScreen size={32} />;
  }

  // Show error ONLY if we have no data at all
  if (!resources) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <div className="bg-red-500/10 p-8 rounded-xl border border-red-500/30 max-w-md backdrop-blur-sm shadow-lg shadow-red-500/10">
          <AlertCircle size={40} className="text-red-400 mx-auto mb-4" />
          <h3 className="text-base font-bold text-white mb-2">No Data Available</h3>
          <p className="text-gray-400 text-sm">
            {isError ? `Error: ${error}` : "Loading resources..."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#09090b]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/5 bg-zinc-900/30 backdrop-blur-md text-xs sticky top-0 z-10">
        <div className="flex items-center gap-2 text-zinc-500">
          <span className="uppercase tracking-wider font-semibold">{resourceType.kind}</span>
          {isListLoading ? (
            <span className="flex items-center gap-1 text-cyan-400">
              <Loading size={12} label="Loading" />
            </span>
          ) : isError ? (
            <span className="flex items-center gap-1 text-red-400">
              <AlertCircle size={12} /> Failed
            </span>
          ) : (
            <span className={`flex items-center gap-1 ${isFetching ? 'text-cyan-400' : 'text-emerald-400'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${isFetching ? 'bg-cyan-400 animate-pulse' : 'bg-emerald-400'}`} />
              {isFetching ? 'Live (updating)' : 'Live'}
            </span>
          )}
        </div>
      </div>
      {isPod ? (
        <div className="grid grid-cols-[2fr_1.5fr_0.8fr_0.7fr_0.8fr_0.8fr_0.8fr_1.2fr_1fr] gap-3 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
          <SortableHeader label="Name" sortKey="name" />
          <SortableHeader label="Namespace" sortKey="namespace" />
          <SortableHeader label="Ready" sortKey="ready" />
          <SortableHeader label="Status" sortKey="status" />
          <SortableHeader label="Restarts" sortKey="restarts" />
          <SortableHeader label="CPU" sortKey="cpu" />
          <SortableHeader label="Memory" sortKey="memory" />
          <SortableHeader label="Node" sortKey="node" />
          <SortableHeader label="Age" sortKey="age" />
        </div>
      ) : isNode ? (
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
          <SortableHeader label="Name" sortKey="name" />
          <SortableHeader label="Status" sortKey="status" />
          <SortableHeader label="CPU" sortKey="cpu" />
          <SortableHeader label="Memory" sortKey="memory" />
          <SortableHeader label="Age" sortKey="age" />
        </div>
      ) : (
        <div className="grid grid-cols-[2fr_1.5fr_1fr_1fr] gap-4 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
          <SortableHeader label="Name" sortKey="name" />
          <SortableHeader label="Namespace" sortKey="namespace" />
          <SortableHeader label="Status" sortKey="status" />
          <SortableHeader label="Age" sortKey="age" />
        </div>
      )}

      {/* List */}
      <div className="flex-1">
        {isListLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 bg-white/5 rounded animate-pulse" />
            ))}
          </div>
        ) : filteredResources.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4 border border-white/10">
              <Layers size={32} className="opacity-40 text-zinc-400" />
            </div>
            <p className="text-base font-medium text-zinc-300">No resources found</p>
            <p className="text-sm opacity-60 mt-2">
              {searchQuery ? `No matches for "${searchQuery}"` : `There are no ${resourceType.kind}s in ${namespaceFilter}`}
            </p>
          </div>
        ) : (
          <Virtuoso
            style={{ height: "100%" }}
            data={filteredResources}
            itemContent={(_, obj) => {
              // For nodes, namespace is "-" in resource list but "" in metrics
              const metricsNs = obj.namespace === '-' ? '' : (obj.namespace || '');
              const metrics = metricsMap.get(`${metricsNs}/${obj.name}`);
              return isPod ? (
                <div
                  onClick={() => onSelect(obj)}
                  className="grid grid-cols-[2fr_1.5fr_0.8fr_0.7fr_0.8fr_0.8fr_0.8fr_1.2fr_1fr] gap-3 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group"
                >
                  <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                  <div className="text-zinc-500 truncate" title={obj.namespace}>{obj.namespace}</div>
                  <div className="text-cyan-400 font-mono text-xs font-semibold">{obj.ready || '0/0'}</div>
                  <div><StatusBadge status={obj.status} /></div>
                  <div className="text-yellow-400 font-mono text-xs font-semibold">{obj.restarts ?? 0}</div>
                  <div className="text-emerald-400 font-mono text-xs font-semibold">{metrics?.cpu || '-'}</div>
                  <div className="text-orange-400 font-mono text-xs font-semibold">{metrics?.memory || '-'}</div>
                  <div className="text-zinc-500 truncate text-xs" title={obj.node}>{obj.node || '-'}</div>
                  <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                </div>
              ) : isNode ? (
                <div
                  onClick={() => onSelect(obj)}
                  className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group"
                >
                  <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                  <div><StatusBadge status={obj.status} /></div>
                  <div className="text-emerald-400 font-mono text-xs font-semibold">{metrics?.cpu || '-'}</div>
                  <div className="text-orange-400 font-mono text-xs font-semibold">{metrics?.memory || '-'}</div>
                  <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                </div>
              ) : (
                <div
                  onClick={() => onSelect(obj)}
                  className="grid grid-cols-[2fr_1.5fr_1fr_1fr] gap-4 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group"
                >
                  <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                  <div className="text-zinc-500 truncate" title={obj.namespace}>{obj.namespace}</div>
                  <div><StatusBadge status={obj.status} /></div>
                  <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

interface Tab {
  id: string;
  resource: K8sObject;
  kind: string;
}

function Dashboard({ onDisconnect, isConnected, setIsConnected }: { onDisconnect: () => void, isConnected: boolean, setIsConnected: (v: boolean) => void }) {
  const [activeRes, setActiveRes] = useState<NavResource | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [resourceToDelete, setResourceToDelete] = useState<K8sObject | null>(null);

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
  const qc = useQueryClient();
  // Don't clear cache on mount - it blocks the UI and causes slow loading
  // The cache will be cleared when needed (e.g., on disconnect)
  /*
  useEffect(() => {
    (async () => {
      try { qc.invalidateQueries(); } catch { }
      try {
        // @ts-ignore
        await invoke("clear_discovery_cache");
      } catch { }
    })();
  }, [qc]);
  */

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
        kind: activeRes?.kind || ""
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
    }
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
  const { data: currentContext } = useQuery({
    queryKey: ["current_context"],
    queryFn: async () => await invoke<string>("get_current_context_name"),
  });

  // Detect vcluster instances using vcluster CLI (Moved to Dashboard for persistence)
  // Note: We no longer fetch namespaces here - we reuse cached data from initial fetch
  const { data: vclusters, isLoading: vclustersLoading, isFetching: vclustersFetching } = useQuery({
    queryKey: ["vclusters", currentContext],
    queryFn: async () => {
      try {
        // Only fetch vcluster list - namespaces come from initial data fetch or cache
        const vclusterResult = await invoke<string>("list_vclusters").catch(() => "[]");

        // Try to get namespaces from React Query cache (populated by initial fetch)
        const cachedNamespaces = qc.getQueryData<string[]>(["namespaces", currentContext]);

        try {
          const vclusterList = JSON.parse(vclusterResult);

          if (vclusterList && vclusterList.length > 0) {
            // If we have cached namespaces, filter vclusters; otherwise show all
            const currentNamespaces = cachedNamespaces ? new Set(cachedNamespaces) : null;
            const filteredVclusters = currentNamespaces
              ? vclusterList.filter((vc: any) => currentNamespaces.has(vc.Namespace))
              : vclusterList;

            // Transform to our format
            return filteredVclusters.map((vc: any) => ({
              id: `vcluster-${vc.Name}-${vc.Namespace}`,
              name: vc.Name,
              namespace: vc.Namespace,
              status: vc.Status || 'Unknown',
              kind: 'VCluster',
              group: '',
              version: vc.Version || '',
              age: '',
              raw_json: '',
              vclusterName: vc.Name,
            }));
          }
        } catch (parseError) {
          console.warn('vcluster CLI parse failed:', parseError);
        }

        return [];
      } catch (e) {
        console.error('Error fetching vclusters:', e);
        return [];
      }
    },
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 5 * 60 * 1000,    // 5 minutes
    retry: false,
    enabled: !!currentContext,
  });

  // Keyboard Shortcut for Command Palette & Terminal
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsCmdPaletteOpen((open) => !open);
      }
      if (e.key === "`" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsTerminalOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
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
    staleTime: 60000, // Cache discovery for 60s - backend has disk cache too
    gcTime: 1000 * 60 * 10, // Keep in memory for 10 minutes
  });

  // 1b. Fetch initial cluster data in parallel - this populates caches for instant navigation
  const { data: initialData } = useQuery({
    queryKey: ["initial_cluster_data", currentContext],
    queryFn: async () => {
      const data = await invoke<InitialClusterData>("get_initial_cluster_data");

      // Pre-populate React Query caches with the fetched data for instant navigation
      // This means when user clicks Pods, Nodes, etc., data is already available
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

  // Invalidate discovery on context change to force loading state
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
      try {
        const crds = await invoke<any[]>("list_crds");
        // Group CRDs by apiGroup title
        const grouped: Record<string, any[]> = {};
        crds.forEach((c: any) => {
          const apiGroup = c.group || "Custom";
          const entry = {
            kind: c.kind,
            group: c.group,
            version: (c.versions || [])[0]?.name || c.version || "v1",
            namespaced: c.scope === "Namespaced",
            title: c.kind
          };
          if (!grouped[apiGroup]) grouped[apiGroup] = [];
          grouped[apiGroup].push(entry);
        });
        return grouped;
      } catch (e) {
        console.warn("CRD listing failed", e);
        return {};
      }
    },
    enabled: !!currentContext,
    staleTime: 30000,
  });

  // Force re-discovery when global reload occurs
  useEffect(() => {
    const handler = () => {
      refetchDiscovery();
    };
    window.addEventListener("lenskiller:reload", handler);
    return () => window.removeEventListener("lenskiller:reload", handler);
  }, [refetchDiscovery]);

  // Default to Cluster Overview
  useEffect(() => {
    if (navStructure && !activeRes) {
      setActiveRes(null); // null means Cluster Overview
    }
  }, [navStructure]);

  // State for expanded groups
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    "Cluster": true,
    "Workloads": true,
    "Network": false,
    "Config": false,
    "Storage": false,
    "Access Control": false,
    "Crossplane": true,
    "Custom Resources": false
  });

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }));
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
      // Skip the top-level "Custom Resources" bucket; we'll show CRDs under their API groups instead
      if (group.title === "Custom Resources") {
        return;
      }
      group.items.forEach(item => {
        const targetGroup = mappings[item.kind];
        if (targetGroup) {
          groups[targetGroup].push(item);
        } else {
          // Use the API Group title for custom resources
          const apiGroup = group.title;
          if (!groups[apiGroup]) {
            groups[apiGroup] = [];
          }
          groups[apiGroup].push(item);
        }
      });
    });

    // Merge CRDs discovered separately for progressive hydration
    if (crdGroups) {
      Object.entries(crdGroups).forEach(([apiGroup, items]) => {
        if (!groups[apiGroup]) groups[apiGroup] = [];
        // Dedup by kind
        const existingKinds = new Set(groups[apiGroup].map(i => i.kind));
        items.forEach((i: any) => {
          if (!existingKinds.has(i.kind)) {
            // Normalize: ensure title is present (fallback to kind)
            const normalized = { ...i, title: i.title ?? i.kind };
            groups[apiGroup].push(normalized);
          }
        });
      });
    }

    // Deduplicate items in each group by title (case-insensitive)
    Object.keys(groups).forEach(groupName => {
      const seen = new Set<string>();
      groups[groupName] = groups[groupName]
        .map(item => ({ ...item, title: item.title ?? item.kind }))
        .filter(item => {
          const key = (item.title || '').toLowerCase();
          if (seen.has(key)) {
            return false;
          }
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

  // 2. Fetch Namespaces for Filter (scoped to current context)
  // Note: initialData comes from get_initial_cluster_data which pre-populates the cache
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
    staleTime: 60000, // Increased to 60s since we get fresh data from initial fetch
    initialData: initialData?.namespaces?.sort(), // Use cached data from initial fetch
  });

  // Set default active resource to Cluster Overview
  useEffect(() => {
    if (navStructure && !activeRes) {
      setActiveRes(null); // null means Cluster Overview
    }
  }, [navStructure]);

  // 2.5 Background Prefetching (Performance Optimization)
  useEffect(() => {
    if (!navStructure || !currentContext) return;

    const prefetch = async () => {
      console.log("Starting background prefetch...");

      // Collect all items to prefetch
      const allItems = navStructure.flatMap(group => group.items);

      // Skip resources already fetched by initial data (Pod, Node, Deployment, Service)
      const alreadyFetched = ["Pod", "Node", "Deployment", "Service"];

      // Prioritize common resources - load these first for snappier UX
      const priorityKinds = ["ConfigMap", "Secret", "Ingress", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"];
      const priorityItems = allItems.filter(item =>
        priorityKinds.includes(item.kind) && !alreadyFetched.includes(item.kind)
      );
      const otherItems = allItems.filter(item =>
        !priorityKinds.includes(item.kind) && !alreadyFetched.includes(item.kind)
      );
      const sortedItems = [...priorityItems, ...otherItems];

      // Prefetch in parallel batches of 10 to avoid overwhelming the backend
      const batchSize = 10;
      for (let i = 0; i < sortedItems.length; i += batchSize) {
        const batch = sortedItems.slice(i, i + batchSize);
        await Promise.all(
          batch.map(item =>
            qc.prefetchQuery({
              // Use same query key format as ResourceList for cache hit
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

    // Small delay to allow initial render to settle
    const timer = setTimeout(prefetch, 500);
    return () => clearTimeout(timer);
  }, [navStructure, currentContext, qc]);



  const deleteMutation = useMutation({
    mutationFn: async (obj: K8sObject) => {
      if (!activeRes) return;
      await invoke("delete_resource", {
        req: { group: activeRes.group, version: activeRes.version, kind: activeRes.kind, namespace: obj.namespace === "-" ? null : obj.namespace },
        name: obj.name
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource"] });
      if (activeTabId) {
        handleCloseTab(activeTabId);
      }
    }
  });





  // Note: We no longer block the entire UI during discovery.
  // ClusterOverview shows immediately with skeleton loading for stats,
  // and the sidebar shows a skeleton while discovery is in progress.

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
              onClick={() => setActiveRes({ kind: "Azure", group: "Azure", version: "v1", namespaced: false, title: "Azure" })}
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

  if (!navStructure && !isDiscovering) {
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
            onClick={() => setActiveRes({ kind: "Azure", group: "Azure", version: "v1", namespaced: false, title: "Azure" })}
            className="bg-[#007acc] hover:bg-[#0098ff] text-white px-4 py-2 rounded transition-colors text-sm flex items-center gap-2"
          >
            <Cloud size={14} />
            Open Azure Explorer
          </button>
        </div>
      </div>
    );
  }



  console.log("Dashboard Render:", { isDiscovering, isDiscoveryError, navStructure, activeRes });

  return (
    <div className="flex h-screen bg-[#1e1e1e] text-[#cccccc] font-sans overflow-hidden">
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
        className="fixed top-0 bottom-0 left-0 z-30 flex flex-col glass-panel border-r border-white/5 transition-all duration-300 ease-in-out"
        style={{ width: sidebarWidth }}
      >
        {/* Sidebar Header */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-white/5 shrink-0 bg-white/5 backdrop-blur-sm">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20 shrink-0">
              <Layers className="text-white" size={18} />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-bold text-sm tracking-tight text-white truncate">OpsPilot</span>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                <span className="text-[10px] text-zinc-400 truncate font-medium">{currentContext || "Unknown"}</span>
              </div>
            </div>
          </div>
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
              className="w-full pl-9 pr-3 py-2 bg-zinc-900/50 border border-white/5 text-zinc-200 text-sm rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 placeholder:text-zinc-600 transition-all"
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
                await queryClient.invalidateQueries({ queryKey: ["nav_structure"] });
                window.location.reload();
              } catch (e) {
                console.error("Failed to refresh discovery:", e);
              }
            }}
            className="p-2 bg-zinc-900/50 border border-white/5 text-zinc-500 hover:text-white rounded-md hover:bg-white/10 transition-colors"
            title="Refresh Discovery Cache"
          >
            <RefreshCw size={14} />
          </button>
        </div>


        {/* Topology button removed */}

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

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Cluster"] && (
            <SidebarGroup
              title="Cluster"
              icon={Server}
              items={filteredGroupedResources["Cluster"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Cluster"]}
              onToggle={() => toggleGroup("Cluster")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Workloads"] && (
            <SidebarGroup
              title="Workloads"
              icon={PieChart}
              items={filteredGroupedResources["Workloads"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Workloads"]}
              onToggle={() => toggleGroup("Workloads")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Config"] && (
            <SidebarGroup
              title="Config"
              icon={FileCog}
              items={filteredGroupedResources["Config"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Config"]}
              onToggle={() => toggleGroup("Config")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Network"] && (
            <SidebarGroup
              title="Network"
              icon={Network}
              items={filteredGroupedResources["Network"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Network"]}
              onToggle={() => toggleGroup("Network")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Storage"] && (
            <SidebarGroup
              title="Storage"
              icon={HardDrive}
              items={filteredGroupedResources["Storage"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Storage"]}
              onToggle={() => toggleGroup("Storage")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Access Control"] && (
            <SidebarGroup
              title="Access Control"
              icon={Shield}
              items={filteredGroupedResources["Access Control"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Access Control"]}
              onToggle={() => toggleGroup("Access Control")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Crossplane"] && (
            <SidebarGroup
              title="Crossplane"
              icon={Cloud}
              items={filteredGroupedResources["Crossplane"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Crossplane"]}
              onToggle={() => toggleGroup("Crossplane")}
            />
          )}

          {/* Custom Resources Section */}
          {!navStructure || isDiscovering ? null : Object.keys(filteredGroupedResources).some(g => ["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "Crossplane"].includes(g) === false) && (
            <SidebarSection
              title="Custom Resources"
              icon={Puzzle}
              isOpen={expandedGroups["Custom Resources"]}
              onToggle={() => toggleGroup("Custom Resources")}
            >
              {/* Clearer loading label; hide once any CRD group appears */}
              {isCrdLoading && Object.keys(filteredGroupedResources).filter(g => !["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "Crossplane"].includes(g)).length === 0 && (
                <div className="px-3 py-2">
                  <Loading size={14} label="Loading Custom Resources…" />
                </div>
              )}
              {Object.keys(filteredGroupedResources)
                .filter(g => !["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "Crossplane"].includes(g))
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

        {/* User Profile / Context */}
        <div className="p-3 border-t border-gray-800 flex flex-col gap-1">
          <button
            onClick={() => setIsTerminalOpen(!isTerminalOpen)}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-base rounded-md transition-all ${isTerminalOpen ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white shadow-lg shadow-green-500/30' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <TerminalIcon size={18} />
            <span>Terminal</span>
          </button>
          <button onClick={async () => {
            console.log("Disconnect button clicked");

            // Proceed with disconnect immediately
            console.log("Calling onDisconnect...");
            onDisconnect();
            console.log("Disconnect complete");

            // Do cleanup in background (don't wait)
            setTimeout(async () => {
              try {
                console.log("Invalidating queries...");
                qc.invalidateQueries();
              } catch (e) {
                console.error("Failed to invalidate queries:", e);
              }

              try {
                console.log("Clearing discovery cache...");
                // @ts-ignore invoke from tauri
                await Promise.race([
                  invoke("clear_discovery_cache"),
                  new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1000))
                ]);
                console.log("Discovery cache cleared");
              } catch (e) {
                console.error("Failed to clear discovery cache:", e);
              }

              console.log("Broadcasting reload event...");
              window.dispatchEvent(new CustomEvent("lenskiller:reload"));
            }, 0);
          }} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-base text-gray-400 hover:text-white hover:bg-gray-800 rounded-md transition-all">
            <LogOutIcon size={18} />
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
            {/* Resize Handle */}
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
              <LocalTerminalTab />
            </div>
          </div>
        )
      }

      {/* Main Content */}
      <main
        className="flex-1 flex flex-col min-w-0 bg-[#09090b] relative transition-all duration-300 ease-in-out"
        style={{ marginLeft: sidebarWidth }}
      >
        {activeRes?.kind === "HelmReleases" ? (
          <HelmReleases />
        ) : (
          <>
            {/* Header */}
            <header className="h-14 glass-header flex items-center justify-between px-6 sticky top-0 z-20">
              <div className="flex items-center gap-4">
                {/* Breadcrumbs */}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-zinc-500 font-medium">{activeRes?.group || "Core"}</span>
                  <ChevronRight size={14} className="text-zinc-700" />
                  <span className="font-semibold text-zinc-100 tracking-tight">{activeRes?.title}</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {/* Search Input */}
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500 group-focus-within:text-cyan-400 transition-colors">
                    <Search size={14} />
                  </div>
                  <input
                    type="text"
                    placeholder="Filter resources..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-zinc-900/50 border border-white/10 text-zinc-200 text-xs rounded-full focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500/50 block w-48 pl-9 p-2 placeholder:text-zinc-600 focus:outline-none transition-all focus:w-64"
                  />
                </div>

                {/* Namespace Filter */}
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
                <HelmReleases />
              ) : activeRes ? (
                /* Gate resource list until discovery completes - it needs navStructure */
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
                /* ClusterOverview can render immediately - stats load independently */
                <ClusterOverview
                  navStructure={navStructure}
                  onNavigate={(res) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
                  vclusters={vclusters}
                  vclustersLoading={vclustersLoading}
                  vclustersFetching={vclustersFetching}
                  isDiscovering={isDiscovering}
                />
              )}
            </div>
          </>
        )}
      </main>

      {/* Tabs Bar */}
      {
        tabs.length > 0 && (
          <div className="absolute top-14 left-0 right-0 h-10 bg-gray-900 border-b border-gray-800 flex items-center px-2 gap-1 overflow-x-auto z-10" style={{ marginLeft: sidebarWidth }}>
            {/* Reload button to clear backend discovery cache and refresh */}
            <button
              onClick={async () => {
                try {
                  // Clear Tauri backend discovery cache if available
                  // @ts-ignore invoke is provided by tauri
                  await invoke("clear_discovery_cache");
                } catch (e) {
                  // no-op if command not present
                }
                // Trigger UI data reloads
                try {
                  // If using React Query, globally invalidate
                  // @ts-ignore queryClient in scope? fallback to window event
                  if (typeof queryClient !== "undefined") {
                    await queryClient.invalidateQueries();
                  }
                } catch { }
                // Fallback: emit a custom event other components can listen to
                window.dispatchEvent(new CustomEvent("lenskiller:reload"));
              }}
              className="flex items-center gap-2 px-2 py-1 rounded text-xs font-medium bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 transition-all mr-2"
              title="Reload (clear cache and refetch)"
            >
              <span className="inline-flex items-center gap-1">
                Reload
              </span>
            </button>
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-t text-xs font-medium transition-all group ${activeTabId === tab.id
                  ? 'bg-black text-white border-t-2 border-t-cyan-400'
                  : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                  }`}
              >
                <span className="truncate max-w-[120px]">{tab.resource.name}</span>
                <span
                  role="button"
                  aria-label="Close tab"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      handleCloseTab(tab.id);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>
        )
      }

      {/* Deep Dive Drawer */}
      {
        selectedObj && activeTabId && (
          <DeepDiveDrawer
            resource={selectedObj}
            kind={tabs.find(t => t.id === activeTabId)?.kind || ""}
            onClose={() => handleCloseTab(activeTabId)}
            onDelete={() => {
              setResourceToDelete(selectedObj);
              setIsDeleteModalOpen(true);
            }}
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
    </div >
  );
}




// --- Deep Dive Components ---

function DeepDiveDrawer({ resource, kind, onClose, onDelete }: { resource: K8sObject, kind: string, onClose: () => void, onDelete: () => void }) {
  const [activeTab, setActiveTab] = useState("overview");



  const [isPFOpen, setIsPFOpen] = useState(false);
  // Fetched full details (handles empty raw_json from list)
  const { data: fullObject, isLoading: detailsLoading, error: detailsError } = useQuery({
    queryKey: ["resource_details_obj", resource.namespace, resource.group, resource.version, resource.kind, resource.name],
    queryFn: async () => {
      if (resource.raw_json && resource.raw_json.trim() !== "") {
        try { return JSON.parse(resource.raw_json); } catch { /* ignore */ }
      }
      const jsonStr = await invoke<string>("get_resource_details", {
        req: {
          group: resource.group,
          version: resource.version,
          kind: resource.kind,
          namespace: resource.namespace !== "-" ? resource.namespace : null
        },
        name: resource.name
      });
      try { return JSON.parse(jsonStr); } catch { return {}; }
    },
    staleTime: 30000,
  });
  const podSpec = useMemo(() => fullObject?.spec || {}, [fullObject]);

  return (
    <aside className="w-[800px] bg-black border-l border-gray-800 flex flex-col shadow-2xl shadow-purple-500/10 z-30 transition-all duration-300 h-full absolute right-0 top-0">
      <PortForwardModal
        isOpen={isPFOpen}
        onClose={() => setIsPFOpen(false)}
        namespace={resource.namespace}
        podName={resource.name}
      />

      {/* Header */}
      <div className="h-12 border-b border-gray-800 flex items-center justify-between px-4 bg-gradient-to-r from-gray-900 to-black shrink-0">
        <div className="flex flex-col overflow-hidden">
          <h3 className="font-semibold text-white truncate text-sm">{resource.name}</h3>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">{kind}</span>
        </div>
        <div className="flex gap-2 items-center">
          {kind === "Pod" && (
            <button
              onClick={() => setIsPFOpen(true)}
              className="p-1.5 text-cyan-400 hover:bg-cyan-500/10 rounded transition-all flex items-center gap-1 border border-cyan-500/30 hover:border-cyan-500/50"
              title="Port Forward"
            >
              <Plug size={14} />
              <span className="text-xs font-medium">Forward</span>
            </button>
          )}
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-all">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 px-4 gap-4 shrink-0 bg-gray-900">
        <TabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")} icon={<Eye size={12} />} label="Overview" />
        {kind === "Pod" && <TabButton active={activeTab === "logs"} onClick={() => setActiveTab("logs")} icon={<List size={12} />} label="Logs" />}
        {kind === "Pod" && <TabButton active={activeTab === "terminal"} onClick={() => setActiveTab("terminal")} icon={<TerminalIcon size={12} />} label="Terminal" />}
        <TabButton active={activeTab === "events"} onClick={() => setActiveTab("events")} icon={<Activity size={12} />} label="Events" />
        <TabButton active={activeTab === "yaml"} onClick={() => setActiveTab("yaml")} icon={<FileCode size={12} />} label="YAML" />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 bg-black">
        {activeTab === "overview" && <OverviewTab resource={resource} fullObject={fullObject} loading={detailsLoading} error={detailsError as Error | undefined} onDelete={onDelete} />}
        {activeTab === "logs" && kind === "Pod" && <LogsTab namespace={resource.namespace} name={resource.name} podSpec={podSpec} />}
        {activeTab === "terminal" && kind === "Pod" && <TerminalTab namespace={resource.namespace} name={resource.name} podSpec={podSpec} />}
        {activeTab === "events" && <EventsTab namespace={resource.namespace} name={resource.name} uid={resource.id} />}
        {activeTab === "yaml" && <YamlTab resource={resource} />}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button
      onClick={onClick}
      className={`py-2.5 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-all ${active ? "border-cyan-400 text-white" : "border-transparent text-gray-500 hover:text-gray-300"
        }`}
    >
      {icon} {label}
    </button>
  );
}

// --- Collapsible Section Component ---
function CollapsibleSection({ title, icon, children, defaultOpen = true }: { title: string, icon: React.ReactNode, children: React.ReactNode, defaultOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="bg-gradient-to-br from-gray-900 to-black rounded-lg border border-gray-800 overflow-hidden shadow-lg">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-all"
      >
        <div className="flex items-center gap-2 text-xs font-bold text-purple-400 uppercase tracking-wider">
          {icon}
          {title}
        </div>
        {isOpen ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
      </button>
      {isOpen && (
        <div className="p-4 border-t border-gray-800">
          {children}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ resource, fullObject, loading, error, onDelete }: { resource: K8sObject, fullObject: any, loading: boolean, error?: Error, onDelete: () => void }) {
  const [llmLoading, setLlmLoading] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<
    { state: 'unknown' | 'connected' | 'unreachable' | 'model-missing'; detail?: string }
  >({ state: 'unknown' });
  const [showOllamaHelp, setShowOllamaHelp] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant' | 'tool', content: string, toolName?: string, command?: string }>>([]);
  const [userInput, setUserInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const metadata = fullObject?.metadata || {};

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (showChat && chatEndRef.current) {
      // Use scrollIntoView with block: 'nearest' to prevent page scrolling
      chatEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [chatHistory, showChat]);

  const sendMessage = async (message: string) => {
    if (!message.trim()) return;

    const newUserMessage = { role: 'user' as const, content: message };
    setChatHistory(prev => [...prev, newUserMessage]);
    setUserInput("");
    setLlmLoading(true);

    try {
      // Gather comprehensive context upfront to reduce hallucinations
      let recentEvents = '';
      try {
        const events = await invoke<any[]>("list_events", {
          namespace: resource.namespace,
          name: resource.name,
          uid: resource.id
        });
        const last10 = events.slice(0, 10);
        if (last10.length > 0) {
          recentEvents = last10.map(e =>
            `[${e.type_}] ${e.reason}: ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}`
          ).join('\n');
        }
      } catch (e) {
        recentEvents = 'Unable to fetch events';
      }

      // Build comprehensive context
      const podConditions = resource.kind === 'Pod' && fullObject?.status?.conditions
        ? fullObject.status.conditions.map((c: any) => `${c.type}=${c.status} (${c.reason || 'N/A'})${c.message ? ` "${c.message}"` : ''}`).join('\n  ')
        : '';

      const podContainerStatuses = resource.kind === 'Pod' && fullObject?.status?.containerStatuses
        ? fullObject.status.containerStatuses.map((cs: any) => {
          const state = cs.state ? Object.keys(cs.state)[0] : 'unknown';
          const stateInfo = cs.state?.[state];
          const restarts = cs.restartCount || 0;
          const resources = fullObject?.spec?.containers?.find((c: any) => c.name === cs.name)?.resources;
          const resourceStr = resources ? `\n    Requests: ${JSON.stringify(resources.requests || {})}\n    Limits: ${JSON.stringify(resources.limits || {})}` : '';
          return `  ${cs.name}:\n    State: ${state}${stateInfo?.reason ? ` (${stateInfo.reason})` : ''}${stateInfo?.exitCode !== undefined ? ` [exit ${stateInfo.exitCode}]` : ''}\n    Restarts: ${restarts}${resourceStr}`;
        }).join('\n')
        : '';

      const ownerRefs = fullObject?.metadata?.ownerReferences
        ? fullObject.metadata.ownerReferences.map((o: any) => `${o.kind}/${o.name}`).join(', ')
        : 'None';

      const labels = fullObject?.metadata?.labels
        ? Object.entries(fullObject.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ')
        : 'None';

      const context = `
Current Resource:
- Kind: ${resource.kind}
- Name: ${resource.name}
- Namespace: ${resource.namespace}
- Status: ${resource.status}
- Age: ${formatAge(resource.age)}
- Owner: ${ownerRefs}
- Labels: ${labels}
${resource.kind === 'Pod' && fullObject?.status?.phase ? `- Phase: ${fullObject.status.phase}` : ''}
${resource.kind === 'Pod' && fullObject?.status?.podIP ? `- Pod IP: ${fullObject.status.podIP}` : ''}
${resource.kind === 'Pod' && fullObject?.spec?.nodeName ? `- Node: ${fullObject.spec.nodeName}` : ''}
${podConditions ? `- Conditions:\n  ${podConditions}` : ''}
${podContainerStatuses ? `- Containers:\n${podContainerStatuses}` : ''}
${resource.kind === 'Deployment' && fullObject?.status ? `- Replicas: ${fullObject.status.replicas || 0}/${fullObject.spec?.replicas || 0} available: ${fullObject.status.availableReplicas || 0}` : ''}
${resource.kind === 'Service' && fullObject?.spec?.type ? `- Type: ${fullObject.spec.type}, ClusterIP: ${fullObject.spec.clusterIP || 'N/A'}` : ''}

Recent Events (last 10):
${recentEvents || 'No recent events'}

Available READ-ONLY debugging tools:
1. DESCRIBE - Get full YAML manifest
2. EVENTS - Get all events for this resource
3. LOGS [container_name] - Get pod logs (optionally specify container)
   **CRITICAL:** Check "Containers:" section in context above for available container names
   **IMPORTANT:** Container names must be plain text, NO brackets, quotes, or spaces
   **CORRECT:** LOGS manager (if "manager" is listed in Containers section)
   **WRONG:** LOGS [calico-node], LOGS "calico-node", LOGS calico node
   **WRONG:** Using a container name from a different pod
4. LOGS_PREVIOUS [container_name] - Get previous pod logs (for crashloops)
   **CRITICAL:** Check "Containers:" section in context above for available container names
   **IMPORTANT:** Container names must be plain text, NO brackets, quotes, or spaces
   **CORRECT:** LOGS_PREVIOUS manager (if "manager" is listed in Containers section)
   **WRONG:** LOGS_PREVIOUS [calico-node]
   **WRONG:** Using a container name from a different pod
5. RELATED_PODS - List related pods (same namespace/labels)
6. PARENT_DETAILS - Get parent resource details (owner references)
7. NETWORK_CHECK - Check service/endpoint status
8. RESOURCE_USAGE - Get current resource metrics
9. LIST_RESOURCES <kind> - List resources of type (e.g., "configmaps", "secrets")
10. DESCRIBE_ANY <kind> <name> - Describe any resource in namespace
11. NODE_INFO - Get node details if pod is scheduled
12. STORAGE_CHECK - Check PVC/PV status for pods

**All tools are read-only and safe - they only retrieve information, never modify resources.**

**CRITICAL SYNTAX RULES:**
- Container names: NO brackets [], quotes "", or apostrophes ''
- Arguments must be plain text separated by spaces
- If you see a TOOL SYNTAX ERROR, fix your syntax and try again

To use a tool, respond with: TOOL: <tool_name> [args]
You can use multiple tools - list each on a new line.
`;

      const answer = await invoke<string>("call_local_llm_with_tools", {
        prompt: `${context}\n\nUser: ${message}`,
        systemPrompt: `SYSTEM IDENTITY
You are a Distinguished Engineer and Principal SRE for Kubernetes and cloud-native systems.
You operate as an AUTONOMOUS, READ-ONLY INCIDENT INVESTIGATOR.

You do NOT wait to be told what to do.
You actively:
- Form hypotheses
- Decide what evidence you need next
- Ask for that evidence explicitly
- Refine or discard hypotheses as new data arrives
- Drive the debugging process end-to-end

You NEVER perform or suggest cluster mutations.
You ONLY analyze and reason.

------------------------------------------------
HARD SAFETY RULES (READ ONLY)
You MUST NOT:
- Generate kubectl commands that modify state (apply, patch, delete, scale, rollout, exec, cp)
- Generate YAML patches or manifests to apply
- Suggest direct mutations like "run this to fix it"
- Provide shell commands that change the cluster

You MAY:
- Suggest READ-ONLY commands the user can run to collect data
  (e.g., "You can run: kubectl get pod X -o yaml (READ ONLY)")
- Ask for outputs of describe, logs, events, metrics, etc.
- Explain how to interpret the outputs they already have

If the user explicitly asks for mutating commands:
Reply: "I am running in READ-ONLY Kubernetes analysis mode and cannot generate modifying commands."

------------------------------------------------
TOOL USAGE (AUTONOMOUS INVESTIGATION)
You have access to READ-ONLY debugging tools. Use them autonomously to drive investigation.

Available tools:
1. DESCRIBE - Get full YAML manifest
2. EVENTS - Get all events for this resource
3. LOGS [container_name] - Get pod logs (optionally specify container)
   SYNTAX: LOGS calico-node (NO brackets, quotes, or spaces)
4. LOGS_PREVIOUS [container_name] - Get previous pod logs (for crashloops)
   SYNTAX: LOGS_PREVIOUS calico-node (NO brackets, quotes, or spaces)
5. RELATED_PODS - List related pods (same namespace/labels)
6. PARENT_DETAILS - Get parent resource details (owner references)
7. NETWORK_CHECK - Check service/endpoint status
8. RESOURCE_USAGE - Get current resource metrics
9. LIST_RESOURCES <kind> - List resources of type (e.g., configmaps, secrets)
10. DESCRIBE_ANY <kind> <name> - Describe any resource in namespace
11. NODE_INFO - Get node details if pod is scheduled
12. STORAGE_CHECK - Check PVC/PV status for pods

To use a tool: TOOL: <tool_name> [args]
Multiple tools: List each on a new line

**CRITICAL TOOL RULES:**
- ALWAYS use LOGS for Pods before analyzing (shows actual behavior)
- ALWAYS use EVENTS for any resource (shows problems and activity)
- **FOR LOGS/LOGS_PREVIOUS: Check the "Containers:" section in the context FIRST**
  - The context shows available containers for THIS specific pod
  - ONLY use container names that are listed for THIS pod
  - NEVER use container names from other pods (e.g., don't use "calico-node" if it's not in the Containers list)
  - If pod has multiple containers, check logs for each one separately
- Container names must be plain text: NO [], "", or '' characters
- If you see "TOOL SYNTAX ERROR", fix your syntax and retry immediately
- IGNORE tool execution errors - focus only on actual resource data
- Never confuse tool errors with pod/resource problems

------------------------------------------------
AUTONOMOUS INVESTIGATION LOOP

You must behave like an autonomous investigator with this loop:

1. INGEST & SUMMARIZE
   - Read all provided data (YAML, logs, events, metrics, describe outputs).
   - Summarize in 2–3 precise sentences what the current situation appears to be.

2. HYPOTHESIS GENERATION
   - Generate 2–5 ranked hypotheses for what might be wrong.
   - Ground each hypothesis in specific signals:
     - container state
     - events
     - logs
     - resource status
     - scheduling info
     - probe results
   - Never say "it might be anything" — always propose concrete, testable possibilities.

3. EVIDENCE CHECK
   For each hypothesis:
   - Identify which existing evidence supports or contradicts it.
   - Mark hypotheses as STRONG, WEAK, or UNKNOWN based on current data.

4. NEXT DATA REQUEST (AUTONOMOUS)
   - Decide what data you need next to narrow down the root cause.
   - Use TOOL: commands to gather that data autonomously.
   - Be explicit and specific; do NOT be vague.

5. ITERATE
   - When new data arrives, repeat:
     - Update summary
     - Refine or discard hypotheses
     - Adjust evidence
     - Request the next most useful data via tools
   - Continue until a HIGH-confidence root cause is identified or you explicitly say it's ambiguous.

------------------------------------------------
OUTPUT FORMAT (EVERY TURN)

On EVERY response, follow this exact structure:

1. SUMMARY  
2–3 sentences describing the situation in clear, precise terms.

2. CURRENT BEST HYPOTHESES (RANKED)  
List items like:
- [#1 – STRONG] <short title>  
  - Objects: Pod X, Deployment Y, Node Z  
  - Fields: spec.containers[0].image, status.containerStatuses[0].state.waiting.reason  
  - Evidence: quote specific lines from logs/events/YAML  
- [#2 – MEDIUM] ...

3. EVIDENCE SNAPSHOT  
Bullet list of the *most important* signals you are using:
- Events: ...
- Logs: ...
- YAML: ...
- Metrics: ...

4. NEXT INVESTIGATION STEPS
If you need more evidence, use TOOL: commands to gather it.
List each tool on a new line:
TOOL: EVENTS
TOOL: LOGS container-name
TOOL: DESCRIBE

5. MISSING DATA (IF ANY)  
If you still lack key evidence after using available tools, list exactly what is missing and why it matters.

------------------------------------------------
SCOPE OF EXPERTISE

You are extremely strong at:
- Pod lifecycle (Pending, ContainerCreating, Running, CrashLoopBackOff, ImagePullBackOff, OOMKilled)
- Probes (liveness, readiness, startup)
- Networking (Services, Endpoints, DNS, CNI, Ingress, NetworkPolicy)
- Scheduling (taints/tolerations, nodeSelector, affinity, resources, quotas)
- Storage (PVC/PV, access modes, mount failures, permissions)
- Controllers (Deployment, StatefulSet, DaemonSet, Job, CronJob, HPA)
- Multi-resource relationships:
  - Service ↔ Endpoints ↔ Pod labels
  - Deployment ↔ ReplicaSet ↔ Pods
  - HPA ↔ metrics ↔ workload

You must reference explicit fields and objects when reasoning, e.g.:
- "spec.template.spec.containers[0].resources.requests.cpu"
- "status.conditions[?(@.type=='Ready')]"

------------------------------------------------
LLAMA OPTIMIZATION RULES

To perform well as a smaller local model (e.g., Llama 3.1 8B):

- Prefer short, structured bullet lists over long paragraphs.
- Avoid storytelling, metaphors, and chit-chat.
- Use consistent labels ("SUMMARY", "HYPOTHESES", "EVIDENCE", "NEXT STEPS").
- Keep your chain of reasoning shallow but precise and anchored to the inputs.
- Never invent missing fields or values.
- If something is unclear, use tools to gather more data instead of guessing.

------------------------------------------------
FINAL SAFETY RULE

If at any point you are not confident in the root cause, you MUST say:
"I cannot safely determine a single root cause yet."

Then:
- Keep multiple hypotheses open
- Use tools to gather the most powerful next piece of evidence

------------------------------------------------
IMPORTANT:
Do NOT output messages such as:
"Reached maximum analysis depth", "Investigation complete", "Stopping here", or
any other message about halting, depth, or completion.

You do NOT manage your own depth or step count.
You continue responding normally unless the USER says to stop.
There is NO investigation depth limit.
Never self-terminate.

------------------------------------------------

You are now running as an AUTONOMOUS, READ-ONLY Kubernetes Distinguished Engineer
whose job is to DRIVE the investigation, not just answer questions.`,
        conversationHistory: chatHistory.filter(m => m.role !== 'tool'),
      });
      // Mark Ollama connected on successful LLM response
      // Always mark as connected and clear prior detail
      setOllamaStatus({ state: 'connected' });

      // Enhanced tool execution with multiple tool support
      const toolMatches = answer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
      const tools = Array.from(toolMatches);

      // Validate tool names to prevent treating syntax errors as real errors
      const validTools = ['DESCRIBE', 'EVENTS', 'LOGS', 'LOGS_PREVIOUS', 'RELATED_PODS',
        'PARENT_DETAILS', 'NETWORK_CHECK', 'RESOURCE_USAGE', 'LIST_RESOURCES',
        'DESCRIBE_ANY', 'NODE_INFO', 'STORAGE_CHECK'];

      if (tools.length > 0) {
        let allToolResults: string[] = [];

        for (const toolMatch of tools) {
          const toolName = toolMatch[1];
          const toolArgs = toolMatch[2]?.trim();
          let toolResult = '';
          let kubectlCommand = '';

          // Validate tool name
          if (!validTools.includes(toolName)) {
            const errorMsg = `⚠️ **TOOL ERROR**: "${toolName}" is not a valid tool.\n\nValid tools: ${validTools.join(', ')}\n\n**This is an AI tool invocation error, NOT a pod/resource error.**`;
            setChatHistory(prev => [...prev, {
              role: 'tool',
              content: errorMsg,
              toolName: 'INVALID_TOOL',
              command: 'N/A'
            }]);
            allToolResults.push(`## INVALID TOOL: ${toolName}\n${errorMsg}`);
            continue;
          }

          try {
            // Show tool execution with kubectl equivalent
            if (toolName === 'DESCRIBE') {
              kubectlCommand = `kubectl get ${resource.kind.toLowerCase()} ${resource.name} -n ${resource.namespace} -o yaml`;
              const details = await invoke<string>("get_resource_details", {
                req: {
                  group: resource.group,
                  version: resource.version,
                  kind: resource.kind,
                  namespace: resource.namespace !== "-" ? resource.namespace : null
                },
                name: resource.name
              });
              toolResult = `\`\`\`yaml\n${details.slice(0, 3000)}\n${details.length > 3000 ? '... (truncated, use kubectl for full output)' : ''}\`\`\``;
            }
            else if (toolName === 'EVENTS') {
              kubectlCommand = `kubectl get events -n ${resource.namespace} --field-selector involvedObject.name=${resource.name}`;
              const events = await invoke<any[]>("list_events", {
                namespace: resource.namespace,
                name: resource.name,
                uid: resource.id
              });
              const warnings = events.filter(e => e.type_ === 'Warning');
              const normal = events.filter(e => e.type_ !== 'Warning');
              toolResult = `**${events.length} total events (${warnings.length} warnings)**\n\n`;
              if (warnings.length > 0) {
                toolResult += `**⚠️ Warnings:**\n${warnings.slice(0, 15).map(e =>
                  `- \`${new Date(e.age).toLocaleString()}\` **${e.reason}**: ${e.message} ${e.count > 1 ? `**(×${e.count})**` : ''}`
                ).join('\n')}\n\n`;
              }
              if (normal.length > 0) {
                toolResult += `**✓ Normal:**\n${normal.slice(0, 5).map(e =>
                  `- ${e.reason}: ${e.message}`
                ).join('\n')}`;
              }
            }
            else if (toolName === 'LOGS' && resource.kind === 'Pod') {
              // Sanitize container name - remove brackets, quotes, and extra whitespace
              let containerName = toolArgs ? toolArgs.replace(/[\[\]"']/g, '').trim() : null;

              // Validate container name
              if (containerName && (/\s/.test(containerName) || containerName.length === 0)) {
                toolResult = `❌ **TOOL SYNTAX ERROR**: Invalid container name "${toolArgs}"\n\n**Issue:** Container names cannot contain spaces or special characters like [], ", '\n\n**Correct usage:** LOGS container-name\n**Example:** LOGS calico-node\n\n**This is a TOOL SYNTAX ERROR, not a pod error.**`;
              } else {
                kubectlCommand = `kubectl logs ${resource.name} -n ${resource.namespace}${containerName ? ` -c ${containerName}` : ''} --tail=100`;
                try {
                  const logs = await invoke<string>("get_pod_logs", {
                    namespace: resource.namespace,
                    name: resource.name,
                    container: containerName,
                    tailLines: 100
                  });
                  // Sanitize logs - remove any control characters or malformed data
                  // Sanitize logs - remove any control characters or malformed data
                  const sanitizedLogs = logs.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
                  const logLines = sanitizedLogs.split('\n').filter(l => l.trim());
                  const errorLines = logLines.filter(l => /error|exception|fatal|fail/i.test(l));
                  toolResult = `**Pod Logs** (${logLines.length} lines total)${errorLines.length > 0 ? ` - **${errorLines.length} errors found**` : ' - **No errors detected**'}\n\n\`\`\`\n${sanitizedLogs.slice(-2500)}\n\`\`\``;
                } catch (err) {
                  const containerListFormatted = fullObject?.spec?.containers?.map((c: any) => `- ${c.name}`).join('\n') || 'Unknown';

                  // Check if error is about wrong container name
                  const isWrongContainer = err && err.toString().includes('is not valid for pod');

                  if (isWrongContainer) {
                    toolResult = `❌ **WRONG CONTAINER NAME**\n\n**You tried:** "${containerName}"\n**Error:** This container does not exist in THIS pod.\n\n**Available containers in THIS pod (${resource.name}):**\n${containerListFormatted}\n\n**What went wrong:**\nYou used a container name from a DIFFERENT pod. The context at the top shows the containers for THIS specific pod under "Containers:" section.\n\n**How to fix:**\nUse LOGS with one of the actual container names listed above.\nExample: LOGS ${fullObject?.spec?.containers?.[0]?.name || 'manager'}\n\n**This is NOT a pod error - you just used the wrong container name.**`;
                  } else {
                    toolResult = `❌ **Could not retrieve logs:** ${err}\n\n**Possible causes:**\n- Container not yet started\n- Container crashed before logging\n- No container named "${containerName || 'default'}"\n\n**Available containers in this pod:**\n${containerListFormatted}\n\nTry: \`${kubectlCommand}\``;
                  }
                }
              }
            }
            else if (toolName === 'LOGS_PREVIOUS' && resource.kind === 'Pod') {
              // Sanitize container name - remove brackets, quotes, and extra whitespace
              let containerName = toolArgs ? toolArgs.replace(/[\[\]"']/g, '').trim() : null;

              if (containerName && (/\s/.test(containerName) || containerName.length === 0)) {
                toolResult = `❌ **TOOL SYNTAX ERROR**: Invalid container name "${toolArgs}"\n\n**Issue:** Container names cannot contain spaces or special characters like [], ", '\n\n**Correct usage:** LOGS_PREVIOUS container-name\n**Example:** LOGS_PREVIOUS calico-node\n\n**This is a TOOL SYNTAX ERROR, not a pod error.**`;
              } else {
                kubectlCommand = `kubectl logs ${resource.name} -n ${resource.namespace}${containerName ? ` -c ${containerName}` : ''} --previous --tail=100`;
                toolResult = `**Previous logs:** Use \`${kubectlCommand}\` to check crashed container logs`;
              }
            }
            else if (toolName === 'RELATED_PODS') {
              kubectlCommand = `kubectl get pods -n ${resource.namespace}`;
              const pods = await invoke<any[]>("list_resources", {
                req: { group: "", version: "v1", kind: "Pod", namespace: resource.namespace }
              });
              const failed = pods.filter(p => p.status.includes('Error') || p.status.includes('CrashLoop'));
              toolResult = `**${pods.length} pods** ${failed.length > 0 ? `**(${failed.length} failing)**` : '**all healthy**'}\n\n${pods.slice(0, 40).map(p => {
                const icon = p.status.includes('Running') && !p.status.includes('0/') ? '✓' : p.status.includes('Error') || p.status.includes('CrashLoop') ? '❌' : '⚠️';
                return `${icon} \`${p.name}\`: ${p.status}`;
              }).join('\n')}`;
            }
            else if (toolName === 'PARENT_DETAILS') {
              const owner = fullObject?.metadata?.ownerReferences?.[0];
              if (owner) {
                kubectlCommand = `kubectl get ${owner.kind.toLowerCase()} ${owner.name} -n ${resource.namespace} -o yaml`;
                const parentDetails = await invoke<string>("get_resource_details", {
                  req: {
                    group: owner.apiVersion.split('/')[0] || '',
                    version: owner.apiVersion.split('/')[1] || owner.apiVersion,
                    kind: owner.kind,
                    namespace: resource.namespace
                  },
                  name: owner.name
                });
                toolResult = `**Parent: ${owner.kind}/${owner.name}**\n\`\`\`yaml\n${parentDetails.slice(0, 1500)}\n...\`\`\``;
              } else {
                toolResult = `No parent resource (standalone ${resource.kind})`;
              }
            }
            else if (toolName === 'NETWORK_CHECK') {
              kubectlCommand = `kubectl get svc,endpoints -n ${resource.namespace}`;
              if (resource.kind === 'Service') {
                const endpoints = await invoke<any[]>("list_resources", {
                  req: { group: "", version: "v1", kind: "Endpoints", namespace: resource.namespace }
                });
                const matchingEp = endpoints.find(ep => ep.name === resource.name);
                toolResult = `**Service:** ${fullObject?.spec?.type}, ClusterIP: ${fullObject?.spec?.clusterIP}\n**Endpoints:** ${matchingEp ? '✓ Found' : '❌ Missing (no pods match selector)'}`;
              } else if (resource.kind === 'Pod') {
                const services = await invoke<any[]>("list_resources", {
                  req: { group: "", version: "v1", kind: "Service", namespace: resource.namespace }
                });
                toolResult = `**${services.length} services** in namespace\n${services.slice(0, 10).map(s => `- ${s.name}: ${s.status}`).join('\n')}`;
              }
            }
            else if (toolName === 'RESOURCE_USAGE') {
              kubectlCommand = `kubectl top ${resource.kind.toLowerCase()} ${resource.name} -n ${resource.namespace}`;
              if (resource.kind === 'Pod' || resource.kind === 'Node') {
                const metrics = await invoke<any>("get_resource_metrics", {
                  resourceKind: resource.kind, namespace: resource.namespace, name: resource.name
                });
                toolResult = `**Current usage:**\n${metrics.map((m: any) =>
                  `- CPU: **${m.cpu}** ${m.cpu_percent ? `(${m.cpu_percent}% of limit)` : ''}\n- Memory: **${m.memory}** ${m.memory_percent ? `(${m.memory_percent}% of limit)` : ''}`
                ).join('\n')}`;
              }
            }
            else if (toolName === 'LIST_RESOURCES') {
              const kind = toolArgs || 'ConfigMap';
              // Validate kind name - catch common mistakes
              if (!kind || kind.includes(' ') || kind.includes('\n')) {
                toolResult = `❌ **Invalid syntax.** Use: LIST_RESOURCES <kind>\n\nExample: LIST_RESOURCES configmaps\n\n**This is a TOOL SYNTAX ERROR, not a resource error.**`;
              } else {
                kubectlCommand = `kubectl get ${kind.toLowerCase()} -n ${resource.namespace}`;
                try {
                  // Try with core API first
                  let resources = await invoke<any[]>("list_resources", {
                    req: { group: "", version: "v1", kind, namespace: resource.namespace }
                  }).catch(async () => {
                    // If core API fails, try to discover the resource from the current namespace
                    // This handles custom resources better
                    const allResources = await invoke<any[]>("list_resources", {
                      req: { group: resource.group, version: resource.version, kind, namespace: resource.namespace }
                    });
                    return allResources;
                  });
                  toolResult = `**${resources.length} ${kind}(s)**\n${resources.slice(0, 20).map(r => `- ${r.name}`).join('\n')}`;
                } catch (err) {
                  toolResult = `❌ **Error listing ${kind}:** ${err}\n\nThis could mean:\n- Resource type doesn't exist\n- Wrong API group/version\n- No resources of this type found\n\nTry using kubectl directly: \`${kubectlCommand}\``;
                }
              }
            }
            else if (toolName === 'DESCRIBE_ANY') {
              if (!toolArgs || !toolArgs.trim()) {
                toolResult = `❌ **Invalid syntax.** Use: DESCRIBE_ANY <kind> <name>\n\nExample: DESCRIBE_ANY configmap my-config\n\n**This is a TOOL SYNTAX ERROR, not a resource error.**`;
              } else {
                const parts = toolArgs.trim().split(/\s+/);
                if (parts.length !== 2) {
                  toolResult = `❌ **Invalid syntax.** Expected 2 arguments (kind and name), got ${parts.length}\n\nUse: DESCRIBE_ANY <kind> <name>\nExample: DESCRIBE_ANY configmap my-config\n\n**This is a TOOL SYNTAX ERROR, not a resource error.**`;
                } else {
                  const [kind, name] = parts;
                  kubectlCommand = `kubectl get ${kind.toLowerCase()} ${name} -n ${resource.namespace} -o yaml`;
                  try {
                    // Try core API first, then fallback to current resource's API group
                    const details = await invoke<string>("get_resource_details", {
                      req: { group: "", version: "v1", kind, namespace: resource.namespace },
                      name
                    }).catch(async () => {
                      // Fallback: try with the parent resource's group/version
                      return await invoke<string>("get_resource_details", {
                        req: { group: resource.group, version: resource.version, kind, namespace: resource.namespace },
                        name
                      });
                    });
                    toolResult = `**${kind}/${name}:**\n\`\`\`yaml\n${details.slice(0, 2000)}\n...\`\`\``;
                  } catch (err) {
                    toolResult = `❌ **Resource not found or inaccessible:** ${kind}/${name}\n\n**Error:** ${err}\n\n**Possible causes:**\n- Resource does not exist in namespace "${resource.namespace}"\n- Wrong resource kind name (check capitalization)\n- Insufficient permissions\n\n**This is a RESOURCE ERROR, not a tool syntax error.**\n\nTry manually: \`${kubectlCommand}\``;
                  }
                }
              }
            }
            else if (toolName === 'NODE_INFO' && resource.kind === 'Pod') {
              const nodeName = fullObject?.spec?.nodeName;
              if (nodeName) {
                kubectlCommand = `kubectl get node ${nodeName} -o yaml`;
                const nodeDetails = await invoke<string>("get_resource_details", {
                  req: { group: "", version: "v1", kind: "Node", namespace: null },
                  name: nodeName
                });
                toolResult = `**Scheduled on node:** ${nodeName}\n\`\`\`yaml\n${nodeDetails.slice(0, 1500)}\n...\`\`\``;
              } else {
                toolResult = `Pod not yet scheduled to a node`;
              }
            }
            else if (toolName === 'STORAGE_CHECK' && resource.kind === 'Pod') {
              kubectlCommand = `kubectl get pvc -n ${resource.namespace}`;
              const pvcs = await invoke<any[]>("list_resources", {
                req: { group: "", version: "v1", kind: "PersistentVolumeClaim", namespace: resource.namespace }
              });
              toolResult = `**${pvcs.length} PVCs** in namespace\n${pvcs.slice(0, 10).map(p => `- ${p.name}: ${p.status}`).join('\n')}`;
            }

            // Add tool execution to chat with kubectl command
            setChatHistory(prev => [...prev, {
              role: 'tool',
              content: toolResult,
              toolName: toolName,
              command: kubectlCommand
            }]);

            allToolResults.push(`## ${toolName}${toolArgs ? ` ${toolArgs}` : ''}\n${toolResult}`);
          } catch (toolErr) {
            const errorMsg = `⚠️ **TOOL EXECUTION ERROR (not a resource error)**\n\n**Tool:** ${toolName}\n**Error:** ${toolErr}\n\n**Note:** This error occurred while trying to execute the debugging tool, not from the Kubernetes resource itself.\n\nTry the kubectl command manually: \`${kubectlCommand || 'N/A'}\``;
            setChatHistory(prev => [...prev, {
              role: 'tool',
              content: errorMsg,
              toolName: toolName,
              command: kubectlCommand
            }]);
            allToolResults.push(`## ${toolName} - Tool Execution Error\n${errorMsg}`);
          }
        }

        // Iterative investigation loop - AI analyzes and decides if more investigation needed
        let combinedResults = allToolResults.join('\n\n---\n\n');
        let iterationCount = 0;
        const maxIterations = 3; // Prevent infinite loops

        while (iterationCount < maxIterations) {
          const analysisPrompt = iterationCount === 0
            ? `Based on these tool results, provide analysis for: "${message}"\n\n${combinedResults}`
            : `Continue investigation with these new results:\n\n${combinedResults}`;

          const analysisAnswer = await invoke<string>("call_local_llm_with_tools", {
            prompt: analysisPrompt,
            systemPrompt: `SYSTEM IDENTITY
You are a Distinguished Engineer and Principal SRE for Kubernetes and cloud-native systems.
You operate as an AUTONOMOUS, READ-ONLY INCIDENT INVESTIGATOR.

You are analyzing tool output data to refine your investigation and determine next steps.

**CRITICAL RULES:**
1. Base analysis ONLY on actual tool output data (logs, events, metrics, YAML)
2. NEVER make assumptions from YAML alone without runtime evidence
3. If logs not checked for a Pod, state: "MISSING EVIDENCE: Pod logs not retrieved"
4. If events not checked, state: "MISSING EVIDENCE: Events not retrieved"
5. **IGNORE tool execution errors** - messages marked "TOOL ERROR", "INVALID TOOL", or "TOOL SYNTAX ERROR" are debugging system issues, NOT resource problems
6. Focus ONLY on successful tool executions containing actual Kubernetes data

**SELF-CORRECTION FOR SYNTAX ERRORS:**
If you see "TOOL SYNTAX ERROR":
- You made a syntax mistake (e.g., LOGS [container] instead of LOGS container)
- Fix syntax and retry immediately using correct format
- Do NOT report syntax errors as resource problems
- Common fixes:
  - Remove brackets: LOGS [calico-node] → LOGS calico-node
  - Remove quotes: LOGS "app" → LOGS app
  - Remove spaces in resource names: LIST_RESOURCES config maps → LIST_RESOURCES configmaps

**CRITICAL: Container Name Errors**
If you see "container X is not valid for pod Y":
- You used a container name from the WRONG pod
- Check the original context's "Containers:" section for THIS pod's actual containers
- ONLY use container names listed for THIS specific pod
- Example: If context shows "Containers: manager, kube-rbac-proxy", ONLY use those names
- NEVER use "calico-node", "install-cni", etc. unless they're listed for THIS pod

**OUTPUT FORMAT (MANDATORY)**

1. SUMMARY
2–3 sentences describing the situation in clear, precise terms based on evidence.

2. CURRENT BEST HYPOTHESES (RANKED)
List items like:
- [#1 – STRONG] <short title>
  - Objects: Pod X, Deployment Y, Node Z
  - Fields: spec.containers[0].image, status.containerStatuses[0].state.waiting.reason
  - Evidence: quote specific lines from logs/events/YAML
- [#2 – MEDIUM] ...
- [#3 – WEAK] ...

3. EVIDENCE SNAPSHOT
Bullet list of the *most important* signals from tool outputs:
- Events: [quote actual event messages with timestamps]
- Logs: [quote actual log lines showing errors/behavior]
- YAML: [reference specific fields like spec.containers[0].resources.limits.memory]
- Metrics: [cite actual CPU/memory values if available]

4. NEXT INVESTIGATION STEPS
If you need more evidence to narrow down the root cause, use TOOL: commands.
List each tool on a new line with correct syntax:
TOOL: EVENTS
TOOL: LOGS container-name
TOOL: DESCRIBE

If you have sufficient evidence, provide final analysis instead.

5. MISSING DATA (IF ANY)
If tool data is insufficient even after using all relevant tools, explicitly state:
- What data is still missing
- Why it's critical for diagnosis
- Whether it's obtainable via tools or requires external access

**BEHAVIOR RULES:**
- Concise: short paragraphs, no filler
- Evidence-based: cite specific fields, log lines, event messages
- Deterministic: no speculation or hallucination
- Linear reasoning: avoid abstract metaphors
- Default to uncertainty when evidence is missing
- Reference exact fields: spec.containers[0].imagePullPolicy
- Align with K8s mechanics: pod lifecycle, probes, scheduling, CrashLoopBackOff, QoS, taints/tolerations

**AUTONOMOUS INVESTIGATION:**
- You drive the debugging process
- Form hypotheses and test them with tools
- Refine or discard hypotheses as new data arrives
- Continue requesting evidence until HIGH confidence or ambiguity is acknowledged

**FINAL RULE:**
If you cannot safely determine a single root cause yet, state:
"I cannot safely determine a single root cause yet."

Then keep multiple hypotheses open and use tools to gather the most powerful next piece of evidence.

Never generate mutative operations (apply, patch, delete, restart, scale).
If requested, respond: "I cannot generate mutative operations. I operate in READ-ONLY Kubernetes DE mode."

**IMPORTANT:**
Do NOT output messages such as:
"Reached maximum analysis depth", "Investigation complete", "Stopping here", or
any other message about halting, depth, or completion.

You do NOT manage your own depth or step count.
You continue responding normally unless the USER says to stop.
There is NO investigation depth limit.
Never self-terminate.`,
            conversationHistory: chatHistory.filter(m => m.role !== 'tool'),
          });
          // Mark Ollama connected on successful follow-up LLM response
          // Always mark as connected and clear prior detail
          setOllamaStatus({ state: 'connected' });

          // Check if AI wants to use more tools
          const nextToolMatches = analysisAnswer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
          const nextTools = Array.from(nextToolMatches);

          if (nextTools.length === 0) {
            // No more tools requested - final answer
            setChatHistory(prev => [...prev, { role: 'assistant', content: analysisAnswer }]);
            break;
          }

          // AI wants to investigate more - show reasoning
          const reasoningPart = analysisAnswer.split('TOOL:')[0].trim();
          if (reasoningPart) {
            setChatHistory(prev => [...prev, {
              role: 'assistant',
              content: reasoningPart + '\n\n*🔄 Continuing investigation...*'
            }]);
          }

          // Execute next round of tools
          const newToolResults: string[] = [];
          for (const toolMatch of nextTools) {
            const toolName = toolMatch[1];
            const toolArgs = toolMatch[2]?.trim();
            let toolResult = '';
            let kubectlCommand = '';

            // Validate tool name in iteration
            if (!validTools.includes(toolName)) {
              const errorMsg = `⚠️ **TOOL ERROR**: "${toolName}" is not a valid tool.\n\nValid tools: ${validTools.join(', ')}\n\n**This is an AI tool invocation error, NOT a pod/resource error.**`;
              setChatHistory(prev => [...prev, {
                role: 'tool',
                content: errorMsg,
                toolName: 'INVALID_TOOL',
                command: 'N/A'
              }]);
              newToolResults.push(`## INVALID TOOL: ${toolName}\n${errorMsg}`);
              continue;
            }

            try {
              // Execute all available tools in iteration
              if (toolName === 'DESCRIBE') {
                kubectlCommand = `kubectl get ${resource.kind.toLowerCase()} ${resource.name} -n ${resource.namespace} -o yaml`;
                const details = await invoke<string>("get_resource_details", {
                  req: { group: resource.group, version: resource.version, kind: resource.kind, namespace: resource.namespace !== "-" ? resource.namespace : null },
                  name: resource.name
                });
                toolResult = `\`\`\`yaml\n${details.slice(0, 3000)}\n${details.length > 3000 ? '... (truncated, use kubectl for full output)' : ''}\`\`\``;
              }
              else if (toolName === 'EVENTS') {
                kubectlCommand = `kubectl get events -n ${resource.namespace} --field-selector involvedObject.name=${resource.name}`;
                const events = await invoke<any[]>("list_events", { namespace: resource.namespace, name: resource.name, uid: resource.id });
                const warnings = events.filter(e => e.type_ === 'Warning');
                const normal = events.filter(e => e.type_ !== 'Warning');
                toolResult = `**${events.length} total events (${warnings.length} warnings)**\n\n`;
                if (warnings.length > 0) {
                  toolResult += `**⚠️ Warnings:**\n${warnings.slice(0, 15).map(e =>
                    `- \`${new Date(e.age).toLocaleString()}\` **${e.reason}**: ${e.message} ${e.count > 1 ? `**(×${e.count})**` : ''}`
                  ).join('\n')}\n\n`;
                }
                if (normal.length > 0) {
                  toolResult += `**✓ Normal:**\n${normal.slice(0, 5).map(e => `- ${e.reason}: ${e.message}`).join('\n')}`;
                }
              }
              else if (toolName === 'LOGS' && resource.kind === 'Pod') {
                // Sanitize container name - remove brackets, quotes, and extra whitespace
                let containerName = toolArgs ? toolArgs.replace(/[\[\]"']/g, '').trim() : null;

                if (containerName && (/\s/.test(containerName) || containerName.length === 0)) {
                  toolResult = `❌ **TOOL SYNTAX ERROR**: Invalid container name "${toolArgs}"\n\n**Issue:** Container names cannot contain spaces or special characters like [], ", '\n\n**Correct usage:** LOGS container-name\n**Example:** LOGS calico-node\n\n**This is a TOOL SYNTAX ERROR, not a pod error.**`;
                } else {
                  kubectlCommand = `kubectl logs ${resource.name} -n ${resource.namespace}${containerName ? ` -c ${containerName}` : ''} --tail=100`;
                  try {
                    const logs = await invoke<string>("get_pod_logs", { namespace: resource.namespace, name: resource.name, container: containerName, tailLines: 100 });
                    const sanitizedLogs = logs.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
                    const logLines = sanitizedLogs.split('\n').filter(l => l.trim());
                    const errorLines = logLines.filter(l => /error|exception|fatal|fail/i.test(l));
                    toolResult = `**Pod Logs** (${logLines.length} lines total)${errorLines.length > 0 ? ` - **${errorLines.length} errors found**` : ' - **No errors detected**'}\n\n\`\`\`\n${sanitizedLogs.slice(-2500)}\n\`\`\``;
                  } catch (err) {
                    const containerListFormatted = fullObject?.spec?.containers?.map((c: any) => `- ${c.name}`).join('\n') || 'Unknown';
                    const isWrongContainer = err && err.toString().includes('is not valid for pod');

                    if (isWrongContainer) {
                      toolResult = `❌ **WRONG CONTAINER NAME**\n\n**You tried:** "${containerName}"\n**Error:** This container does not exist in THIS pod.\n\n**Available containers in THIS pod (${resource.name}):**\n${containerListFormatted}\n\n**What went wrong:**\nYou used a container name from a DIFFERENT pod. The context at the top shows the containers for THIS specific pod under "Containers:" section.\n\n**How to fix:**\nUse LOGS with one of the actual container names listed above.\nExample: LOGS ${fullObject?.spec?.containers?.[0]?.name || 'manager'}\n\n**This is NOT a pod error - you just used the wrong container name.**`;
                    } else {
                      toolResult = `❌ **Could not retrieve logs:** ${err}\n\n**Available containers in this pod:**\n${containerListFormatted}\n\nTry: \`${kubectlCommand}\``;
                    }
                  }
                }
              }
              else if (toolName === 'LOGS_PREVIOUS' && resource.kind === 'Pod') {
                // Sanitize container name - remove brackets, quotes, and extra whitespace
                let containerName = toolArgs ? toolArgs.replace(/[\[\]"']/g, '').trim() : null;

                if (containerName && (/\s/.test(containerName) || containerName.length === 0)) {
                  toolResult = `❌ **TOOL SYNTAX ERROR**: Invalid container name "${toolArgs}"\n\n**Issue:** Container names cannot contain spaces or special characters like [], ", '\n\n**Correct usage:** LOGS_PREVIOUS container-name\n**Example:** LOGS_PREVIOUS calico-node\n\n**This is a TOOL SYNTAX ERROR, not a pod error.**`;
                } else {
                  kubectlCommand = `kubectl logs ${resource.name} -n ${resource.namespace}${containerName ? ` -c ${containerName}` : ''} --previous --tail=100`;
                  toolResult = `**Previous logs:** Use \`${kubectlCommand}\` to check crashed container logs`;
                }
              }
              else if (toolName === 'RELATED_PODS') {
                kubectlCommand = `kubectl get pods -n ${resource.namespace}`;
                try {
                  const pods = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "Pod", namespace: resource.namespace } });
                  const failed = pods.filter(p => p.status.includes('Error') || p.status.includes('CrashLoop'));
                  toolResult = `**${pods.length} pods** ${failed.length > 0 ? `**(${failed.length} failing)**` : '**all healthy**'}\n\n${pods.slice(0, 40).map(p => {
                    const icon = p.status.includes('Running') && !p.status.includes('0/') ? '✓' : p.status.includes('Error') || p.status.includes('CrashLoop') ? '❌' : '⚠️';
                    return `${icon} \`${p.name}\`: ${p.status}`;
                  }).join('\n')}`;
                } catch (err) {
                  toolResult = `❌ **Error listing pods:** ${err}`;
                }
              }
              else if (toolName === 'PARENT_DETAILS') {
                const owner = fullObject?.metadata?.ownerReferences?.[0];
                if (owner) {
                  kubectlCommand = `kubectl get ${owner.kind.toLowerCase()} ${owner.name} -n ${resource.namespace} -o yaml`;
                  const parentDetails = await invoke<string>("get_resource_details", {
                    req: { group: owner.apiVersion.split('/')[0] || '', version: owner.apiVersion.split('/')[1] || owner.apiVersion, kind: owner.kind, namespace: resource.namespace },
                    name: owner.name
                  });
                  toolResult = `**Parent: ${owner.kind}/${owner.name}**\n\`\`\`yaml\n${parentDetails.slice(0, 1500)}\n...\`\`\``;
                } else {
                  toolResult = `No parent resource (standalone ${resource.kind})`;
                }
              }
              else if (toolName === 'NETWORK_CHECK') {
                kubectlCommand = `kubectl get svc,endpoints -n ${resource.namespace}`;
                if (resource.kind === 'Service') {
                  const endpoints = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "Endpoints", namespace: resource.namespace } });
                  const matchingEp = endpoints.find(ep => ep.name === resource.name);
                  toolResult = `**Service:** ${fullObject?.spec?.type}, ClusterIP: ${fullObject?.spec?.clusterIP}\n**Endpoints:** ${matchingEp ? '✓ Found' : '❌ Missing (no pods match selector)'}`;
                } else if (resource.kind === 'Pod') {
                  const services = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "Service", namespace: resource.namespace } });
                  toolResult = `**${services.length} services** in namespace\n${services.slice(0, 10).map(s => `- ${s.name}: ${s.status}`).join('\n')}`;
                }
              }
              else if (toolName === 'RESOURCE_USAGE') {
                kubectlCommand = `kubectl top ${resource.kind.toLowerCase()} ${resource.name} -n ${resource.namespace}`;
                if (resource.kind === 'Pod' || resource.kind === 'Node') {
                  const metrics = await invoke<any>("get_resource_metrics", { resourceKind: resource.kind, namespace: resource.namespace, name: resource.name });
                  toolResult = `**Current usage:**\n${metrics.map((m: any) => `- CPU: **${m.cpu}** ${m.cpu_percent ? `(${m.cpu_percent}% of limit)` : ''}\n- Memory: **${m.memory}** ${m.memory_percent ? `(${m.memory_percent}% of limit)` : ''}`).join('\n')}`;
                }
              }
              else if (toolName === 'LIST_RESOURCES') {
                const kind = toolArgs || 'ConfigMap';
                kubectlCommand = `kubectl get ${kind.toLowerCase()} -n ${resource.namespace}`;
                try {
                  let resources = await invoke<any[]>("list_resources", {
                    req: { group: "", version: "v1", kind, namespace: resource.namespace }
                  }).catch(async () => {
                    return await invoke<any[]>("list_resources", {
                      req: { group: resource.group, version: resource.version, kind, namespace: resource.namespace }
                    });
                  });
                  toolResult = `**${resources.length} ${kind}(s)**\n${resources.slice(0, 20).map(r => `- ${r.name}`).join('\n')}`;
                } catch (err) {
                  toolResult = `❌ **Error listing ${kind}:** ${err}\n\nTry using kubectl directly: \`${kubectlCommand}\``;
                }
              }
              else if (toolName === 'DESCRIBE_ANY') {
                const [kind, name] = (toolArgs || '').split(' ');
                if (kind && name) {
                  kubectlCommand = `kubectl get ${kind.toLowerCase()} ${name} -n ${resource.namespace} -o yaml`;
                  try {
                    const details = await invoke<string>("get_resource_details", {
                      req: { group: "", version: "v1", kind, namespace: resource.namespace },
                      name
                    }).catch(async () => {
                      return await invoke<string>("get_resource_details", {
                        req: { group: resource.group, version: resource.version, kind, namespace: resource.namespace },
                        name
                      });
                    });
                    toolResult = `**${kind}/${name}:**\n\`\`\`yaml\n${details.slice(0, 2000)}\n...\`\`\``;
                  } catch (err) {
                    toolResult = `❌ **Error describing ${kind}/${name}:** ${err}\n\n**Possible issues:**\n- Resource does not exist\n- Wrong resource kind name\n- Insufficient permissions\n\nTry: \`${kubectlCommand}\``;
                  }
                } else {
                  toolResult = `❌ **Invalid syntax.** Use: DESCRIBE_ANY <kind> <name>\n\nExample: DESCRIBE_ANY configmap my-config`;
                }
              }
              else if (toolName === 'NODE_INFO' && resource.kind === 'Pod') {
                const nodeName = fullObject?.spec?.nodeName;
                if (nodeName) {
                  kubectlCommand = `kubectl get node ${nodeName} -o yaml`;
                  const nodeDetails = await invoke<string>("get_resource_details", { req: { group: "", version: "v1", kind: "Node", namespace: null }, name: nodeName });
                  toolResult = `**Scheduled on node:** ${nodeName}\n\`\`\`yaml\n${nodeDetails.slice(0, 1500)}\n...\`\`\``;
                } else {
                  toolResult = `Pod not yet scheduled to a node`;
                }
              }
              else if (toolName === 'STORAGE_CHECK' && resource.kind === 'Pod') {
                kubectlCommand = `kubectl get pvc -n ${resource.namespace}`;
                const pvcs = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "PersistentVolumeClaim", namespace: resource.namespace } });
                toolResult = `**${pvcs.length} PVCs** in namespace\n${pvcs.slice(0, 10).map(p => `- ${p.name}: ${p.status}`).join('\n')}`;
              }
              else {
                toolResult = `Tool ${toolName} not available in iteration mode`;
              }

              setChatHistory(prev => [...prev, {
                role: 'tool',
                content: toolResult,
                toolName: toolName,
                command: kubectlCommand
              }]);

              newToolResults.push(`## ${toolName}${toolArgs ? ` ${toolArgs}` : ''}\n${toolResult}`);
            } catch (toolErr) {
              const errorMsg = `⚠️ **TOOL EXECUTION ERROR (not a resource error)**\n\n**Tool:** ${toolName}\n**Error:** ${toolErr}\n\n**Note:** This error occurred while trying to execute the debugging tool, not from the Kubernetes resource itself.\n\nTry the kubectl command manually: \`${kubectlCommand || 'N/A'}\``;
              setChatHistory(prev => [...prev, { role: 'tool', content: errorMsg, toolName: toolName, command: kubectlCommand }]);
              newToolResults.push(`## ${toolName} - Tool Execution Error\n${errorMsg}`);
            }
          }

          combinedResults = newToolResults.join('\n\n---\n\n');
          iterationCount++;
        }

        // Don't add any "investigation complete" messages - let AI continue naturally
      } else {
        setChatHistory(prev => [...prev, { role: 'assistant', content: answer }]);
      }
    } catch (err) {
      const msg = (err as any)?.toString?.() || String(err);
      const isOllamaNotRunning = /ECONNREFUSED|connection refused|connect ECONNREFUSED|Failed to connect|fetch failed|NetworkError/i.test(msg);
      const isModelMissing = /model not found|no model|unknown model|could not find model|pull the model/i.test(msg);
      if (isOllamaNotRunning) {
        setOllamaStatus({ state: 'unreachable', detail: msg });
        const helpful = `⚠️ Ollama is not running or unreachable.

What this means: The local LLM server couldn’t be reached to process your request.

How to fix (READ ONLY guidance):
- Start Ollama and ensure the service is running locally.
- Verify the model is installed and available.

You can start Ollama and then retry your request.`;
        setChatHistory(prev => [...prev, { role: 'assistant', content: helpful }]);
      } else if (isModelMissing) {
        setOllamaStatus({ state: 'model-missing', detail: msg });
        const helpful = `⚠️ No model found in Ollama.

What this means: The requested model isn’t installed or available.

How to fix (READ ONLY guidance):
- Ensure the configured model exists locally (e.g., llama3.1:8b).
- Pull or select an available model in your Ollama setup.

After the model is available, retry your request.`;
        setChatHistory(prev => [...prev, { role: 'assistant', content: helpful }]);
      } else {
        setChatHistory(prev => [...prev, { role: 'assistant', content: `Error: ${msg}` }]);
      }
    } finally {
      setLlmLoading(false);
    }
  };

  const quickAnalysis = async () => {
    await sendMessage("Analyze this resource and explain its current status, any potential issues, and recommendations.");
  };

  // Events summary (warnings vs total) - lightweight query
  const { data: eventsSummary } = useQuery({
    queryKey: ["overview_events", resource.namespace, resource.kind, resource.name],
    queryFn: async () => {
      try {
        const evs = await invoke<any[]>("list_events", { namespace: resource.namespace, name: resource.name, uid: resource.id });
        const warnings = evs.filter(e => e.type_ === 'Warning').length;
        return { total: evs.length, warnings, recent: evs.slice(0, 5) };
      } catch { return { total: 0, warnings: 0, recent: [] }; }
    },
    staleTime: 10000,
  });

  const showMetrics = resource.kind === "Pod" || resource.kind === "Node";

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loading size={24} label="Loading" /></div>;
  }
  if (error) {
    return <div className="text-red-400 text-xs bg-red-500/10 p-4 rounded border border-red-500/30">Failed to load resource details: {error.message}</div>;
  }

  return (
    <div className="space-y-4">
      {/* AI Chat Button */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowChat(!showChat)}
          className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white text-xs flex items-center gap-2 shadow-sm"
        >
          {showChat ? '✕ Close AI Chat' : '🤖 AI Chat'}
        </button>
        {!showChat && chatHistory.length > 0 && (
          <span className="text-xs text-[#858585]">{chatHistory.filter(m => m.role === 'assistant').length} messages</span>
        )}
      </div>

      {/* AI Chat Panel */}
      {showChat && (
        <div className="bg-[#252526] border border-purple-500/30 rounded overflow-hidden flex flex-col h-[500px]">
          <div className="flex items-center justify-between px-4 py-2 bg-[#1e1e1e] border-b border-purple-500/30 flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-purple-400 text-xs font-semibold">🤖 AI Assistant</span>
              {/* Ollama Status Badge */}
              <button
                type="button"
                onClick={() => setShowOllamaHelp(v => !v)}
                className={`text-[10px] px-2 py-0.5 rounded border ${ollamaStatus.state === 'connected'
                  ? 'bg-green-100 text-green-700 border-green-300'
                  : ollamaStatus.state === 'model-missing'
                    ? 'bg-yellow-100 text-yellow-700 border-yellow-300'
                    : ollamaStatus.state === 'unreachable'
                      ? 'bg-red-100 text-red-700 border-red-300'
                      : 'bg-gray-100 text-gray-700 border-gray-300'
                  }`}
                title="Ollama status"
              >
                {ollamaStatus.state === 'connected' && 'Ollama: Connected'}
                {ollamaStatus.state === 'model-missing' && 'Ollama: Model Missing'}
                {ollamaStatus.state === 'unreachable' && 'Ollama: Unreachable'}
                {ollamaStatus.state === 'unknown' && 'Ollama: Unknown'}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={quickAnalysis}
                disabled={llmLoading}
                className="text-xs text-purple-400 hover:text-purple-300 disabled:text-purple-600"
              >
                Quick Analysis
              </button>
              <button
                onClick={() => setChatHistory([])}
                className="text-xs text-[#858585] hover:text-white"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Ollama Help Drawer */}
          {showOllamaHelp && (
            <div className="px-4 py-2 bg-[#111] border-b border-purple-500/20 text-[11px] text-[#cccccc]">
              <div className="font-semibold mb-1">Ollama Setup (macOS)</div>
              <div className="mb-1">Install/start and pull a model:</div>
              <pre className="bg-[#0d1117] border border-[#3e3e42] rounded p-2 overflow-auto text-[10px] text-[#cccccc]">
                brew install ollama
                ollama serve
                ollama pull llama3.1:8b
              </pre>
              <div className="mt-2">Alternative installer:</div>
              <pre className="bg-[#0d1117] border border-[#3e3e42] rounded p-2 overflow-auto text-[10px] text-[#cccccc]">
                curl -fsSL https://ollama.com/install.sh | sh
              </pre>
              <div className="mt-2">Verify installation and models:</div>
              <pre className="bg-[#0d1117] border border-[#3e3e42] rounded p-2 overflow-auto text-[10px] text-[#cccccc]">
                ollama list
                ollama run llama3.1:8b
              </pre>
              <div className="mt-2 text-[#858585]">Status: {ollamaStatus.state} {ollamaStatus.detail ? `– ${ollamaStatus.detail}` : ''}</div>
            </div>
          )}

          {/* Chat Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
            {chatHistory.length === 0 && (
              <div className="text-center text-[#858585] text-xs py-8">
                <div className="text-2xl mb-2">🤖</div>
                <div className="font-semibold mb-1">AI Kubernetes Debugging Assistant</div>
                Ask me anything about this {resource.kind}!<br />
                <div className="text-[10px] mt-2 space-y-1">
                  <div>💡 "Why is this pod failing?"</div>
                  <div>💡 "Check the logs for errors"</div>
                  <div>💡 "Compare with other pods in this namespace"</div>
                </div>
              </div>
            )}
            {chatHistory.map((msg, i) => (
              <div key={i}>
                {msg.role === 'user' && (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded px-3 py-2 text-xs bg-purple-600 text-white">
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    </div>
                  </div>
                )}

                {msg.role === 'tool' && (
                  <div className="flex justify-start">
                    <div className="max-w-[90%] rounded border border-cyan-500/30 bg-[#1e1e1e] overflow-hidden">
                      {/* Tool header */}
                      <div className="bg-cyan-900/20 px-3 py-1.5 border-b border-cyan-500/30 flex items-center gap-2">
                        <span className="text-cyan-400 text-[10px] font-mono font-semibold">🔧 {msg.toolName}</span>
                      </div>
                      {/* Kubectl command */}
                      {msg.command && (
                        <div className="bg-[#0d1117] px-3 py-1.5 border-b border-cyan-500/20">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[#858585] text-[9px] uppercase tracking-wider">kubectl equivalent</span>
                          </div>
                          <code className="text-[10px] text-cyan-300 font-mono select-all">{msg.command}</code>
                        </div>
                      )}
                      {/* Tool result */}
                      <div className="px-3 py-2">
                        <div
                          className="text-[11px] text-[#cccccc] leading-relaxed prose prose-invert prose-sm max-w-none [&_h2]:text-xs [&_h2]:text-white [&_h2]:font-bold [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:first:mt-0 [&_h3]:text-[11px] [&_h3]:text-white [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:ml-4 [&_ul]:my-1 [&_ul]:space-y-0.5 [&_ul]:text-[10px] [&_li]:text-[#cccccc] [&_p]:my-1 [&_p]:text-[10px] [&_code]:bg-[#2d2d30] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-cyan-300 [&_code]:text-[9px] [&_pre]:bg-[#0d1117] [&_pre]:p-2 [&_pre]:rounded [&_pre]:border [&_pre]:border-[#3e3e42] [&_pre]:my-1.5 [&_pre]:text-[9px] [&_pre]:max-h-40 [&_pre]:overflow-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[#cccccc] [&_strong]:text-white [&_strong]:font-semibold"
                          dangerouslySetInnerHTML={{
                            __html: msg.content
                              .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
                              .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                              .replace(/\*(.+?)\*/g, '<em>$1</em>')
                              .replace(/`([^`]+)`/g, '<code>$1</code>')
                              .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                              .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                              .replace(/^- (.+)$/gm, '<li>$1</li>')
                              .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
                              .replace(/```(\w+)?\n([\s\S]+?)```/g, '<pre><code>$2</code></pre>')
                              .replace(/\n\n/g, '</p><p>')
                              .replace(/^(?!<[hul>]|<p>)(.+)$/gm, '<p>$1</p>')
                              .replace(/<p><\/p>/g, '')
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {msg.role === 'assistant' && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded px-3 py-2 text-xs bg-[#1e1e1e] border border-[#3e3e42] text-[#cccccc]">
                      <div
                        className="prose prose-invert prose-sm max-w-none [&_h1]:text-sm [&_h1]:text-white [&_h1]:font-bold [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:first:mt-0 [&_h2]:text-xs [&_h2]:text-white [&_h2]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-2 [&_h3]:text-xs [&_h3]:text-white [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:ml-4 [&_ul]:my-1.5 [&_ul]:space-y-0.5 [&_ol]:list-decimal [&_ol]:ml-4 [&_ol]:my-1.5 [&_ol]:space-y-0.5 [&_li]:text-[#cccccc] [&_li]:text-[11px] [&_p]:my-1.5 [&_p]:text-[11px] [&_p]:leading-relaxed [&_code]:bg-[#2d2d30] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[#ce9178] [&_code]:text-[10px] [&_pre]:bg-[#0d1117] [&_pre]:p-2.5 [&_pre]:rounded [&_pre]:border [&_pre]:border-[#3e3e42] [&_pre]:my-2 [&_pre]:text-[10px] [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[#cccccc] [&_strong]:text-white [&_strong]:font-semibold [&_em]:italic [&_em]:text-purple-300"
                        dangerouslySetInnerHTML={{
                          __html: msg.content
                            .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
                            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                            .replace(/\*(.+?)\*/g, '<em>$1</em>')
                            .replace(/`([^`]+)`/g, '<code>$1</code>')
                            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                            .replace(/^# (.+)$/gm, '<h1>$1</h1>')
                            .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
                            .replace(/^- (.+)$/gm, '<li>$1</li>')
                            .replace(/(<li>.*<\/li>\n?)+/g, (match) => {
                              return match.includes('<li>1.') ? `<ol>${match}</ol>` : `<ul>${match}</ul>`;
                            })
                            .replace(/```(\w+)?\n([\s\S]+?)```/g, '<pre><code>$2</code></pre>')
                            .replace(/\n\n/g, '</p><p>')
                            .replace(/^(?!<[hul>]|<p>)(.+)$/gm, '<p>$1</p>')
                            .replace(/<p><\/p>/g, '')
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
            {llmLoading && (
              <div className="flex justify-start">
                <div className="bg-[#1e1e1e] border border-[#3e3e42] rounded px-3 py-2 text-xs text-[#cccccc] flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin text-purple-400" />
                  <span>Analyzing...</span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-purple-500/30 p-3 bg-[#1e1e1e] flex-shrink-0">
            <form onSubmit={(e) => { e.preventDefault(); sendMessage(userInput); }} className="flex gap-2">
              <input
                type="text"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                disabled={llmLoading}
                placeholder="Ask about this resource..."
                className="flex-1 bg-[#252526] border border-[#3e3e42] rounded px-3 py-1.5 text-xs text-white placeholder-[#858585] focus:outline-none focus:border-purple-500/50 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={llmLoading || !userInput.trim()}
                className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:opacity-50 text-white text-xs"
              >
                Send
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Metadata Card */}
      <CollapsibleSection title="Metadata" icon={<Settings size={14} />}>
        <div className="grid grid-cols-2 gap-y-4 gap-x-6 text-sm">
          <div>
            <span className="block text-[#858585] text-xs mb-1">Namespace</span>
            <span className="text-[#cccccc] font-medium">{resource.namespace}</span>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-1">Age</span>
            <span className="text-[#cccccc] font-medium">{formatAge(resource.age)}</span>
          </div>
          <div className="col-span-2">
            <span className="block text-[#858585] text-xs mb-1">UID</span>
            <span className="text-[#858585] text-xs font-mono bg-[#1e1e1e] px-2 py-1 rounded border border-[#3e3e42] inline-block select-all">
              {resource.id}
            </span>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-1">API Group</span>
            <span className="text-[#cccccc] font-medium">{resource.group || 'core'}</span>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-1">Version</span>
            <span className="text-[#cccccc] font-medium">{resource.version}</span>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-1">Status</span>
            <StatusBadge status={resource.status} />
          </div>
        </div>
      </CollapsibleSection>

      {/* Crossplane Details */}
      {(resource.group.includes('crossplane.io') || resource.group.includes('upbound.io')) && (
        <CollapsibleSection title="Crossplane Details" icon={<Cloud size={14} />}>
          <div className="space-y-6">
            {/* Conditions Table */}
            {fullObject?.status?.conditions && (
              <div>
                <span className="block text-[#858585] text-xs mb-2 font-medium uppercase tracking-wider">Conditions</span>
                <div className="bg-[#1e1e1e] rounded border border-[#3e3e42] overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#252526] text-[#858585] font-medium border-b border-[#3e3e42]">
                      <tr>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Reason</th>
                        <th className="px-3 py-2">Message</th>
                        <th className="px-3 py-2">Last Transition</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#3e3e42]">
                      {fullObject.status.conditions.map((c: any, i: number) => (
                        <tr key={i} className="hover:bg-[#2d2d30]">
                          <td className="px-3 py-2 font-medium text-white">{c.type}</td>
                          <td className="px-3 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${c.status === 'True' ? 'bg-green-500/20 text-green-400' :
                              c.status === 'False' ? 'bg-red-500/20 text-red-400' :
                                'bg-gray-500/20 text-gray-400'
                              }`}>
                              {c.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-[#cccccc]">{c.reason}</td>
                          <td className="px-3 py-2 text-[#858585] max-w-[200px] truncate" title={c.message}>{c.message}</td>
                          <td className="px-3 py-2 text-[#858585] whitespace-nowrap">{formatAge(c.lastTransitionTime)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Provider Config Ref */}
            {fullObject?.spec?.providerConfigRef && (
              <div>
                <span className="block text-[#858585] text-xs mb-1 font-medium uppercase tracking-wider">Provider Config</span>
                <div className="flex items-center gap-2 text-sm text-[#cccccc]">
                  <span className="font-mono bg-[#1e1e1e] px-2 py-1 rounded border border-[#3e3e42]">
                    {fullObject.spec.providerConfigRef.name}
                  </span>
                </div>
              </div>
            )}

            {/* Connection Secret */}
            {fullObject?.spec?.writeConnectionSecretToRef && (
              <div>
                <span className="block text-[#858585] text-xs mb-1 font-medium uppercase tracking-wider">Connection Secret</span>
                <div className="flex items-center gap-2 text-sm text-[#cccccc]">
                  <span className="text-[#858585]">Secret:</span>
                  <span className="font-mono bg-[#1e1e1e] px-2 py-1 rounded border border-[#3e3e42]">
                    {fullObject.spec.writeConnectionSecretToRef.name}
                  </span>
                  <span className="text-[#858585] ml-2">Namespace:</span>
                  <span className="font-mono bg-[#1e1e1e] px-2 py-1 rounded border border-[#3e3e42]">
                    {fullObject.spec.writeConnectionSecretToRef.namespace}
                  </span>
                </div>
              </div>
            )}

            {/* Connection Details */}
            {fullObject?.status?.connectionDetails && (
              <div>
                <span className="block text-[#858585] text-xs mb-1 font-medium uppercase tracking-wider">Published Connection Details</span>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(fullObject.status.connectionDetails).map(key => (
                    <span key={key} className="px-2 py-1 bg-purple-500/10 text-purple-400 text-xs rounded border border-purple-500/20 font-mono">
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* Resource Metrics */}
      {showMetrics && (
        <CollapsibleSection title="Resource Metrics" icon={<Activity size={14} />}>
          <MetricsChart resourceKind={resource.kind} namespace={resource.namespace} name={resource.name} />
        </CollapsibleSection>
      )}

      {/* Labels & Annotations */}
      <CollapsibleSection title="Labels & Annotations" icon={<Tags size={14} />}>
        <div className="space-y-4">
          <div>
            <span className="block text-[#858585] text-xs mb-2">Labels</span>
            <div className="flex flex-wrap gap-1.5">
              {metadata.labels ? Object.entries(metadata.labels).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-[#007acc]/10 text-[#007acc] text-xs rounded border border-[#007acc]/20 font-mono">
                  {k}={String(v)}
                </span>
              )) : <span className="text-[#858585] text-sm italic">No labels</span>}
            </div>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-2">Annotations</span>
            <div className="flex flex-col gap-1">
              {metadata.annotations ? Object.entries(metadata.annotations).map(([k, v]) => (
                <div key={k} className="text-xs font-mono text-[#cccccc] break-all">
                  <span className="text-[#858585]">{k}:</span> {String(v)}
                </div>
              )) : <span className="text-[#858585] text-sm italic">No annotations</span>}
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* Recent Events */}
      {eventsSummary && (
        <CollapsibleSection title="Recent Events" icon={<Activity size={14} />}>
          <div className="flex items-center gap-4 text-xs mb-3">
            <span className="px-2 py-0.5 rounded bg-[#3e3e42] text-[#cccccc]">Total: {eventsSummary.total}</span>
            <span className="px-2 py-0.5 rounded bg-[#cca700]/15 text-[#cca700]">Warnings: {eventsSummary.warnings}</span>
          </div>
          <div className="space-y-1.5">
            {eventsSummary.recent.length === 0 && <span className="text-[#858585] text-xs italic">No recent events</span>}
            {eventsSummary.recent.map((e: any, i: number) => (
              <div key={i} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2 flex gap-2 items-start">
                <div className={`w-1.5 h-1.5 rounded-full mt-1 ${e.type_ === 'Warning' ? 'bg-[#cca700]' : 'bg-[#89d185]'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline">
                    <span className="font-mono text-[11px] text-[#cccccc] truncate" title={e.reason}>{e.reason}</span>
                    <span className="text-[10px] text-[#858585]" title={e.age}>{new Date(e.age).toLocaleTimeString()}</span>
                  </div>
                  <span className="text-[11px] text-[#858585] break-all" title={e.message}>{e.message}</span>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Owner References */}
      {Array.isArray(metadata.ownerReferences) && metadata.ownerReferences.length > 0 && (
        <CollapsibleSection title="Owner References" icon={<FileCog size={14} />}>
          <div className="space-y-2 text-xs">
            {metadata.ownerReferences.map((o: any, i: number) => (
              <div key={i} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2 flex flex-col gap-1">
                <div className="flex flex-wrap gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-[#007acc]/10 text-[#007acc] font-mono">{o.kind}</span>
                  <span className="px-1.5 py-0.5 rounded bg-[#3e3e42] text-[#cccccc] font-mono">{o.name}</span>
                  {o.controller && <span className="px-1.5 py-0.5 rounded bg-[#89d185]/10 text-[#89d185] font-mono">controller</span>}
                  {o.blockOwnerDeletion && <span className="px-1.5 py-0.5 rounded bg-[#cca700]/10 text-[#cca700] font-mono">blockDeletion</span>}
                </div>
                <div className="text-[#858585] break-all font-mono">uid: {o.uid}</div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Finalizers */}
      {Array.isArray(metadata.finalizers) && metadata.finalizers.length > 0 && (
        <CollapsibleSection title="Finalizers" icon={<Shield size={14} />}>
          <div className="flex flex-wrap gap-1.5">
            {metadata.finalizers.map((f: string) => (
              <span key={f} className="px-2 py-1 bg-[#252526] border border-[#3e3e42] rounded text-[11px] font-mono text-[#cccccc]">{f}</span>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Conditions */}
      {Array.isArray(fullObject?.status?.conditions) && fullObject.status.conditions.length > 0 && (
        <CollapsibleSection title="Conditions" icon={<Activity size={14} />}>
          <div className="space-y-2">
            {fullObject.status.conditions.map((c: any, i: number) => (
              <div key={i} className="grid grid-cols-[1fr_0.7fr_0.6fr_1.4fr] gap-3 text-xs items-center bg-[#1e1e1e] border border-[#3e3e42] rounded p-2">
                <span className="font-mono text-[#cccccc] truncate" title={c.type}>{c.type}</span>
                <span className={`font-medium ${c.status === 'True' ? 'text-[#89d185]' : c.status === 'False' ? 'text-[#f48771]' : 'text-[#cca700]'}`}>{c.status}</span>
                <span className="text-[#858585] font-mono" title={c.lastTransitionTime}>{c.lastTransitionTime?.split('T')[0]}</span>
                <span className="text-[#858585] truncate" title={c.message || c.reason}>{c.reason || c.message || '-'}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Spec Summary (Kind Specific) */}
      <KindSpecSection kind={resource.kind} fullObject={fullObject} />

      {/* Raw Status */}
      {fullObject?.status && (
        <CollapsibleSection title="Raw Status" icon={<FileCode size={14} />}>
          <pre className="max-h-64 overflow-auto text-[11px] leading-relaxed bg-[#1e1e1e] p-3 rounded border border-[#3e3e42] font-mono text-[#cccccc]">
            {JSON.stringify(fullObject.status, null, 2)}
          </pre>
        </CollapsibleSection>
      )}

      {/* Delete Resource */}
      <div className="pt-4 border-t border-gray-800 mt-6">
        <button
          onClick={onDelete}
          className="w-full px-4 py-3 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all flex items-center justify-center gap-2 font-medium shadow-lg shadow-red-500/20 hover:shadow-red-500/30"
        >
          <Trash2 size={16} />
          Delete Resource
        </button>
      </div>
    </div>
  );
}

// --- Kind Specific Spec Section ---
function KindSpecSection({ kind, fullObject }: { kind: string, fullObject: any }) {
  const k = kind.toLowerCase();
  const spec = fullObject?.spec || {};
  const status = fullObject?.status || {};

  // Helpers
  const renderKV = (obj: any) => obj ? Object.entries(obj).map(([k, v]) => (
    <div key={k} className="flex justify-between gap-4"><span className="text-[#858585] font-mono text-[11px]">{k}</span><span className="text-[#cccccc] font-mono text-[11px] break-all">{String(v)}</span></div>
  )) : <span className="text-[#858585] italic text-xs">None</span>;

  if (k === 'pod') {
    const containers = spec.containers || [];
    const initContainers = spec.initContainers || [];
    const cStatuses: Record<string, any> = {};
    (status.containerStatuses || []).forEach((cs: any) => { cStatuses[cs.name] = cs; });
    const volumes = spec.volumes || [];
    const metadata = fullObject?.metadata || {};
    const [activeContainer, setActiveContainer] = useState<string>(containers[0]?.name || "");
    useEffect(() => {
      if (containers.length > 0 && !containers.find((c: any) => c.name === activeContainer)) {
        setActiveContainer(containers[0].name);
      }
    }, [containers, activeContainer]);
    // Matching services (query all services; lightweight summary)
    const { data: svcList } = useQuery({
      queryKey: ["pod_matching_services"],
      queryFn: async () => {
        try {
          const svcs = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "Service", namespace: null } });
          return svcs.map(s => s.name).slice(0, 50); // limit names
        } catch { return []; }
      },
      staleTime: 60000,
    });
    const [matchedServices, setMatchedServices] = useState<string[]>([]);
    useEffect(() => {
      (async () => {
        if (!svcList || svcList.length === 0 || !metadata.labels) { setMatchedServices([]); return; }
        const labels = metadata.labels;
        const matches: string[] = [];
        // Fetch each service detail to inspect selector (limit 20 to avoid spam)
        for (const name of svcList.slice(0, 20)) {
          try {
            const jsonStr = await invoke<string>("get_resource_details", { req: { group: "", version: "v1", kind: "Service", namespace: null }, name });
            const obj = JSON.parse(jsonStr);
            const selector = obj?.spec?.selector || {};
            const isMatch = selector && Object.entries(selector).every(([k, v]) => labels[k] === v);
            if (isMatch) matches.push(name);
          } catch { /* ignore */ }
        }
        setMatchedServices(matches);
      })();
    }, [svcList, metadata.labels]);
    // Calculate QoS class
    const getQoSClass = () => {
      const allContainers = [...containers, ...initContainers];
      if (allContainers.length === 0) return 'BestEffort';

      let allGuaranteed = true;
      let anyRequestOrLimit = false;

      for (const c of allContainers) {
        const requests = c.resources?.requests || {};
        const limits = c.resources?.limits || {};

        const hasCpuRequest = !!requests.cpu;
        const hasMemRequest = !!requests.memory;
        const hasCpuLimit = !!limits.cpu;
        const hasMemLimit = !!limits.memory;

        if (hasCpuRequest || hasMemRequest || hasCpuLimit || hasMemLimit) {
          anyRequestOrLimit = true;
        }

        // For Guaranteed: must have both CPU and memory limits equal to requests
        if (!(hasCpuLimit && hasMemLimit && hasCpuRequest && hasMemRequest &&
              requests.cpu === limits.cpu && requests.memory === limits.memory)) {
          allGuaranteed = false;
        }
      }

      if (!anyRequestOrLimit) return 'BestEffort';
      if (allGuaranteed) return 'Guaranteed';
      return 'Burstable';
    };

    const qosClass = status?.qosClass || getQoSClass();
    const securityContext = spec?.securityContext || {};
    const dnsPolicy = spec?.dnsPolicy || 'ClusterFirst';
    const priorityClassName = spec?.priorityClassName;
    const priority = spec?.priority;

    return (
      <CollapsibleSection title="Pod Details" icon={<Layers size={14} />}>
        <div className="space-y-6">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div><span className="block text-[#858585] mb-1">Node</span><span className="font-mono text-[#cccccc]">{status?.hostIP || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Pod IP</span><span className="font-mono text-[#cccccc]">{status?.podIP || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">ServiceAccount</span><span className="font-mono text-[#cccccc]">{spec?.serviceAccountName || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Restart Policy</span><span className="font-mono text-[#cccccc]">{spec?.restartPolicy || '-'}</span></div>
            <div>
              <span className="block text-[#858585] mb-1">QoS Class</span>
              <span className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${
                qosClass === 'Guaranteed' ? 'bg-[#89d185]/10 text-[#89d185]' :
                qosClass === 'Burstable' ? 'bg-[#cca700]/10 text-[#cca700]' :
                'bg-[#858585]/10 text-[#858585]'
              }`}>{qosClass}</span>
            </div>
            <div><span className="block text-[#858585] mb-1">DNS Policy</span><span className="font-mono text-[#cccccc]">{dnsPolicy}</span></div>
            {priorityClassName && (
              <div><span className="block text-[#858585] mb-1">Priority Class</span><span className="font-mono text-[#cccccc]">{priorityClassName}</span></div>
            )}
            {priority !== undefined && (
              <div><span className="block text-[#858585] mb-1">Priority</span><span className="font-mono text-[#cccccc]">{priority}</span></div>
            )}
          </div>

          {/* Security Context */}
          {Object.keys(securityContext).length > 0 && (
            <div className="space-y-2">
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Security Context</h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {securityContext.runAsUser !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">runAsUser:</span>
                    <span className="font-mono text-[#cccccc]">{securityContext.runAsUser}</span>
                  </div>
                )}
                {securityContext.runAsGroup !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">runAsGroup:</span>
                    <span className="font-mono text-[#cccccc]">{securityContext.runAsGroup}</span>
                  </div>
                )}
                {securityContext.fsGroup !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">fsGroup:</span>
                    <span className="font-mono text-[#cccccc]">{securityContext.fsGroup}</span>
                  </div>
                )}
                {securityContext.runAsNonRoot !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">runAsNonRoot:</span>
                    <span className={`font-mono ${securityContext.runAsNonRoot ? 'text-[#89d185]' : 'text-[#f48771]'}`}>
                      {String(securityContext.runAsNonRoot)}
                    </span>
                  </div>
                )}
                {securityContext.readOnlyRootFilesystem !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">readOnlyRootFilesystem:</span>
                    <span className={`font-mono ${securityContext.readOnlyRootFilesystem ? 'text-[#89d185]' : 'text-[#cca700]'}`}>
                      {String(securityContext.readOnlyRootFilesystem)}
                    </span>
                  </div>
                )}
                {securityContext.seccompProfile && (
                  <div className="flex items-center gap-2 col-span-2">
                    <span className="text-[#858585]">seccompProfile:</span>
                    <span className="font-mono text-[#cccccc]">{securityContext.seccompProfile.type}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Scheduling */}
          {(spec.nodeSelector || spec.tolerations) && (
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="block text-[#858585] mb-1">Node Selector</span>
                <div className="flex flex-wrap gap-1">
                  {spec.nodeSelector ? Object.entries(spec.nodeSelector).map(([k, v]) => (
                    <span key={k} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{k}={String(v)}</span>
                  )) : <span className="text-[#858585] text-[11px] italic">None</span>}
                </div>
              </div>
              <div>
                <span className="block text-[#858585] mb-1">Tolerations</span>
                <div className="flex flex-wrap gap-1">
                  {Array.isArray(spec.tolerations) && spec.tolerations.length > 0 ? spec.tolerations.map((t: any, i: number) => (
                    <span key={i} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={JSON.stringify(t)}>{t.key || '*'}:{t.operator || ''}:{t.effect || ''}</span>
                  )) : <span className="text-[#858585] text-[11px] italic">None</span>}
                </div>
              </div>
            </div>
          )}

          {/* Containers (single selection) */}
          <div className="space-y-3">
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Containers</h4>
            <div className="flex flex-wrap gap-1">
              {containers.map((c: any) => {
                const st = cStatuses[c.name];
                const running = st?.state?.running;
                return (
                  <button
                    key={c.name}
                    onClick={() => setActiveContainer(c.name)}
                    className={`px-2 py-1 rounded text-[11px] font-mono border flex items-center gap-1 transition-colors ${activeContainer === c.name ? 'bg-[#007acc] border-[#007acc] text-white' : 'bg-[#252526] border-[#3e3e42] text-[#cccccc] hover:border-[#007acc]/50'}`}
                    title={c.image}
                  >
                    <span>{c.name}</span>
                    {running && <span className="w-1.5 h-1.5 rounded-full bg-[#89d185]" />}
                  </button>
                );
              })}
              {containers.length === 0 && <span className="text-[#858585] text-xs italic">No containers</span>}
            </div>
            {initContainers.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {initContainers.map((c: any) => (
                  <span key={c.name} className="px-2 py-1 rounded text-[10px] font-mono bg-[#3e3e42] text-[#cccccc]" title={c.image}>init:{c.name}</span>
                ))}
              </div>
            )}
            {/* Active container details */}
            {activeContainer && (() => {
              const c = containers.find((x: any) => x.name === activeContainer);
              if (!c) return <span className="text-[#858585] text-xs italic">Container not found</span>;
              const st = cStatuses[c.name];
              let state = '-';
              if (st?.state?.running) state = 'Running'; else if (st?.state?.waiting) state = 'Waiting:' + (st.state.waiting.reason || ''); else if (st?.state?.terminated) state = 'Terminated:' + (st.state.terminated.reason || '');
              return (
                <div className="border border-[#3e3e42] rounded p-3 bg-[#1e1e1e] space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-1.5 py-0.5 bg-[#007acc]/10 text-[#007acc] rounded text-[11px] font-mono">{c.name}</span>
                    <span className="px-1.5 py-0.5 bg-[#3e3e42] text-[#cccccc] rounded text-[11px] font-mono" title={c.image}>{c.image?.split('@')[0]}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${state.startsWith('Running') ? 'bg-[#89d185]/10 text-[#89d185]' : state.startsWith('Waiting') ? 'bg-[#cca700]/10 text-[#cca700]' : state.startsWith('Terminated') ? 'bg-[#f48771]/10 text-[#f48771]' : 'bg-[#858585]/10 text-[#858585]'}`}>{state}</span>
                    {st && <span className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[11px] font-mono">Restarts:{st.restartCount}</span>}
                  </div>
                  {(c.resources?.requests || c.resources?.limits) && (
                    <div className="grid grid-cols-2 gap-4 text-[11px]">
                      <div>
                        <span className="text-[#858585]">Requests</span>
                        <div className="mt-1 space-y-0.5">{renderKV(c.resources.requests)}</div>
                      </div>
                      <div>
                        <span className="text-[#858585]">Limits</span>
                        <div className="mt-1 space-y-0.5">{renderKV(c.resources.limits)}</div>
                      </div>
                    </div>
                  )}
                  {Array.isArray(c.ports) && c.ports.length > 0 && (
                    <div className="text-[11px]"><span className="text-[#858585]">Ports:</span> {c.ports.map((p: any) => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', ')}</div>
                  )}
                  {Array.isArray(c.env) && c.env.length > 0 && (
                    <div className="text-[11px]">
                      <span className="text-[#858585]">Env:</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {c.env.slice(0, 60).map((e: any) => (
                          <span key={e.name + (e.value || '')} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={e.value || e.valueFrom ? JSON.stringify(e.valueFrom || e.value) : ''}>{e.name}{e.value ? `=${e.value}` : ''}</span>
                        ))}
                        {c.env.length > 60 && <span className="text-[10px] text-[#858585]">+{c.env.length - 60} more</span>}
                      </div>
                    </div>
                  )}
                  {Array.isArray(c.volumeMounts) && c.volumeMounts.length > 0 && (
                    <div className="text-[11px]">
                      <span className="text-[#858585]">Mounts:</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {c.volumeMounts.map((m: any) => (
                          <span key={m.name + m.mountPath} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={m.mountPath}>{m.name}:{m.mountPath}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {(c.livenessProbe || c.readinessProbe || c.startupProbe) && (
                    <div className="text-[11px] space-y-1">
                      <span className="text-[#858585]">Probes:</span>
                      {['livenessProbe', 'readinessProbe', 'startupProbe'].map((pk) => {
                        const probe: any = (c as any)[pk];
                        if (!probe) return null;
                        const type = probe.httpGet ? 'HTTP' : probe.tcpSocket ? 'TCP' : probe.exec ? 'Exec' : 'Unknown';
                        const detail = probe.httpGet ? `${probe.httpGet.path || '/'}:${probe.httpGet.port}` : probe.tcpSocket ? probe.tcpSocket.port : probe.exec ? (probe.exec.command || []).join(' ') : '';
                        return (
                          <div key={pk} className="flex flex-wrap items-center gap-2">
                            <span className="px-1 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{pk.replace('Probe', '')}</span>
                            <span className="px-1 py-0.5 bg-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{type}</span>
                            <span className="px-1 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={detail}>{detail || '-'}</span>
                            {typeof probe.initialDelaySeconds === 'number' && <span className="text-[#858585]">delay:{probe.initialDelaySeconds}s</span>}
                            {typeof probe.periodSeconds === 'number' && <span className="text-[#858585]">period:{probe.periodSeconds}s</span>}
                            {typeof probe.timeoutSeconds === 'number' && <span className="text-[#858585]">timeout:{probe.timeoutSeconds}s</span>}
                            {typeof probe.failureThreshold === 'number' && <span className="text-[#f48771]">fail:{probe.failureThreshold}</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Volumes */}
          <div className="space-y-2">
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Volumes</h4>
            <div className="flex flex-wrap gap-1.5">
              {volumes.map((v: any, i: number) => {
                const type = Object.keys(v).find(k => k !== 'name') || 'unknown';
                return (
                  <span key={i} className="px-2 py-1 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={JSON.stringify(v[type] || {})}>{v.name}:{type}</span>
                );
              })}
              {volumes.length === 0 && <span className="text-[#858585] text-xs italic">No volumes</span>}
            </div>
          </div>
          {/* Matching Services */}
          <div className="space-y-1">
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Matching Services</h4>
            <div className="flex flex-wrap gap-1">
              {matchedServices.length > 0 ? matchedServices.map(n => (
                <span key={n} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={n}>{n}</span>
              )) : <span className="text-[#858585] text-xs italic">None</span>}
            </div>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'deployment') {
    const replicas = spec.replicas ?? 1;
    const strategy = spec.strategy?.type || 'RollingUpdate';
    const rollingUpdate = spec.strategy?.rollingUpdate;
    const selector = spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ') : '-';
    const tplContainers = spec.template?.spec?.containers || [];
    const initContainers = spec.template?.spec?.initContainers || [];

    // Status info
    const readyReplicas = status.readyReplicas || 0;
    const availableReplicas = status.availableReplicas || 0;
    const updatedReplicas = status.updatedReplicas || 0;
    const unavailableReplicas = status.unavailableReplicas || 0;
    const conditions = status.conditions || [];

    // Determine rollout status
    const getRolloutStatus = () => {
      if (unavailableReplicas > 0) return { status: 'Progressing', color: 'text-yellow-400', bg: 'bg-yellow-500/20' };
      if (updatedReplicas < replicas) return { status: 'Updating', color: 'text-blue-400', bg: 'bg-blue-500/20' };
      if (readyReplicas === replicas && availableReplicas === replicas) return { status: 'Complete', color: 'text-green-400', bg: 'bg-green-500/20' };
      if (readyReplicas < replicas) return { status: 'Scaling', color: 'text-orange-400', bg: 'bg-orange-500/20' };
      return { status: 'Unknown', color: 'text-[#858585]', bg: 'bg-[#3e3e42]' };
    };
    const rolloutStatus = getRolloutStatus();

    // Calculate resource totals
    const getResourceTotals = () => {
      let cpuRequest = 0, cpuLimit = 0, memRequest = 0, memLimit = 0;
      tplContainers.forEach((c: any) => {
        const req = c.resources?.requests || {};
        const lim = c.resources?.limits || {};
        if (req.cpu) cpuRequest += parseCpu(req.cpu);
        if (lim.cpu) cpuLimit += parseCpu(lim.cpu);
        if (req.memory) memRequest += parseMemory(req.memory);
        if (lim.memory) memLimit += parseMemory(lim.memory);
      });
      return { cpuRequest, cpuLimit, memRequest, memLimit };
    };
    const parseCpu = (cpu: string) => {
      if (cpu.endsWith('m')) return parseInt(cpu) / 1000;
      return parseFloat(cpu);
    };
    const parseMemory = (mem: string) => {
      const num = parseFloat(mem);
      if (mem.endsWith('Ki')) return num * 1024;
      if (mem.endsWith('Mi')) return num * 1024 * 1024;
      if (mem.endsWith('Gi')) return num * 1024 * 1024 * 1024;
      if (mem.endsWith('Ti')) return num * 1024 * 1024 * 1024 * 1024;
      return num;
    };
    const formatMemory = (bytes: number) => {
      if (bytes === 0) return '-';
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ki`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} Mi`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} Gi`;
    };
    const resources = getResourceTotals();

    return (
      <CollapsibleSection title="Deployment Spec" icon={<Package size={14} />}>
        <div className="space-y-4 text-xs">
          {/* Rollout Status */}
          <div className="flex flex-wrap gap-3">
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Rollout: </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] ${rolloutStatus.bg} ${rolloutStatus.color}`}>{rolloutStatus.status}</span>
            </div>
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Strategy: </span>
              <span className="font-mono text-[#cccccc]">{strategy}</span>
              {rollingUpdate && (
                <span className="text-[#585858] ml-1">
                  (max surge: {rollingUpdate.maxSurge || '25%'}, max unavail: {rollingUpdate.maxUnavailable || '25%'})
                </span>
              )}
            </div>
          </div>

          {/* Replica Status */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Replica Status</h4>
            <div className="grid grid-cols-4 gap-2">
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded text-center">
                <div className="text-lg font-mono text-[#cccccc]">{replicas}</div>
                <div className="text-[9px] text-[#858585]">Desired</div>
              </div>
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded text-center">
                <div className={`text-lg font-mono ${readyReplicas === replicas ? 'text-green-400' : 'text-yellow-400'}`}>{readyReplicas}</div>
                <div className="text-[9px] text-[#858585]">Ready</div>
              </div>
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded text-center">
                <div className={`text-lg font-mono ${updatedReplicas === replicas ? 'text-green-400' : 'text-blue-400'}`}>{updatedReplicas}</div>
                <div className="text-[9px] text-[#858585]">Updated</div>
              </div>
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded text-center">
                <div className={`text-lg font-mono ${availableReplicas === replicas ? 'text-green-400' : 'text-orange-400'}`}>{availableReplicas}</div>
                <div className="text-[9px] text-[#858585]">Available</div>
              </div>
            </div>
            {/* Progress bar */}
            <div className="mt-2 h-1.5 bg-[#3e3e42] rounded overflow-hidden">
              <div
                className={`h-full transition-all ${readyReplicas === replicas ? 'bg-green-500' : 'bg-yellow-500'}`}
                style={{ width: `${(readyReplicas / replicas) * 100}%` }}
              />
            </div>
          </div>

          {/* Conditions */}
          {conditions.length > 0 && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Conditions</h4>
              <div className="flex flex-wrap gap-2">
                {conditions.map((cond: any, i: number) => {
                  const isTrue = cond.status === 'True';
                  return (
                    <div key={i} className="px-2 py-1 bg-[#1e1e1e] border border-[#3e3e42] rounded flex items-center gap-1.5" title={cond.message || cond.reason}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isTrue ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="text-[10px] text-[#cccccc]">{cond.type}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Resource Totals (per replica) */}
          {(resources.cpuRequest > 0 || resources.memRequest > 0) && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Resources Per Replica</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">CPU</div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#858585]">Request:</span>
                    <span className="font-mono text-cyan-400">{resources.cpuRequest > 0 ? `${(resources.cpuRequest * 1000).toFixed(0)}m` : '-'}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#858585]">Limit:</span>
                    <span className="font-mono text-orange-400">{resources.cpuLimit > 0 ? `${(resources.cpuLimit * 1000).toFixed(0)}m` : '-'}</span>
                  </div>
                </div>
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">Memory</div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#858585]">Request:</span>
                    <span className="font-mono text-cyan-400">{formatMemory(resources.memRequest)}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#858585]">Limit:</span>
                    <span className="font-mono text-orange-400">{formatMemory(resources.memLimit)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Selector */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Selector</h4>
            <div className="flex flex-wrap gap-1">
              {spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => (
                <span key={k} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{k}={String(v)}</span>
              )) : <span className="text-[#858585] italic">None</span>}
            </div>
          </div>

          {/* Template Containers */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Containers ({tplContainers.length})</h4>
            <div className="space-y-1.5">
              {tplContainers.map((c: any, i: number) => (
                <div key={i} className="px-2 py-1.5 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] text-[#cccccc] font-bold">{c.name}</span>
                    <div className="flex items-center gap-1">
                      {c.ports?.map((p: any, pi: number) => (
                        <span key={pi} className="px-1 py-0.5 bg-[#3e3e42] rounded text-[9px] text-[#858585]">{p.containerPort}/{p.protocol || 'TCP'}</span>
                      ))}
                    </div>
                  </div>
                  <div className="text-[9px] text-[#585858] truncate mt-0.5" title={c.image}>{c.image}</div>
                </div>
              ))}
              {tplContainers.length === 0 && <span className="text-[#858585] italic">No containers</span>}
            </div>
          </div>

          {/* Init Containers */}
          {initContainers.length > 0 && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Init Containers ({initContainers.length})</h4>
              <div className="flex flex-wrap gap-1.5">
                {initContainers.map((c: any, i: number) => (
                  <span key={i} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-purple-400" title={c.image}>{c.name}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'replicaset') {
    const replicas = spec.replicas;
    const selector = spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ') : '-';
    const tplContainers = spec.template?.spec?.containers || [];
    return (
      <CollapsibleSection title="ReplicaSet Spec" icon={<Package size={14} />}>
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-4">
            <div><span className="block text-[#858585] mb-1">Desired Replicas</span><span className="font-mono text-[#cccccc]">{replicas ?? '-'}</span></div>
            <div className="col-span-2"><span className="block text-[#858585] mb-1">Selector</span><span className="font-mono text-[#cccccc] break-all">{selector}</span></div>
          </div>
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Template Containers</h4>
            <div className="flex flex-wrap gap-1.5">
              {tplContainers.map((c: any, i: number) => (
                <span key={i} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={c.image}>{c.name}</span>
              ))}
              {tplContainers.length === 0 && <span className="text-[#858585] italic">No containers</span>}
            </div>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'service') {
    const ports = spec.ports || [];
    const serviceType = spec.type || 'ClusterIP';
    const sessionAffinity = spec.sessionAffinity || 'None';
    const loadBalancerIP = spec.loadBalancerIP;
    const loadBalancerStatus = status.loadBalancer || {};
    const externalTrafficPolicy = spec.externalTrafficPolicy;
    const internalTrafficPolicy = spec.internalTrafficPolicy;
    const healthCheckNodePort = spec.healthCheckNodePort;

    // Service type colors
    const getServiceTypeInfo = (type: string) => {
      switch (type) {
        case 'LoadBalancer': return { color: 'text-green-400', bg: 'bg-green-500/20' };
        case 'NodePort': return { color: 'text-blue-400', bg: 'bg-blue-500/20' };
        case 'ExternalName': return { color: 'text-purple-400', bg: 'bg-purple-500/20' };
        case 'ClusterIP': return { color: 'text-cyan-400', bg: 'bg-cyan-500/20' };
        default: return { color: 'text-[#858585]', bg: 'bg-[#3e3e42]' };
      }
    };
    const typeInfo = getServiceTypeInfo(serviceType);

    // Get load balancer ingress IPs
    const lbIngress = loadBalancerStatus.ingress || [];

    return (
      <CollapsibleSection title="Service Spec" icon={<Network size={14} />}>
        <div className="space-y-4 text-xs">
          {/* Service Type Badge & Stats */}
          <div className="flex flex-wrap gap-3">
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Type: </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] ${typeInfo.bg} ${typeInfo.color}`}>{serviceType}</span>
            </div>
            {sessionAffinity !== 'None' && (
              <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
                <span className="text-[#858585]">Session Affinity: </span>
                <span className="font-mono text-orange-400">{sessionAffinity}</span>
              </div>
            )}
            {externalTrafficPolicy && (
              <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
                <span className="text-[#858585]">External Traffic: </span>
                <span className={`font-mono ${externalTrafficPolicy === 'Local' ? 'text-yellow-400' : 'text-[#cccccc]'}`}>{externalTrafficPolicy}</span>
              </div>
            )}
          </div>

          {/* IP Addresses */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">IP Addresses</h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                <div className="text-[9px] text-[#858585] mb-1">Cluster IP</div>
                <div className="font-mono text-[11px] text-cyan-400">{spec.clusterIP === 'None' ? <span className="text-[#858585] italic">Headless</span> : spec.clusterIP || '-'}</div>
              </div>
              {serviceType === 'LoadBalancer' && (
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">Load Balancer IP</div>
                  {lbIngress.length > 0 ? (
                    <div className="space-y-0.5">
                      {lbIngress.map((ing: any, i: number) => (
                        <div key={i} className="font-mono text-[11px] text-green-400">{ing.ip || ing.hostname || '-'}</div>
                      ))}
                    </div>
                  ) : loadBalancerIP ? (
                    <div className="font-mono text-[11px] text-yellow-400">{loadBalancerIP} <span className="text-[9px] text-[#585858]">(pending)</span></div>
                  ) : (
                    <div className="text-[#858585] italic text-[11px]">Pending...</div>
                  )}
                </div>
              )}
              {serviceType === 'ExternalName' && spec.externalName && (
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">External Name</div>
                  <div className="font-mono text-[11px] text-purple-400 break-all">{spec.externalName}</div>
                </div>
              )}
              {spec.externalIPs && spec.externalIPs.length > 0 && (
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">External IPs</div>
                  <div className="font-mono text-[11px] text-orange-400">{spec.externalIPs.join(', ')}</div>
                </div>
              )}
            </div>
          </div>

          {/* Ports */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Ports ({ports.length})</h4>
            {ports.length === 0 ? (
              <span className="text-[#858585] italic">No ports</span>
            ) : (
              <div className="space-y-1.5">
                {ports.map((p: any, i: number) => (
                  <div key={i} className="px-2 py-1.5 bg-[#1e1e1e] border border-[#3e3e42] rounded flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {p.name && <span className="font-mono text-[10px] text-[#cccccc] font-bold">{p.name}</span>}
                      <span className="px-1.5 py-0.5 bg-[#3e3e42] rounded text-[9px] text-[#858585]">{p.protocol || 'TCP'}</span>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[10px]">
                      <span className="text-cyan-400">{p.port}</span>
                      <span className="text-[#585858]">→</span>
                      <span className="text-green-400">{p.targetPort || p.port}</span>
                      {p.nodePort && (
                        <>
                          <span className="text-[#585858]">:</span>
                          <span className="text-orange-400">{p.nodePort}</span>
                          <span className="text-[9px] text-[#585858]">(node)</span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Selector */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Selector</h4>
            <div className="flex flex-wrap gap-1">
              {spec.selector ? Object.entries(spec.selector).map(([k, v]) => (
                <span key={k} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{k}={String(v)}</span>
              )) : <span className="text-[#858585] italic text-xs">None (headless or external)</span>}
            </div>
          </div>

          {/* Additional Info */}
          {(healthCheckNodePort || internalTrafficPolicy) && (
            <div className="flex flex-wrap gap-3 text-[10px]">
              {healthCheckNodePort && (
                <div className="px-2 py-1 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <span className="text-[#858585]">Health Check Port: </span>
                  <span className="font-mono text-[#cccccc]">{healthCheckNodePort}</span>
                </div>
              )}
              {internalTrafficPolicy && (
                <div className="px-2 py-1 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <span className="text-[#858585]">Internal Traffic: </span>
                  <span className="font-mono text-[#cccccc]">{internalTrafficPolicy}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'node') {
    const capacity = status.capacity || {};
    const alloc = status.allocatable || {};
    const addresses = status.addresses || [];
    const taints = spec.taints || [];
    const conditions = status.conditions || [];
    const nodeInfo = status.nodeInfo || {};

    // Parse CPU and memory for percentage calculation
    const parseCpu = (val: string) => {
      if (!val) return 0;
      if (val.endsWith('m')) return parseInt(val) / 1000;
      if (val.endsWith('n')) return parseInt(val) / 1000000000;
      return parseFloat(val);
    };
    const parseMem = (val: string) => {
      if (!val) return 0;
      const units: Record<string, number> = { Ki: 1024, Mi: 1024**2, Gi: 1024**3, Ti: 1024**4, K: 1000, M: 1000**2, G: 1000**3, T: 1000**4 };
      for (const [suffix, mult] of Object.entries(units)) {
        if (val.endsWith(suffix)) return parseInt(val) * mult;
      }
      return parseInt(val);
    };

    const cpuCapacity = parseCpu(capacity.cpu);
    const cpuAllocatable = parseCpu(alloc.cpu);
    const memCapacity = parseMem(capacity.memory);
    const memAllocatable = parseMem(alloc.memory);
    const podsCapacity = parseInt(capacity.pods) || 0;
    const podsAllocatable = parseInt(alloc.pods) || 0;

    const cpuReservedPct = cpuCapacity > 0 ? Math.round(((cpuCapacity - cpuAllocatable) / cpuCapacity) * 100) : 0;
    const memReservedPct = memCapacity > 0 ? Math.round(((memCapacity - memAllocatable) / memCapacity) * 100) : 0;

    // Get condition statuses
    const getConditionStatus = (type: string) => {
      const cond = conditions.find((c: any) => c.type === type);
      return cond ? { status: cond.status, message: cond.message } : null;
    };

    const ready = getConditionStatus('Ready');
    const memPressure = getConditionStatus('MemoryPressure');
    const diskPressure = getConditionStatus('DiskPressure');
    const pidPressure = getConditionStatus('PIDPressure');
    const networkUnavail = getConditionStatus('NetworkUnavailable');

    return (
      <CollapsibleSection title="Node Info" icon={<Server size={14} />}>
        <div className="space-y-4 text-xs">
          {/* System Info */}
          <div className="grid grid-cols-2 gap-4">
            <div><span className="block text-[#858585] mb-1">OS Image</span><span className="font-mono text-[#cccccc] break-all">{nodeInfo.osImage || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Kubelet</span><span className="font-mono text-[#cccccc]">{nodeInfo.kubeletVersion || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Container Runtime</span><span className="font-mono text-[#cccccc]">{nodeInfo.containerRuntimeVersion || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Kernel</span><span className="font-mono text-[#cccccc]">{nodeInfo.kernelVersion || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Architecture</span><span className="font-mono text-[#cccccc]">{nodeInfo.architecture || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Machine ID</span><span className="font-mono text-[#cccccc] text-[10px] break-all">{nodeInfo.machineID || '-'}</span></div>
          </div>

          {/* Node Conditions */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Health Status</h4>
            <div className="flex flex-wrap gap-2">
              {ready && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${ready.status === 'True' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={ready.message}>
                  Ready: {ready.status}
                </span>
              )}
              {memPressure && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${memPressure.status === 'False' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={memPressure.message}>
                  MemoryPressure: {memPressure.status}
                </span>
              )}
              {diskPressure && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${diskPressure.status === 'False' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={diskPressure.message}>
                  DiskPressure: {diskPressure.status}
                </span>
              )}
              {pidPressure && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${pidPressure.status === 'False' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={pidPressure.message}>
                  PIDPressure: {pidPressure.status}
                </span>
              )}
              {networkUnavail && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${networkUnavail.status === 'False' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={networkUnavail.message}>
                  NetworkUnavailable: {networkUnavail.status}
                </span>
              )}
            </div>
          </div>

          {/* Taints */}
          {taints.length > 0 && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Taints</h4>
              <div className="flex flex-wrap gap-1.5">
                {taints.map((t: any, i: number) => (
                  <span key={i} className={`px-2 py-1 rounded text-[10px] font-mono border ${
                    t.effect === 'NoSchedule' ? 'bg-[#f48771]/10 text-[#f48771] border-[#f48771]/30' :
                    t.effect === 'NoExecute' ? 'bg-[#f48771]/20 text-[#f48771] border-[#f48771]/40' :
                    t.effect === 'PreferNoSchedule' ? 'bg-[#cca700]/10 text-[#cca700] border-[#cca700]/30' :
                    'bg-[#252526] text-[#cccccc] border-[#3e3e42]'
                  }`} title={`Effect: ${t.effect}${t.value ? `, Value: ${t.value}` : ''}`}>
                    {t.key}={t.value || ''}:{t.effect}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Addresses */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Addresses</h4>
            <div className="flex flex-wrap gap-1.5">
              {addresses.map((a: any, i: number) => (
                <span key={i} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={a.address}>{a.type}:{a.address}</span>
              ))}
              {addresses.length === 0 && <span className="text-[#858585] italic">No addresses</span>}
            </div>
          </div>

          {/* Capacity vs Allocatable with Progress Bars */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Resources</h4>
            <div className="space-y-3">
              {/* CPU */}
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className="text-[#858585]">CPU</span>
                  <span className="font-mono text-[#cccccc]">{alloc.cpu} / {capacity.cpu} <span className="text-[#858585]">({cpuReservedPct}% reserved)</span></span>
                </div>
                <div className="h-2 bg-[#252526] rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-cyan-500 to-blue-500" style={{ width: `${100 - cpuReservedPct}%` }} />
                </div>
              </div>
              {/* Memory */}
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className="text-[#858585]">Memory</span>
                  <span className="font-mono text-[#cccccc]">{alloc.memory} / {capacity.memory} <span className="text-[#858585]">({memReservedPct}% reserved)</span></span>
                </div>
                <div className="h-2 bg-[#252526] rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-purple-500 to-pink-500" style={{ width: `${100 - memReservedPct}%` }} />
                </div>
              </div>
              {/* Pods */}
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className="text-[#858585]">Pods</span>
                  <span className="font-mono text-[#cccccc]">{podsAllocatable} / {podsCapacity} allocatable</span>
                </div>
              </div>
              {/* Ephemeral Storage */}
              {capacity['ephemeral-storage'] && (
                <div className="flex justify-between text-[11px]">
                  <span className="text-[#858585]">Ephemeral Storage</span>
                  <span className="font-mono text-[#cccccc]">{alloc['ephemeral-storage']} / {capacity['ephemeral-storage']}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'persistentvolumeclaim') {
    return (
      <CollapsibleSection title="PVC Spec" icon={<HardDrive size={14} />}>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div><span className="block text-[#858585] mb-1">Storage Class</span><span className="font-mono text-[#cccccc]">{spec.storageClassName || '-'}</span></div>
          <div><span className="block text-[#858585] mb-1">Access Modes</span><span className="font-mono text-[#cccccc]">{Array.isArray(spec.accessModes) ? spec.accessModes.join(', ') : '-'}</span></div>
          <div><span className="block text-[#858585] mb-1">Requested</span><span className="font-mono text-[#cccccc]">{spec.resources?.requests?.storage || '-'}</span></div>
          <div><span className="block text-[#858585] mb-1">Phase</span><span className="font-mono text-[#cccccc]">{status.phase || '-'}</span></div>
          <div className="col-span-2"><span className="block text-[#858585] mb-1">Capacity</span><span className="font-mono text-[#cccccc]">{status.capacity?.storage || '-'}</span></div>
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'configmap') {
    const configData = fullObject.data || {};
    const binaryData = fullObject.binaryData || {};
    const keys = Object.keys(configData);
    const binaryKeys = Object.keys(binaryData);
    const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

    // Calculate total size
    const totalSize = keys.reduce((acc, key) => acc + (configData[key]?.length || 0), 0);
    const binarySize = binaryKeys.reduce((acc, key) => acc + (binaryData[key]?.length || 0), 0);
    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const toggleVisibility = (key: string) => {
      setVisibleKeys(prev => {
        const updated = new Set(prev);
        if (updated.has(key)) {
          updated.delete(key);
        } else {
          updated.add(key);
        }
        return updated;
      });
    };

    const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text).catch(() => { });
    };

    // Detect file type from key name
    const getFileType = (key: string) => {
      if (key.endsWith('.yaml') || key.endsWith('.yml')) return 'yaml';
      if (key.endsWith('.json')) return 'json';
      if (key.endsWith('.properties')) return 'properties';
      if (key.endsWith('.conf') || key.endsWith('.cfg')) return 'config';
      if (key.endsWith('.sh')) return 'shell';
      if (key.endsWith('.xml')) return 'xml';
      if (key.endsWith('.env')) return 'env';
      return 'text';
    };

    return (
      <CollapsibleSection title="ConfigMap Data" icon={<FileCog size={14} />}>
        <div className="space-y-3">
          {/* Stats */}
          <div className="flex flex-wrap gap-3 text-xs">
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Keys: </span>
              <span className="font-mono text-cyan-400">{keys.length}</span>
            </div>
            {binaryKeys.length > 0 && (
              <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
                <span className="text-[#858585]">Binary Keys: </span>
                <span className="font-mono text-purple-400">{binaryKeys.length}</span>
              </div>
            )}
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Total Size: </span>
              <span className="font-mono text-[#cccccc]">{formatSize(totalSize + binarySize)}</span>
            </div>
          </div>

          {keys.length === 0 && binaryKeys.length === 0 && <span className="text-[#858585] italic text-xs">No data</span>}
          {keys.map(key => {
            const isVisible = visibleKeys.has(key);
            const value = configData[key];
            const preview = typeof value === 'string' ? value.substring(0, 100) : String(value).substring(0, 100);
            const fileType = getFileType(key);
            const lineCount = (value?.match(/\n/g) || []).length + 1;
            return (
              <div key={key} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[#cccccc] font-bold">{key}</span>
                    <span className="px-1.5 py-0.5 bg-[#3e3e42] rounded text-[9px] text-[#858585]">{fileType}</span>
                    <span className="text-[9px] text-[#858585]">{formatSize(value?.length || 0)} • {lineCount} lines</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {isVisible && (
                      <button
                        onClick={() => copyToClipboard(value)}
                        className="px-2 py-0.5 bg-[#252526] hover:bg-[#3e3e42] border border-[#3e3e42] rounded text-[10px] text-[#cccccc] transition-colors"
                        title="Copy value"
                      >
                        Copy
                      </button>
                    )}
                    <button
                      onClick={() => toggleVisibility(key)}
                      className="px-2 py-0.5 bg-[#007acc] hover:bg-[#005a9e] rounded text-[10px] text-white transition-colors flex items-center gap-1"
                    >
                      <Eye size={10} />
                      {isVisible ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                {isVisible ? (
                  <div className="bg-[#252526] p-2 rounded border border-[#3e3e42] font-mono text-[10px] text-[#cccccc] break-all whitespace-pre-wrap max-h-96 overflow-auto">
                    {value}
                  </div>
                ) : (
                  <div className="bg-[#252526] p-2 rounded border border-[#3e3e42] font-mono text-[10px] text-[#858585] break-all">
                    {preview}{value?.length > 100 ? '...' : ''}
                  </div>
                )}
              </div>
            );
          })}
          {/* Binary data */}
          {binaryKeys.map(key => (
            <div key={key} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-[#cccccc] font-bold">{key}</span>
                <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-[9px]">binary</span>
                <span className="text-[9px] text-[#858585]">{formatSize(binaryData[key]?.length || 0)}</span>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'secret') {
    const secretData = fullObject.data || {};
    const secretType = fullObject.type || 'Opaque';
    const keys = Object.keys(secretData);
    const [decodedValues, setDecodedValues] = useState<Record<string, string>>({});
    const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

    // Calculate decoded sizes
    const getDecodedSize = (encoded: string) => {
      try {
        return atob(encoded).length;
      } catch {
        return 0;
      }
    };
    const totalEncodedSize = keys.reduce((acc, key) => acc + (secretData[key]?.length || 0), 0);
    const totalDecodedSize = keys.reduce((acc, key) => acc + getDecodedSize(secretData[key] || ''), 0);

    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const decodeBase64 = (encoded: string): string => {
      try {
        return atob(encoded);
      } catch {
        return '[Invalid Base64]';
      }
    };

    const toggleVisibility = (key: string) => {
      setVisibleKeys(prev => {
        const updated = new Set(prev);
        if (updated.has(key)) {
          updated.delete(key);
        } else {
          updated.add(key);
          if (!decodedValues[key]) {
            setDecodedValues(prev => ({
              ...prev,
              [key]: decodeBase64(secretData[key])
            }));
          }
        }
        return updated;
      });
    };

    const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text).catch(() => { });
    };

    // Detect common key types
    const getKeyType = (key: string) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('password') || lowerKey.includes('passwd')) return { type: 'password', color: 'text-red-400' };
      if (lowerKey.includes('token') || lowerKey.includes('bearer')) return { type: 'token', color: 'text-orange-400' };
      if (lowerKey.includes('key') || lowerKey.includes('secret')) return { type: 'key', color: 'text-yellow-400' };
      if (lowerKey.includes('cert') || lowerKey.includes('crt') || lowerKey.includes('pem')) return { type: 'cert', color: 'text-blue-400' };
      if (lowerKey.includes('ca')) return { type: 'ca', color: 'text-blue-400' };
      if (lowerKey.includes('user') || lowerKey.includes('username')) return { type: 'user', color: 'text-green-400' };
      if (lowerKey.includes('host') || lowerKey.includes('endpoint') || lowerKey.includes('url')) return { type: 'endpoint', color: 'text-cyan-400' };
      return { type: 'data', color: 'text-[#858585]' };
    };

    // Get secret type color and label
    const getSecretTypeInfo = (type: string) => {
      if (type === 'kubernetes.io/tls') return { label: 'TLS', color: 'bg-blue-500/20 text-blue-400' };
      if (type === 'kubernetes.io/dockerconfigjson') return { label: 'Docker', color: 'bg-purple-500/20 text-purple-400' };
      if (type === 'kubernetes.io/service-account-token') return { label: 'SA Token', color: 'bg-orange-500/20 text-orange-400' };
      if (type === 'kubernetes.io/basic-auth') return { label: 'Basic Auth', color: 'bg-yellow-500/20 text-yellow-400' };
      if (type === 'kubernetes.io/ssh-auth') return { label: 'SSH', color: 'bg-green-500/20 text-green-400' };
      return { label: 'Opaque', color: 'bg-[#3e3e42] text-[#858585]' };
    };

    const typeInfo = getSecretTypeInfo(secretType);

    return (
      <CollapsibleSection title="Secret Data" icon={<Shield size={14} />}>
        <div className="space-y-3">
          {/* Stats */}
          <div className="flex flex-wrap gap-3 text-xs">
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Type: </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] ${typeInfo.color}`}>{typeInfo.label}</span>
            </div>
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Keys: </span>
              <span className="font-mono text-cyan-400">{keys.length}</span>
            </div>
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Size: </span>
              <span className="font-mono text-[#cccccc]">{formatSize(totalDecodedSize)}</span>
              <span className="text-[#585858] ml-1">(decoded)</span>
            </div>
          </div>

          {keys.length === 0 && <span className="text-[#858585] italic text-xs">No keys</span>}
          {keys.map(key => {
            const isVisible = visibleKeys.has(key);
            const decodedValue = decodedValues[key];
            const keyType = getKeyType(key);
            const decodedSize = getDecodedSize(secretData[key] || '');
            return (
              <div key={key} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[#cccccc] font-bold">{key}</span>
                    <span className={`px-1.5 py-0.5 bg-[#3e3e42] rounded text-[9px] ${keyType.color}`}>{keyType.type}</span>
                    <span className="text-[9px] text-[#858585]">{formatSize(decodedSize)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {isVisible && (
                      <button
                        onClick={() => copyToClipboard(decodedValue)}
                        className="px-2 py-0.5 bg-[#252526] hover:bg-[#3e3e42] border border-[#3e3e42] rounded text-[10px] text-[#cccccc] transition-colors"
                        title="Copy decoded value"
                      >
                        Copy
                      </button>
                    )}
                    <button
                      onClick={() => toggleVisibility(key)}
                      className="px-2 py-0.5 bg-[#007acc] hover:bg-[#005a9e] rounded text-[10px] text-white transition-colors flex items-center gap-1"
                    >
                      <Eye size={10} />
                      {isVisible ? 'Hide' : 'Decode & Show'}
                    </button>
                  </div>
                </div>
                {isVisible ? (
                  <div className="bg-[#252526] p-2 rounded border border-[#3e3e42] font-mono text-[10px] text-[#cccccc] break-all whitespace-pre-wrap max-h-48 overflow-auto">
                    {decodedValue}
                  </div>
                ) : (
                  <div className="bg-[#252526] p-2 rounded border border-[#3e3e42] font-mono text-[10px] text-[#858585] break-all">
                    ••••••••••••••••
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CollapsibleSection>
    );
  }

  // Generic fallback
  if (spec && Object.keys(spec).length > 0) {
    return (
      <CollapsibleSection title="Spec" icon={<FileCog size={14} />}>
        <div className="space-y-0.5 text-[11px] font-mono">
          {renderKV(spec)}
        </div>
      </CollapsibleSection>
    );
  }
  return null;
}

function LogsTab({ namespace, name, podSpec }: { namespace: string, name: string, podSpec: any }) {
  const [selectedContainer, setSelectedContainer] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [logs, setLogs] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useMemo(() => `log-${Math.random().toString(36).substr(2, 9)}`, [namespace, name, selectedContainer]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Extract containers from spec
  const containers = [
    ...(podSpec?.containers || []).map((c: any) => c.name),
    ...(podSpec?.initContainers || []).map((c: any) => c.name)
  ];

  // Set default container
  useEffect(() => {
    if (containers.length > 0 && !selectedContainer) {
      setSelectedContainer(containers[0]);
    }
  }, [containers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start streaming
  useEffect(() => {
    if (!selectedContainer || isPaused) return;

    setError(null);
    setIsStreaming(true);
    setLogs(""); // Clear on container change

    invoke("start_log_stream", { namespace, name, container: selectedContainer, sessionId })
      .catch((err: any) => {
        setError(String(err));
        setIsStreaming(false);
      });

    const unlisten = listen<string>(`log_stream:${sessionId}`, (event) => {
      setLogs((prev) => prev + event.payload);
    });

    const unlistenEnd = listen(`log_stream_end:${sessionId}`, () => {
      setIsStreaming(false);
    });

    return () => {
      unlisten.then((f) => f());
      unlistenEnd.then((f) => f());
      invoke("stop_log_stream", { sessionId }).catch(() => { });
      setIsStreaming(false);
    };
  }, [namespace, name, selectedContainer, sessionId, isPaused]);

  // Auto-scroll
  useEffect(() => {
    if (autoFollow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoFollow]);

  const filteredLogs = useMemo(() => {
    if (!searchQuery) return logs;
    return logs.split('\n').filter(line => line.toLowerCase().includes(searchQuery.toLowerCase())).join('\n');
  }, [logs, searchQuery]);

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center gap-2 shrink-0">
        <label className="text-[10px] uppercase font-bold text-[#858585]">Container:</label>
        <div className="relative">
          <select
            value={selectedContainer}
            onChange={(e) => setSelectedContainer(e.target.value)}
            className="bg-[#252526] border border-[#3e3e42] text-[#cccccc] text-xs rounded pl-2 pr-6 py-1 appearance-none focus:border-[#007acc] focus:outline-none"
          >
            {containers.map((c: string) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[#858585]">
            <ChevronDown size={10} />
          </div>
        </div>

        {/* Controls */}
        <button
          onClick={() => setIsPaused(!isPaused)}
          className={`px-2 py-1 text-xs rounded border transition-colors ${isPaused ? 'bg-yellow-600/10 border-yellow-600/50 text-yellow-400 hover:bg-yellow-600/20' : 'bg-green-600/10 border-green-600/50 text-green-400 hover:bg-green-600/20'}`}
          title={isPaused ? 'Resume streaming' : 'Pause streaming'}
        >
          {isPaused ? 'Paused' : 'Streaming'}
        </button>

        <button
          onClick={() => setAutoFollow(!autoFollow)}
          className={`px-2 py-1 text-xs rounded border transition-colors ${autoFollow ? 'bg-blue-600/10 border-blue-600/50 text-blue-400 hover:bg-blue-600/20' : 'bg-gray-600/10 border-gray-600/50 text-gray-400 hover:bg-gray-600/20'}`}
          title={autoFollow ? 'Disable auto-scroll' : 'Enable auto-scroll'}
        >
          {autoFollow ? 'Following' : 'Follow Off'}
        </button>

        {/* Live status */}
        <div className="ml-2 text-xs flex items-center gap-1">
          {error ? (
            <span className="flex items-center gap-1 text-[#f48771]"><AlertCircle size={12} /> Failed</span>
          ) : (
            <span className={`flex items-center gap-1 ${isStreaming && !isPaused ? 'text-[#89d185]' : 'text-[#858585]'}`}>
              <svg className={`w-2 h-2 ${isStreaming && !isPaused ? 'animate-pulse' : ''}`} viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4" /></svg>
              {isStreaming && !isPaused ? 'Live' : isPaused ? 'Paused' : 'Idle'}
            </span>
          )}
        </div>

        {/* Search Input */}
        <div className="relative flex-1 max-w-xs ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-[#858585]" size={12} />
          <input
            type="text"
            placeholder="Search logs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[#252526] border border-[#3e3e42] rounded pl-8 pr-2 py-1 text-xs text-[#cccccc] focus:border-[#007acc] focus:outline-none"
          />
        </div>
      </div>

      {error && <div className="text-[#f48771] p-4 text-xs bg-red-500/10 border border-red-500/30 rounded">Failed to stream logs: {error}</div>}

      <div className="bg-[#1e1e1e] p-3 rounded border border-[#3e3e42] text-sm font-mono text-[#cccccc] flex-1 overflow-auto whitespace-pre leading-relaxed" ref={scrollRef}>
        {filteredLogs || (isStreaming ? "Waiting for logs..." : "No logs available.")}
      </div>
    </div>
  );
}

function EventsTab({ namespace, name, uid }: { namespace: string, name: string, uid: string }) {
  const [expandedExplanations, setExpandedExplanations] = useState<Record<number, string>>({});
  const [loadingExplanations, setLoadingExplanations] = useState<Record<number, boolean>>({});

  const { data: events, isLoading, isFetching } = useQuery({
    queryKey: ["events", namespace, name, uid],
    queryFn: async () => await invoke<K8sEvent[]>("list_events", { namespace, name, uid }),
    refetchInterval: 8000,
    refetchIntervalInBackground: true,
  });

  const explainEvent = async (index: number, event: K8sEvent) => {
    setLoadingExplanations(prev => ({ ...prev, [index]: true }));
    try {
      const context = `
Event Type: ${event.type_}
Reason: ${event.reason}
Message: ${event.message}
Count: ${event.count}
Resource: ${name} (namespace: ${namespace})
`;
      const answer = await invoke<string>("call_local_llm", {
        prompt: `Analyze this Kubernetes event and explain what it means, why it might be happening, and suggest potential solutions:\n\n${context}`,
        systemPrompt: "You are a Kubernetes SRE assistant. Provide concise, actionable explanations for Kubernetes events. Focus on root causes and practical solutions.",
      });
      setExpandedExplanations(prev => ({ ...prev, [index]: answer }));
    } catch (err) {
      setExpandedExplanations(prev => ({ ...prev, [index]: `Error: ${err}` }));
    } finally {
      setLoadingExplanations(prev => ({ ...prev, [index]: false }));
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 gap-2 text-xs text-[#007acc]">
        <Loader2 className="animate-spin" size={20} /> Loading events
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className={`flex items-center gap-1 ${isFetching ? 'text-[#007acc]' : 'text-[#89d185]'}`}>
          <svg className={`w-2 h-2 ${isFetching ? 'animate-pulse' : ''}`} viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4" /></svg>
          {isFetching ? 'Live (updating)' : 'Live'}
        </span>
      </div>
      {!events || events.length === 0 && (
        <div className="text-[#858585] text-center p-8 text-xs">No events found for this resource.</div>
      )}
      {events && events.length > 0 && events.map((ev, i) => (
        <div key={i} className="bg-[#1e1e1e] p-3 rounded border border-[#3e3e42]">
          <div className="flex items-center justify-between text-xs">
            <span className={`inline-flex items-center gap-1 ${ev.type_ === 'Warning' ? 'text-[#cca700]' : 'text-[#89d185]'}`}>
              <svg className="w-1.5 h-1.5" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4" /></svg>
              {ev.type_}
            </span>
            <span className="text-[10px] text-[#858585]">{new Date(ev.age).toLocaleString()}</span>
          </div>
          <div className="mt-1">
            <span className="font-medium text-xs text-[#cccccc]">{ev.reason}</span>
            {ev.count > 1 && <span className="ml-2 text-[10px] bg-[#3e3e42] px-1.5 py-0.5 rounded text-[#cccccc]">x{ev.count}</span>}
          </div>
          <p className="text-xs text-[#858585] break-words leading-snug mt-1">{ev.message}</p>

          {/* Explain button */}
          <div className="mt-2">
            <button
              onClick={() => expandedExplanations[i] ? setExpandedExplanations(prev => { const n = { ...prev }; delete n[i]; return n; }) : explainEvent(i, ev)}
              disabled={loadingExplanations[i]}
              className="text-xs text-purple-400 hover:text-purple-300 disabled:text-purple-600 flex items-center gap-1"
            >
              {loadingExplanations[i] ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Analyzing...
                </>
              ) : expandedExplanations[i] ? (
                <>Hide Explanation</>
              ) : (
                <>🤖 Explain</>
              )}
            </button>
            {expandedExplanations[i] && !loadingExplanations[i] && (
              <div className="mt-2 p-2 bg-[#252526] border border-[#3e3e42] rounded text-xs text-[#cccccc] leading-relaxed">
                <pre className="whitespace-pre-wrap font-sans">{expandedExplanations[i]}</pre>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function YamlTab({ resource }: { resource: K8sObject }) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const editorRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);
  const qc = useQueryClient();

  // Fetch full resource details on-demand
  const { data: yamlContent, isLoading } = useQuery({
    queryKey: ["resource_details", resource.namespace, resource.group, resource.version, resource.kind, resource.name],
    queryFn: async () => {
      if (resource.raw_json && resource.raw_json.trim() !== "") return resource.raw_json;
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
    staleTime: 30000,
  });

  const [content, setContent] = useState("");

  // Update content when yamlContent loads
  useEffect(() => {
    if (yamlContent) {
      setContent(yamlContent);
    }
  }, [yamlContent]);

  // Search Logic
  useEffect(() => {
    if (!editorRef.current) return;

    const editor = editorRef.current;
    const model = editor.getModel();

    if (!searchQuery) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }

    const matches = model.findMatches(searchQuery, false, false, false, null, true);

    if (matches.length > 0) {
      // Highlight all matches
      const newDecorations = matches.map((match: any) => ({
        range: match.range,
        options: {
          isWholeLine: false,
          className: 'myContentClass', // We'll rely on inline styles or global css if needed, but monaco supports inlineClassName
          inlineClassName: 'bg-yellow-500/40 text-white font-bold'
        }
      }));

      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, newDecorations);

      // Scroll to first match
      editor.revealRangeInCenter(matches[0].range);
    } else {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }
  }, [searchQuery]);

  const handleEditorDidMount = (editor: any) => {
    editorRef.current = editor;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-[#007acc]" size={24} />
      </div>
    );
  }

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await invoke("apply_yaml", {
        namespace: resource.namespace,
        kind: resource.kind,
        name: resource.name,
        yamlContent: content
      });

      qc.invalidateQueries({ queryKey: ["resources"] });
      qc.invalidateQueries({ queryKey: ["discovery"] }); // In case CRDs changed

      // Show success feedback (could be a toast, but for now just clear loading)
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] border border-[#3e3e42] rounded overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-[#252526] border-b border-[#3e3e42]">
        <div className="flex items-center gap-4">
          <span className="text-xs text-[#858585]">Edits are applied via Server-Side Apply</span>
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1.5 text-gray-500" />
            <input
              type="text"
              placeholder="Search in YAML..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-[#1e1e1e] border border-[#3e3e42] rounded pl-7 pr-2 py-1 text-xs text-[#cccccc] focus:outline-none focus:border-[#007acc]"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setContent(yamlContent || "")}
            className="px-3 py-1 text-xs text-[#cccccc] hover:bg-[#3e3e42] rounded transition-colors"
            disabled={isSaving}
          >
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-3 py-1 text-xs bg-[#007acc] hover:bg-[#0062a3] text-white rounded transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving ? <Loader2 className="animate-spin" size={12} /> : <Save size={12} />}
            Save
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[#f48771]/10 text-[#f48771] px-4 py-2 text-xs border-b border-[#f48771]/20">
          Error: {error}
        </div>
      )}

      <div className="flex-1 relative">
        <Editor
          height="100%"
          defaultLanguage="json"
          value={content}
          onChange={(val) => setContent(val || "")}
          onMount={handleEditorDidMount}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          }}
        />
      </div>
    </div>
  );
}

const StatusBadge = ({ status }: { status: string }) => {
  const getStyles = () => {
    switch (status) {
      case 'Active':
      case 'Running':
      case 'Bound':
      case 'Ready':
        return 'bg-green-500/20 text-green-400 border-green-500/40 shadow-sm shadow-green-500/20';
      case 'Pending':
      case 'ContainerCreating':
      case 'Terminating':
        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40 shadow-sm shadow-yellow-500/20';
      case 'CrashLoopBackOff':
      case 'Error':
      case 'Failed':
        return 'bg-red-500/20 text-red-400 border-red-500/40 shadow-sm shadow-red-500/20';
      default:
        return 'bg-gray-500/20 text-gray-400 border-gray-500/40';
    }
  };

  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${getStyles()} inline-flex items-center gap-1`}>
      <span className={`w-1 h-1 rounded-full ${getStyles().split(' ')[1].replace('text-', 'bg-')}`} />
      {status}
    </span>
  );
};

// --- Port Forwarding ---

function PortForwardModal({ isOpen, onClose, namespace, podName }: { isOpen: boolean, onClose: () => void, namespace: string, podName: string }) {
  const [localPort, setLocalPort] = useState("");
  const [podPort, setPodPort] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const handleStart = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await invoke("start_port_forward", {
        namespace,
        name: podName,
        localPort: parseInt(localPort),
        podPort: parseInt(podPort)
      });
      qc.invalidateQueries({ queryKey: ["portforwards"] });
      onClose();
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-6 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">Port Forward</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#858585] mb-1.5 uppercase tracking-wide">Local Port</label>
            <input
              type="number"
              value={localPort}
              onChange={e => setLocalPort(e.target.value)}
              className="w-full bg-[#3c3c3c] border border-[#3e3e42] rounded px-3 py-2 text-sm text-[#cccccc] focus:outline-none focus:border-[#007acc]"
              placeholder="e.g. 8080"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#858585] mb-1.5 uppercase tracking-wide">Pod Port</label>
            <input
              type="number"
              value={podPort}
              onChange={e => setPodPort(e.target.value)}
              className="w-full bg-[#3c3c3c] border border-[#3e3e42] rounded px-3 py-2 text-sm text-[#cccccc] focus:outline-none focus:border-[#007acc]"
              placeholder="e.g. 80"
            />
          </div>

          {error && (
            <div className="text-[#f48771] text-xs bg-[#f48771]/10 p-2 rounded border border-[#f48771]/20">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 mt-6">
            <button onClick={onClose} className="px-4 py-2 text-sm text-[#cccccc] hover:bg-[#3e3e42] rounded transition-colors">Cancel</button>
            <button
              onClick={handleStart}
              disabled={isLoading || !localPort || !podPort}
              className="px-4 py-2 text-sm bg-[#007acc] hover:bg-[#0062a3] text-white rounded transition-colors disabled:opacity-50"
            >
              {isLoading ? "Starting..." : "Start Forwarding"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PortForwardList() {
  const qc = useQueryClient();
  const { data: forwards } = useQuery({
    queryKey: ["portforwards"],
    queryFn: async () => await invoke<any[]>("list_port_forwards"),
    refetchInterval: 5000,
  });

  const stopMutation = useMutation({
    mutationFn: async (id: string) => {
      await invoke("stop_port_forward", { sessionId: id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portforwards"] });
    }
  });

  if (!forwards || forwards.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2">
      {forwards.map(pf => (
        <div key={pf.id} className="bg-[#252526] border border-[#3e3e42] rounded-md shadow-lg p-3 flex items-center gap-4 animate-in slide-in-from-bottom-5">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#89d185] animate-pulse" />
              {pf.local_port} → {pf.pod_port}
            </span>
            <span className="text-[10px] text-[#858585]">{pf.pod_name}</span>
          </div>
          <button
            onClick={() => stopMutation.mutate(pf.id)}
            className="p-1 text-[#858585] hover:text-[#f48771] hover:bg-[#3e3e42] rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}



// --- Helm Integration ---

interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}

function HelmReleases() {
  const qc = useQueryClient();
  const { data: releases, isLoading } = useQuery({
    queryKey: ["helm_releases"],
    queryFn: async () => await invoke<HelmRelease[]>("helm_list"),
    refetchInterval: 10000,
  });

  const uninstallMutation = useMutation({
    mutationFn: async (r: HelmRelease) => {
      if (confirm(`Uninstall ${r.name} from ${r.namespace}?`)) {
        await invoke("helm_uninstall", { namespace: r.namespace, name: r.name });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["helm_releases"] });
    }
  });

  if (isLoading) return <LoadingScreen message="Loading Helm Releases..." />;

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] text-[#cccccc]">
      <div className="h-12 border-b border-[#3e3e42] flex items-center px-4 bg-[#252526] shrink-0">
        <h2 className="font-semibold text-white">Helm Releases</h2>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {releases?.length === 0 && (
          <div className="text-center text-[#858585] mt-20">No Helm releases found.</div>
        )}
        <div className="grid grid-cols-1 gap-3">
          {releases?.map((r) => (
            <div key={`${r.namespace}/${r.name}`} className="bg-[#252526] border border-[#3e3e42] rounded p-4 flex items-center justify-between hover:border-[#505050] transition-colors">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                  <span className="font-bold text-white text-sm">{r.name}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${r.status === 'deployed' ? 'bg-[#89d185]/10 text-[#89d185] border-[#89d185]/20' : 'bg-[#f48771]/10 text-[#f48771] border-[#f48771]/20'}`}>
                    {r.status}
                  </span>
                </div>
                <div className="text-xs text-[#858585] flex gap-4">
                  <span>NS: {r.namespace}</span>
                  <span>Chart: {r.chart}</span>
                  <span>App v{r.app_version}</span>
                  <span>Rev: {r.revision}</span>
                </div>
                <div className="text-[10px] text-[#505050]">Updated: {r.updated}</div>
              </div>
              <button
                onClick={() => uninstallMutation.mutate(r)}
                className="p-2 text-[#858585] hover:text-[#f48771] hover:bg-[#3e3e42] rounded transition-colors"
                title="Uninstall Release"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AzurePage({ onConnect }: { onConnect: () => void }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSubs, setExpandedSubs] = useState<Record<string, boolean>>({});

  const { data: subscriptions, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["azure_data"],
    queryFn: async () => await invoke<AzureSubscription[]>("refresh_azure_data"),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const connectMutation = useMutation({
    mutationFn: async ({ subId, cluster }: { subId: string, cluster: AksCluster }) => {
      await invoke("get_aks_credentials", {
        subscriptionId: subId,
        resourceGroup: cluster.resourceGroup,
        name: cluster.name
      });
    },
    onSuccess: () => {
      onConnect();
    },
  });

  // Filter Logic
  const filteredSubs = useMemo(() => {
    if (!subscriptions) return [];
    if (!searchQuery) return subscriptions;

    const lowerQuery = searchQuery.toLowerCase();
    return subscriptions.map(sub => {
      if (sub.name.toLowerCase().includes(lowerQuery) || sub.id.toLowerCase().includes(lowerQuery)) {
        return sub;
      }
      const matchingClusters = sub.clusters.filter(c =>
        c.name.toLowerCase().includes(lowerQuery) ||
        c.resourceGroup.toLowerCase().includes(lowerQuery)
      );

      if (matchingClusters.length > 0) {
        return { ...sub, clusters: matchingClusters };
      }

      return null;
    }).filter(Boolean) as AzureSubscription[];
  }, [subscriptions, searchQuery]);

  // Auto-expand if searching
  useEffect(() => {
    if (searchQuery && filteredSubs.length > 0) {
      const newExpanded: Record<string, boolean> = {};
      filteredSubs.forEach(s => newExpanded[s.id] = true);
      setExpandedSubs(newExpanded);
    }
  }, [searchQuery, filteredSubs]);

  const toggleSub = (id: string) => {
    setExpandedSubs(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Calculate totals
  const totalClusters = subscriptions?.reduce((acc, sub) => acc + sub.clusters.length, 0) || 0;
  const runningClusters = subscriptions?.reduce((acc, sub) =>
    acc + sub.clusters.filter(c => c.powerState.code === 'Running').length, 0) || 0;

  if (isLoading) return <LoadingScreen message="Fetching Azure Data (this may take a moment)..." />;

  if (error) {
    const isLoginError = error.message.toLowerCase().includes("login");

    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8 bg-gradient-to-br from-zinc-900 to-zinc-950">
        <div className="bg-gradient-to-br from-red-500/10 to-orange-500/5 p-10 rounded-2xl border border-red-500/20 max-w-md backdrop-blur-xl shadow-2xl">
          <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center border border-red-500/30">
            <AlertCircle size={32} className="text-red-400" />
          </div>
          <h3 className="text-xl font-bold text-white mb-3">Azure Connection Error</h3>
          <p className="text-zinc-400 text-sm mb-6 leading-relaxed">{error.message}</p>

          {isLoginError ? (
            <button
              onClick={async () => {
                try {
                  await invoke("azure_login");
                  refetch();
                } catch (e) {
                  console.error(e);
                  refetch();
                }
              }}
              className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 rounded-xl text-white font-medium shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <Cloud size={18} />
              Sign in to Azure
            </button>
          ) : (
            <button
              onClick={() => refetch()}
              className="inline-flex items-center gap-2 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-white font-medium transition-all"
            >
              <RefreshCw size={16} />
              Try Again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950">
      {/* Header */}
      <div className="border-b border-white/5 bg-black/20 backdrop-blur-xl shrink-0">
        <div className="px-6 py-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-blue-500/25">
                <Cloud className="text-white" size={24} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Azure Kubernetes Service</h2>
                <p className="text-sm text-zinc-500">Select a cluster to connect</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Stats Pills */}
              <div className="hidden md:flex items-center gap-2">
                <div className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 flex items-center gap-2">
                  <Server size={14} className="text-blue-400" />
                  <span className="text-xs font-medium text-zinc-300">{totalClusters} Clusters</span>
                </div>
                <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs font-medium text-emerald-300">{runningClusters} Running</span>
                </div>
              </div>

              <button
                onClick={() => refetch()}
                disabled={isRefetching}
                className="p-2.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded-xl transition-all disabled:opacity-50 border border-transparent hover:border-white/10"
                title="Refresh Azure Data"
              >
                <RefreshCw size={18} className={isRefetching ? "animate-spin" : ""} />
              </button>
            </div>
          </div>

          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
            <input
              type="text"
              placeholder="Search subscriptions, clusters, or resource groups..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 transition-all"
            />
            {subscriptions && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-600">
                {filteredSubs.length} subscription{filteredSubs.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Subscription List */}
      <div className="flex-1 overflow-auto p-6 space-y-4">
        {filteredSubs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
              <Search size={28} className="text-zinc-600" />
            </div>
            <p className="text-zinc-400 font-medium">
              {searchQuery ? "No matches found" : "No subscriptions available"}
            </p>
            <p className="text-sm text-zinc-600 mt-1">
              {searchQuery ? "Try a different search term" : "Make sure you're logged in to Azure"}
            </p>
          </div>
        ) : (
          filteredSubs.map(sub => (
            <div
              key={sub.id}
              className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden backdrop-blur-sm hover:border-white/20 transition-all"
            >
              {/* Subscription Header */}
              <button
                onClick={() => toggleSub(sub.id)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${expandedSubs[sub.id] ? 'bg-blue-500/20' : 'bg-white/5'}`}>
                    {expandedSubs[sub.id] ? (
                      <ChevronDown size={18} className="text-blue-400" />
                    ) : (
                      <ChevronRight size={18} className="text-zinc-500" />
                    )}
                  </div>
                  <div className="flex flex-col items-start">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{sub.name}</span>
                      {sub.isDefault && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                          Default
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-zinc-600 font-mono">{sub.id}</span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Server size={14} className="text-zinc-600" />
                    <span className="text-sm text-zinc-400">{sub.clusters.length} cluster{sub.clusters.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              </button>

              {/* Clusters Grid */}
              {expandedSubs[sub.id] && (
                <div className="border-t border-white/5 bg-black/20 p-5">
                  {sub.clusters.length === 0 ? (
                    <div className="text-center py-8">
                      <Server size={24} className="text-zinc-700 mx-auto mb-2" />
                      <p className="text-sm text-zinc-600">No clusters in this subscription</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {sub.clusters.map(cluster => {
                        const isRunning = cluster.powerState.code === 'Running';
                        const isConnecting = connectMutation.isPending &&
                          connectMutation.variables?.cluster.id === cluster.id;

                        return (
                          <div
                            key={cluster.id}
                            className={`group relative rounded-xl border p-5 transition-all duration-300 ${
                              isRunning
                                ? 'bg-gradient-to-br from-emerald-500/5 to-transparent border-emerald-500/20 hover:border-emerald-500/40 hover:shadow-lg hover:shadow-emerald-500/10'
                                : 'bg-white/[0.02] border-white/10 hover:border-white/20'
                            }`}
                          >
                            {/* Status Badge */}
                            <div className="absolute top-4 right-4">
                              <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium ${
                                isRunning
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                  : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                              }`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                                {isRunning ? 'Running' : 'Stopped'}
                              </div>
                            </div>

                            {/* Cluster Info */}
                            <div className="mb-4">
                              <h3 className="font-bold text-white text-lg mb-1 pr-20">{cluster.name}</h3>
                              <div className="flex flex-wrap gap-2 mt-3">
                                <span className="inline-flex items-center gap-1 text-xs text-zinc-500 bg-white/5 px-2 py-1 rounded-md">
                                  <Globe size={12} />
                                  {cluster.location}
                                </span>
                                <span className="inline-flex items-center gap-1 text-xs text-zinc-500 bg-white/5 px-2 py-1 rounded-md truncate max-w-[180px]" title={cluster.resourceGroup}>
                                  <Layers size={12} />
                                  {cluster.resourceGroup}
                                </span>
                              </div>
                            </div>

                            {/* Connect Button */}
                            <button
                              onClick={() => connectMutation.mutate({ subId: sub.id, cluster })}
                              disabled={connectMutation.isPending || !isRunning}
                              className={`w-full py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                                isRunning
                                  ? 'bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 disabled:opacity-50'
                                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                              }`}
                            >
                              {isConnecting ? (
                                <>
                                  <Loader2 className="animate-spin" size={16} />
                                  Connecting...
                                </>
                              ) : (
                                <>
                                  <Plug size={16} />
                                  {isRunning ? 'Connect to Cluster' : 'Cluster Stopped'}
                                </>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AppContent() {
  const [isConnected, setIsConnected] = useState(false);
  const [showAzure, setShowAzure] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type?: 'success' | 'error' | 'info' }>>([]);
  const prevContextRef = useRef<string | null>(null);

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

  // Auto-connect if backend has a context on mount (e.g. after refresh)
  const [hasCheckedInitialContext, setHasCheckedInitialContext] = useState(false);
  useEffect(() => {
    if (!hasCheckedInitialContext && globalCurrentContext !== undefined) {
      if (globalCurrentContext) {
        setIsConnected(true);
      }
      setHasCheckedInitialContext(true);
    }
  }, [globalCurrentContext, hasCheckedInitialContext]);

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

  // Show a full-screen loading/error gate while cluster details load
  if (isConnected && (!!globalCurrentContext) && bootLoading) {
    return <LoadingScreen message={`Loading cluster '${globalCurrentContext}'...`} />;
  }
  if (isConnected && (!!globalCurrentContext) && bootError) {
    const errorMessage = (bootErr as any)?.message || "Unknown error";
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
                onClick={() => setIsConnected(false)}
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
        onDisconnect={() => {
          (window as any).showToast?.('Disconnected from cluster', 'info');
          setIsConnected(false);
        }}
      />
      <PortForwardList />
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
      </PersistQueryClientProvider>
    </ErrorBoundary>
  );
}