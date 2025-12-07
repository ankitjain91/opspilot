#!/usr/bin/env python3
"""
Generate embeddings for the knowledge base documents and tools.
Run this at build time to create kb_embeddings.json

Usage: python scripts/generate_embeddings.py
Output: src-tauri/resources/kb_embeddings.json
"""

import json
import os
from pathlib import Path

# Install: pip install sentence-transformers
from sentence_transformers import SentenceTransformer

# Model config
MODEL_NAME = "all-MiniLM-L6-v2"
DIMENSION = 384

# Paths relative to project root
PROJECT_ROOT = Path(__file__).parent.parent
KNOWLEDGE_DIR = PROJECT_ROOT / "knowledge"
OUTPUT_FILE = PROJECT_ROOT / "src-tauri" / "resources" / "kb_embeddings.json"

# Tool descriptions for semantic tool matching - extremely comprehensive with scenarios
TOOL_DESCRIPTIONS = {
    # Core diagnostic tools
    "CLUSTER_HEALTH": "cluster health status overview summary dashboard nodes pods deployments ready running failed crashed pending unhealthy how is cluster doing overall status check system health monitoring is my cluster ok general cluster state all resources summary tell me about the cluster",
    
    "GET_EVENTS": "events warnings errors alerts recent activity problems issues namespace cluster what happened logs event stream timeline notifications watch changes updates failures show me events recent errors warning messages what went wrong event history kubernetes events",
    
    "LIST_ALL": "list all show resources pods deployments services configmaps secrets namespaces statefulsets daemonsets replicasets jobs cronjobs pvcs ingress enumerate find discover inventory catalog what resources exist show me all pods list deployments get all services find resources in namespace",
    
    "DESCRIBE": "describe resource details full information configuration status yaml spec metadata conditions events verbose deep dive examine inspect analyze show me more about get details of explain resource tell me about specific resource describe pod describe deployment describe service full yaml config",
    
    "GET_LOGS": "logs pod container application output stdout stderr print crash error debug trace messages what is happening inside container log tail follow streaming console output show me logs pod logs container logs application logs why is pod crashing error messages debug logs",
    
    "TOP_PODS": "resource usage cpu memory metrics consumption pods containers performance utilization how much resources who is using most resources memory pressure cpu throttling performance monitoring resource metrics pod cpu pod memory node resources high cpu high memory",
    
    "FIND_ISSUES": "problems issues unhealthy failing broken not working resources errors warnings diagnosis what is wrong troubleshoot debug detect find crashed pending stuck failed not ready why is something broken scan for issues health check find problems automatic diagnosis",
    
    "SEARCH_KNOWLEDGE": "troubleshooting guide documentation how-to reference knowledge best practices runbook playbook solution help information learn about explain what is how do i fix how to solve documentation search kb search knowledge base article",
    
    "GET_ENDPOINTS": "service endpoints networking connectivity routing backend pods ip addresses port mappings service discovery connection between services unreachable cannot connect service not reachable endpoint addresses backend ips pod ips service routing",
    
    "GET_NAMESPACE": "namespace status phase terminating active stuck deletion finalizers cannot delete namespace hanging namespace details information namespace stuck deleting namespace won't delete namespace info",
    
    "LIST_FINALIZERS": "finalizers blocking deletion stuck resources cleanup cannot delete hanging permanently terminating resource finalizer removal orphan kubernetes cleanup stuck deleting finalizer what is blocking deletion remove finalizers",
    
    # Platform and infrastructure tools
    "GET_CROSSPLANE": "crossplane managed resources providers compositions claims xr composite cloud aws azure gcp infrastructure as code external resources cloud provisioning terraform alternative crossplane status provider health managed resource status azure resources aws resources gcp resources upbound",
    
    "GET_ISTIO": "istio service mesh gateway virtualservice destinationrule sidecar envoy proxy mtls traffic routing ingress load balancing traffic management microservices networking istio status proxy configuration istio gateway istio routing 503 error 404 not found routing issues",
    
    "GET_WEBHOOKS": "admission webhook validating mutating certificate configuration blocking create resource stuck webhook failure admission controller policy enforcement security webhook timeout cannot create resource webhook blocking creation admission webhook error",
    
    "GET_UIPATH": "uipath automation suite orchestrator robot aicenter action center asea rpa process automation automation suite pods status orchestrator health robots connection document understanding automation suite status uipath pods uipath namespace",
    
    # New specialized tools  
    "GET_CAPI": "cluster api capi cluster machine machinedeployment machineset kubeadmcontrolplane infrastructure bootstrap controlplane provisioning phase multi-cluster management cluster provisioning machine status node provisioning infrastructure cluster capi clusters cluster.x-k8s.io",
    
    "GET_CASTAI": "castai cast ai autoscaler cost optimization node configuration rebalancing hibernation spot instances node templates kubernetes optimization cluster optimization node scaling cost reduction cast ai status autoscaling",
    
    "VCLUSTER_CMD": "vcluster virtual cluster connect inside kubectl run command nested cluster management cluster customer cluster vcluster connect run command in vcluster execute inside vcluster vcluster kubectl",
    
    "GET_UIPATH_CRD": "customercluster managementcluster uipath dedicated crds custom resources asfailed infrainprogress customer cluster management cluster provisioning customercluster status managementcluster status uipath crd dedicated.uipath.com customer cluster state management cluster ready",
    
    # Power tools
    "RUN_KUBECTL": "run kubectl command custom query bash pipe grep awk sed filter search sort head tail wc count advanced query jsonpath custom format output transform data shell command line powerful flexible custom kubectl command run any kubectl arbitrary kubectl shell pipe filter results"
}


def load_json_doc(filepath: Path) -> list[dict]:
    """Load and extract text content from a JSON knowledge file."""
    with open(filepath, 'r') as f:
        data = json.load(f)
    
    docs = []
    
    # Handle both single objects and arrays
    items = data if isinstance(data, list) else [data]
    
    for item in items:
        if not isinstance(item, dict):
            continue
            
        doc_id = item.get('id', filepath.stem)
        title = item.get('title', filepath.stem.replace('-', ' ').title())
        summary = item.get('summary', '')
        
        # Collect all text content from nested structures
        content_parts = [title, summary]
        
        # Extract from all known content keys
        for key in ['common_errors', 'commands', 'diagnostic_workflows', 'best_practices',
                    'job_basics', 'debugging_workflow', 'job_patterns', 'concepts',
                    'connectivity_basics', 'node_inspection', 'status_overview',
                    'service_basics', 'storage_basics', 'causes', 'symptoms',
                    'scenarios', 'patterns', 'examples']:
            if key in item:
                content_parts.append(extract_text(item[key]))
        
        content = ' '.join(filter(None, content_parts))
        if content.strip():
            docs.append({
                'id': doc_id,
                'file': filepath.name,
                'title': title,
                'content': content[:3000]  # Limit for embedding
            })
    
    return docs


def load_md_doc(filepath: Path) -> list[dict]:
    """Load markdown knowledge file."""
    with open(filepath, 'r') as f:
        content = f.read()
    
    return [{
        'id': filepath.stem,
        'file': filepath.name,
        'title': filepath.stem.replace('-', ' ').title(),
        'content': content[:2000]
    }]


def extract_text(obj, depth=0) -> str:
    """Recursively extract text from nested structures."""
    if depth > 5:
        return ''
    
    if isinstance(obj, str):
        return obj
    elif isinstance(obj, list):
        return ' '.join(extract_text(item, depth+1) for item in obj)
    elif isinstance(obj, dict):
        parts = []
        for key, value in obj.items():
            if key in ['command', 'description', 'name', 'title', 'summary', 
                       'symptoms', 'likely_causes', 'fix_steps', 'error_patterns',
                       'meaning', 'first_steps', 'what_to_look_for', 'when_to_use']:
                parts.append(extract_text(value, depth+1))
        return ' '.join(parts)
    return ''


def main():
    print(f"Loading model: {MODEL_NAME}")
    model = SentenceTransformer(MODEL_NAME)
    
    # Load all knowledge documents
    print(f"\nLoading documents from: {KNOWLEDGE_DIR}")
    all_docs = []
    
    for filepath in KNOWLEDGE_DIR.glob("*.json"):
        if filepath.name == "kb-index.json":
            continue
        docs = load_json_doc(filepath)
        all_docs.extend(docs)
        print(f"  {filepath.name}: {len(docs)} doc(s)")
    
    for filepath in KNOWLEDGE_DIR.glob("*.md"):
        docs = load_md_doc(filepath)
        all_docs.extend(docs)
        print(f"  {filepath.name}: {len(docs)} doc(s)")
    
    print(f"\nTotal documents: {len(all_docs)}")
    
    # Generate document embeddings
    print("\nGenerating document embeddings...")
    doc_texts = [f"{d['title']} {d['content']}" for d in all_docs]
    doc_embeddings = model.encode(doc_texts, show_progress_bar=True)
    
    for i, doc in enumerate(all_docs):
        doc['embedding'] = doc_embeddings[i].tolist()
        # Keep a clean summary (first 500 chars) for display, remove full content
        content = doc.get('content', '')
        # Extract first meaningful paragraph or sentences
        lines = [l.strip() for l in content.split('\n') if l.strip() and not l.strip().startswith('{')]
        summary = ' '.join(lines)[:500]
        if len(summary) == 500:
            summary = summary.rsplit(' ', 1)[0] + '...'
        doc['summary'] = summary
        del doc['content']  # Don't store full content in embeddings file
    
    # Generate tool embeddings
    print("\nGenerating tool embeddings...")
    tool_docs = []
    tool_texts = list(TOOL_DESCRIPTIONS.values())
    tool_embeddings = model.encode(tool_texts)
    
    for i, (name, desc) in enumerate(TOOL_DESCRIPTIONS.items()):
        tool_docs.append({
            'name': name,
            'description': desc,
            'embedding': tool_embeddings[i].tolist()
        })
    
    # Save output
    output = {
        'model': MODEL_NAME,
        'dimension': DIMENSION,
        'documents': all_docs,
        'tools': tool_docs
    }
    
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(output, f)
    
    file_size = OUTPUT_FILE.stat().st_size / 1024
    print(f"\n✅ Generated: {OUTPUT_FILE}")
    print(f"   Documents: {len(all_docs)}")
    print(f"   Tools: {len(tool_docs)}")
    print(f"   File size: {file_size:.1f} KB")


if __name__ == "__main__":
    main()
