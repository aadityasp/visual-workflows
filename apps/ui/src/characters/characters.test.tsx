// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentActivity, AgentLifecycle } from '@visual-workflows/protocol';
import {
  AgentCharacter,
  CHARACTER_STATES,
  CHARACTER_VARIANTS,
  stateFromAgent,
  variantForAgent,
} from './index';
import type { CharacterState } from './index';

afterEach(cleanup);

const ACTIVITIES: readonly AgentActivity[] = [
  'idle',
  'waiting',
  'thinking',
  'reading',
  'searching',
  'writing_code',
  'running_command',
  'testing',
  'reviewing',
];

/** Props that make stateFromAgent produce exactly `state`. */
function propsForState(state: CharacterState): {
  lifecycle: AgentLifecycle;
  activity: AgentActivity;
} {
  if ((ACTIVITIES as readonly string[]).includes(state)) {
    return { lifecycle: 'running', activity: state as AgentActivity };
  }
  return { lifecycle: state as AgentLifecycle, activity: 'idle' };
}

function renderCharacter(
  state: CharacterState,
  variant: (typeof CHARACTER_VARIANTS)[number] = 'scout',
  accent?: string,
) {
  const { lifecycle, activity } = propsForState(state);
  const utils = render(
    <AgentCharacter lifecycle={lifecycle} activity={activity} variant={variant} accent={accent} />,
  );
  const root = utils.container.querySelector('.vw-char');
  return { ...utils, root };
}

describe('contract shape', () => {
  it('exposes exactly the 14 states', () => {
    expect(CHARACTER_STATES).toHaveLength(14);
    expect([...CHARACTER_STATES].sort()).toEqual(
      [
        'idle',
        'waiting',
        'thinking',
        'reading',
        'searching',
        'writing_code',
        'running_command',
        'testing',
        'reviewing',
        'blocked',
        'awaiting_approval',
        'failed',
        'completed',
        'cancelled',
      ].sort(),
    );
  });

  it('exposes the four Crew variants', () => {
    expect([...CHARACTER_VARIANTS].sort()).toEqual(['beaker', 'lens', 'scout', 'wrench']);
  });
});

describe('every variant renders every state', () => {
  for (const variant of CHARACTER_VARIANTS) {
    for (const state of CHARACTER_STATES) {
      it(`${variant} × ${state}`, () => {
        const { root, unmount } = renderCharacter(state, variant);
        expect(root).not.toBeNull();
        expect(root?.getAttribute('data-state')).toBe(state);
        expect(root?.getAttribute('data-variant')).toBe(variant);
        expect(root?.getAttribute('aria-hidden')).toBe('true');
        expect(root?.querySelector('svg')).not.toBeNull();
        unmount();
      });
    }
  }
});

describe('stateFromAgent', () => {
  it('passes activity through while running', () => {
    for (const activity of ACTIVITIES) {
      expect(stateFromAgent('running', activity)).toBe(activity);
    }
  });

  it('idles before the agent starts', () => {
    expect(stateFromAgent('created', 'writing_code')).toBe('idle');
    expect(stateFromAgent('created', 'idle')).toBe('idle');
  });

  it('lifecycle overrides activity', () => {
    expect(stateFromAgent('blocked', 'testing')).toBe('blocked');
    expect(stateFromAgent('failed', 'reviewing')).toBe('failed');
    expect(stateFromAgent('completed', 'running_command')).toBe('completed');
    expect(stateFromAgent('cancelled', 'thinking')).toBe('cancelled');
  });

  it('both awaiting lifecycles use the raised-hand pose', () => {
    expect(stateFromAgent('awaiting_approval', 'idle')).toBe('awaiting_approval');
    expect(stateFromAgent('awaiting_input', 'reading')).toBe('awaiting_approval');
  });
});

describe('variantForAgent', () => {
  it('maps role keywords to variants', () => {
    expect(variantForAgent('gsd-planner')).toBe('scout');
    expect(variantForAgent(undefined, 'researcher')).toBe('scout');
    expect(variantForAgent('unit-tester')).toBe('beaker');
    expect(variantForAgent('qa-bot')).toBe('beaker');
    expect(variantForAgent('code-reviewer')).toBe('lens');
    expect(variantForAgent(undefined, 'auditor')).toBe('lens');
  });

  it('defaults to wrench', () => {
    expect(variantForAgent()).toBe('wrench');
    expect(variantForAgent('main')).toBe('wrench');
    expect(variantForAgent('implementer', 'coder')).toBe('wrench');
  });
});

describe('one-shot states', () => {
  it('applies the one-shot class when entering completed', () => {
    const { root } = renderCharacter('completed');
    expect(root?.classList.contains('vw-char-once')).toBe(true);
  });

  it('applies the one-shot class when entering failed', () => {
    const { root } = renderCharacter('failed');
    expect(root?.classList.contains('vw-char-once')).toBe(true);
  });

  it('does not apply the one-shot class to ambient states', () => {
    for (const state of ['idle', 'thinking', 'blocked', 'cancelled'] as const) {
      const { root, unmount } = renderCharacter(state);
      expect(root?.classList.contains('vw-char-once')).toBe(false);
      unmount();
    }
  });

  it('removes the one-shot class after the confetti animation ends', () => {
    const { root } = renderCharacter('completed');
    expect(root?.classList.contains('vw-char-once')).toBe(true);

    const event = new Event('animationend', { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: 'vwc-once-confetti' });
    act(() => {
      root?.dispatchEvent(event);
    });
    expect(root?.classList.contains('vw-char-once')).toBe(false);
  });

  it('ignores animationend from ambient loops', () => {
    const { root } = renderCharacter('failed');

    const event = new Event('animationend', { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: 'vwc-blink' });
    act(() => {
      root?.dispatchEvent(event);
    });
    expect(root?.classList.contains('vw-char-once')).toBe(true);

    const done = new Event('animationend', { bubbles: true });
    Object.defineProperty(done, 'animationName', { value: 'vwc-once-smoke' });
    act(() => {
      root?.dispatchEvent(done);
    });
    expect(root?.classList.contains('vw-char-once')).toBe(false);
  });
});

describe('tint', () => {
  it('accent overrides the variant tint', () => {
    const { root } = renderCharacter('idle', 'scout', '#ff00aa');
    const style = root?.getAttribute('style') ?? '';
    expect(style).toContain('--vwc-tint');
    expect(style).toContain('#ff00aa');
  });
});
