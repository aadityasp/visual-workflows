/**
 * Bridge endpoint configuration. Default is the local bridge on 4777;
 * override with VITE_VW_BRIDGE (http(s) origin). If the page URL carries a
 * `token` query param it is forwarded to the bridge as a Bearer header on
 * HTTP requests. The token is never placed in the WebSocket URL query: the
 * /ws endpoint is protected by the server's loopback-origin gate, and a URL
 * query would leak the token into logs/history ("token never in URL").
 */

const DEFAULT_BRIDGE = 'http://127.0.0.1:4777';

function fromEnv(): string | undefined {
  const v = import.meta.env.VITE_VW_BRIDGE as string | undefined;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

export function bridgeHttpBase(): string {
  return fromEnv() ?? DEFAULT_BRIDGE;
}

let cachedToken: string | null | undefined;

export function authToken(): string | undefined {
  if (cachedToken === undefined) {
    try {
      cachedToken = new URLSearchParams(window.location.search).get('token');
    } catch {
      cachedToken = null;
    }
  }
  return cachedToken ?? undefined;
}

export function bridgeWsUrl(): string {
  // The token is deliberately NOT appended here. Browsers cannot set headers on
  // a WebSocket handshake, and a `?token=` query would leak the secret into
  // server logs and browser history. The bridge authorizes /ws via its
  // loopback-origin gate instead, so the local flow needs no URL token.
  return `${bridgeHttpBase().replace(/^http/, 'ws')}/ws`;
}

export function authHeaders(): Record<string, string> {
  const t = authToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function apiUrl(path: string): string {
  return `${bridgeHttpBase()}${path}`;
}
