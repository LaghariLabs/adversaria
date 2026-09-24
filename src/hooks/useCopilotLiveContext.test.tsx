import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class Channel<T> {
    onmessage: ((msg: T) => void) | null = null;
  },
}));

import { useCopilotLiveContext } from "./useCopilotLiveContext";

describe("useCopilotLiveContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("calls copilot_set_live_context debounced with session_id + folder/notes/attachments while recording", async () => {
    const pending = [{ kind: "file", value: "/tmp/a.md", label: "a.md" }];
    const sess = "sess-123";
    const { rerender } = renderHook(
      ({ status, notes, folder, attachments, sessionId }) =>
        useCopilotLiveContext({
          status,
          copilotSessionId: sessionId,
          recordingFolderId: folder,
          userNotes: notes,
          pendingAttachments: attachments,
        }),
      {
        initialProps: { status: "recording", sessionId: sess, notes: "hello", folder: 3 as number | null, attachments: pending },
      },
    );

    // immediate on start fires sync + debounced timer, with sessionId
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("copilot_set_live_context", {
      sessionId: sess,
      context: { folder_id: 3, notes: "hello", attachments: pending },
    });

    // second call after debounce delay
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith("copilot_set_live_context", {
      sessionId: sess,
      context: { folder_id: 3, notes: "hello", attachments: pending },
    });

    // change notes -> debounced again with same sessionId
    invokeMock.mockClear();
    rerender({ status: "recording", sessionId: sess, notes: "hello world", folder: 3, attachments: pending });
    expect(invokeMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(invokeMock).toHaveBeenCalledWith("copilot_set_live_context", {
      sessionId: sess,
      context: { folder_id: 3, notes: "hello world", attachments: pending },
    });
  });

  it("does not call when not recording or no sessionId", async () => {
    renderHook(() =>
      useCopilotLiveContext({
        status: "recording",
        copilotSessionId: null,
        recordingFolderId: null,
        userNotes: "hi",
        pendingAttachments: [],
      }),
    );
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(invokeMock).not.toHaveBeenCalled();

    renderHook(() =>
      useCopilotLiveContext({
        status: "idle",
        copilotSessionId: "sess-x",
        recordingFolderId: null,
        userNotes: "hi",
        pendingAttachments: [],
      }),
    );
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("cancels delayed timer from session A; A's notes never send under session B", async () => {
    const sessA = "sess-A";
    const sessB = "sess-B";
    const { rerender } = renderHook(
      ({ sid, notes }) =>
        useCopilotLiveContext({
          status: "recording",
          copilotSessionId: sid,
          recordingFolderId: null,
          userNotes: notes,
          pendingAttachments: [],
        }),
      { initialProps: { sid: sessA, notes: "note A" } },
    );

    // immediate push for A
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("copilot_set_live_context", {
      sessionId: sessA,
      context: { folder_id: null, notes: "note A", attachments: [] },
    });

    // advance 500ms, then switch to B before debounce fires (debounce 1000ms)
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    invokeMock.mockClear();
    rerender({ sid: sessB, notes: "note B" });

    // B's immediate push fires, A's delayed is cancelled
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("copilot_set_live_context", {
      sessionId: sessB,
      context: { folder_id: null, notes: "note B", attachments: [] },
    });

    // advance 1000ms -> only B's debounce fires, not A's
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    // both calls are for B
    expect(invokeMock).toHaveBeenNthCalledWith(1, "copilot_set_live_context", {
      sessionId: sessB,
      context: { folder_id: null, notes: "note B", attachments: [] },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "copilot_set_live_context", {
      sessionId: sessB,
      context: { folder_id: null, notes: "note B", attachments: [] },
    });
    // ensure A never appeared in second phase
    const calls = invokeMock.mock.calls.map((c: any) => c[1].sessionId);
    expect(calls).not.toContain(sessA);
  });

  it("warns on invoke failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("ipc fail"));

    renderHook(() =>
      useCopilotLiveContext({
        status: "recording",
        copilotSessionId: "sess-x",
        recordingFolderId: null,
        userNotes: "x",
        pendingAttachments: [],
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
