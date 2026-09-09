// Setup for the `dom` vitest project (jsdom). Not loaded by the `unit`
// project, so node tests keep their current, faster startup.

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Unmount anything a test rendered. Without this, components stay in
// the document between tests and queries start matching leftovers from
// an earlier case — which shows up as a test that only fails when run
// with its neighbours.
afterEach(() => {
  cleanup();
});

// jsdom implements neither of these, and both are used by the app's
// layout code. Defining them here rather than in each test keeps the
// failure from surfacing as an unrelated-looking TypeError.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
