/**
 * Recorder — opt-in JSONL recordings (--record / VW_RECORD=1).
 *
 * One file per session under <dataDir>/recordings/, named
 * `<iso-ts>-<sessionId>.jsonl`. First line is a header, then one event
 * envelope per line (docs/EVENT_PROTOCOL.md "Recording format"). Replay is
 * client-side: the bridge only lists and serves the raw event arrays.
 *
 * Retention: at most `maxRecordings` files (default 50); oldest deleted when
 * a new recording starts, except files still being recorded (deleting one
 * would leave the next append writing a headerless file). Reads are
 * tolerant: unparseable lines are skipped,
 * both `vw-recording` and the spec's older `wfx-recording` header kinds are
 * accepted, and a missing examples directory is fine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyEvent, RecordingSummary } from '@visual-workflows/protocol';
import { parseEventEnvelope } from '@visual-workflows/protocol';

export interface RecordingHeader {
  kind: 'vw-recording';
  v: 1;
  sessionId: string;
  label: string;
  createdAt: string;
}

const HEADER_KINDS = new Set(['vw-recording', 'wfx-recording']);
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Bundled sample recordings, resolved relative to the repo root. */
export function defaultExamplesDir(): string {
  return fileURLToPath(new URL('../../../examples/recordings/', import.meta.url));
}

export interface RecorderOptions {
  /** Bridge data dir; recordings go in `<dataDir>/recordings`. */
  dataDir: string;
  /** Override for the bundled examples dir (tests). Absence is tolerated. */
  examplesDir?: string;
  /** Max user recordings kept on disk. */
  maxRecordings?: number;
}

interface OpenRecording {
  filePath: string;
}

export class Recorder {
  readonly recordingsDir: string;
  private readonly examplesDir: string;
  private readonly maxRecordings: number;
  private readonly open = new Map<string, OpenRecording>();
  /** id -> absolute file path, rebuilt on every list(). */
  private index = new Map<string, string>();

  constructor(opts: RecorderOptions) {
    this.recordingsDir = path.join(opts.dataDir, 'recordings');
    this.examplesDir = opts.examplesDir ?? defaultExamplesDir();
    this.maxRecordings = opts.maxRecordings ?? 50;
  }

  /**
   * Append one accepted event to its session's recording, creating the file
   * (header first) on the session's first event. Synchronous appends keep
   * ordering trivial and are cheap at local event rates.
   */
  handleEvent(event: AnyEvent): void {
    try {
      let rec = this.open.get(event.sessionId);
      if (!rec) {
        rec = this.createRecording(event);
      }
      fs.appendFileSync(rec.filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      // An ended session's file is closed (and becomes eligible for
      // retention); appending it first keeps the ending in the recording.
      if (event.type === 'session_ended') this.open.delete(event.sessionId);
    } catch {
      /* recording failures must never break the live stream */
    }
  }

  /** Stop writing (files are already flushed; just forget open sessions). */
  stop(): void {
    this.open.clear();
  }

  private createRecording(first: AnyEvent): OpenRecording {
    fs.mkdirSync(this.recordingsDir, { recursive: true, mode: 0o700 });
    const createdAt = new Date().toISOString();
    const safeTs = createdAt.replace(/[:.]/g, '-');
    const safeSession = first.sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    const filePath = path.join(this.recordingsDir, `${safeTs}-${safeSession}.jsonl`);
    const title =
      first.type === 'session_started' &&
      typeof (first.payload as { title?: unknown }).title === 'string'
        ? (first.payload as { title: string }).title
        : undefined;
    const header: RecordingHeader = {
      kind: 'vw-recording',
      v: 1,
      sessionId: first.sessionId,
      label: title ?? first.sessionId,
      createdAt,
    };
    fs.writeFileSync(filePath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
    // Register before enforcing retention so the new file (and every other
    // still-recording session's file) is never the one deleted.
    const rec: OpenRecording = { filePath };
    this.open.set(first.sessionId, rec);
    this.enforceRetention();
    return rec;
  }

  /**
   * Keep at most maxRecordings files; iso-ts filename prefix sorts oldest
   * first. Files still held open by this recorder are never deleted —
   * unlinking one would make the next append silently recreate it headerless
   * — so the count can transiently exceed the cap while sessions record.
   */
  private enforceRetention(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.recordingsDir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return;
    }
    names.sort();
    const openNames = new Set(Array.from(this.open.values(), (rec) => path.basename(rec.filePath)));
    let excess = names.length - this.maxRecordings;
    for (const name of names) {
      if (excess <= 0) break;
      if (openNames.has(name)) continue;
      try {
        fs.unlinkSync(path.join(this.recordingsDir, name));
        excess -= 1;
      } catch {
        /* ignore — retention is best effort */
      }
    }
  }

  /** User recordings merged with bundled examples (absence tolerated). */
  async list(): Promise<RecordingSummary[]> {
    const out: RecordingSummary[] = [];
    const index = new Map<string, string>();
    for (const { dir, prefix } of [
      { dir: this.recordingsDir, prefix: '' },
      { dir: this.examplesDir, prefix: 'ex-' },
    ]) {
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue; // dir missing — fine
      }
      names.sort();
      for (const name of names) {
        const filePath = path.join(dir, name);
        const id = `${prefix}${name.slice(0, -'.jsonl'.length)}`;
        if (!SAFE_ID_RE.test(id) || index.has(id)) continue;
        const summary = summarizeFile(id, filePath);
        if (summary) {
          index.set(id, filePath);
          out.push(summary);
        }
      }
    }
    this.index = index;
    return out;
  }

  /** Parse a recording tolerantly: header skipped, bad lines dropped. */
  async read(id: string): Promise<{ header?: RecordingHeader; events: AnyEvent[] } | undefined> {
    if (!SAFE_ID_RE.test(id)) return undefined;
    if (!this.index.has(id)) await this.list();
    const filePath = this.index.get(id);
    if (!filePath) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
    let header: RecordingHeader | undefined;
    const events: AnyEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // tolerate torn/corrupt lines
      }
      const kind = (parsed as { kind?: unknown }).kind;
      if (typeof kind === 'string' && HEADER_KINDS.has(kind)) {
        header ??= parsed as RecordingHeader;
        continue;
      }
      const result = parseEventEnvelope(parsed);
      if (result.ok) events.push(result.event);
    }
    return { header, events };
  }
}

function summarizeFile(id: string, filePath: string): RecordingSummary | undefined {
  let raw: string;
  let mtime: Date;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
    mtime = fs.statSync(filePath).mtime;
  } catch {
    return undefined;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const firstLine = lines[0];
  let header: Partial<RecordingHeader> | undefined;
  let firstEvent: { sessionId?: unknown; ts?: unknown } | undefined;
  if (firstLine !== undefined) {
    try {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      if (typeof parsed.kind === 'string' && HEADER_KINDS.has(parsed.kind)) {
        header = parsed as Partial<RecordingHeader>;
      } else {
        firstEvent = parsed;
      }
    } catch {
      /* tolerate — summarized from filename below */
    }
  }
  const sessionId =
    (typeof header?.sessionId === 'string' && header.sessionId) ||
    (typeof firstEvent?.sessionId === 'string' && firstEvent.sessionId) ||
    'unknown';
  const createdAt =
    (typeof header?.createdAt === 'string' && header.createdAt) ||
    (typeof firstEvent?.ts === 'string' && firstEvent.ts) ||
    mtime.toISOString();
  return {
    id,
    label: typeof header?.label === 'string' && header.label.length > 0 ? header.label : id,
    sessionId,
    createdAt,
    eventCount: Math.max(0, lines.length - (header ? 1 : 0)),
  };
}
