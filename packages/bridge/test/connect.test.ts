/**
 * runConnect/runDisconnect tests — additive, reversible hook registration
 * (docs/ADAPTERS.md section A). Target settings path is injected via the
 * CLI's own `--settings <path>` flag (packages/bridge/src/connect/index.ts
 * settingsPathFor()), so these tests never touch the real ~/.claude.
 *
 * `--yes` is passed everywhere except the one test that specifically proves
 * the non-interactive abort path — that path is made hang-proof by forcing
 * process.stdin.isTTY to false before calling, regardless of how this test
 * happens to be invoked (confirmOrAbort only calls readline.question() when
 * isTTY is true).
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwarderPath, runConnect, runDisconnect } from '../src/connect/index.js';

type Raw = Record<string, unknown>;

let dir: string;
let settingsPath: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vw-connect-'));
  settingsPath = join(dir, 'settings.json');
  // Isolate the data dir: runDisconnect() removes config.json from
  // resolveDataDir(), which without this is the developer's REAL
  // ~/.visual-workflows — so running the suite would wipe their auto-open
  // config. Point every connect/disconnect test at a throwaway dir.
  prevDataDir = process.env.VW_DATA_DIR;
  process.env.VW_DATA_DIR = join(dir, 'data');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevDataDir === undefined) delete process.env.VW_DATA_DIR;
  else process.env.VW_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function readSettings(): Raw {
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as Raw;
}

function backupFiles(): string[] {
  return readdirSync(dirname(settingsPath)).filter((f) =>
    f.startsWith(`${basename(settingsPath)}.vw-backup-`),
  );
}

/** Every {type:"command", command} entry under hooks.<event>[].hooks[]. */
function allCommands(hooks: Raw): string[] {
  const out: string[] = [];
  for (const arr of Object.values(hooks)) {
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      const g = group as { hooks?: Array<{ command?: string }> };
      for (const h of g.hooks ?? []) if (h.command) out.push(h.command);
    }
  }
  return out;
}

const UNRELATED_HOOK = { type: 'command', command: 'node ~/.claude/other-hook.js', timeout: 10 };

function writeFixtureSettings(): void {
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        keepMe: 'untouched',
        hooks: { SessionStart: [{ hooks: [UNRELATED_HOOK] }] },
      },
      null,
      2,
    ),
  );
}

describe('runConnect', () => {
  it('sanity: forwarderPath resolves to the real hook-adapter forwarder script', () => {
    expect(forwarderPath()).toMatch(/hook-adapter[/\\]src[/\\]forward\.mjs$/);
  });

  it('is additive: installs our hooks across all registered events, preserving an existing hook and unrelated keys', async () => {
    writeFixtureSettings();
    const code = await runConnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);

    const settings = readSettings();
    expect(settings.keepMe).toBe('untouched'); // unrelated top-level key untouched

    const hooks = settings.hooks as Raw;
    // The pre-existing SessionStart hook survives alongside ours.
    const sessionStart = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(
      sessionStart.some((g) => g.hooks.some((h) => h.command === UNRELATED_HOOK.command)),
    ).toBe(true);

    // Every documented event now has a group whose command runs forward.mjs.
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'SubagentStart',
      'SubagentStop',
      'Stop',
      'SessionEnd',
      'PermissionRequest',
      'Notification',
    ]) {
      const arr = hooks[event] as Array<{ hooks: Array<{ command: string }> }> | undefined;
      expect(arr, `missing hooks.${event}`).toBeDefined();
      expect(arr?.some((g) => g.hooks.some((h) => h.command.includes('forward.mjs')))).toBe(true);
    }
    // matcher '*' only on the tool-event groups.
    const preToolUse = hooks.PreToolUse as Array<{ matcher?: string }>;
    expect(preToolUse.some((g) => g.matcher === '*')).toBe(true);
    const sessionStartMatchers = sessionStart.map((g) => (g as { matcher?: string }).matcher);
    expect(sessionStartMatchers.every((m) => m === undefined)).toBe(true);

    expect(backupFiles()).toHaveLength(1); // pre-existing file -> backed up
  });

  it('creates settings.json (no backup) when none exists yet', async () => {
    const code = await runConnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);
    expect(readSettings().hooks).toBeDefined();
    expect(backupFiles()).toHaveLength(0); // nothing to back up
  });

  it('is idempotent: running twice adds nothing the second time', async () => {
    writeFixtureSettings();
    await runConnect(['--settings', settingsPath, '--yes']);
    const afterFirst = readSettings();

    const code = await runConnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);
    const afterSecond = readSettings();
    expect(afterSecond).toEqual(afterFirst);
    expect(backupFiles()).toHaveLength(1); // second run made no changes -> no new backup
  });

  it('without --yes in a non-interactive shell: aborts, never touches the file', async () => {
    writeFixtureSettings();
    const before = readFileSync(settingsPath, 'utf8');
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const code = await runConnect(['--settings', settingsPath]);
      expect(code).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    expect(backupFiles()).toHaveLength(0);
  });

  it('rejects an unknown flag without touching the file', async () => {
    writeFixtureSettings();
    const before = readFileSync(settingsPath, 'utf8');
    const code = await runConnect(['--settings', settingsPath, '--bogus']);
    expect(code).toBe(1);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('refuses malformed JSON rather than clobbering it', async () => {
    writeFileSync(settingsPath, '{ not valid json');
    const code = await runConnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(1);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not valid json'); // untouched
  });

  it('honors --port by embedding VW_PORT in the command (non-default port)', async () => {
    const code = await runConnect(['--settings', settingsPath, '--yes', '--port', '5555']);
    expect(code).toBe(0);
    const hooks = readSettings().hooks as Raw;
    const commands = allCommands(hooks);
    expect(commands.some((c) => c.startsWith('VW_PORT=5555 '))).toBe(true);
  });

  it('aborts on a non-ENOENT read error without replacing the file or writing a backup', async () => {
    // A directory at the settings path makes readFile fail with EISDIR — a
    // read error that is NOT "file missing" and must never be treated as a
    // fresh install (that would clobber whatever is actually there).
    mkdirSync(settingsPath);
    const code = await runConnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(1);
    expect(readdirSync(settingsPath)).toEqual([]); // still an empty directory
    expect(backupFiles()).toHaveLength(0);
  });

  it('quotes the forwarder path in every installed command (paths with spaces survive)', async () => {
    await runConnect(['--settings', settingsPath, '--yes']);
    const commands = allCommands(readSettings().hooks as Raw).filter((c) =>
      c.includes('forward.mjs'),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c).toMatch(/^node "[^"]*forward\.mjs"$/);
  });

  it('writes the auto-open config restrictively (dir 0700, config.json 0600)', async () => {
    // --auto-open writes ~/.visual-workflows/config.json; point the data dir at
    // a temp path so the real one is never touched, then check the perms match
    // auth.ts (data dir 0700, secret-ish files 0600).
    const prevDataDir = process.env.VW_DATA_DIR;
    const dataDir = join(dir, 'vw-data');
    process.env.VW_DATA_DIR = dataDir;
    try {
      const code = await runConnect(['--settings', settingsPath, '--yes', '--auto-open']);
      expect(code).toBe(0);
      const configPath = join(dataDir, 'config.json');
      expect(readFileSync(configPath, 'utf8')).toContain('"autoOpen": true');
      if (process.platform !== 'win32') {
        expect(statSync(dataDir).mode & 0o777).toBe(0o700);
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      if (prevDataDir === undefined) delete process.env.VW_DATA_DIR;
      else process.env.VW_DATA_DIR = prevDataDir;
    }
  });

  it('re-running connect with a different --port updates installed entries instead of no-oping', async () => {
    await runConnect(['--settings', settingsPath, '--yes', '--port', '4777']);
    const code = await runConnect(['--settings', settingsPath, '--yes', '--port', '5000']);
    expect(code).toBe(0);
    const commands = allCommands(readSettings().hooks as Raw).filter((c) =>
      c.includes('forward.mjs'),
    );
    expect(commands).toHaveLength(11); // one per event — updated, not duplicated
    for (const c of commands) expect(c).toMatch(/^VW_PORT=5000 node "[^"]*forward\.mjs"$/);
  });

  it('writes via an atomic temp-file rename: valid JSON on disk, no temp files left behind', async () => {
    writeFixtureSettings();
    const code = await runConnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);
    expect(() => readSettings()).not.toThrow(); // parses cleanly after a normal write
    expect(readdirSync(dir).filter((f) => f.includes('.vw-tmp-'))).toEqual([]);
  });
});

describe('runDisconnect', () => {
  it('removes only our entries, preserving the unrelated hook', async () => {
    writeFixtureSettings();
    await runConnect(['--settings', settingsPath, '--yes']);

    const code = await runDisconnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);

    const settings = readSettings();
    expect(settings.keepMe).toBe('untouched');
    const hooks = settings.hooks as Raw;

    // The unrelated hook is still there.
    const sessionStart = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0]?.hooks).toEqual([UNRELATED_HOOK]);

    // Events we created from scratch (entirely ours) are gone entirely.
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(hooks[event]).toBeUndefined();
    }
    expect(allCommands(hooks).some((c) => c.includes('forward.mjs'))).toBe(false);

    expect(backupFiles().length).toBeGreaterThanOrEqual(2); // connect backup + disconnect backup
  });

  it('no settings file -> nothing to remove, returns 0, creates nothing', async () => {
    const code = await runDisconnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);
    expect(() => readSettings()).toThrow(); // file was never created
  });

  it('settings file with no hooks section -> nothing to remove, returns 0', async () => {
    writeFileSync(settingsPath, JSON.stringify({ keepMe: 'yes' }));
    const code = await runDisconnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);
    expect(readSettings()).toEqual({ keepMe: 'yes' });
  });

  it('settings file with hooks but none of ours -> nothing to remove, file untouched', async () => {
    writeFixtureSettings();
    const before = readFileSync(settingsPath, 'utf8');
    const code = await runDisconnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('without --yes in a non-interactive shell: aborts, never touches the file', async () => {
    writeFixtureSettings();
    await runConnect(['--settings', settingsPath, '--yes']);
    const before = readFileSync(settingsPath, 'utf8');
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const code = await runDisconnect(['--settings', settingsPath]);
      expect(code).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('preserves a user hook that merely mentions forward.mjs as an argument', async () => {
    const lookalike = {
      type: 'command',
      command: 'node ~/.claude/replay.js --script forward.mjs',
      timeout: 10,
    };
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [lookalike] }] } }, null, 2),
    );
    // connect must not mistake the lookalike for a previous install…
    await runConnect(['--settings', settingsPath, '--yes']);
    const installed = allCommands(readSettings().hooks as Raw);
    expect(installed.some((c) => /^node "[^"]*forward\.mjs"$/.test(c))).toBe(true);

    // …and disconnect must remove only OUR entries, never the lookalike.
    const code = await runDisconnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);
    const hooks = readSettings().hooks as Raw;
    const sessionStart = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStart.some((g) => g.hooks.some((h) => h.command === lookalike.command))).toBe(
      true,
    );
    expect(
      allCommands(hooks).some((c) => /^(VW_PORT=\d+ )?node "[^"]*forward\.mjs"$/.test(c)),
    ).toBe(false);
  });
});
