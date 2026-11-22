import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.HERMES_DATA_DIR || path.join(os.homedir(), '.hermes-mcp');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const BACKUP_FILE = path.join(DATA_DIR, 'notes.json.bak');
const LOCK_FILE = path.join(DATA_DIR, 'notes.lock');
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 10000;

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, '[]\n');
}

function staleLock() {
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

// Cross-process mutex: O_EXCL creation is atomic, so only one writer wins.
function withLock(fn) {
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (staleLock()) {
        try { fs.unlinkSync(LOCK_FILE); } catch { /* another breaker won */ }
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for ${LOCK_FILE}; another process holds it`);
      }
      sleepSync(2);
    }
  }
}

function parseNotes(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('notes.json is not an array');
  return parsed;
}

export function readNotes() {
  ensure();
  let text;
  try {
    text = fs.readFileSync(NOTES_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    return parseNotes(text);
  } catch (err) {
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        const backup = parseNotes(fs.readFileSync(BACKUP_FILE, 'utf8'));
        fs.copyFileSync(BACKUP_FILE, NOTES_FILE);
        return backup;
      } catch { /* fall through to the hard failure below */ }
    }
    throw new Error(`notes.json is unreadable (${err.message}) and no valid backup exists`);
  }
}

function writeNotes(notes) {
  const tmp = `${NOTES_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
  if (fs.existsSync(NOTES_FILE)) {
    try { fs.copyFileSync(NOTES_FILE, BACKUP_FILE); } catch { /* backup is best effort */ }
  }
  fs.renameSync(tmp, NOTES_FILE);
}

export function countNotes() {
  try { return readNotes().length; } catch { return 0; }
}

const MAX_TEXT = 20000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 64;

function validate({ text, tags = [] }) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('text must be a non-empty string');
  if (text.length > MAX_TEXT) throw new Error(`text exceeds ${MAX_TEXT} characters`);
  if (!Array.isArray(tags)) throw new Error('tags must be an array of strings');
  if (tags.length > MAX_TAGS) throw new Error(`at most ${MAX_TAGS} tags`);
  const clean = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
  if (clean.some((t) => t.length > MAX_TAG_LEN)) throw new Error(`each tag must be <= ${MAX_TAG_LEN} characters`);
  return { text, tags: clean };
}

export function addNote(input) {
  const { text, tags } = validate(input);
  return withLock(() => {
    const notes = readNotes();
    const note = {
      id: crypto.randomUUID().slice(0, 8),
      text,
      tags,
      createdAt: new Date().toISOString(),
    };
    notes.push(note);
    writeNotes(notes);
    return note;
  });
}

export function deleteNote(id) {
  return withLock(() => {
    const notes = readNotes();
    const next = notes.filter((n) => n.id !== id);
    if (next.length === notes.length) return { deleted: 0, id };
    writeNotes(next);
    return { deleted: 1, id };
  });
}

export function searchNotes(query, tags = []) {
  const q = String(query || '').toLowerCase();
  const wanted = (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase());
  return readNotes().filter((n) => {
    const hitText = !q || n.text.toLowerCase().includes(q) || n.tags.join(' ').toLowerCase().includes(q);
    const hitTags = wanted.length === 0 || wanted.every((t) => n.tags.map((x) => x.toLowerCase()).includes(t));
    return hitText && hitTags;
  });
}
