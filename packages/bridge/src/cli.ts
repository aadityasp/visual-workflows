#!/usr/bin/env node
/**
 * `visual-workflows` CLI — zero-dependency arg parsing.
 *
 * Commands:
 *   start        run the bridge (default)   [--port N] [--record]
 *                [--watch-claude] [--demo]
 *   demo         start --demo, then open the dashboard in a browser
 *   connect      install Claude Code hooks   (integration module)
 *   disconnect   remove Claude Code hooks    (integration module)
 *   wipe         delete ~/.visual-workflows  [--yes]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { resolveDataDir } from './auth.js';
import { startServer } from './server.js';
import { SERVER_VERSION } from './version.js';

interface CliArgs {
  command: string;
  port?: number;
  record: boolean;
  watchClaude: boolean;
  demo: boolean;
  open: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
}

const USAGE = `visual-workflows ${SERVER_VERSION} — local command center for Claude Code workflows

Usage: visual-workflows [command] [flags]

Commands:
  start         Run the bridge server (default)
  demo          Run the bridge and play the scripted demo in a browser
  connect       Install the Claude Code hook integration
  disconnect    Remove the Claude Code hook integration
  wipe          Delete all local data (~/.visual-workflows)

Flags:
  --port <n>       Listen port (default $VW_PORT or 4777)
  --open           Open the dashboard in your browser after start
  --record         Record events to ~/.visual-workflows/recordings
  --watch-claude   Tail ~/.claude transcripts (transcript adapter)
  --demo           Auto-run the demo after start
  --yes            Skip confirmation (wipe)
  --version        Print version
  --help           Show this help
`;

/** Strictly parse a --port value: a base-10 integer 0-65535, nothing looser. */
export function parsePortValue(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number.parseInt(value, 10);
  return n <= 65535 ? n : undefined;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'start',
    record: false,
    watchClaude: false,
    demo: false,
    open: false,
    yes: false,
    help: false,
    version: false,
  };
  let commandSet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) break;
    switch (token) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--record':
        args.record = true;
        break;
      case '--watch-claude':
        args.watchClaude = true;
        break;
      case '--demo':
        args.demo = true;
        break;
      case '--open':
        args.open = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--port': {
        const value = argv[i + 1];
        const port = parsePortValue(value);
        if (port !== undefined) {
          args.port = port;
          i += 1; // consume the value only when it is a valid port
        } else {
          // Invalid/missing value: report it and leave the next token alone
          // so a following flag or command is not silently swallowed.
          console.error(`--port requires a port number (0-65535), got ${value ?? 'nothing'}`);
          process.exitCode = 1;
        }
        break;
      }
      default: {
        if (token.startsWith('--port=')) {
          const value = token.slice('--port='.length);
          const port = parsePortValue(value);
          if (port !== undefined) {
            args.port = port;
          } else {
            console.error(`--port requires a port number (0-65535), got ${value || 'nothing'}`);
            process.exitCode = 1;
          }
        } else if (!token.startsWith('-') && !commandSet) {
          args.command = token;
          commandSet = true;
        }
        // unknown flags are tolerated (forwarded commands may use them)
        break;
      }
    }
  }
  return args;
}

/** Open a URL in the default browser; failure is fine (headless, CI, ...). */
function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(cmd, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    });
    child.on('error', () => {
      /* ignore */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

interface ConnectModule {
  runConnect?(argv: string[]): number | void | Promise<number | void>;
  runDisconnect?(argv: string[]): number | void | Promise<number | void>;
}

/**
 * Flags that consume the following argv token as their value. Their argument
 * must be skipped when scanning for the command word, or e.g. the `5000` in
 * `--port 5000 connect` is mistaken for the command.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--port', '--settings', '--repo']);

/** Remove the leading command word (e.g. "connect"), keeping all flags. */
export function stripCommand(argv: string[], command: string): string[] {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) break;
    if (token.startsWith('-')) {
      // `--flag value` form: skip the value so it is not read as the command.
      // The `--flag=value` form carries its value inline, so skip nothing.
      if (VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    // First bare word: strip it only when it is the expected command; if it is
    // something else, leave argv untouched (the original contract).
    return token === command ? [...argv.slice(0, i), ...argv.slice(i + 1)] : argv;
  }
  return argv;
}

/**
 * The connect/disconnect implementation ships with the Claude Code
 * integration build; import dynamically (via a variable specifier so the
 * type checker tolerates its absence) and degrade gracefully.
 */
async function loadConnectModule(): Promise<ConnectModule | undefined> {
  const specifier = './connect/index.js';
  try {
    return (await import(specifier)) as ConnectModule;
  } catch {
    return undefined;
  }
}

async function runStart(args: CliArgs, openAfter: boolean): Promise<void> {
  const server = await startServer({
    port: args.port,
    record: args.record,
    watchClaude: args.watchClaude,
    autoDemo: args.demo,
  });
  console.log(`visual-workflows bridge ${SERVER_VERSION}`);
  console.log(`  dashboard  ${server.url}`);
  console.log(`  websocket  ws://127.0.0.1:${server.port}/ws`);
  console.log(`  data dir   ${server.dataDir}${args.record ? ' (recording ON)' : ''}`);
  if (args.demo) console.log('  demo       running (source: demo — simulated data)');
  const shutdown = () => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (openAfter) openBrowser(server.url);
}

async function runWipe(args: CliArgs): Promise<void> {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    console.log(`Nothing to wipe (${dir} does not exist).`);
    return;
  }
  if (!args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Delete ${dir} and all recordings? [y/N] `)).trim();
    rl.close();
    if (!/^y(es)?$/i.test(answer)) {
      console.log('Aborted.');
      return;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Wiped ${dir}.`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.version) {
    console.log(SERVER_VERSION);
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  switch (args.command) {
    case 'start':
      await runStart(args, args.open);
      return;
    case 'demo':
      args.demo = true;
      await runStart(args, true);
      return;
    case 'connect':
    case 'disconnect': {
      const mod = await loadConnectModule();
      const run = args.command === 'connect' ? mod?.runConnect : mod?.runDisconnect;
      if (!run) {
        console.error('integration module missing');
        process.exitCode = 1;
        return;
      }
      // Strip the command word before handing off — runConnect/runDisconnect
      // parse only flags, and would reject "connect"/"disconnect" as unknown.
      const code = await run(stripCommand(argv, args.command));
      if (typeof code === 'number' && code !== 0) process.exitCode = code;
      return;
    }
    case 'wipe':
      await runWipe(args);
      return;
    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

// Run when invoked directly (bin entry); inert when imported by tests.
const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
