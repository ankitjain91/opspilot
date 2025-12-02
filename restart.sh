#!/bin/bash
echo "Killing all lens-killer processes..."
pkill -f "lens-killer" || true
pkill -f "tauri dev" || true

echo "Clearing caches..."
rm -rf dist node_modules/.vite

echo "Starting fresh dev server..."
npm run tauri dev
