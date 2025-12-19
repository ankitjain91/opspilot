
import asyncio
import logging
import time
from collections import deque
from kubernetes_asyncio import client, config, watch
from .utils import emit_event

# Configure logging
logger = logging.getLogger("sentinel")

class SentinelLoop:
    """
    Proactive Watchdog for Kubernetes Clusters.
    Subscribes to K8s Event API and triggers alerts for detected anomalies.
    """
    def __init__(self, kube_context: str = None, broadcaster=None):
        self.running = False
        self.kube_context = kube_context
        self.broadcaster = broadcaster
        self.event_buffer = deque(maxlen=100) # Deduplication buffer
        self.last_alert_time = {} # Throttle alerts per resource
        self._consecutive_failures = 0
        self._last_error_log_time = 0

    async def start(self):
        """Start the background monitoring loop.
        Ensures Kubernetes ApiClient and Watch are properly closed to avoid aiohttp leaks.
        """
        self.running = True
        logger.info(f"🛡️ Sentinel starting for context: {self.kube_context or 'default'}")

        while self.running:
            api_client = None
            w = None
            try:
                # Load config asynchronously
                try:
                    # Try in-cluster config first, then kubeconfig
                    await config.load_incluster_config()
                except config.ConfigException:
                    await config.load_kube_config(context=self.kube_context)

                # Create an ApiClient bound to the loaded config and ensure it closes
                api_client = client.ApiClient()
                v1 = client.CoreV1Api(api_client)
                w = watch.Watch()

                logger.info("🛡️ Watching for Warning events...")

                # Connection successful - reset backoff and failure count
                self._backoff = 5
                self._consecutive_failures = 0

                # Stream events; filter for Warning type to reduce noise
                async for event in w.stream(v1.list_event_for_all_namespaces, timeout_seconds=60):
                    if not self.running:
                        break

                    obj = event['object']
                    if getattr(obj, 'type', None) == "Warning":
                        await self.process_warning(obj)

            except Exception as e:
                # Exponential Backoff
                backoff_time = getattr(self, '_backoff', 5)
                self._consecutive_failures += 1

                # Only log errors periodically to avoid spam
                # Log first failure, then every 60 seconds after that
                current_time = time.time()
                should_log = (
                    self._consecutive_failures == 1 or
                    (current_time - self._last_error_log_time) >= 60
                )

                if should_log:
                    error_str = str(e)
                    # Provide helpful context for common errors
                    if "Connection reset" in error_str or "Cannot connect" in error_str:
                        if self._consecutive_failures > 1:
                            logger.warning(f"🛡️ Sentinel: Cluster unreachable (attempt #{self._consecutive_failures}). Will keep retrying silently...")
                        else:
                            logger.warning(f"🛡️ Sentinel: Cluster appears unreachable - may require port-forward or VPN. Retrying in background...")
                    else:
                        logger.error(f"Sentinel connection failed: {e}. Retrying in {backoff_time}s...")
                    self._last_error_log_time = current_time

                await asyncio.sleep(backoff_time)
                self._backoff = min(backoff_time * 2, 300) # Max 5 min wait
            finally:
                # Stop watcher and close underlying aiohttp session to prevent leaks
                try:
                    if w is not None:
                        w.stop()
                except Exception:
                    pass
                try:
                    if api_client is not None:
                        # Close kubernetes_asyncio ApiClient (closes aiohttp session/connector)
                        await api_client.close()
                except Exception:
                    pass

    async def stop(self):
        """Stop the loop."""
        self.running = False
        logger.info("🛡️ Sentinel stopped.")

    async def process_warning(self, event_obj):
        """Analyze a Warning event and decide whether to alert."""
        
        reason = event_obj.reason
        message = event_obj.message
        name = event_obj.metadata.name
        namespace = event_obj.metadata.namespace
        kind = event_obj.involved_object.kind or "Unknown"
        obj_name = event_obj.involved_object.name
        
        # 1. Deduplication Key: (Namespace, Kind, Name, Reason)
        # e.g. ("default", "Pod", "frontend-123", "BackOff")
        key = (namespace, kind, obj_name, reason)
        
        current_time = time.time()
        
        # 2. Throttling: Alert only once per 5 minutes for the exact same issue
        last_time = self.last_alert_time.get(key, 0)
        if current_time - last_time < 300:
            return

        # 3. Filtering: Ignore boring warnings
        ignored_reasons = ["NetworkNotReady", "Unhealthy"] # sometimes transient
        if reason in ignored_reasons:
            return

        # 4. Impact Analysis (Simple heuristics for now)
        severity = "medium"
        if reason in ["FailedScheduling", "BackOff", "FailedCreate", "OOMKilled"]:
            severity = "high"
        
        # 5. Emit Alert (SSE to Frontend)
        alert_msg = f"Detected {reason} on {kind}/{obj_name}: {message}"
        
        logger.info(f"🚨 SENTINEL ALERT: {alert_msg}")
        
        if self.broadcaster:
            # Broadcast to all connected clients
            await self.broadcaster.broadcast({
                "type": "alert",
                "severity": severity,
                "message": alert_msg,
                "timestamp": current_time,
                "resource": f"{kind}/{namespace}/{obj_name}",
                "cluster": self.kube_context
            })
