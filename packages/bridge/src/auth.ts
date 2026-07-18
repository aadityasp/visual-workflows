/**
 * Local auth — a per-install random token stored user-readable-only.
 *
 * What the token protects, and what it deliberately does not:
 *
 *  - POST /ingest and /ingest/hooks REQUIRE the token. These routes write
 *    into the event stream, so without a check any local process could forge
 *    events and make the dashboard lie (SECURITY_MODEL: "Another local
 *    process ingests fake events").
 *
 *  - GET /ws is OPEN on loopback. Tradeoff, documented per SECURITY_MODEL:
 *    the socket is read-only by construction (no executable frame types), so
 *    the only exposure is that another process running as the same user can
 *    observe the stream. That process can already read ~/.claude transcripts
 *    directly — an explicitly out-of-scope threat ("we do not claim to
 *    protect against same-user local malware"). Requiring a token on /ws
 *    would force browsers to put it in the URL query (the browser WebSocket
 *    API cannot set headers), violating "token never in URL or logs" for no
 *    real gain. Integrity is protected (ingestion is authenticated);
 *    same-user confidentiality on loopback is not widened, just not
 *    re-defended.
 *
 * Storage: ~/.visual-workflows (0700), token file `token` (0600), created on
 * first start. VW_DATA_DIR overrides the location (used by tests).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

export const TOKEN_HEADER = 'x-vw-token';
export const TOKEN_FILE = 'token';

/** Data dir: $VW_DATA_DIR if set, else ~/.visual-workflows. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VW_DATA_DIR;
  if (typeof override === 'string' && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), '.visual-workflows');
}

/** Create the data dir (0700) if missing; tighten perms if it exists. */
export function ensureDataDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort — some filesystems (or Windows) do not support chmod */
  }
  return dir;
}

/**
 * Read the install token, creating it on first start.
 * 32 random bytes, hex-encoded, file mode 0600.
 */
export function loadOrCreateToken(dir: string): string {
  const file = path.join(dir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* missing or unreadable — create a fresh one below */
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return token;
}

/** Constant-time comparison (via digests, so lengths may differ). */
export function tokenEquals(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * Check the X-VW-Token header on an ingestion request.
 * The token travels only in a header — never in a URL, never logged.
 */
export function requireToken(req: IncomingMessage, expected: string): boolean {
  const got = req.headers[TOKEN_HEADER];
  if (typeof got !== 'string' || got.length === 0) return false;
  return tokenEquals(got.trim(), expected);
}
