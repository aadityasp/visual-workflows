/** Small shared React hooks. */
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { effectiveReducedMotion, useUi } from '../store/ui';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus trap: on mount, remembers the opener and moves focus inside the
 * container; Tab/Shift+Tab cycle within it (never escaping to the page behind);
 * Escape calls `onClose`; on unmount focus returns to the opener. This is what
 * makes ShortcutsOverlay/FocusView proper dialogs (WCAG 2.4.3 / 2.1.2).
 */
export function useFocusTrap<T extends HTMLElement>(onClose: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const container = ref.current;
    if (!container) return undefined;
    const opener = document.activeElement as HTMLElement | null;

    const items = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    (items()[0] ?? container).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = items();
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const idx = focusables.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      let next = e.shiftKey ? idx - 1 : idx + 1;
      if (idx === -1) next = 0;
      else if (next < 0) next = focusables.length - 1;
      else if (next >= focusables.length) next = 0;
      focusables[next]?.focus();
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  return ref;
}

/** Re-render on an interval while `active`, so ticking clocks stay live. */
export function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

export function useReducedMotion(): boolean {
  return useUi(effectiveReducedMotion);
}
