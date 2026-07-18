/**
 * Bridge server — node:http + ws, bound to 127.0.0.1 only.
 *
 * Routes:
 *   GET  /health                        liveness + version
 *   POST /ingest                        array of protocol events   (token)
 *   POST /ingest/hooks                  one raw Claude Code hook   (token)
 *   POST /demo/start                    start the scripted demo (simulated
 *                                       data only — the sole control surface)
 *   GET  /api/recordings                recording summaries
 *   GET  /api/recordings/:id/events     full event array (replay is client-side)
 *   GET  *                              built UI from apps/ui/dist (SPA fallback)
 *   WS   /ws                            hello / subscribe / snapshot / event
 *
 * Security posture (see src/auth.ts and docs/SECURITY_MODEL.md): the token
 * guards ingestion (event forgery); /ws is open on loopback because it is
 * observation-only and same-user reads are out of scope. Origin headers on
 * /ws must be localhost/127.0.0.1/null when present, which keeps arbitrary
 * web pages from connecting cross-origin out of a browser.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { ClientFrame, ServerFrame } from '@visual-workflows/protocol';
import { EventBus } from './bus.js';
import { ensureDataDir, loadOrCreateToken, requireToken, resolveDataDir } from './auth.js';
import { Recorder } from './recorder.js';
import { createDemoAdapter } from './adapters/demo/index.js';
import type { DemoAdapter } from './adapters/demo/index.js';
import { mapHookPayload } from './adapters/hooks/index.js';
import { createTranscriptAdapter } from './adapters/transcript/index.js';
import type { Adapter, AdapterContext, EventInit } from './adapters/types.js';
import { SERVER_VERSION } from './version.js';

export const DEFAULT_PORT = 4777;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Cap on a ws client's unsent backlog before the bridge drops it. */
export const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024;
const DEFAULT_PING_INTERVAL_MS = 30_000;

/**
 * Content-Security-Policy sent with the served UI (and every serveStatic
 * response). Scripts/objects are locked to 'self'; the policy also permits the
 * inline styles, data: images/fonts, and loopback ws/http connections the
 * built dashboard needs for the live event stream. Kept in sync with the
 * matching <meta http-equiv="Content-Security-Policy"> in apps/ui/index.html.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

export interface BridgeOptions {
  /** Listen port; 0 picks an ephemeral port. Default: $VW_PORT or 4777. */
  port?: number;
  /** Enable JSONL recording of every accepted event. */
  record?: boolean;
  /** Start the transcript adapter (--watch-claude). */
  watchClaude?: boolean;
  /** Auto-run the demo right after startup. */
  autoDemo?: boolean;
  /** Override the data dir (tests); default resolves VW_DATA_DIR / homedir. */
  dataDir?: string;
  /** ws liveness ping cadence in ms (overridable for tests). Default 30s. */
  pingIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BridgeServer {
  port: number;
  url: string;
  dataDir: string;
  token: string;
  bus: EventBus;
  demo: DemoAdapter;
  recorder: Recorder;
  close(): Promise<void>;
}

export async function startServer(opts: BridgeOptions = {}): Promise<BridgeServer> {
  const env = opts.env ?? process.env;
  const port = opts.port ?? parsePort(env.VW_PORT) ?? DEFAULT_PORT;
  const dataDir = ensureDataDir(opts.dataDir ?? resolveDataDir(env));
  const token = loadOrCreateToken(dataDir);

  const bus = new EventBus();
  const recorder = new Recorder({ dataDir });
  const recording = opts.record === true || env.VW_RECORD === '1';
  const unsubRecorder = recording ? bus.subscribe((e) => recorder.handleEvent(e)) : undefined;

  const demo = createDemoAdapter(bus);

  const adapterCtx: AdapterContext = {
    emit: (e: EventInit) => {
      const r = bus.emit(e);
      if (!r.ok) console.error(`[bridge] adapter event rejected: ${r.error}`);
    },
    // Diagnostics go to the terminal; adapters emit adapter_notice events
    // themselves when a notice belongs in a session's stream (the ctx has no
    // session to attribute a synthetic event to).
    log: (level, message) => {
      const line = `[bridge] ${message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    },
    dataDir,
  };

  const adapters: Adapter[] = [];
  if (opts.watchClaude === true || env.VW_WATCH_CLAUDE === '1') {
    const transcript = createTranscriptAdapter();
    adapters.push(transcript);
    await transcript.start(adapterCtx);
  }

  const uiDist = fileURLToPath(new URL('../../../apps/ui/dist/', import.meta.url));

  // The port actually bound; assigned once listen() resolves. Requests and ws
  // upgrades only arrive after that, so the Host-header check below always sees
  // the real port (ephemeral ports included).
  let boundPort = port;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      console.error('[bridge] request failed:', err);
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS-rebinding defense: reject any request whose Host header is not a
    // loopback name (optionally carrying the bound port). A foreign Host means
    // a remote page resolved our origin to 127.0.0.1 and is trying to read
    // local data (e.g. /api/recordings) out of the user's browser.
    if (!isAllowedHost(req.headers.host, boundPort)) {
      return sendJson(res, 403, { error: 'forbidden host' });
    }
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const p = url.pathname;

    if (p === '/health') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, { ok: true, version: SERVER_VERSION });
    }

    if (p === '/ingest') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (!requireToken(req, token)) return sendJson(res, 401, { error: 'invalid token' });
      const body = await readJsonBody(req, res);
      if (!body.ok) {
        if (!body.responded) sendJson(res, 400, { error: body.error });
        return;
      }
      if (!Array.isArray(body.value)) {
        return sendJson(res, 400, { error: 'expected an array of events' });
      }
      let accepted = 0;
      const rejected: Array<{ index: number; error: string }> = [];
      body.value.forEach((item, index) => {
        if (item === null || typeof item !== 'object') {
          rejected.push({ index, error: 'not an object' });
          return;
        }
        const result = bus.emit(item as EventInit);
        if (result.ok) accepted += 1;
        else rejected.push({ index, error: result.error });
      });
      return sendJson(res, 200, { ok: true, accepted, rejected });
    }

    if (p === '/ingest/hooks') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (!requireToken(req, token)) return sendJson(res, 401, { error: 'invalid token' });
      const body = await readJsonBody(req, res);
      if (!body.ok) {
        if (!body.responded) sendJson(res, 400, { error: body.error });
        return;
      }
      let events: EventInit[];
      try {
        events = mapHookPayload(body.value);
      } catch {
        return sendJson(res, 400, { error: 'unmappable hook payload' });
      }
      let accepted = 0;
      const rejected: Array<{ index: number; error: string }> = [];
      events.forEach((e, index) => {
        const result = bus.emit(e);
        if (result.ok) accepted += 1;
        else rejected.push({ index, error: result.error });
      });
      return sendJson(res, 200, { ok: true, accepted, rejected });
    }

    if (p === '/demo/start') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const body = await readJsonBody(req, res, true);
      if (!body.ok && body.responded) return;
      const speed =
        body.ok &&
        body.value !== null &&
        typeof body.value === 'object' &&
        typeof (body.value as { speed?: unknown }).speed === 'number'
          ? (body.value as { speed: number }).speed
          : 1;
      const { sessionId } = demo.start(speed);
      return sendJson(res, 200, { ok: true, sessionId });
    }

    if (p === '/api/recordings') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await recorder.list());
    }

    const recMatch = /^\/api\/recordings\/([^/]+)\/events$/.exec(p);
    if (recMatch) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      let id: string;
      try {
        id = decodeURIComponent(recMatch[1] ?? '');
      } catch {
        // Malformed percent-encoding (e.g. %zz) is a client error, not a 500.
        return sendJson(res, 400, { error: 'malformed recording id' });
      }
      const rec = await recorder.read(id);
      if (!rec) return sendJson(res, 404, { error: 'recording not found' });
      return sendJson(res, 200, rec.events);
    }

    if (method === 'GET' || method === 'HEAD') return serveStatic(res, p);
    return sendJson(res, 404, { error: 'not found' });
  }

  function serveStatic(res: http.ServerResponse, pathname: string): void {
    // Applies to every response path below (the served index + subresources,
    // and the plain-text fallbacks) — set once before any writeHead, which
    // merges rather than clears it.
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    let rel: string;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
    } catch {
      // Malformed percent-encoding (e.g. /%zz) is a client error, not a 500.
      return sendText(res, 400, 'bad request');
    }
    if (!fs.existsSync(uiDist)) {
      return sendText(
        res,
        404,
        'UI not built. Run `npm run build -w @visual-workflows/ui`, or use the API/ws endpoints.',
      );
    }
    let filePath = path.normalize(path.join(uiDist, rel));
    if (!filePath.startsWith(path.normalize(uiDist))) {
      return sendText(res, 403, 'forbidden');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback: unknown extensionless routes get index.html.
      if (path.extname(filePath) === '') filePath = path.join(uiDist, 'index.html');
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        return sendText(res, 404, 'not found');
      }
    }
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(filePath).pipe(res);
  }

  /* ------------------------------ websocket ----------------------------- */

  // noServer mode: we own the upgrade handshake so a foreign Host header
  // (DNS rebinding) or a non-/ws path is rejected *before* the WebSocket is
  // established, rather than after ws would have completed the handshake.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname;
    if (pathname !== '/ws' || !isAllowedHost(req.headers.host, boundPort)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  /** sessionIds each connected socket is subscribed to. */
  const sockets = new Map<WebSocket, Set<string>>();

  /** Backpressure-aware send: a hopelessly backed-up socket is dropped. */
  const send = (socket: WebSocket, frame: ServerFrame): void =>
    sendFrame(socket, frame, (s) => sockets.delete(s));

  // Liveness: ping each socket every interval; a socket that never ponged
  // back since the previous round is dead (half-open TCP, frozen client) and
  // gets terminated so it stops accumulating fan-out work.
  const alive = new WeakSet<WebSocket>();
  const pingTimer = setInterval(() => {
    for (const socket of sockets.keys()) {
      if (!alive.has(socket)) {
        sockets.delete(socket);
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      if (socket.readyState === socket.OPEN) socket.ping();
    }
  }, opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
  pingTimer.unref();

  const knownSessions = new Set<string>();
  const unsubFanout = bus.subscribe((event) => {
    for (const [socket, subs] of sockets) {
      if (subs.has(event.sessionId)) send(socket, { kind: 'event', event });
    }
    // Already-connected clients only got the session list in their hello
    // frame — when a session appears (or starts/ends) later, broadcast the
    // updated list so dashboards see new work without reconnecting.
    // (Caught by e2e: an externally started session never showed up.)
    if (
      !knownSessions.has(event.sessionId) ||
      event.type === 'session_started' ||
      event.type === 'session_ended'
    ) {
      knownSessions.add(event.sessionId);
      const frame: ServerFrame = { kind: 'sessions', sessions: bus.sessionSummaries() };
      for (const socket of sockets.keys()) send(socket, frame);
    }
  });

  wss.on('connection', (socket, req) => {
    if (!isAllowedOrigin(req.headers.origin)) {
      socket.close(1008, 'origin not allowed');
      return;
    }
    const subs = new Set<string>();
    sockets.set(socket, subs);
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));

    void (async () => {
      const recordings = await recorder.list().catch(() => []);
      send(socket, {
        kind: 'hello',
        protocolV: 1,
        serverVersion: SERVER_VERSION,
        sessions: bus.sessionSummaries(),
        recordings,
      });
    })();

    socket.on('message', (data) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(data)) as ClientFrame;
      } catch {
        send(socket, { kind: 'error', message: 'invalid JSON frame' });
        return;
      }
      switch (frame.kind) {
        case 'subscribe': {
          if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) {
            send(socket, { kind: 'error', message: 'subscribe requires sessionId' });
            return;
          }
          // Snapshot + registration happen in one tick, so no event can slip
          // between the snapshot and the live stream.
          subs.add(frame.sessionId);
          send(socket, {
            kind: 'snapshot',
            sessionId: frame.sessionId,
            state: bus.getState(),
            lastSeq: bus.lastSeq(frame.sessionId),
          });
          if (typeof frame.fromSeq === 'number') {
            for (const event of bus.getEventsFrom(frame.sessionId, frame.fromSeq)) {
              send(socket, { kind: 'event', event });
            }
          }
          return;
        }
        case 'unsubscribe': {
          if (typeof frame.sessionId === 'string') subs.delete(frame.sessionId);
          return;
        }
        case 'ping': {
          send(socket, { kind: 'pong' });
          return;
        }
        default:
          send(socket, { kind: 'error', message: 'unknown frame kind' });
      }
    });
  });

  /* ------------------------------- listen ------------------------------- */

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  boundPort = typeof address === 'object' && address !== null ? address.port : port;

  // Liveness file: lets the hook forwarder discover a running bridge (and its
  // real port) without guessing, and powers the opt-in auto-open. Best-effort;
  // removed on clean shutdown, and readers must verify the pid is still alive.
  const infoPath = path.join(dataDir, 'bridge.json');
  try {
    fs.writeFileSync(
      infoPath,
      JSON.stringify({
        pid: process.pid,
        port: boundPort,
        url: `http://${HOST}:${boundPort}`,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }

  if (opts.autoDemo === true) demo.start(1);

  return {
    port: boundPort,
    url: `http://${HOST}:${boundPort}`,
    dataDir,
    token,
    bus,
    demo,
    recorder,
    async close() {
      demo.stop();
      clearInterval(pingTimer);
      try {
        fs.unlinkSync(infoPath);
      } catch {
        /* already gone */
      }
      unsubFanout();
      unsubRecorder?.();
      recorder.stop();
      for (const adapter of adapters) await adapter.stop();
      for (const socket of sockets.keys()) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/* -------------------------------- helpers -------------------------------- */

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

/**
 * Host-header allowlist — the standard DNS-rebinding defense. Accepts only a
 * loopback host name (localhost / 127.0.0.1 / ::1), optionally carrying the
 * bound port; anything else (a remote page that rebound our name to loopback,
 * or a mismatched port) is rejected. A missing/empty Host is rejected too —
 * every browser and fetch client sends one.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined || host.length === 0) return false;
  let hostname = host;
  let portPart: string | undefined;
  if (host.startsWith('[')) {
    // IPv6 literal: "[::1]" or "[::1]:<port>".
    const end = host.indexOf(']');
    if (end === -1) return false;
    hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest.length > 0) {
      if (rest[0] !== ':') return false;
      portPart = rest.slice(1);
    }
  } else {
    const colon = host.indexOf(':');
    if (colon !== -1) {
      hostname = host.slice(0, colon);
      portPart = host.slice(colon + 1);
    }
  }
  if (portPart !== undefined && portPart !== String(port)) return false;
  // A Host header for IPv6 loopback is always bracketed ("[::1]" / "[::1]:p"),
  // so only the bracketed spelling is reachable here.
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Loopback-only origins (or none, e.g. curl/node clients) may connect. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null') return true;
  try {
    const { hostname } = new URL(origin);
    // URL keeps the brackets on IPv6 hostnames: new URL('http://[::1]')
    // yields hostname '[::1]'. Accept both spellings defensively.
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Send a frame unless the socket's unsent backlog exceeds
 * MAX_WS_BUFFERED_BYTES — a stalled-but-OPEN client would otherwise buffer
 * events without bound (bridge OOM). Over the cap the socket is terminated
 * and `drop` unregisters it; the client can resume via snapshot +
 * subscribe{fromSeq} after reconnecting.
 */
export function sendFrame(
  socket: WebSocket,
  frame: ServerFrame,
  drop?: (socket: WebSocket) => void,
): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    drop?.(socket);
    socket.terminate();
    return;
  }
  socket.send(JSON.stringify(frame));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

type JsonBodyResult =
  { ok: true; value: unknown } | { ok: false; error: string; responded?: boolean };

/**
 * Read and parse a JSON body with a hard size cap. `optional` tolerates empty.
 * An oversized body is answered here with a 413 + `Connection: close`
 * (`responded: true`) *before* the socket is dropped, so the client sees a
 * real error instead of a connection reset; the remainder of the body is
 * drained and discarded (bounded by a timer) before the socket closes.
 */
function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  optional = false,
): Promise<JsonBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: JsonBodyResult) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.removeListener('data', onData);
        chunks.length = 0;
        // Lingering close: send the 413 now, keep draining (and discarding)
        // the rest of the body for a bounded time, and only complete the
        // response once the request ends. Destroying the socket right away
        // — or letting Node close an early-completed response — sends an
        // RST that can wipe the response out of the client's receive buffer
        // before it is read; finishing after the request ends closes the
        // socket cleanly (`connection: close`).
        const payload = JSON.stringify({ error: 'body too large' });
        res.writeHead(413, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          connection: 'close',
        });
        res.write(payload);
        const lingerTimer = setTimeout(() => req.destroy(), 2000);
        lingerTimer.unref();
        req.on('data', () => {
          /* discard */
        });
        req.on('end', () => {
          clearTimeout(lingerTimer);
          res.end();
        });
        req.on('close', () => clearTimeout(lingerTimer));
        finish({ ok: false, error: 'body too large', responded: true });
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        finish(optional ? { ok: true, value: {} } : { ok: false, error: 'empty body' });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, error: 'invalid JSON' });
      }
    });
    req.on('error', () => finish({ ok: false, error: 'read error' }));
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};
