/**
 * visual-workflows connect/disconnect — additive, reversible hook
 * registration in Claude Code settings (docs/ADAPTERS.md section A).
 *
 * Guarantees: never touches hooks that aren't ours (6 SessionStart hooks
 * were observed coexisting on one machine — multiplicity is normal), always
 * shows a real diff and asks for confirmation (unless --yes), and always
 * writes a timestamped backup before modifying anything.
 */
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { resolveDataDir } from '../auth.js';

interface CliArgs {
  project: boolean;
  yes: boolean;
  port?: number;
  settings?: string;
  autoOpen: boolean;
  repo?: string;
  error?: string;
}

interface HookEventDef {
  event: string;
  matcher?: string;
}

/** Registration list per ADAPTERS.md — matcher '*' only for tool events. */
const HOOK_EVENTS: HookEventDef[] = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '*' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PostToolUseFailure', matcher: '*' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
  { event: 'PermissionRequest' },
  { event: 'Notification' },
];

type Raw = Record<string, unknown>;

function asObj(v: unknown): Raw | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { project: false, yes: false, autoOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--project':
        args.project = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--auto-open':
        args.autoOpen = true;
        break;
      case '--repo': {
        const v = argv[++i];
        if (!v) {
          args.error = '--repo requires a path';
          return args;
        }
        args.repo = v;
        break;
      }
      case '--port': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0 || v > 65535) {
          args.error = '--port requires a port number (1-65535)';
          return args;
        }
        args.port = v;
        break;
      }
      case '--settings': {
        const v = argv[++i];
        if (!v) {
          args.error = '--settings requires a file path';
          return args;
        }
        args.settings = v;
        break;
      }
      default:
        args.error = `unknown flag: ${String(flag)}`;
        return args;
    }
  }
  return args;
}

function settingsPathFor(args: CliArgs): string {
  if (args.settings) return resolve(args.settings);
  if (args.project) return resolve('.claude/settings.json');
  return resolve(homedir(), '.claude', 'settings.json');
}

/** Absolute path to the dependency-free forwarder script. */
export function forwarderPath(): string {
  return resolve(fileURLToPath(new URL('../../../hook-adapter/src/forward.mjs', import.meta.url)));
}

function buildCommand(port?: number): string {
  const prefix = port && port !== 4777 ? `VW_PORT=${port} ` : '';
  // The forwarder path is quoted so the command survives paths with spaces.
  return `${prefix}node "${forwarderPath()}"`;
}

/** Repo root, derived from the forwarder's known location. */
function repoRoot(): string {
  return resolve(dirname(forwarderPath()), '..', '..', '..');
}

/**
 * Auto-open config read by the forwarder (packages/hook-adapter/src/forward.mjs).
 * `startCommand` builds the UI and serves it without opening a browser (the
 * forwarder does the opening on first spawn); the forwarder passes the port
 * via the child env.
 */
async function writeAutoOpenConfig(args: CliArgs): Promise<string> {
  const dataDir = resolveDataDir(process.env);
  const root = args.repo ? resolve(args.repo) : repoRoot();
  const config = {
    autoOpen: true,
    autoClose: true,
    port: args.port ?? 4777,
    startCommand: `npm --prefix "${root}" run serve`,
  };
  // Restrictive perms, matching auth.ts (data dir 0700, files 0600): the
  // config can carry a repo path / port and is only ever read by this user.
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeAtomic(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 0o600);
  return join(dataDir, 'config.json');
}

async function removeAutoOpenConfig(): Promise<void> {
  try {
    await rm(join(resolveDataDir(process.env), 'config.json'), { force: true });
  } catch {
    /* best-effort */
  }
}

type LoadResult = { ok: true; settings: Raw; existed: boolean } | { ok: false; error: string };

async function loadSettings(path: string): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // Only "file does not exist" means a fresh install. Any other read
    // failure (permissions, I/O error, path is a directory, …) must abort:
    // proceeding would replace a file we could not actually inspect.
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { ok: true, settings: {}, existed: false };
    }
    return { ok: false, error: `cannot read settings file (${String(err)})` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const settings = asObj(parsed);
    if (!settings) return { ok: false, error: 'settings file is not a JSON object' };
    return { ok: true, settings, existed: true };
  } catch (err) {
    return { ok: false, error: `settings file is not valid JSON (${String(err)})` };
  }
}

/* ------------------------------- diff -------------------------------- */

interface DiffOp {
  kind: ' ' | '+' | '-';
  line: string;
}

function diffLines(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= m; i++) table.push(new Uint32Array(n + 1));
  const at = (i: number, j: number): number => table[i]?.[j] ?? 0;
  for (let i = m - 1; i >= 0; i--) {
    const row = table[i];
    if (!row) continue;
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] ?? '' });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: '-', line: a[i] ?? '' });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] ?? '' });
      j++;
    }
  }
  while (i < m) ops.push({ kind: '-', line: a[i++] ?? '' });
  while (j < n) ops.push({ kind: '+', line: b[j++] ?? '' });
  return ops;
}

/** Print a diff of the hooks sections, eliding long unchanged runs. */
function printHooksDiff(before: unknown, after: unknown): void {
  const a = JSON.stringify(before ?? {}, null, 2).split('\n');
  const b = JSON.stringify(after ?? {}, null, 2).split('\n');
  const ops = diffLines(a, b);
  const keep = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.kind !== ' ') {
      for (let k = idx - 2; k <= idx + 2; k++) keep.add(k);
    }
  });
  let elided = false;
  ops.forEach((op, idx) => {
    if (keep.has(idx)) {
      console.log(`  ${op.kind} ${op.line}`);
      elided = false;
    } else if (!elided) {
      console.log('    …');
      elided = true;
    }
  });
}

/* ---------------------------- merge logic ----------------------------- */

/**
 * Matches exactly the command shapes buildCommand() emits — the current
 * quoted form (`node "…/forward.mjs"`, optionally VW_PORT-prefixed) plus the
 * legacy unquoted form written by older installs (a single whitespace-free
 * path token). Anchored on both ends so a user hook that merely mentions
 * forward.mjs as an argument is never mistaken for ours.
 */
const OUR_COMMAND_RE = /^(?:VW_PORT=\d+ )?node ("[^"]*forward\.mjs"|\S*forward\.mjs)$/;

function isOurCommand(command: unknown): boolean {
  return typeof command === 'string' && OUR_COMMAND_RE.test(command);
}

/** Our installed hook objects (by exact command shape) within one event array. */
function findOurHooks(arr: unknown[]): Raw[] {
  const out: Raw[] = [];
  for (const group of arr) {
    const g = asObj(group);
    if (!g || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) {
      const hook = asObj(h);
      if (hook && isOurCommand(hook.command)) out.push(hook);
    }
  }
  return out;
}

async function confirmOrAbort(yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error('not a TTY and --yes not given — refusing to modify settings.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Apply these changes? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Atomic write: write to a temp file in the same directory, then rename()
 * over the target. rename(2) is atomic on the same filesystem, so a crash
 * mid-write can never leave a truncated/unparseable file behind.
 */
async function writeAtomic(path: string, data: string, mode?: number): Promise<void> {
  const tmp = `${path}.vw-tmp-${process.pid}`;
  await writeFile(tmp, data, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  // writeFile only applies `mode` when it creates the file; a leftover temp
  // could keep looser perms, so chmod explicitly (best-effort — Windows/FS
  // without POSIX modes just no-op). rename(2) preserves the mode.
  if (mode !== undefined) {
    try {
      await chmod(tmp, mode);
    } catch {
      /* best effort */
    }
  }
  await rename(tmp, path);
}

async function backupAndWrite(path: string, existed: boolean, settings: Raw): Promise<string> {
  let backupPath = '';
  if (existed) {
    backupPath = `${path}.vw-backup-${Date.now()}`;
    // Backup goes through the same temp-then-rename dance so a partial copy
    // can never masquerade as a complete backup.
    const tmpBackup = `${backupPath}.vw-tmp-${process.pid}`;
    await copyFile(path, tmpBackup);
    await rename(tmpBackup, backupPath);
  } else {
    await mkdir(dirname(path), { recursive: true });
  }
  await writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
  return backupPath;
}

/* ------------------------------ connect ------------------------------- */

export async function runConnect(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`visual-workflows connect: ${args.error}`);
    console.error(
      'usage: visual-workflows connect [--project] [--yes] [--port <n>] [--auto-open] [--repo <path>]',
    );
    return 1;
  }
  const path = settingsPathFor(args);
  const loaded = await loadSettings(path);
  if (!loaded.ok) {
    console.error(`visual-workflows connect: cannot modify ${path}: ${loaded.error}`);
    console.error('fix (or move aside) the file and re-run connect.');
    return 1;
  }
  const { settings, existed } = loaded;
  const hooksVal = settings.hooks;
  if (hooksVal !== undefined && !asObj(hooksVal)) {
    console.error(`visual-workflows connect: unexpected "hooks" shape in ${path} — aborting.`);
    return 1;
  }
  const hooks = asObj(hooksVal) ?? {};
  settings.hooks = hooks;
  const before = structuredClone(hooks);

  const command = buildCommand(args.port);
  let added = 0;
  let updated = 0;
  for (const def of HOOK_EVENTS) {
    const existingVal = hooks[def.event];
    if (existingVal !== undefined && !Array.isArray(existingVal)) {
      console.log(`  ! skipping ${def.event}: existing entry is not an array`);
      continue;
    }
    const arr: unknown[] = Array.isArray(existingVal) ? existingVal : [];
    hooks[def.event] = arr;
    // Never duplicate: a previous install is detected by our exact command
    // shape. If its command differs (e.g. connect re-run with a different
    // --port), rewrite it in place rather than silently doing nothing.
    const ours = findOurHooks(arr);
    if (ours.length > 0) {
      for (const hook of ours) {
        if (hook.command !== command) {
          hook.command = command;
          updated += 1;
        }
      }
      continue;
    }
    arr.push({
      ...(def.matcher ? { matcher: def.matcher } : {}),
      hooks: [{ type: 'command', command, timeout: 5 }],
    });
    added += 1;
  }

  if (added === 0 && updated === 0) {
    // Hooks are already in place, but the user may be (re-)enabling auto-open,
    // which lives in a separate config file — honor the flag regardless.
    if (args.autoOpen) {
      const cfg = await writeAutoOpenConfig(args);
      console.log(`Auto-open enabled (hooks already installed). Config: ${cfg}`);
    } else {
      console.log(`visual-workflows hooks already installed in ${path} — nothing to do.`);
    }
    return 0;
  }

  if (added > 0) {
    console.log(`Registering ${added} visual-workflows hook entr${added === 1 ? 'y' : 'ies'} in:`);
  }
  if (updated > 0) {
    console.log(
      `Updating ${updated} visual-workflows hook entr${updated === 1 ? 'y' : 'ies'} (command changed) in:`,
    );
  }
  console.log(`  ${path}`);
  console.log('');
  console.log('Changes to the "hooks" section (additive — existing hooks untouched):');
  printHooksDiff(before, hooks);
  console.log('');

  if (!(await confirmOrAbort(args.yes))) {
    console.log('aborted — settings unchanged.');
    return 1;
  }

  const backupPath = await backupAndWrite(path, existed, settings);
  console.log('');
  console.log('visual-workflows hooks installed.');
  if (backupPath) console.log(`Backup written to ${backupPath}`);
  if (args.autoOpen) {
    const cfg = await writeAutoOpenConfig(args);
    console.log('');
    console.log('Auto-open enabled: the dashboard opens itself the first time a session');
    console.log('spawns agents (starting the bridge if needed), and offers to close when');
    console.log(`the run ends. Config: ${cfg}`);
  }
  console.log('');
  console.log('Next steps:');
  console.log('  1. Start the bridge from a clone: npm run vw -- start (add --watch-claude');
  console.log('     to also enable the transcript tailer for richer detail).');
  console.log('  2. Open a NEW Claude Code session — hooks load at session start.');
  console.log(`  3. Watch it live at http://127.0.0.1:${args.port ?? 4777}`);
  console.log('');
  console.log('Undo anytime: visual-workflows disconnect');
  return 0;
}

/* ----------------------------- disconnect ----------------------------- */

export async function runDisconnect(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`visual-workflows disconnect: ${args.error}`);
    console.error('usage: visual-workflows disconnect [--project] [--yes]');
    return 1;
  }
  const path = settingsPathFor(args);
  const loaded = await loadSettings(path);
  if (!loaded.ok) {
    console.error(`visual-workflows disconnect: cannot modify ${path}: ${loaded.error}`);
    return 1;
  }
  if (!loaded.existed) {
    console.log(`${path} does not exist — nothing to remove.`);
    return 0;
  }
  const { settings } = loaded;
  const hooks = asObj(settings.hooks);
  if (!hooks) {
    console.log(`no hooks section in ${path} — nothing to remove.`);
    return 0;
  }
  const before = structuredClone(hooks);

  let removed = 0;
  for (const eventName of Object.keys(hooks)) {
    const arr = hooks[eventName];
    if (!Array.isArray(arr)) continue;
    let removedInEvent = 0;
    const nextGroups: unknown[] = [];
    for (const group of arr) {
      const g = asObj(group);
      if (!g || !Array.isArray(g.hooks)) {
        nextGroups.push(group); // unrecognized shape: never touch
        continue;
      }
      const kept = g.hooks.filter((h) => {
        const ours = isOurCommand(asObj(h)?.command);
        if (ours) removedInEvent += 1;
        return !ours;
      });
      if (kept.length > 0 || g.hooks.length === 0) {
        nextGroups.push({ ...g, hooks: kept });
      }
      // group emptied by our removal → dropped entirely
    }
    if (removedInEvent > 0) {
      removed += removedInEvent;
      if (nextGroups.length > 0) hooks[eventName] = nextGroups;
      else delete hooks[eventName];
    }
  }

  if (removed === 0) {
    console.log(`no visual-workflows hooks found in ${path} — nothing to remove.`);
    return 0;
  }

  console.log(`Removing ${removed} visual-workflows hook entr${removed === 1 ? 'y' : 'ies'} from:`);
  console.log(`  ${path}`);
  console.log('');
  console.log('Changes to the "hooks" section (only our entries are removed):');
  printHooksDiff(before, hooks);
  console.log('');

  if (!(await confirmOrAbort(args.yes))) {
    console.log('aborted — settings unchanged.');
    return 1;
  }

  const backupPath = await backupAndWrite(path, true, settings);
  await removeAutoOpenConfig();
  console.log('');
  console.log('visual-workflows hooks removed.');
  if (backupPath) console.log(`Backup written to ${backupPath}`);
  return 0;
}
