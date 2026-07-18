import { describe, expect, it } from 'vitest';
import type { OutputChunk } from '@visual-workflows/protocol';
import { stripControl, tailLines, terminalUpdate } from '../src/canvas/output';

function chunk(seq: number, text: string, stream: OutputChunk['stream'] = 'stdout'): OutputChunk {
  return { stream, text, ts: '2026-01-01T00:00:00.000Z', seq };
}

describe('output tail sanitization (DOM card)', () => {
  it('strips ANSI SGR colour codes and C0 control chars', () => {
    const ESC = String.fromCharCode(27);
    const lines = tailLines([chunk(1, `${ESC}[01;34mhello${ESC}[0m world\r`)], 6);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('hello world');
    expect(lines.some((l) => l.text.includes(ESC) || l.text.includes('\r'))).toBe(false);
  });

  it('expands tabs and drops backspaces', () => {
    expect(stripControl('a\tb\bc')).toBe('a  bc');
  });

  it('keeps stream tagging so stderr can tint', () => {
    const lines = tailLines([chunk(2, 'boom\n', 'stderr')], 6);
    expect(lines[0]?.stream).toBe('stderr');
  });
});

describe('terminalUpdate (focus terminal write plan)', () => {
  it('appends only newer chunks on forward progress', () => {
    const u1 = terminalUpdate(-1, [chunk(1, 'a'), chunk(2, 'b')]);
    expect(u1.clear).toBe(false);
    expect(u1.text).toBe('ab');
    expect(u1.writtenSeq).toBe(2);

    const u2 = terminalUpdate(2, [chunk(1, 'a'), chunk(2, 'b'), chunk(3, 'c')]);
    expect(u2.clear).toBe(false);
    expect(u2.text).toBe('c');
    expect(u2.writtenSeq).toBe(3);
  });

  it('clears and rewrites when the tail regresses (replay scrub-back)', () => {
    // Already showed up to seq 5; replay scrubbed back so newest tail seq is 2.
    const u = terminalUpdate(5, [chunk(1, 'a'), chunk(2, 'b')]);
    expect(u.clear).toBe(true);
    expect(u.text).toBe('ab');
    expect(u.writtenSeq).toBe(2);
  });
});
