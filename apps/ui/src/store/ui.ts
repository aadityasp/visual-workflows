/**
 * UI preferences + view state (docs/UI_SPEC.md). Theme and motion/minimap
 * preferences persist to localStorage; ephemeral view state (selection,
 * focus, camera intents, replay transport) does not.
 *
 * Reduced motion = system preference unless the user overrides it. The
 * effective value drives the `data-reduced-motion` attribute on <html>,
 * which gates every ambient animation in one place.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentLifecycle } from '@visual-workflows/protocol';

export type Theme = 'dark' | 'light';
export type ViewMode = 'overview' | 'follow';
export type ReplaySpeed = 1 | 4 | 16 | 'max';

export interface ReplayTransport {
  recordingId: string | null;
  sessionId: string | null;
  playing: boolean;
  speed: ReplaySpeed;
  seq: number;
  minSeq: number;
  maxSeq: number;
  /** Bucketed event counts across the seq range, for the scrubber sparkline. */
  density: number[];
}

const IDLE_REPLAY: ReplayTransport = {
  recordingId: null,
  sessionId: null,
  playing: false,
  speed: 1,
  seq: 0,
  minSeq: 0,
  maxSeq: 0,
  density: [],
};

interface Persisted {
  theme: Theme;
  reducedMotionOverride: boolean | null;
  minimapVisible: boolean;
}

interface UiState extends Persisted {
  systemReducedMotion: boolean;
  viewMode: ViewMode;
  selectedAgentId: string | null;
  focusAgentId: string | null;
  activeSessionId: string | null;
  shortcutsOpen: boolean;
  /**
   * Per-agent minimize override (docs/UI_SPEC.md "Glass panels & per-panel
   * minimize/expand"). `true` = collapsed to chip, `false` = kept expanded.
   * Absent = follow the default (completed/cancelled collapse, others don't).
   */
  collapsed: Record<string, boolean>;

  /** Bumped to ask the canvas to fit the whole graph. */
  fitNonce: number;
  /** Bumped to ask the canvas to center a specific agent. */
  centerNonce: number;
  centerAgentId: string | null;

  replay: ReplayTransport;

  setTheme(theme: Theme): void;
  toggleTheme(): void;
  setReducedMotionOverride(value: boolean | null): void;
  setSystemReducedMotion(value: boolean): void;
  setViewMode(mode: ViewMode): void;
  toggleFollow(): void;
  select(agentId: string | null): void;
  setFocus(agentId: string | null): void;
  setActiveSession(sessionId: string | null): void;
  toggleMinimap(): void;
  setCollapsed(agentId: string, value: boolean): void;
  openShortcuts(): void;
  closeShortcuts(): void;
  toggleShortcuts(): void;
  requestFit(): void;
  requestCenter(agentId: string): void;

  startReplay(init: {
    recordingId: string;
    sessionId: string;
    minSeq: number;
    maxSeq: number;
    density: number[];
  }): void;
  setReplaySeq(seq: number): void;
  setReplayPlaying(playing: boolean): void;
  setReplaySpeed(speed: ReplaySpeed): void;
  stopReplay(): void;
}

function initialSystemReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      reducedMotionOverride: null,
      minimapVisible: true,
      systemReducedMotion: initialSystemReducedMotion(),
      viewMode: 'overview',
      selectedAgentId: null,
      focusAgentId: null,
      activeSessionId: null,
      shortcutsOpen: false,
      collapsed: {},
      fitNonce: 0,
      centerNonce: 0,
      centerAgentId: null,
      replay: { ...IDLE_REPLAY },

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      setReducedMotionOverride: (reducedMotionOverride) => set({ reducedMotionOverride }),
      setSystemReducedMotion: (systemReducedMotion) => set({ systemReducedMotion }),
      setViewMode: (viewMode) => set({ viewMode }),
      toggleFollow: () => set({ viewMode: get().viewMode === 'follow' ? 'overview' : 'follow' }),
      select: (selectedAgentId) => set({ selectedAgentId }),
      setFocus: (focusAgentId) => set({ focusAgentId }),
      setActiveSession: (activeSessionId) =>
        set({ activeSessionId, selectedAgentId: null, focusAgentId: null, collapsed: {} }),
      toggleMinimap: () => set({ minimapVisible: !get().minimapVisible }),
      setCollapsed: (agentId, value) =>
        set({ collapsed: { ...get().collapsed, [agentId]: value } }),
      openShortcuts: () => set({ shortcutsOpen: true }),
      closeShortcuts: () => set({ shortcutsOpen: false }),
      toggleShortcuts: () => set({ shortcutsOpen: !get().shortcutsOpen }),
      requestFit: () => set({ fitNonce: get().fitNonce + 1 }),
      requestCenter: (agentId) =>
        set({ centerAgentId: agentId, centerNonce: get().centerNonce + 1 }),

      startReplay: ({ recordingId, sessionId, minSeq, maxSeq, density }) =>
        set({
          activeSessionId: sessionId,
          selectedAgentId: null,
          focusAgentId: null,
          collapsed: {},
          viewMode: 'overview',
          replay: {
            recordingId,
            sessionId,
            playing: false,
            speed: 1,
            seq: maxSeq,
            minSeq,
            maxSeq,
            density,
          },
        }),
      setReplaySeq: (seq) => set({ replay: { ...get().replay, seq } }),
      setReplayPlaying: (playing) => set({ replay: { ...get().replay, playing } }),
      setReplaySpeed: (speed) => set({ replay: { ...get().replay, speed } }),
      stopReplay: () => set({ replay: { ...IDLE_REPLAY } }),
    }),
    {
      name: 'vw-ui',
      partialize: (s): Persisted => ({
        theme: s.theme,
        reducedMotionOverride: s.reducedMotionOverride,
        minimapVisible: s.minimapVisible,
      }),
    },
  ),
);

/** The effective reduced-motion value: explicit override wins over system. */
export function effectiveReducedMotion(s: UiState): boolean {
  return s.reducedMotionOverride ?? s.systemReducedMotion;
}

export function isReplaying(s: UiState): boolean {
  return s.replay.recordingId !== null;
}

/**
 * Whether an agent renders as a compact chip: the user's explicit minimize
 * override wins; otherwise completed/cancelled agents collapse by default.
 */
export function agentCollapsed(
  collapsed: Record<string, boolean>,
  agentId: string,
  lifecycle: AgentLifecycle,
): boolean {
  const override = collapsed[agentId];
  if (override !== undefined) return override;
  return lifecycle === 'completed' || lifecycle === 'cancelled';
}
