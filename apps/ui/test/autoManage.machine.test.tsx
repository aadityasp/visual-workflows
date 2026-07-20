// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, reduceAll } from '@visual-workflows/protocol';
import type { WorkspaceState } from '@visual-workflows/protocol';
import { AutoManage } from '../src/app/AutoManage';
import { useWorkspace } from '../src/store/workspace';
import { useUi } from '../src/store/ui';
import { ev, resetSeq } from './fixtures';

/** Reduced states for a session that runs (active) then ends (inactive). */
function buildStates(sessionId: string): { active: WorkspaceState; ended: WorkspaceState } {
  resetSeq();
  const started = [
    ev('session_started', undefined, { title: 'Run' }, sessionId),
    ev('agent_created', 'planner', { name: 'Planner', kind: 'subagent' }, sessionId),
    ev('agent_started', 'planner', {}, sessionId),
  ];
  const active = reduceAll(createWorkspace(), started);
  const ended = reduceAll(active, [ev('session_ended', undefined, {}, sessionId)]);
  return { active, ended };
}

/** A session that stays active while its workflow runs then completes; a second
 * wave can be appended to test re-arming. */
function buildWorkflow(sessionId: string) {
  resetSeq();
  const base = [
    ev('session_started', undefined, { title: 'Run' }, sessionId),
    ev('agent_created', 'main', { name: 'Claude', kind: 'main' }, sessionId),
    ev('agent_created', 'coder', { name: 'Coder', kind: 'subagent' }, sessionId),
    ev('agent_started', 'coder', {}, sessionId),
  ];
  const running = reduceAll(createWorkspace(), base);
  const done = reduceAll(running, [ev('agent_completed', 'coder', {}, sessionId)]);
  const wave2running = reduceAll(done, [
    ev('agent_created', 'coder2', { name: 'Coder 2', kind: 'subagent' }, sessionId),
    ev('agent_started', 'coder2', {}, sessionId),
  ]);
  const wave2done = reduceAll(wave2running, [ev('agent_completed', 'coder2', {}, sessionId)]);
  return { running, done, wave2running, wave2done };
}

function isCounting(): boolean {
  // The counting phase is the only one that shows the "Keep open" affordance.
  return screen.queryByText('Keep open') !== null;
}

beforeEach(() => {
  window.location.hash = '#vw=auto';
  useWorkspace.getState().reset();
  useUi.getState().stopReplay();
  useUi.getState().setActiveSession(null);
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('AutoManage state machine', () => {
  it('arms the countdown on a witnessed session end', () => {
    const { active, ended } = buildStates('s1');
    render(<AutoManage />);

    act(() => {
      useUi.getState().setActiveSession('s1');
      useWorkspace.getState().setState(active);
    });
    // Still running → no dialog.
    expect(screen.queryByText('Run complete')).toBeNull();

    act(() => {
      useWorkspace.getState().setState(ended);
    });
    // Session ended → countdown offered.
    expect(screen.getByText('Run complete')).toBeTruthy();
    expect(isCounting()).toBe(true);
  });

  it('does NOT arm for a session loaded already-ended (never witnessed active)', () => {
    const { ended } = buildStates('s1');
    render(<AutoManage />);
    act(() => {
      useUi.getState().setActiveSession('s1');
      useWorkspace.getState().setState(ended);
    });
    expect(screen.queryByText('Run complete')).toBeNull();
  });

  it('Keep open sticks: later store notifications do NOT re-arm (regression)', () => {
    const { active, ended } = buildStates('s1');
    render(<AutoManage />);

    act(() => {
      useUi.getState().setActiveSession('s1');
      useWorkspace.getState().setState(active);
    });
    act(() => {
      useWorkspace.getState().setState(ended);
    });
    expect(isCounting()).toBe(true);

    // User chooses to stay.
    act(() => {
      fireEvent.click(screen.getByText('Keep open'));
    });
    expect(screen.queryByText('Run complete')).toBeNull();

    // The bug: the store keeps notifying (event-rate tick, reducer batches).
    // Each notification must NOT re-open the countdown for this same ended session.
    act(() => {
      for (let i = 0; i < 8; i += 1) useWorkspace.getState().setState(ended);
    });
    expect(screen.queryByText('Run complete')).toBeNull();
    expect(isCounting()).toBe(false);
  });

  it('a fresh, different session end can still arm after a dismiss', () => {
    const s1 = buildStates('s1');
    render(<AutoManage />);

    act(() => {
      useUi.getState().setActiveSession('s1');
      useWorkspace.getState().setState(s1.active);
    });
    act(() => {
      useWorkspace.getState().setState(s1.ended);
    });
    act(() => {
      fireEvent.click(screen.getByText('Keep open'));
    });
    expect(screen.queryByText('Run complete')).toBeNull();

    // A brand-new session runs and ends — the latch must not suppress it.
    const s2 = buildStates('s2');
    act(() => {
      useUi.getState().setActiveSession('s2');
      useWorkspace.getState().setState(s2.active);
    });
    act(() => {
      useWorkspace.getState().setState(s2.ended);
    });
    expect(screen.getByText('Run complete')).toBeTruthy();
    expect(isCounting()).toBe(true);
  });

  it('arms when the workflow finishes even though the session stays open', () => {
    const { running, done } = buildWorkflow('w1');
    render(<AutoManage />);

    act(() => {
      useUi.getState().setActiveSession('w1');
      useWorkspace.getState().setState(running);
    });
    // Subagent still working → no dialog (session is active the whole time).
    expect(screen.queryByText('Run complete')).toBeNull();

    act(() => {
      useWorkspace.getState().setState(done);
    });
    // All subagents done, session still open → offer to close.
    expect(screen.getByText('Run complete')).toBeTruthy();
    expect(isCounting()).toBe(true);
  });

  it('a second workflow wave after Keep open cancels the latch and re-arms', () => {
    const { running, done, wave2running, wave2done } = buildWorkflow('w1');
    render(<AutoManage />);

    act(() => {
      useUi.getState().setActiveSession('w1');
      useWorkspace.getState().setState(running);
    });
    act(() => {
      useWorkspace.getState().setState(done);
    });
    act(() => {
      fireEvent.click(screen.getByText('Keep open'));
    });
    expect(screen.queryByText('Run complete')).toBeNull();

    // A new subagent starts: the run is no longer done, latch clears.
    act(() => {
      useWorkspace.getState().setState(wave2running);
    });
    expect(screen.queryByText('Run complete')).toBeNull();

    // The second wave finishes → arms again despite the earlier Keep open.
    act(() => {
      useWorkspace.getState().setState(wave2done);
    });
    expect(screen.getByText('Run complete')).toBeTruthy();
    expect(isCounting()).toBe(true);
  });
});
