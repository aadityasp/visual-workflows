/**
 * Auto-layout: dagre, left→right. Rank = execution order, so parallel agents
 * share a rank and, by default, stack vertically in one column. That is fine
 * for a handful of siblings but falls apart when one parent fans out to dozens
 * of children (e.g. 40+ subagents under `main`): dagre stacks them all in a
 * single very tall column and the graph becomes an unreadable strip that never
 * fits on screen.
 *
 * To keep busy real sessions readable we post-process dagre's output: any rank
 * with more than CROWD_THRESHOLD nodes is re-flowed from a single column into a
 * roughly-square GRID within its own horizontal band, and every rank to its
 * right is shifted over to make room. Small graphs (every rank ≤ threshold) are
 * left byte-for-byte as dagre produced them, so the demo layout is unchanged.
 *
 * Pinned (user-dragged) nodes are handled by the caller, which overrides
 * positions after layout.
 */
import dagre from '@dagrejs/dagre';

export const PANEL_W = 360;
export const PANEL_H = 230;

/** Ranks with more than this many nodes get gridded instead of single-column. */
const CROWD_THRESHOLD = 6;
/** Gap between grid cells (matches dagre's nodesep for visual continuity). */
const GRID_GAP = 40;

export interface LayoutItem {
  id: string;
  width: number;
  height: number;
}

export interface LayoutLink {
  from: string;
  to: string;
}

export interface XY {
  x: number;
  y: number;
}

interface Center {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function computeLayout(items: LayoutItem[], links: LayoutLink[]): Record<string, XY> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90, marginx: 48, marginy: 48 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set<string>();
  for (const it of items) {
    ids.add(it.id);
    g.setNode(it.id, { width: it.width, height: it.height });
  }
  for (const l of links) {
    if (l.from !== l.to && ids.has(l.from) && ids.has(l.to)) g.setEdge(l.from, l.to);
  }
  dagre.layout(g);

  // Work in center coordinates (what dagre reports), then convert to top-left.
  const centers = new Map<string, Center>();
  for (const it of items) {
    const n = g.node(it.id);
    if (n) centers.set(it.id, { x: n.x, y: n.y, w: it.width, h: it.height });
  }

  regridCrowdedRanks(centers);

  const out: Record<string, XY> = {};
  for (const it of items) {
    const c = centers.get(it.id);
    if (c) out[it.id] = { x: c.x - c.w / 2, y: c.y - c.h / 2 };
  }
  return out;
}

/**
 * Re-flow any over-crowded rank (a set of nodes sharing an x, i.e. dagre's
 * single vertical column) into a roughly-square grid, shifting later ranks
 * right to make room. Mutates `centers` in place. A rank with ≤ threshold nodes
 * is untouched, so small graphs are identical to plain dagre.
 */
function regridCrowdedRanks(centers: Map<string, Center>): void {
  // Group nodes by rank. In LR layout every node in a rank shares one x center.
  const byRank = new Map<number, string[]>();
  for (const [id, c] of centers) {
    const key = Math.round(c.x);
    const bucket = byRank.get(key);
    if (bucket) bucket.push(id);
    else byRank.set(key, [id]);
  }

  // Process ranks left→right so cumulative right-shifts compose correctly.
  const rankKeys = [...byRank.keys()].sort((a, b) => a - b);
  for (const key of rankKeys) {
    const members = byRank.get(key)!;
    if (members.length <= CROWD_THRESHOLD) continue;

    // Members were shifted uniformly by earlier ranks, so they still share an x;
    // read it live rather than trusting the original bucket key.
    const rankX = centers.get(members[0]!)!.x;

    // Preserve dagre's crossing-minimized order (top→bottom) within the grid.
    members.sort((a, b) => centers.get(a)!.y - centers.get(b)!.y);

    const n = members.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    let maxW = 0;
    let maxH = 0;
    let sumY = 0;
    for (const id of members) {
      const c = centers.get(id)!;
      maxW = Math.max(maxW, c.w);
      maxH = Math.max(maxH, c.h);
      sumY += c.y;
    }
    const cellW = maxW + GRID_GAP;
    const cellH = maxH + GRID_GAP;
    const centerY = sumY / n; // keep the grid centered where the column was

    // Column 0 stays at the rank's x; the grid grows rightward and is centered
    // vertically on the old column's midpoint.
    for (let i = 0; i < n; i += 1) {
      const c = centers.get(members[i]!)!;
      const col = i % cols;
      const row = Math.floor(i / cols);
      c.x = rankX + col * cellW;
      c.y = centerY + (row - (rows - 1) / 2) * cellH;
    }

    // Make room: push every node strictly to the right of this rank over by the
    // extra width the grid introduced, so later ranks never overlap the grid.
    const extraWidth = (cols - 1) * cellW;
    if (extraWidth > 0) {
      const memberSet = new Set(members);
      for (const [id, c] of centers) {
        if (!memberSet.has(id) && c.x > rankX + 0.5) c.x += extraWidth;
      }
    }
  }
}
