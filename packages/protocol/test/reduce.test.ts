import { describe, expect, it } from 'vitest';
import type { AnyEvent, EventEnvelope, EventPayloadMap, EventType } from '../src/index.js';
import {
  createWorkspace,
  LIMITS,
  MAIN_AGENT_ID,
  reduce,
  reduceAll,
  replayToSeq,
} from '../src/index.js';

let seqCounter = 0;

function ev<T extends EventType>(
  type: T,
  payload: EventPayloadMap[T],
  extra: Partial<Pick<EventEnvelope, 'sessionId' | 'agentId' | 'workflowId' | 'seq' | 'ts'>> = {},
): EventEnvelope<T> {
  seqCounter += 1;
  return {
    v: 1,
    id: `e${seqCounter}`,
    seq: extra.seq ?? seqCounter,
    ts: extra.ts ?? `2026-07-17T12:00:${String(seqCounter % 60).padStart(2, '0')}.000Z`,
    source: 'demo',
    sessionId: extra.sessionId ?? 's1',
    agentId: extra.agentId,
    workflowId: extra.workflowId,
    type,
    payload,
  };
}

function fresh() {
  seqCounter = 0;
  return createWorkspace();
}

describe('reduce — sessions and agents', () => {
  it('creates a session and main agent on session_started', () => {
    const s = reduce(fresh(), ev('session_started', { cwd: '/repo', title: 'demo' }));
    const session = s.sessions['s1'];
    expect(session).toBeDefined();
    expect(session?.active).toBe(true);
    expect(session?.agents[MAIN_AGENT_ID]?.kind).toBe('main');
  });

  it('creates agents with parent linkage and spawn dependency', () => {
    const events: AnyEvent[] = [
      ev('session_started', {}),
      ev(
        'agent_created',
        { name: 'Coder A', kind: 'subagent', agentType: 'coder', parentAgentId: MAIN_AGENT_ID },
        { agentId: 'a1' },
      ),
      ev('dependency_created', { fromAgentId: MAIN_AGENT_ID, toAgentId: 'a1', kind: 'spawns' }),
    ];
    const s = reduceAll(fresh(), events);
    const session = s.sessions['s1'];
    expect(session?.agents['a1']?.parentAgentId).toBe(MAIN_AGENT_ID);
    expect(session?.agents[MAIN_AGENT_ID]?.childIds).toContain('a1');
    expect(Object.keys(session?.deps ?? {})).toHaveLength(1);
  });

  it('tolerates events for unknown agents by creating stubs', () => {
    const s = reduce(
      fresh(),
      ev('agent_output', { stream: 'message', chunk: 'hi' }, { agentId: 'ghost' }),
    );
    expect(s.sessions['s1']?.agents['ghost']).toBeDefined();
  });

  it('completes running agents when the session ends', () => {
    const s = reduceAll(fresh(), [
      ev('agent_started', {}, { agentId: 'a1' }),
      ev('session_ended', { reason: 'exit' }),
    ]);
    expect(s.sessions['s1']?.active).toBe(false);
    expect(s.sessions['s1']?.agents['a1']?.lifecycle).toBe('completed');
  });
});

describe('reduce — activity inference through tool events', () => {
  it('maps tools to activities and back to thinking on completion', () => {
    let s = reduceAll(fresh(), [
      ev('agent_started', {}, { agentId: 'a1' }),
      ev(
        'agent_tool_called',
        { toolCallId: 't1', tool: 'Read', inputSummary: 'src/index.ts' },
        { agentId: 'a1' },
      ),
    ]);
    expect(s.sessions['s1']?.agents['a1']?.activity).toBe('reading');

    s = reduce(s, ev('agent_tool_completed', { toolCallId: 't1', ok: true }, { agentId: 'a1' }));
    expect(s.sessions['s1']?.agents['a1']?.activity).toBe('thinking');
  });

  it('detects testing from Bash commands and reviewing from agent names', () => {
    let s = reduceAll(fresh(), [
      ev(
        'agent_created',
        { name: 'Reviewer', kind: 'subagent', agentType: 'reviewer' },
        { agentId: 'r1' },
      ),
      ev('agent_started', {}, { agentId: 'r1' }),
      ev(
        'agent_tool_called',
        { toolCallId: 't1', tool: 'Bash', inputSummary: 'npx vitest run' },
        { agentId: 'r1' },
      ),
    ]);
    expect(s.sessions['s1']?.agents['r1']?.activity).toBe('testing');
    s = reduce(s, ev('agent_tool_completed', { toolCallId: 't1', ok: true }, { agentId: 'r1' }));
    expect(s.sessions['s1']?.agents['r1']?.activity).toBe('reviewing');
  });

  it('is idempotent on duplicate toolCallIds (hook + tailer dual report)', () => {
    const s = reduceAll(fresh(), [
      ev(
        'agent_tool_called',
        { toolCallId: 'toolu_1', tool: 'Bash', inputSummary: 'echo hi' },
        { agentId: 'a1' },
      ),
      ev(
        'agent_tool_called',
        { toolCallId: 'toolu_1', tool: 'Bash', inputSummary: 'echo hi' },
        { agentId: 'a1' },
      ),
    ]);
    const a = s.sessions['s1']?.agents['a1'];
    expect(a?.toolCalls).toHaveLength(1);
    expect(a?.toolCallCount).toBe(1);
    expect(a?.activeToolCallIds).toEqual(['toolu_1']);
  });
});

describe('reduce — attention lifecycle', () => {
  it('tracks failures and resolves attention on completion', () => {
    let s = reduce(fresh(), reduceHelperFail('a1'));
    expect(s.sessions['s1']?.attention.filter((i) => !i.resolved)).toHaveLength(1);
    s = reduce(s, ev('agent_completed', { summary: 'recovered' }, { agentId: 'a1' }));
    expect(s.sessions['s1']?.attention.filter((i) => !i.resolved)).toHaveLength(0);
  });

  it('does not downgrade a failed agent to completed, but still records the summary/usage', () => {
    // A completion arriving after a failure must not flip the terminal
    // outcome (asymmetry the reducer previously had with session_ended, which
    // already preserves 'failed').
    let s = reduce(fresh(), reduceHelperFail('a1'));
    expect(s.sessions['s1']?.agents['a1']?.lifecycle).toBe('failed');
    s = reduce(
      s,
      ev(
        'agent_completed',
        { summary: 'wrapped up', usage: { inputTokens: 42 } },
        { agentId: 'a1' },
      ),
    );
    const a = s.sessions['s1']?.agents['a1'];
    expect(a?.lifecycle).toBe('failed'); // not downgraded to 'completed'
    expect(a?.summary).toBe('wrapped up'); // enriched
    expect(a?.usage).toEqual({ inputTokens: 42 }); // enriched
    expect(a?.endedTs).toBeDefined();
  });

  it('handles approval request/resolve round trip', () => {
    let s = reduceAll(fresh(), [
      ev('agent_started', {}, { agentId: 'a1' }),
      ev(
        'approval_requested',
        { requestId: 'req1', kind: 'question', prompt: 'Apply fix?' },
        { agentId: 'a1' },
      ),
    ]);
    expect(s.sessions['s1']?.agents['a1']?.lifecycle).toBe('awaiting_approval');
    s = reduce(
      s,
      ev('approval_resolved', { requestId: 'req1', resolution: 'yes' }, { agentId: 'a1' }),
    );
    expect(s.sessions['s1']?.agents['a1']?.lifecycle).toBe('running');
    expect(s.sessions['s1']?.attention.every((i) => i.resolved)).toBe(true);
  });

  it('retry clears failure state', () => {
    let s = reduce(fresh(), reduceHelperFail('a1'));
    s = reduce(s, ev('agent_retried', { retryCount: 1 }, { agentId: 'a1' }));
    const a = s.sessions['s1']?.agents['a1'];
    expect(a?.lifecycle).toBe('running');
    expect(a?.error).toBeUndefined();
    expect(a?.retryCount).toBe(1);
  });

  it('retry resolves the stale failure card so the rail clears', () => {
    let s = reduce(fresh(), reduceHelperFail('a1'));
    expect(s.sessions['s1']?.attention.filter((i) => !i.resolved)).toHaveLength(1);
    s = reduce(s, ev('agent_retried', { retryCount: 1 }, { agentId: 'a1' }));
    expect(s.sessions['s1']?.attention.filter((i) => !i.resolved)).toHaveLength(0);
  });

  it('an implicit unblock (status→running) resolves the blocker card', () => {
    let s = reduceAll(fresh(), [
      ev('agent_started', {}, { agentId: 'a1' }),
      ev('agent_blocked', { reason: 'waiting on approval' }, { agentId: 'a1' }),
    ]);
    expect(s.sessions['s1']?.agents['a1']?.lifecycle).toBe('blocked');
    expect(s.sessions['s1']?.attention.filter((i) => !i.resolved)).toHaveLength(1);
    s = reduce(s, ev('agent_status_changed', { lifecycle: 'running' }, { agentId: 'a1' }));
    expect(s.sessions['s1']?.agents['a1']?.lifecycle).toBe('running');
    expect(s.sessions['s1']?.agents['a1']?.blocked).toBeUndefined();
    expect(s.sessions['s1']?.attention.filter((i) => !i.resolved)).toHaveLength(0);
  });
});

function reduceHelperFail(agentId: string) {
  return ev('agent_failed', { error: { message: 'boom' } }, { agentId });
}

describe('reduce — bounds, duplicates, determinism', () => {
  it('caps the output tail ring buffer', () => {
    const events: AnyEvent[] = [];
    for (let i = 0; i < LIMITS.outputTail + 25; i++) {
      events.push(ev('agent_output', { stream: 'stdout', chunk: `line ${i}` }, { agentId: 'a1' }));
    }
    const s = reduceAll(fresh(), events);
    const a = s.sessions['s1']?.agents['a1'];
    expect(a?.outputTail).toHaveLength(LIMITS.outputTail);
    expect(a?.outputTotal).toBe(LIMITS.outputTail + 25);
    expect(a?.outputTail.at(-1)?.text).toBe(`line ${LIMITS.outputTail + 24}`);
  });

  it('skips duplicate seq (idempotent re-delivery)', () => {
    const first = ev('agent_output', { stream: 'stdout', chunk: 'once' }, { agentId: 'a1' });
    let s = reduce(fresh(), first);
    s = reduce(s, first);
    expect(s.sessions['s1']?.eventCount).toBe(1);
    expect(s.sessions['s1']?.agents['a1']?.outputTotal).toBe(1);
  });

  it('replayToSeq is a deterministic prefix of full reduction', () => {
    seqCounter = 0;
    const events: AnyEvent[] = [
      ev('session_started', {}),
      ev('agent_created', { name: 'X', kind: 'subagent' }, { agentId: 'a1' }),
      ev('agent_started', {}, { agentId: 'a1' }),
      ev('agent_output', { stream: 'message', chunk: 'a' }, { agentId: 'a1' }),
      ev('agent_completed', { summary: 'done' }, { agentId: 'a1' }),
    ];
    const partial = replayToSeq(events, 3);
    expect(partial.sessions['s1']?.agents['a1']?.lifecycle).toBe('running');
    const full = replayToSeq(events, 5);
    expect(full).toEqual(reduceAll(createWorkspace(), events));
    expect(full.sessions['s1']?.agents['a1']?.lifecycle).toBe('completed');
  });

  it('tolerates unknown event types without crashing', () => {
    const rogue = {
      ...ev('adapter_notice', { level: 'info', message: 'x' }),
      type: 'totally_unknown_event',
      payload: { whatever: true },
    } as unknown as AnyEvent;
    const s = reduce(fresh(), rogue);
    expect(s.sessions['s1']?.eventCount).toBe(1);
  });

  it('merges token usage cumulatively', () => {
    const s = reduceAll(fresh(), [
      ev('token_usage', { usage: { inputTokens: 100 } }, { agentId: 'a1' }),
      ev('token_usage', { usage: { outputTokens: 50 } }, { agentId: 'a1' }),
    ]);
    expect(s.sessions['s1']?.agents['a1']?.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('tracks workflows and their agents', () => {
    const s = reduceAll(fresh(), [
      ev('workflow_started', { name: 'build', kind: 'workflow' }, { workflowId: 'wf1' }),
      ev(
        'agent_created',
        { name: 'W1', kind: 'workflow-agent' },
        { agentId: 'a1', workflowId: 'wf1' },
      ),
      ev('workflow_completed', { status: 'completed', summary: 'ok' }, { workflowId: 'wf1' }),
    ]);
    const wf = s.sessions['s1']?.workflows['wf1'];
    expect(wf?.agentIds).toEqual(['a1']);
    expect(wf?.status).toBe('completed');
  });

  it('merges duplicate workflow_started without wiping agents or start time', () => {
    const s = reduceAll(fresh(), [
      ev('workflow_started', { name: 'build', kind: 'workflow' }, { workflowId: 'wf1' }),
      ev(
        'agent_created',
        { name: 'W1', kind: 'workflow-agent' },
        { agentId: 'a1', workflowId: 'wf1' },
      ),
      ev(
        'workflow_started',
        { name: 'build v2', kind: 'workflow', description: 'second announce' },
        { workflowId: 'wf1' },
      ),
    ]);
    const wf = s.sessions['s1']?.workflows['wf1'];
    expect(wf?.agentIds).toEqual(['a1']);
    expect(wf?.status).toBe('running');
    expect(wf?.startedTs).toContain(':01.000Z'); // first announce, not the duplicate
    expect(wf?.name).toBe('build v2');
    expect(wf?.description).toBe('second announce');
  });

  it('does not revive a completed agent via late lifecycle events', () => {
    let s = reduceAll(fresh(), [
      ev('agent_started', {}, { agentId: 'a1' }),
      ev('agent_completed', { summary: 'done' }, { agentId: 'a1' }),
    ]);
    s = reduce(s, ev('agent_started', {}, { agentId: 'a1' }));
    expect(s.sessions['s1']?.agents['a1']?.lifecycle).toBe('completed');
    s = reduce(s, ev('agent_status_changed', { lifecycle: 'running' }, { agentId: 'a1' }));
    const a = s.sessions['s1']?.agents['a1'];
    expect(a?.lifecycle).toBe('completed');
    expect(a?.activity).toBe('idle');
  });

  it('clones payload objects instead of adopting (and freezing) them', () => {
    const phases = [{ title: 'phase 1' }];
    const options = ['yes', 'no'];
    const error = { message: 'boom' };
    let s = reduce(
      fresh(),
      ev('workflow_started', { name: 'w', kind: 'workflow', phases }, { workflowId: 'wf1' }),
    );
    s = reduce(
      s,
      ev(
        'approval_requested',
        { requestId: 'r1', kind: 'question', prompt: 'ok?', options },
        { agentId: 'a1' },
      ),
    );
    s = reduce(s, ev('agent_failed', { error }, { agentId: 'a1' }));

    // state holds clones, not the caller's payload objects
    expect(s.sessions['s1']?.workflows['wf1']?.phases).not.toBe(phases);
    expect(s.sessions['s1']?.attention[0]?.options).not.toBe(options);
    expect(s.sessions['s1']?.agents['a1']?.error).not.toBe(error);
    // immer auto-freeze froze the state clones, not the event payloads
    expect(Object.isFrozen(phases)).toBe(false);
    expect(Object.isFrozen(phases[0])).toBe(false);
    expect(Object.isFrozen(options)).toBe(false);
    expect(Object.isFrozen(error)).toBe(false);
    phases.push({ title: 'phase 2' }); // caller can still mutate its own objects
    options.push('maybe');
    expect(s.sessions['s1']?.workflows['wf1']?.phases).toHaveLength(1);
    expect(s.sessions['s1']?.attention[0]?.options).toEqual(['yes', 'no']);
  });

  it('keeps distinct deps whose naive hyphen-joined ids would collide', () => {
    const s = reduceAll(fresh(), [
      ev('dependency_created', { fromAgentId: 'a-b', toAgentId: 'c', kind: 'feeds' }),
      ev('dependency_created', { fromAgentId: 'a', toAgentId: 'b-c', kind: 'feeds' }),
    ]);
    const deps = Object.values(s.sessions['s1']?.deps ?? {});
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => `${d.fromAgentId}→${d.toAgentId}`).sort()).toEqual(['a-b→c', 'a→b-c']);
  });
});
