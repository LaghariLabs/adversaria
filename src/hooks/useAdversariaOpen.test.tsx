import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
let listenHandler: ((event: { payload: { paths: string[] } }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class Channel<T> {
    onmessage: ((msg: T) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: unknown) => void) => {
    listenMock(event, handler);
    if (event === "open-adversaria-file") listenHandler = handler as never;
    return Promise.resolve(() => {});
  },
}));

import { formatImportToast, useAdversariaOpen } from "./useAdversariaOpen";

describe("formatImportToast", () => {
  it("formats imported with folders_created and skipped_existing", () => {
    const msg = formatImportToast({
      format: "adversaria-1",
      imported: 2,
      skipped_existing: 1,
      folders_created: 1,
      meeting_ids: [1, 2],
      folder_id: 5,
      path: "/tmp/a.adversaria",
    });
    expect(msg).toBe("Imported 2 meeting(s) into a new folder · 1 already here");
  });

  it("formats without folder", () => {
    const msg = formatImportToast({
      format: "adversaria-1",
      imported: 1,
      skipped_existing: 0,
      folders_created: 0,
      meeting_ids: [3],
      folder_id: null,
      path: "/tmp/b.adversaria",
    });
    expect(msg).toBe("Imported 1 meeting(s)");
  });
});

describe("useAdversariaOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenHandler = null;
    invokeMock.mockReset();
    // take_pending_open_files returns empty by default
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "take_pending_open_files") return Promise.resolve([]);
      return Promise.resolve(null);
    });
  });

  it("on open-adversaria-file event triggers import_adversaria with the path", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const refreshFolders = vi.fn().mockResolvedValue(undefined);
    const selectMeeting = vi.fn();
    const setNotice = vi.fn();

    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "take_pending_open_files") return Promise.resolve([]);
      if (cmd === "import_adversaria") {
        const p = args as { path: string | null };
        expect(p.path).toBe("/tmp/test.adversaria");
        return Promise.resolve({
          format: "adversaria-1",
          imported: 1,
          skipped_existing: 0,
          folders_created: 0,
          meeting_ids: [99],
          folder_id: null,
          path: "/tmp/test.adversaria",
        });
      }
      return Promise.resolve(null);
    });

    renderHook(() =>
      useAdversariaOpen({ refresh, refreshFolders, selectMeeting, setNotice }),
    );

    // wait for listen registration
    await waitFor(() => expect(listenMock).toHaveBeenCalledWith("open-adversaria-file", expect.any(Function)));
    expect(listenHandler).not.toBeNull();

    await act(async () => {
      await listenHandler!({ payload: { paths: ["/tmp/test.adversaria"] } });
    });

    expect(invokeMock).toHaveBeenCalledWith("import_adversaria", { path: "/tmp/test.adversaria" });
    expect(setNotice).toHaveBeenCalledWith("Imported 1 meeting(s)");
    expect(selectMeeting).toHaveBeenCalledWith(99);
  });

  it("takePendingOpenFiles sequentially imports each path", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const refreshFolders = vi.fn().mockResolvedValue(undefined);
    const selectMeeting = vi.fn();
    const setNotice = vi.fn();
    const paths = ["/tmp/a.adversaria", "/tmp/b.adversaria"];
    const calls: string[] = [];
    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "take_pending_open_files") return Promise.resolve(paths);
      if (cmd === "import_adversaria") {
        const p = args as { path: string | null };
        calls.push(p.path as string);
        return Promise.resolve({
          format: "adversaria-1",
          imported: 1,
          skipped_existing: 0,
          folders_created: 0,
          meeting_ids: [1],
          folder_id: null,
          path: p.path as string,
        });
      }
      return Promise.resolve(null);
    });

    renderHook(() =>
      useAdversariaOpen({ refresh, refreshFolders, selectMeeting, setNotice }),
    );

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls).toEqual(paths);
  });
});
