/**
 * Claude Code hook payload mapper — translates the VERIFIED v2.1.212 hook
 * payloads (docs/discovery/liveHooks.md, docs/ADAPTERS.md section A) into
 * protocol events. The server's POST /ingest/hooks route delegates here.
 *
 * Contract (do not change signature): raw hook JSON in, protocol events out.
 * Rules: adapters translate, never infer; every free-text field is redacted
 * before it leaves this function; unknown hook events map to adapter_notice
 * so newer Claude Code versions degrade gracefully.
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentCompletedPayload,
  ApprovalRequestedPayload,
  SessionStartedPayload,
} from '@visual-workflows/protocol';
import {
  MAIN_AGENT_ID,
  redactText,
  summarizeToolInput,
  truncate,
} from '@visual-workflows/protocol';
import type { EventInit } from '../types.js';
import { makeEvent } from '../types.js';
import { sniffAgentRole } from '../claude-roles.js';

/** Claude Code version these mappings were empirically verified against. */
export const VERIFIED_AGAINST = '2.1.212';

type Raw = Record<string, unknown>;

function asObj(v: unknown): Raw | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Redact + truncate free text. Fail-closed: on redaction error, drop it. */
function clean(s: string, max = 2000): string {
  try {
    return truncate(redactText(s).text, max);
  } catch {
    return '';
  }
}

/** Extract `<name>…</name>` from the task-notification XML block. */
function xmlTag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m?.[1]?.trim();
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export function mapHookPayload(raw: unknown): EventInit[] {
  const r = asObj(raw);
  if (!r) return [];
  const sessionId = asStr(r.session_id);
  const hook = asStr(r.hook_event_name);
  if (!sessionId || !hook) return [];

  const ts = new Date().toISOString();
  const base = { ts, source: 'hook' as const, sessionId };
  // agent_id/agent_type are present on tool events fired inside a subagent
  // (verified) — their absence means "this is the main agent".
  const agentId = asStr(r.agent_id) ?? MAIN_AGENT_ID;
  const events: EventInit[] = [];

  switch (hook) {
    case 'SessionStart': {
      // Extra `source` field ("startup" | "resume" | ...) rides along as a
      // loose payload field — the schema preserves unknown keys.
      events.push(
        makeEvent('session_started', { ...base }, {
          cwd: asStr(r.cwd),
          source: asStr(r.source),
        } as SessionStartedPayload),
      );
      break;
    }

    case 'UserPromptSubmit': {
      const prompt = asStr(r.prompt) ?? '';
      // Only a prompt that IS a task-notification block counts — a user
      // merely mentioning the tag mid-prompt is ordinary input.
      if (prompt.trimStart().startsWith('<task-notification>')) {
        // ⚠ Verified synthetic re-entry: subagent completion re-enters the
        // parent as a UserPromptSubmit carrying a task-notification XML
        // block. This is agent completion, NOT user input.
        const taskId = xmlTag(prompt, 'task-id');
        const status = xmlTag(prompt, 'status');
        const result = xmlTag(prompt, 'result');
        const tokens = Number(xmlTag(prompt, 'subagent_tokens'));
        if (taskId && (status === undefined || status === 'completed')) {
          events.push(
            makeEvent('agent_completed', { ...base, agentId: taskId }, {
              summary: result ? clean(result, 500) : undefined,
              // totalTokens is a loose extra field: the notification reports
              // one aggregate count, which maps to no specific TokenUsage
              // bucket — preserved without overclaiming.
              ...(Number.isFinite(tokens) && tokens > 0 ? { usage: { totalTokens: tokens } } : {}),
            } as AgentCompletedPayload),
          );
        } else {
          events.push(
            makeEvent(
              'adapter_notice',
              { ...base },
              {
                level: 'info',
                message: `task-notification for ${taskId ? clean(taskId, 100) : 'unknown task'} with status ${status ? clean(status, 100) : 'unknown'}`,
              },
            ),
          );
        }
      } else {
        // User prompts are user input — never echoed into the event stream.
        // The main agent starts working on it.
        events.push(
          makeEvent(
            'agent_status_changed',
            { ...base, agentId: MAIN_AGENT_ID },
            {
              activity: 'thinking',
              currentAction: 'Responding to prompt',
              reason: 'user_prompt',
            },
          ),
        );
      }
      break;
    }

    case 'PreToolUse': {
      const tool = asStr(r.tool_name) ?? 'unknown';
      const toolUseId = asStr(r.tool_use_id) ?? `pre-${randomUUID()}`;
      const input = asObj(r.tool_input);
      events.push(
        makeEvent(
          'agent_tool_called',
          { ...base, agentId },
          {
            toolCallId: toolUseId,
            tool,
            inputSummary: clean(summarizeToolInput(tool, r.tool_input), 200),
          },
        ),
      );
      if (tool === 'Bash') {
        const command = asStr(input?.command);
        if (command) {
          const description = asStr(input?.description);
          events.push(
            makeEvent(
              'agent_command_started',
              { ...base, agentId },
              {
                commandId: toolUseId,
                command: clean(command),
                cwd: asStr(r.cwd),
                description: description ? clean(description, 200) : undefined,
              },
            ),
          );
        }
      } else if (tool === 'Read') {
        const filePath = asStr(input?.file_path);
        if (filePath) {
          events.push(makeEvent('agent_file_read', { ...base, agentId }, { path: filePath }));
        }
      }
      // Agent/Task PreToolUse: nothing extra — the spawn is only real once
      // PostToolUse confirms async_launched (verified: launch is async).
      break;
    }

    case 'PostToolUse': {
      const tool = asStr(r.tool_name) ?? 'unknown';
      const toolUseId = asStr(r.tool_use_id) ?? `post-${randomUUID()}`;
      const input = asObj(r.tool_input);
      const resp = asObj(r.tool_response);
      const durationMs = asNum(r.duration_ms);
      // If a PermissionRequest was raised for this tool_use_id, the tool
      // proceeding means it was answered — clear the approval so the agent
      // never strands in awaiting_approval. The reducer no-ops when no
      // matching request exists, so this is safe unconditionally.
      events.push(
        makeEvent(
          'approval_resolved',
          { ...base, agentId },
          {
            requestId: toolUseId,
            resolution: 'answered',
          },
        ),
      );
      events.push(
        makeEvent(
          'agent_tool_completed',
          { ...base, agentId },
          {
            toolCallId: toolUseId,
            ok: true,
            durationMs,
          },
        ),
      );
      if (tool === 'Bash') {
        events.push(
          makeEvent(
            'agent_command_completed',
            { ...base, agentId },
            {
              commandId: toolUseId,
              ok: resp?.interrupted !== true,
              durationMs,
            },
          ),
        );
      } else if (WRITE_TOOLS.has(tool)) {
        const filePath = asStr(input?.file_path);
        if (filePath) {
          events.push(
            makeEvent(
              'agent_file_modified',
              { ...base, agentId },
              {
                path: filePath,
                changeKind: 'edited',
              },
            ),
          );
        }
      } else if (
        // ⚠ The Task tool reports tool_name "Agent" in v2.1.212 hook
        // payloads; match both defensively (verified).
        (tool === 'Agent' || tool === 'Task') &&
        resp?.status === 'async_launched'
      ) {
        // Verified: subagents launch async — PostToolUse(Agent) fires ~17ms
        // after Pre with the new agent's identity. This is agent CREATION,
        // never completion (SubagentStop / task-notification own that).
        const newAgentId = asStr(resp.agentId);
        if (newAgentId) {
          const description = asStr(resp.description) ?? asStr(input?.description);
          events.push(
            makeEvent(
              'agent_created',
              { ...base, agentId: newAgentId },
              {
                name: description ? clean(description, 120) : newAgentId,
                kind: 'subagent',
                agentType: sniffAgentRole(asStr(input?.subagent_type), asStr(input?.prompt)),
                model: asStr(resp.resolvedModel),
                parentAgentId: agentId,
              },
            ),
          );
          events.push(makeEvent('agent_started', { ...base, agentId: newAgentId }, {}));
          events.push(
            makeEvent(
              'dependency_created',
              { ...base },
              {
                fromAgentId: agentId,
                toAgentId: newAgentId,
                kind: 'spawns',
              },
            ),
          );
        }
      }
      break;
    }

    case 'PostToolUseFailure': {
      // Tool failure ≠ agent failure: agents routinely recover from failed
      // tool calls. Report the tool result only.
      const tool = asStr(r.tool_name) ?? 'unknown';
      const toolUseId = asStr(r.tool_use_id) ?? `postfail-${randomUUID()}`;
      const resp = r.tool_response;
      const message =
        asStr(resp) ?? asStr(asObj(resp)?.error) ?? asStr(asObj(resp)?.message) ?? asStr(r.error);
      // Same as PostToolUse: a failed tool still ran, so any pending
      // PermissionRequest for this tool_use_id was answered.
      events.push(
        makeEvent(
          'approval_resolved',
          { ...base, agentId },
          {
            requestId: toolUseId,
            resolution: 'answered',
          },
        ),
      );
      events.push(
        makeEvent(
          'agent_tool_completed',
          { ...base, agentId },
          {
            toolCallId: toolUseId,
            ok: false,
            durationMs: asNum(r.duration_ms),
            resultSummary: message ? clean(message, 300) : undefined,
          },
        ),
      );
      if (tool === 'Bash') {
        events.push(
          makeEvent(
            'agent_command_completed',
            { ...base, agentId },
            {
              commandId: toolUseId,
              ok: false,
              durationMs: asNum(r.duration_ms),
            },
          ),
        );
      }
      break;
    }

    case 'SubagentStart': {
      const subId = asStr(r.agent_id);
      if (!subId) break;
      // Defensive creation: the PostToolUse(async_launched) spawn event may
      // not have been seen (hooks can race / drop). name '' never clobbers a
      // richer name — the reducer keeps the existing name on empty. No
      // parentAgentId and no dependency_created here: SubagentStart does not
      // know the true parent, and guessing 'main' would re-parent nested
      // subagents and duplicate the spawn edge already emitted by the
      // async_launched PostToolUse mapping.
      events.push(
        makeEvent(
          'agent_created',
          { ...base, agentId: subId },
          {
            name: '',
            kind: 'subagent',
            agentType: asStr(r.agent_type),
          },
        ),
      );
      events.push(makeEvent('agent_started', { ...base, agentId: subId }, {}));
      break;
    }

    case 'SubagentStop': {
      const subId = asStr(r.agent_id);
      if (!subId) break;
      const last = asStr(r.last_assistant_message);
      events.push(
        makeEvent(
          'agent_completed',
          { ...base, agentId: subId },
          {
            summary: last ? clean(last, 500) : undefined,
          },
        ),
      );
      break;
    }

    case 'Stop': {
      // Verified: parent Stop fires while subagents are still running, with
      // the live children listed in background_tasks — that is a paused
      // turn, NOT completion.
      const bg = Array.isArray(r.background_tasks) ? r.background_tasks : [];
      if (bg.length > 0) {
        events.push(
          makeEvent(
            'agent_status_changed',
            { ...base, agentId: MAIN_AGENT_ID },
            {
              activity: 'waiting',
              currentAction: `${bg.length} background ${bg.length === 1 ? 'task' : 'tasks'} running`,
            },
          ),
        );
      } else {
        events.push(
          makeEvent(
            'agent_status_changed',
            { ...base, agentId: MAIN_AGENT_ID },
            {
              activity: 'idle',
              currentAction: '',
            },
          ),
        );
      }
      break;
    }

    case 'SessionEnd': {
      events.push(makeEvent('session_ended', { ...base }, { reason: asStr(r.reason) }));
      break;
    }

    case 'PermissionRequest': {
      // ⚠ Docs-only event — never observed firing in the verification runs.
      // Best-effort payload extraction, marked experimental via a loose
      // `detail` field.
      const tool = asStr(r.tool_name);
      const message = asStr(r.message) ?? asStr(r.prompt);
      const prompt = message
        ? clean(message, 500)
        : tool
          ? `Permission requested: ${tool}`
          : 'Permission requested';
      events.push(
        makeEvent('approval_requested', { ...base, agentId }, {
          requestId: asStr(r.tool_use_id) ?? `perm-${randomUUID()}`,
          kind: 'permission',
          prompt,
          detail: 'experimental',
        } as ApprovalRequestedPayload),
      );
      break;
    }

    case 'Notification': {
      const message = asStr(r.message) ?? asStr(r.title) ?? 'Notification';
      events.push(
        makeEvent('adapter_notice', { ...base }, { level: 'info', message: clean(message, 500) }),
      );
      break;
    }

    default: {
      // Forward-compatible: newer Claude Code hook events surface as notices
      // instead of being dropped on the floor.
      events.push(
        makeEvent(
          'adapter_notice',
          { ...base },
          {
            level: 'info',
            message: `unmapped hook event: ${clean(hook, 100)}`,
          },
        ),
      );
      break;
    }
  }

  return events;
}
