/** Derive the last N display lines from an agent's output ring buffer. */
import type { OutputChunk } from '@visual-workflows/protocol';

export interface TailLine {
  text: string;
  stream: OutputChunk['stream'];
  key: string;
}

// ANSI CSI/SGR (colors, cursor moves) and OSC sequences, plus stray C0 control
// bytes. The DOM tail is plain text, so this residue would render literally
// ([0m, \r, \b …). The focus-view xterm keeps the raw bytes and renders colour.
// Control chars in these patterns are the whole point, hence the disables.
/* eslint-disable no-control-regex */
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const C0_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g; // keep \t and \n (handled separately)
/* eslint-enable no-control-regex */

/** Strip ANSI escapes and C0 control chars for the plain-DOM tail. */
export function stripControl(text: string): string {
  return text
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(/\t/g, '  ')
    .replace(C0_CONTROL, '');
}

/**
 * Flatten the tail of the chunk buffer into individual lines (a chunk can
 * carry several), keeping the stream so stderr can tint. Only the last few
 * chunks are examined — the card shows at most `max` lines. ANSI/control
 * residue is stripped so colored stdout stays readable.
 */
export function tailLines(chunks: OutputChunk[], max: number): TailLine[] {
  const lines: TailLine[] = [];
  const slice = chunks.slice(-Math.max(max + 4, 8));
  for (const c of slice) {
    const parts = stripControl(c.text).replace(/\n+$/, '').split('\n');
    parts.forEach((text, i) => {
      lines.push({ text, stream: c.stream, key: `${c.seq}:${i}` });
    });
  }
  return lines.slice(-max);
}

/** The full scrollback as text, for the focus-mode terminal (raw — xterm renders ANSI). */
export function fullOutputText(chunks: OutputChunk[]): string {
  return chunks.map((c) => c.text).join('');
}

export interface TerminalUpdate {
  /** Clear the terminal and rewrite from scratch (replay scrubbed backward). */
  clear: boolean;
  /** Text to write after any clear. */
  text: string;
  /** The new high-water seq to remember. */
  writtenSeq: number;
}

/**
 * Decide what the focus terminal should write given what it has already shown.
 * Normally it appends only chunks newer than `writtenSeq`. But replay does a
 * wholesale setState(replayToSeq(...)), so scrubbing backward shrinks the tail
 * below the high-water mark — detected here as a regression that forces a full
 * clear + rewrite, otherwise the terminal would go permanently stale.
 */
export function terminalUpdate(writtenSeq: number, tail: OutputChunk[]): TerminalUpdate {
  const newest = tail.at(-1)?.seq ?? -1;
  if (newest < writtenSeq) {
    return { clear: true, text: fullOutputText(tail), writtenSeq: newest };
  }
  let text = '';
  let seq = writtenSeq;
  for (const c of tail) {
    if (c.seq > writtenSeq) {
      text += c.text;
      seq = c.seq;
    }
  }
  return { clear: false, text, writtenSeq: seq };
}
