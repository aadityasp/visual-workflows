// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { reduceAll, createWorkspace } from '@visual-workflows/protocol';
import { AgentPanelNode } from '../src/canvas/AgentPanelNode';
import { useWorkspace } from '../src/store/workspace';
import { useUi } from '../src/store/ui';
import { completedScenario, plannerScenario } from './fixtures';

afterEach(cleanup);

function renderNode(agentId: string, sessionId = 's1') {
  const props = {
    id: agentId,
    data: { agentId, sessionId, pinned: false },
  } as unknown as NodeProps;
  return render(
    <ReactFlowProvider>
      <AgentPanelNode {...props} />
    </ReactFlowProvider>,
  );
}

describe('AgentPanelNode', () => {
  beforeEach(() => {
    useWorkspace.getState().reset();
    useWorkspace.getState().setState(reduceAll(createWorkspace(), plannerScenario()));
    useUi.setState({ selectedAgentId: null, activeSessionId: 's1', collapsed: {} });
  });

  it('renders the agent name and a status chip for a running agent', () => {
    renderNode('planner');
    expect(screen.getByText('Planner')).toBeTruthy();
    expect(screen.getByText('planner')).toBeTruthy(); // agentType chip
    // running + reading (last tool was Read) → status label "Reading"
    expect(screen.getByText('Reading')).toBeTruthy();
  });

  it('exposes an accessible group label including the status', () => {
    const { container } = renderNode('planner');
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toContain('Planner');
  });

  it('renders nothing when the agent is missing', () => {
    const { container } = renderNode('ghost');
    expect(container.querySelector('.vw-panel-node')).toBeNull();
    expect(container.querySelector('.vw-chip-node')).toBeNull();
  });

  it('shows always-visible minimize and expand controls on the full panel', () => {
    renderNode('planner');
    expect(screen.getByLabelText('Minimize panel')).toBeTruthy();
    expect(screen.getByLabelText('Expand panel')).toBeTruthy();
  });

  it('minimizes a running agent to a chip that still shows the status, then restores', () => {
    const { container } = renderNode('planner');
    expect(container.querySelector('.vw-panel-node')).not.toBeNull();

    // Minimize a *running* agent (not just completed ones).
    act(() => {
      fireEvent.click(screen.getByLabelText('Minimize panel'));
    });
    expect(container.querySelector('.vw-panel-node')).toBeNull();
    const chip = container.querySelector('.vw-chip-node');
    expect(chip).not.toBeNull();
    // Chip keeps character + name + status chip.
    expect(screen.getByText('Planner')).toBeTruthy();
    expect(screen.getByText('Reading')).toBeTruthy();

    // Restore from the chip's control.
    act(() => {
      fireEvent.click(screen.getByLabelText('Restore Planner panel'));
    });
    expect(container.querySelector('.vw-panel-node')).not.toBeNull();
    expect(container.querySelector('.vw-chip-node')).toBeNull();
  });

  it('lets a user manually expand a completed agent (override beats auto-collapse)', () => {
    useWorkspace.getState().reset();
    useWorkspace.getState().setState(reduceAll(createWorkspace(), completedScenario()));
    useUi.setState({ selectedAgentId: null, activeSessionId: 's1', collapsed: {} });

    const { container } = renderNode('done1');
    // Completed agents auto-collapse to a chip by default.
    expect(container.querySelector('.vw-chip-node')).not.toBeNull();
    expect(container.querySelector('.vw-panel-node')).toBeNull();

    // Manual expand overrides the auto-collapse-on-complete.
    act(() => {
      fireEvent.click(screen.getByLabelText('Restore Finisher panel'));
    });
    expect(container.querySelector('.vw-panel-node')).not.toBeNull();
    expect(container.querySelector('.vw-chip-node')).toBeNull();

    // And it can be minimized again.
    act(() => {
      fireEvent.click(screen.getByLabelText('Minimize panel'));
    });
    expect(container.querySelector('.vw-chip-node')).not.toBeNull();
  });
});
