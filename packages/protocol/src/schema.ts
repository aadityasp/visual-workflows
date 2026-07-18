/**
 * Runtime validation (zod v4) applied at the ingestion boundary — the
 * bridge validates everything arriving over HTTP before it reaches the bus.
 * Tolerant-reader rules: unknown event types pass if the envelope is sound;
 * unknown payload fields are preserved.
 */
import { z } from 'zod';
import type { AnyEvent } from './events.js';
import { EVENT_TYPES } from './events.js';

const lifecycle = z.enum([
  'created',
  'running',
  'blocked',
  'awaiting_approval',
  'awaiting_input',
  'failed',
  'completed',
  'cancelled',
]);

const activity = z.enum([
  'idle',
  'waiting',
  'thinking',
  'reading',
  'searching',
  'writing_code',
  'running_command',
  'testing',
  'reviewing',
]);

/**
 * Session/agent/workflow ids are used as plain-object map keys in the
 * reducer, so prototype-polluting property names must never validate.
 */
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const safeId = z
  .string()
  .min(1)
  .refine((s) => !UNSAFE_IDS.has(s), {
    message: 'reserved object property name not allowed as id',
  });

const agentKind = z.enum(['main', 'subagent', 'workflow-agent', 'teammate']);
const depKind = z.enum(['spawns', 'blocks', 'feeds', 'reviews']);
const stream = z.enum(['message', 'thinking', 'stdout', 'stderr']);

const tokenUsage = z.looseObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  contextPct: z.number().optional(),
});

const phaseInfo = z.looseObject({ title: z.string(), detail: z.string().optional() });

/** Payload schema per known event type (loose: extra fields preserved). */
export const PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
  session_started: z.looseObject({
    cwd: z.string().optional(),
    appVersion: z.string().optional(),
    title: z.string().optional(),
  }),
  session_ended: z.looseObject({ reason: z.string().optional() }),
  workflow_started: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    kind: z.enum(['workflow', 'adhoc', 'demo']),
    phases: z.array(phaseInfo).optional(),
  }),
  workflow_completed: z.looseObject({
    status: z.enum(['completed', 'failed', 'cancelled']),
    summary: z.string().optional(),
  }),
  agent_created: z.looseObject({
    name: z.string(),
    kind: agentKind,
    agentType: z.string().optional(),
    parentAgentId: safeId.optional(),
    model: z.string().optional(),
    phase: z.string().optional(),
  }),
  agent_started: z.looseObject({}),
  agent_status_changed: z
    .looseObject({
      lifecycle: lifecycle.optional(),
      activity: activity.optional(),
      reason: z.string().optional(),
      currentAction: z.string().optional(),
    })
    .refine((p) => p.lifecycle !== undefined || p.activity !== undefined, {
      message: 'agent_status_changed requires lifecycle or activity',
    }),
  agent_output: z.looseObject({
    stream,
    chunk: z.string(),
    truncated: z.boolean().optional(),
  }),
  agent_tool_called: z.looseObject({
    toolCallId: z.string(),
    tool: z.string(),
    inputSummary: z.string(),
    detail: z.string().optional(),
  }),
  agent_tool_completed: z.looseObject({
    toolCallId: z.string(),
    ok: z.boolean(),
    durationMs: z.number().optional(),
    resultSummary: z.string().optional(),
  }),
  agent_file_read: z.looseObject({ path: z.string() }),
  agent_file_modified: z.looseObject({
    path: z.string(),
    changeKind: z.enum(['created', 'edited', 'deleted']),
  }),
  agent_command_started: z.looseObject({
    commandId: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    description: z.string().optional(),
  }),
  agent_command_completed: z.looseObject({
    commandId: z.string(),
    ok: z.boolean(),
    exitCode: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  agent_blocked: z.looseObject({
    reason: z.string(),
    kind: z.enum(['permission', 'dependency', 'error', 'user']).optional(),
  }),
  agent_failed: z.looseObject({
    error: z.looseObject({ message: z.string(), kind: z.string().optional() }),
    retryCount: z.number().optional(),
  }),
  agent_completed: z.looseObject({
    summary: z.string().optional(),
    usage: tokenUsage.optional(),
  }),
  agent_retried: z.looseObject({ retryCount: z.number() }),
  token_usage: z.looseObject({ usage: tokenUsage }),
  dependency_created: z.looseObject({
    fromAgentId: safeId,
    toAgentId: safeId,
    kind: depKind,
  }),
  approval_requested: z.looseObject({
    requestId: z.string(),
    kind: z.enum(['permission', 'plan', 'question']),
    prompt: z.string(),
    options: z.array(z.string()).optional(),
  }),
  approval_resolved: z.looseObject({ requestId: z.string(), resolution: z.string() }),
  user_input_requested: z.looseObject({
    requestId: z.string(),
    prompt: z.string().optional(),
  }),
  user_input_provided: z.looseObject({ requestId: z.string() }),
  adapter_notice: z.looseObject({
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
  }),
};

export const envelopeBase = z.looseObject({
  v: z.literal(1),
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.string().min(1),
  source: z.enum(['hook', 'transcript', 'demo', 'replay', 'manual']),
  sessionId: safeId,
  workflowId: safeId.optional(),
  agentId: safeId.optional(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export type ParseResult =
  { ok: true; event: AnyEvent; known: boolean } | { ok: false; error: string };

const KNOWN = new Set<string>(EVENT_TYPES);

/** Validate one incoming event. Unknown types pass with `known: false`. */
export function parseEventEnvelope(input: unknown): ParseResult {
  const base = envelopeBase.safeParse(input);
  if (!base.success) {
    return { ok: false, error: base.error.issues.map((i) => i.message).join('; ') };
  }
  const type = base.data.type;
  if (!KNOWN.has(type)) {
    return { ok: true, event: base.data as unknown as AnyEvent, known: false };
  }
  const payloadSchema = PAYLOAD_SCHEMAS[type];
  if (payloadSchema) {
    const p = payloadSchema.safeParse(base.data.payload);
    if (!p.success) {
      return {
        ok: false,
        error: `${type}: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      };
    }
  }
  return { ok: true, event: base.data as unknown as AnyEvent, known: true };
}
