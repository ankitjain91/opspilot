
import os
import glob
import subprocess
from typing import List, Optional, Literal
from pydantic import BaseModel, Field

# --- Tool Models ---

class ListDir(BaseModel):
    tool: Literal["fs_list_dir"]
    path: str = Field(..., description="Absolute path to directory to list")
    recursive: bool = Field(False, description="Whether to list recursively (use with caution on large dirs)")

class ReadFile(BaseModel):
    tool: Literal["fs_read_file"]
    path: str = Field(..., description="Absolute path to file to read")
    max_lines: int = Field(2000, description="Maximum number of lines to read")
    start_line: int = Field(0, description="Start reading from this line (0-indexed)")

class GrepSearch(BaseModel):
    tool: Literal["fs_grep"]
    query: str = Field(..., description="Pattern to search for (regex supported)")
    path: str = Field(..., description="File or directory path to search in")
    recursive: bool = Field(True, description="Search recursively if path is a directory")
    case_insensitive: bool = Field(True, description="Perform case-insensitive search")

class FindFile(BaseModel):
    tool: Literal["fs_find"]
    pattern: str = Field(..., description="Glob pattern to find (e.g., *.ts, config.*)")
    path: str = Field(..., description="Root path to start search from")

# --- Tool Implementation ---

def list_dir(path: str, recursive: bool = False) -> str:
    """List contents of a directory."""
    try:
        if not os.path.exists(path):
            return f"Error: Path '{path}' does not exist."
        if not os.path.isdir(path):
            return f"Error: '{path}' is not a directory."
        
        # Security check: prevent escaping permitted bounds if we had them, 
        # but for this local "lens-killer" agent, we assume user trusts it with their fs.
        # Minimal safeguard: don't list entirely root /
        if path.strip() == "/":
             return "Error: Listing root directory is restricted for safety." 

        if recursive:
            # Use glob/walk but limit depth/count
            items = []
            for root, dirs, files in os.walk(path):
                # Simple depth guard could be added here
                for name in files:
                    items.append(os.path.join(root, name))
                for name in dirs:
                    items.append(os.path.join(root, name))
                if len(items) > 1000:
                    items.append("... (truncated > 1000 items)")
                    break
            return "\n".join(items[:1000])
        else:
            items = os.listdir(path)
            return "\n".join(sorted(items))
    except Exception as e:
        return f"Error listing directory: {str(e)}"

def read_file(path: str, max_lines: int = 2000, start_line: int = 0) -> str:
    """Read contents of a file."""
    try:
        if not os.path.exists(path):
            return f"Error: File '{path}' does not exist."
        if not os.path.isfile(path):
            return f"Error: '{path}' is not a file."
        
        # Size check
        if os.path.getsize(path) > 10 * 1024 * 1024: # 10MB limit
            return "Error: File is too large (>10MB). Use grep or read partial."

        content = []
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i < start_line:
                    continue
                if i >= start_line + max_lines:
                    content.append(f"\n... (truncated after {max_lines} lines)")
                    break
                content.append(line)
        
        return "".join(content)
    except Exception as e:
        return f"Error reading file: {str(e)}"

def grep_search(query: str, path: str, recursive: bool = True, case_insensitive: bool = True) -> str:
    """Grep text in files using Python regex (Cross-Platform)."""
    import re
    import mmap
    
    try:
        flags = re.IGNORECASE if case_insensitive else 0
        try:
            pattern_re = re.compile(query.encode('utf-8'), flags)
        except re.error as e:
            return f"Error: Invalid regex pattern: {e}"

        matches = []
        MAX_MATCHES = 1000
        total_matches = 0

        # Gather files
        files_to_scan = []
        if os.path.isfile(path):
            files_to_scan.append(path)
        elif os.path.isdir(path):
             if recursive:
                for root, _, files in os.walk(path):
                    for name in files:
                        files_to_scan.append(os.path.join(root, name))
             else:
                 for name in os.listdir(path):
                     full = os.path.join(path, name)
                     if os.path.isfile(full):
                         files_to_scan.append(full)
        else:
             return f"Error: Path '{path}' not found."

        for file_path in files_to_scan:
            if total_matches >= MAX_MATCHES:
                break
            
            try:
                # Skip binary/large files check (basic)
                if os.path.getsize(file_path) > 10 * 1024 * 1024:
                    continue
                
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    for i, line in enumerate(f, 1):
                        # Simple string check first for speed if no special regex chars
                        # But user asked for regex support.
                        # Let's use search
                        if case_insensitive:
                            if re.search(query, line, re.IGNORECASE):
                                matches.append(f"{file_path}:{i}:{line.strip()}")
                                total_matches += 1
                        else:
                             if re.search(query, line):
                                matches.append(f"{file_path}:{i}:{line.strip()}")
                                total_matches += 1
                        
                        if total_matches >= MAX_MATCHES:
                             matches.append("... (truncated limit reached)")
                             break
            except Exception:
                continue # Skip unreadable files

        if not matches:
             return "No matches found."
             
        return "\n".join(matches)

    except Exception as e:
        return f"Error running grep: {str(e)}"

def text_result_empty(returncode: int) -> str:
    if returncode == 1:
        return "No matches found."
    return f"Grep failed with exit code {returncode}"

def find_files(pattern: str, path: str) -> str:
    """Find files matching a glob pattern (cross-platform)."""
    import platform
    import glob

    try:
        if platform.system() == "Windows":
            # Use Python's glob for cross-platform compatibility
            search_pattern = os.path.join(path, "**", pattern)
            matches = glob.glob(search_pattern, recursive=True)
            if matches:
                return "\n".join(matches)
            return "No files found."
        else:
            # Use `find` command on Unix for speed
            cmd = ["find", path, "-name", pattern]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            return result.stdout if result.stdout else "No files found."
    except Exception as e:
        return f"Error finding files: {str(e)}"

