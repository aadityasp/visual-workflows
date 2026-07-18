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
import { useWorkspace } from '../store/workspace';
import { useUi } from '../store/ui';
import { activeSession } from '../store/selectors';

const COUNTDOWN_START = 5;

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

  // Detect the followed session's running -> ended transition via a store
  // subscription (setState happens in the callback, not the effect body).
  useEffect(() => {
    if (!managed) return;
    // Sessions we have actually witnessed running. We only offer to auto-close a
    // session whose live end we saw (not one loaded already-ended for review).
    const seenActive = new Set<string>();
    const check = () => {
      const sessionId = useUi.getState().activeSessionId;
      const session = activeSession(useWorkspace.getState().state, sessionId);
      if (!session || !sessionId) return;

      // A different session than the one we latched on is a fresh slate: clear
      // the opt-out so its own end can arm.
      if (armedSessionRef.current !== null && armedSessionRef.current !== sessionId) {
        dismissedRef.current = false;
        armedSessionRef.current = null;
      }

      if (session.active) {
        seenActive.add(sessionId);
        // The session we armed is running again: a later end is a genuinely new
        // transition, so drop the latch and allow re-arming.
        if (armedSessionRef.current === sessionId) {
          dismissedRef.current = false;
          armedSessionRef.current = null;
        }
        return;
      }

      const ended = Object.keys(session.agents).length > 0;
      if (!ended || !seenActive.has(sessionId)) return;
      if (dismissedRef.current) return; // sticky opt-out for this end
      if (armedSessionRef.current === sessionId) return; // already armed, don't re-arm
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
            <div className="vw-autoclose-title">Session complete</div>
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
            <div className="vw-autoclose-title">Session complete</div>
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
  try {
    window.close();
  } catch {
    /* fall through to blocked */
  }
  window.setTimeout(() => {
    if (!window.closed) onBlocked();
  }, 400);
}
