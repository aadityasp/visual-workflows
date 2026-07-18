import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyEvent } from '@visual-workflows/protocol';
import { parseEventEnvelope } from '@visual-workflows/protocol';
import { EventBus } from '../src/bus.js';
import { createDemoAdapter } from '../src/adapters/demo/index.js';
import { DEMO_TIMELINE, DEMO_TOTAL_MS } from '../src/adapters/demo/timeline.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function runFullDemo(speed = 1): Promise<{ events: AnyEvent[]; sessionId: string }> {
  const bus = new EventBus();
  const events: AnyEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const demo = createDemoAdapter(bus);
  const { sessionId } = demo.start(speed);
  await vi.advanceTimersByTimeAsync(Math.ceil(DEMO_TOTAL_MS / speed) + 1000);
  return { events, sessionId };
}

function ofType(events: AnyEvent[], type: string): AnyEvent[] {
  return events.filter((e) => e.type === type);
}

describe('demo adapter', () => {
  it('plays a full valid story: every event passes parseEventEnvelope', async () => {
    const { events, sessionId } = await runFullDemo();
    expect(events.length).toBeGreaterThanOrEqual(55);
    for (const event of events) {
      const parsed = parseEventEnvelope(event);
      expect(parsed.ok, `event ${event.type} seq ${event.seq} invalid`).toBe(true);
      expect(event.source).toBe('demo');
      expect(event.sessionId).toBe(sessionId);
    }
    // seq strictly increasing
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('runs the two coders in parallel (created same second, interleaved work)', async () => {
    const { events } = await runFullDemo();
    const created = ofType(events, 'agent_created');
    const coderA = created.find((e) => e.agentId === 'coder-a');
    const coderB = created.find((e) => e.agentId === 'coder-b');
    expect(coderA).toBeDefined();
    expect(coderB).toBeDefined();
    const dt = Math.abs(Date.parse(coderA?.ts ?? '') - Date.parse(coderB?.ts ?? ''));
    expect(dt).toBeLessThan(1000); // same second

    // Interleaved: coder-a events occur between coder-b's start and completion.
    const bStart = events.find((e) => e.type === 'agent_started' && e.agentId === 'coder-b');
    const bDone = events.find((e) => e.type === 'agent_completed' && e.agentId === 'coder-b');
    expect(bStart).toBeDefined();
    expect(bDone).toBeDefined();
    const aWorkBetween = events.filter(
      (e) =>
        e.agentId === 'coder-a' &&
        e.seq > (bStart?.seq ?? 0) &&
        e.seq < (bDone?.seq ?? Infinity) &&
        (e.type === 'agent_tool_called' || e.type === 'agent_file_modified'),
    );
    expect(aWorkBetween.length).toBeGreaterThan(0);
  });

  it('tells the review story: approval requested, coder blocked, retried, workflow completes', async () => {
    const { events } = await runFullDemo();

    const approval = ofType(events, 'approval_requested')[0];
    expect(approval).toBeDefined();
    expect((approval?.payload as { kind?: string }).kind).toBe('question');
    expect((approval?.payload as { prompt?: string }).prompt).toContain('ThemeProvider');

    const blocked = events.find((e) => e.type === 'agent_blocked' && e.agentId === 'coder-a');
    expect((blocked?.payload as { kind?: string }).kind).toBe('dependency');

    const resolved = ofType(events, 'approval_resolved')[0];
    expect((resolved?.payload as { requestId?: string }).requestId).toBe(
      (approval?.payload as { requestId?: string }).requestId,
    );
    expect(resolved && approval && resolved.seq > approval.seq).toBe(true);

    const retried = events.find((e) => e.type === 'agent_retried' && e.agentId === 'coder-a');
    expect(retried).toBeDefined();

    const workflowDone = ofType(events, 'workflow_completed')[0];
    expect((workflowDone?.payload as { status?: string }).status).toBe('completed');

    // Every named agent completes with a summary; one token_usage each.
    const agents = ['main', 'planner', 'researcher', 'coder-a', 'coder-b', 'tester', 'reviewer'];
    for (const id of agents) {
      const done = events.find((e) => e.type === 'agent_completed' && e.agentId === id);
      expect(done, `agent_completed missing for ${id}`).toBeDefined();
      expect(typeof (done?.payload as { summary?: unknown }).summary).toBe('string');
      const usage = events.find((e) => e.type === 'token_usage' && e.agentId === id);
      expect(usage, `token_usage missing for ${id}`).toBeDefined();
    }
  });

  it('reduces into a completed session on the bus state', async () => {
    const bus = new EventBus();
    const demo = createDemoAdapter(bus);
    const { sessionId } = demo.start(1);
    await vi.advanceTimersByTimeAsync(DEMO_TOTAL_MS + 1000);
    const session = bus.getState().sessions[sessionId];
    expect(session?.active).toBe(false);
    expect(Object.values(session?.workflows ?? {})[0]?.status).toBe('completed');
    expect(session?.agentOrder.length).toBe(7);
    for (const agent of Object.values(session?.agents ?? {})) {
      expect(agent.lifecycle).toBe('completed');
    }
  });

  it('scales the timeline by 1/speed and stop() cancels pending steps', async () => {
    const bus = new EventBus();
    const events: AnyEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const demo = createDemoAdapter(bus);

    // speed 10: full story in DEMO_TOTAL_MS / 10.
    demo.start(10);
    await vi.advanceTimersByTimeAsync(Math.ceil(DEMO_TOTAL_MS / 10) + 100);
    expect(ofType(events, 'workflow_completed')).toHaveLength(1);

    // A stopped run emits only its closure (cancelled + ended) and then goes
    // silent — no timeline step fires afterwards.
    events.length = 0;
    demo.start(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(events.length).toBeGreaterThan(0);
    demo.stop();
    expect(demo.running).toBe(false);
    const closures = ofType(events, 'workflow_completed');
    expect(closures).toHaveLength(1);
    expect((closures[0]?.payload as { status?: string }).status).toBe('cancelled');
    expect(ofType(events, 'session_ended')).toHaveLength(1);
    const countAtStop = events.length;
    await vi.advanceTimersByTimeAsync(DEMO_TOTAL_MS + 1000);
    expect(events.length).toBe(countAtStop);
  });

  it('restarting mid-run closes out the abandoned session instead of stranding it', async () => {
    const bus = new EventBus();
    const demo = createDemoAdapter(bus);
    const first = demo.start(1);
    await vi.advanceTimersByTimeAsync(3000); // session + workflow started, agents running
    expect(bus.getState().sessions[first.sessionId]?.active).toBe(true);

    const second = demo.start(1); // restart mid-run
    const abandoned = bus.getState().sessions[first.sessionId];
    expect(abandoned?.active).toBe(false); // not stuck running
    expect(Object.values(abandoned?.workflows ?? {})[0]?.status).toBe('cancelled');
    for (const agent of Object.values(abandoned?.agents ?? {})) {
      expect(['completed', 'failed', 'cancelled']).toContain(agent.lifecycle);
    }

    // The replacement run still plays through to a normal completion.
    await vi.advanceTimersByTimeAsync(DEMO_TOTAL_MS + 1000);
    const replacement = bus.getState().sessions[second.sessionId];
    expect(replacement?.active).toBe(false);
    expect(Object.values(replacement?.workflows ?? {})[0]?.status).toBe('completed');

    // stop() after natural completion must not rewrite the finished session.
    demo.stop();
    expect(
      Object.values(bus.getState().sessions[second.sessionId]?.workflows ?? {})[0]?.status,
    ).toBe('completed');
  });

  it('uses a fresh demo-<n> session per run', async () => {
    const bus = new EventBus();
    const demo = createDemoAdapter(bus);
    const first = demo.start(100);
    await vi.advanceTimersByTimeAsync(Math.ceil(DEMO_TOTAL_MS / 100) + 100);
    const second = demo.start(100);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.sessionId).toMatch(/^demo-\d+$/);
    demo.stop();
  });

  it('timeline data spans ~90s with 55+ events at speed 1', () => {
    expect(DEMO_TOTAL_MS).toBeGreaterThanOrEqual(80_000);
    expect(DEMO_TOTAL_MS).toBeLessThanOrEqual(100_000);
    expect(DEMO_TIMELINE.length).toBeGreaterThan(20);
    const atMsValues = DEMO_TIMELINE.map((s) => s.atMs);
    expect([...atMsValues].sort((a, b) => a - b)).toEqual(atMsValues); // ordered
  });
});
