/**
 * The four "Crew" variants. Each is a silhouette accessory + default tint
 * layered onto the shared rig — roles must read even in grayscale, so every
 * accessory changes the outline (antenna, visor, goggles+flask, monocle).
 *
 * To add a variant: add its name to CHARACTER_VARIANTS in states.ts, then
 * register a VariantDefinition here. See README.md for the full checklist.
 */
import type { ReactElement } from 'react';
import type { CharacterVariant } from './states';

export interface VariantDefinition {
  /** Default body tint (any CSS color). Overridden by the `accent` prop. */
  tint: string;
  /** Accessory layer rendered inside the rig's `vwc-acc` group (SVG, 64×64 space). */
  Accessory: () => ReactElement;
}

/** Scout — planner/researcher. Antenna + tiny notepad. */
function ScoutAccessory() {
  return (
    <g>
      <path className="vwc-acc-line" d="M39 18 C40 14 41.5 11.5 44 9.5" />
      <circle className="vwc-acc-tip" cx="44.6" cy="9" r="2.4" />
      <rect className="vwc-notepad" x="5.5" y="35" width="9" height="11" rx="1.5" />
      <path className="vwc-notepad-lines" d="M7.5 38 h5 M7.5 40.5 h5 M7.5 43 h3.5" />
    </g>
  );
}

/** Wrench — coder/executor. Visor band + keyboard deck. */
function WrenchAccessory() {
  return (
    <g>
      <rect className="vwc-visor" x="16.5" y="21" width="31" height="6" rx="3" />
      <rect className="vwc-visor-sheen" x="18.5" y="22.2" width="12" height="1.6" rx="0.8" />
      <rect className="vwc-deck" x="23" y="46.5" width="18" height="5" rx="1.6" />
      <circle className="vwc-deck-key" cx="26.5" cy="49" r="0.9" />
      <circle className="vwc-deck-key" cx="30.2" cy="49" r="0.9" />
      <circle className="vwc-deck-key" cx="33.9" cy="49" r="0.9" />
      <circle className="vwc-deck-key" cx="37.6" cy="49" r="0.9" />
    </g>
  );
}

/** Beaker — tester. Goggle strap parked on the forehead + flask. */
function BeakerAccessory() {
  return (
    <g>
      <rect className="vwc-strap" x="15" y="20.5" width="34" height="3" rx="1.5" />
      <circle className="vwc-goggle" cx="25" cy="22" r="3.6" />
      <circle className="vwc-goggle" cx="39" cy="22" r="3.6" />
      <path
        className="vwc-flask"
        d="M53.5 33.5 v3.2 l3.4 6.4 q1 2 -1.3 2 h-6.2 q-2.3 0 -1.3 -2 l3.4 -6.4 v-3.2 z"
      />
      <path
        className="vwc-flask-liquid"
        d="M50.9 41.5 h6.2 l1 1.9 q0.7 1.4 -0.9 1.4 h-6.4 q-1.6 0 -0.9 -1.4 z"
      />
      <rect className="vwc-flask-lip" x="52.6" y="32.6" width="4.6" height="1.6" rx="0.8" />
    </g>
  );
}

/** Lens — reviewer. Monocle ring on the right eye + magnifier. */
function LensAccessory() {
  return (
    <g>
      <circle className="vwc-monocle" cx="39" cy="33" r="6" />
      <path className="vwc-monocle-chain" d="M44.6 36.5 q2.6 2.6 2.2 6" />
      <circle className="vwc-mag-glass" cx="9.5" cy="36" r="4.2" />
      <path className="vwc-mag-handle" d="M12.5 39.2 l3.4 3.6" />
    </g>
  );
}

export const VARIANTS: Record<CharacterVariant, VariantDefinition> = {
  scout: { tint: '#5ab889', Accessory: ScoutAccessory },
  wrench: { tint: '#5b8dd9', Accessory: WrenchAccessory },
  beaker: { tint: '#a082e0', Accessory: BeakerAccessory },
  lens: { tint: '#d9a05b', Accessory: LensAccessory },
};
