/**
 * The catalog of things the user can watch: live sessions the bridge knows
 * about (from `hello` / `sessions` frames) and recordings available for
 * replay. Kept separate from the reduced workspace state so the session
 * picker can render without a subscription.
 */
import { create } from 'zustand';
import type { RecordingSummary, SessionSummary } from '@visual-workflows/protocol';

interface SessionsStore {
  serverVersion: string | null;
  protocolV: number | null;
  sessions: SessionSummary[];
  recordings: RecordingSummary[];

  setHello(hello: {
    serverVersion: string;
    protocolV: number;
    sessions: SessionSummary[];
    recordings: RecordingSummary[];
  }): void;
  setSessions(sessions: SessionSummary[]): void;
  /** Optimistically register a session we just started (e.g. the demo). */
  upsertSession(summary: SessionSummary): void;
}

export const useSessions = create<SessionsStore>((set, get) => ({
  serverVersion: null,
  protocolV: null,
  sessions: [],
  recordings: [],

  setHello: ({ serverVersion, protocolV, sessions, recordings }) =>
    set({ serverVersion, protocolV, sessions, recordings }),
  setSessions: (sessions) => set({ sessions }),
  upsertSession: (summary) => {
    const rest = get().sessions.filter((s) => s.sessionId !== summary.sessionId);
    set({ sessions: [summary, ...rest] });
  },
}));
