
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

    async def start(self):
        """Start the background monitoring loop."""
        self.running = True
        logger.info(f"🛡️ Sentinel starting for context: {self.kube_context}")
        
        while self.running:
            try:
                # Load config asynchronously
                try:
                    # Try in-cluster config first, then kubeconfig
                    await config.load_incluster_config()
                except config.ConfigException:
                    await config.load_kube_config(context=self.kube_context)

                v1 = client.CoreV1Api()
                w = watch.Watch()

                logger.info("🛡️ Watching for Warning events...")
                
                # Stream events
                # Filter for Warning type to reduce noise
                async for event in w.stream(v1.list_event_for_all_namespaces, timeout_seconds=60):
                    if not self.running: 
                        break

                    obj = event['object']
                    if obj.type == "Warning":
                        await self.process_warning(obj)
            
            except Exception as e:
                logger.error(f"Sentinel crash: {e}")
                await asyncio.sleep(5) # Backoff before restart

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
                "resource": f"{kind}/{namespace}/{obj_name}"
            })
