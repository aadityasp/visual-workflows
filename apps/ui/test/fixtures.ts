/** Shared event fixtures for the UI store/component tests. */
import type { EventEnvelope, EventPayloadMap, EventType } from '@visual-workflows/protocol';

let seq = 0;

export function resetSeq(): void {
  seq = 0;
}

export function ev<T extends EventType>(
  type: T,
  agentId: string | undefined,
  payload: EventPayloadMap[T],
  sessionId = 's1',
): EventEnvelope<T> {
  seq += 1;
  return {
    v: 1,
    id: `evt-${seq}`,
    seq,
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    source: 'demo',
    sessionId,
    workflowId: 'wf1',
    agentId,
    type,
    payload,
  };
}

/** A single agent that runs and completes (auto-collapses to a chip). */
export function completedScenario(): EventEnvelope[] {
  resetSeq();
  return [
    ev('session_started', undefined, { title: 'Done run' }),
    ev('agent_created', 'done1', { name: 'Finisher', kind: 'subagent', agentType: 'coder' }),
    ev('agent_started', 'done1', {}),
    ev('agent_completed', 'done1', { summary: 'All done' }),
  ];
}

/** A tiny scenario: main spawns a planner that starts, reads, and completes. */
export function plannerScenario(): EventEnvelope[] {
  resetSeq();
  return [
    ev('session_started', undefined, { cwd: '/tmp/app', title: 'Fixture run' }),
    ev('workflow_started', undefined, {
      name: 'Fixture',
      kind: 'demo',
      phases: [{ title: 'Plan' }],
    }),
    ev('agent_created', 'planner', {
      name: 'Planner',
      kind: 'subagent',
      agentType: 'planner',
      parentAgentId: 'main',
      phase: 'Plan',
    }),
    ev('dependency_created', undefined, {
      fromAgentId: 'main',
      toAgentId: 'planner',
      kind: 'spawns',
    }),
    ev('agent_started', 'planner', {}),
    ev('agent_tool_called', 'planner', {
      toolCallId: 'tc1',
      tool: 'Read',
      inputSummary: 'src/App.tsx',
    }),
    ev('agent_output', 'planner', { stream: 'message', chunk: 'Scoping the change.\n' }),
  ];
}
