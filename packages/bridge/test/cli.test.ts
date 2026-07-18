/**
 * cli.ts argument-parser tests — focused on --port validation: an invalid
 * value must not be silently ignored, must never swallow the following
 * token, and must surface an error (stderr + non-zero process.exitCode).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, parsePortValue, stripCommand } from '../src/cli.js';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined; // parseArgs sets it on bad input — never leak into vitest
});

describe('stripCommand', () => {
  it('removes the leading command word, keeping flags on either side', () => {
    expect(stripCommand(['connect', '--auto-open'], 'connect')).toEqual(['--auto-open']);
    expect(stripCommand(['connect'], 'connect')).toEqual([]);
    expect(stripCommand(['--yes', 'connect', '--port', '5000'], 'connect')).toEqual([
      '--yes',
      '--port',
      '5000',
    ]);
  });

  it('leaves argv untouched when the command word is absent', () => {
    expect(stripCommand(['--auto-open'], 'connect')).toEqual(['--auto-open']);
  });

  it('skips value-taking flag arguments so `--port 5000 connect` strips the command', () => {
    // Regression: the value 5000 used to be read as the "first bare word" and
    // mistaken for (or fail to match) the command, breaking `vw --port N connect`.
    expect(stripCommand(['--port', '5000', 'connect'], 'connect')).toEqual(['--port', '5000']);
    expect(stripCommand(['--port', '5000', 'connect', '--auto-open'], 'connect')).toEqual([
      '--port',
      '5000',
      '--auto-open',
    ]);
    // --settings and --repo also take a value.
    expect(stripCommand(['--settings', '/tmp/s.json', 'disconnect'], 'disconnect')).toEqual([
      '--settings',
      '/tmp/s.json',
    ]);
    // The inline --port=N form carries its value, so nothing extra is skipped.
    expect(stripCommand(['--port=5000', 'connect'], 'connect')).toEqual(['--port=5000']);
  });
});

describe('main connect (CLI entry point regression)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-cli-'));
    process.env.VW_DATA_DIR = path.join(tmp, 'data');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.VW_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Regression: the CLI used to forward the "connect" word to runConnect,
  // which rejected it as an unknown flag. Exercise the real entry point.
  it('runs connect through main() without choking on the command word', async () => {
    const settings = path.join(tmp, 'settings.json');
    await main(['connect', '--settings', settings, '--yes', '--auto-open']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.existsSync(settings)).toBe(true);
    expect(fs.readFileSync(settings, 'utf8')).toContain('forward.mjs');
    expect(fs.existsSync(path.join(tmp, 'data', 'config.json'))).toBe(true);
  });
});

describe('parsePortValue', () => {
  it('accepts in-range base-10 integers only', () => {
    expect(parsePortValue('0')).toBe(0);
    expect(parsePortValue('4777')).toBe(4777);
    expect(parsePortValue('65535')).toBe(65535);
  });

  it('rejects non-numeric, out-of-range, and trailing-garbage values', () => {
    expect(parsePortValue(undefined)).toBeUndefined();
    expect(parsePortValue('')).toBeUndefined();
    expect(parsePortValue('abc')).toBeUndefined();
    expect(parsePortValue('65536')).toBeUndefined();
    expect(parsePortValue('4777abc')).toBeUndefined();
    expect(parsePortValue('-1')).toBeUndefined();
  });
});

describe('parseArgs --port', () => {
  it('parses a valid --port <n> and --port=<n>', () => {
    expect(parseArgs(['start', '--port', '5000']).port).toBe(5000);
    expect(parseArgs(['--port=5001']).port).toBe(5001);
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects a non-numeric value: error to stderr, exitCode 1, port unset', () => {
    const args = parseArgs(['start', '--port', 'abc']);
    expect(args.port).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--port'));
  });

  it('does not swallow a following flag when the value is invalid', () => {
    const args = parseArgs(['start', '--port', '--record']);
    expect(args.port).toBeUndefined();
    expect(args.record).toBe(true); // previously eaten as the "value" of --port
    expect(process.exitCode).toBe(1);
  });

  it('does not swallow a following command word when the value is invalid', () => {
    const args = parseArgs(['--port', 'demo']);
    expect(args.command).toBe('demo'); // still recognized as the command
    expect(args.port).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it('rejects --port with no value at all', () => {
    const args = parseArgs(['start', '--port']);
    expect(args.port).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it('rejects an invalid --port=<value> form the same way', () => {
    const args = parseArgs(['start', '--port=abc']);
    expect(args.port).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });
});
