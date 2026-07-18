/**
 * Focus mode (docs/UI_SPEC.md "Focus mode"): one agent maximized in-canvas
 * (a maximize, not a modal dialog). This is the ONLY place an xterm.js
 * instance mounts — cards use cheap DOM tails. History is written on open,
 * then live chunks stream in; the terminal is disposed on close.
 *
 * Tabs: Output (terminal) · Files · Tools · Details.
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { AgentState } from '@visual-workflows/protocol';
import { AgentCharacter, variantForAgent } from '../characters/index';
import { statusFor, toneColor } from '../canvas/status';
import { fullOutputText, terminalUpdate } from '../canvas/output';
import { formatElapsed } from '../app/format';
import { useNow, useFocusTrap } from '../app/hooks';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';

type Tab = 'output' | 'files' | 'tools' | 'details';

function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    // Translucent (glass) so the dimmed canvas stays visible behind the
    // terminal; --vw-glass becomes solid under prefers-reduced-transparency.
    background: v('--vw-glass', 'rgba(11, 14, 20, 0.72)'),
    foreground: v('--vw-text', '#e6eaf2'),
    cursor: v('--vw-accent', '#4cc2ff'),
    selectionBackground: 'rgba(76,194,255,0.25)',
    red: v('--vw-danger', '#f26d6d'),
    green: v('--vw-success', '#3dd68c'),
    yellow: v('--vw-warn', '#f5b94c'),
    blue: v('--vw-running', '#4cc2ff'),
    magenta: v('--vw-thinking', '#a78bfa'),
  };
}

function OutputTerminal({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return undefined;
    const term = new Terminal({
      convertEol: true,
      allowTransparency: true,
      fontFamily: "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      theme: termTheme(),
      scrollback: 5000,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* container not measured yet */
    }

    const first = useWorkspace.getState().state.sessions[sessionId]?.agents[agentId];
    let writtenSeq = -1;
    if (first) {
      term.write(fullOutputText(first.outputTail));
      writtenSeq = first.outputTail.at(-1)?.seq ?? -1;
    }

    const unsub = useWorkspace.subscribe((s) => {
      const agent = s.state.sessions[sessionId]?.agents[agentId];
      if (!agent) return;
      // Handles both live append and replay scrub-backward (tail regression).
      const upd = terminalUpdate(writtenSeq, agent.outputTail);
      if (upd.clear) term.clear();
      if (upd.text) term.write(upd.text);
      writtenSeq = upd.writtenSeq;
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(el);

    return () => {
      unsub();
      ro.disconnect();
      term.dispose();
    };
  }, [sessionId, agentId]);

  return <div className="vw-term" ref={mountRef} />;
}

function FilesTab({ agent }: { agent: AgentState }) {
  return (
    <div className="vw-focus-list">
      <h3>Modified ({agent.filesModified.length})</h3>
      {agent.filesModified.length === 0 ? <div className="vw-mono">none</div> : null}
      {agent.filesModified.map((f, i) => (
        <div className="vw-mono" key={`m${i}`}>
          {f.changeKind === 'deleted' ? '−' : f.changeKind === 'created' ? '+' : '~'} {f.path}
        </div>
      ))}
      <h3>Read ({agent.filesRead.length})</h3>
      {agent.filesRead.length === 0 ? <div className="vw-mono">none</div> : null}
      {agent.filesRead.map((p, i) => (
        <div className="vw-mono" key={`r${i}`}>
          {p}
        </div>
      ))}
    </div>
  );
}

function ToolsTab({ agent }: { agent: AgentState }) {
  return (
    <div className="vw-focus-list">
      <h3>Tool calls ({agent.toolCallCount})</h3>
      {agent.toolCalls.length === 0 ? <div className="vw-mono">none</div> : null}
      {agent.toolCalls.map((t) => (
        <div className="vw-mono" key={t.id}>
          {t.completed ? (t.ok ? '✓' : '⨯') : '…'} {t.tool}: {t.inputSummary}
          {t.durationMs != null ? `  (${Math.round(t.durationMs)}ms)` : ''}
        </div>
      ))}
      <h3>Commands ({agent.commandCount})</h3>
      {agent.commands.length === 0 ? <div className="vw-mono">none</div> : null}
      {agent.commands.map((c) => (
        <div className="vw-mono" key={c.id}>
          {c.completed ? (c.ok ? '✓' : `⨯ (${c.exitCode ?? '?'})`) : '…'} {c.command}
        </div>
      ))}
    </div>
  );
}

function DetailsTab({ agent }: { agent: AgentState }) {
  const u = agent.usage;
  return (
    <div className="vw-focus-list">
      <dl className="vw-kv">
        <dt>Agent id</dt>
        <dd className="vw-mono">{agent.id}</dd>
        <dt>Kind</dt>
        <dd>{agent.kind}</dd>
        {agent.agentType ? (
          <>
            <dt>Type</dt>
            <dd>{agent.agentType}</dd>
          </>
        ) : null}
        {agent.model ? (
          <>
            <dt>Model</dt>
            <dd className="vw-mono">{agent.model}</dd>
          </>
        ) : null}
        {agent.phase ? (
          <>
            <dt>Phase</dt>
            <dd>{agent.phase}</dd>
          </>
        ) : null}
        <dt>Parent</dt>
        <dd className="vw-mono">{agent.parentAgentId ?? '—'}</dd>
        <dt>Children</dt>
        <dd className="vw-mono">{agent.childIds.length > 0 ? agent.childIds.join(', ') : '—'}</dd>
        {u ? (
          <>
            <dt>Tokens</dt>
            <dd className="vw-mono">
              in {u.inputTokens ?? 0} · out {u.outputTokens ?? 0}
              {u.cacheReadTokens != null ? ` · cache ${u.cacheReadTokens}` : ''}
              {u.contextPct != null ? ` · ctx ${u.contextPct}%` : ''}
            </dd>
          </>
        ) : null}
      </dl>
      {agent.error ? (
        <>
          <h3>Error</h3>
          <div className="vw-mono" style={{ color: 'var(--vw-danger)' }}>
            {agent.error.kind ? `[${agent.error.kind}] ` : ''}
            {agent.error.message}
          </div>
        </>
      ) : null}
      {agent.summary ? (
        <>
          <h3>Summary</h3>
          <div>{agent.summary}</div>
        </>
      ) : null}
    </div>
  );
}

function FocusCard({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const setFocus = useUi((s) => s.setFocus);
  const [tab, setTab] = useState<Tab>('output');
  const cardRef = useFocusTrap<HTMLDivElement>(() => setFocus(null));
  const agent = useWorkspace((s) => s.state.sessions[sessionId]?.agents[agentId]);
  const running = agent ? !['completed', 'failed', 'cancelled'].includes(agent.lifecycle) : false;
  const now = useNow(1000, running);

  if (!agent) return null;
  const status = statusFor(agent.lifecycle, agent.activity);
  const variant = variantForAgent(agent.name, agent.agentType);
  const elapsed = agent.startedTs
    ? formatElapsed(
        (agent.endedTs ? new Date(agent.endedTs).getTime() : now) -
          new Date(agent.startedTs).getTime(),
      )
    : '';

  return (
    <div className="vw-focus" onClick={() => setFocus(null)}>
      <div
        ref={cardRef}
        className="vw-focus-card"
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.name} — focus view`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="vw-focus-head">
          <AgentCharacter
            lifecycle={agent.lifecycle}
            activity={agent.activity}
            variant={variant}
            size={40}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="vw-focus-title">{agent.name}</div>
            <div className="vw-mono" style={{ color: 'var(--vw-text-dim)', fontSize: 12 }}>
              {agent.agentType ? `${agent.agentType} · ` : ''}
              {agent.model ? `${agent.model} · ` : ''}
              {elapsed}
            </div>
          </div>
          <span className="vw-status-chip" style={{ color: toneColor(status.tone) }}>
            <span className="vw-status-ico" aria-hidden="true">
              {status.icon}
            </span>
            {status.label}
          </span>
          <button
            className="vw-btn vw-btn-icon"
            aria-label="Close focus"
            onClick={() => setFocus(null)}
          >
            ✕
          </button>
        </div>
        <div className="vw-tabs" role="tablist">
          {(['output', 'files', 'tools', 'details'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`vw-tab${tab === t ? ' is-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'output'
                ? 'Output'
                : t === 'files'
                  ? 'Files'
                  : t === 'tools'
                    ? 'Tools'
                    : 'Details'}
            </button>
          ))}
        </div>
        <div className="vw-focus-body">
          {tab === 'output' ? <OutputTerminal sessionId={sessionId} agentId={agentId} /> : null}
          {tab === 'files' ? <FilesTab agent={agent} /> : null}
          {tab === 'tools' ? <ToolsTab agent={agent} /> : null}
          {tab === 'details' ? <DetailsTab agent={agent} /> : null}
        </div>
      </div>
    </div>
  );
}

export function FocusView() {
  const focusAgentId = useUi((s) => s.focusAgentId);
  const sessionId = useUi((s) => s.activeSessionId);
  if (!focusAgentId || !sessionId) return null;
  // Key by agent so switching focus target resets tab + remounts the terminal.
  return <FocusCard key={focusAgentId} sessionId={sessionId} agentId={focusAgentId} />;
}
