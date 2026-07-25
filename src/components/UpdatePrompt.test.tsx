import type { Update } from "@tauri-apps/plugin-updater";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UpdatePrompt } from "./UpdatePrompt";

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
});
