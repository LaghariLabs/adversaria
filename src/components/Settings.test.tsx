import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { appConfig } from "../test/fixtures";
import { Settings } from "./Settings";

/** The eight-section readiness-ledger IA (docs/SETTINGS_REDESIGN.md).
 *  Order is the order the work happens in, then the app around it. Each label
 *  MUST equal its section's first `.settings-card-title` — the last test here
 *  is what enforces that coupling. */
const TAB_LABELS = [
  "Setup status",
  "Recording",
  "Notifications",
  "Transcription",
  "Notes",
  "Integrations",
  "Privacy & data",
  "General",
];

describe("Settings", () => {
  it("loads configuration and persists the name typed in General", async () => {
    const initial = appConfig();
    const saved = vi.fn();
    mockIPC((command, payload) => {
      if (command === "get_config") return initial;
      if (command === "check_service_health") return { status: "ok" };
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

    await user.click(await screen.findByRole("button", { name: "General settings" }));
    const name = screen.getByLabelText("Your Name");
    await user.type(name, "Hamza");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ user_name: "Hamza" }),
    );
  });

  it("offers exactly the eight redesigned sections, Setup status first", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "list_templates") return [{ name: "general", description: "" }];
      if (command === "list_whisper_models") return [];
      if (command === "plugin:app|version") return "0.3.41";
      return null;
    });
    const { container } = render(<Settings />);

    await screen.findByRole("button", { name: "General settings" });
    const menu = container.querySelectorAll(".settings-menu-item");
    expect(Array.from(menu, (b) => b.textContent)).toEqual(TAB_LABELS);
  });

  it.each([
    ["model", "Transcription"],
    ["templates", "Notes"],
    ["nonsense-id", "Setup status"],
    [undefined, "Setup status"],
  ])(
    "resolves initialTab %s to the %s section instead of a blank pane",
    async (initialTab, expected) => {
      mockIPC((command) => {
        if (command === "get_config") return appConfig();
        if (command === "list_templates") return [{ name: "general", description: "" }];
        if (command === "list_whisper_models") return [];
        if (command === "plugin:app|version") return "0.3.41";
        return null;
      });
      const { container } = render(<Settings initialTab={initialTab} />);

      await screen.findByRole("button", { name: "General settings" });
      // Regression: `.settings-section-card` is display:none without
      // `.active-card`, so an unresolved id showed the sidebar and the Save
      // button over nothing at all — silently, and this is the first thing a new
      // user hits via the wizard and the tour's final step.
      const active = container.querySelectorAll(".settings-section-card.active-card");
      expect(active).toHaveLength(1);
      expect(active[0].querySelector(".settings-card-title")?.textContent).toBe(expected);
    },
  );

  it("keeps every section's card mounted and highlights only the active one", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "list_templates") return [{ name: "general", description: "" }];
      if (command === "list_whisper_models") return [];
      if (command === "plugin:app|version") return "0.3.41";
      return null;
    });
    const user = userEvent.setup();
    const { container } = render(<Settings />);

    await screen.findByRole("button", { name: "General settings" });
    expect(container.querySelectorAll(".settings-section-card")).toHaveLength(
      TAB_LABELS.length,
    );

    for (const label of TAB_LABELS) {
      await user.click(screen.getByRole("button", { name: `${label} settings` }));
      const active = container.querySelectorAll(".settings-section-card.active-card");
      expect(active).toHaveLength(1);
      expect(active[0].querySelector(".settings-card-title")?.textContent).toBe(
        label,
      );
    }
  });
});
