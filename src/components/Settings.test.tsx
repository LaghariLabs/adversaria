import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { appConfig } from "../test/fixtures";
import { Settings } from "./Settings";

describe("Settings", () => {
  it("loads configuration and persists an edited transcription identity", async () => {
    const initial = appConfig();
    const saved = vi.fn();
    mockIPC((command, payload) => {
      if (command === "get_config") return initial;
      if (command === "health") return { status: "ok" };
      if (command === "list_templates") {
        return [{ name: "general", description: "General notes" }];
      }
      if (command === "list_whisper_models") return [];
      if (command === "update_config") {
        const args = payload as Record<string, unknown> | undefined;
        saved(args?.config);
        return null;
      }
      if (command === "plugin:app|version") return "0.3.41";
      return null;
    });
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(
      await screen.findByRole("button", { name: "Transcription settings" }),
    );
    const name = screen.getByLabelText("Your Name");
    await user.type(name, "Hamza");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ user_name: "Hamza" }),
    );
  });
});
