import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { pendingMeeting } from "../test/fixtures";
import { NoteViewer } from "./NoteViewer";

describe("NoteViewer pending meeting recovery", () => {
  it("keeps a failed recording visible and lets the user retry transcription", async () => {
    const updated = pendingMeeting({
      transcript: "Speaker 1: recovered",
      summary: "Recovered notes",
      audio_file_path: null,
    });
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "transcribe_meeting") return updated;
      return null;
    });
    const onMeetingUpdated = vi.fn();
    const user = userEvent.setup();

    render(
      <NoteViewer
        meeting={pendingMeeting()}
        onMeetingUpdated={onMeetingUpdated}
      />,
    );

    expect(screen.getByText("Not transcribed yet")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Transcribe now" }));
    await waitFor(() => expect(onMeetingUpdated).toHaveBeenCalledWith(updated));
  });

  it("prevents a duplicate retry while the meeting is already queued", () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      return null;
    });

    render(
      <NoteViewer
        meeting={pendingMeeting()}
        onMeetingUpdated={vi.fn()}
        isQueued
      />,
    );

    expect(screen.getByText("Queued for transcription")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Transcribe now" }),
    ).not.toBeInTheDocument();
  });
});
