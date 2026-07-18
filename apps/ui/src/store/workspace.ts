/**
 * The live workspace: WorkspaceState = reduce(events), plus connection
 * status and a rolling event rate. Incoming events are batched and applied
 * once per animation frame (one set() per frame) so a burst of activity is
 * a single React commit, not one per event. The reducer is immer-based, so
 * unchanged agents keep referential identity and per-panel selectors stay
 * cheap.
 */
import { create } from 'zustand';
import { createWorkspace, reduceAll } from '@visual-workflows/protocol';
import type { EventEnvelope, WorkspaceState } from '@visual-workflows/protocol';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface WorkspaceStore {
  state: WorkspaceState;
  connection: ConnectionState;
  eventRate: number;

  /** Live path: buffer an event; applied on the next frame. */
  enqueueEvent(event: EventEnvelope): void;
  /** Force any buffered events to apply now (also used by tests). */
  flush(): void;
  /** Replace state from a bridge snapshot frame. */
  applySnapshot(state: WorkspaceState): void;
  /** Replace state wholesale (client-side replay reduces off-thread of live). */
  setState(state: WorkspaceState): void;
  setConnection(connection: ConnectionState): void;
  /** Recompute the decaying event rate (called on a 1s tick). */
  tickRate(): void;
  reset(): void;
}

const raf: (cb: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => setTimeout(cb, 16);

const RATE_WINDOW_MS = 1000;

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  let buffer: EventEnvelope[] = [];
  let scheduled = false;
  const recent: number[] = [];

  function pruneRate(now: number): number {
    while (recent.length > 0 && now - (recent[0] ?? 0) > RATE_WINDOW_MS) recent.shift();
    return recent.length;
  }

  function flushInternal(): void {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const now = Date.now();
    for (let i = 0; i < batch.length; i += 1) recent.push(now);
    const rate = pruneRate(now);
    set((s) => ({ state: reduceAll(s.state, batch), eventRate: rate }));
  }

  return {
    state: createWorkspace(),
    connection: 'connecting',
    eventRate: 0,

    enqueueEvent: (event) => {
      buffer.push(event);
      if (scheduled) return;
      scheduled = true;
      raf(() => {
        scheduled = false;
        flushInternal();
      });
    },
    flush: () => flushInternal(),
    applySnapshot: (state) => set({ state }),
    setState: (state) => set({ state }),
    setConnection: (connection) => set({ connection }),
    tickRate: () => {
      const rate = pruneRate(Date.now());
      if (rate !== get().eventRate) set({ eventRate: rate });
    },
    reset: () => {
      buffer = [];
      recent.length = 0;
      set({ state: createWorkspace(), eventRate: 0 });
    },
  };
});
