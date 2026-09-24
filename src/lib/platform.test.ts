import { describe, expect, it } from "vitest";

import { detectPlatform, platformCopy } from "./platform";

describe("detectPlatform", () => {
  it("recognizes the WebView2 user agent as Windows", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
      ),
    ).toBe("windows");
  });

  it("recognizes the WKWebView user agent as macOS", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      ),
    ).toBe("macos");
  });

  it("falls back to other for anything else", () => {
    expect(detectPlatform("Mozilla/5.0 (linux) AppleWebKit/537.36 jsdom/29")).toBe("other");
    expect(detectPlatform("")).toBe("other");
  });
});

describe("platformCopy", () => {
  it("never shows Mac-only names to Windows users", () => {
    const copy = platformCopy("windows");
    const all = Object.values(copy).join(" ");
    expect(all).not.toMatch(/⌘|Mac|Finder|Keychain|Touch ID|System Settings/);
    expect(copy.recordShortcut).toBe("Ctrl+Shift+M");
    expect(copy.systemSettings).toBe("Windows Settings");
  });

  it("keeps the macOS wording on a Mac", () => {
    const copy = platformCopy("macos");
    expect(copy.recordShortcut).toBe("⌘⇧M");
    expect(copy.fileManager).toBe("Finder");
    expect(copy.device).toBe("Mac");
  });
});
