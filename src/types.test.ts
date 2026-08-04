import { describe, expect, it } from "vitest";

import { classifyTranscriptionProvider } from "./types";

/**
 * The table below is the same one `src-tauri/src/config.rs` asserts against
 * (`mod tests`, 2026-08-03). Both sides must agree: Rust decides what a legacy
 * config migrates to, this copy decides whether the UI is allowed to say "your
 * own server — audio stays on your network".
 */
const expectAll = (urls: string[], expected: string) => {
  for (const url of urls) expect(classifyTranscriptionProvider(url), url).toBe(expected);
};

describe("classifyTranscriptionProvider", () => {
  it("treats no endpoint as on-device", () => {
    expectAll(["", "   ", "\n\t"], "local");
  });

  it("treats loopback as self-hosted", () => {
    expectAll(
      [
        "127.0.0.1",
        "http://127.0.0.1:8000/v1",
        "https://127.0.0.1/v1",
        "http://127.1.2.3:9000",
        "localhost",
        "http://localhost:8000/v1",
        "::1",
        "http://[::1]:8000/v1",
      ],
      "self_hosted",
    );
  });

  it("treats the RFC 1918 ranges as self-hosted", () => {
    expectAll(
      [
        "http://10.0.0.5:8000/v1",
        "http://192.168.1.40/v1",
        "http://172.16.0.1:8000/v1",
        "http://172.31.255.254:8000/v1",
      ],
      "self_hosted",
    );
  });

  it("treats addresses outside those ranges as cloud", () => {
    expectAll(
      ["http://172.15.0.1:8000/v1", "http://172.32.0.1:8000/v1", "http://8.8.8.8:8000/v1"],
      "cloud",
    );
  });

  it("treats LAN hostnames as self-hosted", () => {
    expectAll(
      [
        "http://dgx.office.local:8000/v1",
        "https://whisper.corp.internal/v1",
        "dgx:8000",
        "http://dgx/v1",
        "http://key@dgx.office.local:8000/v1",
      ],
      "self_hosted",
    );
  });

  it("treats public providers as cloud", () => {
    expectAll(
      [
        "https://api.groq.com/openai/v1",
        "https://api.openai.com/v1",
        "https://api.groq.com:443/openai/v1",
      ],
      "cloud",
    );
  });

  /** A URL we can't read must land on the mode whose copy warns that audio
   *  leaves the device — never on the one that promises it doesn't. */
  it("falls back to cloud for a malformed URL", () => {
    expectAll(
      [
        "http://",
        "://",
        "http:///v1",
        "http://[::1",
        "not a url",
        "http:// spaced.host/v1",
        "@",
      ],
      "cloud",
    );
  });
});
