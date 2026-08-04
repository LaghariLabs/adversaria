import type { Update } from "@tauri-apps/plugin-updater";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RECHECK_MS, UpdatePrompt } from "./UpdatePrompt";

function fakeUpdate(
  downloadAndInstall: Update["downloadAndInstall"] = vi.fn(),
): Update {
  return {
    version: "0.4.0",
    currentVersion: "0.3.41",
    body: "Reliability improvements",
    date: "2026-07-14",
    rawJson: {},
    download: vi.fn(),
    install: vi.fn(),
    downloadAndInstall,
    close: vi.fn(),
  } as unknown as Update;
}

describe("UpdatePrompt", () => {
  it("shows an available update and can defer it", async () => {
    const user = userEvent.setup();
    render(
      <UpdatePrompt
        enabled
        checkForUpdate={vi.fn().mockResolvedValue(fakeUpdate())}
      />,
    );

    expect(await screen.findByText("Update available — v0.4.0")).toBeVisible();
    expect(screen.getByText("Reliability improvements")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText("Update available — v0.4.0")).not.toBeInTheDocument();
  });

  it("downloads, installs, and relaunches", async () => {
    const relaunchApp = vi.fn().mockResolvedValue(undefined);
    const downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 10 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 10 } });
      onEvent?.({ event: "Finished", data: {} });
    }) as Update["downloadAndInstall"];
    const user = userEvent.setup();
    render(
      <UpdatePrompt
        enabled
        checkForUpdate={vi.fn().mockResolvedValue(fakeUpdate(downloadAndInstall))}
        relaunchApp={relaunchApp}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Install & Restart" }),
    );
    await waitFor(() => expect(relaunchApp).toHaveBeenCalledOnce());
    expect(downloadAndInstall).toHaveBeenCalledOnce();
  });

  describe("periodic re-check", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-checks after 6 hours and shows the toast when a release appears", async () => {
      const checkForUpdate = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(fakeUpdate());
      render(<UpdatePrompt enabled checkForUpdate={checkForUpdate} />);

      // Flush the launch check — nothing released yet, no toast.
      await act(async () => {});
      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Update available — v0.4.0")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECHECK_MS);
      });
      expect(checkForUpdate).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Update available — v0.4.0")).toBeVisible();
    });

    it("keeps checking silently while there is nothing to install", async () => {
      const checkForUpdate = vi.fn().mockResolvedValue(null);
      const { container } = render(
        <UpdatePrompt enabled checkForUpdate={checkForUpdate} />,
      );

      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECHECK_MS * 3);
      });
      expect(checkForUpdate).toHaveBeenCalledTimes(4);
      expect(container).toBeEmptyDOMElement();
    });

    it("stops re-checking once an update is found", async () => {
      const checkForUpdate = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(fakeUpdate());
      render(<UpdatePrompt enabled checkForUpdate={checkForUpdate} />);

      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECHECK_MS);
      });
      expect(screen.getByText("Update available — v0.4.0")).toBeVisible();

      // The toast is up — further ticks must not fire more checks.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECHECK_MS * 3);
      });
      expect(checkForUpdate).toHaveBeenCalledTimes(2);
    });

    it("clears the timer on unmount", async () => {
      const checkForUpdate = vi.fn().mockResolvedValue(null);
      const { unmount } = render(
        <UpdatePrompt enabled checkForUpdate={checkForUpdate} />,
      );

      await act(async () => {});
      expect(checkForUpdate).toHaveBeenCalledTimes(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECHECK_MS * 3);
      });
      expect(checkForUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
