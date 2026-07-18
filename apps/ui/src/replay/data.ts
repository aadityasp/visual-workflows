/**
 * Non-reactive holder for the events of the recording currently being
 * replayed, plus the seq↔time index the transport uses. Kept out of the
 * store because the event array is large and never needs to trigger renders;
 * the transport controls (seq, playing, speed) live in the ui store.
 */
import type { EventEnvelope } from '@visual-workflows/protocol';

export interface ReplayData {
  recordingId: string;
  sessionId: string;
  events: EventEnvelope[];
  /** seqs[i] / offsets[i] are parallel, sorted by seq; offset = ms since t0. */
  seqs: number[];
  offsets: number[];
  minSeq: number;
  maxSeq: number;
}

export interface ReplayMeta {
  sessionId: string;
  minSeq: number;
  maxSeq: number;
  density: number[];
}

const DENSITY_BUCKETS = 48;

let current: ReplayData | null = null;

export function prepareReplay(recordingId: string, raw: EventEnvelope[]): ReplayMeta {
  const events = [...raw].sort((a, b) => a.seq - b.seq);
  const sessionId = events[0]?.sessionId ?? recordingId;
  const t0 = events.length > 0 ? new Date(events[0]!.ts).getTime() : 0;
  const seqs: number[] = [];
  const offsets: number[] = [];
  for (const e of events) {
    seqs.push(e.seq);
    offsets.push(Math.max(0, new Date(e.ts).getTime() - t0));
  }
  const minSeq = seqs[0] ?? 0;
  const maxSeq = seqs[seqs.length - 1] ?? 0;

  const density = new Array<number>(DENSITY_BUCKETS).fill(0);
  const span = Math.max(1, maxSeq - minSeq);
  for (const s of seqs) {
    const idx = Math.min(DENSITY_BUCKETS - 1, Math.floor(((s - minSeq) / span) * DENSITY_BUCKETS));
    density[idx] = (density[idx] ?? 0) + 1;
  }

  current = { recordingId, sessionId, events, seqs, offsets, minSeq, maxSeq };
  return { sessionId, minSeq, maxSeq, density };
}

export function getReplayData(): ReplayData | null {
  return current;
}

export function clearReplayData(): void {
  current = null;
}

/** Largest index i in the ascending `arr` with arr[i] <= value, or -1. */
function largestIndexAtMost(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) <= value) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Offset (ms since t0) of the last event at or before `seq`. */
export function offsetForSeq(data: ReplayData, seq: number): number {
  const i = largestIndexAtMost(data.seqs, seq);
  return i >= 0 ? (data.offsets[i] ?? 0) : 0;
}

/** Seq of the last event whose offset is at or before `target` ms. */
export function seqForOffset(data: ReplayData, target: number): number {
  const i = largestIndexAtMost(data.offsets, target);
  return i >= 0 ? (data.seqs[i] ?? data.minSeq) : data.minSeq;
}

/** Events with seq in (fromExclusive, toInclusive], used for incremental replay. */
export function sliceEvents(
  data: ReplayData,
  fromExclusive: number,
  toInclusive: number,
): EventEnvelope[] {
  const lo = largestIndexAtMost(data.seqs, fromExclusive) + 1;
  const hi = largestIndexAtMost(data.seqs, toInclusive);
  return hi < lo ? [] : data.events.slice(lo, hi + 1);
}
