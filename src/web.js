#!/usr/bin/env node
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_INFO, tools, callTool } from './tools.js';
import { readNotes, countNotes } from './store.js';
import { loadAtlas, scanAtlas, searchAtlas, atlasRepo, REPOS_DIR } from './atlas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 4123);
const HOST = process.env.HERMES_HTTP_HOST || '127.0.0.1';
const TOKEN = process.env.HERMES_HTTP_TOKEN || '';
const bootedAt = new Date().toISOString();

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

if (TOKEN) {
  app.use('/api', (req, res, next) => {
    if (req.get('authorization') === `Bearer ${TOKEN}`) return next();
    res.status(401).json({ error: 'unauthorized' });
  });
}

const toolIndex = () => tools.map(({ name, title, description, inputSchema }) => ({
  name, title, description, inputSchema,
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version, bootedAt });
});

app.get('/api/info', (_req, res) => {
  res.json({
    server: SERVER_INFO,
    transport: { mode: 'stdio', bridge: 'http', pid: process.pid, bootedAt, auth: TOKEN ? 'bearer' : 'none' },
    tools: toolIndex(),
    resources: [
      { uri: 'hermes://notes', name: 'Stored notes', mimeType: 'application/json' },
      { uri: 'hermes://server-info', name: 'Server info', mimeType: 'application/json' },
    ],
    counts: { tools: tools.length, notes: countNotes() },
  });
});

app.post('/api/call', async (req, res) => {
  const { name, args } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const started = performance.now();
  try {
    const result = await callTool(name, args ?? {});
    res.json({ ok: true, tool: name, durationMs: +(performance.now() - started).toFixed(2), result });
  } catch (err) {
    res.status(400).json({ ok: false, tool: name, error: err.message });
  }
});

app.get('/api/resources/:name', (req, res) => {
  try {
    if (req.params.name === 'notes') return res.json({ uri: 'hermes://notes', content: readNotes() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (req.params.name === 'server-info') {
    return res.json({
      uri: 'hermes://server-info',
      content: { ...SERVER_INFO, pid: process.pid, bootedAt, tools: tools.map((t) => t.name) },
    });
  }
  res.status(404).json({ error: 'unknown resource' });
});

app.get('/api/atlas', (_req, res) => {
  const atlas = loadAtlas();
  if (!atlas) return res.status(404).json({ error: 'no atlas yet', hint: 'POST /api/atlas/scan', reposDir: REPOS_DIR });
  res.json(atlas);
});

app.post('/api/atlas/scan', (_req, res) => {
  try {
    const atlas = scanAtlas();
    res.json({ ok: true, generatedAt: atlas.generatedAt, durationMs: atlas.durationMs, totals: atlas.totals });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, reposDir: REPOS_DIR });
  }
});

app.get('/api/atlas/search', (req, res) => {
  try {
    const hits = searchAtlas(req.query.q, { repo: req.query.repo, limit: Number(req.query.limit) || 25 });
    res.json({ query: req.query.q ?? '', count: hits.length, hits });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/atlas/:name', (req, res) => {
  try {
    res.json(atlasRepo(req.params.name));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  const auth = TOKEN ? 'bearer token required' : 'no auth (loopback only)';
  console.log(`Hermes UI on http://${HOST}:${PORT}  (${tools.length} tools, ${auth})`);
});
