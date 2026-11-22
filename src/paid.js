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
import http from 'node:http';
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
const PORT = Number(process.env.PORT || 4130);
const PAY_TO = process.env.X402_PAY_TO || '';

const PAID_TOOLS = {
  hermes_atlas_scan: { price: process.env.X402_PRICE_SCAN || '$0.02', args: {} },
  hermes_atlas_repo: { price: process.env.X402_PRICE_REPO || '$0.01', args: { name: z.string() } },
};

const IS_MOCK = FACILITATOR === 'mock';

function fail(message) {
  console.error(`paid: ${message}`);
  process.exit(2);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
  fail('set X402_PAY_TO to the wallet address that receives payment (0x + 40 hex chars)');
}
if (IS_MOCK && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
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
  for (const [name, cfg] of Object.entries(PAID_TOOLS)) {
    const accepts = await resourceServer.buildPaymentRequirements({
      scheme: 'exact',
      network: NETWORK,
      payTo: PAY_TO,
      price: cfg.price,
    });
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
      paid.hermes_atlas_scan(async () => textResult(await callTool('hermes_atlas_scan', {}))),
    );

    server.registerTool(
      'hermes_atlas_repo',
      {
        title: 'Inspect one repo (paid)',
        description: 'Return the indexed details for one repository. Paid: $0.01 per call.',
        inputSchema: { name: z.string() },
      },
      paid.hermes_atlas_repo(async ({ name }) => textResult(await callTool('hermes_atlas_repo', { name }))),
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
    });
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
    }),
  );

  const stop = () => httpServer.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => fail(err.message));