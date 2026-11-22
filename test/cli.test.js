import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

function run(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_DATA_DIR: '/tmp/hermes-cli-unit', ...env },
  });
}

check('mcp-json points at this install', () => {
  const cfg = JSON.parse(run(['mcp-json']));
  const entry = cfg.mcpServers.hermes;
  if (!entry.args[0].endsWith('src/mcp.js')) throw new Error(`bad args: ${entry.args}`);
  if (!entry.env.HERMES_DATA_DIR) throw new Error('missing data dir');
});

check('url prints the loopback address', () => {
  const out = run(['url']).trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(out)) throw new Error(`unexpected: ${out}`);
});

check('unknown command exits 2 with usage', () => {
  const res = spawnSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8' });
  if (res.status !== 2) throw new Error(`status ${res.status}`);
  if (!res.stderr.includes('usage: hermes')) throw new Error('no usage text');
});

check('status reports down without a running server', () => {
  const res = spawnSync(process.execPath, [CLI, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_DATA_DIR: '/tmp/hermes-cli-unit', PORT: '4197' },
  });
  if (res.status !== 1) throw new Error(`expected exit 1, got ${res.status}`);
  if (!res.stdout.includes('down')) throw new Error(`stdout: ${res.stdout}`);
});

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
