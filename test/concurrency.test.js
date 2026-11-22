// Regression test for the write race: several processes hammer the same store.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-race-'));
const worker = path.join(__dirname, 'race-worker.js');
const WORKERS = 4;
const PER_WORKER = 200;
const expected = WORKERS * PER_WORKER;

const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

function runWorker(id) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, String(id), String(PER_WORKER)], {
      env: { ...process.env, HERMES_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ id, code, out: out.trim(), err: err.trim() }));
  });
}

const runs = await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker(i)));
for (const r of runs) {
  check(`worker ${r.id} exited 0`, r.code === 0, r.code === 0 ? r.out : r.err.split('\n')[0]);
}

process.env.HERMES_DATA_DIR = dataDir;
const store = await import(path.join(__dirname, '..', 'src', 'store.js') + `?v=${Date.now()}`);
const notes = store.readNotes();
check(`all ${expected} notes survived`, notes.length === expected, `got ${notes.length}`);
check('no duplicate ids', new Set(notes.map((n) => n.id)).size === notes.length);
check('no temp files left behind',
  fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')).length === 0,
  fs.readdirSync(dataDir).join(', '));
check('no lock file left behind', !fs.existsSync(path.join(dataDir, 'notes.lock')));

fs.rmSync(dataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
