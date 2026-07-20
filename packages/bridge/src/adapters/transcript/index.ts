/**
 * Claude Code transcript tailer — reads the on-disk session artifacts
 * (docs/discovery/transcripts.md TAILER RECIPE, docs/ADAPTERS.md section B)
 * and emits protocol events with source 'transcript'.
 *
 * Discovery: ~/.claude/sessions/<pid>.json registry (status busy|idle,
 * kill-0 staleness check) → tail projects/<flat-cwd>/<sessionId>.jsonl plus
 * <sessionId>/subagents/ agent files and subagents/workflows/wf_* runs.
 *
 * Resilience contract: the on-disk format is NOT a stable API — every line
 * is parsed tolerantly (unknown types/fields skipped), every per-session
 * error is contained, and nothing here can crash the bridge. Files can be
 * 100MB+: we never read a whole file — large files attach at EOF and only
 * new bytes are read; reads are chunked per poll tick.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  MAIN_AGENT_ID,
  capChunk,
  redactText,
  summarizeToolInput,
  truncate,
} from '@visual-workflows/protocol';
import type { SessionStartedPayload } from '@visual-workflows/protocol';
import type { Adapter, AdapterContext, EventInit } from '../types.js';
import { makeEvent } from '../types.js';
import { sniffAgentRole } from '../claude-roles.js';

export interface TranscriptAdapterConfig {
  /** Claude config dir (default ~/.claude). */
  claudeDir?: string;
  /** Poll interval in ms (default 1500). */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 1500;
/** Files larger than this at first attach are tailed from EOF (catch-up is
 * the hooks adapter's job); smaller files are read from the start so fresh
 * sessions and newly-spawned agent transcripts are captured fully. */
const ATTACH_READ_LIMIT = 1024 * 1024;
const MAX_BYTES_PER_TICK = 512 * 1024;
const MAX_PARTIAL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 25;
const MAX_AGENT_TAILS = 100;
const MAX_WORKFLOWS = 50;
const MAP_CAP = 1000;

const EMPTY = Buffer.alloc(0);

interface FileTail {
  path: string;
  offset: number;
  rem: Buffer;
  attached: boolean;
}

interface AgentTail extends FileTail {
  agentId: string;
  workflowId?: string;
  started: boolean;
}

interface SessionTail {
  sessionId: string;
  cwd: string;
  projectDir: string;
  main: FileTail;
  lastStatus?: string;
  /** message.id → seen, for token_usage dedupe (one usage per API message). */
  usageSeen: Map<string, true>;
  /** toolu_ id → tool name, to interpret tool_results (AskUserQuestion etc). */
  toolNames: Map<string, string>;
  /** toolu_ id of an Agent/Task call → agentId that made the call. */
  spawnerByToolUse: Map<string, string>;
  /** toolu_ id of an Agent/Task call → sniffed role (e.g. gsd-planner). */
  roleByToolUse: Map<string, string>;
  /** meta.json toolUseId → spawned agentId, to detect agent completion. */
  spawnByToolUse: Map<string, string>;
  agents: Map<string, AgentTail>;
  workflowsAnnounced: Set<string>;
  journals: Map<string, FileTail>;
  parseErrorNoticed: boolean;
  agentCapNoticed: boolean;
  workflowCapNoticed: boolean;
}

interface RegistryEntry {
  sessionId: string;
  cwd: string;
  status: string;
}

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

/** Verified: project dir slug = cwd with '/' replaced by '-'. */
function flattenCwd(cwd: string): string {
  return cwd.replaceAll('/', '-');
}

/** Session ids are only ever used as a single path segment. The registry is
 * attacker-influenceable on-disk content, so anything with separators, '..',
 * or unexpected characters is rejected before it can reach a join(). */
function isSafeSessionId(id: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+$/.test(id) && !id.includes('/') && !id.includes('\\') && !id.includes('..')
  );
}

/** Redact then cap. Fail-closed: on redaction error the text is dropped. */
function safeChunk(s: string): { text: string; truncated: boolean } | undefined {
  try {
    return capChunk(redactText(s).text);
  } catch {
    return undefined;
  }
}

function clean(s: string, max = 500): string {
  try {
    return truncate(redactText(s).text, max);
  } catch {
    return '';
  }
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap = MAP_CAP): void {
  if (!map.has(key) && map.size >= cap) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

/** Read new complete lines from a tailed file. Partial trailing lines are
 * buffered (as bytes, so multi-byte chars never split). */
async function readNewLines(tail: FileTail): Promise<string[]> {
  const st = await stat(tail.path).catch(() => undefined);
  if (!st || !st.isFile()) return [];
  if (!tail.attached) {
    tail.attached = true;
    tail.offset = st.size > ATTACH_READ_LIMIT ? st.size : 0;
  }
  if (st.size < tail.offset) {
    // Truncated/rotated underneath us — restart from the top of the new file.
    tail.offset = 0;
    tail.rem = EMPTY;
  }
  if (st.size === tail.offset) return [];
  const toRead = Math.min(st.size - tail.offset, MAX_BYTES_PER_TICK);
  const fh = await open(tail.path, 'r');
  let combined: Buffer;
  try {
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, tail.offset);
    tail.offset += bytesRead;
    combined = Buffer.concat([tail.rem, buf.subarray(0, bytesRead)]);
  } finally {
    await fh.close();
  }
  const nl = combined.lastIndexOf(0x0a);
  if (nl === -1) {
    tail.rem = combined.length > MAX_PARTIAL_LINE_BYTES ? EMPTY : combined;
    return [];
  }
  const complete = combined.subarray(0, nl).toString('utf8');
  const rest = combined.subarray(nl + 1);
  tail.rem = rest.length > MAX_PARTIAL_LINE_BYTES ? EMPTY : rest;
  return complete.split('\n').filter((l) => l.trim().length > 0);
}

export function createTranscriptAdapter(config?: TranscriptAdapterConfig): Adapter {
  const claudeDir = config?.claudeDir ?? join(homedir(), '.claude');
  const pollMs = config?.pollMs ?? DEFAULT_POLL_MS;

  let ctx: AdapterContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let registryMissingNoticed = false;
  const sessions = new Map<string, SessionTail>();

  function emit(event: EventInit): void {
    ctx?.emit(event);
  }

  function nowTs(): string {
    return new Date().toISOString();
  }

  async function readRegistry(): Promise<Map<string, RegistryEntry>> {
    const live = new Map<string, RegistryEntry>();
    const dir = join(claudeDir, 'sessions');
    const names = await readdir(dir).catch(() => undefined);
    if (!names) {
      if (!registryMissingNoticed) {
        registryMissingNoticed = true;
        ctx?.log('info', `transcript: no session registry at ${dir} (is Claude Code installed?)`);
      }
      return live;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = await readFile(join(dir, name), 'utf8').catch(() => undefined);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const o = asObj(parsed);
      if (!o) continue;
      const sessionId = asStr(o.sessionId);
      const cwd = asStr(o.cwd);
      const status = asStr(o.status);
      if (!sessionId || !cwd) continue;
      if (!isSafeSessionId(sessionId)) continue; // hostile/path-traversing id
      // Stale pid files are pruned with a kill-0 liveness probe; entries
      // without a pid are assumed live (defensive: format may evolve).
      const pid = asNum(o.pid);
      if (pid !== undefined) {
        try {
          process.kill(pid, 0);
        } catch {
          continue; // process gone → stale registry file
        }
      }
      // Missing status = process still starting; wait for busy|idle.
      if (status !== 'busy' && status !== 'idle') continue;
      live.set(sessionId, { sessionId, cwd, status });
    }
    return live;
  }

  function ensureSessionTail(entry: RegistryEntry): SessionTail | undefined {
    let t = sessions.get(entry.sessionId);
    if (t) return t;
    // Defense in depth: however the registry cwd is shaped, the resolved
    // project dir must stay strictly under <claudeDir>/projects.
    const projectsRoot = resolve(claudeDir, 'projects');
    const projectDir = resolve(projectsRoot, flattenCwd(entry.cwd));
    if (!projectDir.startsWith(projectsRoot + sep)) return undefined;
    t = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      projectDir,
      main: {
        path: join(projectDir, `${entry.sessionId}.jsonl`),
        offset: 0,
        rem: EMPTY,
        attached: false,
      },
      usageSeen: new Map(),
      toolNames: new Map(),
      spawnerByToolUse: new Map(),
      roleByToolUse: new Map(),
      spawnByToolUse: new Map(),
      agents: new Map(),
      workflowsAnnounced: new Set(),
      journals: new Map(),
      parseErrorNoticed: false,
      agentCapNoticed: false,
      workflowCapNoticed: false,
    };
    sessions.set(entry.sessionId, t);
    // First sight of a session: announce it (so the picker and the window title
    // show the project name, not a raw id), then materialize the main agent.
    const projectName =
      entry.cwd
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop() || entry.sessionId;
    emit(
      makeEvent(
        'session_started',
        { ts: nowTs(), source: 'transcript', sessionId: entry.sessionId },
        { title: projectName, cwd: entry.cwd } as SessionStartedPayload,
      ),
    );
    emit(
      makeEvent(
        'agent_created',
        { ts: nowTs(), source: 'transcript', sessionId: entry.sessionId, agentId: MAIN_AGENT_ID },
        { name: 'Claude', kind: 'main' },
      ),
    );
    return t;
  }

  function noteParseError(t: SessionTail): void {
    if (t.parseErrorNoticed) return;
    t.parseErrorNoticed = true;
    emit(
      makeEvent(
        'adapter_notice',
        { ts: nowTs(), source: 'transcript', sessionId: t.sessionId },
        {
          level: 'warn',
          message:
            'transcript: skipped unparseable line(s) — on-disk format may have changed ' +
            '(parser verified against Claude Code 2.1.212)',
        },
      ),
    );
  }

  /** Handle one parsed JSONL line from a main or agent transcript. */
  function handleLine(t: SessionTail, line: string, agentId: string, workflowId?: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      noteParseError(t);
      return;
    }
    const o = asObj(parsed);
    if (!o) return;
    const ts = asStr(o.timestamp) ?? nowTs();
    const base = {
      ts,
      source: 'transcript' as const,
      sessionId: t.sessionId,
      ...(workflowId ? { workflowId } : {}),
    };

    switch (asStr(o.type)) {
      case 'assistant': {
        const msg = asObj(o.message);
        if (!msg) return;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const blockU of content) {
          const b = asObj(blockU);
          if (!b) continue;
          switch (asStr(b.type)) {
            case 'text': {
              const text = asStr(b.text);
              if (!text || text.trim().length === 0) break;
              const chunk = safeChunk(text);
              if (chunk) {
                emit(
                  makeEvent(
                    'agent_output',
                    { ...base, agentId },
                    {
                      stream: 'message',
                      chunk: chunk.text,
                      ...(chunk.truncated ? { truncated: true } : {}),
                    },
                  ),
                );
              }
              break;
            }
            case 'thinking': {
              const text = asStr(b.thinking);
              if (!text || text.trim().length === 0) break;
              const chunk = safeChunk(text);
              if (chunk) {
                emit(
                  makeEvent(
                    'agent_output',
                    { ...base, agentId },
                    {
                      stream: 'thinking',
                      chunk: chunk.text,
                      ...(chunk.truncated ? { truncated: true } : {}),
                    },
                  ),
                );
              }
              break;
            }
            case 'tool_use': {
              const id = asStr(b.id);
              if (!id) break;
              const name = asStr(b.name) ?? 'unknown';
              const input = asObj(b.input);
              boundedSet(t.toolNames, id, name);
              // Mirrors the hooks mapper so either source alone yields a
              // complete picture; the reducer dedupes on the toolu_ id.
              emit(
                makeEvent(
                  'agent_tool_called',
                  { ...base, agentId },
                  {
                    toolCallId: id,
                    tool: name,
                    inputSummary: clean(summarizeToolInput(name, b.input), 200),
                  },
                ),
              );
              if (name === 'Bash') {
                const command = asStr(input?.command);
                if (command) {
                  const description = asStr(input?.description);
                  emit(
                    makeEvent(
                      'agent_command_started',
                      { ...base, agentId },
                      {
                        commandId: id,
                        command: clean(command, 2000),
                        description: description ? clean(description, 200) : undefined,
                      },
                    ),
                  );
                }
              } else if (name === 'Read') {
                const filePath = asStr(input?.file_path);
                if (filePath) {
                  emit(
                    makeEvent(
                      'agent_file_read',
                      { ...base, agentId },
                      {
                        path: clean(filePath, 1024),
                      },
                    ),
                  );
                }
              } else if (name === 'Agent' || name === 'Task') {
                boundedSet(t.spawnerByToolUse, id, agentId);
                const role = sniffAgentRole(asStr(input?.subagent_type), asStr(input?.prompt));
                if (role) boundedSet(t.roleByToolUse, id, role);
              } else if (name === 'AskUserQuestion') {
                const questions = input && Array.isArray(input.questions) ? input.questions : [];
                const first = asObj(questions[0]);
                const q = first ? asStr(first.question) : undefined;
                emit(
                  makeEvent(
                    'user_input_requested',
                    { ...base, agentId },
                    {
                      requestId: id,
                      prompt: q ? clean(q, 300) : undefined,
                    },
                  ),
                );
              }
              break;
            }
            default:
              break; // redacted_thinking, images, future block types: skip
          }
        }
        // usage is duplicated on every content-block line of one API
        // message — dedupe by message.id, never sum blindly (verified).
        const msgId = asStr(msg.id);
        const usage = asObj(msg.usage);
        if (msgId && usage && !t.usageSeen.has(msgId)) {
          boundedSet(t.usageSeen, msgId, true);
          emit(
            makeEvent(
              'token_usage',
              { ...base, agentId },
              {
                usage: {
                  inputTokens: asNum(usage.input_tokens),
                  outputTokens: asNum(usage.output_tokens),
                  cacheReadTokens: asNum(usage.cache_read_input_tokens),
                },
              },
            ),
          );
        }
        break;
      }

      case 'user': {
        const msg = asObj(o.message);
        const content = msg && Array.isArray(msg.content) ? msg.content : [];
        for (const itemU of content) {
          const item = asObj(itemU);
          if (!item) continue;
          const itemType = asStr(item.type);
          if (itemType === 'tool_result') {
            const toolUseId = asStr(item.tool_use_id);
            if (!toolUseId) continue;
            const ok = item.is_error !== true;
            emit(
              makeEvent(
                'agent_tool_completed',
                { ...base, agentId },
                {
                  toolCallId: toolUseId,
                  ok,
                },
              ),
            );
            if (t.toolNames.get(toolUseId) === 'AskUserQuestion') {
              emit(
                makeEvent('user_input_provided', { ...base, agentId }, { requestId: toolUseId }),
              );
            }
            // A tool_result for the toolu_ id that spawned an agent is the
            // clean completion signal for plain subagents (verified).
            const spawnedAgent = t.spawnByToolUse.get(toolUseId);
            if (spawnedAgent) {
              const resultText = asStr(item.content);
              emit(
                makeEvent(
                  'agent_completed',
                  { ...base, agentId: spawnedAgent },
                  {
                    summary: resultText ? clean(resultText, 500) : undefined,
                  },
                ),
              );
            }
            // toolUseResult: structured, richer mirror of the tool_result —
            // its shape identifies the originating tool.
            const tr = asObj(o.toolUseResult);
            if (tr) {
              if (typeof tr.stdout === 'string' || typeof tr.stderr === 'string') {
                // Bash shape
                const stdout = asStr(tr.stdout);
                const stderr = asStr(tr.stderr);
                if (stdout && stdout.trim().length > 0) {
                  const chunk = safeChunk(stdout);
                  if (chunk) {
                    emit(
                      makeEvent(
                        'agent_output',
                        { ...base, agentId },
                        {
                          stream: 'stdout',
                          chunk: chunk.text,
                          ...(chunk.truncated ? { truncated: true } : {}),
                        },
                      ),
                    );
                  }
                }
                if (stderr && stderr.trim().length > 0) {
                  const chunk = safeChunk(stderr);
                  if (chunk) {
                    emit(
                      makeEvent(
                        'agent_output',
                        { ...base, agentId },
                        {
                          stream: 'stderr',
                          chunk: chunk.text,
                          ...(chunk.truncated ? { truncated: true } : {}),
                        },
                      ),
                    );
                  }
                }
                emit(
                  makeEvent(
                    'agent_command_completed',
                    { ...base, agentId },
                    {
                      commandId: toolUseId,
                      ok: ok && tr.interrupted !== true,
                    },
                  ),
                );
              } else if (asStr(tr.filePath) && Array.isArray(tr.structuredPatch)) {
                // Edit/Write shape
                const originalFile = asStr(tr.originalFile) ?? '';
                emit(
                  makeEvent(
                    'agent_file_modified',
                    { ...base, agentId },
                    {
                      path: clean(asStr(tr.filePath) ?? '', 1024),
                      changeKind: originalFile === '' ? 'created' : 'edited',
                    },
                  ),
                );
              } else {
                const file = asObj(tr.file);
                const filePath = file ? asStr(file.filePath) : undefined;
                if (filePath) {
                  // Read shape
                  emit(
                    makeEvent(
                      'agent_file_read',
                      { ...base, agentId },
                      {
                        path: clean(filePath, 1024),
                      },
                    ),
                  );
                }
              }
            }
          } else if (itemType === 'text') {
            const text = asStr(item.text);
            if (text && text.includes('[Request interrupted by user]')) {
              // Interrupt cancels the TURN, not the main agent — main stays
              // alive, so lifecycle 'cancelled' would be wrong here.
              emit(
                makeEvent(
                  'agent_status_changed',
                  { ...base, agentId },
                  {
                    activity: 'idle',
                    reason: 'interrupted',
                    currentAction: '',
                  },
                ),
              );
              emit(
                makeEvent(
                  'adapter_notice',
                  { ...base },
                  {
                    level: 'info',
                    message: 'request interrupted by user',
                  },
                ),
              );
            }
          }
        }
        break;
      }

      case 'system': {
        const subtype = asStr(o.subtype);
        if (subtype === 'api_error') {
          const err = asObj(o.error);
          const message = err ? asStr(err.message) : undefined;
          emit(
            makeEvent(
              'adapter_notice',
              { ...base },
              {
                level: 'warn',
                message: `api error (retrying): ${message ? clean(message, 300) : 'unknown'}`,
              },
            ),
          );
        } else if (subtype === 'compact_boundary') {
          emit(
            makeEvent(
              'adapter_notice',
              { ...base },
              { level: 'info', message: 'context compacted' },
            ),
          );
        }
        break;
      }

      default:
        break; // attachment, queue-operation, ai-title, ...: skip
    }
  }

  /** Discover agent-*.{jsonl,meta.json} files in a subagents (or wf_*) dir. */
  async function scanAgentDir(
    t: SessionTail,
    dir: string,
    workflowId: string | undefined,
  ): Promise<void> {
    const names = await readdir(dir).catch(() => undefined);
    if (!names) return;
    const seen = new Set<string>();
    for (const name of names) {
      const m = /^agent-([A-Za-z0-9_-]+?)(?:\.meta)?\.(?:jsonl|json)$/.exec(name);
      const id = m?.[1];
      if (!id || seen.has(id) || t.agents.has(id)) {
        if (id) seen.add(id);
        continue;
      }
      seen.add(id);
      if (t.agents.size >= MAX_AGENT_TAILS) {
        if (!t.agentCapNoticed) {
          t.agentCapNoticed = true;
          ctx?.log('warn', `transcript: agent tail cap reached for session ${t.sessionId}`);
        }
        continue;
      }
      let meta: Raw | undefined;
      const metaRaw = await readFile(join(dir, `agent-${id}.meta.json`), 'utf8').catch(
        () => undefined,
      );
      if (metaRaw) {
        try {
          meta = asObj(JSON.parse(metaRaw));
        } catch {
          meta = undefined;
        }
      }
      const description = meta ? asStr(meta.description) : undefined;
      const toolUseId = meta ? asStr(meta.toolUseId) : undefined;
      const parent = (toolUseId && t.spawnerByToolUse.get(toolUseId)) || MAIN_AGENT_ID;
      const base = {
        ts: nowTs(),
        source: 'transcript' as const,
        sessionId: t.sessionId,
        ...(workflowId ? { workflowId } : {}),
      };
      emit(
        makeEvent(
          'agent_created',
          { ...base, agentId: id },
          {
            name: description ? clean(description, 120) : id,
            kind: workflowId ? 'workflow-agent' : 'subagent',
            // Prefer the role sniffed from the spawning prompt (gsd spawns
            // planners as 'general-purpose'); fall back to meta agentType.
            agentType:
              (toolUseId ? t.roleByToolUse.get(toolUseId) : undefined) ??
              (meta ? asStr(meta.agentType) : undefined),
            parentAgentId: parent,
          },
        ),
      );
      emit(
        makeEvent(
          'dependency_created',
          { ...base },
          {
            fromAgentId: parent,
            toAgentId: id,
            kind: 'spawns',
          },
        ),
      );
      if (toolUseId) boundedSet(t.spawnByToolUse, toolUseId, id);
      t.agents.set(id, {
        agentId: id,
        workflowId,
        path: join(dir, `agent-${id}.jsonl`),
        offset: 0,
        rem: EMPTY,
        attached: false,
        started: false,
      });
    }
  }

  async function scanWorkflows(t: SessionTail): Promise<void> {
    const wfRoot = join(t.projectDir, t.sessionId, 'subagents', 'workflows');
    const names = await readdir(wfRoot).catch(() => undefined);
    if (!names) return;
    for (const name of names) {
      if (!name.startsWith('wf_')) continue;
      if (!t.workflowsAnnounced.has(name)) {
        // Bounded like agents: past the cap, new wf_* dirs are ignored so
        // workflowsAnnounced/journals cannot grow without limit.
        if (t.workflowsAnnounced.size >= MAX_WORKFLOWS) {
          if (!t.workflowCapNoticed) {
            t.workflowCapNoticed = true;
            ctx?.log('warn', `transcript: workflow cap reached for session ${t.sessionId}`);
          }
          continue;
        }
        t.workflowsAnnounced.add(name);
        emit(
          makeEvent(
            'workflow_started',
            { ts: nowTs(), source: 'transcript', sessionId: t.sessionId, workflowId: name },
            { name, kind: 'workflow' },
          ),
        );
        t.journals.set(name, {
          path: join(wfRoot, name, 'journal.jsonl'),
          offset: 0,
          rem: EMPTY,
          attached: false,
        });
      }
      await scanAgentDir(t, join(wfRoot, name), name);
    }
  }

  function handleJournalLine(t: SessionTail, workflowId: string, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const o = asObj(parsed);
    if (!o) return;
    const agentId = asStr(o.agentId);
    if (!agentId) return;
    const base = { ts: nowTs(), source: 'transcript' as const, sessionId: t.sessionId, workflowId };
    const type = asStr(o.type);
    if (type === 'started') {
      emit(makeEvent('agent_started', { ...base, agentId }, {}));
      const tail = t.agents.get(agentId);
      if (tail) tail.started = true;
    } else if (type === 'result') {
      // journal.jsonl {type:'result'} is the earliest clean per-agent
      // completion signal — never wait on the end-of-run wf_*.json summary.
      emit(makeEvent('agent_completed', { ...base, agentId }, {}));
    }
  }

  async function pollSession(t: SessionTail, entry: RegistryEntry): Promise<void> {
    // Registry status → light-touch main-agent activity (only on change).
    if (entry.status !== t.lastStatus) {
      t.lastStatus = entry.status;
      emit(
        makeEvent(
          'agent_status_changed',
          { ts: nowTs(), source: 'transcript', sessionId: t.sessionId, agentId: MAIN_AGENT_ID },
          { activity: entry.status === 'busy' ? 'thinking' : 'idle' },
        ),
      );
    }
    // Subagent/workflow discovery BEFORE reading transcripts so spawn maps
    // exist when the main transcript's tool_results are processed.
    await scanAgentDir(t, join(t.projectDir, t.sessionId, 'subagents'), undefined);
    await scanWorkflows(t);
    for (const line of await readNewLines(t.main)) {
      handleLine(t, line, MAIN_AGENT_ID);
    }
    for (const tail of t.agents.values()) {
      const lines = await readNewLines(tail);
      if (lines.length > 0 && !tail.started) {
        tail.started = true;
        emit(
          makeEvent(
            'agent_started',
            {
              ts: nowTs(),
              source: 'transcript',
              sessionId: t.sessionId,
              agentId: tail.agentId,
              ...(tail.workflowId ? { workflowId: tail.workflowId } : {}),
            },
            {},
          ),
        );
      }
      for (const line of lines) {
        handleLine(t, line, tail.agentId, tail.workflowId);
      }
    }
    for (const [workflowId, journal] of t.journals) {
      for (const line of await readNewLines(journal)) {
        handleJournalLine(t, workflowId, line);
      }
    }
  }

  async function poll(): Promise<void> {
    if (!ctx || polling) return;
    polling = true;
    try {
      const live = await readRegistry();
      // Close tails whose session vanished from the registry (ended or
      // stale) — bounded memory: nothing outlives its registry entry.
      for (const sessionId of [...sessions.keys()]) {
        if (!live.has(sessionId)) sessions.delete(sessionId);
      }
      let attached = 0;
      for (const entry of live.values()) {
        if (!sessions.has(entry.sessionId) && sessions.size >= MAX_SESSIONS) continue;
        attached += 1;
        if (attached > MAX_SESSIONS) break;
        const t = ensureSessionTail(entry);
        if (!t) continue; // rejected: resolved project path escapes claudeDir
        try {
          await pollSession(t, entry);
        } catch (err) {
          ctx?.log('warn', `transcript: session ${entry.sessionId} poll failed: ${String(err)}`);
        }
      }
    } catch (err) {
      ctx?.log('warn', `transcript: poll failed: ${String(err)}`);
    } finally {
      polling = false;
    }
  }

  return {
    name: 'transcript',
    start(c: AdapterContext) {
      ctx = c;
      timer = setInterval(() => {
        void poll();
      }, pollMs);
      void poll();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      ctx = undefined;
      sessions.clear();
    },
  };
}
