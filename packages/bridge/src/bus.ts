/**
 * EventBus — the single in-process pipeline every event source feeds.
 *
 * Responsibilities (and nothing more):
 *  - validate every incoming EventInit at the boundary (parseEventEnvelope)
 *  - assign event identity: `id` (uuid, unless the adapter supplied one)
 *    and per-session monotonic `seq` (the reducer's only ordering authority)
 *  - keep a bounded per-session ring buffer of accepted events (resume/replay)
 *  - maintain a live WorkspaceState by running the pure protocol reducer
 *    incrementally on each accepted event
 *  - fan accepted events out to subscribers (ws layer, recorder)
 *
 * The bus never executes anything and never mutates state outside its own
 * fields — observation plane only (see docs/SECURITY_MODEL.md).
 */
import crypto from 'node:crypto';
import type { AnyEvent, SessionSummary, WorkspaceState } from '@visual-workflows/protocol';
import {
  PROTOCOL_VERSION,
  createWorkspace,
  parseEventEnvelope,
  reduce,
} from '@visual-workflows/protocol';
import type { EventInit } from './adapters/types.js';

/** Max events retained per session; oldest are dropped first. */
export const RING_CAP = 20000;

export type EmitResult = { ok: true; event: AnyEvent } | { ok: false; error: string };

export type BusListener = (event: AnyEvent) => void;

export class EventBus {
  private state: WorkspaceState = createWorkspace();
  private readonly rings = new Map<string, AnyEvent[]>();
  private readonly nextSeq = new Map<string, number>();
  private readonly listeners = new Set<BusListener>();

  /**
   * Validate, sequence, and publish one event. Invalid events are rejected
   * without consuming a sequence number.
   */
  emit(init: EventInit): EmitResult {
    const sessionId = (init as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, error: 'event missing sessionId' };
    }
    const seq = this.nextSeq.get(sessionId) ?? 1;
    const candidate = {
      ...init,
      v: PROTOCOL_VERSION,
      id: typeof init.id === 'string' && init.id.length > 0 ? init.id : crypto.randomUUID(),
      seq,
    };
    const parsed = parseEventEnvelope(candidate);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    this.nextSeq.set(sessionId, seq + 1);
    let ring = this.rings.get(sessionId);
    if (!ring) {
      ring = [];
      this.rings.set(sessionId, ring);
    }
    ring.push(parsed.event);
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);

    this.state = reduce(this.state, parsed.event);

    for (const listener of this.listeners) {
      try {
        listener(parsed.event);
      } catch {
        /* a broken subscriber must never break ingestion */
      }
    }
    return { ok: true, event: parsed.event };
  }

  /** Subscribe to every accepted event. Returns an unsubscribe function. */
  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current reducer output (frozen; treat as immutable). */
  getState(): WorkspaceState {
    return this.state;
  }

  /** Highest seq assigned for a session (0 if the session is unknown). */
  lastSeq(sessionId: string): number {
    return (this.nextSeq.get(sessionId) ?? 1) - 1;
  }

  /**
   * Buffered events for a session with `seq >= fromSeq` (inclusive resume).
   * Events older than the ring cap are gone; callers should fall back to the
   * snapshot when the requested range is no longer buffered.
   */
  getEventsFrom(sessionId: string, fromSeq: number): AnyEvent[] {
    const ring = this.rings.get(sessionId);
    if (!ring) return [];
    return ring.filter((e) => e.seq >= fromSeq);
  }

  /** One SessionSummary per known session, in first-seen order. */
  sessionSummaries(): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const id of this.state.sessionOrder) {
      const s = this.state.sessions[id];
      if (!s) continue;
      out.push({
        sessionId: s.id,
        source: s.source,
        title: s.title,
        cwd: s.cwd,
        active: s.active,
        agentCount: s.agentOrder.length,
        lastSeq: s.lastSeq,
        startedTs: s.startedTs,
      });
    }
    return out;
  }
}
