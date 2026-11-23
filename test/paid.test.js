// End-to-end check for the paid MCP server: free tool open, paid tool returns a
// real x402 402 challenge, and a paying client unlocks it after settlement.
// Runs against the mock facilitator, so no chain is touched and no money moves.
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { x402MCPClient } from '@x402/mcp';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-paid-test-'));
const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-paid-repos-'));
const PORT = 4199;
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const PAY_TO = privateKeyToAccount(generatePrivateKey()).address;
const payer = privateKeyToAccount(generatePrivateKey());

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

fs.mkdirSync(path.join(reposDir, 'demo-repo', 'src'), { recursive: true });
fs.writeFileSync(path.join(reposDir, 'demo-repo', 'src', 'index.js'), 'export function add(a, b) { return a + b; }\n');
fs.writeFileSync(path.join(reposDir, 'demo-repo', 'package.json'), JSON.stringify({ name: 'demo-repo', version: '1.0.0' }));

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'paid.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR: 'mock',
    HERMES_DATA_DIR: dataDir,
    HERMES_REPOS_DIR: reposDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d.toString(); });

async function waitForHealth(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start: ${serverErr || 'no output'}`);
}

async function connect({ autoPayment, approve = true }) {
  const mcpClient = new Client({ name: 'hermes-paid-test', version: '1.0.0' }, { capabilities: {} });
  const paymentClient = registerExactEvmScheme(new x402Client(), { signer: payer });
  const wrapped = new x402MCPClient(mcpClient, paymentClient, {
    autoPayment,
    onPaymentRequested: () => approve,
  });
  await wrapped.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  return wrapped;
}

try {
  const health = await waitForHealth();
  check('health reports mock facilitator and two paid tools',
    health.facilitator === 'mock' && Object.keys(health.paidTools).length === 2,
    JSON.stringify(health.paidTools));

  const free = await connect({ autoPayment: false });
  const listed = (await free.listTools()).tools.map((t) => t.name);
  check('tools/list exposes free and paid tools',
    ['hermes_calc', 'hermes_atlas_scan', 'hermes_atlas_repo'].every((n) => listed.includes(n)),
    listed.join(', '));

  const calc = await free.callTool('hermes_calc', { expression: '6*7' });
  check('free tool answers without payment',
    !calc.paymentMade && JSON.parse(calc.content[0].text).value === 42);
  await free.close();

  const probe = await connect({ autoPayment: false });
  let challenge = null;
  try {
    await probe.callTool('hermes_atlas_scan', {});
  } catch (err) {
    challenge = err?.paymentRequired ?? null;
    check('unpaid paid-tool call fails with 402', err?.code === 402, `code ${err?.code}`);
  }
  const accept = challenge?.accepts?.[0];
  check('challenge names exact/USDC on Base Sepolia at the right price',
    accept?.scheme === 'exact' && accept?.network === 'eip155:84532' && accept?.amount === '20000' && accept?.payTo === PAY_TO,
    JSON.stringify(accept && { scheme: accept.scheme, network: accept.network, amount: accept.amount }));
  await probe.close();

  const paying = await connect({ autoPayment: true });
  const scan = await paying.callTool('hermes_atlas_scan', {});
  const scanBody = JSON.parse(scan.content[0].text);
  check('paid call goes through after settlement',
    scan.paymentMade === true && scan.paymentResponse?.success === true && /^0x[0-9a-f]{64}$/.test(scan.paymentResponse.transaction),
    scan.paymentResponse?.transaction);
  check('paid call returns real work, not a placeholder',
    scanBody.totals?.repos === 1 && scanBody.repos?.[0]?.name === 'demo-repo',
    JSON.stringify(scanBody.totals));

  const repo = await paying.callTool('hermes_atlas_repo', { name: 'demo-repo' });
  check('second paid tool bills separately and answers',
    repo.paymentMade === true && JSON.parse(repo.content[0].text).name === 'demo-repo');

  const ledgerLines = fs.readFileSync(path.join(dataDir, 'payments.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('settled payments are appended to the ledger, free calls are not',
    ledgerLines.length === 2 &&
      ledgerLines.map((e) => e.tool).sort().join(',') === 'hermes_atlas_repo,hermes_atlas_scan' &&
      ledgerLines.every((e) => e.mock === true && e.transaction && e.payer),
    ledgerLines.map((e) => `${e.tool}:${e.amount}`).join(' '));

  const earnings = await (await fetch(`http://127.0.0.1:${PORT}/earnings`)).json();
  check('earnings counts mock volume but reports zero real revenue',
    earnings.real.count === 0 && earnings.real.totalUsd === 0 &&
      earnings.mock.count === 2 && earnings.mock.totalUsd === 0.03,
    JSON.stringify({ real: earnings.real, mock: earnings.mock }));

  const guarded = await connect({ autoPayment: true, approve: false });
  let denied = false;
  try {
    await guarded.callTool('hermes_atlas_repo', { name: 'demo-repo' });
  } catch (err) {
    denied = /denied/i.test(String(err?.message));
  }
  check('client refuses the payment when its own policy says no', denied);
  await guarded.close();
  await paying.close();
} catch (err) {
  check('test run completed', false, err.message);
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(reposDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} paid checks passed`);
  process.exit(failed ? 1 : 0);
}