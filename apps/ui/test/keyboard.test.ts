import { describe, expect, it } from 'vitest';
import { resolveKey } from '../src/app/keyboard';
import type { KeyContext, KeyEventLike } from '../src/app/keyboard';

function key(k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods };
}

const idle: KeyContext = { typing: false, interactive: false, replayActive: false };
const replay: KeyContext = { typing: false, interactive: false, replayActive: true };

describe('resolveKey', () => {
  it('maps the core view actions', () => {
    expect(resolveKey(key('?'), idle)).toEqual({ type: 'toggle-shortcuts' });
    expect(resolveKey(key('o'), idle)).toEqual({ type: 'fit' });
    expect(resolveKey(key('f'), idle)).toEqual({ type: 'toggle-follow' });
    expect(resolveKey(key('F', { shiftKey: true }), idle)).toEqual({ type: 'fullscreen' });
    expect(resolveKey(key('Enter'), idle)).toEqual({ type: 'focus-selected' });
    expect(resolveKey(key('m'), idle)).toEqual({ type: 'toggle-minimap' });
    expect(resolveKey(key('t'), idle)).toEqual({ type: 'toggle-theme' });
    expect(resolveKey(key('Escape'), idle)).toEqual({ type: 'escape' });
  });

  it('cycles with Tab and arrows', () => {
    expect(resolveKey(key('Tab'), idle)).toEqual({ type: 'cycle', dir: 1 });
    expect(resolveKey(key('Tab', { shiftKey: true }), idle)).toEqual({ type: 'cycle', dir: -1 });
    expect(resolveKey(key('ArrowDown'), idle)).toEqual({ type: 'cycle', dir: 1 });
    expect(resolveKey(key('ArrowUp'), idle)).toEqual({ type: 'cycle', dir: -1 });
  });

  it('routes replay keys only when replay is active', () => {
    expect(resolveKey(key(' '), idle)).toBeNull();
    expect(resolveKey(key(' '), replay)).toEqual({ type: 'replay-toggle' });
    expect(resolveKey(key('ArrowRight'), replay)).toEqual({ type: 'replay-step', dir: 1 });
    expect(resolveKey(key('ArrowLeft'), replay)).toEqual({ type: 'replay-step', dir: -1 });
    // outside replay, arrows cycle instead
    expect(resolveKey(key('ArrowRight'), idle)).toEqual({ type: 'cycle', dir: 1 });
  });

  it('maps digits to attention jumps (0-indexed)', () => {
    expect(resolveKey(key('1'), idle)).toEqual({ type: 'attention', index: 0 });
    expect(resolveKey(key('3'), idle)).toEqual({ type: 'attention', index: 2 });
  });

  it('swallows keys while typing, except Escape', () => {
    const typing: KeyContext = { typing: true, interactive: false, replayActive: false };
    expect(resolveKey(key('o'), typing)).toBeNull();
    expect(resolveKey(key('Escape'), typing)).toEqual({ type: 'escape' });
  });

  it('does not hijack keys when a focusable control owns focus (no Tab trap)', () => {
    // A focused button / element in a dialog: only Escape is global.
    const onControl: KeyContext = { typing: false, interactive: true, replayActive: false };
    expect(resolveKey(key('Tab'), onControl)).toBeNull(); // focus can move
    expect(resolveKey(key('Enter'), onControl)).toBeNull(); // button activates
    expect(resolveKey(key(' '), { ...onControl, replayActive: true })).toBeNull(); // no steal
    expect(resolveKey(key('o'), onControl)).toBeNull();
    expect(resolveKey(key('Escape'), onControl)).toEqual({ type: 'escape' });
  });

  it('ignores modifier chords (reserved for the browser/OS)', () => {
    expect(resolveKey(key('t', { metaKey: true }), idle)).toBeNull();
    expect(resolveKey(key('o', { ctrlKey: true }), idle)).toBeNull();
  });
});
