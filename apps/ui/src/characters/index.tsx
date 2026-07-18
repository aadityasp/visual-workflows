/**
 * Character pack entry — the "Crew" pack. Public API used by the UI:
 *
 *   <AgentCharacter lifecycle activity variant? size? accent? />
 *   variantForAgent(name?, agentType?)  → CharacterVariant
 *   stateFromAgent(lifecycle, activity) → CharacterState
 *   CHARACTER_STATES / CHARACTER_VARIANTS
 *
 * Characters are decorative (aria-hidden); the status chip carries the
 * accessible name. See README.md for the pack/variant contributor contract.
 */
import './characters.css';
import type { AgentActivity, AgentLifecycle } from '@visual-workflows/protocol';
import { CharacterRig } from './rig';
import { stateFromAgent } from './states';
import type { CharacterVariant } from './states';
import { VARIANTS } from './variants';

export { CHARACTER_STATES, CHARACTER_VARIANTS, ONE_SHOT_STATES, stateFromAgent } from './states';
export type { CharacterState, CharacterVariant } from './states';
export { VARIANTS } from './variants';
export type { VariantDefinition } from './variants';

export interface AgentCharacterProps {
  lifecycle: AgentLifecycle;
  activity: AgentActivity;
  variant?: CharacterVariant;
  size?: number;
  /** Overrides the variant's default body tint (any CSS color). */
  accent?: string;
}

/** Pick a Crew variant from an agent's name/agentType (role keywords). */
export function variantForAgent(name?: string, agentType?: string): CharacterVariant {
  const s = `${name ?? ''} ${agentType ?? ''}`.toLowerCase();
  if (/plan|research|scout|map|explore/.test(s)) return 'scout';
  if (/test|qa|verif|beaker/.test(s)) return 'beaker';
  if (/review|check|audit|critic|judge|lens/.test(s)) return 'lens';
  return 'wrench';
}

export function AgentCharacter({
  lifecycle,
  activity,
  variant = 'wrench',
  size = 44,
  accent,
}: AgentCharacterProps) {
  const state = stateFromAgent(lifecycle, activity);
  const def = VARIANTS[variant];
  return (
    <CharacterRig
      state={state}
      variant={variant}
      size={size}
      tint={accent ?? def.tint}
      accessory={<def.Accessory />}
    />
  );
}
