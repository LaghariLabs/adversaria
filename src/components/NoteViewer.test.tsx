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

  it("re-reads the meeting when transcription fails AFTER saving the transcript", async () => {
    // The backend persists the transcript and deletes the audio before
    // summarizing, so a rejection can leave the meeting no longer pending.
    // Keeping the stale row would leave "Transcribe now" pointing at audio
    // that is already gone.
    const afterTranscript = pendingMeeting({
      transcript: "Me: it did save",
      summary: "",
      audio_file_path: null,
      tags: [],
    });
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "engine_configured") return false;
      if (command === "get_meeting") return afterTranscript;
      if (command === "transcribe_meeting") {
        throw new Error("The notes model isn't set up yet, so notes were skipped.");
      }
      return null;
    });
    const onMeetingUpdated = vi.fn();
    const user = userEvent.setup();

    render(
      <NoteViewer meeting={pendingMeeting()} onMeetingUpdated={onMeetingUpdated} />,
    );

    await user.click(screen.getByRole("button", { name: "Transcribe now" }));
    await waitFor(() => expect(onMeetingUpdated).toHaveBeenCalledWith(afterTranscript));
    // …and the reason survives the panel it was raised in.
    expect(screen.getByRole("alert")).toHaveTextContent(/notes were skipped/);
  });

  it("explains that it is waiting for the transcription model, not for the user", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      return null;
    });

    render(
      <NoteViewer
        meeting={pendingMeeting()}
        onMeetingUpdated={vi.fn()}
        transcriptionSetup={{
          state: "downloading",
          percent: 62,
          detail: "",
          serviceOnline: true,
          refresh: vi.fn(),
          retry: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText("Waiting for the transcription model")).toBeVisible();
    expect(screen.getByText(/transcribe automatically once/)).toBeVisible();
    expect(screen.getByText(/62%/)).toBeVisible();
    // The manual escape hatch stays.
    expect(screen.getByRole("button", { name: "Transcribe now" })).toBeVisible();
  });
});

describe("NoteViewer notes-engine guidance", () => {
  const transcribed = pendingMeeting({
    transcript: "Me: hello",
    summary: "",
    audio_file_path: null,
  });

  it("routes to the model settings instead of offering a button that only fails", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "engine_configured") return false;
      return null;
    });
    const onOpenModelSettings = vi.fn();
    const user = userEvent.setup();

    render(
      <NoteViewer
        meeting={transcribed}
        onMeetingUpdated={vi.fn()}
        onOpenModelSettings={onOpenModelSettings}
      />,
    );

    const cta = await screen.findByRole("button", { name: "Choose a notes model" });
    expect(
      screen.queryByRole("button", { name: "Generate notes" }),
    ).not.toBeInTheDocument();
    await user.click(cta);
    expect(onOpenModelSettings).toHaveBeenCalled();
  });

  it("never claims an engine is configured before the probe answers", () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      // engine_configured never resolves to a boolean here — the probe is
      // still unknown, which used to render "Your engine is configured".
      return null;
    });

    render(<NoteViewer meeting={transcribed} onMeetingUpdated={vi.fn()} />);

    expect(screen.queryByText(/engine is configured/)).not.toBeInTheDocument();
    expect(screen.getByText(/Checking which model will write them/)).toBeVisible();
  });
});
