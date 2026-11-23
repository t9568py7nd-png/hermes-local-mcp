#!/usr/bin/env node
// Demo paying agent: connects to the paid Hermes MCP server, calls the free tool,
// gets a 402 on the paid tool, then pays and retries in one call.
//
//   PAYER_PRIVATE_KEY=0x... node scripts/paid-client.js
//
// With X402_FACILITATOR=mock on the server side, no money moves: the signature is
// real but settlement is simulated. Against the public facilitator on Base Sepolia
// the payer account needs testnet USDC.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { x402MCPClient, extractPaymentRequiredFromError } from '@x402/mcp';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const URL_ = process.env.X402_URL || 'http://127.0.0.1:4130/mcp';
const KEY = process.env.PAYER_PRIVATE_KEY || '';
const MAX_PRICE_USD = Number(process.env.MAX_PRICE_USD || '0.05');

if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error('paid-client: set PAYER_PRIVATE_KEY to a throwaway testnet key (0x + 64 hex chars)');
  process.exit(2);
}

const account = privateKeyToAccount(KEY);
const paidTool = process.env.PAID_TOOL || 'hermes_atlas_scan';
const paidArgs = paidTool === 'hermes_atlas_repo' ? { name: process.env.PAID_TOOL_ARG || 'hermes-local-mcp' } : {};

function log(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
}

async function connect(autoPayment) {
  const mcpClient = new Client({ name: 'hermes-paid-demo', version: '1.0.0' }, { capabilities: {} });
  const paymentClient = registerExactEvmScheme(new x402Client(), { signer: account });
  const wrapped = new x402MCPClient(mcpClient, paymentClient, {
    autoPayment,
    onPaymentRequested: ({ toolName, paymentRequired }) => {
      const accept = paymentRequired.accepts[0];
      const usd = Number(accept.amount) / 1e6;
      console.log(
        `payment requested for ${toolName}: $${usd} of ${accept.asset} on ${accept.network} to ${accept.payTo}`,
      );
      if (!(usd <= MAX_PRICE_USD)) {
        console.log(`refusing: $${usd} is above the $${MAX_PRICE_USD} cap (MAX_PRICE_USD)`);
        return false;
      }
      return true;
    },
  });
  await wrapped.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  return wrapped;
}

async function main() {
  log('payer', account.address);
  log('server', URL_);

  const free = await connect(false);
  const tools = await free.listTools();
  log('tools', tools.tools.map((t) => t.name).join(', '));

  const sum = await free.callTool('hermes_calc', { expression: '6*7' });
  log('free call result', sum.content[0].text.trim());
  await free.close();

  // Phase 1: no payment attached, so the server answers with a 402 challenge.
  const probe = await connect(false);
  try {
    await probe.callTool(paidTool, paidArgs);
    console.log('unexpected: paid tool answered without payment');
  } catch (err) {
    const challenge = err?.paymentRequired ?? extractPaymentRequiredFromError(err);
    if (!challenge?.accepts) throw err;
    log('402 challenge', challenge.accepts.map((a) => ({
      scheme: a.scheme, network: a.network, amount: a.amount, asset: a.asset, payTo: a.payTo,
    })));
    log('charged', 'nothing (request refused)');
  } finally {
    await probe.close();
  }

  // Phase 2: sign the authorization and retry; the wrapper attaches x402/payment.
  const paying = await connect(true);
  try {
    const paid = await paying.callTool(paidTool, paidArgs);
    log('paid result', paid.content[0].text.slice(0, 400));
    log('settlement', paid.paymentResponse ?? 'none reported');
    log('payment made', paid.paymentMade);
  } catch (err) {
    console.error(`paid call failed: ${err?.message || err}`);
    if (/insufficient|balance|funds|transfer/i.test(String(err?.message))) {
      console.error('hint: the payer account needs testnet USDC on Base Sepolia for the real facilitator');
    }
    process.exitCode = 1;
  } finally {
    await paying.close();
  }
}

main().catch((err) => {
  console.error(`paid-client: ${err?.message || err}`);
  process.exit(1);
});