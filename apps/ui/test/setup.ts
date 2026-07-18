/**
 * Vitest jsdom setup. jsdom lacks a few browser primitives the stores and
 * components touch (matchMedia, ResizeObserver, rAF timing); polyfill just
 * enough so unit tests exercise real code paths without a real browser.
 */

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// React feature-detects animation/transition events via `window.AnimationEvent`.
// jsdom omits the constructor, so React registers the vendor-prefixed
// `webkitAnimationEnd` listener and a dispatched `animationend` never fires the
// handler. Defining the constructor makes React use the unprefixed name, which
// the character rig's one-shot tests rely on.
if (typeof globalThis.AnimationEvent === 'undefined') {
  class AnimationEventPolyfill extends Event {
    animationName: string;
    elapsedTime: number;
    pseudoElement: string;
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init);
      this.animationName = (init.animationName as string) ?? '';
      this.elapsedTime = (init.elapsedTime as number) ?? 0;
      this.pseudoElement = (init.pseudoElement as string) ?? '';
    }
  }
  globalThis.AnimationEvent = AnimationEventPolyfill as unknown as typeof AnimationEvent;
}
