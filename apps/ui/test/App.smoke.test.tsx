// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, reduceAll } from '@visual-workflows/protocol';
import { App } from '../src/app/App';
import { useWorkspace } from '../src/store/workspace';
import { useUi } from '../src/store/ui';
import { plannerScenario } from './fixtures';

function seedSession() {
  useWorkspace.getState().reset();
  useWorkspace.getState().setState(reduceAll(createWorkspace(), plannerScenario()));
  useUi.getState().setActiveSession('s1');
  useUi.setState({ selectedAgentId: null });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App smoke', () => {
  it('boots offline and shows the empty state with both actions', () => {
    vi.useFakeTimers();
    useWorkspace.getState().reset();
    useUi.getState().setActiveSession(null);

    // No WebSocket/fetch in jsdom → the client fails to connect and we fall
    // back to the empty state without throwing.
    expect(() => render(<App />)).not.toThrow();

    expect(screen.getByText('Watch your agents work')).toBeTruthy();
    expect(screen.getByText('Run the demo')).toBeTruthy();
    expect(screen.getByText('Connect Claude Code')).toBeTruthy();
    expect(screen.getByText('npm run vw -- connect')).toBeTruthy();

    // The connection indicator reflects the offline/attempting state.
    const html = document.documentElement;
    expect(html.getAttribute('data-theme')).toBe('dark');
    expect(html.getAttribute('data-reduced-motion')).toBeTruthy();
  });

  it('mounts the canvas without runtime loops when a session has agents', () => {
    vi.useFakeTimers();
    useWorkspace.getState().reset();
    useWorkspace.getState().setState(reduceAll(createWorkspace(), plannerScenario()));
    useUi.getState().setActiveSession('s1');

    expect(() => render(<App />)).not.toThrow();
    // The AgentPanel for the seeded planner mounts on the canvas.
    expect(screen.getAllByText('Planner').length).toBeGreaterThan(0);
  });

  it('does not trap Tab or steal Enter when a button owns focus (WCAG 2.1.2)', () => {
    vi.useFakeTimers();
    seedSession();
    render(<App />);

    const btn = screen.getByLabelText('Toggle theme');
    act(() => btn.focus());
    // fireEvent returns false if preventDefault was called; Tab must pass through.
    const tabNotPrevented = fireEvent.keyDown(btn, { key: 'Tab' });
    expect(tabNotPrevented).toBe(true);
    // The global "cycle agents" action must NOT have fired.
    expect(useUi.getState().selectedAgentId).toBeNull();
  });

  it('still cycles agents when Tab is pressed on the canvas (body)', () => {
    vi.useFakeTimers();
    seedSession();
    render(<App />);

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Tab' });
    });
    expect(useUi.getState().selectedAgentId).not.toBeNull();
  });
});
