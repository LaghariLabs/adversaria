import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PERMISSION_ERROR_PREFIX } from "../lib/tauri";
import { ErrorBanner } from "./ErrorBanner";

describe("ErrorBanner permission recovery", () => {
  it("shows system-audio actions and rechecks the permission", async () => {
    const commands: string[] = [];
    mockIPC((command) => {
      commands.push(command);
      if (command === "probe_system_audio") {
        return { microphone: "granted", system_audio: "granted" };
      }
      return null;
    });
    const dismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <ErrorBanner
        message={`${PERMISSION_ERROR_PREFIX}Adversaria can't hear your Mac's system audio yet.`}
        onDismiss={dismiss}
      />,
    );

    expect(screen.getByText("Adversaria can't hear your Mac's system audio yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledOnce());
    expect(commands).toContain("probe_system_audio");
  });
});
