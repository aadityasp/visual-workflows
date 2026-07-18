# Claude Code Adapter Specification (verified)

Verification basis: empirical hook capture against Claude Code **v2.1.212**
(arm64, macOS) + on-disk schema analysis of ~20 real sessions. Field lists
below are observed fact, not docs paraphrase. Version-fragile items are
marked ⚠. Full probe reports: docs/discovery/.

## A. Hook forwarder adapter (real-time skeleton)

### Registration (additive, reversible)

`.claude/settings.json` (user or project) — our entries are namespaced and
installed/removed only via `visual-workflows connect|disconnect`, which
prints the diff, backs up settings, and never touches other hooks. Hooks
run alongside others (6 SessionStart hooks observed on this machine —
assume multiplicity, never exclusivity).

Events registered: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher
`*`), `PostToolUse` (matcher `*`), `SubagentStart`, `SubagentStop`, `Stop`,
`SessionEnd`, `PermissionRequest`, `Notification`, `PostToolUseFailure`.

### Verified payload fields (v2.1.212 empirical)

Common: `session_id`, `transcript_path`, `cwd`, `hook_event_name`; +`prompt_id` after first prompt; +`permission_mode` except Session* events.

| Event                            | Extra fields observed                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| SessionStart                     | `source` ("startup")                                                                                    |
| UserPromptSubmit                 | `prompt`                                                                                                |
| PreToolUse                       | `tool_name`, `tool_input`, `tool_use_id` (+`agent_id`, `agent_type` when inside a subagent)             |
| PostToolUse                      | + `tool_response`, `duration_ms`                                                                        |
| Stop                             | `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]`                   |
| SubagentStop                     | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks[]`       |
| SessionEnd                       | `reason`                                                                                                |
| PermissionRequest / Notification | ⚠ docs-only; Notification **never fired** in 4 headless runs incl. forced denial — treat as best-effort |

### Mapping rules (hook → protocol events)

- `SessionStart` → `session_started`; `SessionEnd` → `session_ended`.
- `UserPromptSubmit` → turn boundary; if `prompt` matches
  `<task-notification>` XML (⚠ synthetic re-entry, verified) → parse task-id,
  status, usage → `agent_completed` for the matching agent, NOT user input.
- `PreToolUse` → `agent_tool_called` (agent = `agent_id` ?? `main`);
  specialize: Bash → `agent_command_started`; Read → `agent_file_read`;
  Edit/Write → pending `agent_file_modified` (confirm on PostToolUse).
- `PostToolUse` → `agent_tool_completed` (join on `tool_use_id`); Bash →
  `agent_command_completed` (exit info only in `tool_response` shape).
- ⚠ **Task tool reports `tool_name: "Agent"`** (not "Task"); match both.
- ⚠ **Subagents launch async**: PostToolUse(Agent) arrives ~17ms after Pre
  with `tool_response.status: "async_launched"`, `agentId`, `resolvedModel`,
  `outputFile` → this is `agent_created` (+`dependency_created` spawn edge),
  **never** completion.
- `SubagentStart` → `agent_started`. `SubagentStop` → `agent_completed`
  (carry `last_assistant_message` as summary, `agent_transcript_path` for
  the tailer to pick up).
- `Stop` with non-empty `background_tasks` → parent `agent_status_changed`
  {activity: waiting} — turn paused with live children, NOT completed.
- `PermissionRequest` → `approval_requested` (experimental). Fallback
  heuristic: PreToolUse with no matching PostToolUse within T and parent
  idle → `agent_blocked{kind:permission}` (labeled inferred).
- Forwarder contract: read stdin (single-line JSON), redact, POST
  127.0.0.1:port with token, hard 2s self-timeout, **always exit 0** — a
  broken bridge must never break Claude Code.

## B. Transcript tailer adapter (detail + catch-up)

### Discovery & liveness

- Primary: watch `~/.claude/sessions/<pid>.json` registry —
  `{sessionId, cwd, status: busy|idle, updatedAt...}` (verified live).
  Missing `status` = starting. Stale pid files pruned by kill-0 check.
- Per session: `~/.claude/projects/<flat-cwd>/<sessionId>.jsonl` (verified
  incremental flush), `<sessionId>/subagents/` (fs-watch for
  `agent-*.{jsonl,meta.json}`), `<sessionId>/subagents/workflows/wf_*/`
  (+`journal.jsonl`), `<sessionId>/tool-results/` (spill files).

### Parsing rules (all verified)

- Group consecutive `assistant` lines by `message.id` (one API message =
  N JSONL lines, one per content block); emit on non-null `stop_reason`;
  dedupe `usage` by `message.id` → `token_usage`.
- `tool_use` ↔ `tool_result` join: `content[].id` ==
  `tool_result.tool_use_id` (redundant `parentUuid` check available).
- `toolUseResult` structured mirror: Bash `{stdout, stderr, interrupted,
persistedOutputPath}` → `agent_command_completed` + `agent_output`;
  Edit/Write `{filePath, structuredPatch, userModified}` →
  `agent_file_modified`; Read `{file.filePath}` → `agent_file_read`.
- `system` subtypes: `api_error` → `adapter_notice`(retry, not failure);
  `compact_boundary` → `agent_status_changed` note; `turn_duration` → turn
  end corroboration; `model_refusal_fallback` → `adapter_notice`.
- Interrupts: synthetic user line `"[Request interrupted by user]"` +
  `interruptedMessageId` → `agent_status_changed`{cancelled turn}.
- `AskUserQuestion` tool_use → `user_input_requested` (structured, clean).
- Subagent files: same envelope + `agentId`, `isSidechain: true`;
  `meta.json.toolUseId` correlates to the spawning Agent call — for
  `spawnDepth>0` search sibling agent transcripts for the spawner.
  Workflow agents: `meta.json` is only `{agentType:"workflow-subagent"}`;
  correlate by `agentId`; `journal.jsonl` `{type:"result", agentId}` is the
  per-agent completion signal (run-summary `wf_*.json` is end-of-run only —
  never wait on it for live UI).
- Teammates (named agents): `meta.json{taskKind:"in_process_teammate",
name, teamName}`; `teamName` may reference an ANCESTOR session's team dir
  (`~/.claude/teams/…`) — resolve, but treat `config.json.members[].prompt`
  as sensitive (never ingested).

### Known gaps (honest)

- `approval_requested` from transcripts: unverified (bypass-permissions
  corpus) — hooks path owns it.
- ⚠ On-disk format is not a stable public API — parser is tolerant
  (unknown types/fields → skip + `adapter_notice`), covered by fixture
  tests, and versioned per observed Claude Code version.

## C. Merge layer

Hook and tailer events for the same fact are deduped keyed on
(`session_id`, `tool_use_id`) with source precedence: hook wins on timing
(first), tailer enriches (output text, patches, usage) — emitted as
follow-up events, never duplicates. Either adapter absent = degraded but
correct stream.

## D. Environment traps (must handle)

1. ⚠ **Rosetta trap (verified on this machine)**: `/usr/local/bin/claude`
   was x86_64-under-Rosetta and hangs at 100% CPU (Bun x64 needs AVX).
   Anything that probes `claude` must use a short-timeout version check and
   prefer `/opt/homebrew/bin/claude` on arm64; surface a clear error.
2. Hook multiplicity: never assume our hooks are alone; never reorder or
   remove others on disconnect.
3. Path flattening: project dir slug = cwd with `/`→`-` (verified);
   compute, don't guess.
4. All ⚠ items re-verified per Claude Code release; the hooks adapter records a
   `VERIFIED_AGAINST = "2.1.212"` constant and tolerantly skips shapes it does
   not recognize rather than guessing. It does not currently detect the
   installed Claude Code version or surface a UI mismatch marker; version-drift
   detection is a roadmap item.
