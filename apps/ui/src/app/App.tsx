/**
 * App shell (docs/UI_SPEC.md "Global layout"). Owns the socket lifecycle,
 * the global keyboard map, the html theme/motion attributes, and the
 * demo/replay flows. The heavy state lives in the stores; this component
 * wires intents to them.
 */
import { useEffect, useRef } from 'react';
import type { SessionSummary } from '@visual-workflows/protocol';
import { Canvas } from '../canvas/Canvas';
import { FocusView } from '../terminal/FocusView';
import { Transport } from '../replay/Transport';
import { useReplayController } from '../replay/controller';
import { clearReplayData, getReplayData, prepareReplay } from '../replay/data';
import { BridgeClient } from '../ws';
import { apiUrl, authHeaders } from './config';
import { resolveKey } from './keyboard';
import type { KeyAction } from './keyboard';
import { TopBar } from './TopBar';
import type { SessionChoice } from './TopBar';
import { StatusBar } from './StatusBar';
import { AttentionRail } from './AttentionRail';
import { EmptyState } from './EmptyState';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { AutoManage } from './AutoManage';
import { useUi, isReplaying, effectiveReducedMotion } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { useSessions } from '../store/sessions';
import { activeSession, agentCycleOrder, unresolvedAttention } from '../store/selectors';

/**
 * A window the forwarder opens is pinned to one session via `#vw=auto&session=<id>`,
 * so parallel Claude sessions each get their own scoped window instead of all
 * sharing one global "live" view.
 */
function pinnedSessionId(): string | null {
  try {
    const m = /[#&]session=([^&]+)/.exec(window.location.hash || '');
    return m && m[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function autoSelect(sessions: SessionSummary[]): void {
  const ui = useUi.getState();
  if (ui.activeSessionId || isReplaying(ui)) return;
  const pin = pinnedSessionId();
  if (pin) {
    // Session-scoped window: wait for ITS session to appear, and never fall
    // back to a different one — this window belongs to that session only.
    const hit = sessions.find((s) => s.sessionId === pin);
    if (hit) ui.setActiveSession(hit.sessionId);
    return;
  }
  const pick = sessions.find((s) => s.active) ?? sessions[0];
  if (pick) ui.setActiveSession(pick.sessionId);
}

function exitReplay(): void {
  useUi.getState().stopReplay();
  clearReplayData();
  useWorkspace.getState().reset();
  const list = useSessions.getState().sessions;
  const live = list.find((s) => s.active) ?? list[0];
  useUi.getState().setActiveSession(live?.sessionId ?? null);
}

async function startReplay(recordingId: string): Promise<void> {
  try {
    const res = await fetch(apiUrl(`/api/recordings/${encodeURIComponent(recordingId)}/events`), {
      headers: authHeaders(),
    });
    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return;
    useUi.getState().setActiveSession(null);
    useWorkspace.getState().reset();
    const meta = prepareReplay(recordingId, events);
    useUi.getState().startReplay({
      recordingId,
      sessionId: meta.sessionId,
      minSeq: meta.minSeq,
      maxSeq: meta.maxSeq,
      density: meta.density,
    });
  } catch {
    /* recording fetch failed — stay where we are */
  }
}

async function runDemo(): Promise<void> {
  if (isReplaying(useUi.getState())) exitReplay();
  try {
    const res = await fetch(apiUrl('/demo/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ speed: 1 }),
    });
    const data = (await res.json()) as { sessionId?: string };
    if (data.sessionId) {
      useSessions.getState().upsertSession({
        sessionId: data.sessionId,
        source: 'demo',
        title: 'Ship dark mode',
        active: true,
        agentCount: 0,
        lastSeq: 0,
      });
      useUi.getState().setActiveSession(data.sessionId);
    }
  } catch {
    /* bridge unreachable — EmptyState stays */
  }
}

function cycleSelection(dir: 1 | -1): void {
  const ui = useUi.getState();
  const session = activeSession(useWorkspace.getState().state, ui.activeSessionId);
  const order = agentCycleOrder(session);
  if (order.length === 0) return;
  const cur = ui.selectedAgentId;
  let idx: number;
  if (!cur || order.indexOf(cur) === -1) idx = dir > 0 ? 0 : order.length - 1;
  else idx = (order.indexOf(cur) + dir + order.length) % order.length;
  const next = order[idx];
  if (next) {
    ui.select(next);
    ui.requestCenter(next);
  }
}

function replayStep(dir: 1 | -1): void {
  const data = getReplayData();
  if (!data) return;
  const ui = useUi.getState();
  let curIdx = 0;
  for (let k = 0; k < data.seqs.length; k += 1) {
    if ((data.seqs[k] ?? 0) <= ui.replay.seq) curIdx = k;
    else break;
  }
  const nextIdx = Math.min(data.seqs.length - 1, Math.max(0, curIdx + dir));
  ui.setReplayPlaying(false);
  ui.setReplaySeq(data.seqs[nextIdx] ?? ui.replay.seq);
}

function attentionJump(index: number): void {
  const ui = useUi.getState();
  const session = activeSession(useWorkspace.getState().state, ui.activeSessionId);
  const item = unresolvedAttention(session)[index];
  if (item?.agentId) {
    ui.select(item.agentId);
    ui.requestCenter(item.agentId);
  }
}

function toggleFullscreen(): void {
  if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.();
  else void document.exitFullscreen?.();
}

/**
 * A focusable control (button/link/[role]/[tabindex]) or an element inside a
 * modal owns its own keys — global shortcuts must not fire there, or they trap
 * Tab and steal Enter/Space. Modals (dialog/overlay/focus) run their own trap.
 */
function isInteractiveTarget(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.closest('[role="dialog"], .vw-focus, .vw-overlay')) return true;
  if (/^(button|a|input|textarea|select)$/i.test(el.tagName)) return true;
  if (el.isContentEditable) return true;
  return el.hasAttribute('role') || el.hasAttribute('tabindex');
}

function dispatch(action: KeyAction, e: KeyboardEvent): void {
  const ui = useUi.getState();
  switch (action.type) {
    case 'toggle-shortcuts':
      ui.toggleShortcuts();
      e.preventDefault();
      break;
    case 'escape':
      if (ui.shortcutsOpen) ui.closeShortcuts();
      else if (ui.focusAgentId) ui.setFocus(null);
      else ui.select(null);
      break;
    case 'fit':
      ui.requestFit();
      break;
    case 'toggle-follow':
      ui.toggleFollow();
      break;
    case 'fullscreen':
      toggleFullscreen();
      e.preventDefault();
      break;
    case 'focus-selected':
      if (ui.selectedAgentId) ui.setFocus(ui.selectedAgentId);
      e.preventDefault();
      break;
    case 'cycle':
      cycleSelection(action.dir);
      e.preventDefault();
      break;
    case 'toggle-minimap':
      ui.toggleMinimap();
      break;
    case 'toggle-theme':
      ui.toggleTheme();
      break;
    case 'replay-toggle': {
      const r = ui.replay;
      if (r.recordingId) {
        if (!r.playing && r.seq >= r.maxSeq) ui.setReplaySeq(r.minSeq);
        ui.setReplayPlaying(!r.playing);
      }
      e.preventDefault();
      break;
    }
    case 'replay-step':
      replayStep(action.dir);
      e.preventDefault();
      break;
    case 'attention':
      attentionJump(action.index);
      e.preventDefault();
      break;
  }
}

export function App() {
  useReplayController();

  const clientRef = useRef<BridgeClient | null>(null);
  const theme = useUi((s) => s.theme);
  const reduced = useUi(effectiveReducedMotion);
  const setSystemReducedMotion = useUi((s) => s.setSystemReducedMotion);

  const activeSessionId = useUi((s) => s.activeSessionId);
  const replaying = useUi(isReplaying);
  const focusAgentId = useUi((s) => s.focusAgentId);
  const shortcutsOpen = useUi((s) => s.shortcutsOpen);
  const hasContent = useWorkspace((s) => {
    const sess = activeSession(s.state, activeSessionId);
    return Boolean(sess && sess.agentOrder.length > 0);
  });

  // html attributes drive theme + the single motion gate.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-reduced-motion', String(reduced));
  }, [theme, reduced]);

  // Window/tab title = the session's project (basename of its cwd, else its
  // title), so parallel auto-opened windows are distinguishable at a glance in
  // the OS window list / dock, not all named "visual-workflows".
  const projectLabel = useWorkspace((s) => {
    const sess = activeSession(s.state, activeSessionId);
    if (!sess) return null;
    const base = sess.cwd ? sess.cwd.replace(/\/+$/, '').split('/').pop() : undefined;
    return base || sess.title || null;
  });
  useEffect(() => {
    document.title = projectLabel ? `${projectLabel} · visual-workflows` : 'visual-workflows';
  }, [projectLabel]);

  // Track the system reduced-motion preference.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setSystemReducedMotion(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [setSystemReducedMotion]);

  // Socket lifecycle.
  useEffect(() => {
    const client = new BridgeClient({
      onConnection: (c) => useWorkspace.getState().setConnection(c),
      onHello: (hello) => {
        useSessions.getState().setHello(hello);
        autoSelect(hello.sessions);
      },
      onSessions: (list) => {
        useSessions.getState().setSessions(list);
        autoSelect(list);
      },
      onSnapshot: (_sid, state) => {
        if (isReplaying(useUi.getState())) return;
        useWorkspace.getState().applySnapshot(state);
      },
      onEvent: (event) => {
        if (isReplaying(useUi.getState())) return;
        useWorkspace.getState().enqueueEvent(event);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => client.close();
  }, []);

  // Subscribe to the active live session (never while replaying).
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    if (replaying) {
      client.unsubscribe();
      return;
    }
    if (activeSessionId) client.subscribe(activeSessionId);
  }, [activeSessionId, replaying]);

  // Global keyboard map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = Boolean(
        el && (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable),
      );
      const action = resolveKey(e, {
        typing,
        interactive: isInteractiveTarget(el),
        replayActive: isReplaying(useUi.getState()),
      });
      if (action) dispatch(action, e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSelectSession = (choice: SessionChoice) => {
    if (choice.kind === 'recording') {
      void startReplay(choice.id);
    } else {
      if (isReplaying(useUi.getState())) {
        useUi.getState().stopReplay();
        clearReplayData();
        useWorkspace.getState().reset();
      }
      useUi.getState().setActiveSession(choice.id);
    }
  };

  const showCanvas = replaying || hasContent;

  return (
    <div className="vw-app">
      <TopBar onSelectSession={onSelectSession} onRunDemo={() => void runDemo()} />
      <div className="vw-main">
        <div className="vw-stage">
          {showCanvas ? <Canvas /> : <EmptyState onRunDemo={() => void runDemo()} />}
          {focusAgentId ? <FocusView /> : null}
          {replaying ? <Transport onExit={exitReplay} /> : null}
        </div>
        <AttentionRail />
      </div>
      <StatusBar />
      {shortcutsOpen ? <ShortcutsOverlay /> : null}
      <AutoManage />
    </div>
  );
}
