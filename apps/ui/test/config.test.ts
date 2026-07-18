// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { authHeaders, bridgeWsUrl } from '../src/app/config';

describe('bridge endpoint config', () => {
  it('never places the token in the WebSocket URL, even when one is present', () => {
    // Seed a ?token= on the page URL (the only source the client reads).
    window.history.replaceState({}, '', '/?token=secret-abc123');

    const url = bridgeWsUrl();
    expect(url).toContain('/ws');
    // "token never in URL": the secret must not appear in the ws URL/query.
    expect(url.toLowerCase()).not.toContain('token');
    expect(url).not.toContain('secret-abc123');

    // The token still authenticates HTTP requests via the Bearer header.
    expect(authHeaders().Authorization).toBe('Bearer secret-abc123');
  });
});
