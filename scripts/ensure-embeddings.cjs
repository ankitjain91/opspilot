#!/usr/bin/env node
/**
 * Ensure kb_embeddings.json is up-to-date before build.
 *
 * As of v0.2.5+, embeddings can be generated at RUNTIME via the AI Settings UI.
 * This script now:
 * - Skips if SKIP_EMBEDDINGS=1 (default in CI)
 * - Skips if kb_embeddings.json already exists (bundled builds)
 * - Warns but does NOT fail if Ollama is unavailable
 * - Only generates if explicitly requested AND Ollama is running
 *
 * The app will work without pre-generated embeddings - users can generate
 * them at runtime via AI Settings > "Generate" button after downloading
 * nomic-embed-text model.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const OUTPUT = path.join(ROOT, 'src-tauri', 'resources', 'kb_embeddings.json');
const PY_SCRIPT = path.join(ROOT, 'scripts', 'generate_embeddings.py');

const log = (msg) => console.log(`[embeddings] ${msg}`);
const warn = (msg) => console.warn(`[embeddings] WARNING: ${msg}`);

// Skip in CI or when explicitly disabled
if (process.env.SKIP_EMBEDDINGS === '1' || process.env.CI === 'true') {
  log('Skipping embeddings generation (CI or SKIP_EMBEDDINGS=1).');
  log('Users can generate embeddings at runtime via AI Settings.');
  process.exit(0);
}

// If embeddings already exist, skip (they can be generated at runtime if needed)
if (fs.existsSync(OUTPUT)) {
  const stats = fs.statSync(OUTPUT);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  log(`Embeddings file exists (${sizeMB}MB). Skipping generation.`);
  log('Delete the file to regenerate, or use SKIP_EMBEDDINGS=1 to skip.');
  process.exit(0);
}

// No embeddings file - warn but don't fail
log('No pre-computed embeddings found.');
log('Embeddings can be generated at runtime via AI Settings.');
log('');
log('To generate embeddings locally (optional):');
log('  1. Install Ollama: brew install ollama (macOS)');
log('  2. Pull model: ollama pull nomic-embed-text');
log('  3. Run: python3 scripts/generate_embeddings.py');
log('');

// Attempt generation only if user explicitly wants it
if (process.env.GENERATE_EMBEDDINGS === '1') {
  log('GENERATE_EMBEDDINGS=1 set, attempting to generate...');

  // Check python3 exists or use venv
  const venvPythonRef = path.join(ROOT, '.venv-build', 'bin', 'python3');
  const venvPythonWin = path.join(ROOT, '.venv-build', 'Scripts', 'python.exe');
  const isWindows = process.platform === 'win32';

  let pythonCmd = isWindows ? 'python' : 'python3';  // Windows often uses 'python' not 'python3'
  if (fs.existsSync(venvPythonRef)) {
    log('Using local venv python: ' + venvPythonRef);
    pythonCmd = venvPythonRef;
  } else if (fs.existsSync(venvPythonWin)) {
    log('Using local venv python: ' + venvPythonWin);
    pythonCmd = venvPythonWin;
  }

  const pyCheck = spawnSync(pythonCmd, ['-V'], { encoding: 'utf8', shell: isWindows });
  if (pyCheck.error) {
    warn(`${pythonCmd} not found. Cannot generate embeddings.`);
    process.exit(0); // Don't fail - runtime generation available
  }

  log('Generating embeddings using Ollama nomic-embed-text...');
  const run = spawnSync(pythonCmd, [PY_SCRIPT], { stdio: 'inherit', cwd: ROOT, shell: isWindows });
  if (run.status !== 0) {
    warn('Embedding generation failed (Ollama may not be running).');
    warn('Users can generate embeddings at runtime via AI Settings.');
    process.exit(0); // Don't fail build
  }

  log('Embeddings generated successfully.');
} else {
  log('Skipping generation. Set GENERATE_EMBEDDINGS=1 to generate locally.');
}

process.exit(0);
