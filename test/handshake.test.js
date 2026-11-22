// End-to-end check: speaks real MCP JSON-RPC to the stdio server.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-test-'));

const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp.js')], {
  env: { ...process.env, HERMES_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

child.stderr.on('data', () => {});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const results = [];
const check = (label, cond, extra = '') => {
  results.push({ label, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'hermes-test', version: '0.0.1' },
  });
  check('initialize returns protocolVersion', !!init.protocolVersion, init.protocolVersion);
  check('serverInfo.name is hermes', init.serverInfo?.name === 'hermes', init.serverInfo?.name);
  notify('notifications/initialized', {});

  const { tools } = await rpc('tools/list', {});
  check('tools/list returns 11 tools', tools?.length === 11, `${tools?.length} tools`);
  check('atlas tools are registered', (tools || []).filter((t) => t.name.startsWith('hermes_atlas_')).length === 4);
  check('all tools have inputSchema', tools.every((t) => t.inputSchema?.type === 'object'));

  const who = await rpc('tools/call', { name: 'hermes_whoami', arguments: {} });
  const whoData = JSON.parse(who.content[0].text);
  check('hermes_whoami identifies server', whoData.name === 'hermes', `v${whoData.version}`);

  const calc = await rpc('tools/call', { name: 'hermes_calc', arguments: { expression: '(2+3)^2 / 5' } });
  check('hermes_calc computes (2+3)^2/5 = 5', JSON.parse(calc.content[0].text).value === 5);

  const bad = await rpc('tools/call', { name: 'hermes_calc', arguments: { expression: '1/0' } });
  check('division by zero is an error', bad.isError === true, bad.content[0].text);

  const added = await rpc('tools/call', {
    name: 'hermes_add_note',
    arguments: { text: 'Hermes handshake works', tags: ['test', 'mcp'] },
  });
  const note = JSON.parse(added.content[0].text).note;
  check('hermes_add_note persists a note', !!note.id, note.id);

  const listed = await rpc('tools/call', { name: 'hermes_list_notes', arguments: { tags: ['mcp'] } });
  check('hermes_list_notes finds it by tag', JSON.parse(listed.content[0].text).count === 1);

  const { resources } = await rpc('resources/list', {});
  check('resources/list exposes 3 resources', resources?.length === 3);
  check('atlas resource is listed', (resources || []).some((r) => r.uri === 'hermes://atlas'));

  const read = await rpc('resources/read', { uri: 'hermes://notes' });
  check('resources/read hermes://notes returns JSON', JSON.parse(read.contents[0].text).length === 1);

  const status = await rpc('tools/call', { name: 'hermes_atlas_status', arguments: {} });
  check('hermes_atlas_status reports state', typeof JSON.parse(status.content[0].text).built === 'boolean');

  const del = await rpc('tools/call', { name: 'hermes_delete_note', arguments: { id: note.id } });
  check('hermes_delete_note removes it', JSON.parse(del.content[0].text).deleted === 1);
} catch (err) {
  check('test run completed', false, err.message);
} finally {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
