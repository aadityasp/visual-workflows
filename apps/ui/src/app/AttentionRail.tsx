/**
 * Attention Rail (docs/UI_SPEC.md) — the only interruption surface. Shows
 * unresolved approvals, blockers, failures and input requests as large
 * cards; clicking one selects the agent and flies the camera to it. Hidden
 * entirely when there is nothing to attend to (calm by default).
 */
import type { AttentionItem, AttentionKind } from '@visual-workflows/protocol';
import { useWorkspace } from '../store/workspace';
import { useUi } from '../store/ui';
import { activeSession, unresolvedAttention } from '../store/selectors';

const KIND_META: Record<AttentionKind, { icon: string; label: string }> = {
  approval: { icon: '✋', label: 'Approval' },
  blocker: { icon: '⛔', label: 'Blocked' },
  failure: { icon: '⨯', label: 'Failure' },
  input: { icon: '⧖', label: 'Input needed' },
};

export function AttentionRail() {
  const sessionId = useUi((s) => s.activeSessionId);
  const select = useUi((s) => s.select);
  const requestCenter = useUi((s) => s.requestCenter);
  const session = useWorkspace((s) => activeSession(s.state, sessionId));
  const items = unresolvedAttention(session);

  if (items.length === 0) return null;

  const go = (item: AttentionItem) => {
    if (item.agentId) {
      select(item.agentId);
      requestCenter(item.agentId);
    }
  };

  return (
    <aside className="vw-rail" aria-label="Attention">
      <div className="vw-rail-title">Needs attention · {items.length}</div>
      {items.slice(0, 20).map((item, i) => {
        const meta = KIND_META[item.kind];
        const name = item.agentId ? session?.agents[item.agentId]?.name : undefined;
        return (
          <button
            key={item.id}
            className={`vw-attn-card vw-attn-${item.kind}`}
            onClick={() => go(item)}
          >
            {i < 9 ? <span className="vw-attn-index">{i + 1}</span> : null}
            <div className="vw-attn-kind">
              <span aria-hidden="true">{meta.icon}</span>
              {meta.label}
            </div>
            <div className="vw-attn-msg">{item.message}</div>
            {name ? <div className="vw-attn-agent">{name}</div> : null}
          </button>
        );
      })}
    </aside>
  );
}
