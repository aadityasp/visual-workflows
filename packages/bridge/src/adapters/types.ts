/**
 * Adapter contract — every source of events (demo, hooks, transcript, and
 * future OTEL/Codex adapters) implements this. Deleting an adapter must
 * break nothing else.
 */
import type { EventEnvelope, EventType, EventPayloadMap } from '@visual-workflows/protocol';

/** What adapters hand the bus: the bus assigns `v`, `seq`, and `id`. */
export type EventInit<T extends EventType = EventType> = Omit<
  EventEnvelope<T>,
  'v' | 'seq' | 'id'
> & { id?: string };

/** Convenience constructor preserving payload/type pairing. */
export function makeEvent<T extends EventType>(
  type: T,
  base: Omit<EventInit<T>, 'type' | 'payload'>,
  payload: EventPayloadMap[T],
): EventInit<T> {
  return { ...base, type, payload };
}

export interface AdapterContext {
  /** Push one event into the bus (validated, sequenced, fanned out). */
  emit(event: EventInit): void;
  /** Adapter diagnostics — also mirrored as adapter_notice events when warn/error. */
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Bridge data directory (token, recordings) — already created. */
  dataDir: string;
}

export interface Adapter {
  name: string;
  start(ctx: AdapterContext): void | Promise<void>;
  stop(): void | Promise<void>;
}
