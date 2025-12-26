
import os
import json
import httpx
import fnmatch
from typing import List, Optional

# Local implementations to avoid circular imports with server.py
def _get_secret(key: str) -> str | None:
    """Get secret from keyring."""
    try:
        import keyring
        return keyring.get_password("opspilot", key)
    except Exception:
        return None

def _load_opspilot_config() -> dict:
    """Load OpsPilot config from ~/.opspilot/config.json."""
    config_path = os.path.join(os.path.expanduser("~"), ".opspilot", "config.json")
    try:
        with open(config_path) as f:
            return json.load(f)
    except Exception:
        return {}

async def search_github_code(query: str, repo_filter: Optional[str] = None, file_pattern: Optional[str] = None) -> str:
    """
    Search for code in GitHub repositories using the REST API.

    Args:
        query: The search term (e.g., class name, config key, error message substring).
        repo_filter: Specific repo to search (e.g., "owner/repo"). If None, uses config settings.
        file_pattern: Glob pattern to filter filenames (e.g., "*.java", "config.yaml").

    Returns:
        Markdown formatted string with search results and snippets.
    """
    import base64
    import urllib.parse

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
        if repo_filter:
            # Explicit repo filter provided - search only that repo
            q = f"{query} repo:{repo_filter}"
        elif search_all_repos:
            # Global search mode - search ALL repos user has access to
            # Don't add any repo: qualifier, GitHub will search all accessible repos
            q = query
        elif configured_repos:
            # Search only configured repos
            # We'll do individual searches for each repo
            pass
        else:
            return "Error: No repositories configured. Enable 'Search All Accessible Repos' in Settings, or add specific repositories."

        # Add file pattern qualifier if provided
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
            q_with_pattern = q if 'q' in dir() else None

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
            """Execute a search and return formatted results."""
            results = []
            encoded_q = urllib.parse.quote(search_query)
            try:
                resp = await client.get(
                    f"https://api.github.com/search/code?q={encoded_q}&per_page=10",
                    headers=headers
                )

                if resp.status_code == 200:
                    data = resp.json()
                    items = data.get("items", [])
                    total_count = data.get("total_count", 0)

                    if total_count > 0:
                        results.append(f"**Found {total_count} results** {scope_label}")

                    for item in items[:5]:  # Limit to top 5 matches
                        path = item.get("path", "")
                        html_url = item.get("html_url", "")
                        repo_name = item.get("repository", {}).get("full_name", "unknown")

                        # Client-side pattern filtering
                        if file_pattern and not fnmatch.fnmatch(path, file_pattern):
                            continue

                        snippet = await fetch_snippet(item)
                        results.append(f"### [{repo_name}] {path}\n[View on GitHub]({html_url})\n```\n{snippet}\n```")

                elif resp.status_code == 401:
                    return ["Error: Invalid GitHub Personal Access Token (401). Please check your token in Settings."]
                elif resp.status_code == 403:
                    # Check if it's rate limiting
                    remaining = resp.headers.get("X-RateLimit-Remaining", "?")
                    return [f"Error: GitHub API Forbidden (403). Rate limit remaining: {remaining}. Try again later."]
                elif resp.status_code == 422:
                    return [f"Error: GitHub search query invalid (422). Query: {search_query[:100]}..."]
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
            # Search each configured repo individually
            for repo in configured_repos[:5]:  # Limit to first 5 repos to avoid rate limits
                repo_query = f"{query} repo:{repo}"
                if file_pattern and "*" not in file_pattern:
                    repo_query += f" filename:{file_pattern}"
                repo_results = await search_repos(repo_query, f"in {repo}")
                results_summary.extend(repo_results)

    if not results_summary:
        scope = repo_filter if repo_filter else ("all accessible repos" if search_all_repos else ", ".join(configured_repos[:3]))
        return f"No results found for '{query}' in {scope}."

    return "\n\n".join(results_summary)
