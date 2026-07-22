/**
 * Auto-managed window behavior. When the forwarder opens the dashboard on the
 * first spawn of a session, it appends `#vw=auto` to the URL. In that mode we:
 *   - watch the followed session, and
 *   - when it ends, offer to close the window (with a countdown and a "Keep
 *     open" escape hatch, since you often want to stay and replay).
 *
 * Honest limitation: window.close() only closes windows the page is allowed to
 * close (an app window, or one opened by script). In an ordinary browser tab
 * the browser blocks it, so we fall back to a clear "safe to close" message.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionState } from '@visual-workflows/protocol';
import { MAIN_AGENT_ID } from '@visual-workflows/protocol';
import { useWorkspace } from '../store/workspace';
import { useUi } from '../store/ui';
import { activeSession } from '../store/selectors';
import { TERMINAL_LIFECYCLES } from '../canvas/status';
import { apiUrl, authHeaders } from './config';

const COUNTDOWN_START = 5;

/**
 * Where a session's *workflow* (its spawned subagents, ignoring the always-on
 * main agent) stands:
 *   'none'    — no subagents spawned (nothing to auto-close for)
 *   'running' — at least one subagent still working
 *   'done'    — subagents spawned and all of them are terminal
 * This is how we detect "the workflow finished" while the Claude session itself
 * stays open, which is the case the auto-managed window closes on.
 */
function workflowPhase(session: SessionState): 'none' | 'running' | 'done' {
  let subagents = 0;
  let running = 0;
  for (const id of session.agentOrder) {
    const a = session.agents[id];
    if (!a || a.kind === 'main' || id === MAIN_AGENT_ID) continue;
    subagents += 1;
    if (!TERMINAL_LIFECYCLES.has(a.lifecycle)) running += 1;
  }
  if (subagents === 0) return 'none';
  return running > 0 ? 'running' : 'done';
}

export function isAutoManaged(): boolean {
  try {
    const hash = window.location.hash || '';
    const search = window.location.search || '';
    return /(?:[#&?]|^#?)vw=auto\b/.test(hash) || /[?&]vw=auto\b/.test(search);
  } catch {
    return false;
  }
}

export function AutoManage() {
  // Lazy init: evaluated once, never a ref read during render.
  const [managed] = useState(isAutoManaged);
  const [phase, setPhase] = useState<'idle' | 'counting' | 'blocked'>('idle');
  const [secs, setSecs] = useState(COUNTDOWN_START);

  // Sticky opt-out latch: once the user clicks "Keep open" or "Dismiss" for a
  // given session end, we must NOT re-arm the countdown when more store
  // notifications arrive (the event-rate tick fires ~1/s, and the reducer
  // notifies on every batch). `dismissedRef` short-circuits `check` while set.
  const dismissedRef = useRef(false);
  // The sessionId we've already armed/dismissed for. A store notification about
  // the SAME ended session must not re-arm; only a genuinely new running->ended
  // transition (a different session, or this session going active then re-ending)
  // re-arms.
  const armedSessionRef = useRef<string | null>(null);

  // The user opted out of auto-closing for the current session end. Latch it so
  // subsequent store ticks leave the dialog dismissed.
  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    setPhase('idle');
  }, []);

  // Offer to close when the run this window opened for finishes — either its
  // workflow's subagents all completed (session may stay open) or the whole
  // session ended. Detected as transitions (not levels) via a store
  // subscription, so a batch landing on "done" arms exactly once.
  useEffect(() => {
    if (!managed) return;
    // Previous observations per session, to detect the running->done edge.
    const lastWf = new Map<string, 'none' | 'running' | 'done'>();
    const lastActive = new Map<string, boolean>();

    const check = () => {
      const sessionId = useUi.getState().activeSessionId;
      const session = activeSession(useWorkspace.getState().state, sessionId);
      if (!session || !sessionId) return;

      const wf = workflowPhase(session);
      const active = session.active;
      const prevWf = lastWf.get(sessionId);
      const prevActive = lastActive.get(sessionId);
      lastWf.set(sessionId, wf);
      lastActive.set(sessionId, active);

      // A different session than the one we latched on is a fresh slate.
      if (armedSessionRef.current !== null && armedSessionRef.current !== sessionId) {
        dismissedRef.current = false;
        armedSessionRef.current = null;
      }
      // New work started (a workflow (re)started): clear the opt-out and cancel
      // any in-progress countdown — the run is no longer "done".
      if (wf === 'running' && prevWf !== undefined && prevWf !== 'running') {
        dismissedRef.current = false;
        armedSessionRef.current = null;
        setPhase((p) => (p === 'counting' ? 'idle' : p));
      }

      // Two closeable edges: the workflow just finished, or the session just
      // ended. Edges (not levels) mean a window loaded already-done never arms.
      const workflowJustDone = wf === 'done' && prevWf === 'running';
      const sessionJustEnded = active === false && prevActive === true;
      if (!workflowJustDone && !sessionJustEnded) return;
      if (dismissedRef.current) return; // sticky opt-out for this completion
      if (armedSessionRef.current === sessionId) return; // already armed
      armedSessionRef.current = sessionId;
      setSecs(COUNTDOWN_START);
      setPhase('counting');
    };
    check();
    const unsubWorkspace = useWorkspace.subscribe(check);
    const unsubUi = useUi.subscribe(check);
    return () => {
      unsubWorkspace();
      unsubUi();
    };
  }, [managed]);

  // Countdown, then attempt to close. setState only ever runs in callbacks.
  useEffect(() => {
    if (phase !== 'counting') return;
    if (secs <= 0) {
      attemptClose(() => setPhase('blocked'));
      return;
    }
    const t = window.setTimeout(() => setSecs((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [phase, secs]);

  if (!managed || phase === 'idle') return null;

  return (
    <div className="vw-autoclose" role="dialog" aria-modal="false" aria-live="polite">
      <div className="vw-autoclose-card">
        {phase === 'counting' ? (
          <>
            <div className="vw-autoclose-title">Run complete</div>
            <div className="vw-autoclose-sub">
              Closing this window in <b>{secs}s</b>.
            </div>
            <div className="vw-autoclose-actions">
              <button className="ghost" onClick={dismiss}>
                Keep open
              </button>
              <button className="primary" onClick={() => attemptClose(() => setPhase('blocked'))}>
                Close now
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="vw-autoclose-title">Run complete</div>
            <div className="vw-autoclose-sub">
              You can close this tab. (Your browser blocks auto-close for tabs it did not open;
              connect with an app window for true auto-close.)
            </div>
            <div className="vw-autoclose-actions">
              <button className="ghost" onClick={dismiss}>
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Try to close the window; if the browser refuses, run onBlocked shortly after. */
function attemptClose(onBlocked: () => void): void {
  // Release this window's open-claim first so the NEXT workflow spawn re-opens a
  // fresh window (per-workflow open/close). Best-effort + keepalive so it lands
  // even as the window closes; if it fails, the worst case is no re-open.
  const sessionId = useUi.getState().activeSessionId;
  if (sessionId) {
    try {
      void fetch(apiUrl('/api/auto-open/release'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sessionId }),
        keepalive: true,
      });
    } catch {
      /* best-effort */
    }
  }
  try {
    window.close();
  } catch {
    /* fall through to blocked */
  }
  window.setTimeout(() => {
    if (!window.closed) onBlocked();
  }, 400);
}
