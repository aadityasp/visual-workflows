import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerFrame } from '@visual-workflows/protocol';
import { TOKEN_HEADER } from '../src/auth.js';
import {
  CONTENT_SECURITY_POLICY,
  MAX_WS_BUFFERED_BYTES,
  isAllowedHost,
  isAllowedOrigin,
  sendFrame,
  startServer,
} from '../src/server.js';
import type { BridgeServer } from '../src/server.js';

let tmp: string;
let server: BridgeServer;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-srv-'));
  server = await startServer({ port: 0, dataDir: tmp });
});

afterEach(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function validEvent(seqHint: number): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    source: 'manual',
    sessionId: 'ingest-s1',
    agentId: 'main',
    type: 'agent_output',
    payload: { stream: 'message', chunk: `hi ${seqHint}` },
  };
}

/** GET via raw http so a custom Host header survives (fetch strips it). */
function httpGetStatus(port: number, pathname: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Host: host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('bridge server', () => {
  it('GET /health returns ok + version', async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });

  it('rejects a request with a foreign Host header (DNS-rebinding defense)', async () => {
    const status = await httpGetStatus(server.port, '/api/recordings', 'evil.example.com');
    expect(status).toBe(403);
  });

  it('still accepts a loopback Host header (localhost + bound port)', async () => {
    expect(await httpGetStatus(server.port, '/health', `localhost:${server.port}`)).toBe(200);
    expect(await httpGetStatus(server.port, '/health', '127.0.0.1')).toBe(200);
  });

  it('serves the UI with the exact Content-Security-Policy header', async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  });

  it('rejects a ws upgrade carrying a foreign Host before the handshake', async () => {
    const response = await new Promise<string>((resolve) => {
      const sock = net.connect(server.port, '127.0.0.1');
      let out = '';
      sock.on('data', (d) => {
        out += String(d);
      });
      sock.on('close', () => resolve(out));
      sock.on('error', () => resolve(out));
      sock.on('connect', () => {
        sock.write(
          'GET /ws HTTP/1.1\r\n' +
            'Host: evil.example.com\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(out);
      }, 1500);
      timer.unref();
    });
    // The server destroyed the socket without a "101 Switching Protocols".
    expect(response).not.toContain('101');
  });

  it('POST /ingest rejects a missing or bad token', async () => {
    const noToken = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      body: JSON.stringify([validEvent(1)]),
    });
    expect(noToken.status).toBe(401);
    const badToken = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: 'not-the-token' },
      body: JSON.stringify([validEvent(1)]),
    });
    expect(badToken.status).toBe(401);
    expect(server.bus.lastSeq('ingest-s1')).toBe(0); // nothing got in
  });

  it('POST /ingest with the token accepts valid events and reports rejects', async () => {
    const res = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' },
      body: JSON.stringify([validEvent(1), { nonsense: true }, validEvent(2)]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accepted: number;
      rejected: Array<{ index: number; error: string }>;
    };
    expect(body.accepted).toBe(2);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]?.index).toBe(1);
    expect(server.bus.lastSeq('ingest-s1')).toBe(2);
  });

  it('POST /ingest rejects non-array bodies and invalid JSON', async () => {
    const notArray = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token },
      body: JSON.stringify({}),
    });
    expect(notArray.status).toBe(400);
    const badJson = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token },
      body: '{{{',
    });
    expect(badJson.status).toBe(400);
  });

  it('POST /ingest/hooks requires the token (stub mapper tolerated)', async () => {
    const noToken = await fetch(`${server.url}/ingest/hooks`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PreToolUse' }),
    });
    expect(noToken.status).toBe(401);
    const withToken = await fetch(`${server.url}/ingest/hooks`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token },
      body: JSON.stringify({ hook_event_name: 'PreToolUse' }),
    });
    expect(withToken.status).toBe(200);
  });

  it('POST /demo/start starts a demo session (no token needed — simulated data only)', async () => {
    const res = await fetch(`${server.url}/demo/start`, {
      method: 'POST',
      body: JSON.stringify({ speed: 1000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toMatch(/^demo-\d+$/);
    expect(server.demo.running).toBe(true);
  });

  it('GET /api/recordings lists recordings', async () => {
    const res = await fetch(`${server.url}/api/recordings`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('GET /api/recordings/:id/events 404s for unknown ids', async () => {
    const res = await fetch(`${server.url}/api/recordings/nope/events`);
    expect(res.status).toBe(404);
  });

  it('ws /ws sends hello, answers ping, and streams subscribed events', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    // Queued collector: the server may send several frames in one tick (e.g.
    // snapshot + backlog); a naive once('message') between awaits drops them.
    const queue: ServerFrame[] = [];
    const waiters: Array<(f: ServerFrame) => void> = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    });
    const nextRawFrame = (): Promise<ServerFrame> => {
      const buffered = queue.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws frame timeout')), 5000);
        waiters.push((f) => {
          clearTimeout(timer);
          resolve(f);
        });
      });
    };
    // Informational `sessions` broadcasts can interleave anywhere; this test
    // asserts the request/response frames only.
    const nextFrame = async (): Promise<ServerFrame> => {
      let frame = await nextRawFrame();
      while (frame.kind === 'sessions') frame = await nextRawFrame();
      return frame;
    };

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const hello = await nextFrame();
    expect(hello.kind).toBe('hello');
    if (hello.kind === 'hello') {
      expect(hello.protocolV).toBe(1);
      expect(Array.isArray(hello.sessions)).toBe(true);
      expect(Array.isArray(hello.recordings)).toBe(true);
    }

    socket.send(JSON.stringify({ kind: 'ping' }));
    expect((await nextFrame()).kind).toBe('pong');

    // Seed an event, then subscribe with fromSeq for backlog + snapshot.
    const ingest = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token },
      body: JSON.stringify([validEvent(1)]),
    });
    expect(ingest.status).toBe(200);

    socket.send(JSON.stringify({ kind: 'subscribe', sessionId: 'ingest-s1', fromSeq: 1 }));
    const snapshot = await nextFrame();
    expect(snapshot.kind).toBe('snapshot');
    if (snapshot.kind === 'snapshot') {
      expect(snapshot.sessionId).toBe('ingest-s1');
      expect(snapshot.lastSeq).toBe(1);
      expect(snapshot.state.sessions['ingest-s1']?.eventCount).toBe(1);
    }
    const backlog = await nextFrame();
    expect(backlog.kind).toBe('event');
    if (backlog.kind === 'event') expect(backlog.event.seq).toBe(1);

    // A newly ingested event streams live.
    const live = nextFrame();
    await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token },
      body: JSON.stringify([validEvent(2)]),
    });
    const liveFrame = await live;
    expect(liveFrame.kind).toBe('event');
    if (liveFrame.kind === 'event') expect(liveFrame.event.seq).toBe(2);

    socket.close();
  });

  it('ws /ws broadcasts an updated session list when a new session appears', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    // Wait for hello, then ingest an event for a session this client has
    // never heard of — it must receive a sessions frame without resubscribing.
    await expect.poll(() => frames.some((f) => f.kind === 'hello'), { timeout: 5000 }).toBe(true);
    await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: server.token },
      body: JSON.stringify([validEvent(1)]),
    });
    await expect
      .poll(
        () =>
          frames.some(
            (f) => f.kind === 'sessions' && f.sessions.some((s) => s.sessionId === 'ingest-s1'),
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    socket.close();
  });

  it('ws /ws refuses non-localhost origins', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { origin: 'https://evil.example.com' },
    });
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws close timeout')), 5000);
      socket.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      socket.on('error', () => {
        /* connection may error after close — ignore */
      });
    });
    expect(code).toBe(1008);
  });

  it('unknown routes 404 without a built UI', async () => {
    const res = await fetch(`${server.url}/definitely-not-a-route`);
    expect([200, 404]).toContain(res.status); // 200 iff apps/ui/dist exists (SPA fallback)
  });

  it('malformed percent-encoding gets a 400, not a 500', async () => {
    const staticPath = await fetch(`${server.url}/%zz`);
    expect(staticPath.status).toBe(400);
    const recordingId = await fetch(`${server.url}/api/recordings/%zz/events`);
    expect(recordingId.status).toBe(400);
  });

  it('an oversized ingest body gets a 413 response, not a connection reset', async () => {
    const body = 'x'.repeat(11 * 1024 * 1024); // over the 10 MiB cap
    const response = await new Promise<string>((resolve) => {
      const sock = net.connect(server.port, '127.0.0.1');
      let out = '';
      sock.on('data', (d) => {
        out += String(d);
        // Full response arrived — done; the later reset must not matter.
        if (out.includes('body too large')) {
          sock.destroy();
          resolve(out);
        }
      });
      sock.on('close', () => resolve(out));
      sock.on('error', () => resolve(out)); // reset after the response is fine
      sock.on('connect', () => {
        sock.write(
          `POST /ingest HTTP/1.1\r\n` +
            `host: 127.0.0.1\r\n` +
            `${TOKEN_HEADER}: ${server.token}\r\n` +
            `content-type: application/json\r\n` +
            `content-length: ${body.length}\r\n\r\n`,
        );
        sock.write(body);
      });
    });
    expect(response.startsWith('HTTP/1.1 413')).toBe(true);
    expect(response).toContain('body too large');
  }, 15_000);

  it('ws liveness pings drop a client that never pongs and keep responsive ones', async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-ping-'));
    const pinger = await startServer({ port: 0, dataDir: tmp2, pingIntervalMs: 30 });
    try {
      const url = `ws://127.0.0.1:${pinger.port}/ws`;
      const healthy = new WebSocket(url); // auto-pongs (ws default)
      const dead = new WebSocket(url, { autoPong: false }); // never pongs
      await Promise.all(
        [healthy, dead].map(
          (s) =>
            new Promise<void>((resolve, reject) => {
              s.once('open', resolve);
              s.once('error', reject);
            }),
        ),
      );
      const deadClosed = new Promise<void>((resolve) => dead.once('close', () => resolve()));
      await deadClosed; // server terminates it after a missed pong round
      expect(dead.readyState).not.toBe(WebSocket.OPEN);
      // Several ping rounds have elapsed; a pong-ing client must survive them.
      expect(healthy.readyState).toBe(WebSocket.OPEN);
      healthy.close();
    } finally {
      await pinger.close();
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe('sendFrame backpressure', () => {
  it('terminates and drops a backed-up socket instead of sending to it', () => {
    const sent: string[] = [];
    let terminated = 0;
    const makeFake = (bufferedAmount: number): WebSocket =>
      ({
        readyState: 1,
        OPEN: 1,
        bufferedAmount,
        send: (data: string) => sent.push(data),
        terminate: () => {
          terminated += 1;
        },
      }) as unknown as WebSocket;

    const stalled = makeFake(MAX_WS_BUFFERED_BYTES + 1);
    const registry = new Map<WebSocket, Set<string>>([[stalled, new Set(['s1'])]]);
    sendFrame(stalled, { kind: 'pong' }, (s) => registry.delete(s));
    expect(terminated).toBe(1);
    expect(registry.size).toBe(0); // dropped from the fan-out map
    expect(sent).toHaveLength(0); // nothing buffered onto the stalled socket

    // Under the cap the frame goes out normally.
    const healthy = makeFake(0);
    sendFrame(healthy, { kind: 'pong' }, () => undefined);
    expect(sent).toHaveLength(1);
    expect(terminated).toBe(1);
  });
});

describe('isAllowedHost', () => {
  it('allows loopback host names with and without the bound port', () => {
    expect(isAllowedHost('127.0.0.1', 4777)).toBe(true);
    expect(isAllowedHost('127.0.0.1:4777', 4777)).toBe(true);
    expect(isAllowedHost('localhost', 4777)).toBe(true);
    expect(isAllowedHost('localhost:4777', 4777)).toBe(true);
    expect(isAllowedHost('[::1]', 4777)).toBe(true);
    expect(isAllowedHost('[::1]:4777', 4777)).toBe(true);
  });

  it('rejects foreign hosts, a mismatched port, and a missing header', () => {
    expect(isAllowedHost('evil.example.com', 4777)).toBe(false);
    expect(isAllowedHost('evil.example.com:4777', 4777)).toBe(false);
    expect(isAllowedHost('127.0.0.1:5000', 4777)).toBe(false); // port must match
    expect(isAllowedHost('127.0.0.1.evil.com', 4777)).toBe(false);
    expect(isAllowedHost('[2001:db8::1]:4777', 4777)).toBe(false);
    expect(isAllowedHost(undefined, 4777)).toBe(false);
    expect(isAllowedHost('', 4777)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('allows localhost, 127.0.0.1, null, and absent origins', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('null')).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4777')).toBe(true);
  });

  it('allows the IPv6 loopback (URL keeps the brackets in hostname)', () => {
    expect(isAllowedOrigin('http://[::1]:4777')).toBe(true);
    expect(isAllowedOrigin('http://[::1]')).toBe(true);
  });

  it('refuses everything else', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('http://192.168.1.10:4777')).toBe(false);
    expect(isAllowedOrigin('http://[2001:db8::1]:4777')).toBe(false);
    expect(isAllowedOrigin('garbage')).toBe(false);
  });
});
