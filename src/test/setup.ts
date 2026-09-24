import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  clearMocks();
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub;

// jsdom polyfills needed for ProseMirror / TipTap in tests
// Minimal stubs so the editor can mount without layout engine
if (typeof document !== "undefined") {
  // document.createRange is used by ProseMirror for decorations
  if (typeof document.createRange !== "function" || (() => {
    try {
      const r = document.createRange();
      return typeof r.getClientRects !== "function" || typeof r.getBoundingClientRect !== "function";
    } catch { return true; }
  })()) {
    // Provide a minimal Range stub when jsdom's is incomplete
    const originalCreateRange = document.createRange?.bind(document);
    document.createRange = () => {
      if (originalCreateRange) {
        try {
          const r = originalCreateRange();
          if (typeof r.getClientRects !== "function") {
            (r as unknown as { getClientRects: () => DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
          }
          if (typeof r.getBoundingClientRect !== "function") {
            (r as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
              ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {}; } } as DOMRect);
          }
          return r;
        } catch {
          // fall through to stub
        }
      }
      return {
        setStart() {},
        setEnd() {},
        getClientRects() { return [] as unknown as DOMRectList; },
        getBoundingClientRect() {
          return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {}; } } as unknown as DOMRect;
        },
        commonAncestorContainer: document.body,
      } as unknown as Range;
    };
  }
  // Ensure Range.prototype helpers exist for jsdom
  if (typeof Range !== "undefined") {
    if (typeof Range.prototype.getClientRects !== "function") {
      Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
    }
    if (typeof Range.prototype.getBoundingClientRect !== "function") {
      Range.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {}; } } as unknown as DOMRect;
      };
    }
  }
  // Provide no-op ClipboardEvent/DragEvent if missing (TipTap registers handlers)
  if (typeof window !== "undefined") {
    if (typeof (window as unknown as { ClipboardEvent?: unknown }).ClipboardEvent === "undefined") {
      (window as unknown as { ClipboardEvent: unknown }).ClipboardEvent = class ClipboardEvent extends Event {
        clipboardData = { getData: () => "", setData: () => {} } as unknown as DataTransfer;
        constructor(type: string, init?: EventInit) { super(type, init); }
      };
    }
    if (typeof (window as unknown as { DragEvent?: unknown }).DragEvent === "undefined") {
      (window as unknown as { DragEvent: unknown }).DragEvent = class DragEvent extends Event {
        dataTransfer = { getData: () => "", setData: () => {} } as unknown as DataTransfer;
        constructor(type: string, init?: EventInit) { super(type, init); }
      };
    }
    // ProseMirror calls document.elementFromPoint during mousedown handling; jsdom lacks it
    if (typeof document.elementFromPoint !== "function") {
      (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
    }
    if (typeof (document as unknown as { caretRangeFromPosition?: unknown }).caretRangeFromPosition !== "function") {
      (document as unknown as { caretRangeFromPosition: () => Range | null }).caretRangeFromPosition = () => null;
    }
    // jsdom getClientRects on Range may be missing; also ensure Element.prototype
    if (typeof Element !== "undefined" && typeof Element.prototype.getClientRects !== "function") {
      Element.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
    }
    if (typeof Element !== "undefined" && typeof Element.prototype.getBoundingClientRect !== "function") {
      Element.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {}; } } as unknown as DOMRect;
      };
    }
  }
}
