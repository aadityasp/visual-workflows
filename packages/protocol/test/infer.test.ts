import { describe, expect, it } from 'vitest';
import { activityForTool, isReviewerRole, summarizeToolInput, truncate } from '../src/infer.js';

describe('activityForTool', () => {
  it.each([
    ['Read', '', 'reading'],
    ['NotebookRead', '', 'reading'],
    ['Grep', 'pattern', 'searching'],
    ['WebSearch', 'q', 'searching'],
    ['Edit', 'src/a.ts', 'writing_code'],
    ['Write', 'src/a.ts', 'writing_code'],
    ['Bash', 'ls -la', 'running_command'],
    ['Bash', 'npx vitest run --coverage', 'testing'],
    ['Bash', 'cargo test --all', 'testing'],
    ['Bash', 'npm test', 'testing'],
    ['Task', 'spawn a helper', 'waiting'],
    ['Agent', 'spawn a helper', 'waiting'],
    ['SomeMcpTool', '', 'thinking'],
  ] as const)('%s(%s) -> %s', (tool, input, expected) => {
    expect(activityForTool(tool, input)).toBe(expected);
  });
});

describe('isReviewerRole', () => {
  it('detects reviewer-ish names and types', () => {
    expect(isReviewerRole('Reviewer', undefined)).toBe(true);
    expect(isReviewerRole(undefined, 'gsd-verifier')).toBe(true);
    expect(isReviewerRole('Coder A', 'coder')).toBe(false);
  });
});

describe('summarizeToolInput', () => {
  it('picks the most descriptive field', () => {
    expect(summarizeToolInput('Bash', { command: 'echo hi', description: 'greet' })).toBe(
      'echo hi',
    );
    expect(summarizeToolInput('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(summarizeToolInput('X', 'raw string')).toBe('raw string');
    expect(summarizeToolInput('X', null)).toBe('X');
    expect(summarizeToolInput('X', { unrelated: 1 })).toBe('X');
  });

  it('truncates long values', () => {
    const long = 'a'.repeat(500);
    expect(summarizeToolInput('Bash', { command: long }).length).toBeLessThanOrEqual(160);
    expect(truncate('abc', 10)).toBe('abc');
  });
});
