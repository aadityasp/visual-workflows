/**
 * The AgentPanel node (docs/UI_SPEC.md "AgentPanel anatomy"). Subscribes to
 * exactly one agent by id, so it re-renders only when that agent changes.
 *
 * Layout: header (character · name · type chip · elapsed · status chip ·
 * minimize/expand buttons), a current-action line, a 6-line output tail, and
 * footer fact chips. Any agent can be minimized to a compact chip row (the
 * minimize state lives in the ui store so the layout recomputes); completed/
 * cancelled agents collapse by default. Failed keeps full size with a red bar
 * and the error; blocked/awaiting get an amber bar. The panel is glass
 * (translucent) so the canvas shows through. Status is always icon + label.
 */
import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { AgentState } from '@visual-workflows/protocol';
import { AgentCharacter, variantForAgent } from '../characters/index';
import { statusFor, toneColor } from './status';
import { tailLines } from './output';
import { formatElapsed, formatTokens } from '../app/format';
import { useNow } from '../app/hooks';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import type { AgentNodeData } from './graph';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function elapsedMs(agent: AgentState, now: number): number {
  const start = agent.startedTs ?? agent.createdTs;
  const end = agent.endedTs ? new Date(agent.endedTs).getTime() : now;
  return end - new Date(start).getTime();
}

function tokenTotal(agent: AgentState): number {
  const u = agent.usage;
  if (!u) return 0;
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0);
}

function actionLine(agent: AgentState): { text: string; error: boolean } {
  if (agent.lifecycle === 'failed' && agent.error) {
    return { text: agent.error.message, error: true };
  }
  if (agent.lifecycle === 'blocked' && agent.blocked) {
    return { text: `Blocked: ${agent.blocked.reason}`, error: false };
  }
  if (agent.lifecycle === 'awaiting_approval')
    return { text: 'Waiting for approval', error: false };
  if (agent.lifecycle === 'awaiting_input') return { text: 'Waiting for input', error: false };
  if (agent.currentAction) return { text: agent.currentAction, error: false };
  if (agent.lifecycle === 'created') return { text: 'Queued', error: false };
  return { text: '', error: false };
}

function AgentPanelNodeImpl({ data }: NodeProps) {
  const { agentId, sessionId, pinned } = data as AgentNodeData;
  const agent = useWorkspace((s) => s.state.sessions[sessionId]?.agents[agentId]);
  const selected = useUi((s) => s.selectedAgentId === agentId);
  const collapsedOverride = useUi((s) => s.collapsed[agentId]);
  const setFocus = useUi((s) => s.setFocus);
  const select = useUi((s) => s.select);
  const setCollapsed = useUi((s) => s.setCollapsed);

  const running = agent ? !TERMINAL.has(agent.lifecycle) : false;
  const now = useNow(1000, running);

  if (!agent) return null;

  const status = statusFor(agent.lifecycle, agent.activity);
  const variant = variantForAgent(agent.name, agent.agentType);
  // Explicit minimize wins; otherwise completed/cancelled collapse by default.
  const collapsed =
    collapsedOverride !== undefined
      ? collapsedOverride
      : agent.lifecycle === 'completed' || agent.lifecycle === 'cancelled';

  const handles = (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );

  if (collapsed) {
    const restore = () => {
      select(agentId);
      setCollapsed(agentId, false);
    };
    return (
      <div
        className={`vw-chip-node vw-panel-enter${agent.lifecycle === 'completed' ? ' is-done' : ''}`}
        onDoubleClick={() => setFocus(agentId)}
        onClick={restore}
        role="group"
        aria-label={`${agent.name}: ${status.label} (minimized)`}
      >
        {handles}
        <AgentCharacter
          lifecycle={agent.lifecycle}
          activity={agent.activity}
          variant={variant}
          size={36}
        />
        <div className="vw-chip-body">
          <div className="vw-chip-name">{agent.name}</div>
          <div className="vw-chip-sum">{agent.summary ?? agent.currentAction ?? ''}</div>
        </div>
        <span
          className="vw-status-chip vw-status-chip-sm"
          style={{ color: toneColor(status.tone) }}
        >
          <span className="vw-status-ico" aria-hidden="true">
            {status.icon}
          </span>
          {status.label}
        </span>
        <button
          className="vw-icon-btn"
          title="Restore panel"
          aria-label={`Restore ${agent.name} panel`}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed(agentId, false);
          }}
        >
          ▸
        </button>
      </div>
    );
  }

  const action = actionLine(agent);
  const lines = tailLines(agent.outputTail, 6);
  const tokens = tokenTotal(agent);
  const ctxPct = agent.usage?.contextPct;
  const barPct = ctxPct != null ? Math.min(100, ctxPct) : Math.min(100, (tokens / 200_000) * 100);

  const cls = ['vw-panel-node', 'vw-panel-enter'];
  if (selected) cls.push('is-selected');
  if (agent.lifecycle === 'failed') cls.push('is-failed');
  else if (agent.lifecycle === 'blocked') cls.push('is-blocked');
  else if (agent.lifecycle === 'awaiting_approval' || agent.lifecycle === 'awaiting_input') {
    cls.push('is-awaiting', 'is-attn');
  }

  return (
    <div
      className={cls.join(' ')}
      onDoubleClick={() => setFocus(agentId)}
      onClick={() => select(agentId)}
      role="group"
      aria-label={`${agent.name}${agent.agentType ? `, ${agent.agentType}` : ''}: ${status.label}`}
    >
      {handles}
      <div className="vw-panel-head">
        <AgentCharacter
          lifecycle={agent.lifecycle}
          activity={agent.activity}
          variant={variant}
          size={44}
        />
        <div className="vw-panel-id">
          <div className="vw-panel-name" title={agent.name}>
            {agent.name}
            {pinned ? (
              <span className="vw-pin" title="pinned">
                {' '}
                ⚲
              </span>
            ) : null}
          </div>
          <div className="vw-panel-sub">
            {agent.agentType ? <span className="vw-type-chip">{agent.agentType}</span> : null}
            <span className="vw-elapsed">{formatElapsed(elapsedMs(agent, now))}</span>
          </div>
        </div>
        <span className="vw-status-chip" style={{ color: toneColor(status.tone) }}>
          <span className="vw-status-ico" aria-hidden="true">
            {status.icon}
          </span>
          {status.label}
        </span>
        <div className="vw-panel-btns">
          <button
            className="vw-icon-btn"
            title="Minimize panel"
            aria-label="Minimize panel"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed(agentId, true);
            }}
          >
            ▁
          </button>
          <button
            className="vw-icon-btn"
            title="Expand to focus"
            aria-label="Expand panel"
            onClick={(e) => {
              e.stopPropagation();
              setFocus(agentId);
            }}
          >
            ⤢
          </button>
        </div>
      </div>

      <div className={`vw-panel-action${action.error ? ' is-error' : ''}`}>{action.text}</div>

      <div className="vw-tail" aria-hidden="true">
        {lines.length === 0 ? (
          <div className="vw-tail-line vw-tail-empty">no output yet</div>
        ) : (
          lines.map((l) => (
            <div key={l.key} className={`vw-tail-line${l.stream === 'stderr' ? ' is-stderr' : ''}`}>
              {l.text || ' '}
            </div>
          ))
        )}
      </div>

      <div className="vw-panel-foot">
        {agent.filesModified.length > 0 ? (
          <span className="vw-fact" title="files touched">
            <span className="vw-fact-ico" aria-hidden="true">
              ⛃
            </span>
            {agent.filesModified.length} files
          </span>
        ) : null}
        {agent.toolCallCount > 0 ? (
          <span className="vw-fact" title="tool calls">
            <span className="vw-fact-ico" aria-hidden="true">
              ⚙
            </span>
            {agent.toolCallCount} tools
          </span>
        ) : null}
        {agent.childIds.length > 0 ? (
          <span className="vw-fact" title="child agents">
            <span className="vw-fact-ico" aria-hidden="true">
              ↳
            </span>
            {agent.childIds.length} children
          </span>
        ) : null}
        {agent.retryCount > 0 ? (
          <span className="vw-fact" title="retries">
            <span className="vw-fact-ico" aria-hidden="true">
              ⟳
            </span>
            {agent.retryCount} {agent.retryCount === 1 ? 'retry' : 'retries'}
          </span>
        ) : null}
        {tokens > 0 || ctxPct != null ? (
          <span className="vw-fact" title="token usage">
            <span className="vw-tok-bar" aria-hidden="true">
              <i style={{ width: `${barPct}%` }} />
            </span>
            {formatTokens(tokens)} tok
          </span>
        ) : null}
      </div>
    </div>
  );
}

export const AgentPanelNode = memo(AgentPanelNodeImpl);
