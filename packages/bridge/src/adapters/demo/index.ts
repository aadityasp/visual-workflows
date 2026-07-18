/**
 * Demo adapter — plays the scripted "Ship dark mode" timeline into the bus.
 *
 * The ONLY control surface in the bridge (POST /demo/start) lands here, and
 * it affects simulated data only: every emitted event is source:'demo' with
 * a session id of its own. Timers are plain setTimeout so stop() can cancel
 * a run cleanly mid-flight.
 */
import type { EventBus } from '../../bus.js';
import type { DemoStepCtx } from './timeline.js';
import { DEMO_TIMELINE, DEMO_TOTAL_MS } from './timeline.js';

export interface DemoAdapter {
  name: 'demo';
  /** Begin a fresh run (cancelling any active one). Returns its session id. */
  start(speed?: number): { sessionId: string };
  /** Cancel all pending timers for the active run. */
  stop(): void;
  readonly running: boolean;
}

const MIN_SPEED = 0.1;
const MAX_SPEED = 10_000;

export function createDemoAdapter(bus: EventBus): DemoAdapter {
  let timers: NodeJS.Timeout[] = [];
  let running = false;
  let runCount = 0;
  /** Session/workflow of the in-flight run, for closure on stop(). */
  let current: { sessionId: string; workflowId: string } | undefined;

  function stop(): void {
    for (const t of timers) clearTimeout(t);
    timers = [];
    // Stopping mid-run cleared the timers that would have completed the
    // session — without closure the reducer strands it active forever.
    // Emit the ending synchronously so the abandoned session reads as
    // cancelled, not stuck running. Skip sessions that never emitted (no
    // ghost sessions) or already ended (don't overwrite 'completed').
    if (running && current) {
      const { sessionId, workflowId } = current;
      if (bus.getState().sessions[sessionId]?.active === true) {
        const ts = new Date().toISOString();
        bus.emit({
          ts,
          source: 'demo',
          sessionId,
          workflowId,
          type: 'workflow_completed',
          payload: { status: 'cancelled', summary: 'Demo stopped before completion.' },
        });
        bus.emit({
          ts,
          source: 'demo',
          sessionId,
          workflowId,
          type: 'session_ended',
          payload: { reason: 'demo stopped' },
        });
      }
    }
    running = false;
    current = undefined;
  }

  function start(speed = 1): { sessionId: string } {
    stop(); // one demo run at a time
    const sp = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number.isFinite(speed) ? speed : 1));
    runCount += 1;
    const sessionId = `demo-${runCount}`;
    const ctx: DemoStepCtx = {
      sessionId,
      workflowId: 'wf-dark-mode',
      now: () => new Date().toISOString(),
    };
    current = { sessionId, workflowId: ctx.workflowId };
    for (const step of DEMO_TIMELINE) {
      const timer = setTimeout(
        () => {
          for (const init of step.make(ctx)) {
            const result = bus.emit(init);
            if (!result.ok) {
              // A rejected demo event is a bug in the timeline, not the user's
              // data — log loudly but keep playing.
              console.error(`[demo] event rejected: ${result.error}`);
            }
          }
        },
        Math.round(step.atMs / sp),
      );
      timers.push(timer);
    }
    timers.push(
      setTimeout(
        () => {
          running = false;
        },
        Math.round(DEMO_TOTAL_MS / sp) + 25,
      ),
    );
    running = true;
    return { sessionId };
  }

  return {
    name: 'demo',
    start,
    stop,
    get running() {
      return running;
    },
  };
}
