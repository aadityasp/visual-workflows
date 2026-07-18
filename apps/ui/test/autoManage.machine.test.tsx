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
    expect(screen.queryByText('Session complete')).toBeNull();

    act(() => {
      useWorkspace.getState().setState(ended);
    });
    // Session ended → countdown offered.
    expect(screen.getByText('Session complete')).toBeTruthy();
    expect(isCounting()).toBe(true);
  });

  it('does NOT arm for a session loaded already-ended (never witnessed active)', () => {
    const { ended } = buildStates('s1');
    render(<AutoManage />);
    act(() => {
      useUi.getState().setActiveSession('s1');
      useWorkspace.getState().setState(ended);
    });
    expect(screen.queryByText('Session complete')).toBeNull();
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
    expect(screen.queryByText('Session complete')).toBeNull();

    // The bug: the store keeps notifying (event-rate tick, reducer batches).
    // Each notification must NOT re-open the countdown for this same ended session.
    act(() => {
      for (let i = 0; i < 8; i += 1) useWorkspace.getState().setState(ended);
    });
    expect(screen.queryByText('Session complete')).toBeNull();
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
    expect(screen.queryByText('Session complete')).toBeNull();

    // A brand-new session runs and ends — the latch must not suppress it.
    const s2 = buildStates('s2');
    act(() => {
      useUi.getState().setActiveSession('s2');
      useWorkspace.getState().setState(s2.active);
    });
    act(() => {
      useWorkspace.getState().setState(s2.ended);
    });
    expect(screen.getByText('Session complete')).toBeTruthy();
    expect(isCounting()).toBe(true);
  });
});
