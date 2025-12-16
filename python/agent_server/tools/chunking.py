from typing import Dict, Any, List
import re

def chunk_yaml(yaml_text: str) -> List[str]:
    parts = []
    current = []
    for line in yaml_text.split('\n'):
        if re.match(r'^kind:\s*', line) and current:
            parts.append('\n'.join(current).strip())
            current = []
        current.append(line)
    if current:
        parts.append('\n'.join(current).strip())
    return parts

def chunk_logs(log_text: str, window: int = 120) -> List[str]:
    lines = log_text.split('\n')
    chunks = []
    for i in range(0, len(lines), window):
        chunk = '\n'.join(lines[i:i+window]).strip()
        if chunk:
            chunks.append(chunk)
    return chunks

def chunk_events(events_text: str) -> List[str]:
    # Simple split by blank lines or timestamp markers
    parts = re.split(r"\n\s*\n|\n\d{4}-\d{2}-\d{2}T", events_text)
    return [p.strip() for p in parts if p.strip()]

def annotate_chunk_metadata(kind: str = None, name: str = None, namespace: str = None, container: str = None, timestamp: str = None, reason: str = None) -> Dict[str, Any]:
    return {
        "kind": kind,
        "name": name,
        "namespace": namespace,
        "container": container,
        "timestamp": timestamp,
        "reason": reason,
    }
