import os from 'node:os';
import { countNotes, addNote, deleteNote, searchNotes } from './store.js';
import { scanAtlas, loadAtlas, atlasRepo, searchAtlas, REPOS_DIR } from './atlas.js';

export const SERVER_INFO = {
  name: 'hermes',
  version: '1.0.0',
  title: 'Hermes MCP',
  description: 'A small self-contained MCP server: notes, arithmetic, time and environment info.',
};

const startedAt = Date.now();

// --- tiny arithmetic evaluator (no eval) -------------------------------------
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[0-9.]/.test(c)) {
      let n = '';
      while (i < src.length && /[0-9._]/.test(src[i])) n += src[i++];
      if ((n.match(/\./g) || []).length > 1) throw new Error(`bad number: ${n}`);
      out.push({ t: 'num', v: parseFloat(n.replace(/_/g, '')) });
      continue;
    }
    if ('+-*/%^()'.includes(c)) { out.push({ t: c }); i += 1; continue; }
    throw new Error(`unexpected character: ${c}`);
  }
  return out;
}

function evaluate(src) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => (peek() && peek().t === t ? (p += 1, true) : false);

  function expr() {
    let v = term();
    for (;;) {
      if (eat('+')) v += term();
      else if (eat('-')) v -= term();
      else return v;
    }
  }
  function term() {
    let v = unary();
    for (;;) {
      if (eat('*')) v *= unary();
      else if (eat('/')) {
        const d = unary();
        if (d === 0) throw new Error('division by zero');
        v /= d;
      } else if (eat('%')) v %= unary();
      else return v;
    }
  }
  function unary() {
    if (eat('-')) return -unary();
    if (eat('+')) return unary();
    return power();
  }
  function power() {
    const base = atom();
    if (eat('^')) return Math.pow(base, unary());
    return base;
  }
  function atom() {
    if (eat('(')) {
      const v = expr();
      if (!eat(')')) throw new Error('missing closing parenthesis');
      return v;
    }
    const t = peek();
    if (t && t.t === 'num') { p += 1; return t.v; }
    throw new Error('expected a number or (');
  }

  const value = expr();
  if (p !== toks.length) throw new Error('unexpected trailing input');
  if (!Number.isFinite(value)) throw new Error('result is not finite');
  return value;
}

const notesText = (notes) => notes.length
  ? notes.map((n) => `- [${n.id}] ${n.text}${n.tags.length ? `  (tags: ${n.tags.join(', ')})` : ''}`).join('\n')
  : 'No notes.';

export const tools = [
  {
    name: 'hermes_whoami',
    title: 'Who am I',
    description: 'Identify this MCP server: name, version, pid, uptime and note count.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({
      ...SERVER_INFO,
      pid: process.pid,
      node: process.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      notes: countNotes(),
      transports: ['stdio'],
      dataDir: process.env.HERMES_DATA_DIR || `${os.homedir()}/.hermes-mcp`,
    }),
  },
  {
    name: 'hermes_time',
    title: 'Current time',
    description: 'Current date and time in ISO 8601 and in the given IANA timezone.',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/London (default: UTC)' } },
      additionalProperties: false,
    },
    handler: ({ timezone = 'UTC' }) => {
      const tz = timezone || 'UTC';
      let local;
      try {
        local = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, dateStyle: 'full', timeStyle: 'long',
        }).format(new Date());
      } catch {
        throw new Error(`unknown timezone: ${tz}`);
      }
      return { iso: new Date().toISOString(), timezone: tz, local };
    },
  },
  {
    name: 'hermes_calc',
    title: 'Calculate',
    description: 'Evaluate a basic arithmetic expression with + - * / % ^ and parentheses.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. (2+3)^2 / 5' } },
      required: ['expression'],
      additionalProperties: false,
    },
    handler: ({ expression }) => {
      const value = evaluate(expression);
      return { expression: String(expression), value };
    },
  },
  {
    name: 'hermes_add_note',
    title: 'Add a note',
    description: 'Store a note with optional tags. Notes persist across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Note body' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: ({ text, tags = [] }) => ({ note: addNote({ text, tags }) }),
  },
  {
    name: 'hermes_list_notes',
    title: 'List notes',
    description: 'List stored notes, optionally filtered by a text query and tags.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring match' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only notes having all these tags' },
      },
      additionalProperties: false,
    },
    handler: ({ query = '', tags = [] } = {}) => {
      const notes = searchNotes(query, tags);
      return { count: notes.length, notes, summary: notesText(notes) };
    },
  },
  {
    name: 'hermes_delete_note',
    title: 'Delete a note',
    description: 'Delete a note by its id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id from hermes_list_notes' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: ({ id }) => deleteNote(id),
  },
  {
    name: 'hermes_env_info',
    title: 'Environment info',
    description: 'Runtime host details: platform, arch, cpu count, memory and process uptime.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
      hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()),
      nodeUptimeSeconds: Math.round(process.uptime()),
    }),
  },
  {
    name: 'hermes_atlas_scan',
    title: 'Scan repos into the atlas',
    description: 'Re-index every repo in the local repos dir: languages, line counts, exported symbols, '
      + 'markdown headings, entrypoints and manifests. Returns totals per repo.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const atlas = scanAtlas();
      return {
        generatedAt: atlas.generatedAt,
        reposDir: atlas.reposDir,
        durationMs: atlas.durationMs,
        totals: atlas.totals,
        repos: atlas.repos.map((r) => ({
          name: r.name,
          branch: r.git?.branch,
          files: r.files,
          loc: r.loc,
          symbols: r.symbols?.length || 0,
          topLanguage: r.languages?.[0]?.ext,
          error: r.error,
        })),
      };
    },
  },
  {
    name: 'hermes_atlas_search',
    title: 'Search the repo atlas',
    description: 'Search across repo names, READMEs, symbols, headings and entrypoints in the knowledge map.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring to find' },
        repo: { type: 'string', description: 'Restrict to one repo name' },
        limit: { type: 'integer', description: 'Max hits (default 25)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: ({ query, repo, limit = 25 }) => {
      const hits = searchAtlas(query, { repo, limit: Number(limit) || 25 });
      return { query, count: hits.length, hits };
    },
  },
  {
    name: 'hermes_atlas_repo',
    title: 'Inspect one repo',
    description: 'Full knowledge-map entry for one repo: git state, languages, entrypoints, symbols and manifest.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Repo name from hermes_atlas_scan' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: ({ name }) => atlasRepo(name),
  },
  {
    name: 'hermes_atlas_status',
    title: 'Atlas status',
    description: 'When the knowledge map was last built, where the repos live and what it covers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const atlas = loadAtlas();
      if (!atlas) return { built: false, reposDir: REPOS_DIR };
      return {
        built: true,
        generatedAt: atlas.generatedAt,
        reposDir: atlas.reposDir,
        totals: atlas.totals,
        repos: atlas.repos.map((r) => r.name),
      };
    },
  },
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

export function callTool(name, args = {}) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(args ?? {});
}
