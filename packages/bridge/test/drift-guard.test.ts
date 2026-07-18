/**
 * Drift guards — fail CI the moment the two shipped copies of the forwarder
 * diverge, or the forwarder's inlined redaction PATTERNS fall out of sync with
 * the protocol's canonical redact.ts table.
 *
 * Both invariants are load-bearing: the Claude Code plugin ships its own
 * byte-for-byte copy of forward.mjs (plugin/forward.mjs), and forward.mjs
 * inlines the redaction patterns to stay dependency-free (it is exec'd raw by
 * hooks with no build step). If either drifts, secrets can leak or the plugin
 * can behave differently from the package — neither is caught by ordinary
 * unit tests, so it is pinned here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const HOOK_FORWARD = join(REPO_ROOT, 'packages', 'hook-adapter', 'src', 'forward.mjs');
const PLUGIN_FORWARD = join(REPO_ROOT, 'plugin', 'forward.mjs');
const REDACT_TS = join(REPO_ROOT, 'packages', 'protocol', 'src', 'redact.ts');

/**
 * Extract the ordered list of `kind: '...'` literals from a source file. Only
 * the PATTERNS table uses that exact shape in either file (the `Redaction`
 * interface and destructuring use unquoted `kind`), so this yields precisely
 * the pattern kinds in declaration order.
 */
function patternKinds(source: string): string[] {
  return [...source.matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1]!);
}

describe('forwarder drift guard', () => {
  it('plugin/forward.mjs is byte-identical to packages/hook-adapter/src/forward.mjs', () => {
    const hook = readFileSync(HOOK_FORWARD);
    const plugin = readFileSync(PLUGIN_FORWARD);
    // Buffer.equals is a byte comparison — any divergence (even whitespace)
    // fails, forcing whoever edits one copy to re-sync the other.
    expect(plugin.equals(hook)).toBe(true);
  });

  it('forward.mjs PATTERNS kinds match protocol redact.ts PATTERNS kinds exactly, in order', () => {
    const forwardKinds = patternKinds(readFileSync(HOOK_FORWARD, 'utf8'));
    const redactKinds = patternKinds(readFileSync(REDACT_TS, 'utf8'));
    // Sanity: the extraction actually located the table (not an empty match
    // that would make the equality vacuously pass).
    expect(forwardKinds.length).toBeGreaterThanOrEqual(14);
    expect(forwardKinds).toEqual(redactKinds);
  });
});
