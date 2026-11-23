# Hermes

A local-first [Model Context Protocol](https://modelcontextprotocol.io) server that gives your
agent a persistent notebook, a searchable map of your local repositories, and a live console for
calling every tool by hand.

No account, no API key, no network call. Notes live in a JSON file you own.

```bash
npx hermes-local-mcp start        # console on http://127.0.0.1:4123
npx hermes-local-mcp mcp-json     # ready-to-paste config for your MCP client
```

## Why

- **Your agent forgets; Hermes doesn't.** Notes survive restarts and are shared across every client
  you connect (Claude Desktop, Cursor, VS Code, any MCP host).
- **Local code context without uploading code.** Point it at your checkouts and it indexes
  languages, exported symbols, headings, entrypoints and manifest dependencies.
- **You can see what your agent sees.** The console is the same tool registry the MCP server exposes,
  not a mock, so debugging a tool call is one click instead of a protocol trace.

## Install

Requires Node 18.17+.

```bash
npm install -g hermes-local-mcp
hermes start
hermes status
hermes mcp-json     # copy the output into your client's config
```

Or skip the install and use `npx hermes-local-mcp <command>`.

### Connect a client

`hermes mcp-json` prints the exact JSON for the directory Hermes is installed in:

```json
{
  "mcpServers": {
    "hermes": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/hermes-local-mcp/src/mcp.js"],
      "env": { "HERMES_DATA_DIR": "/home/you/.hermes-mcp" }
    }
  }
}
```

- **Claude Desktop** — paste into `claude_desktop_config.json`, restart the app.
- **Cursor / VS Code** — paste into `~/.cursor/mcp.json` or `.vscode/mcp.json` under `servers`.
- **Lemon Code** — Customize → MCP servers, same `command` / `args` / `env`.

The server speaks stdio only: logs go to stderr, protocol frames to stdout.

## CLI

| Command | Does |
| --- | --- |
| `hermes start` | Run the console in the background (idempotent) |
| `hermes stop` | Stop it |
| `hermes restart` | Stop then start |
| `hermes status` | Health check, pid, data directory |
| `hermes url` | Print the console address |
| `hermes mcp-json` | Print a client config for this install |
| `hermes logs` | Last 60 lines of the console log |

## Tools

| Tool | What it does |
| --- | --- |
| `hermes_whoami` | Server name, version, pid, uptime, note count, data dir |
| `hermes_time` | Current time in ISO 8601, optional IANA timezone |
| `hermes_calc` | Arithmetic `+ - * / % ^ ( )` via a real parser (no `eval`) |
| `hermes_add_note` | Store text with tags |
| `hermes_list_notes` | Filter by substring and/or tags |
| `hermes_delete_note` | Delete by id |
| `hermes_env_info` | Platform, arch, cpus, memory, hostname, uptime |
| `hermes_atlas_scan` | Re-index repo checkouts into the knowledge map |
| `hermes_atlas_search` | Search repo names, READMEs, symbols, headings, entrypoints |
| `hermes_atlas_repo` | One repo in full: git state, languages, symbols, manifest |
| `hermes_atlas_status` | Map age, repo location, coverage |

Resources: `hermes://notes`, `hermes://server-info`, `hermes://atlas`.

## Repo atlas

```bash
hermes-local-mcp sync-repos   # gh repo list → clone/fetch into ~/hermes-repos, then rescan
hermes-local-mcp atlas        # rescan only
```

Env: `HERMES_REPOS_DIR` (default `~/hermes-repos`), `HERMES_GH_OWNER` (defaults to the signed-in
`gh` account). The map lands in `$HERMES_DATA_DIR/atlas.json`; a scan of ~10 repos (18k lines)
takes about 60 ms. Skips `.git`, `node_modules`, `dist`, `venv` and friends.

## Paid tools (x402)

`src/paid.js` serves the same tools over MCP Streamable HTTP with per-call pricing, so an agent
can discover the server for free and pay only for the calls that cost you money to run. Payment
is [x402](https://x402.org): the server answers an unpaid call with a 402 carrying price, asset,
network and payee; the client signs a USDC authorization and retries, and a facilitator verifies
and settles it.

| Tool | Price | What it does |
| --- | --- | --- |
| `hermes_calc` | free | Arithmetic; proves the server is reachable before paying |
| `hermes_atlas_scan` | $0.02 | Index every repo under `HERMES_REPOS_DIR` |
| `hermes_atlas_repo` | $0.01 | Details for one indexed repo |

```bash
# demo: local mock facilitator — a real signature and 402 flow, no chain, no money
X402_PAY_TO=0xYourReceivingAddress X402_FACILITATOR=mock npm run paid:serve
PAYER_PRIVATE_KEY=0xThrowawayTestnetKey npm run paid:client
```

```bash
# real testnet settlement on Base Sepolia via the public facilitator:
# the payer account needs testnet USDC (0x036CbD…CF7e)
X402_PAY_TO=0xYourReceivingAddress npm run paid:serve
PAYER_PRIVATE_KEY=0xFundedTestnetKey npm run paid:client
```

| Env (server) | Default | Meaning |
| --- | --- | --- |
| `X402_PAY_TO` | — (required) | Address that receives payment |
| `X402_FACILITATOR` | `https://x402.org/facilitator` | `mock` for offline demos; a mock is refused on a non-loopback bind |
| `X402_NETWORK` | `eip155:84532` | Base Sepolia |
| `X402_PRICE_SCAN` / `X402_PRICE_REPO` | `$0.02` / `$0.01` | Price per call |
| `PORT` / `HOST` | `4130` / `127.0.0.1` | Listen address |

The client (`scripts/paid-client.js`) prints the 402 challenge before paying, then pays and prints
the settlement. It refuses any call above `MAX_PRICE_USD` (default `0.05`) in its
`onPaymentRequested` hook — the same place you would add a daily budget or an allowlist.

The mock facilitator always verifies and settles and never touches a chain, so a green
`npm test` proves the protocol flow, not that money moved. `test/paid.test.js` covers the free
tier, the 402, settlement, the second paid tool and the client-side price cap.

## Safety and data

- Notes and the atlas are plain JSON in `$HERMES_DATA_DIR` (default `~/.hermes-mcp`). Back them up
  by copying that directory; delete them by removing it.
- Every write takes an `O_EXCL` lock and renames a temp file into place, so several processes can
  write at once. The previous version is kept as `notes.json.bak` and restored automatically if the
  main file is ever corrupt.
- The console binds `127.0.0.1` by default. To expose it on a network, set both
  `HERMES_HTTP_HOST=0.0.0.0` **and** `HERMES_HTTP_TOKEN=<secret>`; `/api/*` then requires
  `Authorization: Bearer <secret>` and the UI prompts once. Never set the host without the token.

## Develop

```bash
npm install
npm test        # stdio handshake, multi-process writes, CLI and x402 payment checks
npm run demo    # spawn the server with a real MCP client and call its tools
```

## License

MIT
