
import os
import json
import httpx
import fnmatch
from typing import List, Optional

# Local implementations to avoid circular imports with server.py
OPSPILOT_SECRETS_PATH = os.path.join(os.path.expanduser("~"), ".opspilot", "secrets.enc")

def _get_machine_key() -> bytes:
    """Get a machine-specific key for obfuscating secrets."""
    import hashlib
    identity = f"{os.getenv('USER', 'user')}:{os.path.expanduser('~')}:opspilot"
    return hashlib.sha256(identity.encode()).digest()

def _deobfuscate(encoded: str) -> str:
    """Deobfuscate a string."""
    import base64
    key = _get_machine_key()
    obfuscated = base64.b64decode(encoded.encode('ascii'))
    data = bytes(b ^ key[i % len(key)] for i, b in enumerate(obfuscated))
    return data.decode('utf-8')

def _load_local_secrets() -> dict:
    """Load secrets from local encrypted file."""
    if not os.path.exists(OPSPILOT_SECRETS_PATH):
        return {}
    try:
        with open(OPSPILOT_SECRETS_PATH, 'r') as f:
            encoded_data = json.load(f)
        return {k: _deobfuscate(v) for k, v in encoded_data.items()}
    except Exception:
        return {}

def _get_secret(key: str) -> str | None:
    """Get secret from local encrypted file or environment variables."""
    # 1. Try local encrypted file first
    local_secrets = _load_local_secrets()
    if key in local_secrets and local_secrets[key]:
        return local_secrets[key]

    # 2. Fallback to environment variable
    env_key = key.upper()
    env_value = os.environ.get(env_key)
    if env_value:
        return env_value

    # Also try OPSPILOT_ prefixed version
    prefixed_key = f"OPSPILOT_{env_key}"
    prefixed_value = os.environ.get(prefixed_key)
    if prefixed_value:
        return prefixed_value

    return None

def _load_opspilot_config() -> dict:
    """Load OpsPilot config from ~/.opspilot/config.json."""
    config_path = os.path.join(os.path.expanduser("~"), ".opspilot", "config.json")
    try:
        with open(config_path) as f:
            return json.load(f)
    except Exception:
        return {}

async def search_github_code(
    query: str,
    repo_filter: Optional[str] = None,
    file_pattern: Optional[str] = None,
    max_results: int = 15,
    include_snippets: bool = True
) -> str:
    """
    Search for code in GitHub repositories using the REST API.

    Args:
        query: The search term (e.g., class name, config key, error message substring).
        repo_filter: Specific repo to search (e.g., "owner/repo"). If None, uses config settings.
        file_pattern: Glob pattern to filter filenames (e.g., "*.java", "config.yaml").
        max_results: Maximum number of results to display (default: 15, max: 50).
        include_snippets: Whether to fetch and include code snippets (slower but more useful).

    Returns:
        Markdown formatted string with search results and snippets.
    """
    import base64
    import urllib.parse

    # Cap max_results to avoid excessive API calls
    max_results = min(max_results, 50)

    # 1. Securely retrieve PAT
    pat = _get_secret("github_token")
    if not pat:
        return "Error: GitHub Personal Access Token (PAT) not configured. Please add it in Settings -> Code Search."

    # 2. Load config and determine search mode
    config = _load_opspilot_config()
    search_all_repos = config.get("github_search_all_repos", True)  # Default to global search
    configured_repos = config.get("github_repos", [])

    headers = {
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github.v3+json"
    }

    results_summary = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Build the search query
        q = None  # Initialize to None
        if repo_filter:
            # Explicit repo filter provided - search only that repo
            q = f"{query} repo:{repo_filter}"
        elif search_all_repos:
            # Global search mode - search ALL repos user has access to
            # Don't add any repo: qualifier, GitHub will search all accessible repos
            q = query
        elif configured_repos:
            # Search only configured repos
            # We'll do individual searches for each repo (q stays None)
            pass
        else:
            return "Error: No repositories configured. Enable 'Search All Accessible Repos' in Settings, or add specific repositories."

        # Add file pattern qualifier if provided (only if q is set)
        q_with_pattern = None
        if q is not None:
            if file_pattern:
                if "*" not in file_pattern:
                    q_with_pattern = f"{q} filename:{file_pattern}"
                elif file_pattern.startswith("*."):
                    # Convert *.ext to extension:ext
                    ext = file_pattern[2:]
                    q_with_pattern = f"{q} extension:{ext}"
                else:
                    q_with_pattern = q  # Can't easily translate complex patterns
            else:
                q_with_pattern = q

        async def fetch_snippet(item: dict) -> str:
            """Fetch code snippet for a search result."""
            blob_url = item.get("url")
            if not blob_url:
                return "(No content URL)"
            try:
                content_resp = await client.get(blob_url, headers=headers)
                if content_resp.status_code == 200:
                    blob = content_resp.json()
                    if blob.get("encoding") == "base64":
                        raw_content = base64.b64decode(blob.get("content", "")).decode('utf-8', errors='replace')
                        # Find the query in the content and extract context
                        lines = raw_content.splitlines()
                        for i, line in enumerate(lines):
                            if query.lower() in line.lower():
                                start = max(0, i-2)
                                end = min(len(lines), i+3)
                                return "\n".join(lines[start:end])
                        # Fallback: return first 200 chars
                        return raw_content[:200] + "..." if len(raw_content) > 200 else raw_content
            except Exception:
                pass
            return "(Could not fetch content)"

        async def search_repos(search_query: str, scope_label: str) -> List[str]:
            """Execute a search and return formatted results with pagination support."""
            results = []
            encoded_q = urllib.parse.quote(search_query)
            displayed_count = 0
            page = 1
            max_pages = 3  # Limit pagination to avoid excessive API calls

            try:
                while displayed_count < max_results and page <= max_pages:
                    # Request more results per page (up to GitHub's max of 100)
                    per_page = min(30, max_results - displayed_count + 10)  # +10 buffer for filtering
                    resp = await client.get(
                        f"https://api.github.com/search/code?q={encoded_q}&per_page={per_page}&page={page}",
                        headers=headers
                    )

                    if resp.status_code == 200:
                        data = resp.json()
                        items = data.get("items", [])
                        total_count = data.get("total_count", 0)

                        # Add summary header only on first page
                        if page == 1 and total_count > 0:
                            results.append(f"**Found {total_count} results** {scope_label} (showing up to {max_results})")

                        if not items:
                            break  # No more results

                        for item in items:
                            if displayed_count >= max_results:
                                break

                            path = item.get("path", "")
                            html_url = item.get("html_url", "")
                            repo_name = item.get("repository", {}).get("full_name", "unknown")

                            # Client-side pattern filtering
                            if file_pattern and not fnmatch.fnmatch(path, file_pattern):
                                continue

                            if include_snippets:
                                snippet = await fetch_snippet(item)
                                results.append(f"### [{repo_name}] {path}\n[View on GitHub]({html_url})\n```\n{snippet}\n```")
                            else:
                                # Compact format without snippets - faster for initial discovery
                                results.append(f"- **[{repo_name}]** `{path}` - [View]({html_url})")

                            displayed_count += 1

                        page += 1

                    elif resp.status_code == 401:
                        return ["Error: Invalid GitHub Personal Access Token (401). Please check your token in Settings."]
                    elif resp.status_code == 403:
                        # Check if it's rate limiting
                        remaining = resp.headers.get("X-RateLimit-Remaining", "?")
                        reset_time = resp.headers.get("X-RateLimit-Reset", "?")
                        return [f"Error: GitHub API rate limited (403). Remaining: {remaining}. Resets at: {reset_time}. Try again later."]
                    elif resp.status_code == 422:
                        return [f"Error: GitHub search query invalid (422). Query too broad or syntax error. Query: `{search_query[:100]}...`"]
                    else:
                        return [f"Error: GitHub API returned {resp.status_code}"]

            except Exception as e:
                return [f"Exception during search: {str(e)}"]

            return results

        # Execute the search based on mode
        if repo_filter or search_all_repos:
            # Single global search or specific repo search
            scope = f"in repo:{repo_filter}" if repo_filter else "across all accessible repositories"
            results_summary = await search_repos(q_with_pattern or q, scope)
        else:
            # Search each configured repo individually (up to 10 repos)
            for repo in configured_repos[:10]:
                repo_query = f"{query} repo:{repo}"
                if file_pattern and "*" not in file_pattern:
                    repo_query += f" filename:{file_pattern}"
                elif file_pattern and file_pattern.startswith("*."):
                    ext = file_pattern[2:]
                    repo_query += f" extension:{ext}"
                repo_results = await search_repos(repo_query, f"in {repo}")
                results_summary.extend(repo_results)

    if not results_summary:
        scope = repo_filter if repo_filter else ("all accessible repos" if search_all_repos else ", ".join(configured_repos[:3]))
        return f"No results found for '{query}' in {scope}."

    return "\n\n".join(results_summary)
