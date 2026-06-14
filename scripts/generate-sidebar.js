/**
 * Auto-generate docs/_sidebar.md from the docs/ directory structure.
 *
 * Usage:  node scripts/generate-sidebar.js
 *
 * Section display names are configured below. Root-level .md files are split
 * into "Getting Started" (the short list) and "Guides" (everything else).
 * Subdirectories are auto-discovered; order is driven by this config.
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.resolve(__dirname, '..', 'docs');
const OUT = path.join(DOCS_DIR, '_sidebar.md');

// ---------- display-name helpers ----------

function titleCase(str) {
  return str
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAnd\b/g, 'and')
    .replace(/\bOr\b/g, 'or')
    .replace(/\bFor\b/g, 'for')
    .replace(/\bThe\b/g, 'the')
    .replace(/\bWith\b/g, 'with')
    .replace(/\bTo\b/g, 'to')
    .replace(/\bVs\b/gi, 'vs')
    .replace(/\bOf\b/g, 'of')
    .replace(/\bIn\b/g, 'in')
    .replace(/\bA\b/g, 'a')
    .replace(/\bOn\b/g, 'on')
    .replace(/\bAs\b/g, 'as')
    .replace(/\bAt\b/g, 'at')
    .replace(/\bBy\b/g, 'by')
    .replace(/\bIs\b/g, 'is')
    .replace(/\bAn\b/g, 'an')
    .replace(/\bGpu\b/gi, 'GPU')
    .replace(/\bApi\b/gi, 'API')
    .replace(/\bUi\b/gi, 'UI')
    .replace(/\bIos\b/gi, 'iOS')
    .replace(/\bE2e\b/gi, 'E2E')
    .replace(/\bJwt\b/gi, 'JWT')
    .replace(/\bCrdt\b/gi, 'CRDT')
    .replace(/\bI18n\b/gi, 'i18n')
    .replace(/\bYaml\b/gi, 'YAML')
    .replace(/\bMd\b/g, 'MD')
    .replace(/\bQa\b/gi, 'QA')
    .replace(/\bCalDav\b/gi, 'CalDAV')
    .replace(/\bVevent\b/gi, 'VEvent')
    .replace(/\bWebdav\b/gi, 'WebDAV')
    .replace(/\bWayland\b/gi, 'Wayland')
    .replace(/\bSnap\b/gi, 'Snap')
    .replace(/\bPr\d\b/gi, (m) => m.toUpperCase())
    .replace(/\bSup\b/gi, 'SUP')
    .replace(/\bSupersync\b/gi, 'SuperSync')
    .replace(/\bOp[s]?\b/gi, (m) => m.toUpperCase())
    .trim();
}

function displayName(filename) {
  let name = filename.replace(/\.md$/, '');
  // strip leading date-prefix (YYYY-MM-DD-) for display
  name = name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  return titleCase(name);
}

// ---------- section config ----------

// Sections whose files are manually picked (root-level only).
// Subdirectory sections are auto-discovered.
const GETTING_STARTED = ['ENV_SETUP.md', 'TRANSLATING.md'];

// Root-level files NOT in Getting Started and NOT excluded become "Guides".
const EXCLUDE_ROOT = ['README.md', '_sidebar.md', 'index.html', 'generate-sidebar.js'];

// Section display order for subdirectories. Directories not listed here
// appear after the listed ones in alphabetical order.
const SUBDIR_ORDER = [
  'plans',
  'long-term-plans',
  'promotion',
  'research',
  'sync-and-op-log',
  'wiki',
];

const SUBDIR_LABELS = {
  plans: 'Plans',
  'long-term-plans': 'Long-term Plans',
  promotion: 'Promotion',
  research: 'Research',
  'sync-and-op-log': 'Sync & Op-log',
  wiki: 'Wiki',
};

// Subdirectories that get a nested sub-section (e.g. sync-and-op-log/diagrams)
const NESTED_SUBDIRS = {
  'sync-and-op-log': ['diagrams'],
};

// ---------- scanning ----------

function scanDir(dir, relativeTo) {
  const entries = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('_') && item.name.endsWith('.md')) continue; // skip sidebar/config markdown
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const full = path.join(dir, item.name);
    const rel = path.relative(relativeTo, full).replace(/\\/g, '/');
    if (item.isFile() && item.name.endsWith('.md')) {
      entries.push({
        rel,
        name: item.name,
        dir: path.dirname(rel) === '.' ? null : path.dirname(rel),
      });
    } else if (item.isDirectory()) {
      entries.push(...scanDir(full, relativeTo));
    }
  }
  return entries;
}

// ---------- main ----------

const allFiles = scanDir(DOCS_DIR, DOCS_DIR);

// Group files by their immediate parent directory
const rootFiles = [];
const subdirGroups = {}; // key: top-level subdir path (e.g. "plans", "sync-and-op-log/diagrams")

for (const f of allFiles) {
  if (EXCLUDE_ROOT.includes(f.name) && !f.dir) continue;
  if (!f.dir) {
    rootFiles.push(f);
  } else {
    const parts = f.dir.split('/');
    const topDir = parts[0];
    // expand nested subdirs into explicit groups
    const groupKey = parts.length > 1 ? f.dir : topDir;
    if (!subdirGroups[groupKey]) subdirGroups[groupKey] = [];
    subdirGroups[groupKey].push(f);
  }
}

// Sort root files
rootFiles.sort((a, b) => a.name.localeCompare(b.name));

// Sort each subgroup
for (const key of Object.keys(subdirGroups)) {
  subdirGroups[key].sort((a, b) => a.rel.localeCompare(b.rel));
}

// Separate Getting Started from Guides
const gettingStarted = rootFiles.filter((f) => GETTING_STARTED.includes(f.name));
const guides = rootFiles.filter((f) => !GETTING_STARTED.includes(f.name));

// Build output
const lines = [];

function addSection(title, indent = '') {
  lines.push(`${indent}- ${title}`);
}

function addFile(rel, indent = '  ') {
  lines.push(`${indent}- [${displayName(path.basename(rel))}](${rel})`);
}

// --- Getting Started ---
addSection('Getting Started');
for (const f of gettingStarted) addFile(f.rel);

// --- Guides ---
addSection('Guides');
for (const f of guides) addFile(f.rel);

// --- Subdirectory sections ---
const orderedKeys = Object.keys(subdirGroups).sort((a, b) => {
  const aTop = a.split('/')[0];
  const bTop = b.split('/')[0];
  const aIdx = SUBDIR_ORDER.indexOf(aTop);
  const bIdx = SUBDIR_ORDER.indexOf(bTop);
  if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
  if (aIdx !== -1) return -1;
  if (bIdx !== -1) return 1;
  return a.localeCompare(b);
});

let lastTopDir = null;
for (const key of orderedKeys) {
  const topDir = key.split('/')[0];
  if (topDir !== lastTopDir) {
    addSection(SUBDIR_LABELS[topDir] || titleCase(topDir));
    lastTopDir = topDir;
  }
  // Nested sub-folder (e.g. "sync-and-op-log/diagrams")
  if (key.includes('/')) {
    const subLabel = titleCase(key.split('/').pop());
    addSection(subLabel, '  ');
  }
  const fileIndent = key.includes('/') ? '    ' : '  ';
  for (const f of subdirGroups[key]) {
    addFile(f.rel, fileIndent);
  }
}

// Ensure trailing newline
const output = lines.join('\n') + '\n';

fs.writeFileSync(OUT, output, 'utf-8');
console.log(`Generated ${OUT} with ${lines.length} lines.`);
