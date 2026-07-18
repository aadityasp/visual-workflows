import { describe, expect, it } from 'vitest';
import { computeLayout, PANEL_W, PANEL_H } from '../src/canvas/layout';
import type { LayoutItem, LayoutLink } from '../src/canvas/layout';

function panel(id: string): LayoutItem {
  return { id, width: PANEL_W, height: PANEL_H };
}

function allFinite(pos: Record<string, { x: number; y: number }>): boolean {
  return Object.values(pos).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

describe('computeLayout', () => {
  it('lays a spawn chain out in strictly increasing ranks (left→right)', () => {
    const items = ['main', 'a', 'b', 'c'].map(panel);
    const links: LayoutLink[] = [
      { from: 'main', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    const pos = computeLayout(items, links);

    expect(allFinite(pos)).toBe(true);
    // Each child sits to the right of its parent — increasing rank == increasing x.
    expect(pos.a!.x).toBeGreaterThan(pos.main!.x);
    expect(pos.b!.x).toBeGreaterThan(pos.a!.x);
    expect(pos.c!.x).toBeGreaterThan(pos.b!.x);
    // A single-node chain stays a single column: distinct, non-overlapping x's.
    const xs = new Set(['main', 'a', 'b', 'c'].map((id) => Math.round(pos[id]!.x)));
    expect(xs.size).toBe(4);
  });

  it('gives 3 sibling items distinct, finite, non-overlapping positions', () => {
    const items = ['main', 'a', 'b'].map(panel);
    const links: LayoutLink[] = [
      { from: 'main', to: 'a' },
      { from: 'main', to: 'b' },
    ];
    const pos = computeLayout(items, links);
    expect(allFinite(pos)).toBe(true);
    // Children to the right of the parent.
    expect(pos.a!.x).toBeGreaterThan(pos.main!.x);
    expect(pos.b!.x).toBeGreaterThan(pos.main!.x);
    // Two siblings do not overlap (different y in the same column).
    expect(pos.a!.y).not.toBe(pos.b!.y);
  });

  it('reflows a large sibling fan-out into a bounded grid, not one tall column', () => {
    const N = 60;
    const items = [panel('main')];
    const links: LayoutLink[] = [];
    for (let i = 0; i < N; i += 1) {
      const id = `c${i}`;
      items.push(panel(id));
      links.push({ from: 'main', to: id });
    }
    const pos = computeLayout(items, links);
    expect(allFinite(pos)).toBe(true);

    const childIds = Array.from({ length: N }, (_, i) => `c${i}`);
    const xs = childIds.map((id) => pos[id]!.x);
    const ys = childIds.map((id) => pos[id]!.y);
    const distinctColumns = new Set(xs.map((x) => Math.round(x)));

    // Not a single column: the fan-out spreads across several grid columns.
    expect(distinctColumns.size).toBeGreaterThanOrEqual(4);

    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    // A single dagre column of 60 panels would be ~ 60 * (PANEL_H + gap) ≈ 16000
    // tall. The grid must be dramatically shorter.
    const singleColumnHeight = N * (PANEL_H + 40);
    expect(height).toBeLessThan(singleColumnHeight / 3);

    // Bounded in BOTH axes and roughly square (same order of magnitude), so it
    // fits on screen at 40–130 nodes.
    const cols = Math.ceil(Math.sqrt(N));
    const rows = Math.ceil(N / cols);
    expect(width).toBeLessThan(cols * (PANEL_W + 40));
    expect(height).toBeLessThan(rows * (PANEL_H + 40));
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    const ratio = Math.max(width, height) / Math.min(width, height);
    expect(ratio).toBeLessThan(4);

    // No two panels share the same cell (grid is non-overlapping).
    const cells = new Set(
      childIds.map((id) => `${Math.round(pos[id]!.x)},${Math.round(pos[id]!.y)}`),
    );
    expect(cells.size).toBe(N);
  });

  it('tolerates edges to missing ids and self-loops without throwing', () => {
    const items = ['a', 'b', 'c'].map(panel);
    const links: LayoutLink[] = [
      { from: 'a', to: 'ghost' }, // dangling target
      { from: 'nobody', to: 'b' }, // dangling source
      { from: 'b', to: 'b' }, // self-loop
      { from: 'a', to: 'b' },
    ];
    let pos: Record<string, { x: number; y: number }> = {};
    expect(() => {
      pos = computeLayout(items, links);
    }).not.toThrow();
    for (const id of ['a', 'b', 'c']) {
      expect(pos[id]).toBeDefined();
      expect(Number.isFinite(pos[id]!.x)).toBe(true);
      expect(Number.isFinite(pos[id]!.y)).toBe(true);
    }
  });
});
