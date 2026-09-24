import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// This jsdom setup exposes no window.localStorage, but the collapsible header
// persists through it — provide a minimal in-memory store for these tests.
const noteViewerMemoryStore = new Map<string, string>();
const noteViewerStorageStub = {
  getItem: (key: string) =>
    noteViewerMemoryStore.has(key) ? noteViewerMemoryStore.get(key)! : null,
  setItem: (key: string, value: string) => {
    noteViewerMemoryStore.set(key, String(value));
  },
  removeItem: (key: string) => {
    noteViewerMemoryStore.delete(key);
  },
  clear: () => {
    noteViewerMemoryStore.clear();
  },
  key: (index: number) => Array.from(noteViewerMemoryStore.keys())[index] ?? null,
  get length() {
    return noteViewerMemoryStore.size;
  },
};
Object.defineProperty(window, "localStorage", {
  value: noteViewerStorageStub,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: noteViewerStorageStub,
  configurable: true,
});

const { shellOpenMock } = vi.hoisted(() => ({ shellOpenMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpenMock }));

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    // @ts-ignore
    ...actual,
    getCopilotReceipt: vi.fn().mockResolvedValue({ questions: 0, passages: 0, claude_questions: 0, deepseek_questions: 0, local_questions: 0, web_requested: 0, web_performed: 0 }),
    getCopilotHistory: vi.fn().mockResolvedValue({ meeting_id: 1, cards: [] }),
  };
});

import { appConfig, pendingMeeting } from "../test/fixtures";
import type { RelatedMeetingRef } from "../types";
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
          liveCaptionsState: undefined,
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

    // The header is collapsed by default — expand to reach the attendee chips.
    const showDetails = screen.queryByRole("button", { name: "Show meeting details" });
    if (showDetails) await user.click(showDetails);
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

    // The header is collapsed by default — expand to reach the attendee chips.
    const showDetailsForDict = screen.queryByRole("button", { name: "Show meeting details" });
    if (showDetailsForDict) await user.click(showDetailsForDict);
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

    // The header is collapsed by default — expand to reach the attendee chips.
    const showDetailsForCancel = screen.queryByRole("button", { name: "Show meeting details" });
    if (showDetailsForCancel) await user.click(showDetailsForCancel);
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

describe("NoteViewer project context", () => {
  const meeting = pendingMeeting({ summary: "Meeting notes" });
  const suggestion = {
    workspace_id: 9,
    workspace_name: "Launch plan",
    related_meeting_count: 3,
    shared_attendee_count: 2,
  };

  it("renders the assigned project chip", () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      return null;
    });

    render(
      <NoteViewer
        meeting={meeting}
        onMeetingUpdated={vi.fn()}
        projectChip={{ name: "Launch plan", color: "purple" }}
      />,
    );

    // The header is collapsed by default — the chip lives in the details.
    const showChip = screen.queryByRole("button", { name: "Show meeting details" });
    if (showChip) fireEvent.click(showChip);
    expect(screen.getByText("Launch plan")).toBeVisible();
  });

  it("accepts the suggested project", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      return null;
    });
    const onAcceptSuggestion = vi.fn();
    const user = userEvent.setup();

    render(
      <NoteViewer
        meeting={meeting}
        onMeetingUpdated={vi.fn()}
        suggestion={suggestion}
        onAcceptSuggestion={onAcceptSuggestion}
      />,
    );

    // The header is collapsed by default — the suggestion lives in the details.
    const showSuggestion = screen.queryByRole("button", { name: "Show meeting details" });
    if (showSuggestion) await user.click(showSuggestion);
    expect(screen.getByText(/Looks like Launch plan:/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add to Launch plan" }));
    expect(onAcceptSuggestion).toHaveBeenCalledWith(9);
  });

  it("hides the suggestion banner when a project chip is set", () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      return null;
    });

    render(
      <NoteViewer
        meeting={meeting}
        onMeetingUpdated={vi.fn()}
        projectChip={{ name: "Launch plan", color: "purple" }}
        suggestion={suggestion}
      />,
    );

    expect(screen.queryByText(/Looks like Launch plan:/)).not.toBeInTheDocument();
  });
});

describe("NoteViewer related meetings", () => {
  const meetingWithSummary = pendingMeeting({
    id: 1,
    summary: "Discussion about project architecture and design.",
  });

  const sampleRelated: RelatedMeetingRef[] = [
    {
      meeting_id: 2,
      title: "Sprint Planning",
      recorded_at: "2026-08-01T10:00:00Z",
      reason: "Mentions the same things",
    },
    {
      meeting_id: 3,
      title: "Roadmap Sync",
      recorded_at: "2026-08-02T14:00:00Z",
      reason: "Similar content (82% match)",
    },
  ];

  it("renders the Related meetings card with titles + reasons when the mock resolves items", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "related_meetings") return sampleRelated;
      return null;
    });

    render(
      <NoteViewer
        meeting={meetingWithSummary}
        onMeetingUpdated={vi.fn()}
      />,
    );

    expect(await screen.findByText("Related meetings")).toBeVisible();
    expect(screen.getByText("Sprint Planning")).toBeVisible();
    expect(screen.getByText("Mentions the same things")).toBeVisible();
    expect(screen.getByText("Roadmap Sync")).toBeVisible();
    expect(screen.getByText("Similar content (82% match)")).toBeVisible();
  });

  it("clicking a row calls onOpenMeetingId with the id", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "related_meetings") return sampleRelated;
      return null;
    });
    const onOpenMeetingId = vi.fn();
    const user = userEvent.setup();

    render(
      <NoteViewer
        meeting={meetingWithSummary}
        onMeetingUpdated={vi.fn()}
        onOpenMeetingId={onOpenMeetingId}
      />,
    );

    const rowButton = await screen.findByRole("button", { name: /Sprint Planning/ });
    await user.click(rowButton);
    expect(onOpenMeetingId).toHaveBeenCalledWith(2);
  });

  it("does not render the card when the mock resolves []", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "related_meetings") return [];
      return null;
    });

    render(
      <NoteViewer
        meeting={meetingWithSummary}
        onMeetingUpdated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Related meetings")).not.toBeInTheDocument();
    });
  });
});

describe("NoteViewer context used", () => {
  it("shows typed notes and attachments as chips", async () => {
    const meeting = pendingMeeting({
      id: 99,
      user_notes: "one\ntwo",
      summary: "Notes summary",
      transcript: "hello",
    });
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "list_meeting_attachments")
        return [
          {
            id: 1,
            meeting_id: 99,
            kind: "meeting",
            value: "166",
            label: "Council Meeting",
            created_at: "2026-09-01T00:00:00Z",
          },
          {
            id: 2,
            meeting_id: 99,
            kind: "file",
            value: "/tmp/brief.md",
            label: "brief.md",
            created_at: "2026-09-01T00:00:00Z",
          },
        ];
      if (command === "related_meetings") return [];
      return null;
    });

    render(<NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />);

    expect(await screen.findByText("Council Meeting")).toBeVisible();
    expect(screen.getByText("brief.md")).toBeVisible();
    expect(screen.getByText("Your notes · 2 lines")).toBeVisible();
    expect(screen.getByText("Context used")).toBeVisible();
  });

  it("clicking an attached meeting opens it", async () => {
    const meeting = pendingMeeting({
      id: 99,
      user_notes: "one\ntwo",
      summary: "Notes summary",
      transcript: "hello",
    });
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "list_meeting_attachments")
        return [
          {
            id: 1,
            meeting_id: 99,
            kind: "meeting",
            value: "166",
            label: "Council Meeting",
            created_at: "2026-09-01T00:00:00Z",
          },
        ];
      if (command === "related_meetings") return [];
      return null;
    });
    const onOpenMeetingId = vi.fn();
    const user = userEvent.setup();

    render(
      <NoteViewer
        meeting={meeting}
        onMeetingUpdated={vi.fn()}
        onOpenMeetingId={onOpenMeetingId}
      />,
    );

    const chip = await screen.findByText("Council Meeting");
    await user.click(chip);
    expect(onOpenMeetingId).toHaveBeenCalledWith(166);
  });

  it("hides the strip when there is nothing to show", async () => {
    const meeting = pendingMeeting({
      id: 100,
      user_notes: "",
      summary: "Notes summary",
      transcript: "hello",
    });
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "list_meeting_attachments") return [];
      if (command === "related_meetings") return [];
      return null;
    });

    render(<NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Context used")).toBeNull();
    });
  });

  it("renders (file not included) for attachment without path separator", async () => {
    const meeting = pendingMeeting({
      id: 101,
      user_notes: "notes line",
      summary: "summary",
      transcript: "hi",
    });
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "related_meetings") return [];
      if (command === "list_meeting_attachments")
        return [
          { id: 9, meeting_id: 101, kind: "file", value: "notes.md", label: "notes.md", created_at: "2026-09-01T00:00:00Z" },
        ];
      return null;
    });
    render(<NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />);
    expect(await screen.findByText(/file not included/)).toBeVisible();
  });

  it("does not add suffix when attachment value has path separator", async () => {
    const meeting = pendingMeeting({
      id: 102,
      user_notes: "notes line",
      summary: "summary",
      transcript: "hi",
    });
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "related_meetings") return [];
      if (command === "list_meeting_attachments")
        return [
          { id: 10, meeting_id: 102, kind: "file", value: "/tmp/foo/notes.md", label: "notes.md", created_at: "2026-09-01T00:00:00Z" },
        ];
      return null;
    });
    render(<NoteViewer meeting={meeting} onMeetingUpdated={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("notes.md")).toBeVisible());
    expect(screen.queryByText(/file not included/)).toBeNull();
  });
});

describe("NoteViewer export menu", () => {
  const exportMeeting = pendingMeeting({
    id: 55,
    title: "Export Test",
    recorded_at: "2026-08-10T10:00:00Z",
    summary: "# Overview\nHello",
    transcript: "hello",
    attendees: ["Alice"],
    audio_file_path: null,
  });

  it("Export as Slide calls export_html with HTML containing active theme id", async () => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.setProperty("--bg-primary", "#f6f6f7");
    document.documentElement.style.setProperty("--bg-secondary", "#efeff1");
    document.documentElement.style.setProperty("--bg-tertiary", "#ffffff");
    document.documentElement.style.setProperty("--text-primary", "#1a1a1f");
    document.documentElement.style.setProperty("--text-secondary", "#494951");
    document.documentElement.style.setProperty("--text-muted", "#6b6b74");
    document.documentElement.style.setProperty("--accent-blue", "#007aff");
    document.documentElement.style.setProperty("--accent-purple", "#7c3aed");
    document.documentElement.style.setProperty("--accent-green", "#1f9d4d");
    document.documentElement.style.setProperty("--accent-amber", "#b45309");
    document.documentElement.style.setProperty("--accent-red", "#d92d20");
    const captured: { name: string; contents: string }[] = [];
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "list_meeting_attachments") return [];
      if (command === "related_meetings") return [];
      if (command === "export_html") {
        const p = payload as { defaultName: string; contents: string };
        captured.push({ name: p.defaultName, contents: p.contents });
        return "/tmp/Export-Test.html";
      }
      return null;
    });
    const user = userEvent.setup();
    render(<NoteViewer meeting={exportMeeting} onMeetingUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(screen.getByRole("menuitem", { name: "Export as Slide…" }));
    await waitFor(() => expect(captured.length).toBe(1));
    expect(captured[0].name).toBe("Export-Test.html");
    expect(captured[0].contents).toContain('name="adversaria-theme" content="light"');
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("--bg-primary");
  });

  it("Export as PDF uses -print file name", async () => {
    document.documentElement.dataset.theme = "dark";
    const captured: { name: string }[] = [];
    shellOpenMock.mockClear();
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "list_meeting_attachments") return [];
      if (command === "related_meetings") return [];
      if (command === "export_html") {
        const p = payload as { defaultName: string; contents: string };
        captured.push({ name: p.defaultName });
        return "/tmp/Export-Test-print.html";
      }
      return null;
    });
    const user = userEvent.setup();
    render(<NoteViewer meeting={exportMeeting} onMeetingUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(screen.getByRole("menuitem", { name: "Export as PDF (opens print)…" }));
    await waitFor(() => expect(captured.length).toBe(1));
    expect(captured[0].name).toBe("Export-Test-print.html");
    await waitFor(() => expect(shellOpenMock).toHaveBeenCalledWith("file:///tmp/Export-Test-print.html#print"));
    document.documentElement.removeAttribute("data-theme");
  });

  it("Export as .adversaria invokes export_adversaria with meetingIds and folderId null", async () => {
    const captured: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "list_meeting_attachments") return [];
      if (command === "related_meetings") return [];
      if (command === "export_adversaria") {
        captured.push(payload);
        return "/tmp/export.adversaria";
      }
      return null;
    });
    const user = userEvent.setup();
    render(<NoteViewer meeting={exportMeeting} onMeetingUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(screen.getByRole("menuitem", { name: /Export as \.adversaria/ }));
    await waitFor(() => expect(captured.length).toBe(1));
    expect(captured[0]).toEqual({ meetingIds: [55], folderId: null });
  });
});

describe("NoteViewer AI Copilot tab", () => {
  it("shows the AI Copilot tab and its empty state", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "list_meeting_attachments") return [];
      if (command === "related_meetings") return [];
      return null;
    });
    const user = userEvent.setup();
    render(<NoteViewer meeting={pendingMeeting({ id: 1, transcript: "hello", summary: "notes", audio_file_path: null })} onMeetingUpdated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "AI Copilot" }));
    expect(await screen.findByText("No Copilot suggestions were saved for this meeting.")).toBeVisible();
  });
});

describe("NoteViewer summary edit rich editor", () => {
  it("summary edit mode mounts the rich editor", async () => {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      if (command === "list_meeting_attachments") return [];
      if (command === "related_meetings") return [];
      return null;
    });
    const user = userEvent.setup();
    render(
      <NoteViewer
        meeting={pendingMeeting({
          id: 10,
          transcript: "hello",
          summary: "**Attendees:** Hamza\n\n**Overview**\n\n- point one\n- point two\n\n- [ ] Hamza: task",
          audio_file_path: null,
        })}
        onMeetingUpdated={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      await screen.findByLabelText("Meeting notes", {}, { timeout: 10000 }),
    ).toBeInTheDocument();
    expect(document.querySelector(".summary-editor")).not.toBeNull();
    expect(screen.getByText("Editing the meeting notes. Headings and checkboxes are kept; saved as Markdown.")).toBeVisible();
  });
});

describe("NoteViewer collapsible header", () => {
  const headerMeeting = pendingMeeting({
    id: 7,
    title: "Weekly sync",
    attendees: ["Alice"],
    transcript: "hello",
    summary: "Notes",
    audio_file_path: null,
    tags: [],
  });

  function mockHeaderBase() {
    mockIPC((command) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "get_config") return appConfig();
      return null;
    });
  }

  it("is collapsed by default: title visible, detail rows hidden", () => {
    localStorage.clear();
    mockHeaderBase();

    render(<NoteViewer meeting={headerMeeting} onMeetingUpdated={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "Weekly sync" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show meeting details" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Add attendee")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Add a term to the transcription dictionary"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rename Alice" }),
    ).not.toBeInTheDocument();
  });

  it("the chevron expands and collapses the details and remembers the choice", async () => {
    localStorage.clear();
    mockHeaderBase();
    const user = userEvent.setup();

    render(<NoteViewer meeting={headerMeeting} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Show meeting details" }));
    expect(screen.getByLabelText("Add attendee")).toBeVisible();
    expect(
      screen.getByLabelText("Add a term to the transcription dictionary"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Hide meeting details" }),
    ).toBeVisible();
    expect(localStorage.getItem("viewer.headerCollapsed")).toBe("0");

    await user.click(screen.getByRole("button", { name: "Hide meeting details" }));
    expect(screen.queryByLabelText("Add attendee")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Add a term to the transcription dictionary"),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem("viewer.headerCollapsed")).toBe("1");
  });

  it("starts expanded when the stored choice says so", () => {
    localStorage.clear();
    localStorage.setItem("viewer.headerCollapsed", "0");
    mockHeaderBase();

    render(<NoteViewer meeting={headerMeeting} onMeetingUpdated={vi.fn()} />);

    expect(screen.getByLabelText("Add attendee")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Hide meeting details" }),
    ).toBeVisible();
    localStorage.clear();
  });
});

describe("NoteViewer meeting rename", () => {
  const titled = pendingMeeting({
    id: 11,
    title: "Weekly sync",
    transcript: "hello",
    summary: "Notes",
    audio_file_path: null,
    tags: [],
  });

  function mockRenameBase(
    onTitle: (payload: unknown) => unknown,
    calls: unknown[],
  ) {
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "update_meeting_title") {
        calls.push(payload);
        return onTitle(payload);
      }
      return null;
    });
  }

  it("Enter saves a trimmed title and propagates the update", async () => {
    localStorage.clear();
    const calls: unknown[] = [];
    mockRenameBase((payload) => (payload as { title: string }).title.trim(), calls);
    const onMeetingUpdated = vi.fn();
    const user = userEvent.setup();

    render(<NoteViewer meeting={titled} onMeetingUpdated={onMeetingUpdated} />);

    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    const input = screen.getByRole("textbox", { name: "Meeting title" });
    expect(input).toHaveValue("Weekly sync");
    await user.clear(input);
    await user.type(input, "  Renamed sync  {Enter}");

    await waitFor(() =>
      expect(calls).toEqual([{ id: 11, title: "Renamed sync" }]),
    );
    expect(onMeetingUpdated).toHaveBeenCalledWith({
      ...titled,
      title: "Renamed sync",
    });
  });

  it("double-clicking the title opens the rename input", async () => {
    localStorage.clear();
    const calls: unknown[] = [];
    mockRenameBase((payload) => (payload as { title: string }).title, calls);
    const user = userEvent.setup();

    render(<NoteViewer meeting={titled} onMeetingUpdated={vi.fn()} />);

    await user.dblClick(screen.getByRole("heading", { name: "Weekly sync" }));
    expect(screen.getByRole("textbox", { name: "Meeting title" })).toHaveValue(
      "Weekly sync",
    );
    expect(calls).toHaveLength(0);
  });

  it("Escape cancels without calling the command", async () => {
    localStorage.clear();
    const calls: unknown[] = [];
    mockRenameBase(() => "unused", calls);
    const user = userEvent.setup();

    render(<NoteViewer meeting={titled} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    const input = screen.getByRole("textbox", { name: "Meeting title" });
    await user.clear(input);
    await user.type(input, "Discarded{Escape}");

    expect(calls).toHaveLength(0);
    expect(
      screen.getByRole("heading", { name: "Weekly sync" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Meeting title" }),
    ).not.toBeInTheDocument();
  });

  it("an unchanged title exits edit mode without calling the command", async () => {
    localStorage.clear();
    const calls: unknown[] = [];
    mockRenameBase(() => "unused", calls);
    const user = userEvent.setup();

    render(<NoteViewer meeting={titled} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    const input = screen.getByRole("textbox", { name: "Meeting title" });
    await user.click(input);
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Meeting title" }),
      ).not.toBeInTheDocument(),
    );
    expect(calls).toHaveLength(0);
  });

  it("whitespace-only input shows an error and does not call the command", async () => {
    localStorage.clear();
    const calls: unknown[] = [];
    mockRenameBase(() => "unused", calls);
    const user = userEvent.setup();

    render(<NoteViewer meeting={titled} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    const input = screen.getByRole("textbox", { name: "Meeting title" });
    await user.clear(input);
    await user.type(input, "   {Enter}");

    expect(calls).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("Title can't be empty.");
    // Stays in edit mode so the user can fix it.
    expect(screen.getByRole("textbox", { name: "Meeting title" })).toBeInTheDocument();
  });

  it("a rejected rename shows the message and stays in edit mode", async () => {
    localStorage.clear();
    const calls: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "list_templates") return [];
      if (command === "get_action_items") return [];
      if (command === "update_meeting_title") {
        calls.push(payload);
        throw new Error("Title is too long (200 characters max).");
      }
      return null;
    });
    const user = userEvent.setup();

    render(<NoteViewer meeting={titled} onMeetingUpdated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Rename meeting" }));
    const input = screen.getByRole("textbox", { name: "Meeting title" });
    await user.clear(input);
    await user.type(input, "A brand new title{Enter}");

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Title is too long (200 characters max).",
    );
    expect(screen.getByRole("textbox", { name: "Meeting title" })).toBeInTheDocument();
  });
});
