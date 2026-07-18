## SUMMARY

Empirical verification succeeded: real headless Claude Code sessions (v2.1.212, arm64) were run with command hooks registered for all 8 requested events, and 7 of 8 fired with full payloads captured (Notification never fired in headless -p mode, even on a forced permission denial). Critical environment finding: the task-specified binary /usr/local/bin/claude (v2.1.207) is an x86_64 Mach-O running under Rosetta 2 on an Apple M1 Pro and is unusable — it spins at 100% CPU without even printing --version within 140s (Bun x64 build requires AVX, which Rosetta lacks); the arm64 Homebrew binary at /opt/homebrew/bin/claude works in under a second and plain invocation from inside a parent Claude Code session worked without unsetting CLAUDECODE/CLAUDE_CODE_ENTRYPOINT. Key payload discoveries: the Task tool is reported as tool_name "Agent" and launches subagents asynchronously (PostToolUse fires at launch with status async_launched, not at completion); subagent inner tool calls fire PreToolUse/PostToolUse in the same session with extra agent_id/agent_type fields; SubagentStop delivers agent_transcript_path and the subagent's last_assistant_message; subagent completion re-enters the parent as a synthetic UserPromptSubmit containing a <task-notification> XML block. Hook stdout never appears in plain -p text output but surfaces as system/hook_response events in stream-json and as hook_success attachment entries in the transcript; transcript_path points at a real JSONL file verified to grow mid-session.

## FINDINGS

## Environment findings (critical)

- **/usr/local/bin/claude is broken on this machine.** It symlinks to `/usr/local/Caskroom/claude-code@latest/2.1.207/claude`, an **x86_64 Mach-O** on an **Apple M1 Pro**, so it runs under Rosetta 2. It prints `warn: CPU lacks AVX support, strange crashes may occur` (Bun v1.4.0 x64 non-baseline build) and then burns 100% CPU indefinitely: `--version` produced no output in 140s wall / 124s user CPU and was killed by SIGALRM (exit 142). Every invocation behaves this way; this is a binary/arch problem, not an env-var or nesting problem.
- **Working binary:** `/opt/homebrew/bin/claude` → `/opt/homebrew/Caskroom/claude-code@latest/2.1.212/claude`, native **arm64**, `--version` in 0.6s. All runs below used this binary, v**2.1.212**.
- **Env stripping not needed:** plain invocation (with only the `perl -e 'alarm N; exec @ARGV'` wrapper) worked from inside a parent Claude Code session; `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT` was never required with the arm64 binary.
- **Contamination note:** user-level `~/.claude/settings.json` registers its own SessionStart hook (gsd-check-update.js) and installed plugins (superpowers, vercel) add more — stream-json showed **6 SessionStart hook_started events** (mine + user + plugins). Only the project hook wrote to events.jsonl, so captured payloads are clean.
- Hooks in a brand-new directory's `.claude/settings.json` executed in `-p` mode **without any trust prompt**.
- `matcher: "*"` on PreToolUse/PostToolUse works (omitted-matcher form not tested since "*" succeeded).
- Hook stdin is a **single-line JSON object terminated by a trailing newline**.

Working directory: a temp scratchpad dir (below: `<WORKDIR>`). Raw logs preserved there: `events_runA.jsonl`, `events_runB.jsonl`, `events_runC.jsonl`, `events.jsonl` (run D), `streamjson.txt`, `watcher.log`, `.claude/settings.json`. `<HOME>` = user home; `<FLATCWD>` = flattened cwd path used under `~/.claude/projects/`.

## Run A (simple Bash echo) — event ordering

`SessionStart(source=startup) → UserPromptSubmit → PreToolUse(Bash) → PostToolUse(Bash) → Stop → SessionEnd(reason="other")`

## Exact top-level fields per observed event

Common to all events: `session_id`, `transcript_path`, `cwd`, `hook_event_name`. All events after SessionStart also carry `prompt_id`; all except SessionStart/SessionEnd carry `permission_mode`.

| Event            | Top-level fields (exact, from jq keys)                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart     | cwd, hook_event_name, session_id, source, transcript_path                                                                                                                                             |
| UserPromptSubmit | cwd, hook_event_name, permission_mode, prompt, prompt_id, session_id, transcript_path                                                                                                                 |
| PreToolUse       | cwd, hook_event_name, permission_mode, prompt_id, session_id, tool_input, tool_name, tool_use_id, transcript_path (+ agent_id, agent_type when fired from inside a subagent)                          |
| PostToolUse      | cwd, duration_ms, hook_event_name, permission_mode, prompt_id, session_id, tool_input, tool_name, tool_response, tool_use_id, transcript_path (+ agent_id, agent_type inside a subagent)              |
| Stop             | background_tasks, cwd, hook_event_name, last_assistant_message, permission_mode, prompt_id, session_crons, session_id, stop_hook_active, transcript_path                                              |
| SubagentStop     | agent_id, agent_transcript_path, agent_type, background_tasks, cwd, hook_event_name, last_assistant_message, permission_mode, prompt_id, session_crons, session_id, stop_hook_active, transcript_path |
| SessionEnd       | cwd, hook_event_name, prompt_id, reason, session_id, transcript_path                                                                                                                                  |
| Notification     | **never observed** (see below)                                                                                                                                                                        |

## Sanitized sample payloads (verbatim structure, paths/user sanitized)

SessionStart:

```json
{
  "session_id": "e090e726-528b-4453-a90f-c65016d2d293",
  "transcript_path": "<HOME>/.claude/projects/<FLATCWD>/e090e726-528b-4453-a90f-c65016d2d293.jsonl",
  "cwd": "<WORKDIR>",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

UserPromptSubmit:

```json
{
  "session_id": "e090e726-...",
  "transcript_path": "<HOME>/.claude/projects/<FLATCWD>/e090e726-....jsonl",
  "cwd": "<WORKDIR>",
  "prompt_id": "1ea7a8a0-1d0c-4a90-aa44-632ae0960ea5",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Use the Bash tool to run exactly: echo hooktest-123"
}
```

PreToolUse (Bash):

```json
{
  "session_id": "e090e726-...",
  "transcript_path": "<HOME>/.claude/projects/<FLATCWD>/e090e726-....jsonl",
  "cwd": "<WORKDIR>",
  "prompt_id": "1ea7a8a0-...",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "echo hooktest-123", "description": "Run the requested echo command" },
  "tool_use_id": "toolu_01ATC8QGvfBLP7EL2uaRxHEN"
}
```

PostToolUse (Bash) — note `tool_response` shape for Bash and `duration_ms`:

```json
{
  "session_id": "e090e726-...",
  "transcript_path": "...",
  "cwd": "<WORKDIR>",
  "prompt_id": "1ea7a8a0-...",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "echo hooktest-123", "description": "Run the requested echo command" },
  "tool_response": {
    "stdout": "hooktest-123",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  },
  "tool_use_id": "toolu_01ATC8QGvfBLP7EL2uaRxHEN",
  "duration_ms": 3556
}
```

Stop:

```json
{
  "session_id": "e090e726-...",
  "transcript_path": "...",
  "cwd": "<WORKDIR>",
  "prompt_id": "1ea7a8a0-...",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "Done. The command output is `hooktest-123`.",
  "background_tasks": [],
  "session_crons": []
}
```

SessionEnd:

```json
{
  "session_id": "e090e726-...",
  "transcript_path": "...",
  "cwd": "<WORKDIR>",
  "prompt_id": "1ea7a8a0-...",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

(`reason` was `"other"` for normal `-p` completion in every run.)

## Run B (subagent) — the big discoveries

Observed exact ordering (same session_id throughout; prompt_id shown truncated):

```
SessionStart                     3529300e
UserPromptSubmit                 3529300e
PreToolUse   Agent               3529300e
PostToolUse  Agent   (17 ms!)    3529300e   <- fires at LAUNCH, not completion
PreToolUse   Bash  +agent_id     3529300e   <- subagent's inner call
Stop         (parent)            3529300e   <- parent stops WHILE subagent still running
PostToolUse  Bash  +agent_id     3529300e
SubagentStop                     3529300e
UserPromptSubmit                 3c34c7da   <- synthetic <task-notification> prompt
Stop                             3c34c7da
SessionEnd                       3c34c7da
```

1. **The Task tool is reported as `tool_name: "Agent"`** in hook payloads (the tools list in stream-json `init` still says "Task").
2. **Subagents are async in v2.1.212.** PostToolUse(Agent) fired after 17ms with:

```json
"tool_response":{"isAsync":true,"status":"async_launched","agentId":"aa91056a25d3a6fed","description":"Run echo subtest-456","resolvedModel":"claude-haiku-4-5-20251001","prompt":"Run the following bash command and report the output: echo subtest-456","outputFile":"<TMP>/<FLATCWD>/91466526-.../tasks/aa91056a25d3a6fed.output","canReadOutputFile":true}
```

PreToolUse(Agent) `tool_input` = `{"description","prompt","subagent_type":"general-purpose"}`. 3. **Subagent inner tool calls DO fire PreToolUse/PostToolUse** into the same hooks/log, same `session_id` and `prompt_id`, distinguished ONLY by two extra fields: `"agent_id":"aa91056a25d3a6fed"`, `"agent_type":"general-purpose"`. 4. **Parent Stop fires while the subagent is still running**, interleaved between the subagent's PreToolUse(Bash) and PostToolUse(Bash); its `background_tasks` shows it: `[{"id":"aa91056a25d3a6fed","type":"subagent","status":"running","description":"Run echo subtest-456","agent_type":"general-purpose"}]`. 5. **SubagentStop payload** (sanitized):

````json
{"session_id":"91466526-...","prompt_id":"3529300e-...","permission_mode":"default","agent_id":"aa91056a25d3a6fed","agent_type":"general-purpose","hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"<HOME>/.claude/projects/<FLATCWD>/91466526-.../subagents/agent-aa91056a25d3a6fed.jsonl","last_assistant_message":"The output is:\n\n```\nsubtest-456\n```","background_tasks":[{"id":"aa91056a25d3a6fed","type":"subagent","status":"running",...}],"session_crons":[],"transcript_path":"...","cwd":"..."}
````

The `agent_transcript_path` file exists on disk (39KB) alongside `agent-<id>.meta.json`. 6. **Subagent completion re-enters the parent as a synthetic UserPromptSubmit** whose `prompt` is a `<task-notification>` XML block containing `<task-id>`, `<tool-use-id>`, `<output-file>`, `<status>completed</status>`, `<summary>`, `<note>`, `<result>` (the subagent's answer), and `<usage><subagent_tokens>16938</subagent_tokens><tool_uses>1</tool_uses><duration_ms>6811</duration_ms></usage>` — with a NEW `prompt_id`, followed by its own Stop and then SessionEnd.

## Run C (stream-json) — headless stream format

Line types observed (27 lines total): `system/init` (1), `system/hook_started` (6, all SessionStart), `system/hook_response` (6), `system/thinking_tokens` (10), `assistant` (2), `rate_limit_event` (1), `result/success` (1).

- `system/init` fields include: cwd, session_id, tools[] (lists "Task", "Bash", "Skill", "ToolSearch", etc.), mcp_servers[] with {name,status}.
- `system/hook_started`: {type,subtype,hook_id,hook_name:"SessionStart:startup",hook_event,uuid,session_id}.
- `system/hook_response`: adds output, stdout, stderr, exit_code, outcome:"success" — **this is where hook stdout appears** in stream-json. My marker `HOOK-STDOUT-MARKER-SESSIONSTART\n` appeared verbatim in `stdout`. Notably, only SessionStart hooks got hook_started/hook_response stream events; UserPromptSubmit/Stop/SessionEnd hooks fired (per events.jsonl) but emitted no stream lines.
- One plugin hook demonstrated the structured-stdout protocol in the wild: stdout of `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` (superpowers plugin injecting context).
- `assistant` envelope keys: message, parent_tool_use_id, request_id, session_id, timestamp, type, uuid; `message` keys: content, context_management, diagnostics, id, model, role, stop_details, stop_reason, stop_sequence, type, usage.
- `result` keys: type, subtype, is_error, api_error_status, duration_ms, duration_api_ms, ttft_ms, ttft_stream_ms, time_to_request_ms, num_turns, result ("ok"), stop_reason ("end_turn"), session_id, total_cost_usd, usage (incl. cache_creation ephemeral buckets, iterations[]), modelUsage (per-model tokens/cost/contextWindow), permission_denials[], terminal_reason ("completed"), fast_mode_state, uuid.

## Run D (permission denial probe)

Prompt asked for Write; only Bash was allowed. Result: `SessionStart → UserPromptSubmit → PreToolUse(Write) → Stop → SessionEnd`. **PreToolUse fires for a tool that is subsequently permission-denied; PostToolUse does NOT fire; Notification did NOT fire.** The CLI's text reply said permission was required. Across all four runs, **Notification never fired in headless -p mode**.

## Hook stdout visibility (summary)

- Plain `-p` text output: hook stdout **never appeared** (markers absent from CLI output in runs A/B/D).
- stream-json + --verbose: appears in `system/hook_response` events (`stdout`/`output` fields).
- Transcript file: each hook execution is recorded as `{"type":"attachment","attachment":{"type":"hook_success","hookName","hookEvent","content":"<stdout w/o trailing NL>","stdout","stderr","exitCode":0,"durationMs","command","toolUseID"}}` — markers for SessionStart, UserPromptSubmit, and Stop all present (3 each in run C's transcript).

## transcript_path validity

`transcript_path` = `<HOME>/.claude/projects/<flattened-cwd-with-dashes>/<session_id>.jsonl`. Verified real (45,975 bytes after run A, 19 lines of typed JSONL starting with `queue-operation` enqueue/dequeue entries) and verified **growing mid-session** by a 1s poller during run D (29,444 → 36,090 bytes while the session ran). Subagent transcripts live separately at `<project-dir>/<session_id>/subagents/agent-<agent_id>.jsonl` (+ `.meta.json`), and the async Agent tool's `outputFile` lives under a session `tasks/` directory.

## RISKS

1. **Version specificity**: all payloads are from Claude Code v2.1.212 (arm64, macOS). The async-subagent behavior ("Agent" tool_name, async_launched, task-notification re-injection) may differ in other versions — the parent env even had CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in user settings, which could influence subagent architecture; field sets (background_tasks, session_crons, prompt_id) are not all in public docs and may be unstable.
2. **The specified binary was never exercised**: /usr/local/bin/claude (2.1.207 x86_64) could not run at all; findings come from the 2.1.212 arm64 binary instead. If production must use 2.1.207, its hook payloads are unverified.
3. **Notification is unverified**: it never fired in headless -p mode across four runs including a forced permission denial. Its payload shape (message/title fields per docs) could not be empirically confirmed; interactive-mode behavior untested.
4. **Untested events**: PreCompact, SessionStart sources other than "startup" (resume/clear), SessionEnd reasons other than "other", Stop with stop_hook_active=true, PermissionRequest-style flows, and omitted-matcher PreToolUse config (only matcher "*" verified).
5. **Environment contamination**: user-level and plugin hooks (gsd, superpowers, vercel) also ran during tests; while events.jsonl only received project-hook writes, model-visible context included plugin-injected content, and MCP servers from user config were loading — a cleaner machine could behave slightly differently (and these runs cost real API tokens, ~$0.014 for the trivial run C).
6. **Ordering caveat**: hook events are written by concurrently-running shell processes appending to one file; under heavy parallel tool use, interleaving in the log may not perfectly reflect true firing order (observed run B interleaving was internally consistent, but appends are not atomic-ordered by guarantee).
7. **stream-json hook visibility gap**: only SessionStart hooks emitted hook_started/hook_response stream events; UserPromptSubmit/Stop/SessionEnd hook executions were invisible in the stream (though present in transcript and in the hooks' own log) — do not rely on the stream for complete hook observability.

## RECOMMENDATIONS

1. **Ship the adapter against the arm64 binary and detect the Rosetta trap.** Any launcher must not assume `/usr/local/bin/claude` works: probe with a short-timeout `claude --version` first, and prefer `/opt/homebrew/bin/claude` (or `arch -arm64` native installs) on Apple Silicon. Surface a clear error mentioning the x86_64/AVX/Rosetta failure mode.
2. **Key your event model on `hook_event_name` + `session_id` + `prompt_id` + `tool_use_id`.** `prompt_id` cleanly segments turns; `tool_use_id` joins PreToolUse to PostToolUse. Treat `agent_id`/`agent_type` presence on Pre/PostToolUse as the "this is a subagent call" discriminator — same session, no separate stream.
3. **Do NOT use PostToolUse(Agent/Task) as subagent completion.** In 2.1.212 subagents launch async (`status:"async_launched"`, ~17ms). Completion signals are: SubagentStop (has `agent_transcript_path` + subagent `last_assistant_message`) and the synthetic UserPromptSubmit `<task-notification>` block (has result + token usage). Handle Stop events whose `background_tasks` is non-empty as "turn paused with live children", not "done"; also match tool_name "Agent" (and "Task" for older versions) defensively.
4. **For a UI event feed, hooks are sufficient for lifecycle + tool telemetry; pair them with a transcript tailer** — transcript_path is reliable and grows in near-real-time, and it also captures hook stdout as `hook_success` attachments (with durationMs/exitCode) that hooks themselves can't see.
5. **Don't build anything that depends on the Notification hook in headless mode** — it never fired, even on permission denial. Detect denials via PreToolUse-without-PostToolUse plus `permission_denials` in the stream-json `result` event.
6. **Use `--output-format stream-json --verbose` when you own the launch**: it adds init (tool/MCP inventory), hook_started/hook_response, thinking_tokens, per-turn assistant messages, and a rich final result (cost, usage, ttft, terminal_reason) that hooks alone don't provide.
7. **Log-appending hook commands work well as the capture mechanism**: `cat >> log; echo >> log` yields parseable JSONL (payloads are single-line JSON with trailing newline; filter blank lines). Use absolute paths and `matcher: "*"` for Pre/PostToolUse.
8. **Design for hook multiplicity**: user-level settings and plugins add their own hooks (6 SessionStart hooks fired here), and the structured `hookSpecificOutput.additionalContext` stdout protocol is actively used by plugins — your adapter's hooks must be additive and namespaced, never assume they're alone.
