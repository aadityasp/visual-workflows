/**
 * Custom edge (docs/UI_SPEC.md): spawns solid, feeds an animated directional
 * dash *while the target is running* (and motion is allowed), blocks shows a
 * lock glyph, reviews is dotted with a magnifier at the midpoint.
 *
 * The edge subscribes to its target agent's lifecycle by id, so dash flow
 * starts/stops without rebuilding the whole edge set.
 */
import { EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { useWorkspace } from '../store/workspace';
import { useReducedMotion } from '../app/hooks';
import type { FlowEdgeData } from './graph';

export function FlowEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  target,
  data,
}: EdgeProps) {
  const { kind, sessionId } = (data ?? { kind: 'spawns', sessionId: '' }) as FlowEdgeData;
  const reduced = useReducedMotion();
  const targetLifecycle = useWorkspace(
    (s) => s.state.sessions[sessionId]?.agents[target]?.lifecycle,
  );

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const flowing = kind === 'feeds' && targetLifecycle === 'running' && !reduced;
  const glyph = kind === 'blocks' ? '⛔' : kind === 'reviews' ? '⌕' : null;

  return (
    <>
      <path
        d={path}
        className={`vw-edge-path vw-edge-${kind}${flowing ? ' is-flowing' : ''}`}
        fill="none"
      />
      {glyph ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: 'var(--vw-bg-elev)',
                border: '1px solid var(--vw-border)',
                fontSize: 12,
                color: kind === 'blocks' ? 'var(--vw-warn)' : 'var(--vw-thinking)',
              }}
            >
              {glyph}
            </span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
