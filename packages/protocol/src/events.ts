/**
 * Event protocol v1 — the contract between adapters (observers) and
 * consumers (bridge, UI, recorder, replay). See docs/EVENT_PROTOCOL.md.
 *
 * Rules: adapters translate, never infer; consumers tolerate unknown
 * event types and extra fields; payloads arrive already redacted.
 */

export const PROTOCOL_VERSION = 1 as const;

export type EventSource = 'hook' | 'transcript' | 'demo' | 'replay' | 'manual';

export type AgentLifecycle =
  | 'created'
  | 'running'
  | 'blocked'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'failed'
  | 'completed'
  | 'cancelled';

export type AgentActivity =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'writing_code'
  | 'running_command'
  | 'testing'
  | 'reviewing';

export type AgentKind = 'main' | 'subagent' | 'workflow-agent' | 'teammate';

export type DependencyKind = 'spawns' | 'blocks' | 'feeds' | 'reviews';

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  contextPct?: number;
}

export interface PhaseInfo {
  title: string;
  detail?: string;
}

/* ------------------------------ payloads ------------------------------ */

export interface SessionStartedPayload {
  cwd?: string;
  appVersion?: string;
  title?: string;
}

export interface SessionEndedPayload {
  reason?: string;
}

export interface WorkflowStartedPayload {
  name: string;
  description?: string;
  kind: 'workflow' | 'adhoc' | 'demo';
  phases?: PhaseInfo[];
}

export interface WorkflowCompletedPayload {
  status: 'completed' | 'failed' | 'cancelled';
  summary?: string;
}

export interface AgentCreatedPayload {
  name: string;
  kind: AgentKind;
  agentType?: string;
  parentAgentId?: string;
  model?: string;
  phase?: string;
}

export type AgentStartedPayload = Record<string, never>;

export interface AgentStatusChangedPayload {
  lifecycle?: AgentLifecycle;
  activity?: AgentActivity;
  reason?: string;
  currentAction?: string;
}

export interface AgentOutputPayload {
  stream: 'message' | 'thinking' | 'stdout' | 'stderr';
  chunk: string;
  truncated?: boolean;
}

export interface AgentToolCalledPayload {
  toolCallId: string;
  tool: string;
  inputSummary: string;
  detail?: string;
}

export interface AgentToolCompletedPayload {
  toolCallId: string;
  ok: boolean;
  durationMs?: number;
  resultSummary?: string;
}

export interface AgentFileReadPayload {
  path: string;
}

export interface AgentFileModifiedPayload {
  path: string;
  changeKind: 'created' | 'edited' | 'deleted';
}

export interface AgentCommandStartedPayload {
  commandId: string;
  command: string;
  cwd?: string;
  description?: string;
}

export interface AgentCommandCompletedPayload {
  commandId: string;
  ok: boolean;
  exitCode?: number;
  durationMs?: number;
}

export interface AgentBlockedPayload {
  reason: string;
  kind?: 'permission' | 'dependency' | 'error' | 'user';
}

export interface AgentFailedPayload {
  error: { message: string; kind?: string };
  retryCount?: number;
}

export interface AgentCompletedPayload {
  summary?: string;
  usage?: TokenUsage;
}

export interface AgentRetriedPayload {
  retryCount: number;
}

export interface TokenUsagePayload {
  usage: TokenUsage;
}

export interface DependencyCreatedPayload {
  fromAgentId: string;
  toAgentId: string;
  kind: DependencyKind;
}

export interface ApprovalRequestedPayload {
  requestId: string;
  kind: 'permission' | 'plan' | 'question';
  prompt: string;
  options?: string[];
}

export interface ApprovalResolvedPayload {
  requestId: string;
  resolution: string;
}

export interface UserInputRequestedPayload {
  requestId: string;
  prompt?: string;
}

export interface UserInputProvidedPayload {
  requestId: string;
}

export interface AdapterNoticePayload {
  level: 'info' | 'warn' | 'error';
  message: string;
}

/* ------------------------------ envelope ------------------------------ */

export interface EventPayloadMap {
  session_started: SessionStartedPayload;
  session_ended: SessionEndedPayload;
  workflow_started: WorkflowStartedPayload;
  workflow_completed: WorkflowCompletedPayload;
  agent_created: AgentCreatedPayload;
  agent_started: AgentStartedPayload;
  agent_status_changed: AgentStatusChangedPayload;
  agent_output: AgentOutputPayload;
  agent_tool_called: AgentToolCalledPayload;
  agent_tool_completed: AgentToolCompletedPayload;
  agent_file_read: AgentFileReadPayload;
  agent_file_modified: AgentFileModifiedPayload;
  agent_command_started: AgentCommandStartedPayload;
  agent_command_completed: AgentCommandCompletedPayload;
  agent_blocked: AgentBlockedPayload;
  agent_failed: AgentFailedPayload;
  agent_completed: AgentCompletedPayload;
  agent_retried: AgentRetriedPayload;
  token_usage: TokenUsagePayload;
  dependency_created: DependencyCreatedPayload;
  approval_requested: ApprovalRequestedPayload;
  approval_resolved: ApprovalResolvedPayload;
  user_input_requested: UserInputRequestedPayload;
  user_input_provided: UserInputProvidedPayload;
  adapter_notice: AdapterNoticePayload;
}

export type EventType = keyof EventPayloadMap;

export interface EventEnvelope<T extends EventType = EventType> {
  v: typeof PROTOCOL_VERSION;
  /** unique, sortable event id (assigned by the emitting adapter/bridge) */
  id: string;
  /** monotonic per-session order, assigned by the bridge; the reducer's clock */
  seq: number;
  /** ISO-8601 timestamp with ms — display only, adapter clocks may skew */
  ts: string;
  source: EventSource;
  sessionId: string;
  workflowId?: string;
  agentId?: string;
  type: T;
  payload: EventPayloadMap[T];
}

/** Discriminated union over every concrete event type. */
export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

/** The id every session's root agent uses. */
export const MAIN_AGENT_ID = 'main';

export const EVENT_TYPES = [
  'session_started',
  'session_ended',
  'workflow_started',
  'workflow_completed',
  'agent_created',
  'agent_started',
  'agent_status_changed',
  'agent_output',
  'agent_tool_called',
  'agent_tool_completed',
  'agent_file_read',
  'agent_file_modified',
  'agent_command_started',
  'agent_command_completed',
  'agent_blocked',
  'agent_failed',
  'agent_completed',
  'agent_retried',
  'token_usage',
  'dependency_created',
  'approval_requested',
  'approval_resolved',
  'user_input_requested',
  'user_input_provided',
  'adapter_notice',
] as const satisfies readonly EventType[];
