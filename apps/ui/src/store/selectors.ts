/**
 * Pure derivations over the reduced state — kept out of components so they
 * can be reused and unit-tested. Everything here is a plain function of
 * WorkspaceState/SessionState; hooks live at the call sites.
 */
import type {
  AgentState,
  AttentionItem,
  SessionState,
  WorkspaceState,
} from '@visual-workflows/protocol';

export function activeSession(
  state: WorkspaceState,
  sessionId: string | null,
): SessionState | undefined {
  return sessionId ? state.sessions[sessionId] : undefined;
}

export function unresolvedAttention(session: SessionState | undefined): AttentionItem[] {
  if (!session) return [];
  return session.attention.filter((a) => !a.resolved);
}

/** The most recently active agent, for follow mode's camera target. */
export function latestActiveAgentId(session: SessionState | undefined): string | null {
  if (!session) return null;
  let best: AgentState | null = null;
  for (const id of session.agentOrder) {
    const a = session.agents[id];
    if (!a || a.lifecycle === 'completed' || a.lifecycle === 'cancelled') continue;
    if (!best || a.lastEventTs > best.lastEventTs) best = a;
  }
  return best?.id ?? null;
}

export interface LifecycleCounts {
  total: number;
  running: number;
  waiting: number;
  done: number;
  failed: number;
  attention: number;
}

export function lifecycleCounts(session: SessionState | undefined): LifecycleCounts {
  const counts: LifecycleCounts = {
    total: 0,
    running: 0,
    waiting: 0,
    done: 0,
    failed: 0,
    attention: 0,
  };
  if (!session) return counts;
  for (const id of session.agentOrder) {
    const a = session.agents[id];
    if (!a) continue;
    counts.total += 1;
    switch (a.lifecycle) {
      case 'running':
        counts.running += 1;
        break;
      case 'created':
        counts.waiting += 1;
        break;
      case 'completed':
      case 'cancelled':
        counts.done += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      case 'blocked':
      case 'awaiting_approval':
      case 'awaiting_input':
        counts.attention += 1;
        break;
    }
  }
  return counts;
}

/** Ordered agent ids for Tab/arrow cycling (topological-ish: creation order). */
export function agentCycleOrder(session: SessionState | undefined): string[] {
  return session ? [...session.agentOrder] : [];
}
