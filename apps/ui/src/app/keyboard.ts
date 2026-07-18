/**
 * Keyboard map (docs/UI_SPEC.md "Keyboard") as a pure resolver so it can
 * be unit-tested without a DOM. The App shell owns dispatching actions.
 */

export type KeyAction =
  | { type: 'toggle-shortcuts' }
  | { type: 'escape' }
  | { type: 'fit' }
  | { type: 'toggle-follow' }
  | { type: 'fullscreen' }
  | { type: 'focus-selected' }
  | { type: 'cycle'; dir: 1 | -1 }
  | { type: 'toggle-minimap' }
  | { type: 'toggle-theme' }
  | { type: 'replay-toggle' }
  | { type: 'replay-step'; dir: 1 | -1 }
  | { type: 'attention'; index: number };

export interface KeyEventLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface KeyContext {
  /** True when focus is in an input/textarea/select/contentEditable. */
  typing: boolean;
  /**
   * True when focus is on a focusable control (button, link, [tabindex],
   * [role]) or inside a modal/overlay. Global shortcuts must NOT fire here or
   * they trap Tab/Enter/Space and steal the control's own keys (WCAG 2.1.2).
   */
  interactive: boolean;
  replayActive: boolean;
}

export function resolveKey(e: KeyEventLike, ctx: KeyContext): KeyAction | null {
  // While a control or modal owns focus, only Escape is global.
  if (ctx.typing || ctx.interactive) return e.key === 'Escape' ? { type: 'escape' } : null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;

  switch (e.key) {
    case 'Escape':
      return { type: 'escape' };
    case '?':
      return { type: 'toggle-shortcuts' };
    case 'o':
      return { type: 'fit' };
    case 'f':
      return { type: 'toggle-follow' };
    case 'F':
      return { type: 'fullscreen' };
    case 'Enter':
      return { type: 'focus-selected' };
    case 'Tab':
      return { type: 'cycle', dir: e.shiftKey ? -1 : 1 };
    case 'm':
      return { type: 'toggle-minimap' };
    case 't':
      return { type: 'toggle-theme' };
    case ' ':
      return ctx.replayActive ? { type: 'replay-toggle' } : null;
    case 'ArrowRight':
      return ctx.replayActive ? { type: 'replay-step', dir: 1 } : { type: 'cycle', dir: 1 };
    case 'ArrowLeft':
      return ctx.replayActive ? { type: 'replay-step', dir: -1 } : { type: 'cycle', dir: -1 };
    case 'ArrowDown':
      return { type: 'cycle', dir: 1 };
    case 'ArrowUp':
      return { type: 'cycle', dir: -1 };
    default: {
      if (/^[1-9]$/.test(e.key)) return { type: 'attention', index: Number(e.key) - 1 };
      return null;
    }
  }
}

export const SHORTCUT_ROWS: Array<{ keys: string; does: string }> = [
  { keys: '?', does: 'Toggle this overlay' },
  { keys: 'o', does: 'Fit the whole graph (overview)' },
  { keys: 'f', does: 'Follow mode — camera tracks the latest active agent' },
  { keys: 'Enter', does: 'Focus the selected agent (full terminal)' },
  { keys: 'Esc', does: 'Back — close overlay / exit focus / deselect' },
  { keys: 'Tab · arrows', does: 'Cycle agents' },
  { keys: '1–9', does: 'Jump to attention item' },
  { keys: 'm', does: 'Toggle minimap' },
  { keys: 't', does: 'Toggle theme' },
  { keys: 'Space', does: 'Play / pause (replay)' },
  { keys: '← →', does: 'Step one event (replay)' },
  { keys: 'Shift+F', does: 'Browser fullscreen' },
];
