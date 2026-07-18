/**
 * Secret redaction — applied by adapters BEFORE events enter the bus, so
 * neither the UI nor recordings ever see raw credentials. Fail-closed: if
 * redaction throws, callers must drop the chunk rather than pass it raw.
 */

export interface Redaction {
  kind: string;
  count: number;
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

const MARK = (kind: string) => `•••REDACTED:${kind}•••`;

/** Ordered — more specific patterns first (e.g. sk-ant- before sk-). */
const PATTERNS: Array<{ kind: string; re: RegExp; keepGroup?: number }> = [
  {
    kind: 'pem-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'aws-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'stripe-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  {
    kind: 'auth-header',
    re: /((?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|token)\s+)[^\s'"]+/gi,
    keepGroup: 1,
  },
  {
    kind: 'url-credentials',
    // user:password@ in URLs — mask only the password, keep scheme/user/host.
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s/]+)(?=@)/gi,
    keepGroup: 1,
  },
  {
    kind: 'secret-assignment',
    // Case-insensitive so `password=`/`aws_secret_access_key=` match too.
    // The {0,64} bounds keep the scan linear on long [A-Z0-9_] runs
    // (unbounded * here backtracks catastrophically on 100k-char runs).
    re: /([A-Z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]{0,64}\s*[=:]\s*["']?)[^\s"']{8,}/gi,
    keepGroup: 1,
  },
];

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * High-entropy catch-all: long unbroken mixed-charset tokens that look like
 * credentials. Threshold 4.2 bits/char deliberately exceeds pure hex
 * (max 4.0), so git SHAs survive.
 */
const CANDIDATE_RE = /\b[A-Za-z0-9+/_=-]{40,}\b/g;

function entropyPass(text: string, redactions: Redaction[]): string {
  return text.replace(CANDIDATE_RE, (tok) => {
    if (/^[0-9a-f]+$/i.test(tok)) return tok; // hex digests (git SHAs etc.)
    if (/^[0-9]+$/.test(tok)) return tok;
    if (shannonEntropy(tok) <= 4.2) return tok;
    bump(redactions, 'high-entropy');
    return MARK('high-entropy');
  });
}

function bump(list: Redaction[], kind: string) {
  const hit = list.find((r) => r.kind === kind);
  if (hit) hit.count += 1;
  else list.push({ kind, count: 1 });
}

export function redactText(input: string): RedactResult {
  let text = input;
  const redactions: Redaction[] = [];
  for (const { kind, re, keepGroup } of PATTERNS) {
    text = text.replace(re, (...args) => {
      bump(redactions, kind);
      if (keepGroup !== undefined) {
        const groups = args.slice(1, -2) as string[];
        return `${groups[keepGroup - 1] ?? ''}${MARK(kind)}`;
      }
      return MARK(kind);
    });
  }
  text = entropyPass(text, redactions);
  return { text, redactions };
}

export const MAX_CHUNK_BYTES = 16 * 1024;

/** Cap a chunk to MAX_CHUNK_BYTES of UTF-8; returns truncation flag. */
export function capChunk(s: string): { text: string; truncated: boolean } {
  if (Buffer_byteLength(s) <= MAX_CHUNK_BYTES) return { text: s, truncated: false };
  let out = s;
  while (Buffer_byteLength(out) > MAX_CHUNK_BYTES) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  // The slice can land mid-surrogate-pair; drop a trailing lone high
  // surrogate so the capped text stays well-formed UTF-16.
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return { text: `${out}…`, truncated: true };
}

/** TextEncoder is a runtime global in Node ≥11 and all browsers; declared
 * here so this package needs neither DOM nor Node type libs. */
declare const TextEncoder: new () => { encode(input: string): { length: number } };

/** Environment-agnostic UTF-8 byte length (no Node Buffer dependency). */
function Buffer_byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
