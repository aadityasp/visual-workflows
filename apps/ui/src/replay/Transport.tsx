/**
 * Replay transport bar (docs/UI_SPEC.md "Replay"): play/pause, speeds
 * 1×/4×/16×/Max, and a seq scrubber with an event-density sparkline. The
 * heavy lifting (advancing seq, recomputing state) is the controller's; this
 * is just the control surface over the ui-store transport state.
 */
import { useUi } from '../store/ui';
import type { ReplaySpeed } from '../store/ui';

const SPEEDS: ReplaySpeed[] = [1, 4, 16, 'max'];

function speedLabel(s: ReplaySpeed): string {
  return s === 'max' ? 'Max' : `${s}×`;
}

export function Transport({ onExit }: { onExit: () => void }) {
  const r = useUi((s) => s.replay);
  const setSeq = useUi((s) => s.setReplaySeq);
  const setPlaying = useUi((s) => s.setReplayPlaying);
  const setSpeed = useUi((s) => s.setReplaySpeed);

  if (!r.recordingId) return null;

  const span = Math.max(1, r.maxSeq - r.minSeq);
  const fraction = (r.seq - r.minSeq) / span;
  const atEnd = r.seq >= r.maxSeq;
  const maxDensity = Math.max(1, ...r.density);

  const togglePlay = () => {
    if (r.playing) {
      setPlaying(false);
    } else {
      if (atEnd) setSeq(r.minSeq);
      setPlaying(true);
    }
  };

  return (
    <div className="vw-transport" role="group" aria-label="Replay transport">
      <button
        className="vw-btn vw-btn-icon"
        onClick={togglePlay}
        aria-label={r.playing ? 'Pause' : 'Play'}
        title={r.playing ? 'Pause (space)' : 'Play (space)'}
      >
        {r.playing ? '❚❚' : '▶'}
      </button>

      <div className="vw-transport-scrub">
        <div className="vw-density" aria-hidden="true">
          {r.density.map((count, i) => {
            const past = (i + 1) / r.density.length <= fraction;
            return (
              <i
                key={i}
                className={past ? 'is-past' : undefined}
                style={{ height: `${Math.max(8, (count / maxDensity) * 100)}%` }}
              />
            );
          })}
        </div>
        <input
          className="vw-range"
          type="range"
          min={r.minSeq}
          max={r.maxSeq}
          step={1}
          value={r.seq}
          aria-label="Seek by event sequence"
          onChange={(e) => setSeq(Number(e.target.value))}
        />
      </div>

      <div className="vw-speeds" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button
            key={String(s)}
            className={`vw-speed${r.speed === s ? ' is-active' : ''}`}
            aria-pressed={r.speed === s}
            onClick={() => setSpeed(s)}
          >
            {speedLabel(s)}
          </button>
        ))}
      </div>

      <span className="vw-seq">
        {r.seq}/{r.maxSeq}
      </span>

      <button className="vw-btn" onClick={onExit} title="Exit replay">
        Exit
      </button>
    </div>
  );
}
