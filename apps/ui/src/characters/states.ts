/**
 * Character state model — pure logic, no JSX.
 *
 * A CharacterState is what a character's pose/animation communicates.
 * It is derived from the protocol's (lifecycle, activity) pair via
 * stateFromAgent(); see docs/CHARACTER_SYSTEM.md for the state table.
 */
import type { AgentActivity, AgentLifecycle } from '@visual-workflows/protocol';

/** The 14-state contract every character pack must implement. */
export const CHARACTER_STATES = [
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
] as const;

export type CharacterState = (typeof CHARACTER_STATES)[number];

/** Variants bundled in the default "Crew" pack. */
export const CHARACTER_VARIANTS = ['scout', 'wrench', 'beaker', 'lens'] as const;

export type CharacterVariant = (typeof CHARACTER_VARIANTS)[number];

/** States that play a one-shot animation on entry (then rest). */
export const ONE_SHOT_STATES = ['completed', 'failed'] as const satisfies readonly CharacterState[];

/**
 * The CSS animation whose `animationend` marks a one-shot as finished.
 * The rig removes its one-shot class when this animation completes.
 */
export const ONE_SHOT_FINAL_ANIMATION: Partial<Record<CharacterState, string>> = {
  completed: 'vwc-once-confetti',
  failed: 'vwc-once-smoke',
};

/**
 * Map protocol (lifecycle, activity) to a character state.
 *
 * Terminal, blocked and awaiting lifecycles override activity;
 * `running` shows the live activity; `created` idles until started.
 * `awaiting_input` renders as the raised-hand awaiting pose too — both
 * mean "a human needs to respond before I can continue".
 */
export function stateFromAgent(lifecycle: AgentLifecycle, activity: AgentActivity): CharacterState {
  switch (lifecycle) {
    case 'failed':
      return 'failed';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    case 'awaiting_approval':
    case 'awaiting_input':
      return 'awaiting_approval';
    case 'created':
      return 'idle';
    case 'running':
      return activity;
  }
}
