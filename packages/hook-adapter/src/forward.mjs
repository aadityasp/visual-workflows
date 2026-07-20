#!/usr/bin/env node
/* global process, Buffer, setTimeout */
/**
 * visual-workflows hook forwarder.
 *
 * Runs as a Claude Code hook command: reads one JSON payload from stdin,
 * redacts secrets, and POSTs it to the local bridge at
 * http://127.0.0.1:$VW_PORT (default 4777) /ingest/hooks.
 *
 * Opt-in extra (enabled by `visual-workflows connect --auto-open`, off
 * otherwise): when a session first spawns agents, pop the dashboard open in
 * the browser, auto-starting the bridge if it is not already running.
 *
 * HARD SAFETY CONTRACT (a broken bridge must never break Claude Code):
 * - plain JavaScript, zero dependencies — hook commands exec it directly
 * - NEVER writes to stdout or stderr (hook stdout is model-visible)
 * - ALWAYS exits 0, on every path, including crashes
 * - total self-deadline of 1500 ms — never blocks the session
 * - stdin capped at 1 MB; unparseable or oversized input is dropped silently
 * - every auto-open side effect is best-effort and can never delay exit
 *
 * KEEP IN SYNC: plugin/forward.mjs is a byte-for-byte copy of this file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATA_DIR = process.env.VW_DATA_DIR || join(homedir(), '.visual-workflows');
const PORT =
  Number.parseInt(process.env.VW_PORT ?? '', 10) > 0
    ? Number.parseInt(process.env.VW_PORT ?? '', 10)
    : 4777;
const MAX_STDIN_BYTES = 1024 * 1024;
const DEADLINE_MS = 1500;

/*
 * KEEP IN SYNC: inlined copy of the redaction core from
 * packages/protocol/src/redact.ts — the PATTERNS table below AND the
 * high-entropy catch-all (CANDIDATE_RE + shannonEntropy + entropyPass).
 * redactString mirrors redactText's text output exactly; both invariants are
 * drift-guarded by packages/bridge/test/{forward-redaction,drift-guard}.test.ts.
 * This file must stay dependency-free so hooks can `node forward.mjs` with no
 * build step.
 */
const MARK = (kind) => `•••REDACTED:${kind}•••`;
const PATTERNS = [
  {
    kind: 'pem-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'aws-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'stripe-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  {
    kind: 'auth-header',
    re: /((?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|token)\s+)[^\s'"]+/gi,
    keepGroup: 1,
  },
  {
    kind: 'url-credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(?=@)/gi,
    keepGroup: 1,
  },
  {
    kind: 'secret-assignment',
    re: /([A-Z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]{0,64}\s*[=:]\s*["']?)[^\s"']{8,}/gi,
    keepGroup: 1,
  },
];

/** Shannon entropy in bits per character (mirrors redact.ts). */
function shannonEntropy(s) {
  if (s.length === 0) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * High-entropy catch-all: long unbroken mixed-charset tokens that look like
 * credentials. Threshold 4.2 bits/char deliberately exceeds pure hex
 * (max 4.0) so git SHAs survive. Mirrors redact.ts CANDIDATE_RE + entropyPass.
 */
const CANDIDATE_RE = /\b[A-Za-z0-9+/_=-]{40,}\b/g;

function entropyPass(text) {
  return text.replace(CANDIDATE_RE, (tok) => {
    if (/^[0-9a-f]+$/i.test(tok)) return tok; // hex digests (git SHAs etc.)
    if (/^[0-9]+$/.test(tok)) return tok;
    if (shannonEntropy(tok) <= 4.2) return tok;
    return MARK('high-entropy');
  });
}

export function redactString(input) {
  let text = input;
  for (const { kind, re, keepGroup } of PATTERNS) {
    text = text.replace(re, (...args) => {
      if (keepGroup !== undefined) {
        const groups = args.slice(1, -2);
        return `${groups[keepGroup - 1] ?? ''}${MARK(kind)}`;
      }
      return MARK(kind);
    });
  }
  // Final sweep: any remaining long high-entropy token is scrubbed, so every
  // string at or above the entropy threshold leaves this function redacted.
  return entropyPass(text);
}

/** Recursively redact every string value longer than 6 chars. */
export function redactDeep(value) {
  if (typeof value === 'string') return value.length > 6 ? redactString(value) : value;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactDeep(value[key]);
    return out;
  }
  return value;
}

function readToken() {
  try {
    return readFileSync(join(DATA_DIR, 'token'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/* --------------------------- auto-open (opt-in) ------------------------- */

/**
 * Pure: from a hook payload, decide whether this event marks the session
 * starting or an agent/workflow spawning. Exported for tests; no side effects.
 * Spawn detection mirrors docs/ADAPTERS.md: the Task tool is reported as
 * "Agent" and launches asynchronously (tool_response.status "async_launched").
 */
export function classifyEvent(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const evt = p.hook_event_name;
  const tool = p.tool_name;
  const status =
    p.tool_response && typeof p.tool_response === 'object' ? p.tool_response.status : undefined;
  const isSessionStart = evt === 'SessionStart';
  const isSpawn =
    evt === 'SubagentStart' ||
    (evt === 'PostToolUse' &&
      (tool === 'Agent' || tool === 'Task') &&
      status === 'async_launched') ||
    (evt === 'PreToolUse' && tool === 'Workflow');
  return { isSessionStart, isSpawn };
}

function readJsonFile(name) {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Running-bridge info, or undefined if the file is missing or its pid is dead. */
function readBridgeInfo() {
  const info = readJsonFile('bridge.json');
  if (!info || typeof info !== 'object') return undefined;
  if (typeof info.pid === 'number') {
    try {
      process.kill(info.pid, 0); // signal 0 = liveness probe, does not kill
    } catch {
      return undefined; // stale file from a bridge that already exited
    }
  }
  return info;
}

function sanitizeId(id) {
  return String(id)
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 120);
}

/**
 * Claim a once-per-session action via a marker file. Returns true the first
 * time (and records the claim), false if it was already claimed or on error.
 */
function claimOnce(kind, sessionId) {
  if (!sessionId) return false;
  const file = join(DATA_DIR, 'run', `${sanitizeId(sessionId)}.${kind}`);
  try {
    mkdirSync(join(DATA_DIR, 'run'), { recursive: true });
    // Atomic first-writer-wins: the 'wx' flag exclusively creates the marker,
    // failing with EEXIST if it already exists. This makes the claim race-free
    // across concurrently-spawned hook processes — the old read-then-write had
    // a TOCTOU window in which two spawns could both claim and double-open.
    writeFileSync(file, String(Date.now()), { flag: 'wx' });
    return true;
  } catch {
    return false; // EEXIST = already claimed; any other error = don't claim
  }
}

function detached(cmd, args, useShell, extraEnv) {
  try {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      shell: useShell,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best-effort */
  }
}

/**
 * Open the dashboard. Prefer a Chromium-family *app window* (which the page
 * can later close itself for auto-close), falling back to a normal tab in the
 * default browser. All variants are tried in one detached shell command.
 *
 * The app window uses a dedicated --user-data-dir: without it, `open -na
 * "Google Chrome" --app=...` silently no-ops when the user's main Chrome is
 * already running (macOS routes to the existing instance and drops --app), so
 * no window ever appears. A separate profile forces a real app instance every
 * time, and window.close() works there for auto-close.
 */
function openBrowser(url) {
  const p = process.platform;
  const profile = join(DATA_DIR, 'browser');
  const flags = `--user-data-dir="${profile}" --no-first-run --no-default-browser-check`;
  let cmd;
  if (p === 'darwin') {
    cmd =
      `open -na "Google Chrome" --args --app="${url}" ${flags} 2>/dev/null || ` +
      `open -na "Brave Browser" --args --app="${url}" ${flags} 2>/dev/null || ` +
      `open -na "Microsoft Edge" --args --app="${url}" ${flags} 2>/dev/null || ` +
      `open "${url}"`;
  } else if (p === 'win32') {
    cmd =
      `start "" chrome --app="${url}" ${flags} || ` +
      `start "" msedge --app="${url}" ${flags} || ` +
      `start "" "${url}"`;
  } else {
    cmd =
      `google-chrome --app="${url}" ${flags} >/dev/null 2>&1 || ` +
      `chromium --app="${url}" ${flags} >/dev/null 2>&1 || ` +
      `microsoft-edge --app="${url}" ${flags} >/dev/null 2>&1 || ` +
      `xdg-open "${url}" >/dev/null 2>&1`;
  }
  detached(cmd, undefined, true);
}

/**
 * Best-effort auto-open side effects. Reads config (written by
 * `connect --auto-open`); does nothing unless autoOpen is on. All spawns are
 * detached + unref'd so they outlive this process and never delay its exit.
 */
export function runAutoOpen(payload) {
  const config = readJsonFile('config.json');
  if (!config || config.autoOpen !== true) return;
  const sessionId = payload && typeof payload === 'object' ? payload.session_id : undefined;
  const { isSessionStart, isSpawn } = classifyEvent(payload);
  const info = readBridgeInfo();
  const port = (info && info.port) || config.port || PORT;
  const base = (info && info.url) || `http://127.0.0.1:${port}`;
  // The #vw=auto marker tells the UI this window is auto-managed, so it can
  // follow the live session and offer to close itself when the run ends.
  const url = `${String(base).replace(/\/$/, '')}/#vw=auto`;

  // At session start, if the bridge is down and we know how to start it, do so
  // once — so it is ready by the time the first agent spawns.
  if (isSessionStart && !info && config.startCommand && claimOnce('started', sessionId)) {
    // Pass the port via the child env (cross-platform, unlike a shell prefix).
    detached(
      config.startCommand,
      undefined,
      true,
      config.port ? { VW_PORT: String(config.port) } : undefined,
    );
  }
  // On the first spawn, open the dashboard — but only once the bridge is
  // actually up (never a dead tab). If it is not up yet, don't burn the claim;
  // a workflow spawns several agents, so a later spawn retries.
  if (isSpawn && info && claimOnce('opened', sessionId)) {
    openBrowser(url);
  }
}

/* ------------------------------- forward ------------------------------- */

function forward(payload) {
  const body = JSON.stringify(redactDeep(payload));
  const token = readToken();
  const req = request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/ingest/hooks',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(token ? { 'x-vw-token': token } : {}),
      },
    },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
      res.on('error', () => process.exit(0));
    },
  );
  req.setTimeout(DEADLINE_MS - 200, () => {
    req.destroy();
    process.exit(0);
  });
  req.on('error', () => process.exit(0));
  req.end(body);
}

function main() {
  const deadline = setTimeout(() => process.exit(0), DEADLINE_MS);
  if (typeof deadline.unref === 'function') deadline.unref();
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));

  let stdinBytes = 0;
  const chunks = [];
  process.stdin.on('data', (chunk) => {
    stdinBytes += chunk.length;
    if (stdinBytes <= MAX_STDIN_BYTES) chunks.push(chunk);
  });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    try {
      if (stdinBytes === 0 || stdinBytes > MAX_STDIN_BYTES) process.exit(0);
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        process.exit(0); // not JSON: drop silently
      }
      // Auto-open first (synchronous, detached) so it fires regardless of how
      // the POST resolves; wrapped so it can never break telemetry.
      try {
        runAutoOpen(payload);
      } catch {
        /* never let auto-open affect forwarding */
      }
      forward(payload);
    } catch {
      process.exit(0);
    }
  });
}

// Run only when executed directly as a hook — importing for tests is inert.
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
