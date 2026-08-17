import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("offers all five themes and dispatches a live preview for each", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "check_service_health") return { status: "ok" };
      if (command === "list_templates") return [{ name: "general", description: "" }];
      if (command === "list_whisper_models") return [];
      if (command === "plugin:app|version") return "0.3.41";
      return null;
    });
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(await screen.findByRole("button", { name: "General settings" }));
    const appearance = screen.getByLabelText("Appearance") as HTMLSelectElement;
    expect(Array.from(appearance.options, (option) => option.text)).toEqual([
      "Dark",
      "Light",
      "Cream",
      "Navy",
      "Laghari Labs",
      "System",
    ]);

    const previews: string[] = [];
    const capturePreview = (event: Event) => {
      previews.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener("adversaria-theme-preview", capturePreview);
    try {
      for (const theme of ["light", "cream", "navy", "laghari", "dark"]) {
        await user.selectOptions(appearance, theme);
        expect(appearance.value).toBe(theme);
      }
    } finally {
      window.removeEventListener("adversaria-theme-preview", capturePreview);
    }

    expect(previews).toEqual(["light", "cream", "navy", "laghari", "dark"]);
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

describe("Setup status ledger — unknown is not a problem", () => {
  const ipc = (health: unknown) =>
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "list_templates") return [{ name: "general", description: "" }];
      if (command === "list_whisper_models") {
        return [{ key: "large-v3", label: "Large v3", size: "3 GB", downloaded: true }];
      }
      if (command === "check_service_health") return health;
      if (command === "plugin:app|version") return "0.3.75";
      return null;
    });

  it("says Checking, not Needs attention, before the transcriber state is known", async () => {
    // Regression 2026-08-07: a user with large-v3 downloaded was told transcription
    // "needs attention" because an ABSENT transcriber_state fell into the same
    // branch as a real error. An unknown must never be reported as a fault.
    ipc({ status: "ok", ollama_available: true }); // no transcriber_state at all
    const { container } = render(<Settings initialTab="setup" />);

    await screen.findByRole("button", { name: "General settings" });
    await waitFor(() => {
      const card = container.querySelector(".settings-section-card.active-card");
      expect(card?.textContent).toContain("Checking");
    });
    const card = container.querySelector(".settings-section-card.active-card");
    // "Needs attention" is the section heading and always renders; what matters is
    // that the Transcribe STAGE does not claim a fault, and that nothing is raised.
    const stage = [...card!.querySelectorAll(".settings-stage")].find((n) =>
      n.textContent?.includes("Transcribe"),
    );
    expect(stage?.textContent).toContain("Checking");
    expect(stage?.getAttribute("data-tone")).toBe("unknown");
    expect(card?.textContent).toContain("Nothing is blocking your next meeting.");
    expect(card?.querySelectorAll(".settings-issue")).toHaveLength(0);
  });

  it("reports the service's own reason when the model genuinely will not load", async () => {
    ipc({
      status: "ok",
      ollama_available: true,
      transcriber_state: "error",
      transcriber_detail: "The transcription model on this machine could not be loaded.",
    });
    const { container } = render(<Settings initialTab="setup" />);

    await screen.findByRole("button", { name: "General settings" });
    await waitFor(() => {
      const card = container.querySelector(".settings-section-card.active-card");
      // The service's sentence, not our guess — and never "no model downloaded"
      // for a machine that has one.
      expect(card?.textContent).toContain("could not be loaded");
    });
    const card = container.querySelector(".settings-section-card.active-card");
    expect(card?.textContent).not.toContain("No model downloaded yet");
  });
});

describe("Setup status permissions", () => {
  const mockPermissions = (permission: "granted" | "denied" | "undetermined") =>
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "list_templates") return [{ name: "general", description: "" }];
      if (command === "list_whisper_models") return [];
      if (command === "check_service_health") return { status: "ok" };
      if (command === "check_capture_permissions") {
        return { microphone: permission, system_audio: permission };
      }
      if (command === "plugin:app|version") return "0.3.79";
      return null;
    });

  it.each([
    ["granted", "Granted"],
    ["denied", "Not granted"],
    ["undetermined", "Not checked yet"],
  ] as const)("renders the %s permission chip state", async (permission, label) => {
    mockPermissions(permission);
    render(<Settings initialTab="setup" />);

    const card = await screen.findByLabelText("Capture permissions");
    await waitFor(() => {
      expect(within(card).getByLabelText(`Microphone permission: ${label}`)).toBeInTheDocument();
      expect(within(card).getByLabelText(`System audio permission: ${label}`)).toBeInTheDocument();
    });
  });

  it("runs the system-audio probe and renders the returned state", async () => {
    let probes = 0;
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "list_templates") return [{ name: "general", description: "" }];
      if (command === "list_whisper_models") return [];
      if (command === "check_service_health") return { status: "ok" };
      if (command === "check_capture_permissions") {
        return { microphone: "granted", system_audio: "undetermined" };
      }
      if (command === "probe_system_audio") {
        probes += 1;
        return { microphone: "granted", system_audio: "granted" };
      }
      if (command === "plugin:app|version") return "0.3.79";
      return null;
    });

    const user = userEvent.setup();
    render(<Settings initialTab="setup" />);
    const card = await screen.findByLabelText("Capture permissions");
    await user.click(within(card).getByRole("button", { name: "Check" }));

    await waitFor(() => expect(probes).toBe(1));
    expect(within(card).getByLabelText("System audio permission: Granted")).toBeInTheDocument();
  });
});
