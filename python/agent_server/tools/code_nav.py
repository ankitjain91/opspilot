import os
import subprocess
from typing import List, Optional, Literal
from pydantic import BaseModel, Field


# Note: LocateSource model definition moved to .definitions to avoid circular imports


def locate_source(file_pattern: str, line_number: Optional[int], project_mappings: List[dict]) -> str:
    """
    Locate a file in mapped local directories.
    
    Args:
        file_pattern: Path segment from stack trace (e.g., "src/main/java/com/example/App.java")
        line_number: Optional line number
        project_mappings: List of {image_pattern: str, local_path: str}
        
    Returns:
        String description of location with deep link or error message.
    """
    if not project_mappings:
        return "No project source mappings configured. Please configure them in Settings -> Smart Code Discovery."

    # Extract filename from pattern for faster search
    filename = os.path.basename(file_pattern)
    search_subpath = file_pattern # Use full pattern for validation match
    
    found_paths = []

    for mapping in project_mappings:
        local_root = os.path.expanduser(mapping.get('local_path', ''))
        if not os.path.isdir(local_root):
            continue
            
        # Use simple recursive search for the filename
        # This is basic; for large repos 'fd' or 'find' is better, but this handles cross-platform Python
        for root, _, files in os.walk(local_root):
             if filename in files:
                 full_path = os.path.join(root, filename)
                 
                 # Heuristic: does the full path contain the search subpath?
                 # e.g. search="com/foo/Bar.java", found="/root/src/com/foo/Bar.java" -> Match
                 # Normalizing separators is important
                 norm_full = full_path.replace('\\', '/')
                 norm_search = search_subpath.replace('\\', '/')
                 
                 if norm_search in norm_full:
                     found_paths.append(full_path)
                     # Stop after first good match per mapping? Maybe continue to find ambiguous matches.
                     break
    
    if not found_paths:
        return f"Could not find '{file_pattern}' in any mapped usage directories."
    
    # Format result
    results = []
    for path in found_paths:
        link = f"vscode://file/{path}"
        if line_number:
            link += f":{line_number}"
        
        results.append(f"Found: [{path}]({link})")
        
    return "\n".join(results)
