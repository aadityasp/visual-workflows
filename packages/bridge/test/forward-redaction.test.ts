/**
 * The forwarder inlines the protocol's redaction so hooks stay
 * dependency-free (forward.mjs is exec'd raw, no build step). These tests pin
 * that the inlined redactString/redactDeep catch every secret class the
 * canonical redact.ts catches — including the high-entropy catch-all — and
 * produce byte-identical text to redactText(). A secret must never leak
 * through the hook path that the bus path would have scrubbed.
 */
import { describe, expect, it } from 'vitest';
// forward.mjs is plain ESM; importing it is inert (main() only runs when the
// file is executed directly as a hook), so its pure redaction helpers are
// testable here.
import { redactDeep, redactString } from '../../hook-adapter/src/forward.mjs';
import { redactText } from '@visual-workflows/protocol';

/**
 * One representative per secret class. `secret` is the substring that MUST be
 * gone from the output; the whole input is fed to the redactor.
 */
const CASES: Record<string, { input: string; secret: string }> = {
  'pem-key': {
    input:
      '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8w\n-----END PRIVATE KEY-----',
    secret: 'MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8w',
  },
  'aws-key': { input: 'AKIAIOSFODNN7EXAMPLE', secret: 'AKIAIOSFODNN7EXAMPLE' },
  'github-token': {
    input: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    secret: '1234567890abcdefghijklmnopqrstuvwxyz',
  },
  'github-pat': {
    input: `github_pat_${'A1b2C3d4E5'.repeat(7)}`,
    secret: 'A1b2C3d4E5A1b2C3d4E5',
  },
  'slack-token': {
    input: 'xoxb-1234567890-0987654321-abcdefghijklmnop',
    secret: 'abcdefghijklmnop',
  },
  'anthropic-key': {
    input: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    secret: 'abcdefghijklmnopqrstuvwxyz',
  },
  'openai-key': {
    input: 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    secret: 'abcdefghijklmnopqrstuvwxyz',
  },
  'stripe-key': {
    input: 'sk_live_abcdefghijklmnop1234567890',
    secret: 'abcdefghijklmnop1234567890',
  },
  'google-key': {
    input: `AIza${'A1b2C3d4E5'.repeat(4).slice(0, 35)}`,
    secret: 'A1b2C3d4E5A1b2C3d4E5',
  },
  'npm-token': {
    input: `npm_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`,
    secret: 'a1B2c3D4e5a1B2c3D4e5',
  },
  jwt: {
    input:
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpEIn0.dozjgNryP4J3jVmNHl0w5N',
    secret: 'dozjgNryP4J3jVmNHl0w5N',
  },
  'auth-header': {
    input: 'Authorization: Bearer sometoken1234567890abcdef',
    secret: 'sometoken1234567890abcdef',
  },
  'url-credentials': {
    input: 'postgres://dbuser:supersecretpw@db.example.com:5432/app',
    secret: 'supersecretpw',
  },
  'secret-assignment': {
    input: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
    secret: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
  },
  'high-entropy': {
    // No fixed prefix -> only the entropy catch-all can catch this.
    input: 'Zx9Qw3rTy7Ui1Op2As4Df6Gh8Jk0Lz5Xc7Vb9Nm3Qw1Er',
    secret: 'Zx9Qw3rTy7Ui1Op2As4Df6Gh8Jk0Lz5Xc7Vb9Nm3Qw1Er',
  },
};

describe('forward.mjs redactString', () => {
  for (const [kind, { input, secret }] of Object.entries(CASES)) {
    it(`redacts ${kind} and keeps no raw secret`, () => {
      const out = redactString(input);
      expect(out).toContain('REDACTED');
      expect(out).not.toContain(secret);
    });
  }

  it('produces byte-identical output to the canonical redactText() on the whole corpus', () => {
    for (const { input } of Object.values(CASES)) {
      expect(redactString(input)).toBe(redactText(input).text);
    }
    // Also on a mixed blob containing several secrets at once.
    const blob = Object.values(CASES)
      .map((c) => c.input)
      .join(' ');
    expect(redactString(blob)).toBe(redactText(blob).text);
  });

  it('leaves benign high-entropy-looking values (git SHAs, digit runs) untouched', () => {
    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';
    const digits = '12345678901234567890123456789012345678901234';
    expect(redactString(sha)).toBe(sha);
    expect(redactString(digits)).toBe(digits);
    // And identical to the canonical redactor on these survivors.
    expect(redactString(sha)).toBe(redactText(sha).text);
    expect(redactString(digits)).toBe(redactText(digits).text);
  });
});

describe('forward.mjs redactDeep', () => {
  it('recursively scrubs independently-detectable secret values nested in objects and arrays', () => {
    // redactDeep redacts each string value on its own (object keys give no
    // in-string context), so nested VALUES must themselves be recognizable
    // secrets — e.g. an AWS key value under an AWS_SECRET_ACCESS_KEY field.
    const payload = {
      tool_input: {
        env: { AWS_SECRET_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE' },
        argv: ['--token', 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'],
      },
    };
    const out = redactDeep(payload) as typeof payload;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
    expect(serialized).toContain('REDACTED');
    // Structure is preserved.
    expect(out.tool_input.argv[0]).toBe('--token');
  });

  it('leaves short (<=6 char) strings and non-strings untouched', () => {
    expect(redactDeep({ a: 'abc', b: 'AKIA12', n: 42, ok: true, z: null })).toEqual({
      a: 'abc',
      b: 'AKIA12',
      n: 42,
      ok: true,
      z: null,
    });
  });
});
