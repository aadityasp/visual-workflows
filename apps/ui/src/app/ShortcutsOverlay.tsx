/**
 * Keyboard shortcuts overlay (the `?` surface). A real modal dialog: focus is
 * trapped inside, Tab cycles within it, Escape closes, and focus returns to
 * the opener on close. Rows come from keyboard.ts so the help and the resolver
 * never drift apart.
 */
import { SHORTCUT_ROWS } from './keyboard';
import { useFocusTrap } from './hooks';
import { useUi } from '../store/ui';

export function ShortcutsOverlay() {
  const close = useUi((s) => s.closeShortcuts);
  const cardRef = useFocusTrap<HTMLDivElement>(close);

  return (
    <div className="vw-overlay" onClick={close}>
      <div
        ref={cardRef}
        className="vw-overlay-card"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="vw-overlay-head">
          <h2>Keyboard shortcuts</h2>
          <button className="vw-icon-btn" aria-label="Close shortcuts" onClick={close}>
            ✕
          </button>
        </div>
        {SHORTCUT_ROWS.map((row) => (
          <div className="vw-shortcut-row" key={row.keys}>
            <kbd>{row.keys}</kbd>
            <span>{row.does}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
