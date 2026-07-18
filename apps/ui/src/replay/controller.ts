/**
 * Client-side replay engine (docs/UI_SPEC.md "Replay"). A single rAF loop
 * advances the transport's seq using the recording's own event timing scaled
 * by the playback speed, then reduces the workspace INCREMENTALLY (only the
 * new event slice, via IncrementalReplay) and writes it to the workspace
 * store. Scrubbing sets seq directly; the loop re-baselines and the recompute
 * is naturally throttled to one per frame.
 */
import { useEffect } from 'react';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { getReplayData, offsetForSeq, seqForOffset } from './data';
import { IncrementalReplay } from './engine';
import type { ReplaySpeed } from '../store/ui';

interface Baseline {
  startMs: number;
  offset: number;
  speed: ReplaySpeed;
}

/** 'Max' speed advances a large fixed seq step per frame so it still animates. */
function maxStep(minSeq: number, maxSeq: number): number {
  return Math.max(1, Math.ceil((maxSeq - minSeq) / 90));
}

export function useReplayController(): void {
  useEffect(() => {
    let raf = 0;
    let engine: IncrementalReplay | null = null;
    let engineRecordingId: string | null = null;
    let lastWritten = -1;
    let baseline: Baseline | null = null;

    const loop = (): void => {
      const ui = useUi.getState();
      const r = ui.replay;
      const data = getReplayData();

      if (r.recordingId && data) {
        // (Re)build the engine when the recording changes.
        if (!engine || engineRecordingId !== data.recordingId) {
          engine = new IncrementalReplay(data);
          engineRecordingId = data.recordingId;
          lastWritten = -1;
          baseline = null;
        }
        // A seq that isn't the one we last wrote means the user scrubbed.
        if (lastWritten !== -1 && r.seq !== lastWritten) baseline = null;

        let seq = r.seq;
        if (r.playing) {
          if (r.speed === 'max') {
            seq = Math.min(r.maxSeq, r.seq + maxStep(r.minSeq, r.maxSeq));
            baseline = null;
          } else {
            if (!baseline || baseline.speed !== r.speed) {
              baseline = {
                startMs: performance.now(),
                offset: offsetForSeq(data, r.seq),
                speed: r.speed,
              };
            }
            const elapsed = (performance.now() - baseline.startMs) * r.speed;
            seq = seqForOffset(data, baseline.offset + elapsed);
          }
          if (seq >= r.maxSeq) {
            seq = r.maxSeq;
            ui.setReplayPlaying(false);
            baseline = null;
          }
        } else {
          baseline = null;
        }

        if (seq !== r.seq) ui.setReplaySeq(seq);
        if (seq !== lastWritten) {
          useWorkspace.getState().setState(engine.seek(seq));
          lastWritten = seq;
        }
      } else {
        engine = null;
        engineRecordingId = null;
        lastWritten = -1;
        baseline = null;
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}
