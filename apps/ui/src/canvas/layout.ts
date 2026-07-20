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
 * single vertical column) into a compact block, shifting later ranks right to
 * make room. Mutates `centers` in place. A rank with ≤ threshold nodes is
 * untouched, so small graphs are identical to plain dagre.
 *
 * The block is shelf-packed by each node's actual size: full-size (running)
 * panels are laid out first so the active work stays prominent, then the small
 * completed chips pack densely below — so a session with a few running agents
 * and dozens of finished ones reads as "here's what's live, and here's the
 * compressed history", not one undifferentiated wall.
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

    let sumY = 0;
    let maxW = 0;
    let tallest = 0;
    for (const id of members) {
      const c = centers.get(id)!;
      sumY += c.y;
      maxW = Math.max(maxW, c.w);
      tallest = Math.max(tallest, c.h);
    }
    const centerY = sumY / members.length; // re-center the block on the column

    // Order: full-size panels first (prominent), compact chips after; within
    // each group keep dagre's crossing-minimized top→bottom order.
    const isChip = (id: string) => centers.get(id)!.h < tallest - 0.5;
    members.sort((a, b) => {
      const ca = isChip(a) ? 1 : 0;
      const cb = isChip(b) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return centers.get(a)!.y - centers.get(b)!.y;
    });

    // Band width ≈ a roughly-square grid of the widest (full-size) cell, so full
    // panels get ~√n columns while the narrower chips pack more per row.
    const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const bandW = cols * (maxW + GRID_GAP);

    // Shelf-pack left→right, wrapping when a row would exceed bandW; each row is
    // as tall as its tallest member, so chip rows stay short and dense.
    const topLeft = new Map<string, XY>();
    let cx = 0;
    let cy = 0;
    let rowH = 0;
    let blockRight = 0;
    for (const id of members) {
      const c = centers.get(id)!;
      if (cx > 0 && cx + c.w > bandW) {
        cy += rowH + GRID_GAP;
        cx = 0;
        rowH = 0;
      }
      topLeft.set(id, { x: cx, y: cy });
      cx += c.w + GRID_GAP;
      rowH = Math.max(rowH, c.h);
      blockRight = Math.max(blockRight, cx - GRID_GAP);
    }
    const blockBottom = cy + rowH;

    // Anchor the block's left at rankX, centered vertically on the old column;
    // convert each node's top-left slot to a center.
    const blockTop = centerY - blockBottom / 2;
    for (const id of members) {
      const c = centers.get(id)!;
      const tl = topLeft.get(id)!;
      c.x = rankX + tl.x + c.w / 2;
      c.y = blockTop + tl.y + c.h / 2;
    }

    // Push every node to the right of this rank over by the extra width the
    // block introduced beyond dagre's single column, so nothing overlaps.
    const extraWidth = Math.max(0, blockRight - maxW / 2);
    if (extraWidth > 0) {
      const memberSet = new Set(members);
      for (const [id, c] of centers) {
        if (!memberSet.has(id) && c.x > rankX + 0.5) c.x += extraWidth;
      }
    }
  }
}
