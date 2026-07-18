import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyEvent } from '@visual-workflows/protocol';
import { Recorder } from '../src/recorder.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-rec-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function event(sessionId: string, seq: number, overrides: Partial<AnyEvent> = {}): AnyEvent {
  return {
    v: 1,
    id: `evt-${sessionId}-${seq}`,
    seq,
    ts: new Date().toISOString(),
    source: 'demo',
    sessionId,
    type: 'agent_output',
    agentId: 'main',
    payload: { stream: 'message', chunk: `chunk ${seq}` },
    ...overrides,
  } as AnyEvent;
}

function recordingFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(dir, 'recordings'))
    .filter((n) => n.endsWith('.jsonl'))
    .sort();
}

describe('Recorder', () => {
  it('writes a header line then one event per line', () => {
    const recorder = new Recorder({ dataDir: tmp, examplesDir: path.join(tmp, 'no-examples') });
    recorder.handleEvent(
      event('s1', 1, {
        type: 'session_started',
        payload: { title: 'My run' },
      } as Partial<AnyEvent>),
    );
    recorder.handleEvent(event('s1', 2));
    recorder.handleEvent(event('s1', 3));

    const files = recordingFiles(tmp);
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(tmp, 'recordings', files[0] ?? ''), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(4);
    const header = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(header).toMatchObject({ kind: 'vw-recording', v: 1, sessionId: 's1', label: 'My run' });
    expect(typeof header.createdAt).toBe('string');
    const second = JSON.parse(lines[2] ?? '') as { seq: number };
    expect(second.seq).toBe(2);
  });

  it('enforces maxRecordings retention on ended sessions (oldest deleted)', () => {
    const recorder = new Recorder({
      dataDir: tmp,
      examplesDir: path.join(tmp, 'no-examples'),
      maxRecordings: 3,
    });
    for (let i = 1; i <= 5; i += 1) {
      recorder.handleEvent(event(`session-${i}`, 1));
      recorder.handleEvent(
        event(`session-${i}`, 2, {
          type: 'session_ended',
          payload: { reason: 'done' },
        } as Partial<AnyEvent>),
      );
    }
    const files = recordingFiles(tmp);
    expect(files).toHaveLength(3);
    // The two oldest (session-1, session-2) are gone.
    expect(files.join()).not.toContain('session-1');
    expect(files.join()).not.toContain('session-2');
    expect(files.join()).toContain('session-5');
  });

  it('retention never unlinks a still-open recording; its header survives', () => {
    const recorder = new Recorder({
      dataDir: tmp,
      examplesDir: path.join(tmp, 'no-examples'),
      maxRecordings: 1,
    });
    recorder.handleEvent(
      event('live', 1, {
        type: 'session_started',
        payload: { title: 'Still recording' },
      } as Partial<AnyEvent>),
    );
    // Churn short-lived sessions well past the cap while `live` records on.
    for (let i = 1; i <= 3; i += 1) {
      recorder.handleEvent(event(`done-${i}`, 1));
      recorder.handleEvent(
        event(`done-${i}`, 2, {
          type: 'session_ended',
          payload: { reason: 'done' },
        } as Partial<AnyEvent>),
      );
    }
    recorder.handleEvent(event('live', 2));

    const liveFile = recordingFiles(tmp).find((n) => n.endsWith('-live.jsonl'));
    expect(liveFile).toBeDefined(); // survived every retention pass
    const raw = fs.readFileSync(path.join(tmp, 'recordings', liveFile ?? ''), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3); // header + both events, no headerless recreate
    const header = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(header).toMatchObject({ kind: 'vw-recording', sessionId: 'live' });
    expect((JSON.parse(lines[2] ?? '') as { seq: number }).seq).toBe(2);
  });

  it('list() summarizes recordings and merges bundled examples', async () => {
    const examplesDir = path.join(tmp, 'examples');
    fs.mkdirSync(examplesDir, { recursive: true });
    const exampleEvents = [event('demo-x', 1), event('demo-x', 2)];
    fs.writeFileSync(
      path.join(examplesDir, 'sample.jsonl'),
      [
        JSON.stringify({
          kind: 'vw-recording',
          v: 1,
          sessionId: 'demo-x',
          label: 'Sample',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        ...exampleEvents.map((e) => JSON.stringify(e)),
        '',
      ].join('\n'),
    );
    const recorder = new Recorder({ dataDir: tmp, examplesDir });
    recorder.handleEvent(event('s1', 1));

    const list = await recorder.list();
    expect(list).toHaveLength(2);
    const example = list.find((r) => r.id === 'ex-sample');
    expect(example).toMatchObject({ label: 'Sample', sessionId: 'demo-x', eventCount: 2 });
    const user = list.find((r) => r.id !== 'ex-sample');
    expect(user?.sessionId).toBe('s1');
    expect(user?.eventCount).toBe(1);
  });

  it('tolerates a missing examples dir', async () => {
    const recorder = new Recorder({ dataDir: tmp, examplesDir: path.join(tmp, 'missing') });
    await expect(recorder.list()).resolves.toEqual([]);
  });

  it('read() parses tolerantly: header and garbage lines skipped', async () => {
    const recordingsDir = path.join(tmp, 'recordings');
    fs.mkdirSync(recordingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(recordingsDir, 'mixed.jsonl'),
      [
        JSON.stringify({ kind: 'wfx-recording', v: 1, sessionId: 's9', label: 'old header' }),
        JSON.stringify(event('s9', 1)),
        'not json at all {{{',
        JSON.stringify({ nearly: 'an event' }),
        JSON.stringify(event('s9', 2)),
        '',
      ].join('\n'),
    );
    const recorder = new Recorder({ dataDir: tmp, examplesDir: path.join(tmp, 'missing') });
    const rec = await recorder.read('mixed');
    expect(rec?.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(rec?.header?.label).toBe('old header');
  });

  it('read() refuses unsafe ids and unknown ids', async () => {
    const recorder = new Recorder({ dataDir: tmp, examplesDir: path.join(tmp, 'missing') });
    await expect(recorder.read('../etc/passwd')).resolves.toBeUndefined();
    await expect(recorder.read('nope')).resolves.toBeUndefined();
  });
});
