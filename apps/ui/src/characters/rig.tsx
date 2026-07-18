/**
 * The shared "Crew" rig — one soft rounded-square body every variant shares.
 *
 * Five SVG layers (back to front): shadow · fx-back · puppet(body/face/arms)
 * · accessory · fx-front. All animation lives in characters.css, keyed off
 * `data-state` on the root span; this file is pure structure plus the
 * one-shot lifecycle hook (completed/failed play once, then rest).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnimationEvent as ReactAnimationEvent, CSSProperties, ReactNode } from 'react';
import { ONE_SHOT_FINAL_ANIMATION } from './states';
import type { CharacterState, CharacterVariant } from './states';

export interface CharacterRigProps {
  state: CharacterState;
  variant: CharacterVariant;
  size: number;
  tint: string;
  /** Accessory-layer SVG for the variant (antenna, visor, goggles, monocle…). */
  accessory?: ReactNode;
}

/**
 * One-shot handling: entering a one-shot state applies `vw-char-once`,
 * which enables the entry animation (hop+confetti, smoke puff). When the
 * final fx animation ends, the class is removed so the character rests.
 */
function useOneShot(state: CharacterState): {
  oneShot: boolean;
  onAnimationEnd: (event: ReactAnimationEvent<HTMLSpanElement>) => void;
} {
  const [done, setDone] = useState(false);
  const prevState = useRef(state);

  useEffect(() => {
    if (prevState.current !== state) {
      prevState.current = state;
      setDone(false);
    }
  }, [state]);

  const finalAnimation = ONE_SHOT_FINAL_ANIMATION[state];
  const oneShot = finalAnimation !== undefined && !done;

  const onAnimationEnd = useCallback(
    (event: ReactAnimationEvent<HTMLSpanElement>) => {
      if (finalAnimation !== undefined && event.animationName === finalAnimation) {
        setDone(true);
      }
    },
    [finalAnimation],
  );

  return { oneShot, onAnimationEnd };
}

const CONFETTI_COLORS = ['#5fd0a5', '#ffd166', '#7cb8ff', '#ff8fa3'] as const;

function confettiColor(index: number): string {
  return CONFETTI_COLORS[index % CONFETTI_COLORS.length] ?? '#ffd166';
}

export function CharacterRig({ state, variant, size, tint, accessory }: CharacterRigProps) {
  const { oneShot, onAnimationEnd } = useOneShot(state);

  const rootStyle = {
    '--vwc-tint': tint,
    width: size,
    height: size,
  } as CSSProperties;

  return (
    <span
      className={oneShot ? 'vw-char vw-char-once' : 'vw-char'}
      data-state={state}
      data-variant={variant}
      aria-hidden="true"
      style={rootStyle}
      onAnimationEnd={onAnimationEnd}
    >
      <svg viewBox="0 0 64 64" width={size} height={size} className="vwc-svg">
        {/* layer 1 — floating soft shadow */}
        <ellipse className="vwc-shadow" cx="32" cy="57" rx="13" ry="3" />

        {/* layer 2 — fx behind the body (rings, sweeps, beams) */}
        <g className="vwc-fx vwc-fx-back">
          <circle className="vwc-fx-ring" cx="32" cy="33" r="19" />
          <g className="vwc-fx-pulse">
            <circle className="vwc-pulse-1" cx="32" cy="34" r="17" />
            <circle className="vwc-pulse-2" cx="32" cy="34" r="17" />
          </g>
          <circle className="vwc-fx-arc" cx="32" cy="30" r="17" />
          <polygon className="vwc-fx-beam" points="42,31 60,22 60,32" />
        </g>

        {/* layer 3 — puppet: body + face + arms (poses via CSS transforms) */}
        <g className="vwc-puppet">
          <rect className="vwc-body" x="14" y="18" width="36" height="32" rx="11" />
          <rect className="vwc-sheen" x="19" y="21.5" width="26" height="7" rx="3.5" />

          <g className="vwc-face">
            <g className="vwc-eyes">
              <g className="vwc-eyes-round">
                <circle cx="25" cy="33" r="4" />
                <circle cx="39" cy="33" r="4" />
                <circle className="vwc-glint" cx="26.4" cy="31.6" r="1.2" />
                <circle className="vwc-glint" cx="40.4" cy="31.6" r="1.2" />
              </g>
              <rect
                className="vwc-lid vwc-lid-l"
                x="20.4"
                y="28.2"
                width="9.2"
                height="4.6"
                rx="2.3"
              />
              <rect
                className="vwc-lid vwc-lid-r"
                x="34.4"
                y="28.2"
                width="9.2"
                height="4.6"
                rx="2.3"
              />
              <g className="vwc-eyes-happy">
                <path d="M21.4 34.2 Q25 29.6 28.6 34.2" />
                <path d="M35.4 34.2 Q39 29.6 42.6 34.2" />
              </g>
              <g className="vwc-eyes-x">
                <path d="M22.6 30.6 l4.8 4.8 M27.4 30.6 l-4.8 4.8" />
                <path d="M36.6 30.6 l4.8 4.8 M41.4 30.6 l-4.8 4.8" />
              </g>
              <g className="vwc-eyes-closed">
                <path d="M21.4 33 h7.2" />
                <path d="M35.4 33 h7.2" />
              </g>
            </g>
            <path className="vwc-mouth vwc-mouth-smile" d="M28.8 40.2 Q32 43 35.2 40.2" />
            <path className="vwc-mouth vwc-mouth-frown" d="M28.8 42 Q32 39.4 35.2 42" />
            <path className="vwc-mouth vwc-mouth-flat" d="M29.4 41 h5.2" />
          </g>

          {/* layer 4 — variant accessory (silhouette differentiator) */}
          <g className="vwc-acc">{accessory}</g>

          <g className="vwc-arm vwc-arm-l">
            <rect x="8.5" y="31" width="6" height="11" rx="3" />
          </g>
          <g className="vwc-arm vwc-arm-r">
            <rect x="49.5" y="31" width="6" height="11" rx="3" />
          </g>
        </g>

        {/* layer 5 — fx in front (bubbles, glyph bursts, speech bubbles) */}
        <g className="vwc-fx vwc-fx-front">
          <g className="vwc-fx-orbit">
            <circle cx="32" cy="10.5" r="1.7" />
            <circle cx="43.8" cy="30.7" r="1.7" />
            <circle cx="20.2" cy="30.7" r="1.7" />
          </g>
          <g className="vwc-fx-read">
            <rect className="vwc-page" x="24.5" y="4.5" width="15" height="11.5" rx="1.8" />
            <path className="vwc-page-lines" d="M27 8 h10 M27 10.5 h10 M27 13 h7" />
            <rect className="vwc-scanline" x="25.5" y="6" width="13" height="1.8" rx="0.9" />
          </g>
          <g className="vwc-fx-code">
            <text className="vwc-tick vwc-tick-1" x="15" y="16">
              {'{'}
            </text>
            <text className="vwc-tick vwc-tick-2" x="29.5" y="11">
              ;
            </text>
            <text className="vwc-tick vwc-tick-3" x="43" y="16">
              {'}'}
            </text>
          </g>
          <g className="vwc-fx-bub">
            <circle className="vwc-bub-1" cx="54" cy="30" r="1.6" />
            <circle className="vwc-bub-2" cx="57" cy="31" r="1.2" />
            <circle className="vwc-bub-3" cx="52.5" cy="31.5" r="1" />
          </g>
          <g className="vwc-fx-z">
            <text className="vwc-z vwc-z-1" x="45" y="20">
              z
            </text>
            <text className="vwc-z vwc-z-2" x="50" y="13">
              Z
            </text>
          </g>
          <g className="vwc-fx-alert">
            <rect className="vwc-alert-bubble" x="44" y="7" width="13" height="13" rx="3.5" />
            <path className="vwc-alert-tail" d="M47.5 19.5 L50 23.5 L52 19.5 Z" />
            <rect className="vwc-alert-mark" x="49.6" y="10" width="1.9" height="5.2" rx="0.95" />
            <circle className="vwc-alert-mark" cx="50.55" cy="17" r="1.05" />
          </g>
          <g className="vwc-fx-hand">
            <rect className="vwc-hand-bubble" x="42" y="5.5" width="15" height="13.5" rx="4" />
            <path className="vwc-hand-tail" d="M46 18.6 L48.5 22.5 L50.5 18.6 Z" />
            <g className="vwc-hand-glyph">
              <rect x="46.7" y="11.2" width="6" height="4.8" rx="2.2" />
              <rect x="46.9" y="8.2" width="1.4" height="4" rx="0.7" />
              <rect x="48.9" y="7.4" width="1.4" height="4.8" rx="0.7" />
              <rect x="50.9" y="8" width="1.4" height="4.2" rx="0.7" />
            </g>
          </g>
          <g className="vwc-fx-smoke">
            <circle cx="30.5" cy="12" r="2.6" />
            <circle cx="34" cy="13.5" r="1.9" />
          </g>
          <g className="vwc-fx-confetti">
            {Array.from({ length: 12 }, (_, i) => (
              <rect
                key={i}
                className={`vwc-cf vwc-cf-${i + 1}`}
                x="31"
                y="14"
                width="2.2"
                height="3.2"
                rx="0.6"
                fill={confettiColor(i)}
              />
            ))}
          </g>
        </g>
      </svg>
    </span>
  );
}
