#!/usr/bin/env node
// Paid MCP server: the same Hermes tools, but the expensive ones cost USDC per call
// through x402. Free tools stay free so a client can discover the server before paying.
//
//   X402_PAY_TO=0x... npm run paid:serve
//
// Payments are verified and settled by a facilitator. The default is the public
// testnet facilitator (Base Sepolia). X402_FACILITATOR=mock swaps in a local
// stand-in that always verifies and settles, for demos and tests only: no money
// moves and no chain is touched.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { x402ResourceServer } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { createPaymentWrapper } from '@x402/mcp';
import { callTool } from './tools.js';

const NETWORK = process.env.X402_NETWORK || 'eip155:84532'; // Base Sepolia
const FACILITATOR = process.env.X402_FACILITATOR || 'https://x402.org/facilitator';
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const PORT = Number(process.env.PORT || 4130);
const PAY_TO = process.env.X402_PAY_TO || '';

const PAID_TOOLS = {
  hermes_atlas_scan: { price: process.env.X402_PRICE_SCAN || '$0.02', args: {} },
  hermes_atlas_repo: { price: process.env.X402_PRICE_REPO || '$0.01', args: { name: z.string() } },
};

const IS_MOCK = FACILITATOR === 'mock';

// Every settled payment is appended here, one JSON object per line. O_APPEND
// keeps concurrent writers from interleaving, and the file is the audit trail
// behind /earnings: mock settlements are recorded but never counted as revenue.
const DATA_DIR = process.env.HERMES_DATA_DIR || path.join(os.homedir(), '.hermes-mcp');
const LEDGER_FILE = process.env.X402_LEDGER || path.join(DATA_DIR, 'payments.jsonl');

function fail(message) {
  console.error(`paid: ${message}`);
  process.exit(2);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
  fail('set X402_PAY_TO to the wallet address that receives payment (0x + 40 hex chars)');
}
if (IS_MOCK && !LOOPBACK) {
  fail('X402_FACILITATOR=mock is for local demos only; bind to 127.0.0.1');
}

// --- facilitator -------------------------------------------------------------

function httpFacilitator(baseUrl) {
  const url = baseUrl.replace(/\/$/, '');
  async function post(path, body) {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`facilitator ${path} failed: HTTP ${res.status}`);
    return res.json();
  }
  return {
    verify: (paymentPayload, paymentRequirements) => post('/verify', { paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements) => post('/settle', { paymentPayload, paymentRequirements }),
    getSupported: async () => {
      const res = await fetch(url + '/supported');
      if (!res.ok) throw new Error(`facilitator /supported failed: HTTP ${res.status}`);
      return res.json();
    },
  };
}

function mockFacilitator() {
  let counter = 0;
  const payer = '0x000000000000000000000000000000000000dEaD';
  return {
    async verify() {
      return { isValid: true, payer };
    },
    async settle() {
      counter += 1;
      const tx = `0x${counter.toString(16).padStart(64, '0')}`;
      return { success: true, payer, transaction: tx, network: NETWORK };
    },
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }] };
    },
  };
}

// --- revenue ledger ----------------------------------------------------------

const ASSET_DECIMALS = 6; // USDC on the x402 EVM networks

function recordPayment(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), mock: IS_MOCK, ...entry }) + '\n';
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.appendFileSync(LEDGER_FILE, line);
  } catch (err) {
    // A paid call must still succeed if the ledger cannot be written; the
    // settlement already happened on-chain and the facilitator holds the record.
    console.error(`paid: could not append to ledger ${LEDGER_FILE}: ${err.message}`);
  }
}

function readLedger() {
  let raw = '';
  try {
    raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn line from a crash mid-write is skipped, not fatal.
    }
  }
  return entries;
}

function usdOf(entry) {
  return Number(entry.amount || 0) / 10 ** ASSET_DECIMALS;
}

function summarize(entries) {
  const bucket = () => ({ count: 0, totalUsd: 0, byTool: {} });
  const real = bucket();
  const mock = bucket();
  for (const entry of entries) {
    const target = entry.mock ? mock : real;
    const usd = usdOf(entry);
    target.count += 1;
    target.totalUsd += usd;
    const tool = target.byTool[entry.tool] || (target.byTool[entry.tool] = { count: 0, totalUsd: 0 });
    tool.count += 1;
    tool.totalUsd += usd;
  }
  const round = (b) => ({
    count: b.count,
    totalUsd: Number(b.totalUsd.toFixed(6)),
    byTool: Object.fromEntries(
      Object.entries(b.byTool).map(([k, v]) => [k, { count: v.count, totalUsd: Number(v.totalUsd.toFixed(6)) }]),
    ),
  });
  return {
    real: round(real),
    mock: round(mock),
    recent: entries.slice(-20).reverse(),
    ledger: LEDGER_FILE,
  };
}

// --- server ------------------------------------------------------------------

function textResult(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function main() {
  const resourceServer = new x402ResourceServer(IS_MOCK ? mockFacilitator() : httpFacilitator(FACILITATOR));
  registerExactEvmScheme(resourceServer, { networks: [NETWORK] });
  await resourceServer.initialize(); // fetch supported kinds from the facilitator

  const paid = {};
  const paidMeta = {};
  for (const [name, cfg] of Object.entries(PAID_TOOLS)) {
    const accepts = await resourceServer.buildPaymentRequirements({
      scheme: 'exact',
      network: NETWORK,
      payTo: PAY_TO,
      price: cfg.price,
    });
    paidMeta[name] = { amount: accepts[0]?.amount, asset: accepts[0]?.asset };
    paid[name] = createPaymentWrapper(resourceServer, {
      accepts,
      resource: {
        url: `mcp://tool/${name}`,
        description: `${name} for Hermes, billed per call`,
        mimeType: 'application/json',
        serviceName: 'hermes-paid',
        tags: ['agent-infrastructure', 'repo-atlas'],
      },
    });
  }

  // Outermost wrapper: after the handler returns, the settlement (if any) is on
  // the result, so the ledger sees exactly what the facilitator confirmed.
  function billable(name, handler) {
    return async (args, extra) => {
      const result = await handler(args, extra);
      // Server-side the settlement rides in _meta as 'x402/payment-response';
      // the client-side paymentResponse field is rebuilt on the wire.
      const settle = result?.paymentResponse ?? result?._meta?.['x402/payment-response'];
      if (settle?.success) {
        recordPayment({
          tool: name,
          price: PAID_TOOLS[name].price,
          amount: paidMeta[name]?.amount ?? settle.amount ?? null,
          asset: paidMeta[name]?.asset ?? null,
          network: settle.network || NETWORK,
          payer: settle.payer ?? null,
          transaction: settle.transaction ?? null,
        });
      }
      return result;
    };
  }

  // A fresh McpServer per request: the transport is stateless, so nothing is
  // shared between callers and a failed payment cannot leak into the next call.
  function buildServer() {
    const server = new McpServer(
      { name: 'hermes-paid', version: '1.0.0', title: 'Hermes (paid tools)' },
      {
        instructions:
          'Hermes exposes free utilities plus paid atlas tools. ' +
          'A paid tool answers with a 402 payment requirement; retry with an x402 payment attached. ' +
          'Free: hermes_calc. Paid: hermes_atlas_scan ($0.02), hermes_atlas_repo ($0.01).',
      },
    );

    server.registerTool(
      'hermes_calc',
      {
        title: 'Calculate (free)',
        description: 'Evaluate an arithmetic expression. Free, no payment required.',
        inputSchema: { expression: z.string() },
      },
      async ({ expression }) => textResult(await callTool('hermes_calc', { expression })),
    );

    server.registerTool(
      'hermes_atlas_scan',
      {
        title: 'Scan repos into the atlas (paid)',
        description: 'Index every repository under the configured repos directory. Paid: $0.02 per call.',
        inputSchema: {},
      },
      billable('hermes_atlas_scan', paid.hermes_atlas_scan(async () => textResult(await callTool('hermes_atlas_scan', {})))),
    );

    server.registerTool(
      'hermes_atlas_repo',
      {
        title: 'Inspect one repo (paid)',
        description: 'Return the indexed details for one repository. Paid: $0.01 per call.',
        inputSchema: { name: z.string() },
      },
      billable('hermes_atlas_repo', paid.hermes_atlas_repo(async ({ name }) => textResult(await callTool('hermes_atlas_repo', { name })))),
    );

    return server;
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: 'hermes-paid',
      network: NETWORK,
      facilitator: IS_MOCK ? 'mock' : FACILITATOR,
      payTo: PAY_TO,
      paidTools: Object.fromEntries(Object.entries(PAID_TOOLS).map(([k, v]) => [k, v.price])),
      ledger: LEDGER_FILE,
    });
  });

  app.get('/earnings', (req, res) => {
    // Revenue numbers are for the operator. On a loopback bind they are local;
    // on any other bind they need the shared operator token.
    if (!LOOPBACK && req.get('x-hermes-token') !== process.env.X402_ADMIN_TOKEN) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      res.json({ ok: true, payTo: PAY_TO, network: NETWORK, ...summarize(readLedger()) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/mcp', async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('paid: request failed', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });

  const httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(PORT, HOST, resolve));
  console.log(
    JSON.stringify({
      listening: `http://${HOST}:${PORT}/mcp`,
      network: NETWORK,
      facilitator: IS_MOCK ? 'mock (no money moves, no chain is touched)' : FACILITATOR,
      payTo: PAY_TO,
      paidTools: Object.fromEntries(Object.entries(PAID_TOOLS).map(([k, v]) => [k, v.price])),
      ledger: LEDGER_FILE,
      earnings: `http://${HOST}:${PORT}/earnings`,
    }),
  );

  const stop = () => httpServer.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => fail(err.message));