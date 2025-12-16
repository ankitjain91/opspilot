
from typing import List, Dict, Optional, Any
from pydantic import BaseModel, Field

class K8sContainer(BaseModel):
    name: str
    image: str = "unknown"
    ready: bool = False
    restart_count: int = Field(0, alias="restartCount")
    state: str = "Unknown"  # Running, Waiting, Terminated
    reason: Optional[str] = None # CrashLoopBackOff, Error, etc.
    message: Optional[str] = None

class K8sPod(BaseModel):
    name: str
    namespace: str
    status: str # Phase: Running, Pending, Failed
    node_name: Optional[str] = Field(None, alias="nodeName")
    pod_ip: Optional[str] = Field(None, alias="podIP")
    start_time: Optional[str] = Field(None, alias="startTime")
    labels: Dict[str, str] = {}
    containers: List[K8sContainer] = []
    
    @property
    def is_healthy(self) -> bool:
        # Check phase
        if self.status not in ["Running", "Succeeded"]:
            return False
            
        # Check containers
        if not self.containers: # Pending or initializing
            return self.status == "Succeeded"
            
        return all(c.ready for c in self.containers)

    def summary(self) -> str:
        """Returns a concise summary for LLM consumption."""
        unhealthy_containers = [f"{c.name}({c.reason or c.state}: {c.restart_count} restarts)" for c in self.containers if not c.ready]
        container_summary = ", ".join(unhealthy_containers) if unhealthy_containers else "All ready"
        return f"Pod {self.name} ({self.status}): {container_summary}"

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'K8sPod':
        """Parse strict Summary Model from raw K8s JSON."""
        metadata = data.get('metadata', {})
        status_obj = data.get('status', {})
        
        # 1. Basic Fields
        name = metadata.get('name', 'unknown')
        namespace = metadata.get('namespace', 'default')
        labels = metadata.get('labels', {})
        
        # 2. Phase / Status Logic
        # Heuristic: Check conditions first for deeper info (e.g. PodScheduled=False)
        phase = status_obj.get('phase') or 'Unknown'
        reason = status_obj.get('reason')
        if reason: 
             phase = reason

        # 3. Containers
        containers = []
        # Combine initContainers and regular containers status
        all_statuses = status_obj.get('initContainerStatuses', []) + status_obj.get('containerStatuses', [])
        
        for cs in all_statuses:
            c_name = cs.get('name', 'unknown')
            c_image = cs.get('image', 'unknown')
            c_ready = cs.get('ready', False)
            c_restarts = cs.get('restartCount', 0)
            
            # State parsing
            state_obj = cs.get('state', {})
            c_state = "Unknown"
            c_reason = None
            c_msg = None
            
            if 'running' in state_obj:
                c_state = "Running"
            elif 'waiting' in state_obj:
                c_state = "Waiting"
                c_reason = state_obj['waiting'].get('reason')
                c_msg = state_obj['waiting'].get('message')
            elif 'terminated' in state_obj:
                c_state = "Terminated"
                c_reason = state_obj['terminated'].get('reason')
                c_msg = state_obj['terminated'].get('message')
            
            containers.append(K8sContainer(
                name=c_name,
                image=c_image,
                ready=c_ready,
                restartCount=c_restarts,
                state=c_state,
                reason=c_reason,
                message=c_msg
            ))
            
        return cls(
            name=name,
            namespace=namespace,
            status=phase,
            nodeName=data.get('spec', {}).get('nodeName'),
            podIP=status_obj.get('podIP'),
            startTime=status_obj.get('startTime'),
            labels=labels,
            containers=containers
        )

class K8sEvent(BaseModel):
    type: str = "Normal" # Normal, Warning
    reason: str = "Unknown"
    message: str = ""
    object: str # involvedObject.kind/name
    count: int = 1
    first_timestamp: Optional[str] = Field(None, alias="firstTimestamp")
    last_timestamp: Optional[str] = Field(None, alias="lastTimestamp")

    def summary(self) -> str:
        return f"[{self.type}] {self.reason} on {self.object}: {self.message} (x{self.count})"

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'K8sEvent':
        obj = data.get('involvedObject', {})
        obj_ref = f"{obj.get('kind', 'Unknown')}/{obj.get('name', 'unknown')}"
        
        return cls(
            type=data.get('type', 'Normal'),
            reason=data.get('reason', 'Unknown'),
            message=data.get('message', ''),
            object=obj_ref,
            count=data.get('count', 1),
            firstTimestamp=data.get('firstTimestamp'),
            lastTimestamp=data.get('lastTimestamp')
        )

class K8sDeployment(BaseModel):
    name: str
    namespace: str
    replicas: int = 0
    ready_replicas: int = Field(0, alias="readyReplicas")
    available_replicas: int = Field(0, alias="availableReplicas")
    unavailable_replicas: int = Field(0, alias="unavailableReplicas")
    conditions: List[Dict[str, Any]] = [] # Available, Progressing

    @property
    def is_healthy(self) -> bool:
        return self.ready_replicas == self.replicas
    
    def summary(self) -> str:
        failed_conds = [c.get('type') for c in self.conditions if c.get('status') == 'False']
        cond_str = f" Conditions: {failed_conds}" if failed_conds else ""
        return f"Deployment {self.name}: {self.ready_replicas}/{self.replicas} ready.{cond_str}"

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'K8sDeployment':
        metadata = data.get('metadata', {})
        status = data.get('status', {})
        spec = data.get('spec', {})
        
        return cls(
            name=metadata.get('name', 'unknown'),
            namespace=metadata.get('namespace', 'default'),
            replicas=spec.get('replicas', 0) or 0, # spec can be None?
            readyReplicas=status.get('readyReplicas', 0),
            availableReplicas=status.get('availableReplicas', 0),
            unavailableReplicas=status.get('unavailableReplicas', 0),
            conditions=status.get('conditions', [])
        )

class K8sNode(BaseModel):
    name: str
    status: str = "Unknown" # Ready, NotReady
    conditions: List[Dict[str, Any]] = []

    def summary(self) -> str:
        return f"Node {self.name} ({self.status})"

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'K8sNode':
        metadata = data.get('metadata', {})
        status_obj = data.get('status', {})
        
        # Parse status condition 'Ready'
        status_str = "NotReady"
        conditions = status_obj.get('conditions', [])
        for c in conditions:
            if c.get('type') == 'Ready':
                if c.get('status') == 'True':
                    status_str = "Ready"
                else:
                    status_str = f"NotReady ({c.get('reason')})"
                break
                
        return cls(
            name=metadata.get('name', 'unknown'),
            status=status_str,
            conditions=conditions
        )
