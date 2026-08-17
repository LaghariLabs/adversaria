import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { appConfig, pendingMeeting } from "../test/fixtures";
import { NoteViewer } from "./NoteViewer";

function selectTranscriptText(container: HTMLElement, text: string) {
  const textNode = container.querySelector(".transcript-line")?.lastChild;
  if (!textNode) throw new Error("Transcript text node not found");
  const range = {
    commonAncestorContainer: textNode,
    getBoundingClientRect: () => ({
      x: 120,
      y: 80,
      left: 120,
      top: 80,
      right: 160,
      bottom: 100,
      width: 40,
      height: 20,
      toJSON: () => ({}),
    }),
  } as unknown as Range;
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
  } as unknown as Selection;
  const getSelection = vi.spyOn(window, "getSelection").mockReturnValue(selection);
  fireEvent.mouseUp(container);
  getSelection.mockRestore();
}

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

describe("NoteViewer transcript tab", () => {
  const correctionMeeting = pendingMeeting({
    id: 42,
    transcript: "Them: We should ask cloud about it.",
    summary: "Meeting notes",
    audio_file_path: null,
    tags: [],
    transcript_turns: [
      {
        speaker: "Them",
        text: "We should ask cloud about it.",
        start: 0,
        end: 3,
      },
    ],
  });

  it("copies labeled turns as clean plain text", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      return null;
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const meeting = pendingMeeting({
      transcript: "Them: Hello\nHamza: Hi",
      summary: "Notes",
      audio_file_path: null,
      tags: [],
      transcript_turns: [
        { speaker: "Them", text: "Hello", start: 0, end: 2 },
        { speaker: "Hamza", text: "Hi", start: 5, end: 6 },
      ],
    });

    render(<NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Transcript" }));
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith(
      "[00:00] Them: Hello\n[00:05] Hamza: Hi",
    );
    expect(screen.getByRole("button", { name: "Copied!" })).toBeVisible();
  });

  it("copies the flat transcript when structured turns are empty", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      return null;
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const meeting = pendingMeeting({
      transcript: "line one\nline two",
      summary: "Notes",
      audio_file_path: null,
      tags: [],
      transcript_turns: [],
    });

    render(<NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Transcript" }));
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("line one\nline two");
  });

  it("renders a long stored turn as multiple paragraphs", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      return null;
    });
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn() },
      configurable: true,
    });
    const longText = ["A", "B", "C"]
      .map((letter) => `${letter.repeat(300)}.`)
      .join(" ");
    const meeting = pendingMeeting({
      transcript: `Them: ${longText}`,
      summary: "Notes",
      audio_file_path: null,
      tags: [],
      transcript_turns: [
        { speaker: "Them", text: longText, start: 0, end: 10 },
      ],
    });

    const { container } = render(
      <NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Transcript" }));

    expect(container.querySelectorAll(".transcript-line").length).toBeGreaterThan(1);
  });

  it("does not render a speaker span for an empty speaker label", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      return null;
    });
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn() },
      configurable: true,
    });
    const meeting = pendingMeeting({
      transcript: "Unlabeled words",
      summary: "Notes",
      audio_file_path: null,
      tags: [],
      transcript_turns: [
        { speaker: "", text: "Unlabeled words", start: 0, end: 2 },
      ],
    });

    const { container } = render(
      <NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Transcript" }));

    expect(container.querySelector(".transcript-speaker")).toBeNull();
  });

  it("fixes a selected transcript word everywhere and returns the refreshed meeting", async () => {
    const updated = {
      ...correctionMeeting,
      transcript: "Them: We should ask Claude about it.",
      transcript_turns: [
        {
          speaker: "Them",
          text: "We should ask Claude about it.",
          start: 0,
          end: 3,
        },
      ],
    };
    const renamePayloads: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "update_config") return null;
      if (command === "rename_meeting_person") {
        renamePayloads.push(payload);
        return updated;
      }
      return null;
    });
    const onMeetingUpdated = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <NoteViewer
        meeting={correctionMeeting}
        onMeetingUpdated={onMeetingUpdated}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Transcript" }));
    const transcript = container.querySelector("#transcript-container");
    if (!(transcript instanceof HTMLElement)) {
      throw new Error("Transcript not found");
    }
    selectTranscriptText(transcript, "cloud");

    await user.click(screen.getByRole("button", { name: "Fix this word" }));
    const input = screen.getByRole("textbox", {
      name: "Corrected transcript text",
    });
    await user.clear(input);
    await user.type(input, "Claude{Enter}");

    await waitFor(() =>
      expect(renamePayloads).toContainEqual({
        meetingId: 42,
        fromName: "cloud",
        toName: "Claude",
      }),
    );
    expect(onMeetingUpdated).toHaveBeenCalledWith(updated);
  });

  it("adds a corrected transcript word to the transcription dictionary", async () => {
    const config = appConfig({ custom_vocabulary: "" });
    let savedVocabulary = "";
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return config;
      if (command === "rename_meeting_person") return correctionMeeting;
      if (command === "update_config") {
        const args = payload as { config?: { custom_vocabulary?: string } };
        savedVocabulary = args.config?.custom_vocabulary ?? "";
        return null;
      }
      return null;
    });
    const user = userEvent.setup();
    const { container } = render(
      <NoteViewer meeting={correctionMeeting} onMeetingUpdated={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Transcript" }));
    const transcript = container.querySelector("#transcript-container");
    if (!(transcript instanceof HTMLElement)) {
      throw new Error("Transcript not found");
    }
    selectTranscriptText(transcript, "cloud");
    await user.click(screen.getByRole("button", { name: "Fix this word" }));
    const input = screen.getByRole("textbox", {
      name: "Corrected transcript text",
    });
    await user.clear(input);
    await user.type(input, "Claude{Enter}");

    await waitFor(() =>
      expect(savedVocabulary.split(/[,\n]/).map((term) => term.trim())).toContain(
        "Claude",
      ),
    );
  });

  it("dismisses transcript correction on Escape without an IPC call", async () => {
    const renameCalls = vi.fn();
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "rename_meeting_person") renameCalls(payload);
      return null;
    });
    const user = userEvent.setup();
    const { container } = render(
      <NoteViewer meeting={correctionMeeting} onMeetingUpdated={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Transcript" }));
    const transcript = container.querySelector("#transcript-container");
    if (!(transcript instanceof HTMLElement)) {
      throw new Error("Transcript not found");
    }
    selectTranscriptText(transcript, "cloud");
    await user.click(screen.getByRole("button", { name: "Fix this word" }));
    await user.keyboard("{Escape}");

    expect(renameCalls).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "Corrected transcript text" }),
    ).not.toBeInTheDocument();
  });
});

describe("NoteViewer attendee rename", () => {
  const meeting = pendingMeeting({
    id: 42,
    attendees: ["dhanesh"],
    transcript: "dhanesh: I will send the notes.",
    transcript_turns: [
      {
        speaker: "dhanesh",
        text: "I will send the notes.",
        start: 0,
        end: 2,
      },
    ],
    summary: "Meeting notes",
    audio_file_path: null,
    tags: [],
  });

  it("renames from the attendee chip and returns the refreshed meeting", async () => {
    const updated = {
      ...meeting,
      attendees: ["Danish"],
      transcript: "Danish: I will send the notes.",
    };
    const renamePayloads: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "update_config") return null;
      if (command === "rename_meeting_person") {
        renamePayloads.push(payload);
        return updated;
      }
      return null;
    });
    const onMeetingUpdated = vi.fn();
    const user = userEvent.setup();

    render(
      <NoteViewer meeting={meeting} onMeetingUpdated={onMeetingUpdated} />,
    );

    await user.click(screen.getByRole("button", { name: "Rename dhanesh" }));
    const input = screen.getByRole("textbox", { name: "Rename dhanesh" });
    await user.clear(input);
    await user.type(input, "Danish{Enter}");

    await waitFor(() =>
      expect(renamePayloads).toContainEqual({
        meetingId: 42,
        fromName: "dhanesh",
        toName: "Danish",
      }),
    );
    expect(onMeetingUpdated).toHaveBeenCalledWith(updated);
  });

  it("adds the corrected name to the transcription dictionary", async () => {
    const config = appConfig({ custom_vocabulary: "" });
    let savedVocabulary = "";
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return config;
      if (command === "rename_meeting_person") {
        return { ...meeting, attendees: ["Danish"] };
      }
      if (command === "update_config") {
        const args = payload as { config?: { custom_vocabulary?: string } };
        savedVocabulary = args.config?.custom_vocabulary ?? "";
        return null;
      }
      return null;
    });
    const user = userEvent.setup();

    render(<NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rename dhanesh" }));
    const input = screen.getByRole("textbox", { name: "Rename dhanesh" });
    await user.clear(input);
    await user.type(input, "Danish{Enter}");

    await waitFor(() =>
      expect(savedVocabulary.split(/[,\n]/).map((term) => term.trim())).toContain(
        "Danish",
      ),
    );
  });

  it("cancels the attendee rename on Escape", async () => {
    const renameCalls = vi.fn();
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "rename_meeting_person") renameCalls(payload);
      return null;
    });
    const user = userEvent.setup();

    render(<NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rename dhanesh" }));
    const input = screen.getByRole("textbox", { name: "Rename dhanesh" });
    await user.clear(input);
    await user.type(input, "Danish{Escape}");

    expect(renameCalls).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rename dhanesh" })).toHaveTextContent(
      "dhanesh",
    );
  });
});
