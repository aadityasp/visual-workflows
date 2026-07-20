/**
 * Turns a reduced SessionState into React Flow nodes and edges. Positions
 * come from the dagre LR layout (layout.ts); user-pinned nodes override.
 * Nodes carry only ids — each AgentPanelNode subscribes to its own agent by
 * id, so one agent's churn never re-renders its neighbours.
 */
import type { Edge, Node } from '@xyflow/react';
import type { DependencyState, SessionState } from '@visual-workflows/protocol';
import { computeLayout, PANEL_W, PANEL_H } from './layout';
import type { XY } from './layout';
import { agentCollapsed } from '../store/ui';

export const CHIP_H = 56;
/** A collapsed (completed/minimized) agent is narrow as well as short, so many
 * pack densely while running agents keep full-size prominence. */
export const CHIP_W = 240;
const BAND_PAD = 44;

export interface AgentNodeData extends Record<string, unknown> {
  agentId: string;
  sessionId: string;
  pinned: boolean;
}

export interface FlowEdgeData extends Record<string, unknown> {
  kind: DependencyState['kind'];
  sessionId: string;
}

export interface PhaseBandData extends Record<string, unknown> {
  title: string;
}

export type AgentNode = Node<AgentNodeData, 'agentPanel'>;
export type PhaseBandNode = Node<PhaseBandData, 'phaseBand'>;

/** A collapsed (minimized or completed) agent is a compact chip; others keep height. */
export function nodeHeight(collapsed: boolean): number {
  return collapsed ? CHIP_H : PANEL_H;
}

/** A collapsed agent is also narrow, so crowded ranks of done chips pack tight. */
export function nodeWidth(collapsed: boolean): number {
  return collapsed ? CHIP_W : PANEL_W;
}

/** A stable string that changes only when the graph's shape or sizing does. */
export function topologySignature(session: SessionState | undefined): string {
  if (!session) return '';
  const agents = session.agentOrder
    .map((id) => {
      const a = session.agents[id];
      return a
        ? `${id}:${a.lifecycle === 'completed' || a.lifecycle === 'cancelled' ? 'c' : 'f'}:${a.phase ?? ''}`
        : id;
    })
    .join('|');
  const deps = Object.keys(session.deps).sort().join('|');
  return `${agents}#${deps}`;
}

export function buildGraph(
  session: SessionState,
  sessionId: string,
  pinned: Map<string, XY>,
  collapsed: Record<string, boolean>,
): { nodes: Node[]; edges: Edge[] } {
  const items = session.agentOrder
    .map((id) => session.agents[id])
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .map((a) => {
      const isCollapsed = agentCollapsed(collapsed, a.id, a.lifecycle);
      return { id: a.id, width: nodeWidth(isCollapsed), height: nodeHeight(isCollapsed) };
    });

  const links = Object.values(session.deps).map((d) => ({ from: d.fromAgentId, to: d.toAgentId }));
  const laid = computeLayout(items, links);
  const posOf = (id: string): XY => pinned.get(id) ?? laid[id] ?? { x: 0, y: 0 };

  const agentNodes: AgentNode[] = items.map((it) => ({
    id: it.id,
    type: 'agentPanel',
    position: posOf(it.id),
    data: { agentId: it.id, sessionId, pinned: pinned.has(it.id) },
    draggable: true,
    zIndex: 1,
  }));

  const bandNodes = buildPhaseBands(session, posOf, collapsed);

  const edges: Edge[] = Object.values(session.deps)
    .filter((d) => session.agents[d.fromAgentId] && session.agents[d.toAgentId])
    .map((d) => ({
      id: d.id,
      source: d.fromAgentId,
      target: d.toAgentId,
      type: 'flowEdge',
      data: { kind: d.kind, sessionId } satisfies FlowEdgeData,
      zIndex: 0,
    }));

  return { nodes: [...bandNodes, ...agentNodes], edges };
}

/** One subtle labeled band per workflow phase, sized to its agents' bbox. */
function buildPhaseBands(
  session: SessionState,
  posOf: (id: string) => XY,
  collapsed: Record<string, boolean>,
): PhaseBandNode[] {
  const wf = Object.values(session.workflows)[0];
  if (!wf || wf.phases.length < 2) return [];

  const byPhase = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (const id of session.agentOrder) {
    const a = session.agents[id];
    if (!a?.phase) continue;
    const p = posOf(id);
    const isCollapsed = agentCollapsed(collapsed, a.id, a.lifecycle);
    const h = nodeHeight(isCollapsed);
    const w = nodeWidth(isCollapsed);
    const box = byPhase.get(a.phase);
    if (!box) {
      byPhase.set(a.phase, { minX: p.x, minY: p.y, maxX: p.x + w, maxY: p.y + h });
    } else {
      box.minX = Math.min(box.minX, p.x);
      box.minY = Math.min(box.minY, p.y);
      box.maxX = Math.max(box.maxX, p.x + w);
      box.maxY = Math.max(box.maxY, p.y + h);
    }
  }

  const bands: PhaseBandNode[] = [];
  for (const phase of wf.phases) {
    const box = byPhase.get(phase.title);
    if (!box) continue;
    bands.push({
      id: `phase:${phase.title}`,
      type: 'phaseBand',
      position: { x: box.minX - BAND_PAD, y: box.minY - BAND_PAD },
      data: { title: phase.title },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: 0,
      style: {
        width: box.maxX - box.minX + BAND_PAD * 2,
        height: box.maxY - box.minY + BAND_PAD * 2,
      },
    });
  }
  return bands;
}
