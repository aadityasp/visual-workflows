import { describe, expect, it } from 'vitest';
import { capChunk, MAX_CHUNK_BYTES, redactText, shannonEntropy } from '../src/redact.js';

// Runtime global in Node and browsers; declared to keep this package free of
// DOM/Node type libs (mirrors src/redact.ts).
declare const TextEncoder: new () => { encode(input: string): { length: number } };

describe('redactText — credential patterns', () => {
  it('redacts AWS access keys', () => {
    const r = redactText('creds: AKIAIOSFODNN7EXAMPLE done');
    expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(r.text).toContain('•••REDACTED:aws-key•••');
    expect(r.redactions).toEqual([{ kind: 'aws-key', count: 1 }]);
  });

  it('redacts GitHub tokens', () => {
    const r = redactText(`token=ghp_${'a1B2'.repeat(10)}`);
    expect(r.text).toContain('REDACTED');
    expect(
      r.redactions.some((x) => x.kind === 'github-token' || x.kind === 'secret-assignment'),
    ).toBe(true);
  });

  it('labels Anthropic keys as anthropic (ordering before generic sk-)', () => {
    const r = redactText('using sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx here');
    expect(r.text).toContain('•••REDACTED:anthropic-key•••');
    expect(r.text).not.toContain('sk-ant-api03');
  });

  it('redacts JWTs', () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
    const r = redactText(`Bearer-ish ${jwt}`);
    expect(r.text).not.toContain(jwt);
  });

  it('keeps the Authorization prefix but hides the value', () => {
    const r = redactText('Authorization: Bearer supersecrettokenvalue123');
    expect(r.text).toContain('Authorization: Bearer ');
    expect(r.text).not.toContain('supersecrettokenvalue123');
  });

  it('keeps the variable name in secret assignments', () => {
    const r = redactText('export DATABASE_PASSWORD=hunter2hunter2');
    expect(r.text).toContain('DATABASE_PASSWORD=');
    expect(r.text).not.toContain('hunter2hunter2');
  });

  it('redacts lowercase and mixed-case secret assignments', () => {
    const r = redactText('password=hunter2hunter2 and aws_secret_access_key=wJalrXUtnFEMI1234');
    expect(r.text).toContain('password=');
    expect(r.text).not.toContain('hunter2hunter2');
    expect(r.text).toContain('aws_secret_access_key=');
    expect(r.text).not.toContain('wJalrXUtnFEMI1234');

    const mixed = redactText('Db_Password: "p4sswordv4lue"');
    expect(mixed.text).toContain('Db_Password:');
    expect(mixed.text).not.toContain('p4sswordv4lue');
  });

  it('masks URL-embedded passwords but keeps scheme, user, and host', () => {
    const r = redactText('db postgres://u:p@h/db then https://user:secretpw@example.com/path');
    expect(r.text).toContain('postgres://u:');
    expect(r.text).toContain('@h/db');
    expect(r.text).not.toContain(':p@');
    expect(r.text).toContain('https://user:');
    expect(r.text).toContain('@example.com/path');
    expect(r.text).not.toContain('secretpw');
    expect(r.redactions.find((x) => x.kind === 'url-credentials')?.count).toBe(2);
  });

  it('handles a 100k-char [A-Z0-9_] run without catastrophic backtracking', () => {
    const s = 'A_'.repeat(50_000); // 100k chars matching the secret-assignment prefix class
    const t0 = Date.now();
    const r = redactText(s);
    const elapsedMs = Date.now() - t0;
    expect(r.text).toBe(s); // no secret keyword, no high entropy — untouched
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('redacts PEM private key blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow_fake_body\n-----END RSA PRIVATE KEY-----';
    const r = redactText(`before\n${pem}\nafter`);
    expect(r.text).not.toContain('fake_body');
    expect(r.text).toContain('before');
    expect(r.text).toContain('after');
  });
});

describe('redactText — entropy pass precision', () => {
  it('leaves 40-char git SHAs alone (pure hex)', () => {
    const sha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
    const r = redactText(`commit ${sha}`);
    expect(r.text).toContain(sha);
  });

  it('leaves long decimal numbers alone', () => {
    const n = '1234567890'.repeat(5);
    expect(redactText(n).text).toContain(n);
  });

  it('redacts long high-entropy mixed tokens', () => {
    const tok = 'zQ3vB8xW1pK9mR4tY7uJ2hN6cD0aS5eF8gL3oI1qXwZ_yV';
    const r = redactText(`standalone ${tok} end`);
    expect(r.text).not.toContain(tok);
    expect(r.redactions.some((x) => x.kind === 'high-entropy')).toBe(true);
  });

  it('shannonEntropy sanity: hex < threshold < random base62', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('a94a8fe5ccb19ba61c4c0873d391e987982fbbd3')).toBeLessThanOrEqual(4.0);
  });
});

describe('capChunk', () => {
  it('passes small chunks through untouched', () => {
    expect(capChunk('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('caps oversized chunks under the byte budget', () => {
    const big = 'x'.repeat(MAX_CHUNK_BYTES * 2);
    const r = capChunk(big);
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(MAX_CHUNK_BYTES + 4);
  });

  it('never leaves a lone surrogate when the cut lands mid-pair', () => {
    // 4101 emoji: the final slice of the cap loop lands between the high and
    // low surrogate of a pair (verified against the unfixed implementation).
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const count of [4101, 8000]) {
      const r = capChunk('😀'.repeat(count));
      expect(r.truncated).toBe(true);
      expect(loneSurrogate.test(r.text)).toBe(false);
      expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(MAX_CHUNK_BYTES + 4);
    }
  });
});
