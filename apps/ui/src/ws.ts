/**
 * Bridge WebSocket client. Speaks the frames in packages/protocol/frames.ts:
 * connect → server `hello`; `subscribe` → `snapshot` then live `event`s.
 *
 * Resilient by construction: auto-reconnect with capped backoff, and on
 * reconnect it re-subscribes from the last seq it saw so no events are lost
 * across a blip. The socket is injectable so the frame handling can be unit
 * tested without a real WebSocket.
 */
import type {
  ClientFrame,
  EventEnvelope,
  RecordingSummary,
  ServerFrame,
  SessionSummary,
  WorkspaceState,
} from '@visual-workflows/protocol';
import { bridgeWsUrl } from './app/config';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The slice of the WebSocket API this client uses (real WebSocket satisfies it). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  readyState: number;
}

export type SocketFactory = (url: string) => SocketLike;

export interface BridgeHandlers {
  onConnection(state: ConnectionState): void;
  onHello(hello: {
    serverVersion: string;
    protocolV: number;
    sessions: SessionSummary[];
    recordings: RecordingSummary[];
  }): void;
  onSessions(sessions: SessionSummary[]): void;
  onSnapshot(sessionId: string, state: WorkspaceState, lastSeq: number): void;
  onEvent(event: EventEnvelope): void;
  onError?(message: string): void;
}

const OPEN = 1;
const MAX_BACKOFF_MS = 10_000;
const BASE_BACKOFF_MS = 500;
const PING_INTERVAL_MS = 20_000;

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export class BridgeClient {
  private socket: SocketLike | null = null;
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  /** Highest seq applied per session, so a resume asks for exactly the gap. */
  private lastSeq = new Map<string, number>();
  private everConnected = false;

  constructor(
    private handlers: BridgeHandlers,
    private factory: SocketFactory = defaultFactory,
    private urlProvider: () => string = bridgeWsUrl,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  /** Switch the subscription to a session (idempotent for the same id). */
  subscribe(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    if (this.sessionId) this.sendFrame({ kind: 'unsubscribe', sessionId: this.sessionId });
    this.sessionId = sessionId;
    this.sendSubscribe();
  }

  unsubscribe(): void {
    if (this.sessionId) this.sendFrame({ kind: 'unsubscribe', sessionId: this.sessionId });
    this.sessionId = null;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.socket?.close();
    this.socket = null;
    this.handlers.onConnection('closed');
  }

  private open(): void {
    this.handlers.onConnection(this.everConnected ? 'reconnecting' : 'connecting');
    let socket: SocketLike;
    try {
      socket = this.factory(this.urlProvider());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.everConnected = true;
      this.attempt = 0;
      this.handlers.onConnection('open');
      if (this.sessionId) this.sendSubscribe();
      this.startPing();
    };
    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onclose = () => this.handleDrop();
    socket.onerror = () => this.handleDrop();
  }

  private handleDrop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket = null;
    if (this.closedByUser) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.handlers.onConnection('reconnecting');
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.sendFrame({ kind: 'ping' }), PING_INTERVAL_MS);
  }

  private sendSubscribe(): void {
    if (!this.sessionId) return;
    const seen = this.lastSeq.get(this.sessionId);
    const frame: ClientFrame =
      seen !== undefined
        ? { kind: 'subscribe', sessionId: this.sessionId, fromSeq: seen + 1 }
        : { kind: 'subscribe', sessionId: this.sessionId };
    this.sendFrame(frame);
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.socket && this.socket.readyState === OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  /** Exposed for tests: feed a raw wire string as if it arrived on the socket. */
  handleMessage(data: unknown): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(String(data)) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.kind) {
      case 'hello':
        this.handlers.onHello({
          serverVersion: frame.serverVersion,
          protocolV: frame.protocolV,
          sessions: frame.sessions,
          recordings: frame.recordings,
        });
        break;
      case 'sessions':
        this.handlers.onSessions(frame.sessions);
        break;
      case 'snapshot':
        this.lastSeq.set(frame.sessionId, frame.lastSeq);
        this.handlers.onSnapshot(frame.sessionId, frame.state, frame.lastSeq);
        break;
      case 'event': {
        const prev = this.lastSeq.get(frame.event.sessionId) ?? 0;
        if (frame.event.seq > prev) this.lastSeq.set(frame.event.sessionId, frame.event.seq);
        this.handlers.onEvent(frame.event);
        break;
      }
      case 'error':
        this.handlers.onError?.(frame.message);
        break;
      case 'pong':
        break;
    }
  }
}
