import { afterEach, describe, expect, it } from 'vitest';
import { clearReplayData, getReplayData, prepareReplay, sliceEvents } from '../src/replay/data';
import { IncrementalReplay } from '../src/replay/engine';
import { ev, resetSeq } from './fixtures';

afterEach(() => clearReplayData());

/** A recording where agent A finishes early while B keeps producing output. */
function recording() {
  resetSeq();
  return [
    ev('session_started', undefined, { title: 'rec' }),
    ev('agent_created', 'A', { name: 'A', kind: 'subagent' }),
    ev('agent_started', 'A', {}),
    ev('agent_created', 'B', { name: 'B', kind: 'subagent' }),
    ev('agent_started', 'B', {}),
    ev('agent_output', 'A', { stream: 'message', chunk: 'a1\n' }),
    ev('agent_completed', 'A', { summary: 'done' }),
    ev('agent_output', 'B', { stream: 'message', chunk: 'b1\n' }),
    ev('agent_output', 'B', { stream: 'message', chunk: 'b2\n' }),
  ];
}

describe('sliceEvents (binary-searched incremental slice)', () => {
  it('returns the half-open (from, to] range', () => {
    prepareReplay('rec1', recording());
    const data = getReplayData()!;
    expect(sliceEvents(data, 6, 9).map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(sliceEvents(data, -1, 3).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(sliceEvents(data, 9, 9)).toEqual([]);
    expect(sliceEvents(data, 2, 2)).toEqual([]);
  });
});

describe('IncrementalReplay', () => {
  it('preserves agent object identity across a forward step (per-panel memo intact)', () => {
    prepareReplay('rec1', recording());
    const engine = new IncrementalReplay(getReplayData()!);

    const at7 = engine.seek(7); // A has completed here
    const aRef = at7.sessions['s1']?.agents['A'];
    expect(aRef?.lifecycle).toBe('completed');

    const at9 = engine.seek(9); // only B changes between 7 and 9
    // A was untouched → immer keeps the same reference, so its panel won't re-render.
    expect(at9.sessions['s1']?.agents['A']).toBe(aRef);
    expect(at9.sessions['s1']?.agents['B']?.outputTotal).toBe(2);
  });

  it('rebuilds correctly on a backward scrub', () => {
    prepareReplay('rec1', recording());
    const engine = new IncrementalReplay(getReplayData()!);
    engine.seek(9);
    const back = engine.seek(6); // before A completed
    expect(back.sessions['s1']?.agents['A']?.lifecycle).toBe('running');
    expect(back.sessions['s1']?.agents['B']?.outputTotal).toBe(0);
  });

  it('matches a full reduction at the same seq', () => {
    prepareReplay('rec1', recording());
    const engine = new IncrementalReplay(getReplayData()!);
    const inc = engine.seek(9);
    const b = inc.sessions['s1']?.agents['B'];
    expect(b?.outputTotal).toBe(2);
    expect(inc.sessions['s1']?.agents['A']?.lifecycle).toBe('completed');
  });
});
