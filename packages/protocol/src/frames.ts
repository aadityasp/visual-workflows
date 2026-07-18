/**
 * WebSocket wire frames between bridge and UI. Observation-only by
 * construction: no frame type exists that executes or forwards anything.
 */
import type { EventEnvelope, EventSource } from './events.js';
import type { WorkspaceState } from './state.js';

export interface SessionSummary {
  sessionId: string;
  source: EventSource;
  title?: string;
  cwd?: string;
  active: boolean;
  agentCount: number;
  lastSeq: number;
  startedTs?: string;
}

export interface RecordingSummary {
  id: string;
  label: string;
  sessionId: string;
  createdAt: string;
  eventCount: number;
}

export type ServerFrame =
  | {
      kind: 'hello';
      protocolV: 1;
      serverVersion: string;
      sessions: SessionSummary[];
      recordings: RecordingSummary[];
    }
  | { kind: 'sessions'; sessions: SessionSummary[] }
  | { kind: 'snapshot'; sessionId: string; state: WorkspaceState; lastSeq: number }
  | { kind: 'event'; event: EventEnvelope }
  | { kind: 'error'; message: string }
  | { kind: 'pong' };

export type ClientFrame =
  | { kind: 'subscribe'; sessionId: string; fromSeq?: number }
  | { kind: 'unsubscribe'; sessionId: string }
  | { kind: 'ping' };
