/**
 * Incremental replay reducer. Playing a recording forward should be O(Δ), not
 * O(total): instead of re-reducing the whole history every frame, we reduce
 * only the new slice (lastSeq, seq] onto the prior state. Because the protocol
 * reducer is immer-based, unchanged agents keep referential identity, so the
 * per-panel selectors don't re-render the whole canvas each frame. Backward
 * scrubbing is the only case that rebuilds from scratch.
 */
import { createWorkspace, reduceAll, replayToSeq } from '@visual-workflows/protocol';
import type { WorkspaceState } from '@visual-workflows/protocol';
import { sliceEvents } from './data';
import type { ReplayData } from './data';

export class IncrementalReplay {
  private lastSeq = -1;
  private state: WorkspaceState = createWorkspace();

  constructor(private readonly data: ReplayData) {}

  get seq(): number {
    return this.lastSeq;
  }

  /** Advance/rewind to `seq`, returning the reduced state at that point. */
  seek(seq: number): WorkspaceState {
    if (seq >= this.lastSeq) {
      const slice = sliceEvents(this.data, this.lastSeq, seq);
      if (slice.length > 0) this.state = reduceAll(this.state, slice);
    } else {
      // Backward scrub: no incremental undo — rebuild the prefix.
      this.state = replayToSeq(this.data.events, seq);
    }
    this.lastSeq = seq;
    return this.state;
  }
}
