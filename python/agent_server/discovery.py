import json
import subprocess
import asyncio
import time
from typing import List, Dict, Any, Optional, Tuple, Set
from pydantic import BaseModel
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# Thread pool for kubectl calls - increased for parallel discovery
_executor = ThreadPoolExecutor(max_workers=12)


def run_kubectl_parallel(commands: List[Tuple[str, List[str]]], context: str = "", timeout_per_cmd: int = 30, total_timeout: int = 120) -> Dict[str, Any]:
    """
    Run multiple kubectl commands in parallel with timeouts.
    Args:
        commands: List of (name, args) tuples, e.g., [("deployments", ["get", "deployments", "-A"]), ...]
        timeout_per_cmd: Timeout per individual command
        total_timeout: Total timeout for all commands to complete
    Returns:
        Dict mapping name -> result
    """
    results = {}

    def run_one(name: str, args: List[str]) -> Tuple[str, Any]:
        return (name, run_kubectl(args, context, timeout_seconds=timeout_per_cmd))

    futures = {_executor.submit(run_one, name, args): name for name, args in commands}

    try:
        for future in as_completed(futures, timeout=total_timeout):
            try:
                name, result = future.result(timeout=5)  # Quick result fetch
                results[name] = result
            except Exception as e:
                name = futures[future]
                print(f"[discovery] Parallel kubectl error for {name}: {e}")
                results[name] = None
    except TimeoutError:
        print(f"[discovery] Parallel commands timed out after {total_timeout}s")
        # Cancel remaining futures
        for future in futures:
            future.cancel()

    return results

# Background discovery cache
class DiscoveryCache:
    """Thread-safe cache for controller/CRD discovery results."""

    def __init__(self, ttl_seconds: int = 300):  # 5 min default TTL
        self._lock = threading.RLock()
        self._data: Dict[str, Dict] = {}  # context -> data
        self._timestamps: Dict[str, float] = {}  # context -> last_updated
        self._scanning: Dict[str, bool] = {}  # context -> is_scanning
        self._ttl = ttl_seconds

    def get(self, context: str) -> Optional[Dict]:
        """Get cached data if valid."""
        with self._lock:
            if context not in self._data:
                return None
            ts = self._timestamps.get(context, 0)
            if time.time() - ts > self._ttl:
                return None  # Expired
            return self._data[context]

    def set(self, context: str, data: Dict):
        """Set cache data."""
        with self._lock:
            self._data[context] = data
            self._timestamps[context] = time.time()
            self._scanning[context] = False

    def is_scanning(self, context: str) -> bool:
        """Check if a scan is in progress."""
        with self._lock:
            return self._scanning.get(context, False)

    def set_scanning(self, context: str, value: bool):
        """Mark scan as in progress."""
        with self._lock:
            self._scanning[context] = value

    def get_scan_progress(self, context: str) -> Dict:
        """Get partial data during a scan."""
        with self._lock:
            data = self._data.get(context, {})
            return {
                "scanning": self._scanning.get(context, False),
                "controllers": data.get("controllers", []),
                "crds": data.get("crds", []),
                "mapping": data.get("mapping", {}),
                "unhealthy_crs": data.get("unhealthy_crs", []),
                "scanned_crds": data.get("scanned_crds", 0),
                "total_crds": data.get("total_crds", 0),
            }

    def update_partial(self, context: str, key: str, value: Any):
        """Update a specific field during scanning."""
        with self._lock:
            if context not in self._data:
                self._data[context] = {}
            self._data[context][key] = value

# Global cache instance
discovery_cache = DiscoveryCache(ttl_seconds=300)

class ControllerInfo(BaseModel):
    name: str # e.g. "postgres-operator"
    kind: str # "Deployment", "StatefulSet"
    namespace: str
    managed_crds: List[str] # List of CRD names e.g. ["postgresclusters.acid.zalan.do"]
    status: str # "Running", "Failed"

class CRDInfo(BaseModel):
    name: str
    group: str
    version: str
    kind: str
    controller: Optional[str] = None  # Name of controller if found
    categories: List[str] = []  # CRD categories (e.g., ["all"])
    conversion_webhook_service: Optional[str] = None  # Service name from conversion webhook
    conversion_webhook_namespace: Optional[str] = None  # Namespace of conversion webhook service
    detection_method: Optional[str] = None  # How the controller was detected

def run_kubectl(args: List[str], context: str = "", timeout_seconds: int = 30) -> Any:
    """Run a kubectl command and return parsed JSON with timeout."""
    cmd = ["kubectl"] + args + ["-o", "json"]
    if context:
        cmd.extend(["--context", context])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=timeout_seconds)
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        print(f"Kubectl timeout after {timeout_seconds}s: {' '.join(args[:3])}")
        return None
    except subprocess.CalledProcessError as e:
        # Suppress common "not found" errors for optional resources
        stderr = e.stderr or ""
        if "NotFound" not in stderr and "no matches" not in stderr.lower():
            print(f"Kubectl error: {stderr[:200]}")
        return None
    except json.JSONDecodeError:
        print(f"JSON decode error")
        return None
    except Exception as e:
        print(f"Detailed Kubectl execution error: {str(e)}")
        return None

def list_crds(context: str = "") -> List[CRDInfo]:
    """List all CRDs in the cluster with enhanced metadata extraction."""
    data = run_kubectl(["get", "crds"], context)
    if not data:
        return []

    crds = []
    for item in data.get("items", []):
        metadata = item.get("metadata") or {}
        spec = item.get("spec") or {}

        if not spec:
            continue

        # Extract conversion webhook info (points directly to controller service)
        conversion = spec.get("conversion", {})
        webhook_service = None
        webhook_namespace = None
        if conversion.get("strategy") == "Webhook":
            client_config = conversion.get("webhook", {}).get("clientConfig", {})
            service_ref = client_config.get("service", {})
            if service_ref:
                webhook_service = service_ref.get("name")
                webhook_namespace = service_ref.get("namespace")

        # Extract categories
        names = spec.get("names", {})
        categories = names.get("categories", [])

        crds.append(CRDInfo(
            name=metadata.get("name", ""),
            group=spec.get("group", ""),
            version=spec.get("versions", [{}])[0].get("name", "v1") if spec.get("versions") else "v1",
            kind=names.get("kind", ""),
            controller=None,
            categories=categories,
            conversion_webhook_service=webhook_service,
            conversion_webhook_namespace=webhook_namespace
        ))
    return crds

# Controller discovery logic removed as per user request
def find_controllers(context: str = "") -> List[ControllerInfo]:
    """
    Deprecated/Disabled: Returns empty list as logic was removed.
    """
    return []

# Mapping logic removed
def map_controllers_to_crds(controllers: List[ControllerInfo], crds: List[CRDInfo], context: str = "", skip_rbac: bool = False) -> Dict[str, str]:
    return {}

def enhanced_map_controllers_to_crds(controllers: List[ControllerInfo], crds: List[CRDInfo], context: str = "", fast_mode: bool = False) -> Dict[str, str]:
    return {}


class CRInstance(BaseModel):
    name: str
    namespace: str
    kind: str
    status: str # "Healthy", "Degraded", "Unknown"
    message: str # Error message if any

def scan_cr_health(crd_name: str, context: str = "") -> List[CRInstance]:
    """
    List all instances of a CRD and check their health.

    Health Status Logic:
    - "Healthy": Ready=True, Synced=True, or positive phase states
    - "Progressing": Actively reconciling but not in error state
    - "Degraded": Explicit failure conditions
    - "Unknown": Cannot determine status (not treated as error)
    """
    # Get all instances across all namespaces
    data = run_kubectl(["get", crd_name, "-A"], context)
    if not data:
        return []

    instances = []
    for item in data.get("items", []):
        metadata = item.get("metadata") or {}
        status_obj = item.get("status") or {}

        name = metadata.get("name", "unknown")
        ns = metadata.get("namespace", "default")
        kind = item.get("kind", crd_name)

        health = "Unknown"
        msg = ""

        # Check standard conditions
        conditions = status_obj.get("conditions", [])

        # Track various condition states
        is_ready = False
        is_synced = False
        is_progressing = False
        is_available = False
        has_failure = False
        failure_msg = ""

        for cond in conditions:
            c_type = cond.get("type", "").lower()
            c_status = cond.get("status", "")
            c_msg = cond.get("message", "")
            c_reason = cond.get("reason", "")

            # Healthy indicators (case insensitive type check)
            if c_type == "ready" and c_status == "True":
                is_ready = True
            elif c_type == "synced" and c_status == "True":
                is_synced = True
            elif c_type == "available" and c_status == "True":
                is_available = True
            elif c_type == "succeeded" and c_status == "True":
                is_ready = True  # Jobs/Tasks

            # Progressing indicator (NOT a failure state)
            elif c_type == "progressing" and c_status == "True":
                is_progressing = True
            elif c_type == "reconciling" and c_status == "True":
                is_progressing = True

            # Failure indicators
            elif c_type in ["failed", "error", "degraded", "stalled"] and c_status == "True":
                has_failure = True
                failure_msg = c_msg or c_reason or f"Condition {c_type}=True"
            elif c_type == "ready" and c_status == "False":
                # Ready=False with a failure reason
                reason_lower = c_reason.lower() if c_reason else ""
                if any(err in reason_lower for err in ["error", "fail", "crash", "backoff", "timeout"]):
                    has_failure = True
                    failure_msg = c_msg or c_reason or "Ready=False"
                elif c_reason:
                    # Ready=False but not an error (e.g., still initializing)
                    is_progressing = True

        # Determine health status
        if has_failure:
            health = "Degraded"
            msg = failure_msg
        elif is_ready or is_synced or is_available:
            health = "Healthy"
        elif is_progressing:
            # Progressing is normal operation, NOT an error
            health = "Progressing"
            msg = "Reconciliation in progress"
        else:
            # Check 'phase' field as fallback
            phase = status_obj.get("phase", "").lower()
            if phase in ["running", "ready", "active", "bound", "succeeded", "complete"]:
                health = "Healthy"
            elif phase in ["failed", "error", "crashing", "crashloopbackoff"]:
                health = "Degraded"
                msg = f"Phase is {phase}"
            elif phase in ["pending", "creating", "provisioning", "initializing"]:
                # These are normal transitional states
                health = "Progressing"
                msg = f"Phase: {phase}"
            else:
                # Check generation vs observedGeneration
                gen = metadata.get("generation", 0)
                obs_gen = status_obj.get("observedGeneration", 0)
                if gen != obs_gen and gen > 0:
                    health = "Progressing"
                    msg = "Controller is reconciling (generation mismatch)"
                else:
                    # Truly unknown status - but don't flag as error
                    health = "Unknown"
                    if not conditions and not phase:
                        msg = "No status information available"

        instances.append(CRInstance(
            name=name,
            namespace=ns,
            kind=kind,
            status=health,
            message=msg
        ))

    return instances


# =============================================================================
# ASYNC BACKGROUND DISCOVERY
# =============================================================================

async def run_kubectl_async(args: List[str], context: str = "") -> Any:
    """Run kubectl asynchronously using thread pool."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, run_kubectl, args, context)


async def list_crds_async(context: str = "") -> List[CRDInfo]:
    """Async version of list_crds."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, list_crds, context)


async def find_controllers_async(context: str = "") -> List[ControllerInfo]:
    """Async version of find_controllers."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, find_controllers, context)


async def scan_cr_health_async(crd_name: str, context: str = "") -> List[CRInstance]:
    """Async version of scan_cr_health."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, scan_cr_health, crd_name, context)


async def run_full_discovery_async(context: str, batch_size: int = 5, fast_mode: bool = True) -> Dict:
    """
    Run full controller/CRD discovery asynchronously with batch processing.
    Updates cache progressively so UI can show partial results.

    Args:
        fast_mode: If True (default), skip slow detection methods for faster initial results
    """
    print(f"[discovery] Starting async discovery for context: {context} (fast_mode={fast_mode})")

    # Mark as scanning
    discovery_cache.set_scanning(context, True)
    discovery_cache.update_partial(context, "scanning", True)

    try:
        # Phase 1: Quick discovery (controllers + CRDs) - runs in parallel
        print(f"[discovery] Phase 1: Discovering controllers and CRDs...")
        crds_task = list_crds_async(context)
        controllers_task = find_controllers_async(context)

        crds, controllers = await asyncio.gather(crds_task, controllers_task)

        print(f"[discovery] Found {len(controllers)} controllers, {len(crds)} CRDs")

        # Map controllers to CRDs using heuristics (fast) or full RBAC analysis
        # Run enhanced mapping in executor since it makes kubectl calls
        loop = asyncio.get_event_loop()
        mapping = await loop.run_in_executor(
            _executor,
            lambda: enhanced_map_controllers_to_crds(controllers, crds, context, fast_mode=fast_mode)
        )

        # Update cache with initial data
        discovery_cache.update_partial(context, "controllers", [c.dict() for c in controllers])
        discovery_cache.update_partial(context, "crds", [c.dict() for c in crds])
        discovery_cache.update_partial(context, "mapping", mapping)
        discovery_cache.update_partial(context, "total_crds", len([c for c in crds if c.name in mapping]))
        discovery_cache.update_partial(context, "scanned_crds", 0)
        discovery_cache.update_partial(context, "unhealthy_crs", [])

        # Phase 2: Health scanning (batched, for managed CRDs only)
        managed_crd_names = [crd.name for crd in crds if crd.name in mapping]
        all_unhealthy_crs = []

        print(f"[discovery] Phase 2: Scanning {len(managed_crd_names)} managed CRDs in batches of {batch_size}...")

        for i in range(0, len(managed_crd_names), batch_size):
            batch = managed_crd_names[i:i + batch_size]

            # Scan batch in parallel
            tasks = [scan_cr_health_async(crd_name, context) for crd_name in batch]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for crd_name, result in zip(batch, results):
                if isinstance(result, Exception):
                    print(f"[discovery] Error scanning {crd_name}: {result}")
                    continue

                for inst in result:
                    # Only flag actual errors (Degraded), not Progressing/Unknown
                    if inst.status == "Degraded":
                        # Find the CRD info to get group/version for proper API access
                        crd_info = next((c for c in crds if c.name == crd_name), None)
                        all_unhealthy_crs.append({
                            "name": inst.name,
                            "namespace": inst.namespace,
                            "kind": inst.kind,
                            "status": inst.status,
                            "message": inst.message,
                            "controller": mapping.get(crd_name, "Unknown"),
                            "crd_name": crd_name,
                            "group": crd_info.group if crd_info else "",
                            "version": crd_info.version if crd_info else "v1"
                        })

            # Update progress in cache
            scanned = min(i + batch_size, len(managed_crd_names))
            discovery_cache.update_partial(context, "scanned_crds", scanned)
            discovery_cache.update_partial(context, "unhealthy_crs", all_unhealthy_crs)

            print(f"[discovery] Scanned {scanned}/{len(managed_crd_names)} CRDs, found {len(all_unhealthy_crs)} unhealthy")

            # Small delay between batches to avoid overwhelming the API server
            await asyncio.sleep(0.1)

        # Finalize
        final_data = {
            "controllers": [c.dict() for c in controllers],
            "crds": [c.dict() for c in crds],
            "mapping": mapping,
            "unhealthy_crs": all_unhealthy_crs,
            "scanning": False,
            "scanned_crds": len(managed_crd_names),
            "total_crds": len(managed_crd_names),
        }

        discovery_cache.set(context, final_data)
        print(f"[discovery] Completed. {len(controllers)} controllers, {len(all_unhealthy_crs)} unhealthy CRs")

        return final_data

    except Exception as e:
        print(f"[discovery] Error during async discovery: {e}")
        discovery_cache.set_scanning(context, False)
        raise


def start_background_discovery(context: str):
    """
    Start discovery in background. Returns immediately.
    Call get_discovery_status() to check progress.
    """
    if discovery_cache.is_scanning(context):
        print(f"[discovery] Scan already in progress for {context}")
        return

    async def _run():
        try:
            await run_full_discovery_async(context)
        except Exception as e:
            print(f"[discovery] Background discovery failed: {e}")

    # Schedule the coroutine
    asyncio.create_task(_run())


def get_discovery_status(context: str) -> Dict:
    """Get current discovery status/data for a context."""
    # First check cache for complete data
    cached = discovery_cache.get(context)
    if cached and not discovery_cache.is_scanning(context):
        return {"status": "complete", "data": cached}

    # Check if scanning
    if discovery_cache.is_scanning(context):
        progress = discovery_cache.get_scan_progress(context)
        return {"status": "scanning", "data": progress}

    # No data, no scan
    return {"status": "empty", "data": None}

