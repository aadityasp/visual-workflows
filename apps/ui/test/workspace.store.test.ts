import { beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, reduceAll } from '@visual-workflows/protocol';
import { useWorkspace } from '../src/store/workspace';
import { ev, plannerScenario, resetSeq } from './fixtures';

describe('workspace store', () => {
  beforeEach(() => {
    useWorkspace.getState().reset();
  });

  it('applies batched event fixtures and agents appear', () => {
    const events = plannerScenario();
    for (const e of events) useWorkspace.getState().enqueueEvent(e);
    useWorkspace.getState().flush();

    const session = useWorkspace.getState().state.sessions['s1'];
    expect(session).toBeDefined();
    expect(session?.agents['main']).toBeDefined();
    expect(session?.agents['planner']?.name).toBe('Planner');
    expect(session?.agents['planner']?.agentType).toBe('planner');
    expect(session?.agents['planner']?.lifecycle).toBe('running');
    // a spawns dependency was created main -> planner
    expect(Object.values(session?.deps ?? {}).some((d) => d.kind === 'spawns')).toBe(true);
  });

  it('flush is a no-op with an empty buffer', () => {
    const before = useWorkspace.getState().state;
    useWorkspace.getState().flush();
    expect(useWorkspace.getState().state).toBe(before);
  });

  it('setState replaces state wholesale (the replay path)', () => {
    resetSeq();
    const events = [
      ev('session_started', undefined, { title: 'Replayed' }),
      ev('agent_created', 'coder', { name: 'Coder', kind: 'subagent' }),
    ];
    const replayed = reduceAll(createWorkspace(), events);
    useWorkspace.getState().setState(replayed);
    expect(useWorkspace.getState().state.sessions['s1']?.agents['coder']?.name).toBe('Coder');
  });

  it('tracks connection state', () => {
    useWorkspace.getState().setConnection('open');
    expect(useWorkspace.getState().connection).toBe('open');
  });
});
