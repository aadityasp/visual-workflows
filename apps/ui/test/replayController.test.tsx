// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReplayController } from '../src/replay/controller';
import { clearReplayData, prepareReplay } from '../src/replay/data';
import { useUi } from '../src/store/ui';
import { useWorkspace } from '../src/store/workspace';
import { ev, resetSeq } from './fixtures';

// The controller runs a rAF loop driven by performance.now(). We replace both
// with a manual pump so we can step frames deterministically: each pump()
// advances the fake clock and runs exactly one loop iteration (which reschedules
// the next frame into the queue).
let rafQueue: FrameRequestCallback[] = [];
let now = 0;

function pump(dtMs: number): void {
  now += dtMs;
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(now);
}

/** A recording where A completes at seq 7 and B outputs at seq 8 and 9. */
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

function startAt(seq: number, playing: boolean) {
  const meta = prepareReplay('rec1', recording());
  useUi.getState().startReplay({
    recordingId: 'rec1',
    sessionId: 's1',
    minSeq: meta.minSeq,
    maxSeq: meta.maxSeq,
    density: meta.density,
  });
  useUi.getState().setReplaySeq(seq);
  useUi.getState().setReplayPlaying(playing);
  return meta;
}

beforeEach(() => {
  rafQueue = [];
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  useWorkspace.getState().reset();
  useUi.getState().stopReplay();
});

afterEach(() => {
  clearReplayData();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useReplayController', () => {
  it('advances seq over time while playing and writes the reduced state', () => {
    const meta = startAt(1, true);
    const { unmount } = renderHook(() => useReplayController());

    pump(0); // frame 1: build engine + baseline, write seek(min)
    expect(useUi.getState().replay.seq).toBe(meta.minSeq);

    pump(3000); // 3s at 1x → offset 3000ms → seq 4 (events are 1s apart)
    const advanced = useUi.getState().replay.seq;
    expect(advanced).toBeGreaterThan(meta.minSeq);
    // The workspace store reflects the reduced state at the advanced seq.
    expect(useWorkspace.getState().state.sessions['s1']?.agents['A']?.lifecycle).toBe('running');

    unmount();
  });

  it('re-bases on a backward scrub (engine rebuilds the prefix)', () => {
    startAt(9, false);
    const { unmount } = renderHook(() => useReplayController());

    pump(0); // land on seq 9: A completed, B has 2 outputs
    let s = useWorkspace.getState().state.sessions['s1'];
    expect(s?.agents['A']?.lifecycle).toBe('completed');
    expect(s?.agents['B']?.outputTotal).toBe(2);

    // Scrub backwards to before A completed.
    useUi.getState().setReplaySeq(6);
    pump(0);
    s = useWorkspace.getState().state.sessions['s1'];
    expect(s?.agents['A']?.lifecycle).toBe('running');
    expect(s?.agents['B']?.outputTotal).toBe(0);

    unmount();
  });

  it('scrubbing while playing re-bases the time origin to the scrub point', () => {
    startAt(1, true);
    const { unmount } = renderHook(() => useReplayController());

    pump(0);
    pump(5000); // advance well into the recording
    expect(useUi.getState().replay.seq).toBeGreaterThan(4);

    // Scrub back while still playing: the next frame must resume from ~seq 2,
    // not snap forward from where the old time baseline pointed.
    useUi.getState().setReplaySeq(2);
    pump(100);
    expect(useUi.getState().replay.seq).toBeLessThanOrEqual(3);

    unmount();
  });
});
