import os
import subprocess
from typing import List, Optional, Literal
from pydantic import BaseModel, Field


# Note: LocateSource model definition moved to .definitions to avoid circular imports


def locate_source(file_pattern: str, line_number: Optional[int], project_mappings: List[dict], search_paths: List[str] = None) -> str:
    """
    Locate a file in mapped local directories or search all workspaces (Smart Discovery).
    
    Args:
        file_pattern: Path segment from stack trace (e.g., "src/main/java/com/example/App.java")
        line_number: Optional line number
        project_mappings: List of {image_pattern: str, local_path: str}
        search_paths: List of workspace root paths to search if no mapping found (Zero-Config)
        
    Returns:
        String description of location with deep link or error message.
    """
    # Extract filename from pattern for faster search
    filename = os.path.basename(file_pattern)
    search_subpath = file_pattern # Use full pattern for validation match
    
    found_paths = []
    
    # helper to search a root
    def search_root(root_path):
        results = []
        if not os.path.isdir(root_path):
            return results
            
        for root, _, files in os.walk(root_path):
             if filename in files:
                 full_path = os.path.join(root, filename)
                 
                 # Heuristic: does the full path contain the search subpath?
                 # e.g. search="com/foo/Bar.java", found="/root/src/com/foo/Bar.java" -> Match
                 norm_full = full_path.replace('\\', '/')
                 norm_search = search_subpath.replace('\\', '/')
                 
                 if norm_search in norm_full:
                     results.append(full_path)
        return results

    # 1. Try explicit mappings first (Priority)
    if project_mappings:
        for mapping in project_mappings:
            local_root = os.path.expanduser(mapping.get('local_path', ''))
            found_paths.extend(search_root(local_root))

    # 2. If no mappings or no results, try all workspaces (Zero-Config Smart Search)
    if not found_paths and search_paths:
        print(f"[code_nav] No mapping match. Trying smart search in workspaces: {search_paths}", flush=True)
        for ws_path in search_paths:
            found_paths.extend(search_root(ws_path))

    if not found_paths:
        mapped_msg = "" if project_mappings else " (No mappings configured)"
        ws_msg = "" if search_paths else " (No open workspaces)"
        return f"Could not find '{file_pattern}' in local files.{mapped_msg}{ws_msg} Try standard 'fs_find' or 'github_smart_search'."
    
    # Deduplicate
    found_paths = list(set(found_paths))

    # Format result
    results = []
    for path in found_paths:
        link = f"vscode://file/{path}"
        if line_number:
            link += f":{line_number}"
        
        results.append(f"Found: [{path}]({link})")
        
    return "\n".join(results)
