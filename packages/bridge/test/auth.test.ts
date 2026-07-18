import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  TOKEN_FILE,
  TOKEN_HEADER,
  ensureDataDir,
  loadOrCreateToken,
  requireToken,
  resolveDataDir,
  tokenEquals,
} from '../src/auth.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-auth-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('resolveDataDir', () => {
  it('honors VW_DATA_DIR override', () => {
    expect(resolveDataDir({ VW_DATA_DIR: tmp })).toBe(tmp);
  });

  it('defaults to ~/.visual-workflows', () => {
    expect(resolveDataDir({})).toBe(path.join(os.homedir(), '.visual-workflows'));
  });
});

describe('ensureDataDir', () => {
  it('creates the directory with 0700 perms', () => {
    const dir = path.join(tmp, 'data');
    ensureDataDir(dir);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe('loadOrCreateToken', () => {
  it('creates a crypto-random hex token file with 0600 perms on first start', () => {
    const dir = ensureDataDir(path.join(tmp, 'data'));
    const token = loadOrCreateToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(dir, TOKEN_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(token);
  });

  it('returns the same token on subsequent starts', () => {
    const dir = ensureDataDir(path.join(tmp, 'data'));
    const first = loadOrCreateToken(dir);
    const second = loadOrCreateToken(dir);
    expect(second).toBe(first);
  });

  it('replaces a corrupt/too-short token file', () => {
    const dir = ensureDataDir(path.join(tmp, 'data'));
    fs.writeFileSync(path.join(dir, TOKEN_FILE), 'short\n');
    const token = loadOrCreateToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('requireToken', () => {
  it('accepts the correct X-VW-Token header only', () => {
    const dir = ensureDataDir(path.join(tmp, 'data'));
    const token = loadOrCreateToken(dir);
    expect(requireToken(fakeReq({ [TOKEN_HEADER]: token }), token)).toBe(true);
    expect(requireToken(fakeReq({ [TOKEN_HEADER]: `${token} ` }), token)).toBe(true); // trimmed
    expect(requireToken(fakeReq({ [TOKEN_HEADER]: 'wrong' }), token)).toBe(false);
    expect(requireToken(fakeReq({}), token)).toBe(false);
  });
});

describe('tokenEquals', () => {
  it('compares without throwing on length mismatch', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true);
    expect(tokenEquals('abc', 'abcd')).toBe(false);
  });
});
