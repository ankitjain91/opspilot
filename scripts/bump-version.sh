#!/bin/bash
# Version bump script - updates version in all relevant files

set -e

if [ -z "$1" ]; then
    echo "Usage: ./scripts/bump-version.sh <new-version>"
    echo "Example: ./scripts/bump-version.sh 0.2.145"
    exit 1
fi

NEW_VERSION="$1"

echo "Bumping version to $NEW_VERSION..."

# Update package.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" package.json
echo "✓ package.json"

# Update Python version file
cat > python/agent_server/_version.py << EOF
"""Auto-generated version file - do not edit"""
__version__ = "$NEW_VERSION"
EOF
echo "✓ python/agent_server/_version.py"

# Update tauri.conf.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json
echo "✓ src-tauri/tauri.conf.json"

# Update Cargo.toml (package version on line 3)
sed -i '' '3s/version = "[^"]*"/version = "'"$NEW_VERSION"'"/' src-tauri/Cargo.toml
echo "✓ src-tauri/Cargo.toml"

echo ""
echo "Version updated to $NEW_VERSION in all files:"
grep -h "version" package.json src-tauri/tauri.conf.json | head -2
grep "__version__" python/agent_server/_version.py
grep "^version = " src-tauri/Cargo.toml | head -1
