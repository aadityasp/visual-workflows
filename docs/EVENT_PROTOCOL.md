# Event Protocol Specification (v1 draft)

Status: DRAFT — adapter mapping tables to be finalized after discovery probes.
This document defines the wire protocol and recording format. It is the contract
between adapters (things that observe work) and consumers (UI, recorder, replay).

## Design principles

1. **Adapters are dumb, consumers are smart.** Adapters translate what they can
   observe into events; they never guess. Inference (e.g. deriving "testing"
   from a `npm test` command) happens in the state engine, in one place.
2. **Append-only, replayable.** UI state is a pure function of the ordered event
   list: `state = reduce(events)`. A recording is just the event list. Replay,
   scrubbing, and live view all use the same reducer.
3. **Tolerant reader.** Consumers MUST ignore unknown event types and unknown
   fields. Protocol changes are additive within a major version.
4. **Redact at the source.** Secret scrubbing happens in the adapter before an
   event enters the bus. Consumers may assume payloads are already scrubbed.
5. **Truth labeling.** Every event carries `source` so the UI can distinguish
   observed facts (hooks/transcripts) from simulated data (demo) — no mock data
   masquerading as real.

## Envelope

Every event shares one envelope shape:

```ts
interface EventEnvelope<T extends EventType = EventType> {
  v: 1; // protocol major version
  id: string; // unique event id (ulid-style, sortable)
  seq: number; // monotonic per session stream, assigned by the bridge
  ts: string; // ISO 8601 with ms, adapter clock
  source: EventSource; // 'hook' | 'transcript' | 'demo' | 'replay' | 'manual'
  sessionId: string; // observed Claude Code session (or demo session)
  workflowId?: string; // present when the event belongs to a workflow
  agentId?: string; // present when the event belongs to an agent
  type: T;
  payload: PayloadFor<T>;
}
```

Identifier conventions:

| Id             | Form                                                           | Assigned by  |
| -------------- | -------------------------------------------------------------- | ------------ |
| `sessionId`    | observed session UUID or `demo-<slug>`                         | adapter      |
| `workflowId`   | observed id (e.g. `wf_*`) or synthesized `wfx-<ulid>`          | adapter      |
| `agentId`      | stable per agent panel; `main` for the root agent of a session | adapter      |
| `toolCallId`   | observed `tool_use` id when available, else synthesized        | adapter      |
| `commandId`    | synthesized per shell command                                  | adapter      |
| `terminalId`   | 1:1 with `agentId` in v1 (each agent owns one terminal)        | state engine |
| `dependencyId` | `dep-<from>-<to>-<kind>`                                       | state engine |
| `requestId`    | approval / input request correlation                           | adapter      |
| `id` / `seq`   | event identity + total order                                   | bridge       |

`seq` is the total order used by the reducer and replay scrubber. `ts` is
display-only (adapter clocks may skew).

## Entity model

```
Session ─┬─ Workflow* ─┬─ Agent* (tree via parentAgentId)
         │             └─ Dependency* (edges between agents)
         └─ Agent "main" (always exists once observed)
Agent ─── ToolCall* ── Command* ── FileTouch* ── OutputChunk*
```

- The **main agent** is modeled as an agent (`agentId: "main"`, `kind: "main"`),
  so the UI needs no special cases.
- A **workflow** is a named group of agents with its own lifecycle. Ad-hoc
  subagent fan-outs (bare Task calls) get a synthesized workflow when 2+
  agents run concurrently, so the canvas always has a stable grouping.

### Agent lifecycle vs activity

Two orthogonal dimensions; the character animation is derived from both:

```ts
type AgentLifecycle =
  | 'created'
  | 'running'
  | 'blocked'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'failed'
  | 'completed'
  | 'cancelled';

type AgentActivity =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'writing_code'
  | 'running_command'
  | 'testing'
  | 'reviewing';
```

Mapping to the product's visible states: Idle/Waiting/Thinking/Reading/
Searching/Writing code/Running a command/Testing/Reviewing come from
`activity` while `lifecycle = running`; Blocked/Failed/Completed come from
`lifecycle`. Activity is **inferred by the state engine** from tool events
(rules below), never invented by adapters.

Activity inference rules (state engine, in priority order):

1. `Read`/`NotebookRead` tool active → `reading`
2. `Grep`/`Glob`/`WebSearch`/`WebFetch` active → `searching`
3. `Edit`/`Write`/`NotebookEdit` active → `writing_code`
4. `Bash` active → `running_command`, unless command matches test-runner
   patterns (`test|vitest|jest|pytest|playwright|go test|cargo test`) → `testing`
5. Agent name/type matches `review|verify|check` while running → `reviewing`
6. No tool active but agent streaming text → `thinking`
7. Agent alive, nothing streaming, has pending children → `waiting`
8. Otherwise → `idle`

## Event catalog

Names required by the product spec are used verbatim. Additional events are
marked EXT (protocol extensions all consumers must tolerate).

### Session & workflow

| Type                  | Payload                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `session_started` EXT | `{ cwd?, appVersion?, title? }`                                                              |
| `session_ended` EXT   | `{ reason? }`                                                                                |
| `workflow_started`    | `{ name, description?, kind: 'workflow' \| 'adhoc' \| 'demo', phases?: {title, detail?}[] }` |
| `workflow_completed`  | `{ status: 'completed' \| 'failed' \| 'cancelled', summary? }`                               |

### Agent lifecycle

| Type                   | Payload                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `agent_created`        | `{ name, kind: 'main' \| 'subagent' \| 'workflow-agent', agentType?, parentAgentId?, model?, phase? }` |
| `agent_started`        | `{ }`                                                                                                  |
| `agent_status_changed` | `{ lifecycle?, activity?, reason?, currentAction? }` — at least one of lifecycle/activity              |
| `agent_blocked`        | `{ reason, kind?: 'permission' \| 'dependency' \| 'error' \| 'user' }`                                 |
| `agent_failed`         | `{ error: { message, kind? }, retryCount? }`                                                           |
| `agent_completed`      | `{ summary?, usage?: TokenUsage }`                                                                     |
| `agent_retried` EXT    | `{ retryCount }`                                                                                       |

### Agent work detail

| Type                       | Payload                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `agent_output`             | `{ stream: 'message' \| 'thinking' \| 'stdout' \| 'stderr', chunk, truncated? }` |
| `agent_tool_called`        | `{ toolCallId, tool, inputSummary, detail? }`                                    |
| `agent_tool_completed` EXT | `{ toolCallId, ok, durationMs?, resultSummary? }`                                |
| `agent_file_read`          | `{ path }`                                                                       |
| `agent_file_modified`      | `{ path, changeKind: 'created' \| 'edited' \| 'deleted' }`                       |
| `agent_command_started`    | `{ commandId, command, cwd?, description? }`                                     |
| `agent_command_completed`  | `{ commandId, exitCode?, ok, durationMs? }`                                      |
| `token_usage` EXT          | `{ usage: TokenUsage }` (cumulative per agent)                                   |

```ts
interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  contextPct?: number;
}
```

### Graph & interaction

| Type                      | Payload                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `dependency_created`      | `{ fromAgentId, toAgentId, kind: 'spawns' \| 'blocks' \| 'feeds' \| 'reviews' }` |
| `approval_requested`      | `{ requestId, kind: 'permission' \| 'plan' \| 'question', prompt, options? }`    |
| `approval_resolved` EXT   | `{ requestId, resolution }`                                                      |
| `user_input_requested`    | `{ requestId, prompt? }`                                                         |
| `user_input_provided` EXT | `{ requestId }`                                                                  |
| `adapter_notice` EXT      | `{ level: 'info' \| 'warn' \| 'error', message }` — adapter health/diagnostics   |

## Transport

Local WebSocket (default `ws://127.0.0.1:<port>/ws`), JSON text frames:

```ts
type ServerFrame =
  | { kind: 'hello'; protocolV: 1; serverVersion: string; sessions: SessionSummary[] }
  | { kind: 'snapshot'; sessionId: string; state: WorkspaceState } // reducer output
  | { kind: 'event'; event: EventEnvelope }
  | { kind: 'pong' };
type ClientFrame =
  | { kind: 'subscribe'; sessionId: string; fromSeq?: number }
  | { kind: 'unsubscribe'; sessionId: string }
  | { kind: 'ping' };
```

On subscribe the server sends `snapshot` then streams `event` frames with
`seq > snapshot.lastSeq`. Reconnect with `fromSeq` for gapless resume.
The observation plane has **no frames that execute anything** — command
execution is structurally impossible over this socket (security model).

Ingestion (adapter → bridge): HTTP POST `/ingest` on localhost with an array of
envelopes (hook adapter), or in-process for the built-in tailer/demo adapters.
A bearer token (generated per install, stored user-readable-only) is required
for both `/ingest` and `/ws` unless `--no-auth` is explicitly set.

## Recording format

A recording is a JSONL file: first line a header, then one envelope per line.

```
{ "kind": "vw-recording", "v": 1, "createdAt": "...", "sessionId": "...", "label": "...", "redaction": { "profile": "default" } }
{ "v": 1, "id": "...", "seq": 1, ... }
```

Replay feeds lines through the same reducer with a virtual clock built from
`ts` deltas (speed control: 1x/4x/16x/max, plus scrub-to-seq).
Retention: recordings only persist when the user enables recording; default
retention window configurable, in-memory ring buffer otherwise.

## Redaction (adapter-side)

- Pattern pass: common credential shapes (AWS `AKIA…`, GitHub `ghp_`/`gho_`,
  Slack `xox…`, OpenAI/Anthropic `sk-…`, JWTs, PEM blocks, `password=`/
  `Authorization:` values, generic `KEY=32+ high-entropy`).
- Entropy pass on long unbroken tokens in env-var-like contexts.
- Replaced with `•••REDACTED:<kind>•••`; the UI renders these as a shield chip.
- `agent_output` chunks are capped (16 KiB/chunk) and marked `truncated`.

## Versioning

- `v` bumps only on breaking envelope changes.
- New event types / payload fields are non-breaking; readers ignore unknowns.
- The state engine snapshot format is NOT a public contract; only events are.
