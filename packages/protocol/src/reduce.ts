/**
 * Pure reducer: WorkspaceState = reduce(events). Live view, snapshots,
 * replay, and scrubbing all run through this one function.
 *
 * Tolerant by design: events referencing unknown sessions/agents create
 * stubs; unknown event types are counted and ignored. Deterministic by
 * design: no clocks, no randomness — `seq` is the only ordering authority.
 */
import { produce } from 'immer';
import type { AnyEvent, EventEnvelope } from './events.js';
import { MAIN_AGENT_ID } from './events.js';
import type { AgentState, AttentionItem, SessionState, WorkspaceState } from './state.js';
import { createWorkspace, LIMITS } from './state.js';
import { activityForTool, streamingActivity } from './infer.js';

export function reduce(state: WorkspaceState, event: EventEnvelope): WorkspaceState {
  return produce(state, (draft) => {
    applyEvent(draft, event as AnyEvent);
  });
}

export function reduceAll(state: WorkspaceState, events: EventEnvelope[]): WorkspaceState {
  return produce(state, (draft) => {
    for (const e of events) applyEvent(draft, e as AnyEvent);
  });
}

export function replayToSeq(events: EventEnvelope[], seq: number): WorkspaceState {
  return reduceAll(
    createWorkspace(),
    events.filter((e) => e.seq <= seq),
  );
}

/* ----------------------------- internals ------------------------------ */

function ensureSession(draft: WorkspaceState, e: AnyEvent): SessionState {
  let s = draft.sessions[e.sessionId];
  if (!s) {
    s = {
      id: e.sessionId,
      source: e.source,
      active: true,
      agents: {},
      agentOrder: [],
      workflows: {},
      deps: {},
      attention: [],
      lastSeq: 0,
      eventCount: 0,
    };
    draft.sessions[e.sessionId] = s;
    draft.sessionOrder.push(e.sessionId);
  }
  return s;
}

function ensureAgent(s: SessionState, e: AnyEvent, agentId?: string): AgentState {
  const id = agentId ?? e.agentId ?? MAIN_AGENT_ID;
  let a = s.agents[id];
  if (!a) {
    a = {
      id,
      sessionId: s.id,
      workflowId: e.workflowId,
      childIds: [],
      name: id === MAIN_AGENT_ID ? 'Main agent' : id,
      kind: id === MAIN_AGENT_ID ? 'main' : 'subagent',
      lifecycle: 'created',
      activity: 'idle',
      createdTs: e.ts,
      lastEventTs: e.ts,
      outputTail: [],
      outputTotal: 0,
      filesRead: [],
      filesModified: [],
      toolCalls: [],
      toolCallCount: 0,
      activeToolCallIds: [],
      commands: [],
      commandCount: 0,
      retryCount: 0,
    };
    s.agents[id] = a;
    s.agentOrder.push(id);
  }
  return a;
}

const TERMINAL: ReadonlySet<AgentState['lifecycle']> = new Set([
  'failed',
  'completed',
  'cancelled',
]);

function wake(a: AgentState, e: AnyEvent): void {
  a.lastEventTs = e.ts;
  if (a.lifecycle === 'created') {
    a.lifecycle = 'running';
    a.startedTs ??= e.ts;
  }
}

function pushCapped<T>(arr: T[], item: T, cap: number): void {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function addAttention(s: SessionState, item: AttentionItem): void {
  pushCapped(s.attention, item, LIMITS.attention);
}

function resolveAttention(s: SessionState, match: (item: AttentionItem) => boolean): void {
  for (const item of s.attention) {
    if (!item.resolved && match(item)) item.resolved = true;
  }
}

function applyEvent(draft: WorkspaceState, e: AnyEvent): void {
  const s = ensureSession(draft, e);
  if (e.seq <= s.lastSeq && s.eventCount > 0) return; // duplicate / replayed
  s.lastSeq = e.seq;
  s.eventCount += 1;

  switch (e.type) {
    case 'session_started': {
      s.startedTs = e.ts;
      s.active = true;
      s.cwd = e.payload.cwd ?? s.cwd;
      s.appVersion = e.payload.appVersion ?? s.appVersion;
      s.title = e.payload.title ?? s.title;
      ensureAgent(s, e, MAIN_AGENT_ID);
      break;
    }
    case 'session_ended': {
      s.endedTs = e.ts;
      s.active = false;
      for (const a of Object.values(s.agents)) {
        if (!TERMINAL.has(a.lifecycle)) {
          a.lifecycle = a.lifecycle === 'failed' ? 'failed' : 'completed';
          a.endedTs ??= e.ts;
          a.activity = 'idle';
        }
      }
      break;
    }
    case 'workflow_started': {
      const id = e.workflowId ?? `wfx-${e.seq}`;
      const existing = s.workflows[id];
      if (existing) {
        // Duplicate start: merge details, never reset agentIds/startedTs/status.
        existing.name = e.payload.name || existing.name;
        if (e.payload.description !== undefined) existing.description = e.payload.description;
        if (e.payload.phases) existing.phases = e.payload.phases.map((p) => ({ ...p }));
        break;
      }
      s.workflows[id] = {
        id,
        name: e.payload.name,
        description: e.payload.description,
        kind: e.payload.kind,
        // Clone: never adopt the caller's payload objects into (auto-frozen) state.
        phases: (e.payload.phases ?? []).map((p) => ({ ...p })),
        status: 'running',
        startedTs: e.ts,
        agentIds: [],
      };
      break;
    }
    case 'workflow_completed': {
      const wf = e.workflowId ? s.workflows[e.workflowId] : undefined;
      if (wf) {
        wf.status = e.payload.status;
        wf.endedTs = e.ts;
        wf.summary = e.payload.summary;
      }
      break;
    }
    case 'agent_created': {
      const a = ensureAgent(s, e);
      a.name = e.payload.name || a.name;
      a.kind = e.payload.kind;
      a.agentType = e.payload.agentType ?? a.agentType;
      a.model = e.payload.model ?? a.model;
      a.phase = e.payload.phase ?? a.phase;
      a.createdTs = e.ts;
      a.lastEventTs = e.ts;
      if (e.payload.parentAgentId) {
        a.parentAgentId = e.payload.parentAgentId;
        const parent = ensureAgent(s, e, e.payload.parentAgentId);
        if (!parent.childIds.includes(a.id)) parent.childIds.push(a.id);
      }
      if (e.workflowId) {
        a.workflowId = e.workflowId;
        const wf = s.workflows[e.workflowId];
        if (wf && !wf.agentIds.includes(a.id)) wf.agentIds.push(a.id);
      }
      break;
    }
    case 'agent_started': {
      const a = ensureAgent(s, e);
      a.lastEventTs = e.ts;
      if (TERMINAL.has(a.lifecycle)) break; // late event: never revive a finished agent
      a.lifecycle = 'running';
      a.startedTs = e.ts;
      if (a.activity === 'idle') a.activity = streamingActivity(a.name, a.agentType);
      break;
    }
    case 'agent_status_changed': {
      const a = ensureAgent(s, e);
      a.lastEventTs = e.ts;
      if (e.payload.lifecycle && !TERMINAL.has(a.lifecycle)) {
        const wasInterrupted = a.lifecycle !== 'running';
        a.lifecycle = e.payload.lifecycle;
        if (TERMINAL.has(e.payload.lifecycle)) {
          a.endedTs ??= e.ts;
          a.activity = 'idle';
        }
        // An implicit unblock/grant (→running from blocked/awaiting) ends the
        // interruption: clear the agent's stale attention cards + blocked state
        // so the rail doesn't keep pointing at a recovered agent.
        if (e.payload.lifecycle === 'running' && wasInterrupted) {
          a.blocked = undefined;
          resolveAttention(s, (i) => i.agentId === a.id);
        }
      }
      if (e.payload.activity) a.activity = e.payload.activity;
      if (e.payload.currentAction !== undefined) a.currentAction = e.payload.currentAction;
      break;
    }
    case 'agent_output': {
      const a = ensureAgent(s, e);
      wake(a, e);
      pushCapped(
        a.outputTail,
        { stream: e.payload.stream, text: e.payload.chunk, ts: e.ts, seq: e.seq },
        LIMITS.outputTail,
      );
      a.outputTotal += 1;
      if (a.activeToolCallIds.length === 0 && !TERMINAL.has(a.lifecycle)) {
        a.activity = streamingActivity(a.name, a.agentType);
      }
      break;
    }
    case 'agent_tool_called': {
      const a = ensureAgent(s, e);
      wake(a, e);
      // Idempotent on toolCallId: hooks and the transcript tailer may both
      // report the same call (same toolu_ id) — merge, never duplicate.
      const existing = a.toolCalls.find((t) => t.id === e.payload.toolCallId);
      if (existing) {
        existing.inputSummary = e.payload.inputSummary || existing.inputSummary;
        existing.detail = e.payload.detail ?? existing.detail;
        break;
      }
      pushCapped(
        a.toolCalls,
        {
          id: e.payload.toolCallId,
          tool: e.payload.tool,
          inputSummary: e.payload.inputSummary,
          detail: e.payload.detail,
          startedTs: e.ts,
          completed: false,
        },
        LIMITS.toolCalls,
      );
      a.toolCallCount += 1;
      if (!a.activeToolCallIds.includes(e.payload.toolCallId)) {
        a.activeToolCallIds.push(e.payload.toolCallId);
      }
      if (!TERMINAL.has(a.lifecycle)) {
        a.activity = activityForTool(e.payload.tool, e.payload.inputSummary);
        a.currentAction = `${e.payload.tool}: ${e.payload.inputSummary}`;
      }
      break;
    }
    case 'agent_tool_completed': {
      const a = ensureAgent(s, e);
      wake(a, e);
      const call = a.toolCalls.find((t) => t.id === e.payload.toolCallId);
      if (call) {
        call.completed = true;
        call.ok = e.payload.ok;
        call.durationMs = e.payload.durationMs;
        call.resultSummary = e.payload.resultSummary;
      }
      a.activeToolCallIds = a.activeToolCallIds.filter((id) => id !== e.payload.toolCallId);
      if (a.activeToolCallIds.length === 0 && !TERMINAL.has(a.lifecycle)) {
        a.activity = streamingActivity(a.name, a.agentType);
        a.currentAction = undefined;
      }
      break;
    }
    case 'agent_file_read': {
      const a = ensureAgent(s, e);
      wake(a, e);
      if (!a.filesRead.includes(e.payload.path)) {
        pushCapped(a.filesRead, e.payload.path, LIMITS.filesRead);
      }
      break;
    }
    case 'agent_file_modified': {
      const a = ensureAgent(s, e);
      wake(a, e);
      pushCapped(
        a.filesModified,
        { path: e.payload.path, changeKind: e.payload.changeKind },
        LIMITS.filesModified,
      );
      break;
    }
    case 'agent_command_started': {
      const a = ensureAgent(s, e);
      wake(a, e);
      if (a.commands.some((c) => c.id === e.payload.commandId)) break; // dual-source dedupe
      pushCapped(
        a.commands,
        {
          id: e.payload.commandId,
          command: e.payload.command,
          description: e.payload.description,
          startedTs: e.ts,
          completed: false,
        },
        LIMITS.commands,
      );
      a.commandCount += 1;
      break;
    }
    case 'agent_command_completed': {
      const a = ensureAgent(s, e);
      wake(a, e);
      const cmd = a.commands.find((c) => c.id === e.payload.commandId);
      if (cmd) {
        cmd.completed = true;
        cmd.ok = e.payload.ok;
        cmd.exitCode = e.payload.exitCode;
        cmd.durationMs = e.payload.durationMs;
      }
      break;
    }
    case 'agent_blocked': {
      const a = ensureAgent(s, e);
      a.lastEventTs = e.ts;
      a.lifecycle = 'blocked';
      a.blocked = { reason: e.payload.reason, kind: e.payload.kind };
      addAttention(s, {
        id: `att-${e.seq}`,
        kind: 'blocker',
        sessionId: s.id,
        agentId: a.id,
        message: e.payload.reason,
        ts: e.ts,
        resolved: false,
      });
      break;
    }
    case 'agent_failed': {
      const a = ensureAgent(s, e);
      a.lastEventTs = e.ts;
      a.lifecycle = 'failed';
      a.activity = 'idle';
      a.endedTs ??= e.ts;
      a.error = { ...e.payload.error };
      if (e.payload.retryCount !== undefined) a.retryCount = e.payload.retryCount;
      addAttention(s, {
        id: `att-${e.seq}`,
        kind: 'failure',
        sessionId: s.id,
        agentId: a.id,
        message: e.payload.error.message,
        ts: e.ts,
        resolved: false,
      });
      break;
    }
    case 'agent_completed': {
      const a = ensureAgent(s, e);
      a.lastEventTs = e.ts;
      // A failed agent stays failed: a later/duplicate completion still
      // enriches the record (summary/usage/end time) but never downgrades the
      // terminal outcome to 'completed'. Mirrors session_ended, which encodes
      // the same `failed ? 'failed' : 'completed'` intent.
      if (a.lifecycle !== 'failed') {
        a.lifecycle = 'completed';
        a.activity = 'idle';
      }
      a.endedTs = e.ts;
      a.summary = e.payload.summary ?? a.summary;
      if (e.payload.usage) a.usage = { ...a.usage, ...e.payload.usage };
      a.blocked = undefined;
      a.currentAction = undefined;
      resolveAttention(s, (i) => i.agentId === a.id);
      break;
    }
    case 'agent_retried': {
      const a = ensureAgent(s, e);
      wake(a, e);
      a.retryCount = e.payload.retryCount;
      if (a.lifecycle === 'failed' || a.lifecycle === 'blocked') {
        a.lifecycle = 'running';
        a.error = undefined;
        a.blocked = undefined;
      }
      // A retry ends the interruption: resolve this agent's stale blocker/
      // failure cards so the attention rail doesn't flag a recovered agent.
      resolveAttention(s, (i) => i.agentId === a.id);
      break;
    }
    case 'token_usage': {
      const a = ensureAgent(s, e);
      a.lastEventTs = e.ts;
      a.usage = { ...a.usage, ...e.payload.usage };
      break;
    }
    case 'dependency_created': {
      // JSON delimiter — plain '-' joins collide for hyphenated agent ids.
      const id = `dep:${JSON.stringify([e.payload.fromAgentId, e.payload.toAgentId, e.payload.kind])}`;
      if (!s.deps[id]) {
        s.deps[id] = {
          id,
          fromAgentId: e.payload.fromAgentId,
          toAgentId: e.payload.toAgentId,
          kind: e.payload.kind,
        };
        if (e.payload.kind === 'spawns') {
          const child = ensureAgent(s, e, e.payload.toAgentId);
          const parent = ensureAgent(s, e, e.payload.fromAgentId);
          child.parentAgentId ??= parent.id;
          if (!parent.childIds.includes(child.id)) parent.childIds.push(child.id);
        }
      }
      break;
    }
    case 'approval_requested': {
      const a = e.agentId ? ensureAgent(s, e) : undefined;
      if (a) {
        a.lifecycle = 'awaiting_approval';
        a.lastEventTs = e.ts;
      }
      addAttention(s, {
        id: `att-${e.seq}`,
        kind: 'approval',
        sessionId: s.id,
        agentId: a?.id,
        requestId: e.payload.requestId,
        message: e.payload.prompt,
        options: e.payload.options?.slice(),
        ts: e.ts,
        resolved: false,
      });
      break;
    }
    case 'approval_resolved': {
      resolveAttention(s, (i) => i.requestId === e.payload.requestId);
      const a = e.agentId ? s.agents[e.agentId] : undefined;
      if (a && a.lifecycle === 'awaiting_approval') a.lifecycle = 'running';
      break;
    }
    case 'user_input_requested': {
      const a = e.agentId ? ensureAgent(s, e) : undefined;
      if (a) {
        a.lifecycle = 'awaiting_input';
        a.lastEventTs = e.ts;
      }
      addAttention(s, {
        id: `att-${e.seq}`,
        kind: 'input',
        sessionId: s.id,
        agentId: a?.id,
        requestId: e.payload.requestId,
        message: e.payload.prompt ?? 'Input requested',
        ts: e.ts,
        resolved: false,
      });
      break;
    }
    case 'user_input_provided': {
      resolveAttention(s, (i) => i.requestId === e.payload.requestId);
      const a = e.agentId ? s.agents[e.agentId] : undefined;
      if (a && a.lifecycle === 'awaiting_input') a.lifecycle = 'running';
      break;
    }
    case 'adapter_notice':
      break; // surfaced via the event stream itself, not state
    default: {
      // Tolerant reader: unknown event types are ignored (already counted).
      break;
    }
  }
}
