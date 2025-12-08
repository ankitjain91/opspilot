#!/usr/bin/env node
/**
 * Ensure kb_embeddings.json is up-to-date before build.
 * - Skips if SKIP_EMBEDDINGS=1
 * - Rebuilds if missing or older than any knowledge/*.json|*.md file
 * - Requires python3 with sentence_transformers installed
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const OUTPUT = path.join(ROOT, 'src-tauri', 'resources', 'kb_embeddings.json');
const PY_SCRIPT = path.join(ROOT, 'scripts', 'generate_embeddings.py');

const log = (msg) => console.log(`[embeddings] ${msg}`);
const error = (msg) => console.error(`[embeddings] ${msg}`);

if (process.env.SKIP_EMBEDDINGS === '1') {
  log('SKIP_EMBEDDINGS=1 set; skipping embeddings generation.');
  process.exit(0);
}

const fileMtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

function needsRebuild() {
  const outMtime = fileMtime(OUTPUT);
  if (!outMtime) return true;

  const files = fs.readdirSync(KNOWLEDGE_DIR)
    .filter((f) => (f.endsWith('.json') || f.endsWith('.md')) && f !== 'kb-index.json');

  for (const f of files) {
    const m = fileMtime(path.join(KNOWLEDGE_DIR, f));
    if (m > outMtime) return true;
  }
  return false;
}

if (!needsRebuild()) {
  log('Embeddings up-to-date; skipping generation.');
  process.exit(0);
}

// Check python3 exists
const pyCheck = spawnSync('python3', ['-V'], { encoding: 'utf8' });
if (pyCheck.error) {
  error('python3 not found. Install Python 3 to generate embeddings.');
  process.exit(1);
}

// Check sentence_transformers is installed
const stCheck = spawnSync('python3', ['-c', 'import sentence_transformers'], { encoding: 'utf8' });
if (stCheck.status !== 0) {
  error('sentence_transformers is not installed. Run: pip install sentence-transformers');
  process.exit(1);
}

log('Generating embeddings (this may download a model if not cached)...');
const run = spawnSync('python3', [PY_SCRIPT], { stdio: 'inherit', cwd: ROOT });
if (run.status !== 0) {
  error('Embedding generation failed.');
  process.exit(run.status || 1);
}

log('Embeddings generated successfully.');
