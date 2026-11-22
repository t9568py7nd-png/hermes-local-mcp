#!/usr/bin/env node
// Control CLI: start/stop the loopback console and print copy-paste MCP config
// for whatever directory this package is installed in (npx or global).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'src', 'web.js');
const MCP = path.join(ROOT, 'src', 'mcp.js');
const PORT = Number(process.env.PORT || 4123);
const HOST = process.env.HERMES_HTTP_HOST || '127.0.0.1';
const PIDFILE = path.join(DATA_DIR, 'hermes-ui.pid');
const LOGDIR = path.join(DATA_DIR, 'logs');
const LOGFILE = path.join(LOGDIR, 'ui.log');
const URL_BASE = `http://${HOST}:${PORT}`;

mkdirSync(LOGDIR, { recursive: true });

function pidFromFile() {
  try {
    const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function healthy() {
  try {
    const res = await fetch(`${URL_BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function start() {
  const pid = pidFromFile();
  if (pid && (await healthy())) {
    console.log(`hermes: already running (pid ${pid}) → ${URL_BASE}`);
    return 0;
  }
  const logFd = openSync(LOGFILE, 'a');
  const out = spawn(process.execPath, [WEB], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(PORT), HERMES_HTTP_HOST: HOST },
  });
  out.unref();
  writeFileSync(PIDFILE, String(out.pid));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) {
      console.log(`hermes: started (pid ${out.pid}) → ${URL_BASE}`);
      return 0;
    }
  }
  console.error(`hermes: did not become healthy; see ${LOGFILE}`);
  return 1;
}

async function stop() {
  const pid = pidFromFile();
  if (!pid) {
    console.log('hermes: not running');
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      console.log(`hermes: stopped (pid ${pid})`);
      return 0;
    }
  }
  process.kill(pid, 'SIGKILL');
  console.log(`hermes: killed (pid ${pid})`);
  return 0;
}

async function status() {
  const pid = pidFromFile();
  const ok = await healthy();
  console.log(`hermes: ${ok ? 'healthy' : 'down'}${pid ? ` (pid ${pid})` : ''} → ${URL_BASE}`);
  console.log(`data: ${DATA_DIR}`);
  return ok ? 0 : 1;
}

function mcpJson() {
  return JSON.stringify(
    {
      mcpServers: {
        hermes: {
          command: process.execPath,
          args: [MCP],
          env: { HERMES_DATA_DIR: DATA_DIR },
        },
      },
    },
    null,
    2,
  );
}

const cmd = process.argv[2] || 'status';
const actions = {
  start,
  stop,
  status,
  restart: async () => (await stop()) || start(),
  url: async () => (console.log(URL_BASE), 0),
  'mcp-json': async () => (console.log(mcpJson()), 0),
  logs: async () => {
    if (!existsSync(LOGFILE)) return console.log(`hermes: no log yet (${LOGFILE})`), 0;
    console.log(readFileSync(LOGFILE, 'utf8').split('\n').slice(-60).join('\n'));
    return 0;
  },
  help: async () => (console.log(usage()), 0),
};

if (!actions[cmd]) {
  console.error(usage());
  process.exit(2);
}
process.exit(await actions[cmd]());

function usage() {
  return `usage: hermes <${Object.keys(actions).join('|')}>

  start      run the console in the background
  stop       stop it
  restart    stop then start
  status     health + data directory
  url        print the console address
  mcp-json   print an MCP client config pointing at this install
  logs       last 60 lines of the console log`;
}
