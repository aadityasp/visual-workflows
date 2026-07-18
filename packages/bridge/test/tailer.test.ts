/**
 * createTranscriptAdapter tests — a synthetic ~/.claude-shaped tree (copied
 * fresh per test from test/fixtures/fake-claude/) drives the real tailer.
 * Layout mirrors docs/discovery/transcripts.md: sessions/<pid>.json registry,
 * projects/<flat-cwd>/<sessionId>.jsonl main transcript, and
 * <sessionId>/subagents/agent-<id>.{meta.json,jsonl} for subagent detail.
 *
 * Fixture files are all written before the adapter first attaches (small,
 * well under the 1MB attach-from-EOF cutoff) so everything is visible from
 * the very first poll tick.
 */
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranscriptAdapter } from '../src/adapters/transcript/index.js';
import type { Adapter, AdapterContext, EventInit } from '../src/adapters/types.js';

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'fake-claude');

let claudeDir: string;
let adapter: Adapter | undefined;
let events: EventInit[];
let logs: Array<{ level: string; message: string }>;

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), 'vw-tailer-'));
  cpSync(FIXTURE_ROOT, claudeDir, { recursive: true });
  events = [];
  logs = [];
});

afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
  rmSync(claudeDir, { recursive: true, force: true });
});

function ctx(): AdapterContext {
  return {
    emit: (e) => events.push(e),
    log: (level, message) => logs.push({ level, message }),
    dataDir: claudeDir,
  };
}

function ofType(type: string): EventInit[] {
  return events.filter((e) => e.type === type);
}

/** Poll-wait: the tailer's own interval drives progress, this just waits for
 * enough ticks to have happened. Deadline 5s per the anti-stall test budget. */
async function waitFor(predicate: () => boolean, deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) {
      throw new Error(
        `timed out waiting for condition; saw ${events.length} events: ${events.map((e) => `${e.type}:${e.agentId ?? ''}`).join(', ')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('createTranscriptAdapter', () => {
  it('tails a registered session: main agent, tool call/result, subagent creation and output', async () => {
    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());

    await waitFor(() => ofType('agent_output').some((e) => e.agentId === 'abc123'));

    // Main agent materialized on first sight of the session.
    const mainCreated = ofType('agent_created').find((e) => e.agentId === 'main');
    expect(mainCreated).toMatchObject({
      sessionId: 'sess-abc',
      payload: { name: 'Claude', kind: 'main' },
    });

    // Bash tool_use in the main transcript, keyed by the toolu_ id.
    const toolCalled = ofType('agent_tool_called').find(
      (e) => (e.payload as { toolCallId?: string }).toolCallId === 'toolu_X',
    );
    expect(toolCalled).toMatchObject({ agentId: 'main', payload: { tool: 'Bash' } });

    const commandStarted = ofType('agent_command_started').find(
      (e) => (e.payload as { commandId?: string }).commandId === 'toolu_X',
    );
    expect(commandStarted).toMatchObject({ agentId: 'main', payload: { command: 'echo hi' } });

    // toolUseResult (Bash shape) -> stdout output + command completion, both
    // joined on the same toolu_ id.
    const stdout = ofType('agent_output').find(
      (e) => e.agentId === 'main' && (e.payload as { stream?: string }).stream === 'stdout',
    );
    expect(stdout).toMatchObject({ payload: { chunk: 'hi' } });

    const commandCompleted = ofType('agent_command_completed').find(
      (e) => (e.payload as { commandId?: string }).commandId === 'toolu_X',
    );
    expect(commandCompleted).toMatchObject({ payload: { ok: true } });

    // Final assistant text block -> message output + token_usage (deduped
    // by message.id, so at least the two distinct messages in the fixture).
    const message = ofType('agent_output').find(
      (e) => e.agentId === 'main' && (e.payload as { stream?: string }).stream === 'message',
    );
    expect(message).toMatchObject({ payload: { chunk: 'Done, output was hi.' } });
    expect(ofType('token_usage').length).toBeGreaterThanOrEqual(2);

    // Subagent discovered from subagents/agent-abc123.{meta.json,jsonl}.
    const subCreated = ofType('agent_created').find((e) => e.agentId === 'abc123');
    expect(subCreated).toMatchObject({
      payload: { name: 'helper', kind: 'subagent', agentType: 'general-purpose' },
    });

    const spawn = ofType('dependency_created').find(
      (e) => (e.payload as { toAgentId?: string }).toAgentId === 'abc123',
    );
    expect(spawn).toMatchObject({ payload: { fromAgentId: 'main', kind: 'spawns' } });

    expect(ofType('agent_started').some((e) => e.agentId === 'abc123')).toBe(true);

    const subOutput = ofType('agent_output').find((e) => e.agentId === 'abc123');
    expect(subOutput).toMatchObject({
      payload: { stream: 'message', chunk: 'Sub agent says hello.' },
    });
  }, 10000);

  it('stop() halts polling: no new events after stop even once the transcript grows', async () => {
    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());
    await waitFor(() => ofType('agent_created').some((e) => e.agentId === 'main'));

    await adapter.stop();
    const countAtStop = events.length;

    // Appending after stop must produce nothing further.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      join(claudeDir, 'projects', '-tmp-fakeproj', 'sess-abc.jsonl'),
      '{"type":"assistant","timestamp":"2026-07-17T12:00:04.000Z","sessionId":"sess-abc","uuid":"u4","parentUuid":"u3","message":{"id":"msg_3","role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"more"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}}\n',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(events.length).toBe(countAtStop);
    adapter = undefined; // already stopped; afterEach no-ops
  }, 10000);

  it('no session registry -> logs info, emits nothing, never throws', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'vw-tailer-empty-'));
    try {
      adapter = createTranscriptAdapter({ claudeDir: emptyDir, pollMs: 50 });
      adapter.start(ctx());
      await new Promise((r) => setTimeout(r, 150));
      expect(events).toEqual([]);
      expect(
        logs.some((l) => l.level === 'info' && l.message.includes('no session registry')),
      ).toBe(true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('caps workflow tracking at MAX_WORKFLOWS with a one-time cap notice', async () => {
    // 55 synthetic wf_* dirs, cap is 50 — announcing must stop at the cap.
    const { mkdirSync } = await import('node:fs');
    const wfRoot = join(
      claudeDir,
      'projects',
      '-tmp-fakeproj',
      'sess-abc',
      'subagents',
      'workflows',
    );
    for (let i = 0; i < 55; i += 1) {
      mkdirSync(join(wfRoot, `wf_${String(i).padStart(3, '0')}`), { recursive: true });
    }

    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());

    await waitFor(
      () =>
        ofType('workflow_started').length >= 50 &&
        logs.some((l) => l.level === 'warn' && l.message.includes('workflow cap reached')),
    );
    // Let a few more polls run: the count must not grow past the cap and the
    // notice must stay one-time.
    await new Promise((r) => setTimeout(r, 200));
    expect(ofType('workflow_started')).toHaveLength(50);
    expect(logs.filter((l) => l.message.includes('workflow cap reached'))).toHaveLength(1);
  }, 10000);

  it('session dropped from the registry stops emitting for it (session tail closed)', async () => {
    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());
    await waitFor(() => ofType('agent_output').some((e) => e.agentId === 'abc123'));

    const { rmSync: rm } = await import('node:fs');
    rm(join(claudeDir, 'sessions', '12345.json'), { force: true });
    await new Promise((r) => setTimeout(r, 150));
    const countAfterRemoval = events.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(events.length).toBe(countAfterRemoval); // no further activity once un-registered
  });

  // --- live incremental tail (readNewLines state machine) -----------------
  // The fixture is fully written before attach, so these exercise the parts
  // the pre-written fixtures never reach: bytes arriving AFTER attach, a line
  // split across poll ticks, and truncation mid-stream.
  const mainPath = (): string => join(claudeDir, 'projects', '-tmp-fakeproj', 'sess-abc.jsonl');

  const chunkOf = (e: EventInit): string | undefined => (e.payload as { chunk?: string }).chunk;

  function assistantLine(id: string, text: string): string {
    return JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-17T12:30:00.000Z',
      sessionId: 'sess-abc',
      uuid: id,
      parentUuid: 'u3',
      message: {
        id,
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  }

  it('tails lines appended AFTER the initial attach (live incremental tail)', async () => {
    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());
    // Initial catch-up of the pre-written fixture completes first.
    await waitFor(() => events.some((e) => chunkOf(e) === 'Done, output was hi.'));

    // Now append a brand-new message and assert it is picked up on a later tick.
    appendFileSync(mainPath(), `${assistantLine('appended-1', 'Appended after attach.')}\n`);
    await waitFor(() => events.some((e) => chunkOf(e) === 'Appended after attach.'));
  }, 10000);

  it('buffers a partial line split across poll ticks, then emits once completed', async () => {
    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());
    await waitFor(() => events.some((e) => chunkOf(e) === 'Done, output was hi.'));

    const line = assistantLine('split-1', 'Reassembled from two halves.');
    const cut = Math.floor(line.length / 2);
    // First half has no trailing newline -> the tailer must buffer it (as
    // bytes, in tail.rem) and emit nothing yet.
    appendFileSync(mainPath(), line.slice(0, cut));
    await new Promise((r) => setTimeout(r, 200)); // several poll ticks pass
    expect(events.some((e) => chunkOf(e) === 'Reassembled from two halves.')).toBe(false);

    // Second half + newline completes the buffered line on the next tick.
    appendFileSync(mainPath(), `${line.slice(cut)}\n`);
    await waitFor(() => events.some((e) => chunkOf(e) === 'Reassembled from two halves.'));
  }, 10000);

  it('resets cleanly when the transcript is truncated/rotated underneath it', async () => {
    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());
    await waitFor(() => events.some((e) => chunkOf(e) === 'Done, output was hi.'));

    // Replace the multi-line transcript with a single SHORTER line: the new
    // size is below the current read offset, so the tailer must reset offset
    // to 0 and re-read from the top rather than seek past EOF into garbage.
    writeFileSync(mainPath(), `${assistantLine('rotated-1', 'After rotation.')}\n`);
    await waitFor(() => events.some((e) => chunkOf(e) === 'After rotation.'));

    // The rotation itself must not surface as a parse error / format-drift notice.
    expect(logs.some((l) => l.message.includes('unparseable'))).toBe(false);
    expect(
      ofType('adapter_notice').some((e) =>
        (e.payload as { message?: string }).message?.includes('format may have changed'),
      ),
    ).toBe(false);
  }, 10000);
});

// Sanity: fixture events are well-formed EventInit shapes (agentId/sessionId
// set), even though full envelope validation belongs to hooks-mapping.test.ts
// and bus.test.ts — the tailer emits via ctx.emit(), never touches
// parseEventEnvelope itself.
describe('createTranscriptAdapter event shape', () => {
  it('every emitted event carries sessionId "sess-abc" and source "transcript"', async () => {
    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());
    await waitFor(() => ofType('agent_output').some((e) => e.agentId === 'abc123'));
    for (const e of events) {
      expect(e.sessionId).toBe('sess-abc');
      expect(e.source).toBe('transcript');
    }
  });
});
