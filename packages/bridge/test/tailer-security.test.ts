/**
 * Transcript tailer security tests — hostile on-disk registry content must
 * never escape claudeDir, and observed file paths must be redacted before
 * they reach the bus.
 *
 * Layout per test: <tmpRoot>/claude is the claudeDir (copied from
 * test/fixtures/fake-claude/), and "evil" transcript files are planted at
 * the exact locations an unguarded join() would read. The planted files are
 * small (attach-from-start), so if the tailer ever consumed them their
 * marker text would surface as events — absence of the marker proves they
 * were never read.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranscriptAdapter } from '../src/adapters/transcript/index.js';
import type { Adapter, AdapterContext, EventInit } from '../src/adapters/types.js';

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'fake-claude');

const EVIL_MARKER = 'EVIL_MARKER_must_never_be_read';

/** A well-formed transcript line that would emit agent_output if tailed. */
function evilTranscriptLine(): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-17T12:00:00.000Z',
    message: {
      id: 'msg_evil',
      role: 'assistant',
      content: [{ type: 'text', text: EVIL_MARKER }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })}\n`;
}

let tmpRoot: string;
let claudeDir: string;
let adapter: Adapter | undefined;
let events: EventInit[];
let logs: Array<{ level: string; message: string }>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'vw-tailer-sec-'));
  claudeDir = join(tmpRoot, 'claude');
  cpSync(FIXTURE_ROOT, claudeDir, { recursive: true });
  events = [];
  logs = [];
});

afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
  rmSync(tmpRoot, { recursive: true, force: true });
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

describe('createTranscriptAdapter security', () => {
  it('rejects registry entries with path-traversing sessionIds and never reads outside claudeDir', async () => {
    // Hostile registry entries: sessionId is attacker-influenceable content.
    writeFileSync(
      join(claudeDir, 'sessions', '66601.json'),
      JSON.stringify({ sessionId: '../../evil', cwd: '/tmp/fakeproj', status: 'busy' }),
    );
    writeFileSync(
      join(claudeDir, 'sessions', '66602.json'),
      JSON.stringify({ sessionId: '../../../evil2', cwd: '/tmp/fakeproj', status: 'busy' }),
    );
    // Plant transcripts exactly where an unguarded
    // join(projectDir, `${sessionId}.jsonl`) would resolve:
    //   '../../evil'    -> <claudeDir>/evil.jsonl   (escapes projects/)
    //   '../../../evil2' -> <tmpRoot>/evil2.jsonl   (escapes claudeDir itself)
    writeFileSync(join(claudeDir, 'evil.jsonl'), evilTranscriptLine());
    writeFileSync(join(tmpRoot, 'evil2.jsonl'), evilTranscriptLine());

    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());

    // The legit fixture session still flows: the adapter is genuinely polling.
    await waitFor(() => ofType('agent_output').some((e) => e.agentId === 'abc123'));
    await new Promise((r) => setTimeout(r, 150));

    // No event belongs to a hostile session, and the planted content never
    // surfaced anywhere in the stream.
    for (const e of events) {
      expect(e.sessionId).toBe('sess-abc');
    }
    expect(JSON.stringify(events)).not.toContain(EVIL_MARKER);
  }, 10000);

  it('rejects registry entries whose cwd resolves outside <claudeDir>/projects', async () => {
    // Safe-looking sessionId, hostile cwd: flattenCwd('..') = '..' would
    // resolve the project dir to claudeDir itself.
    writeFileSync(
      join(claudeDir, 'sessions', '66603.json'),
      JSON.stringify({ sessionId: 'evilcwd', cwd: '..', status: 'busy' }),
    );
    // Where the unguarded join('projects', '..', 'evilcwd.jsonl') would land.
    writeFileSync(join(claudeDir, 'evilcwd.jsonl'), evilTranscriptLine());

    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());

    await waitFor(() => ofType('agent_output').some((e) => e.agentId === 'abc123'));
    await new Promise((r) => setTimeout(r, 150));

    expect(events.some((e) => e.sessionId === 'evilcwd')).toBe(false);
    expect(JSON.stringify(events)).not.toContain(EVIL_MARKER);
  }, 10000);

  it('redacts file paths in agent_file_read / agent_file_modified (all three emit sites)', async () => {
    const secretPath = '/tmp/w/PASSWORD=supersecretvalue123/notes.txt';
    const lines = [
      // Site 1: Read tool_use in the transcript.
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-17T12:00:05.000Z',
        sessionId: 'sess-abc',
        uuid: 'sec1',
        parentUuid: 'u3',
        message: {
          id: 'msg_sec1',
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [
            { type: 'tool_use', id: 'toolu_SEC1', name: 'Read', input: { file_path: secretPath } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      // Site 2: toolUseResult Edit/Write shape -> agent_file_modified.
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-17T12:00:06.000Z',
        sessionId: 'sess-abc',
        uuid: 'sec2',
        parentUuid: 'sec1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_SEC2', content: 'ok' }],
        },
        toolUseResult: { filePath: secretPath, structuredPatch: [], originalFile: 'old' },
      }),
      // Site 3: toolUseResult Read shape -> agent_file_read.
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-17T12:00:07.000Z',
        sessionId: 'sess-abc',
        uuid: 'sec3',
        parentUuid: 'sec2',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_SEC3', content: 'ok' }],
        },
        toolUseResult: { file: { filePath: secretPath } },
      }),
    ];
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      join(claudeDir, 'projects', '-tmp-fakeproj', 'sess-abc.jsonl'),
      `${lines.join('\n')}\n`,
    );

    adapter = createTranscriptAdapter({ claudeDir, pollMs: 50 });
    adapter.start(ctx());

    await waitFor(
      () => ofType('agent_file_read').length >= 2 && ofType('agent_file_modified').length >= 1,
    );

    const paths = [...ofType('agent_file_read'), ...ofType('agent_file_modified')].map(
      (e) => (e.payload as { path: string }).path,
    );
    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const p of paths) {
      expect(p).not.toContain('supersecretvalue123');
      expect(p).toContain('REDACTED');
      expect(p.length).toBeLessThanOrEqual(1024);
    }
  }, 10000);
});
