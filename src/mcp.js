#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INFO, tools, callTool } from './tools.js';
import { readNotes } from './store.js';
import { loadAtlas, REPOS_DIR } from './atlas.js';

const server = new Server(
  { name: SERVER_INFO.name, version: SERVER_INFO.version, title: SERVER_INFO.title },
  {
    capabilities: {
      tools: {},
      resources: {},
      logging: {},
    },
    instructions:
      'Hermes exposes small utilities: notes storage, arithmetic, time and environment info. ' +
      'Use hermes_add_note/hermes_list_notes for persistence and hermes_calc for arithmetic.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callTool(name, args ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const RESOURCES = [
  {
    uri: 'hermes://notes',
    name: 'Stored notes',
    title: 'Stored notes',
    description: 'All notes currently stored by the Hermes MCP server, as JSON.',
    mimeType: 'application/json',
  },
  {
    uri: 'hermes://server-info',
    name: 'Server info',
    title: 'Server info',
    description: 'Identity and transport details of this Hermes MCP server.',
    mimeType: 'application/json',
  },
  {
    uri: 'hermes://atlas',
    name: 'Repo atlas',
    title: 'Repo atlas',
    description: 'Knowledge map over the local repo checkouts: languages, symbols, headings, manifests.',
    mimeType: 'application/json',
  },
];

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  if (uri === 'hermes://notes') {
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(readNotes(), null, 2) }] };
  }
  if (uri === 'hermes://atlas') {
    const atlas = loadAtlas();
    if (!atlas) {
      throw new Error(`no atlas yet; run hermes_atlas_scan (repos dir: ${REPOS_DIR})`);
    }
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(atlas, null, 2) }] };
  }
  if (uri === 'hermes://server-info') {
    const info = { ...SERVER_INFO, pid: process.pid, tools: tools.map((t) => t.name) };
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(info, null, 2) }] };
  }
  throw new Error(`unknown resource: ${uri}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`hermes-mcp ${SERVER_INFO.version} ready on stdio (${tools.length} tools)`);
