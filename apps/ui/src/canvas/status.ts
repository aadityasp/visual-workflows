/**
 * The status system: every visible state is icon + text (never color
 * alone), with a semantic tone that maps onto the CSS token palette.
 * See docs/UI_SPEC.md "Status system (accessible)".
 */
import type { AgentActivity, AgentLifecycle } from '@visual-workflows/protocol';

export type StatusTone = 'idle' | 'active' | 'think' | 'warn' | 'danger' | 'success';

export interface StatusMeta {
  icon: string;
  label: string;
  tone: StatusTone;
}

const ACTIVITY_META: Record<AgentActivity, StatusMeta> = {
  idle: { icon: '◌', label: 'Idle', tone: 'idle' },
  waiting: { icon: '◌', label: 'Waiting', tone: 'idle' },
  thinking: { icon: '◐', label: 'Thinking', tone: 'think' },
  reading: { icon: '▤', label: 'Reading', tone: 'active' },
  searching: { icon: '⌕', label: 'Searching', tone: 'active' },
  writing_code: { icon: '⌨', label: 'Writing code', tone: 'active' },
  running_command: { icon: '▶', label: 'Running', tone: 'active' },
  testing: { icon: '⚗', label: 'Testing', tone: 'active' },
  reviewing: { icon: '◎', label: 'Reviewing', tone: 'think' },
};

/** Combined lifecycle+activity to one visible status. */
export function statusFor(lifecycle: AgentLifecycle, activity: AgentActivity): StatusMeta {
  switch (lifecycle) {
    case 'created':
      return { icon: '◌', label: 'Queued', tone: 'idle' };
    case 'blocked':
      return { icon: '⊘', label: 'Blocked', tone: 'warn' };
    case 'awaiting_approval':
      return { icon: '❖', label: 'Needs approval', tone: 'warn' };
    case 'awaiting_input':
      return { icon: '⧖', label: 'Needs input', tone: 'warn' };
    case 'failed':
      return { icon: '⨯', label: 'Failed', tone: 'danger' };
    case 'completed':
      return { icon: '✓', label: 'Done', tone: 'success' };
    case 'cancelled':
      return { icon: '∅', label: 'Cancelled', tone: 'idle' };
    case 'running':
      return ACTIVITY_META[activity] ?? ACTIVITY_META.thinking;
  }
}

/** CSS color value (custom property) for a tone. */
export function toneColor(tone: StatusTone): string {
  switch (tone) {
    case 'idle':
      return 'var(--vw-text-dim)';
    case 'active':
      return 'var(--vw-running)';
    case 'think':
      return 'var(--vw-thinking)';
    case 'warn':
      return 'var(--vw-warn)';
    case 'danger':
      return 'var(--vw-danger)';
    case 'success':
      return 'var(--vw-success)';
  }
}

/** Minimap / dot color for a lifecycle. */
export function lifecycleColor(lifecycle: AgentLifecycle | undefined): string {
  switch (lifecycle) {
    case 'running':
      return 'var(--vw-running)';
    case 'blocked':
    case 'awaiting_approval':
    case 'awaiting_input':
      return 'var(--vw-warn)';
    case 'failed':
      return 'var(--vw-danger)';
    case 'completed':
      return 'var(--vw-success)';
    default:
      return 'var(--vw-text-faint)';
  }
}

export const TERMINAL_LIFECYCLES: ReadonlySet<AgentLifecycle> = new Set([
  'completed',
  'failed',
  'cancelled',
]);
