import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace } from '@visual-workflows/protocol';
import type { EventEnvelope, ServerFrame } from '@visual-workflows/protocol';
import { BridgeClient } from '../src/ws';
import type { BridgeHandlers, SocketLike } from '../src/ws';

class MockSocket implements SocketLike {
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 1;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void {
    this.onopen?.({});
  }
  emit(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  sentFrames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function collector() {
  const hellos: unknown[] = [];
  const snapshots: unknown[] = [];
  const events: EventEnvelope[] = [];
  const connections: string[] = [];
  const handlers: BridgeHandlers = {
    onConnection: (c) => connections.push(c),
    onHello: (h) => hellos.push(h),
    onSessions: () => {},
    onSnapshot: (sessionId, state, lastSeq) => snapshots.push({ sessionId, state, lastSeq }),
    onEvent: (e) => events.push(e),
  };
  return { handlers, hellos, snapshots, events, connections };
}

function sampleEvent(seq: number): EventEnvelope {
  return {
    v: 1,
    id: `e${seq}`,
    seq,
    ts: new Date().toISOString(),
    source: 'demo',
    sessionId: 's1',
    type: 'agent_output',
    payload: { stream: 'message', chunk: 'hi' },
  };
}

afterEach(() => vi.useRealTimers());

describe('BridgeClient frame handling', () => {
  it('routes hello, snapshot and event frames to handlers', () => {
    const c = collector();
    const socket = new MockSocket();
    const client = new BridgeClient(
      c.handlers,
      () => socket,
      () => 'ws://x/ws',
    );
    client.connect();
    socket.open();

    socket.emit({
      kind: 'hello',
      protocolV: 1,
      serverVersion: '1.0',
      sessions: [],
      recordings: [],
    });
    expect(c.hellos).toHaveLength(1);

    socket.emit({ kind: 'snapshot', sessionId: 's1', state: createWorkspace(), lastSeq: 3 });
    expect(c.snapshots).toHaveLength(1);

    socket.emit({ kind: 'event', event: sampleEvent(4) });
    expect(c.events).toHaveLength(1);
    expect(c.events[0]?.seq).toBe(4);
    expect(c.connections).toContain('open');
  });

  it('subscribes and unsubscribes with the right frames', () => {
    const c = collector();
    const socket = new MockSocket();
    const client = new BridgeClient(
      c.handlers,
      () => socket,
      () => 'ws://x/ws',
    );
    client.connect();
    socket.open();

    client.subscribe('s1');
    expect(socket.sentFrames()).toContainEqual({ kind: 'subscribe', sessionId: 's1' });

    client.subscribe('s2');
    expect(socket.sentFrames()).toContainEqual({ kind: 'unsubscribe', sessionId: 's1' });
    expect(socket.sentFrames()).toContainEqual({ kind: 'subscribe', sessionId: 's2' });
  });

  it('ignores malformed frames without throwing', () => {
    const c = collector();
    const socket = new MockSocket();
    const client = new BridgeClient(
      c.handlers,
      () => socket,
      () => 'ws://x/ws',
    );
    client.connect();
    socket.open();
    expect(() => socket.onmessage?.({ data: 'not json' })).not.toThrow();
    expect(c.events).toHaveLength(0);
  });

  it('resumes from the last seq after a reconnect', () => {
    vi.useFakeTimers();
    const c = collector();
    const sockets: MockSocket[] = [];
    const factory = () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    };
    const client = new BridgeClient(c.handlers, factory, () => 'ws://x/ws');
    client.connect();
    sockets[0]!.open();
    client.subscribe('s1');
    sockets[0]!.emit({ kind: 'snapshot', sessionId: 's1', state: createWorkspace(), lastSeq: 5 });
    sockets[0]!.emit({ kind: 'event', event: sampleEvent(6) });

    // Drop the connection; the client should schedule a reconnect.
    sockets[0]!.close();
    vi.advanceTimersByTime(600);
    expect(sockets).toHaveLength(2);

    // New socket opens; it must re-subscribe asking for the gap after seq 6.
    sockets[1]!.open();
    expect(sockets[1]!.sentFrames()).toContainEqual({
      kind: 'subscribe',
      sessionId: 's1',
      fromSeq: 7,
    });
  });
});
