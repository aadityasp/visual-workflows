import { describe, expect, it } from 'vitest';
import { parseEventEnvelope } from '../src/schema.js';

const base = {
  v: 1,
  id: 'e1',
  seq: 1,
  ts: '2026-07-17T12:00:00.000Z',
  source: 'demo',
  sessionId: 's1',
};

describe('parseEventEnvelope', () => {
  it('accepts a valid known event', () => {
    const r = parseEventEnvelope({
      ...base,
      type: 'agent_output',
      agentId: 'a1',
      payload: { stream: 'stdout', chunk: 'hello' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.known).toBe(true);
  });

  it('accepts unknown event types with known:false (tolerant reader)', () => {
    const r = parseEventEnvelope({ ...base, type: 'future_event', payload: { x: 1 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.known).toBe(false);
  });

  it('rejects a broken envelope', () => {
    const r = parseEventEnvelope({ ...base, type: 'agent_output' }); // no payload
    expect(r.ok).toBe(false);
  });

  it('rejects known events with invalid payloads', () => {
    const r = parseEventEnvelope({
      ...base,
      type: 'agent_status_changed',
      payload: { reason: 'no lifecycle or activity' },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects wrong protocol version', () => {
    const r = parseEventEnvelope({ ...base, v: 2, type: 'session_started', payload: {} });
    expect(r.ok).toBe(false);
  });

  it('preserves extra payload fields (loose objects)', () => {
    const r = parseEventEnvelope({
      ...base,
      type: 'adapter_notice',
      payload: { level: 'info', message: 'm', extraDiagnostic: 42 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.event.payload as Record<string, unknown>)['extraDiagnostic']).toBe(42);
    }
  });

  it('rejects prototype-polluting session/agent/workflow ids', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(
        parseEventEnvelope({ ...base, sessionId: bad, type: 'session_started', payload: {} }).ok,
      ).toBe(false);
      expect(
        parseEventEnvelope({ ...base, agentId: bad, type: 'agent_started', payload: {} }).ok,
      ).toBe(false);
      expect(
        parseEventEnvelope({
          ...base,
          workflowId: bad,
          type: 'workflow_started',
          payload: { name: 'w', kind: 'workflow' },
        }).ok,
      ).toBe(false);
    }
  });

  it('rejects prototype-polluting agent ids inside payloads', () => {
    expect(
      parseEventEnvelope({
        ...base,
        type: 'dependency_created',
        payload: { fromAgentId: '__proto__', toAgentId: 'b', kind: 'feeds' },
      }).ok,
    ).toBe(false);
    expect(
      parseEventEnvelope({
        ...base,
        type: 'agent_created',
        payload: { name: 'X', kind: 'subagent', parentAgentId: 'constructor' },
      }).ok,
    ).toBe(false);
  });

  it('rejects empty-string agentId/workflowId', () => {
    expect(
      parseEventEnvelope({ ...base, agentId: '', type: 'agent_started', payload: {} }).ok,
    ).toBe(false);
    expect(
      parseEventEnvelope({
        ...base,
        workflowId: '',
        type: 'workflow_started',
        payload: { name: 'w', kind: 'workflow' },
      }).ok,
    ).toBe(false);
  });

  it('validates every dependency kind and rejects bad ones', () => {
    for (const kind of ['spawns', 'blocks', 'feeds', 'reviews']) {
      const r = parseEventEnvelope({
        ...base,
        type: 'dependency_created',
        payload: { fromAgentId: 'a', toAgentId: 'b', kind },
      });
      expect(r.ok).toBe(true);
    }
    const bad = parseEventEnvelope({
      ...base,
      type: 'dependency_created',
      payload: { fromAgentId: 'a', toAgentId: 'b', kind: 'teleports' },
    });
    expect(bad.ok).toBe(false);
  });
});
