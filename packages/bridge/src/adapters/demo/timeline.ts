/**
 * The scripted demo timeline — "Ship dark mode".
 *
 * Data-driven: an ordered list of { atMs, make(ctx) } steps the demo adapter
 * schedules with setTimeout(atMs / speed). Every event is labeled
 * source:'demo' (truth labeling — simulated data never masquerades as real).
 *
 * Story: main spawns a Planner, a Researcher feeds it context, two coders
 * implement in parallel, a Tester goes green, a Reviewer finds a real issue
 * (theme preference dropped on reload), Coder A is blocked on the decision,
 * the fix is approved and applied, tests re-run green, main presents.
 */
import type { EventInit } from '../types.js';
import type { EventPayloadMap, EventType } from '@visual-workflows/protocol';
import { MAIN_AGENT_ID } from '@visual-workflows/protocol';

export interface DemoStepCtx {
  sessionId: string;
  workflowId: string;
  /** Wall-clock ISO timestamp at fire time. */
  now(): string;
}

export interface DemoStep {
  atMs: number;
  make(ctx: DemoStepCtx): EventInit[];
}

const A = {
  main: MAIN_AGENT_ID,
  planner: 'planner',
  researcher: 'researcher',
  coderA: 'coder-a',
  coderB: 'coder-b',
  tester: 'tester',
  reviewer: 'reviewer',
} as const;

function ev<T extends EventType>(
  ctx: DemoStepCtx,
  type: T,
  agentId: string | undefined,
  payload: EventPayloadMap[T],
): EventInit<T> {
  return {
    ts: ctx.now(),
    source: 'demo',
    sessionId: ctx.sessionId,
    workflowId: ctx.workflowId,
    agentId,
    type,
    payload,
  };
}

export const DEMO_TIMELINE: DemoStep[] = [
  {
    atMs: 0,
    make: (c) => [
      ev(c, 'session_started', undefined, {
        cwd: '~/projects/acme-web',
        title: 'Ship dark mode',
      }),
      ev(c, 'workflow_started', undefined, {
        name: 'Ship dark mode',
        kind: 'demo',
        description: 'Add a full dark theme: provider, tokens, component migration, tests, review.',
        phases: [
          { title: 'Plan' },
          { title: 'Research' },
          { title: 'Implement' },
          { title: 'Test' },
          { title: 'Review' },
        ],
      }),
      ev(c, 'agent_started', A.main, {}),
    ],
  },
  {
    atMs: 1000,
    make: (c) => [
      ev(c, 'agent_output', A.main, {
        stream: 'message',
        chunk:
          'Shipping dark mode. Planning first, then fanning implementation out to parallel coders.',
      }),
    ],
  },
  {
    atMs: 2500,
    make: (c) => [
      ev(c, 'agent_created', A.planner, {
        name: 'Planner',
        kind: 'workflow-agent',
        agentType: 'planner',
        parentAgentId: A.main,
        model: 'claude-sonnet-4-5',
        phase: 'Plan',
      }),
      ev(c, 'dependency_created', undefined, {
        fromAgentId: A.main,
        toAgentId: A.planner,
        kind: 'spawns',
      }),
      ev(c, 'agent_started', A.planner, {}),
    ],
  },
  {
    atMs: 4000,
    make: (c) => [
      ev(c, 'agent_output', A.planner, {
        stream: 'thinking',
        chunk: 'Scanning the existing theme setup to size the refactor before writing the plan.',
      }),
    ],
  },
  {
    atMs: 5500,
    make: (c) => [
      ev(c, 'agent_tool_called', A.planner, {
        toolCallId: 'tc-plan-1',
        tool: 'Read',
        inputSummary: 'src/theme/tokens.ts',
      }),
      ev(c, 'agent_file_read', A.planner, { path: 'src/theme/tokens.ts' }),
    ],
  },
  {
    atMs: 7200,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.planner, {
        toolCallId: 'tc-plan-1',
        ok: true,
        durationMs: 1500,
        resultSummary: '182 lines',
      }),
      ev(c, 'agent_tool_called', A.planner, {
        toolCallId: 'tc-plan-2',
        tool: 'Read',
        inputSummary: 'src/App.tsx',
      }),
      ev(c, 'agent_file_read', A.planner, { path: 'src/App.tsx' }),
    ],
  },
  {
    atMs: 9000,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.planner, {
        toolCallId: 'tc-plan-2',
        ok: true,
        durationMs: 1600,
        resultSummary: '96 lines',
      }),
      ev(c, 'agent_output', A.planner, {
        stream: 'message',
        chunk:
          'Plan:\n1. Refactor ThemeProvider to serve light/dark palettes from one context\n2. Add dark token set in src/theme/darkPalette.ts\n3. Migrate Button/Nav/Card styles to tokens\n4. npm test gate\n5. Reviewer pass before completion',
      }),
    ],
  },
  {
    atMs: 11000,
    make: (c) => [
      ev(c, 'agent_created', A.researcher, {
        name: 'Researcher',
        kind: 'workflow-agent',
        agentType: 'researcher',
        parentAgentId: A.main,
        model: 'claude-haiku-4-5',
        phase: 'Research',
      }),
      ev(c, 'dependency_created', undefined, {
        fromAgentId: A.main,
        toAgentId: A.researcher,
        kind: 'spawns',
      }),
      ev(c, 'dependency_created', undefined, {
        fromAgentId: A.planner,
        toAgentId: A.researcher,
        kind: 'feeds',
      }),
      ev(c, 'agent_started', A.researcher, {}),
    ],
  },
  {
    atMs: 12500,
    make: (c) => [
      ev(c, 'agent_tool_called', A.researcher, {
        toolCallId: 'tc-res-1',
        tool: 'Grep',
        inputSummary: 'useTheme(',
        detail: 'src/**/*.{ts,tsx}',
      }),
    ],
  },
  {
    atMs: 14000,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.researcher, {
        toolCallId: 'tc-res-1',
        ok: true,
        durationMs: 1200,
        resultSummary: '14 matches across 6 files',
      }),
      ev(c, 'agent_tool_called', A.researcher, {
        toolCallId: 'tc-res-2',
        tool: 'Read',
        inputSummary: 'src/theme/ThemeProvider.tsx',
      }),
      ev(c, 'agent_file_read', A.researcher, { path: 'src/theme/ThemeProvider.tsx' }),
    ],
  },
  {
    atMs: 15500,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.researcher, {
        toolCallId: 'tc-res-2',
        ok: true,
        durationMs: 1300,
      }),
      ev(c, 'agent_tool_called', A.researcher, {
        toolCallId: 'tc-res-3',
        tool: 'Read',
        inputSummary: 'src/theme/palette.ts',
      }),
      ev(c, 'agent_file_read', A.researcher, { path: 'src/theme/palette.ts' }),
    ],
  },
  {
    atMs: 17000,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.researcher, {
        toolCallId: 'tc-res-3',
        ok: true,
        durationMs: 1300,
      }),
      ev(c, 'agent_tool_called', A.researcher, {
        toolCallId: 'tc-res-4',
        tool: 'Read',
        inputSummary: 'src/theme/useTheme.ts',
      }),
      ev(c, 'agent_file_read', A.researcher, { path: 'src/theme/useTheme.ts' }),
    ],
  },
  {
    atMs: 18500,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.researcher, {
        toolCallId: 'tc-res-4',
        ok: true,
        durationMs: 1200,
      }),
      ev(c, 'agent_tool_called', A.researcher, {
        toolCallId: 'tc-res-5',
        tool: 'Read',
        inputSummary: 'src/components/Button.module.css',
      }),
      ev(c, 'agent_file_read', A.researcher, { path: 'src/components/Button.module.css' }),
    ],
  },
  {
    atMs: 20000,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.researcher, {
        toolCallId: 'tc-res-5',
        ok: true,
        durationMs: 1100,
      }),
      ev(c, 'agent_output', A.researcher, {
        stream: 'message',
        chunk:
          'Findings: theme state is centralized in ThemeProvider via context; palette.ts hard-codes light hex values in 3 places; Button/Nav/Card read colors directly instead of via tokens.',
      }),
    ],
  },
  {
    atMs: 21500,
    make: (c) => [
      ev(c, 'token_usage', A.planner, {
        usage: { inputTokens: 12400, outputTokens: 1850, cacheReadTokens: 8200, contextPct: 14 },
      }),
      ev(c, 'agent_completed', A.planner, {
        summary:
          'Plan ready: provider refactor, dark tokens, 3 component migrations, test and review gates.',
      }),
    ],
  },
  {
    atMs: 23000,
    make: (c) => [
      ev(c, 'token_usage', A.researcher, {
        usage: { inputTokens: 9800, outputTokens: 940, cacheReadTokens: 5100, contextPct: 9 },
      }),
      ev(c, 'agent_completed', A.researcher, {
        summary: 'Mapped theme architecture; flagged 3 hard-coded palettes and direct color reads.',
      }),
    ],
  },
  {
    // Both coders are created in the same second and run in parallel.
    atMs: 25000,
    make: (c) => [
      ev(c, 'agent_created', A.coderA, {
        name: 'Coder A',
        kind: 'workflow-agent',
        agentType: 'coder',
        parentAgentId: A.planner,
        model: 'claude-sonnet-4-5',
        phase: 'Implement',
      }),
      ev(c, 'agent_created', A.coderB, {
        name: 'Coder B',
        kind: 'workflow-agent',
        agentType: 'coder',
        parentAgentId: A.planner,
        model: 'claude-sonnet-4-5',
        phase: 'Implement',
      }),
      ev(c, 'dependency_created', undefined, {
        fromAgentId: A.planner,
        toAgentId: A.coderA,
        kind: 'spawns',
      }),
      ev(c, 'dependency_created', undefined, {
        fromAgentId: A.planner,
        toAgentId: A.coderB,
        kind: 'spawns',
      }),
      ev(c, 'agent_started', A.coderA, {}),
      ev(c, 'agent_started', A.coderB, {}),
    ],
  },
  {
    atMs: 26500,
    make: (c) => [
      ev(c, 'agent_output', A.coderA, {
        stream: 'thinking',
        chunk:
          'Refactoring ThemeProvider: theme name and resolved palette must come from a single context value.',
      }),
    ],
  },
  {
    atMs: 27500,
    make: (c) => [
      ev(c, 'agent_tool_called', A.coderA, {
        toolCallId: 'tc-a-1',
        tool: 'Read',
        inputSummary: 'src/theme/ThemeProvider.tsx',
      }),
      ev(c, 'agent_file_read', A.coderA, { path: 'src/theme/ThemeProvider.tsx' }),
      ev(c, 'agent_output', A.coderB, {
        stream: 'thinking',
        chunk: 'Migrating component styles to theme tokens; starting with Button.',
      }),
    ],
  },
  {
    atMs: 29000,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.coderA, {
        toolCallId: 'tc-a-1',
        ok: true,
        durationMs: 1400,
      }),
      ev(c, 'agent_tool_called', A.coderB, {
        toolCallId: 'tc-b-1',
        tool: 'Read',
        inputSummary: 'src/components/Button.module.css',
      }),
      ev(c, 'agent_file_read', A.coderB, { path: 'src/components/Button.module.css' }),
    ],
  },
  {
    atMs: 30500,
    make: (c) => [
      ev(c, 'agent_tool_called', A.coderA, {
        toolCallId: 'tc-a-2',
        tool: 'Write',
        inputSummary: 'src/theme/darkPalette.ts',
      }),
      ev(c, 'agent_file_modified', A.coderA, {
        path: 'src/theme/darkPalette.ts',
        changeKind: 'created',
      }),
      ev(c, 'agent_tool_completed', A.coderB, {
        toolCallId: 'tc-b-1',
        ok: true,
        durationMs: 1200,
      }),
    ],
  },
  {
    atMs: 32000,
    make: (c) => [
      ev(c, 'agent_output', A.coderA, {
        stream: 'message',
        chunk:
          "export const darkPalette: Palette = {\n  bg: '#0f1115',\n  surface: '#161a22',\n  text: '#e6e9ef',\n  accent: '#7aa2ff',\n};",
      }),
      ev(c, 'agent_tool_called', A.coderB, {
        toolCallId: 'tc-b-2',
        tool: 'Edit',
        inputSummary: 'src/components/Button.module.css',
      }),
      ev(c, 'agent_file_modified', A.coderB, {
        path: 'src/components/Button.module.css',
        changeKind: 'edited',
      }),
    ],
  },
  {
    atMs: 33500,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.coderA, {
        toolCallId: 'tc-a-2',
        ok: true,
        durationMs: 900,
      }),
      ev(c, 'agent_tool_completed', A.coderB, {
        toolCallId: 'tc-b-2',
        ok: true,
        durationMs: 1100,
      }),
    ],
  },
  {
    atMs: 35000,
    make: (c) => [
      ev(c, 'agent_tool_called', A.coderA, {
        toolCallId: 'tc-a-3',
        tool: 'Edit',
        inputSummary: 'src/theme/ThemeProvider.tsx',
      }),
      ev(c, 'agent_file_modified', A.coderA, {
        path: 'src/theme/ThemeProvider.tsx',
        changeKind: 'edited',
      }),
      ev(c, 'agent_output', A.coderB, {
        stream: 'message',
        chunk: '.button {\n  background: var(--vw-surface);\n  color: var(--vw-text);\n}',
      }),
    ],
  },
  {
    atMs: 37000,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.coderA, {
        toolCallId: 'tc-a-3',
        ok: true,
        durationMs: 1800,
      }),
      ev(c, 'agent_tool_called', A.coderB, {
        toolCallId: 'tc-b-3',
        tool: 'Edit',
        inputSummary: 'src/components/Nav.module.css',
      }),
      ev(c, 'agent_file_modified', A.coderB, {
        path: 'src/components/Nav.module.css',
        changeKind: 'edited',
      }),
    ],
  },
  {
    atMs: 39000,
    make: (c) => [
      ev(c, 'agent_output', A.coderA, {
        stream: 'message',
        chunk:
          "const value = useMemo(\n  () => ({ theme, palette: theme === 'dark' ? darkPalette : lightPalette, toggle }),\n  [theme],\n);",
      }),
      ev(c, 'agent_tool_completed', A.coderB, {
        toolCallId: 'tc-b-3',
        ok: true,
        durationMs: 1300,
      }),
    ],
  },
  {
    atMs: 41000,
    make: (c) => [
      ev(c, 'agent_tool_called', A.coderB, {
        toolCallId: 'tc-b-4',
        tool: 'Edit',
        inputSummary: 'src/components/Card.module.css',
      }),
      ev(c, 'agent_file_modified', A.coderB, {
        path: 'src/components/Card.module.css',
        changeKind: 'edited',
      }),
    ],
  },
  {
    atMs: 43000,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.coderB, {
        toolCallId: 'tc-b-4',
        ok: true,
        durationMs: 1200,
      }),
      ev(c, 'agent_output', A.coderB, {
        stream: 'message',
        chunk: 'Button, Nav, and Card now consume theme tokens; no hard-coded hex left in modules.',
      }),
    ],
  },
  {
    atMs: 45000,
    make: (c) => [
      ev(c, 'agent_created', A.tester, {
        name: 'Tester',
        kind: 'workflow-agent',
        agentType: 'tester',
        parentAgentId: A.main,
        model: 'claude-haiku-4-5',
        phase: 'Test',
      }),
      ev(c, 'dependency_created', undefined, {
        fromAgentId: A.coderA,
        toAgentId: A.tester,
        kind: 'feeds',
      }),
      ev(c, 'dependency_created', undefined, {
        fromAgentId: A.coderB,
        toAgentId: A.tester,
        kind: 'feeds',
      }),
      ev(c, 'agent_started', A.tester, {}),
    ],
  },
  {
    atMs: 46500,
    make: (c) => [
      ev(c, 'agent_command_started', A.tester, {
        commandId: 'cmd-test-1',
        command: 'npm test',
        cwd: '~/projects/acme-web',
        description: 'Run unit tests after theme changes',
      }),
    ],
  },
  {
    atMs: 49000,
    make: (c) => [
      ev(c, 'agent_output', A.tester, {
        stream: 'stdout',
        chunk:
          '✓ src/theme/ThemeProvider.test.tsx (12 tests) 841ms\n✓ src/components/Button.test.tsx (8 tests) 412ms\n✓ src/components/Nav.test.tsx (6 tests) 388ms',
      }),
    ],
  },
  {
    atMs: 51500,
    make: (c) => [
      ev(c, 'agent_command_completed', A.tester, {
        commandId: 'cmd-test-1',
        ok: true,
        exitCode: 0,
        durationMs: 4800,
      }),
      ev(c, 'agent_output', A.tester, {
        stream: 'stdout',
        chunk: 'Test Files  6 passed (6)\n     Tests  34 passed (34)\n  Duration  4.8s',
      }),
    ],
  },
  {
    atMs: 54000,
    make: (c) => [
      ev(c, 'agent_created', A.reviewer, {
        name: 'Reviewer',
        kind: 'workflow-agent',
        agentType: 'reviewer',
        parentAgentId: A.main,
        model: 'claude-opus-4-1',
        phase: 'Review',
      }),
      ev(c, 'dependency_created', undefined, {
        fromAgentId: A.reviewer,
        toAgentId: A.coderA,
        kind: 'reviews',
      }),
      ev(c, 'agent_started', A.reviewer, {}),
    ],
  },
  {
    atMs: 55500,
    make: (c) => [
      ev(c, 'agent_tool_called', A.reviewer, {
        toolCallId: 'tc-rev-1',
        tool: 'Read',
        inputSummary: 'src/theme/ThemeProvider.tsx',
      }),
      ev(c, 'agent_file_read', A.reviewer, { path: 'src/theme/ThemeProvider.tsx' }),
    ],
  },
  {
    atMs: 57500,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.reviewer, {
        toolCallId: 'tc-rev-1',
        ok: true,
        durationMs: 1700,
      }),
      ev(c, 'agent_output', A.reviewer, {
        stream: 'thinking',
        chunk:
          'Provider looks clean, but theme state initializes to light on every mount: the user preference is not persisted anywhere.',
      }),
    ],
  },
  {
    atMs: 60000,
    make: (c) => [
      ev(c, 'approval_requested', A.reviewer, {
        requestId: 'req-review-1',
        kind: 'question',
        prompt:
          'Reviewer flags: ThemeProvider drops user preference on reload, apply suggested fix?',
        options: ['Apply fix', 'Ship as is'],
      }),
      ev(c, 'agent_blocked', A.coderA, {
        reason: 'Blocked on review decision: persist theme preference across reloads',
        kind: 'dependency',
      }),
    ],
  },
  {
    atMs: 66000,
    make: (c) => [
      ev(c, 'approval_resolved', A.reviewer, {
        requestId: 'req-review-1',
        resolution: 'Apply fix',
      }),
      ev(c, 'agent_retried', A.coderA, { retryCount: 1 }),
    ],
  },
  {
    atMs: 68000,
    make: (c) => [
      ev(c, 'agent_tool_called', A.coderA, {
        toolCallId: 'tc-a-4',
        tool: 'Edit',
        inputSummary: 'src/theme/ThemeProvider.tsx',
      }),
      ev(c, 'agent_file_modified', A.coderA, {
        path: 'src/theme/ThemeProvider.tsx',
        changeKind: 'edited',
      }),
    ],
  },
  {
    atMs: 70000,
    make: (c) => [
      ev(c, 'agent_tool_completed', A.coderA, {
        toolCallId: 'tc-a-4',
        ok: true,
        durationMs: 1500,
      }),
      ev(c, 'agent_output', A.coderA, {
        stream: 'message',
        chunk:
          "const [theme, setTheme] = useState<Theme>(\n  () => (localStorage.getItem('vw-theme') as Theme) ?? 'light',\n);",
      }),
    ],
  },
  {
    atMs: 72000,
    make: (c) => [
      ev(c, 'agent_output', A.coderA, {
        stream: 'message',
        chunk: 'Preference now persists via localStorage and hydrates before first paint.',
      }),
    ],
  },
  {
    atMs: 74000,
    make: (c) => [
      ev(c, 'agent_command_started', A.tester, {
        commandId: 'cmd-test-2',
        command: 'npm test',
        cwd: '~/projects/acme-web',
        description: 'Re-run tests after review fix',
      }),
    ],
  },
  {
    atMs: 77000,
    make: (c) => [
      ev(c, 'agent_output', A.tester, {
        stream: 'stdout',
        chunk: '✓ src/theme/ThemeProvider.test.tsx (12 tests) 802ms',
      }),
    ],
  },
  {
    atMs: 79500,
    make: (c) => [
      ev(c, 'agent_command_completed', A.tester, {
        commandId: 'cmd-test-2',
        ok: true,
        exitCode: 0,
        durationMs: 4100,
      }),
      ev(c, 'agent_output', A.tester, {
        stream: 'stdout',
        chunk: 'Test Files  6 passed (6)\n     Tests  34 passed (34)\n  Duration  4.1s',
      }),
    ],
  },
  {
    atMs: 82000,
    make: (c) => [
      ev(c, 'token_usage', A.main, {
        usage: { inputTokens: 18400, outputTokens: 2200, cacheReadTokens: 11000, contextPct: 21 },
      }),
      ev(c, 'token_usage', A.coderA, {
        usage: { inputTokens: 15200, outputTokens: 3400, cacheReadTokens: 9600, contextPct: 18 },
      }),
      ev(c, 'token_usage', A.coderB, {
        usage: { inputTokens: 13100, outputTokens: 2900, cacheReadTokens: 8800, contextPct: 16 },
      }),
      ev(c, 'token_usage', A.tester, {
        usage: { inputTokens: 6200, outputTokens: 800, cacheReadTokens: 4100, contextPct: 7 },
      }),
      ev(c, 'token_usage', A.reviewer, {
        usage: { inputTokens: 8800, outputTokens: 1200, cacheReadTokens: 5400, contextPct: 10 },
      }),
    ],
  },
  {
    atMs: 84000,
    make: (c) => [
      ev(c, 'agent_completed', A.coderB, {
        summary: 'Migrated Button, Nav, and Card styles to theme tokens.',
      }),
      ev(c, 'agent_completed', A.coderA, {
        summary:
          'ThemeProvider refactored with dark palette and persisted preference (1 review fix applied).',
      }),
    ],
  },
  {
    atMs: 85500,
    make: (c) => [
      ev(c, 'agent_completed', A.tester, {
        summary: '34 tests passing across 6 files; both runs green.',
      }),
      ev(c, 'agent_completed', A.reviewer, {
        summary: 'Approved after persistence fix; no further findings.',
      }),
    ],
  },
  {
    atMs: 87000,
    make: (c) => [
      ev(c, 'agent_output', A.main, {
        stream: 'message',
        chunk:
          'Dark mode is in: ThemeProvider serves both palettes, the preference persists across reloads, Button/Nav/Card use tokens, and all 34 tests pass. The reviewer caught a persistence bug and the fix is applied.',
      }),
      ev(c, 'agent_completed', A.main, {
        summary: 'Dark mode shipped with review fix and green tests.',
      }),
    ],
  },
  {
    atMs: 89000,
    make: (c) => [
      ev(c, 'workflow_completed', undefined, {
        status: 'completed',
        summary:
          'Dark mode implemented: provider refactor, token migration, review fix applied, 34 tests green.',
      }),
      ev(c, 'session_ended', undefined, { reason: 'demo complete' }),
    ],
  },
];

/** Total scripted duration at speed 1. */
export const DEMO_TOTAL_MS = Math.max(...DEMO_TIMELINE.map((s) => s.atMs));
