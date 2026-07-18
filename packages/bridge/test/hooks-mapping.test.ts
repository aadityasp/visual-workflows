/**
 * mapHookPayload tests — fed the EXACT sanitized hook payload shapes captured
 * in docs/discovery/liveHooks.md (v2.1.212, arm64) plus the documented
 * <task-notification> re-entry shape. Every mapped event is round-tripped
 * through parseEventEnvelope (replicating what EventBus.emit does when it
 * assigns v/id/seq) to guarantee the mapper never produces a schema-invalid
 * event.
 */
import { describe, expect, it } from 'vitest';
import { createWorkspace, parseEventEnvelope, reduceAll } from '@visual-workflows/protocol';
import type { EventEnvelope } from '@visual-workflows/protocol';
import { mapHookPayload } from '../src/adapters/hooks/index.js';
import type { EventInit } from '../src/adapters/types.js';

/** Mirrors EventBus.emit()'s envelope assignment (v/id/seq) without needing
 * a live bus — mapHookPayload's contract is "valid EventInit in, valid
 * envelope once sequenced" and this is the cheapest way to prove it. */
function assertAllValid(events: EventInit[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    const envelope = { ...e, v: 1, id: e.id ?? 'x', seq: 1 };
    const parsed = parseEventEnvelope(envelope);
    expect(parsed.ok, `${e.type} invalid: ${!parsed.ok ? parsed.error : ''}`).toBe(true);
  }
}

function find(events: EventInit[], type: string): EventInit | undefined {
  return events.find((e) => e.type === type);
}

/** Sequence EventInits into envelopes (as EventBus.emit would) and reduce. */
function reduceEvents(events: EventInit[]) {
  const envelopes = events.map(
    (e, i) => ({ ...e, v: 1, id: e.id ?? `env-${i}`, seq: i + 1 }) as EventEnvelope,
  );
  return reduceAll(createWorkspace(), envelopes);
}

describe('mapHookPayload', () => {
  it('SessionStart -> session_started', () => {
    const events = mapHookPayload({
      session_id: 'e090e726-528b-4453-a90f-c65016d2d293',
      transcript_path: '/home/u/.claude/projects/-tmp-w/e090e726.jsonl',
      cwd: '/tmp/w',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session_started',
      sessionId: 'e090e726-528b-4453-a90f-c65016d2d293',
      source: 'hook',
      payload: { cwd: '/tmp/w', source: 'startup' },
    });
  });

  it('UserPromptSubmit (plain) -> agent_status_changed thinking on main', () => {
    const events = mapHookPayload({
      session_id: 's1',
      cwd: '/tmp/w',
      permission_mode: 'default',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Use the Bash tool to run exactly: echo hooktest-123',
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent_status_changed',
      agentId: 'main',
      payload: {
        activity: 'thinking',
        reason: 'user_prompt',
        currentAction: 'Responding to prompt',
      },
    });
  });

  it('UserPromptSubmit with <task-notification> (completed) -> agent_completed for the task agent', () => {
    const prompt = [
      '<task-notification>',
      '<task-id>aa91056a25d3a6fed</task-id>',
      '<tool-use-id>toolu_01ATC8QGvfBLP7EL2uaRxHEN</tool-use-id>',
      '<output-file>/tmp/tasks/aa91056a25d3a6fed.output</output-file>',
      '<status>completed</status>',
      '<summary>Ran the requested echo</summary>',
      '<note>Task complete</note>',
      '<result>The output is:\n\n```\nsubtest-456\n```</result>',
      '<usage><subagent_tokens>16938</subagent_tokens><tool_uses>1</tool_uses><duration_ms>6811</duration_ms></usage>',
      '</task-notification>',
    ].join('\n');
    const events = mapHookPayload({
      session_id: 's1',
      cwd: '/tmp/w',
      permission_mode: 'default',
      hook_event_name: 'UserPromptSubmit',
      prompt,
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    const e = find(events, 'agent_completed');
    expect(e).toMatchObject({
      agentId: 'aa91056a25d3a6fed',
      payload: { usage: { totalTokens: 16938 } },
    });
    const payload = e?.payload as { summary?: string };
    expect(payload.summary).toContain('subtest-456');
  });

  it('UserPromptSubmit with <task-notification> (non-completed status) -> adapter_notice, not agent_completed', () => {
    const prompt = [
      '<task-notification>',
      '<task-id>aa91056a25d3a6fed</task-id>',
      '<status>failed</status>',
      '<result>boom</result>',
      '</task-notification>',
    ].join('\n');
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'UserPromptSubmit',
      prompt,
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'adapter_notice' });
    const payload = events[0]?.payload as { message: string };
    expect(payload.message).toContain('aa91056a25d3a6fed');
    expect(payload.message).toContain('failed');
  });

  it('PreToolUse Bash -> agent_tool_called + agent_command_started, redacting a planted AWS key', () => {
    const events = mapHookPayload({
      session_id: 's1',
      cwd: '/tmp/w',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01ATC8QGvfBLP7EL2uaRxHEN',
      tool_input: {
        command: 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE',
        description: 'Configure AWS creds',
      },
    });
    assertAllValid(events);
    expect(events).toHaveLength(2);

    const called = find(events, 'agent_tool_called');
    expect(called).toMatchObject({
      agentId: 'main',
      payload: { toolCallId: 'toolu_01ATC8QGvfBLP7EL2uaRxHEN', tool: 'Bash' },
    });
    const calledPayload = called?.payload as { inputSummary: string };
    expect(calledPayload.inputSummary).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(calledPayload.inputSummary).toContain('REDACTED');

    const started = find(events, 'agent_command_started');
    expect(started).toMatchObject({
      agentId: 'main',
      payload: {
        commandId: 'toolu_01ATC8QGvfBLP7EL2uaRxHEN',
        cwd: '/tmp/w',
        description: 'Configure AWS creds',
      },
    });
    const startedPayload = started?.payload as { command: string };
    expect(startedPayload.command).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(startedPayload.command).toContain('REDACTED');
  });

  it('PreToolUse Read -> agent_tool_called + agent_file_read', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 'toolu_2',
      tool_input: { file_path: '/tmp/w/file.txt' },
    });
    assertAllValid(events);
    expect(events).toHaveLength(2);
    expect(find(events, 'agent_file_read')).toMatchObject({
      agentId: 'main',
      payload: { path: '/tmp/w/file.txt' },
    });
  });

  it('PreToolUse with agent_id/agent_type -> events attributed to the subagent, not main', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_3',
      tool_input: { command: 'echo subtest-456' },
      agent_id: 'aa91056a25d3a6fed',
      agent_type: 'general-purpose',
    });
    assertAllValid(events);
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.agentId).toBe('aa91056a25d3a6fed');
  });

  it('PostToolUse Bash -> agent_tool_completed + agent_command_completed with duration', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01ATC8QGvfBLP7EL2uaRxHEN',
      tool_input: { command: 'echo hooktest-123' },
      tool_response: {
        stdout: 'hooktest-123',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
      duration_ms: 3556,
    });
    assertAllValid(events);
    expect(events).toHaveLength(3);
    expect(find(events, 'approval_resolved')).toMatchObject({
      payload: { requestId: 'toolu_01ATC8QGvfBLP7EL2uaRxHEN', resolution: 'answered' },
    });
    expect(find(events, 'agent_tool_completed')).toMatchObject({
      agentId: 'main',
      payload: { toolCallId: 'toolu_01ATC8QGvfBLP7EL2uaRxHEN', ok: true, durationMs: 3556 },
    });
    expect(find(events, 'agent_command_completed')).toMatchObject({
      agentId: 'main',
      payload: { commandId: 'toolu_01ATC8QGvfBLP7EL2uaRxHEN', ok: true, durationMs: 3556 },
    });
  });

  it('PostToolUse Bash interrupted -> agent_command_completed ok:false', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_4',
      tool_input: { command: 'sleep 100' },
      tool_response: { stdout: '', stderr: '', interrupted: true },
      duration_ms: 900,
    });
    assertAllValid(events);
    expect(find(events, 'agent_command_completed')).toMatchObject({ payload: { ok: false } });
  });

  it('PostToolUse Edit -> agent_tool_completed + agent_file_modified', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_use_id: 'toolu_5',
      tool_input: { file_path: '/tmp/w/a.ts', old_string: 'a', new_string: 'b' },
      tool_response: { filePath: '/tmp/w/a.ts' },
      duration_ms: 40,
    });
    assertAllValid(events);
    expect(events).toHaveLength(3);
    expect(find(events, 'agent_file_modified')).toMatchObject({
      agentId: 'main',
      payload: { path: '/tmp/w/a.ts', changeKind: 'edited' },
    });
  });

  it('PostToolUse Agent async_launched -> agent_created + agent_started + dependency_created, NOT agent_completed', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_6',
      tool_input: {
        description: 'Run echo subtest-456',
        prompt: 'Run: echo subtest-456',
        subagent_type: 'general-purpose',
      },
      tool_response: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'aa91056a25d3a6fed',
        description: 'Run echo subtest-456',
        resolvedModel: 'claude-haiku-4-5-20251001',
        prompt: 'Run: echo subtest-456',
        outputFile: '/tmp/tasks/aa91056a25d3a6fed.output',
        canReadOutputFile: true,
      },
      duration_ms: 17,
    });
    assertAllValid(events);
    expect(events.map((e) => e.type)).toEqual([
      'approval_resolved',
      'agent_tool_completed',
      'agent_created',
      'agent_started',
      'dependency_created',
    ]);
    expect(find(events, 'agent_completed')).toBeUndefined();

    const created = find(events, 'agent_created');
    expect(created).toMatchObject({
      agentId: 'aa91056a25d3a6fed',
      payload: {
        name: 'Run echo subtest-456',
        kind: 'subagent',
        agentType: 'general-purpose',
        model: 'claude-haiku-4-5-20251001',
        parentAgentId: 'main',
      },
    });
    expect(find(events, 'agent_started')).toMatchObject({
      agentId: 'aa91056a25d3a6fed',
      payload: {},
    });
    expect(find(events, 'dependency_created')).toMatchObject({
      payload: { fromAgentId: 'main', toAgentId: 'aa91056a25d3a6fed', kind: 'spawns' },
    });
  });

  it('PostToolUse "Task" tool_name (defensive match) also spawns on async_launched', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Task',
      tool_use_id: 'toolu_7',
      tool_response: { status: 'async_launched', agentId: 'agent-x' },
    });
    assertAllValid(events);
    expect(find(events, 'agent_created')).toBeDefined();
  });

  it('SubagentStop -> agent_completed with summary', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'SubagentStop',
      agent_id: 'aa91056a25d3a6fed',
      agent_type: 'general-purpose',
      agent_transcript_path:
        '/home/u/.claude/projects/-tmp-w/s1/subagents/agent-aa91056a25d3a6fed.jsonl',
      last_assistant_message: 'The output is:\n\n```\nsubtest-456\n```',
      background_tasks: [],
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent_completed',
      agentId: 'aa91056a25d3a6fed',
      payload: { summary: 'The output is:\n\n```\nsubtest-456\n```' },
    });
  });

  it('Stop with non-empty background_tasks -> agent_status_changed waiting', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Working on it in the background.',
      background_tasks: [
        {
          id: 'aa91056a25d3a6fed',
          type: 'subagent',
          status: 'running',
          description: 'Run echo subtest-456',
          agent_type: 'general-purpose',
        },
      ],
      session_crons: [],
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent_status_changed',
      agentId: 'main',
      payload: { activity: 'waiting', currentAction: '1 background task running' },
    });
  });

  it('Stop with empty background_tasks -> agent_status_changed idle', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Done. The command output is `hooktest-123`.',
      background_tasks: [],
      session_crons: [],
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent_status_changed',
      agentId: 'main',
      payload: { activity: 'idle', currentAction: '' },
    });
  });

  it('SessionEnd -> session_ended', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'SessionEnd',
      reason: 'other',
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'session_ended', payload: { reason: 'other' } });
  });

  it('unknown hook_event_name -> adapter_notice (forward-compatible)', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'SomeFutureHookEvent',
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'adapter_notice', payload: { level: 'info' } });
    const payload = events[0]?.payload as { message: string };
    expect(payload.message).toContain('SomeFutureHookEvent');
  });

  it('UserPromptSubmit merely mentioning <task-notification> mid-text -> user input, not completion', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Can you explain what a <task-notification> block is used for?',
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent_status_changed',
      agentId: 'main',
      payload: { activity: 'thinking', reason: 'user_prompt' },
    });
    expect(find(events, 'agent_completed')).toBeUndefined();
    expect(find(events, 'adapter_notice')).toBeUndefined();
  });

  it('task-notification notice redacts taskId/status (planted AWS key never leaks)', () => {
    const prompt = [
      '<task-notification>',
      '<task-id>AKIAIOSFODNN7EXAMPLE</task-id>',
      '<status>failed</status>',
      '</task-notification>',
    ].join('\n');
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'UserPromptSubmit',
      prompt,
    });
    assertAllValid(events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'adapter_notice' });
    const payload = events[0]?.payload as { message: string };
    expect(payload.message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(payload.message).toContain('REDACTED');
  });

  it('SubagentStart after async_launched does not re-parent the agent or add a second spawn edge', () => {
    // Nested spawn: the Task tool fires inside subagent 'parentA'.
    const spawn = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_nested',
      agent_id: 'parentA',
      agent_type: 'general-purpose',
      tool_input: { description: 'nested child', subagent_type: 'general-purpose' },
      tool_response: { status: 'async_launched', agentId: 'childB', description: 'nested child' },
    });
    assertAllValid(spawn);
    expect(find(spawn, 'agent_created')).toMatchObject({
      agentId: 'childB',
      payload: { parentAgentId: 'parentA' },
    });

    const start = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'SubagentStart',
      agent_id: 'childB',
      agent_type: 'general-purpose',
    });
    assertAllValid(start);
    // Defensive creation carries no parent guess and no spawn edge.
    const created = find(start, 'agent_created');
    expect(created).toBeDefined();
    expect((created?.payload as { parentAgentId?: string }).parentAgentId).toBeUndefined();
    expect(find(start, 'dependency_created')).toBeUndefined();

    const state = reduceEvents([...spawn, ...start]);
    const session = state.sessions['s1'];
    expect(session?.agents['childB']?.parentAgentId).toBe('parentA');
    const spawnEdges = Object.values(session?.deps ?? {}).filter(
      (d) => d.kind === 'spawns' && d.toAgentId === 'childB',
    );
    expect(spawnEdges).toHaveLength(1);
    expect(spawnEdges[0]?.fromAgentId).toBe('parentA');
    expect(session?.agents['main']?.childIds ?? []).not.toContain('childB');
  });

  it('PermissionRequest then PostToolUse for the same tool_use_id -> approval_resolved clears awaiting_approval', () => {
    const requested = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_use_id: 'toolu_perm',
      message: 'Allow Bash?',
    });
    assertAllValid(requested);
    expect(find(requested, 'approval_requested')).toMatchObject({
      agentId: 'main',
      payload: { requestId: 'toolu_perm', kind: 'permission' },
    });

    // Agent stuck awaiting approval until the tool proceeds.
    const midState = reduceEvents(requested);
    expect(midState.sessions['s1']?.agents['main']?.lifecycle).toBe('awaiting_approval');

    const completed = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_perm',
      tool_input: { command: 'echo ok' },
      tool_response: { stdout: 'ok', stderr: '', interrupted: false },
      duration_ms: 10,
    });
    assertAllValid(completed);
    expect(find(completed, 'approval_resolved')).toMatchObject({
      agentId: 'main',
      payload: { requestId: 'toolu_perm', resolution: 'answered' },
    });

    const state = reduceEvents([...requested, ...completed]);
    const session = state.sessions['s1'];
    expect(session?.agents['main']?.lifecycle).not.toBe('awaiting_approval');
    const approval = session?.attention.find((a) => a.requestId === 'toolu_perm');
    expect(approval?.resolved).toBe(true);
  });

  it('PostToolUseFailure also resolves a pending PermissionRequest for its tool_use_id', () => {
    const events = mapHookPayload({
      session_id: 's1',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'toolu_permfail',
      error: 'command failed',
    });
    assertAllValid(events);
    expect(find(events, 'approval_resolved')).toMatchObject({
      payload: { requestId: 'toolu_permfail', resolution: 'answered' },
    });
    expect(find(events, 'agent_tool_completed')).toMatchObject({ payload: { ok: false } });
  });

  it('malformed input (missing session_id/hook_event_name, non-object) -> no events, never throws', () => {
    expect(mapHookPayload({})).toEqual([]);
    expect(mapHookPayload({ session_id: 's1' })).toEqual([]);
    expect(mapHookPayload({ hook_event_name: 'Stop' })).toEqual([]);
    expect(mapHookPayload(null)).toEqual([]);
    expect(mapHookPayload('not an object')).toEqual([]);
    expect(mapHookPayload([1, 2, 3])).toEqual([]);
  });
});
