#!/usr/bin/env node
// Real MCP client: spawns the server over stdio exactly as an MCP host would.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, '..', 'src', 'mcp.js')],
  // The default env whitelist would drop HERMES_DATA_DIR before the server sees it.
  env: { ...process.env },
});

const client = new Client({ name: 'hermes-demo', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const info = client.getServerVersion();
console.log(`connected to ${info.name} v${info.version}\n`);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '), `(${tools.length})`);

const show = (label, res) => {
  const body = res.content?.find((c) => c.type === 'text')?.text ?? JSON.stringify(res);
  console.log(`\n[${label}]${res.isError ? ' ERROR' : ''}\n${body}`);
};

show('hermes_whoami', await client.callTool({ name: 'hermes_whoami', arguments: {} }));
show('hermes_time', await client.callTool({ name: 'hermes_time', arguments: { timezone: 'Europe/London' } }));
show('hermes_calc', await client.callTool({ name: 'hermes_calc', arguments: { expression: '2^10 + 24' } }));
show('hermes_add_note', await client.callTool({
  name: 'hermes_add_note',
  arguments: { text: 'Connected over a real MCP stdio client', tags: ['demo', 'stdio'] },
}));
show('hermes_list_notes', await client.callTool({ name: 'hermes_list_notes', arguments: { tags: ['stdio'] } }));

const { resources } = await client.listResources();
console.log('\nresources:', resources.map((r) => r.uri).join(', '));
const read = await client.readResource({ uri: 'hermes://server-info' });
console.log('[hermes://server-info]\n' + read.contents[0].text);

await client.close();
console.log('\nclient closed cleanly');
