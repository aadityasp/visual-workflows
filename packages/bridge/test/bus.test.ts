import { describe, expect, it } from 'vitest';
import type { AnyEvent } from '@visual-workflows/protocol';
import { EventBus } from '../src/bus.js';
import type { EventInit } from '../src/adapters/types.js';

function init(overrides: Partial<EventInit> = {}): EventInit {
  return {
    ts: new Date().toISOString(),
    source: 'manual',
    sessionId: 's1',
    type: 'agent_output',
    agentId: 'main',
    payload: { stream: 'message', chunk: 'hello' },
    ...overrides,
  } as EventInit;
}

describe('EventBus', () => {
  it('assigns increasing per-session seq and unique ids', () => {
    const bus = new EventBus();
    const a = bus.emit(init());
    const b = bus.emit(init());
    const c = bus.emit(init({ sessionId: 's2' }));
    if (!a.ok || !b.ok || !c.ok) throw new Error('emit failed');
    expect(a.event.seq).toBe(1);
    expect(b.event.seq).toBe(2);
    expect(c.event.seq).toBe(1); // independent counter per session
    expect(a.event.id).not.toBe(b.event.id);
    expect(a.event.v).toBe(1);
    expect(bus.lastSeq('s1')).toBe(2);
    expect(bus.lastSeq('nope')).toBe(0);
  });

  it('preserves an adapter-supplied id', () => {
    const bus = new EventBus();
    const r = bus.emit(init({ id: 'evt-fixed-1' }));
    if (!r.ok) throw new Error(r.error);
    expect(r.event.id).toBe('evt-fixed-1');
  });

  it('rejects invalid events without consuming a seq', () => {
    const bus = new EventBus();
    const bad = bus.emit(
      init({ type: 'workflow_started', payload: { kind: 'demo' } as never }), // missing name
    );
    expect(bad.ok).toBe(false);
    const missingSession = bus.emit(init({ sessionId: '' }));
    expect(missingSession.ok).toBe(false);
    const good = bus.emit(init());
    if (!good.ok) throw new Error(good.error);
    expect(good.event.seq).toBe(1); // rejected events never advanced the counter
  });

  it('accepts unknown event types (tolerant reader)', () => {
    const bus = new EventBus();
    const r = bus.emit(init({ type: 'future_event' as never, payload: { x: 1 } as never }));
    expect(r.ok).toBe(true);
  });

  it('keeps a live WorkspaceState via the reducer', () => {
    const bus = new EventBus();
    bus.emit(init({ type: 'session_started', payload: { title: 'T', cwd: '/w' } }));
    bus.emit(
      init({
        type: 'agent_created',
        agentId: 'a1',
        payload: { name: 'Coder', kind: 'subagent', parentAgentId: 'main' },
      }),
    );
    bus.emit(init({ type: 'agent_started', agentId: 'a1', payload: {} }));
    const state = bus.getState();
    const session = state.sessions['s1'];
    expect(session?.title).toBe('T');
    expect(session?.agents['a1']?.name).toBe('Coder');
    expect(session?.agents['a1']?.lifecycle).toBe('running');
    expect(session?.agents['main']?.childIds).toContain('a1');
    expect(session?.lastSeq).toBe(3);
  });

  it('getEventsFrom returns events with seq >= fromSeq', () => {
    const bus = new EventBus();
    for (let i = 0; i < 5; i += 1) bus.emit(init());
    const events = bus.getEventsFrom('s1', 3);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(bus.getEventsFrom('unknown', 1)).toEqual([]);
  });

  it('notifies subscribers and honors unsubscribe', () => {
    const bus = new EventBus();
    const seen: AnyEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    bus.emit(init());
    unsub();
    bus.emit(init());
    expect(seen).toHaveLength(1);
  });

  it('produces SessionSummary entries per frames.ts', () => {
    const bus = new EventBus();
    bus.emit(init({ type: 'session_started', payload: { title: 'Demo run', cwd: '/x' } }));
    bus.emit(init());
    const summaries = bus.sessionSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sessionId: 's1',
      source: 'manual',
      title: 'Demo run',
      cwd: '/x',
      active: true,
      agentCount: 1,
      lastSeq: 2,
    });
  });
});
