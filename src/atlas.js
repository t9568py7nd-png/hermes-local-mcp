// Knowledge map over local checkouts: what each repo is, what it exports, where.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './store.js';

export const REPOS_DIR = process.env.HERMES_REPOS_DIR || path.join(os.homedir(), 'hermes-repos');
export const ATLAS_FILE = path.join(DATA_DIR, 'atlas.json');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__',
  'venv', '.venv', 'env', 'coverage', '.pytest_cache', '.mypy_cache', 'target', 'vendor', '.idea', '.vscode']);
const TEXT_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt',
  '.yml', '.yaml', '.toml', '.cfg', '.ini', '.sh', '.html', '.css', '.sql', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.env.example']);
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 2000;
const MAX_SYMBOLS = 400;

const JS_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];

const SYMBOL_PATTERNS = [
  [{ exts: JS_EXTS, re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/ }, 'function'],
  [{ exts: JS_EXTS, re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ }, 'export'],
  [{ exts: ['.py'], re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ }, 'def'],
  [{ exts: ['.py', ...JS_EXTS], re: /^\s*class\s+([A-Za-z_]\w*)/ }, 'class'],
  [{ exts: ['.ts', '.tsx'], re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_]\w*)/ }, 'type'],
  [{ exts: ['.go'], re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ }, 'func'],
];

function walk(root, rel = '', acc = { files: [], truncated: false }) {
  if (acc.files.length >= MAX_FILES) { acc.truncated = true; return acc; }
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.files.length >= MAX_FILES) { acc.truncated = true; break; }
    const relPath = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(root, relPath, acc);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_EXT.has(ext) || entry.name === 'Dockerfile' || entry.name === 'Makefile') {
        acc.files.push({ relPath, ext: ext || entry.name.toLowerCase() });
      }
    }
  }
  return acc;
}

function gitInfo(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h%x09%ad%x09%s', '--date=short'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [hash, date, ...subject] = out.split('\t');
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { branch, commit: hash, date, subject: subject.join('\t') };
  } catch {
    return null;
  }
}

function scanRepo(name) {
  const dir = path.join(REPOS_DIR, name);
  const { files, truncated } = walk(dir);
  const languages = new Map();
  const symbols = [];
  const headings = [];
  const entrypoints = [];
  let loc = 0;
  let readme = '';

  for (const file of files) {
    let text = '';
    try {
      const full = path.join(dir, file.relPath);
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lineCount = text.split('\n').length;
    loc += lineCount;
    const lang = languages.get(file.ext) || { ext: file.ext, files: 0, loc: 0 };
    lang.files += 1;
    lang.loc += lineCount;
    languages.set(file.ext, lang);

    if (/^(main|index|app|server|cli)\.(py|js|mjs|ts|tsx|go|rs)$/.test(path.basename(file.relPath)) ||
        /^(src|app)\/[^/]+\.(py|js|mjs|ts|tsx)$/.test(file.relPath)) {
      entrypoints.push(file.relPath);
    }

    if (file.ext === '.md') {
      if (!readme && /^readme\.md$/i.test(path.basename(file.relPath))) {
        readme = text.replace(/\s+/g, ' ').slice(0, 600).trim();
      }
      for (const line of text.split('\n')) {
        const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
        if (m && headings.length < 60) headings.push(`${m[1]} ${m[2]}`);
      }
      continue;
    }

    if (symbols.length >= MAX_SYMBOLS) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i += 1) {
      for (const [{ exts, re }, kind] of SYMBOL_PATTERNS) {
        if (!exts.includes(file.ext)) continue;
        const m = re.exec(lines[i]);
        if (m) {
          symbols.push({ kind, name: m[1], file: file.relPath, line: i + 1 });
          break;
        }
      }
    }
  }

  const pkgFile = path.join(dir, 'package.json');
  let manifest = null;
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      manifest = {
        file: 'package.json',
        name: pkg.name,
        description: pkg.description,
        scripts: Object.keys(pkg.scripts || {}),
        dependencies: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }),
      };
    } catch { /* malformed manifest is itself worth knowing about */ }
  }
  const reqFile = path.join(dir, 'requirements.txt');
  if (!manifest && fs.existsSync(reqFile)) {
    const deps = fs.readFileSync(reqFile, 'utf8').split('\n').map((l) => l.split(/[=<>!\[]/)[0].trim()).filter(Boolean);
    manifest = { file: 'requirements.txt', dependencies: deps };
  }

  return {
    name,
    path: dir,
    git: gitInfo(dir),
    files: files.length,
    truncated,
    loc,
    languages: [...languages.values()].sort((a, b) => b.loc - a.loc),
    symbols,
    headings: headings.slice(0, 40),
    entrypoints: [...new Set(entrypoints)].slice(0, 20),
    readme,
    manifest,
    scannedAt: new Date().toISOString(),
  };
}

export function scanAtlas() {
  if (!fs.existsSync(REPOS_DIR)) throw new Error(`repos dir not found: ${REPOS_DIR}`);
  const names = fs.readdirSync(REPOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(REPOS_DIR, n, '.git')) || fs.readdirSync(path.join(REPOS_DIR, n)).length > 0)
    .sort();
  const started = Date.now();
  const repos = names.map((name) => {
    try {
      return scanRepo(name);
    } catch (err) {
      return { name, error: err.message };
    }
  });
  const atlas = {
    generatedAt: new Date().toISOString(),
    reposDir: REPOS_DIR,
    durationMs: Date.now() - started,
    totals: {
      repos: repos.length,
      files: repos.reduce((n, r) => n + (r.files || 0), 0),
      loc: repos.reduce((n, r) => n + (r.loc || 0), 0),
      symbols: repos.reduce((n, r) => n + (r.symbols?.length || 0), 0),
    },
    repos,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${ATLAS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(atlas, null, 2));
  fs.renameSync(tmp, ATLAS_FILE);
  return atlas;
}

export function loadAtlas() {
  try {
    return JSON.parse(fs.readFileSync(ATLAS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function atlasRepo(name) {
  const atlas = loadAtlas();
  if (!atlas) throw new Error('no atlas yet; run hermes_atlas_scan first');
  const repo = atlas.repos.find((r) => r.name === name);
  if (!repo) throw new Error(`unknown repo: ${name}`);
  return repo;
}

export function searchAtlas(query, { repo, limit = 25 } = {}) {
  const atlas = loadAtlas();
  if (!atlas) throw new Error('no atlas yet; run hermes_atlas_scan first');
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const hits = [];
  for (const r of atlas.repos) {
    if (repo && r.name !== repo) continue;
    const push = (kind, text, where, score) => hits.push({ repo: r.name, kind, text, where, score });
    if (r.name.toLowerCase().includes(q)) push('repo', r.name, r.path, 10);
    if ((r.readme || '').toLowerCase().includes(q)) push('readme', r.readme.slice(0, 200), 'README', 4);
    for (const s of r.symbols || []) {
      if (s.name.toLowerCase().includes(q)) push(`symbol:${s.kind}`, s.name, `${s.file}:${s.line}`, 6);
      else if (s.file.toLowerCase().includes(q)) push(`symbol:${s.kind}`, s.name, `${s.file}:${s.line}`, 2);
    }
    for (const h of r.headings || []) {
      if (h.toLowerCase().includes(q)) push('heading', h, 'markdown', 3);
    }
    for (const e of r.entrypoints || []) {
      if (e.toLowerCase().includes(q)) push('entrypoint', e, 'root', 5);
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
