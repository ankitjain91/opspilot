
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
    """Grep text in files."""
    try:
        cmd = ["grep", "-n", "-I"] # -n: line numbers, -I: ignore binary
        if recursive and os.path.isdir(path):
            cmd.append("-r")
        if case_insensitive:
            cmd.append("-i")
        
        cmd.append(query)
        cmd.append(path)
        
        # Run grep
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        
        output = result.stdout
        if len(output) > 50000:
             return output[:50000] + "\n... (truncated output)"
        return output if output else text_result_empty(result.returncode)
    except subprocess.TimeoutExpired:
        return "Error: Grep command timed out."
    except Exception as e:
        return f"Error running grep: {str(e)}"

def text_result_empty(returncode: int) -> str:
    if returncode == 1:
        return "No matches found."
    return f"Grep failed with exit code {returncode}"

def find_files(pattern: str, path: str) -> str:
    """Find files matching a glob pattern."""
    try:
        # Use simple os.walk or glob
        # glob.glob(os.path.join(path, "**", pattern), recursive=True) 
        # is easier but standard glob might be slow on huge trees.
        
        # Let's use `find` command if available for speed, else python walk
        cmd = ["find", path, "-name", pattern]
        # Ignore permission errors?
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        return result.stdout if result.stdout else "No files found."
    except Exception as e:
        return f"Error finding files: {str(e)}"

