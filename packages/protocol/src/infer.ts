/**
 * Activity inference — the ONE place tool names become visible activity
 * states. Adapters report facts; this module interprets them.
 */
import type { AgentActivity } from './events.js';

const TEST_COMMAND_RE =
  /\b(vitest|jest|pytest|playwright|mocha|tape|ava|rspec|phpunit|tox)\b|\bgo test\b|\bcargo (test|nextest)\b|\bnpm (test|t)\b|\bnpx (vitest|jest|playwright)\b|\byarn test\b|\bpnpm test\b|\bmake test\b/i;

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch', 'LSP']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const DELEGATE_TOOLS = new Set(['Task', 'Agent', 'Workflow']);

/** Map a tool call to the activity it implies. */
export function activityForTool(tool: string, inputSummary = ''): AgentActivity {
  if (READ_TOOLS.has(tool)) return 'reading';
  if (SEARCH_TOOLS.has(tool)) return 'searching';
  if (WRITE_TOOLS.has(tool)) return 'writing_code';
  if (DELEGATE_TOOLS.has(tool)) return 'waiting';
  if (tool === 'Bash' || tool === 'BashOutput') {
    return TEST_COMMAND_RE.test(inputSummary) ? 'testing' : 'running_command';
  }
  return 'thinking';
}

const REVIEWER_RE = /\breview|verif|check|audit|inspect|critic|judge\b/i;

/** Agents whose role is reviewing show 'reviewing' instead of 'thinking'. */
export function isReviewerRole(name?: string, agentType?: string): boolean {
  return REVIEWER_RE.test(name ?? '') || REVIEWER_RE.test(agentType ?? '');
}

/** Default streaming activity for an agent with no active tool. */
export function streamingActivity(name?: string, agentType?: string): AgentActivity {
  return isReviewerRole(name, agentType) ? 'reviewing' : 'thinking';
}

/** One-line human summary of a tool input, for adapters building events. */
export function summarizeToolInput(tool: string, input: unknown): string {
  if (input == null) return tool;
  if (typeof input === 'string') return truncate(input, 160);
  if (typeof input !== 'object') return String(input);
  const o = input as Record<string, unknown>;
  const pick =
    firstString(o, ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) ??
    firstString(o, ['prompt', 'skill', 'subject']);
  return pick ? truncate(pick, 160) : tool;
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
