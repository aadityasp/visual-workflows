/**
 * WorkspaceState — the pure-reducer output consumed by the UI and
 * snapshotted by the bridge. Not a public wire contract (events are);
 * shape may evolve within a minor version.
 */
import type {
  AgentActivity,
  AgentKind,
  AgentLifecycle,
  DependencyKind,
  EventSource,
  PhaseInfo,
  TokenUsage,
} from './events.js';

export interface OutputChunk {
  stream: 'message' | 'thinking' | 'stdout' | 'stderr';
  text: string;
  ts: string;
  seq: number;
}

export interface ToolCallInfo {
  id: string;
  tool: string;
  inputSummary: string;
  detail?: string;
  startedTs: string;
  completed: boolean;
  ok?: boolean;
  durationMs?: number;
  resultSummary?: string;
}

export interface CommandInfo {
  id: string;
  command: string;
  description?: string;
  startedTs: string;
  completed: boolean;
  ok?: boolean;
  exitCode?: number;
  durationMs?: number;
}

export interface FileTouch {
  path: string;
  changeKind: 'created' | 'edited' | 'deleted';
}

export interface AgentState {
  id: string;
  sessionId: string;
  workflowId?: string;
  parentAgentId?: string;
  childIds: string[];
  name: string;
  kind: AgentKind;
  agentType?: string;
  model?: string;
  phase?: string;
  lifecycle: AgentLifecycle;
  activity: AgentActivity;
  currentAction?: string;
  createdTs: string;
  startedTs?: string;
  endedTs?: string;
  lastEventTs: string;
  outputTail: OutputChunk[];
  outputTotal: number;
  filesRead: string[];
  filesModified: FileTouch[];
  toolCalls: ToolCallInfo[];
  toolCallCount: number;
  activeToolCallIds: string[];
  commands: CommandInfo[];
  commandCount: number;
  retryCount: number;
  usage?: TokenUsage;
  summary?: string;
  error?: { message: string; kind?: string };
  blocked?: { reason: string; kind?: string };
}

export interface DependencyState {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  kind: DependencyKind;
}

export type AttentionKind = 'approval' | 'blocker' | 'failure' | 'input';

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  sessionId: string;
  agentId?: string;
  requestId?: string;
  message: string;
  options?: string[];
  ts: string;
  resolved: boolean;
}

export interface WorkflowState {
  id: string;
  name: string;
  description?: string;
  kind: 'workflow' | 'adhoc' | 'demo';
  phases: PhaseInfo[];
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedTs: string;
  endedTs?: string;
  agentIds: string[];
  summary?: string;
}

export interface SessionState {
  id: string;
  source: EventSource;
  title?: string;
  cwd?: string;
  appVersion?: string;
  startedTs?: string;
  endedTs?: string;
  active: boolean;
  agents: Record<string, AgentState>;
  agentOrder: string[];
  workflows: Record<string, WorkflowState>;
  deps: Record<string, DependencyState>;
  attention: AttentionItem[];
  lastSeq: number;
  eventCount: number;
}

export interface WorkspaceState {
  sessions: Record<string, SessionState>;
  sessionOrder: string[];
}

/** Bounded-memory caps applied by the reducer. */
export const LIMITS = {
  outputTail: 1000,
  toolCalls: 100,
  commands: 60,
  filesRead: 300,
  filesModified: 300,
  attention: 100,
} as const;

export function createWorkspace(): WorkspaceState {
  return { sessions: {}, sessionOrder: [] };
}
