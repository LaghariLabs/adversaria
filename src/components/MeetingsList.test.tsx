import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TranscriptionSetup } from "../hooks/useTranscriptionSetup";
import { pendingMeeting } from "../test/fixtures";
import { MeetingsList } from "./MeetingsList";

const setup = (
  state: TranscriptionSetup["state"],
  percent: number | null = null,
): TranscriptionSetup => ({
  state,
  percent,
  detail: "",
  serviceOnline: true,
  refresh: vi.fn(),
  retry: vi.fn(),
});

function renderList(
  meetings: Parameters<typeof MeetingsList>[0]["meetings"],
  transcriptionSetup?: TranscriptionSetup,
) {
  mockIPC(() => null);
  return render(
    <MeetingsList
      meetings={meetings}
      onSelect={vi.fn()}
      transcriptionSetup={transcriptionSetup}
    />,
  );
}

describe("MeetingsList transcription badge", () => {
  it("says a recording is waiting for the model, keyed off the data not the tag", () => {
    // The transcript write clears the "Needs transcription" tag and rewrites
    // the title, so the tag cannot carry this state — `transcript === "" &&
    // audio_file_path != null` is what actually means "not transcribed".
    renderList([pendingMeeting({ tags: [] })], setup("missing"));
    expect(screen.getByText("Waiting for the model")).toBeVisible();
  });

  it("counts the model down while it downloads", () => {
    renderList([pendingMeeting({ tags: [] })], setup("downloading", 43));
    expect(screen.getByText("Waiting for the model — 43%")).toBeVisible();
  });

  it("says nothing once transcription is ready", () => {
    renderList([pendingMeeting({ tags: [] })], setup("ready"));
    expect(screen.queryByText(/Waiting for the model/)).not.toBeInTheDocument();
  });

  it("never marks a transcribed meeting as waiting, even with a stale tag", () => {
    const transcribed = pendingMeeting({
      transcript: "Me: done",
      audio_file_path: null,
      tags: [{ label: "Needs transcription", color: "orange" }],
    });
    renderList([transcribed], setup("missing"));
    expect(screen.queryByText(/Waiting for the model/)).not.toBeInTheDocument();
  });
});
