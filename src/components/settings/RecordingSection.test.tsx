import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { appConfig } from "../../test/fixtures";
import { RecordingSection } from "./RecordingSection";

// The pill picker branches on the host OS, which is fixed at module load.
vi.mock("../../lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/platform")>();
  return { ...actual, IS_WINDOWS: true, IS_MAC: false };
});

describe("RecordingSection on Windows", () => {
  it("offers the recording pill styles, including Hidden, instead of saying there is no pill", async () => {
    // Windows does show a floating pill (commands.rs::show_recording_bubble),
    // and it is captured by screen sharing, so Hidden must be reachable.
    const update = vi.fn();
    render(
      <RecordingSection
        active
        config={appConfig({ notch_pill_style: "minimal" })}
        update={update}
        onOpenTranscription={() => undefined}
      />,
    );

    expect(screen.getByText("Recording pill")).toBeInTheDocument();
    expect(screen.queryByText(/no notch/i)).not.toBeInTheDocument();

    const hidden = screen.getByRole("radio", { name: /Hidden/ });
    await userEvent.setup().click(hidden);
    expect(update).toHaveBeenCalledWith({ notch_pill_style: "hidden" });
  });
});
