/**
 * EmptyState (docs/UI_SPEC.md): shown when there's nothing to watch. Two
 * large actions — run the scripted demo, or connect a real Claude Code
 * session with a copyable command. No dashboard, no empty grid.
 */
import { useState } from 'react';

export function EmptyState({ onRunDemo }: { onRunDemo(): void }) {
  const [copied, setCopied] = useState(false);
  // The package isn't published; the connect command runs through the repo's
  // `vw` script (see README quickstart) rather than a non-existent npx binary.
  const cmd = 'npm run vw -- connect';

  const copy = () => {
    void navigator.clipboard?.writeText(cmd).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };

  return (
    <div className="vw-empty">
      <h1>Watch your agents work</h1>
      <p>
        A live map of every Claude Code agent in a run — who spawned whom, what each is doing right
        now, and where a human is needed. Start with the demo, or connect a real session.
      </p>
      <div className="vw-empty-actions">
        <div className="vw-empty-card">
          <h2>Run the demo</h2>
          <p>
            A scripted multi-agent run — planning, parallel coders, a test that fails then goes
            green, a review.
          </p>
          <button className="vw-btn vw-btn-primary" onClick={onRunDemo}>
            ▶ Run the demo
          </button>
        </div>
        <div className="vw-empty-card">
          <h2>Connect Claude Code</h2>
          <p>
            Install the observer into your project, then run Claude Code as usual and watch it here.
          </p>
          <div className="vw-snippet">
            <code>{cmd}</code>
            <button
              className="vw-btn vw-btn-icon"
              onClick={copy}
              aria-label="Copy command"
              title="Copy"
            >
              {copied ? '✓' : '⧉'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
