import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { appConfig } from "../test/fixtures";
import { GuidedTour } from "./GuidedTour";

const onboarding = (setup_complete: boolean) => ({
  schema_version: 1,
  completed_steps: setup_complete ? ["registration", "permissions", "ready"] : [],
  selected_model_profile: "",
  setup_complete,
  updated_at: "2026-07-28T10:00:00Z",
});

describe("GuidedTour", () => {
  it("shows after setup completes and skipping persists tour_completed", async () => {
    let savedTourDone: boolean | null = null;
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding(true);
      if (command === "get_config") return appConfig({ tour_completed: false });
      if (command === "update_config") {
        const args = payload as { config?: { tour_completed?: boolean } };
        savedTourDone = args.config?.tour_completed ?? null;
        return null;
      }
      return null;
    });

    const user = userEvent.setup();
    render(<GuidedTour onNavigate={() => {}} />);
    expect(await screen.findByText("Record")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(savedTourDone).toBe(true));
    expect(screen.queryByText("Record")).not.toBeInTheDocument();
  });

  it("walks all steps and the last one navigates to Settings › AI Model", async () => {
    const navigations: Array<[string, string | undefined]> = [];
    mockIPC((command) => {
      if (command === "get_onboarding_state") return onboarding(true);
      if (command === "get_config") return appConfig({ tour_completed: false });
      if (command === "update_config") return null;
      return null;
    });

    const user = userEvent.setup();
    render(<GuidedTour onNavigate={(view, tab) => navigations.push([view, tab])} />);
    expect(await screen.findByText("Record")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("One last thing — how your notes get written")).toBeInTheDocument();
    expect(navigations).toContainEqual(["settings", "model"]);
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByText("One last thing — how your notes get written")).not.toBeInTheDocument(),
    );
  });

  it("never shows once tour_completed is set", async () => {
    mockIPC((command) => {
      if (command === "get_onboarding_state") return onboarding(true);
      if (command === "get_config") return appConfig({ tour_completed: true });
      return null;
    });
    const { container } = render(<GuidedTour onNavigate={vi.fn()} />);
    // Give the eligibility probe a beat, then confirm nothing rendered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it("never shows during the wizard", async () => {
    mockIPC((command) => {
      if (command === "get_onboarding_state") return onboarding(false);
      if (command === "get_config") return appConfig({ tour_completed: false });
      return null;
    });
    const { container } = render(<GuidedTour onNavigate={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
