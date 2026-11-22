# Hermes — custom MCP server + console

A self-contained [Model Context Protocol](https://modelcontextprotocol.io) server named **hermes**, plus a
browser console that discovers the server, lists its tools and calls them live.

```
hermes-mcp/
├── src/
│   ├── mcp.js        # MCP server (stdio JSON-RPC, official SDK)
│   ├── tools.js      # tool registry (7 tools) + safe expression evaluator
│   ├── store.js      # persistent note storage (~/.hermes-mcp/notes.json)
│   └── web.js        # HTTP bridge + static console on :4123
├── public/index.html # the console UI
├── test/handshake.test.js
└── mcp.example.json  # ready-to-paste MCP client config
```

## Run it

```bash
npm install

npm run mcp     # MCP server on stdio  (this is what an MCP client launches)
npm test        # 12-check MCP handshake + 8-check multi-process write test
npm run ui      # console at http://127.0.0.1:4123 (loopback only)
npm run demo    # spawns the server with a real MCP client and calls its tools
```

## Tools

| Tool | What it does |
| --- | --- |
| `hermes_whoami` | server name, version, pid, uptime, note count, data dir |
| `hermes_time` | current time in ISO 8601 + any IANA timezone |
| `hermes_calc` | arithmetic `+ - * / % ^ ( )` via a real parser (no `eval`) |
| `hermes_add_note` | store text with tags, persisted to JSON |
| `hermes_list_notes` | filter by substring and/or tags |
| `hermes_delete_note` | delete by id |
| `hermes_env_info` | platform, arch, cpus, memory, hostname, uptime |
| `hermes_atlas_scan` | re-index every repo checkout into the knowledge map |
| `hermes_atlas_search` | search repo names, READMEs, symbols, headings, entrypoints |
| `hermes_atlas_repo` | one repo in full: git state, languages, symbols, manifest |
| `hermes_atlas_status` | when the map was built, where the repos live, coverage |

Resources: `hermes://notes`, `hermes://server-info`, `hermes://atlas`.

## Connect it to an MCP client

`npm run demo` proves the server works over a real MCP client (the SDK's
`StdioClientTransport`): it initializes, lists tools, calls several, and reads a
resource. It is the same path an MCP host takes when it launches the server.

Use the absolute path to `src/mcp.js` on your machine. Copy the entry from
[`mcp.example.json`](./mcp.example.json):

```json
{
  "mcpServers": {
    "hermes": {
      "command": "node",
      "args": ["/absolute/path/to/hermes-mcp/src/mcp.js"],
      "env": { "HERMES_DATA_DIR": "/absolute/path/to/hermes-data" }
    }
  }
}
```

* **Lemon Code** — Customize → MCP servers → add a server with the same `command` / `args` / `env`.
  After it reconnects you should see the seven `hermes_*` tools in the tool list.
* **Claude Desktop** — paste into `claude_desktop_config.json`, then restart the app.
* **VS Code / Cursor** — paste into `.vscode/mcp.json` under `servers`.

The server only speaks stdio: it prints logs to stderr and protocol frames to stdout, so nothing
should write to stdout other than the SDK.

## Concurrency and safety

- Every write takes an `O_EXCL` lock on `notes.lock`, so the stdio server and the
  HTTP bridge can write at the same time. `npm test` spawns four processes that
  add 800 notes at once and asserts all 800 survive with no leftover temp files.
- Writes go to a unique temp file and are renamed into place; the previous file is
  kept as `notes.json.bak` and used automatically if `notes.json` is ever corrupt.
- The bridge binds `127.0.0.1` by default. Set `HERMES_HTTP_HOST=0.0.0.0` only if
  you also set `HERMES_HTTP_TOKEN=<secret>`; `/api/*` then requires
  `Authorization: Bearer <secret>` and the console prompts for it.

## Console

`npm run ui` serves the console. It talks to the same tool registry through
`POST /api/call`, so it is a faithful preview of what an MCP client sees —
not a mock. Endpoints: `/api/health`, `/api/info`, `/api/call`,
`/api/resources/notes`, `/api/resources/server-info`.

## Repo atlas

Hermes keeps a knowledge map of your local repo checkouts so tools and the UI can
search code structure without touching GitHub on every call.

```bash
npm run sync-repos     # gh repo list → clone/fetch into ~/hermes-repos, then rescan
npm run atlas          # rescan only
```

Env: `HERMES_REPOS_DIR` (default `~/hermes-repos`), `HERMES_GH_OWNER` (defaults to
the signed-in `gh` account). The map lands in `$HERMES_DATA_DIR/atlas.json`
(default `~/.hermes-mcp/atlas.json`) and covers languages, line counts, exported
symbols, markdown headings, entrypoints and manifest dependencies, skipping
`.git`, `node_modules`, `dist`, `venv` and friends. A full scan of ~10 repos
(18k lines) takes about 60 ms.

In the browser, `http://127.0.0.1:4123/atlas.html` shows one card per repo, has
live search and opens a full detail sheet on click. HTTP: `GET /api/atlas`,
`POST /api/atlas/scan`, `GET /api/atlas/search?q=…`, `GET /api/atlas/<name>`.

### Reaching it from other machines

The bridge binds `127.0.0.1` on purpose. To serve the console and the atlas to
your whole network, put it behind a token too — never either option alone:

```bash
HERMES_HTTP_HOST=0.0.0.0 HERMES_HTTP_TOKEN=$(openssl rand -hex 16) npm run ui
```

The UI asks for the token once and keeps it in `localStorage`.
