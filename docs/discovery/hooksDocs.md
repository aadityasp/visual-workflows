## SUMMARY

Claude Code provides multiple official observability surfaces for external monitoring without modifying internals: **hooks** (25+ events with JSON I/O via stdin/stdout, configurable matchers, and async support), **OpenTelemetry** (metrics, logs, traces with beta support, via CLAUDE_CODE_ENABLE_TELEMETRY + OTEL_* env vars), **statusLine** (JSON data piped to shell scripts), **transcript JSONL files** (at ~/.claude/projects/<slug>/<session-id>.jsonl, internal schema, not stable API), **headless streaming** (--output-format stream-json with newline-delimited JSON events), and **plugins** (can distribute hooks+commands). The Agent SDK surfaces the same hooks, observability, and session management. No IDE extension protocol is officially documented. All claims below are verified against official code.claude.com documentation.

## FINDINGS

## 1. Hook Events & JSON Payload Schema

**VERIFIED-IN-DOCS** (https://code.claude.com/docs/en/hooks.md):

Claude Code supports 25+ hook events organized by cadence:

- **Once per session**: `SessionStart`, `SessionEnd`
- **Once per turn**: `UserPromptSubmit`, `Stop`, `StopFailure`
- **Per tool call**: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`
- **Lifecycle**: `PermissionRequest`, `Notification`, `FileChanged`, `ConfigChange`, `CwdChanged`
- **Subagent**: `SubagentStart`, `SubagentStop`
- **Context**: `PreCompact`

Plugin hooks support additional events: `Setup`, `UserPromptExpansion`, `PermissionDenied`, `MessageDisplay`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `WorktreeCreate`, `WorktreeRemove`, `PostCompact`, `Elicitation`, `ElicitationResult` (source: https://code.claude.com/docs/en/plugins-reference.md).

**Common JSON Input Fields (stdin payload)**: All hook events receive these fields via stdin in JSON format:

- `session_id` - unique session identifier
- `prompt_id` - UUID identifying current user prompt (available after first input)
- `transcript_path` - path to conversation transcript file
- `cwd` - current working directory
- `permission_mode` - current permission mode
- `hook_event_name` - name of firing event (e.g., "PreToolUse")
- `effort.level` - reasoning effort setting

**Tool-specific fields** (PreToolUse, PostToolUse, PostToolUseFailure):

- `tool_name` - name of the tool
- `tool_input` - tool's input arguments (for PreToolUse; object structure varies by tool)
- `tool_response` - tool's output (for PostToolUse)
- `tool_use_id` - correlates PreToolUse and PostToolUse for same call

**Subagent fields** (SubagentStart, SubagentStop):

- `agent_id` - subagent identifier
- `agent_type` - agent type name
- `agent_transcript_path` - path to subagent's transcript

**Output JSON schema**:

```json
{
  "continue": true,
  "stopReason": "string (if continue=false)",
  "suppressOutput": false,
  "systemMessage": "message shown to user",
  "terminalSequence": "desktop notification OSC sequence",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "explanation",
    "additionalContext": "context for Claude",
    "updatedInput": { "tool argument": "new value" },
    "updatedToolOutput": "replacement tool output"
  }
}
```

Exit codes:

- **0**: Success, parse stdout for JSON
- **2**: Blocking error, stderr shown as feedback, action blocked
- **Other**: Non-blocking, stderr shown, execution continues

**Settings.json wiring format**:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write",
        "hooks": [
          {
            "type": "command",
            "command": "./script.sh",
            "timeout": 600,
            "if": "Bash(rm *)"
          }
        ]
      }
    ]
  }
}
```

**Matchers**: Exact strings (no regex chars) or regex patterns. Special format for MCP tools: `mcp__<server>__<tool>`. Supports `*` for all, pipe-separated alternatives, or omit for all.

**Timeout behavior**: Command/HTTP/MCP default 600s, prompt 30s, agent 60s. Can override per hook.

**Async/parallel behavior**: Multiple hooks for same event run in parallel (non-deterministic order). Exit codes and JSON outputs compose with precedence: `deny` > `defer` > `ask` > `allow`.

---

## 2. Subagent Hooks & Tool Calls Inside Subagents

**VERIFIED-IN-DOCS** (https://code.claude.com/docs/en/agent-sdk/hooks.md, https://code.claude.com/docs/en/hooks.md):

**Do hooks fire for tool calls inside subagents (Task tool)?** YES. When a subagent executes, its `PreToolUse`, `PostToolUse`, `PostToolUseFailure` hooks fire normally. These are visible via:

- Agent SDK: hook input's `agent_id` and `agent_type` fields indicate whether firing inside subagent
- Subagent transcript paths: available at `agent_transcript_path` in SubagentStop hook

**SubagentStop hook receives**:

- `agent_id` - subagent identifier
- `agent_type` - agent type
- `agent_transcript_path` - path to subagent's JSONL transcript
- `tool_use_id` - ID of the Task tool call that spawned it
- `stop_hook_active` - whether stop hook is active

**SubagentStart hook** - VERIFIED-IN-DOCS exists and fires when subagent initializes, provides `agent_id`, `agent_type`.

---

## 3. statusLine Input JSON Schema & Update Cadence

**VERIFIED-IN-DOCS** (https://code.claude.com/docs/en/statusline.md):

**Input JSON schema** (piped to shell command via stdin):

```json
{
  "cwd": "/current/working/directory",
  "session_id": "abc123",
  "session_name": "my-session (optional, only if set)",
  "prompt_id": "uuid (only after first input)",
  "transcript_path": "/path/to/transcript.jsonl",
  "model": {
    "id": "claude-opus-4-8",
    "display_name": "Opus"
  },
  "workspace": {
    "current_dir": "/path",
    "project_dir": "/original/path",
    "added_dirs": [],
    "git_worktree": "feature-xyz (optional, only in worktree)",
    "repo": {
      "host": "github.com",
      "owner": "anthropics",
      "name": "claude-code"
    } // optional, only in git repo with origin
  },
  "version": "2.1.90",
  "output_style": { "name": "default" },
  "cost": {
    "total_cost_usd": 0.01234,
    "total_duration_ms": 45000,
    "total_api_duration_ms": 2300,
    "total_lines_added": 156,
    "total_lines_removed": 23
  },
  "context_window": {
    "total_input_tokens": 15500,
    "total_output_tokens": 1200,
    "context_window_size": 200000,
    "used_percentage": 8,
    "remaining_percentage": 92,
    "current_usage": {
      "input_tokens": 8500,
      "output_tokens": 1200,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 2000
    } // null before first API call
  },
  "exceeds_200k_tokens": false,
  "effort": { "level": "high" },
  "thinking": { "enabled": true },
  "rate_limits": {
    "five_hour": {
      "used_percentage": 23.5,
      "resets_at": 1738425600
    },
    "seven_day": {
      "used_percentage": 41.2,
      "resets_at": 1738857600
    }
  }, // only for Claude.ai subscribers after first API call
  "vim": { "mode": "NORMAL" }, // only if vim mode enabled
  "agent": { "name": "security-reviewer" }, // optional
  "pr": {
    "number": 1234,
    "url": "...",
    "review_state": "pending|approved|changes_requested"
  }, // optional, removed after merge/close
  "worktree": {
    "name": "my-feature",
    "path": "/path",
    "branch": "worktree-my-feature",
    "original_cwd": "/path",
    "original_branch": "main"
  } // only during --worktree sessions
}
```

**Update cadence**: Script runs:

- After each new assistant message
- After `/compact` finishes
- When permission mode changes
- When vim mode toggles
- Updates debounced at 300ms (rapid changes batch)
- Can set optional `refreshInterval` for time-based updates (minimum 1 second)

**Timeout**: No explicit timeout documented, command runs and output captured (does not connect to terminal).

---

## 4. OpenTelemetry Support & Event Catalog

**VERIFIED-IN-DOCS** (https://code.claude.com/docs/en/monitoring-usage.md, https://code.claude.com/docs/en/agent-sdk/observability.md):

**Enable telemetry**:

- `CLAUDE_CODE_ENABLE_TELEMETRY=1` (required)
- For traces (beta): `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`

**Exporter env vars**:

- `OTEL_METRICS_EXPORTER` - `otlp|prometheus|console|none`
- `OTEL_LOGS_EXPORTER` - `otlp|console|none`
- `OTEL_TRACES_EXPORTER` - `otlp` (requires enhanced telemetry beta)
- `OTEL_EXPORTER_OTLP_PROTOCOL` - `grpc|http/protobuf` (default: grpc)
- `OTEL_EXPORTER_OTLP_ENDPOINT` - collector URL (e.g., http://localhost:4317)
- `OTEL_EXPORTER_OTLP_HEADERS` - auth headers

**Data logging control**:

- `OTEL_LOG_USER_PROMPTS=1` - include prompt text in events
- `OTEL_LOG_TOOL_DETAILS=1` - include tool parameters
- `OTEL_LOG_TOOL_CONTENT=1` - include full tool I/O bodies
- `OTEL_LOG_RAW_API_BODIES` - `1` for inline or `file:<dir>` for files

**Export intervals**:

- `OTEL_METRIC_EXPORT_INTERVAL` - default 60000ms
- `OTEL_LOGS_EXPORT_INTERVAL` - default 5000ms
- `OTEL_TRACES_EXPORT_INTERVAL` - default (not specified, likely 5000ms)

**Metrics available** (counters):

- `claude_code.session.count` - sessions started (attributes: start_type=fresh|resume|continue|agents_view)
- `claude_code.code_edits.lines` - lines added/removed
- `claude_code.pull_requests.count` - PRs created
- `claude_code.commits.count` - commits made
- `claude_code.cost.usage` - USD cost (breakdownable by model, skill, agent, user, team)
- `claude_code.token.usage` - tokens (input, output, cache read, cache creation)
- `claude_code.tool_decision.count` - code edit tool permission accept/reject
- `claude_code.active_time.seconds` - session duration

**Events/Logs** (named `claude_code.<event_type>`):

- `user_prompt` - user submission
- `assistant_response` - model response (v2.1.193+)
- `api_request` / `api_error` / `api_refusal` - API calls and failures
- `tool_result` - tool output
- `tool_decision` - permission accept/reject
- `mcp_server_connection` - MCP server activity
- `plugin_installed` / `plugin_loaded` - plugin inventory
- `auth` - login/logout
- `hook_registered` / `hook_execution_complete` - hook activity
- `internal_error` - unexpected errors

**Traces (beta)** - span names:

- `claude_code.interaction` - wraps one agent loop turn
- `claude_code.llm_request` - API call (attributes: model, latency, token counts)
- `claude_code.tool` - tool invocation (children: `claude_code.tool.blocked_on_user`, `claude_code.tool.execution`)
- `claude_code.hook` - hook execution (requires `ENABLE_BETA_TRACING_DETAILED=1`)

**Standard attributes on all data**:

- `session.id` - session identifier
- `user.id` - anonymous or authenticated user
- `user.email` - when authenticated
- `organization.id` - org UUID
- Custom attributes from `OTEL_RESOURCE_ATTRIBUTES`

**Structured per-tool-call events**: YES. `tool_result` and `tool_decision` events (as log records) include `tool_name`, `tool_input` (if `OTEL_LOG_TOOL_DETAILS=1`), `tool_output` (if `OTEL_LOG_TOOL_CONTENT=1`), and `tool_use_id` for correlation with `claude_code.tool` spans. These can be sent to local OTLP receiver.

---

## 5. Headless Mode Message Streaming

**VERIFIED-IN-DOCS** (https://code.claude.com/docs/en/headless.md):

**Command flags**:

- `-p` / `--print` - non-interactive mode
- `--bare` - skip hooks, skills, plugins, MCP servers, CLAUDE.md auto-discovery
- `--output-format text|json|stream-json` (default: text)
- `--include-partial-messages` - emit text deltas before message completes
- `--verbose` - enable detailed output
- `--no-session-persistence` - suppress transcript writes

**stream-json message schema**: Newline-delimited JSON events:

```json
{
  "type": "stream_event|system",
  "event": {
    "delta": {
      "type": "text_delta",
      "text": "token..."
    }
  }
}
```

Special `system` events:

- `system/init` - first event, contains model, tools, MCP servers, loaded plugins, plugin errors, capabilities array
- `system/api_retry` - retryable error, includes attempt, max_retries, retry_delay_ms, error_status, error category
- `system/plugin_install` - marketplace plugin install progress (if `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`)

Subagent messages: contain `parent_tool_use_id` field (ID of Task tool that spawned them), null for main conversation.

**By default** subagents emit only `tool_use` and `tool_result` blocks; with `--forward-subagent-text` or `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1` (v2.1.211+), also emit text and thinking blocks.

**Session resume flags**: `--continue`, `--resume <session-id>`, `--from-pr <number>`

---

## 6. Transcript JSONL Files

**VERIFIED-IN-DOCS** (https://code.claude.com/docs/en/sessions.md):

**Location**: `~/.claude/projects/<project>/<session-id>.jsonl`

- `<project>` = working directory path with non-alphanumeric chars replaced by `-`
- Customizable via `CLAUDE_CONFIG_DIR` env var

**Schema**: Internal format, NOT stable API. Each line is JSON object for:

- Message
- Tool use
- Metadata entry
  Documentation explicitly states: "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release."

**Recommended access patterns** instead of direct file parsing:

- `/export` command - renders readable text transcript
- `claude -p --resume <session-id> --output-format json` - follow-up query with structured result
- Read `transcript_path` from hooks/statusline input JSON, pass to external logger
- Agent SDK: receive each message programmatically via streaming

**Retention**: Default 30 days, configurable via `cleanupPeriodDays` in settings.json

---

## 7. Plugin System: Distribution & Components

**VERIFIED-IN-DOCS** (https://code.claude.com/docs/en/plugins-reference.md, https://code.claude.com/docs/en/plugins.md):

**Can plugins distribute hooks + commands as single install?** YES.

**What plugins can contain**:

- **Skills** - `/name` commands (location: `skills/`, `commands/`, or `SKILL.md` at root)
- **Agents** - subagents (location: `agents/`)
- **Hooks** - event handlers (location: `hooks/hooks.json` or inline in `plugin.json`)
- **MCP servers** - external tools (location: `.mcp.json` or inline)
- **LSP servers** - language intelligence (location: `.lsp.json` or inline)
- **Monitors** - background watchers (location: `monitors/monitors.json` or inline, experimental)
- **Themes** - color schemes (location: `themes/`, experimental)

**Installation**:

- Via `/plugin` marketplace UI or `claude plugin install`
- Scopes: `user` (global), `project` (git repo), `local` (git-ignored), `managed` (admin)
- Skills-directory plugins: drop `.claude-plugin/plugin.json` in `~/.claude/skills/foo/` or `.claude/skills/foo/`, loads on next session as `foo@skills-dir`

**Manifest schema** (`.claude-plugin/plugin.json`):

```json
{
  "name": "plugin-id",
  "displayName": "Human Name",
  "version": "1.0.0",
  "description": "...",
  "skills": "./skills/",
  "commands": ["./cmd.md"],
  "agents": ["./agents/reviewer.md"],
  "hooks": "./hooks/hooks.json",
  "mcpServers": {
    "my-server": {
      "command": "...",
      "args": [...],
      "env": {...}
    }
  },
  "lspServers": {...},
  "experimental": {
    "monitors": "./monitors.json",
    "themes": "./themes/"
  },
  "dependencies": ["other-plugin-name"]
}
```

**Scoped names**: Plugin agents/commands appear with namespace, e.g., `my-plugin:code-reviewer` when invoked via @-mention.

---

## 8. Agent SDK Surfaces

**VERIFIED-IN-DOCS** (https://code.claude.com/docs/en/agent-sdk/hooks.md, https://code.claude.com/docs/en/agent-sdk/observability.md):

**Hooks in SDK**: Python and TypeScript SDKs support hooks via `ClaudeAgentOptions.hooks` (Python) or `options.hooks` (TS). Same events and matchers as settings-file hooks. Python SDK: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `Stop`, `Notification` (no `SessionStart`, `SessionEnd`). TypeScript SDK: all events listed above.

Hooks can be callback functions (Python/TS async lambdas) or shell commands loaded from settings. Callback receives hook input, returns JSON output with `hookSpecificOutput` dict. SDK callbacks run in parallel, exit code / return status composes with precedence.

**Observability in SDK**:

- Configure via `ClaudeAgentOptions.env` (Python) or `options.env` (TS)
- Pass `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTEL_* vars
- Spans: `claude_code.interaction`, `claude_code.llm_request`, `claude_code.tool`, `claude_code.hook`
- Traces link via W3C propagation: SDK injects `TRACEPARENT`/`TRACESTATE` into child process
- Cost tracking: read from message stream with `usage_data` on result messages

**Session management in SDK**: `ClaudeAgentOptions.session_id`, `session_sources`, automatic or explicit session storage via `SessionStore` interface.

---

## 9. Other Official Observation Surfaces

**VERIFIED-IN-DOCS**:

- **IDE extensions** - NOT OFFICIALLY DOCUMENTED. VS Code and JetBrains extensions are mentioned in docs (https://code.claude.com/docs/en/vs-code.md, https://code.claude.com/docs/en/jetbrains.md) but no public protocol for external monitoring.
- **Channels** (webhooks) - NOT for observability: https://code.claude.com/docs/en/channels.md enables relay of permission prompts and notifications, but designed for multi-agent coordination, not external observation.
- **Analytics API** - NOT for live Claude Code sessions: https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api.md covers usage reports, not live event streaming.

**Files with guaranteed stability**:

- Settings/config JSON schemas: Yes, documented
- Plugin manifest schema: Yes, documented (https://code.claude.com/docs/en/plugins-reference.md)
- Hook input/output: Yes, documented (https://code.claude.com/docs/en/hooks.md)
- statusLine JSON: Yes, documented (https://code.claude.com/docs/en/statusline.md)
- Headless stream-json events: Partially; message types documented, span/event schema documented, but frame schema may evolve
- Transcripts JSONL: NO, explicitly not stable (https://code.claude.com/docs/en/sessions.md)

## RISKS

**Uncertainties & Limitations**:

1. **Transcript JSONL schema**: Explicitly unstable. Cannot rely on field names, structure, or presence. Recommend using `/export` or programmatic APIs only.

2. **Stream-json event schema**: Full specification for all event types not provided in single location. Documented event types: stream_event, system/init, system/api_retry, system/plugin_install, but frame/payload schema details inferred from examples.

3. **Traces (beta)**: Documentation warns this is beta and "span names and attributes may change between releases." Do not build critical systems on current trace format until GA.

4. **Hook execution order non-determinism**: Multiple hooks for same event run in parallel; order not guaranteed. Cannot assume one hook's work completes before another starts unless they serialize within hook output.

5. **Plugin hook restrictions**:
   - Plugin-shipped agents cannot use `hooks`, `mcpServers`, `permissionMode` fields
   - Project-scope plugin hooks load only after workspace trust
   - Background monitors in plugins do not load for project scope (only personal)

6. **Agent SDK Python limitations**: `SessionStart` and `SessionEnd` callbacks not available; only available as shell-command hooks from settings files or TypeScript SDK.

7. **subagentStatusLine**: Documented but not yet researched in detail; format assumed compatible with statusLine but may differ.

8. **IDE extension protocol**: Completely absent from official docs. VS Code extension has published API but not documented as stable or public for external use.

9. **OpenTelemetry redaction**: By default, prompt text, tool parameters, and API bodies are redacted from exports. Opt-in flags (`OTEL_LOG_USER_PROMPTS`, etc.) required to include them; security risk if enabled.

10. **Rate limiting & CLI env inheritance**: Agent SDK passes env to child CLI; inherited environment may conflict with user's local settings. TypeScript SDK replaces inherited env entirely if options.env is provided; Python merges on top.

11. **statusLine environment variables**: Command receives COLUMNS and LINES vars (v2.1.153+) for terminal sizing, but cannot call tput. Older versions lack these vars.

## RECOMMENDATIONS

**For building an external observability app (visual command center):**

1. **Primary data source**: Use OpenTelemetry export with OTLP receiver. Configure `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` + OTEL_* env vars. This gives:
   - Real-time structured events (user prompts, tool calls, API requests, errors) as log records
   - Spans with nesting (interaction → llm_request / tool)
   - Metrics (cost, tokens, session count)
   - Attributes for filtering (session.id, tool_name, user.id, organization.id)

2. **Secondary data source (cost/usage without external backend)**: Parse headless `claude -p` with `--output-format stream-json` to capture cost, tokens, session_id directly from result messages.

3. **Session lifecycle monitoring**:
   - Hooks: `SessionStart` (in settings-file hooks or TS SDK callbacks, not Python callbacks), `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`
   - Or: Read `transcript_path` from statusline input JSON; archive transcripts at `SessionEnd` hook
   - Avoid parsing JSONL directly (internal, unstable)

4. **Cost/context/status visualization**:
   - Consume statusLine JSON (piped to script): has real-time context_window.used_percentage, cost.total_cost_usd, rate_limits
   - Or: Parse stream-json from headless mode
   - Both provide structured, stable data

5. **Plugin architecture for distribution**:
   - Package observability as a plugin with `hooks/hooks.json` (hooks event handlers) + `commands/` (e.g., `/observability-dashboard`)
   - Hooks: `SessionStart` (initialize logger), `PostToolUse` (log tool result), `SessionEnd` (finalize)
   - Plugin can also bundle custom MCP server (e.g., for analytics backend)

6. **Avoid**:
   - Parsing transcript JSONL (not stable API)
   - Parsing headless text output (fragile)
   - Hooking into CLI internals (not designed for external use)
   - Modifying .claude/ config files (use settings-file hooks or plugins instead)

7. **Missing feature**: IDE extension protocol is not public. If building IDE integration, use existing extensions' published capabilities only.

8. **Streaming cadences**:
   - statusLine: 300ms debounce, optional refreshInterval timer
   - OTEL events: 5000ms export interval (tunable)
   - stream-json: real-time per token (no batching)
   - Hooks: synchronous (can timeout)
