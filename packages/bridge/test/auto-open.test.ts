import type * as ChildProcessModule from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The forwarder is plain ESM; importing it is inert (main() only runs when the
// file is executed directly as a hook), so its pure helpers are testable here.
import { classifyEvent } from '../../hook-adapter/src/forward.mjs';
import { runConnect, runDisconnect } from '../src/connect/index.js';

// Stub child_process.spawn so runAutoOpen's detached opener/starter is
// captured, never actually launching a browser or serve process. Only spawn
// is overridden; every other export passes through so unrelated consumers
// (connect etc.) are unaffected.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn((..._args: unknown[]) => ({ on: () => {}, unref: () => {} })),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: spawnMock };
});

describe('classifyEvent (auto-open trigger detection)', () => {
  it('flags SessionStart', () => {
    expect(classifyEvent({ hook_event_name: 'SessionStart' })).toEqual({
      isSessionStart: true,
      isSpawn: false,
    });
  });

  it('flags SubagentStart as a spawn', () => {
    expect(classifyEvent({ hook_event_name: 'SubagentStart' }).isSpawn).toBe(true);
  });

  it('flags an async-launched Agent/Task PostToolUse as a spawn', () => {
    expect(
      classifyEvent({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: { status: 'async_launched' },
      }).isSpawn,
    ).toBe(true);
    expect(
      classifyEvent({
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_response: { status: 'async_launched' },
      }).isSpawn,
    ).toBe(true);
  });

  it('flags a Workflow PreToolUse as a spawn', () => {
    expect(classifyEvent({ hook_event_name: 'PreToolUse', tool_name: 'Workflow' }).isSpawn).toBe(
      true,
    );
  });

  it('does NOT treat ordinary tool calls or synchronous completions as spawns', () => {
    expect(classifyEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }).isSpawn).toBe(false);
    expect(
      classifyEvent({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: { status: 'completed' },
      }).isSpawn,
    ).toBe(false);
    expect(classifyEvent({}).isSpawn).toBe(false);
    expect(classifyEvent(null).isSpawn).toBe(false);
  });
});

describe('connect --auto-open writes and clears the forwarder config', () => {
  let tmp: string;
  let settingsPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-auto-'));
    settingsPath = path.join(tmp, 'settings.json');
    process.env.VW_DATA_DIR = path.join(tmp, 'data');
  });

  afterEach(() => {
    delete process.env.VW_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes config.json with autoOpen + a startCommand on connect --auto-open', async () => {
    const code = await runConnect(['--settings', settingsPath, '--yes', '--auto-open']);
    expect(code).toBe(0);
    const cfgPath = path.join(tmp, 'data', 'config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      autoOpen: boolean;
      autoClose: boolean;
      startCommand: string;
      port: number;
    };
    expect(cfg.autoOpen).toBe(true);
    expect(cfg.autoClose).toBe(true);
    expect(cfg.port).toBe(4777);
    expect(cfg.startCommand).toMatch(/npm --prefix ".*" run serve/);
  });

  it('does NOT write config without the flag, and disconnect removes it', async () => {
    await runConnect(['--settings', settingsPath, '--yes']);
    expect(fs.existsSync(path.join(tmp, 'data', 'config.json'))).toBe(false);

    await runConnect(['--settings', settingsPath, '--yes', '--auto-open']);
    expect(fs.existsSync(path.join(tmp, 'data', 'config.json'))).toBe(true);

    const code = await runDisconnect(['--settings', settingsPath, '--yes']);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'data', 'config.json'))).toBe(false);
  });

  it('honors a custom --repo in the startCommand', async () => {
    const repo = path.join(tmp, 'my repo');
    fs.mkdirSync(repo);
    await runConnect(['--settings', settingsPath, '--yes', '--auto-open', '--repo', repo]);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'config.json'), 'utf8')) as {
      startCommand: string;
    };
    expect(cfg.startCommand).toContain(repo);
  });
});

describe('runAutoOpen (forward.mjs auto-open side effects)', () => {
  let tmp: string;
  let dataDir: string;
  let runAutoOpen: (payload: unknown) => void;

  // forward.mjs binds DATA_DIR from VW_DATA_DIR at module-eval time, so it
  // must be re-imported (via resetModules) AFTER the temp dir is set for each
  // test to point its side effects at the throwaway tree.
  async function loadForwarder(): Promise<void> {
    process.env.VW_DATA_DIR = dataDir;
    vi.resetModules();
    const mod = (await import('../../hook-adapter/src/forward.mjs')) as {
      runAutoOpen: (payload: unknown) => void;
    };
    runAutoOpen = mod.runAutoOpen;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-runauto-'));
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    spawnMock.mockClear();
  });

  afterEach(() => {
    delete process.env.VW_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeConfig(cfg: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg));
  }
  function writeBridge(info: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dataDir, 'bridge.json'), JSON.stringify(info));
  }
  const runDir = (): string => path.join(dataDir, 'run');
  const spawnEvent = (session_id: string) => ({
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_response: { status: 'async_launched' },
    session_id,
  });

  it('no config -> no side effects (no run/ dir, no spawn)', async () => {
    await loadForwarder();
    runAutoOpen(spawnEvent('s1'));
    expect(fs.existsSync(runDir())).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawn with a live bridge opens the dashboard exactly once', async () => {
    writeConfig({ autoOpen: true });
    // pid = this process -> kill(pid,0) succeeds -> bridge reads as live.
    writeBridge({ pid: process.pid, port: 4777, url: 'http://127.0.0.1:4777' });
    await loadForwarder();

    const payload = spawnEvent('sess-open');
    runAutoOpen(payload);

    expect(fs.existsSync(path.join(runDir(), 'sess-open.opened'))).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The auto-managed dashboard URL (the #vw=auto marker) is what gets opened.
    expect(String(spawnMock.mock.calls[0]![0])).toContain('#vw=auto');
    // App-window mode must use a dedicated --user-data-dir so a window opens
    // reliably even when the user's main browser is already running (macOS
    // otherwise drops --app for a second same-profile instance — the window
    // never appears). Regression guard for that exact bug.
    expect(String(spawnMock.mock.calls[0]![0])).toContain('--user-data-dir');

    // A second spawn in the same session must NOT re-claim or re-open.
    runAutoOpen(payload);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(runDir()).filter((f) => f.endsWith('.opened'))).toHaveLength(1);
  });

  it('spawn with no live bridge writes no .opened marker and does not open', async () => {
    writeConfig({ autoOpen: true });
    // No bridge.json -> readBridgeInfo() is undefined -> open path is skipped
    // (never a dead tab) and the claim is not burned.
    await loadForwarder();

    runAutoOpen({ hook_event_name: 'SubagentStart', session_id: 'sess-nobridge' });

    expect(fs.existsSync(path.join(runDir(), 'sess-nobridge.opened'))).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('SessionStart with the bridge down + startCommand writes the .started claim exactly once', async () => {
    writeConfig({ autoOpen: true, startCommand: 'my-serve-cmd', port: 4999 });
    // No bridge.json -> bridge is down -> SessionStart fires the startCommand.
    await loadForwarder();

    const payload = { hook_event_name: 'SessionStart', session_id: 'sess-start' };
    runAutoOpen(payload);

    expect(fs.existsSync(path.join(runDir(), 'sess-start.started'))).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toBe('my-serve-cmd');
    // Port is handed to the started bridge via the child env (cross-platform),
    // not a shell prefix.
    const opts = spawnMock.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(opts.env?.VW_PORT).toBe('4999');

    // A second SessionStart must not re-claim or re-run the start command.
    runAutoOpen(payload);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
