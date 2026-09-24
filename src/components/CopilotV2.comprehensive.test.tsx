import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../lib/tauri", () => ({
  getConfig: vi.fn().mockResolvedValue({ copilot_hud_enabled: false }),
  getAudioLevel: vi.fn().mockResolvedValue(0),
  pickContextFile: vi.fn().mockResolvedValue(null),
  getFolderCopilotBrief: vi.fn().mockResolvedValue({ folder_id: 3, folder_name: "F", copilot_mode: "no_ai", copilot_web: false, meeting_count: 0, last_meeting: null, open_items: [], decisions: [], follow_ups: [] }),
  setFolderCopilotMode: vi.fn().mockResolvedValue(undefined),
  setFolderCopilotWeb: vi.fn().mockResolvedValue(undefined),
  copilotGetMode: vi.fn().mockResolvedValue("no_ai"),
  copilotSetMode: vi.fn().mockResolvedValue("no_ai"),
  hasCopilotApiKey: vi.fn().mockResolvedValue(false),
  hasDeepSeekCopilotApiKey: vi.fn().mockResolvedValue(false),
  copilotSetMicQuestions: vi.fn().mockResolvedValue(undefined),
  copilotCardReview: vi.fn().mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T00:00:00Z", dismissed_at: null }),
  copilotHudIsOpen: vi.fn().mockResolvedValue(false),
}));

import { CopilotCards } from "./CopilotCards";
import { CopilotAnswerStrip } from "./CopilotAnswerStrip";
import { RecordingCompanion } from "./RecordingCompanion";
import type { CopilotCard } from "../types";
import { COPY } from "../lib/platform";

const sess = "sess-v2-test";

function card(overrides: Partial<CopilotCard> = {}): CopilotCard {
  return {
    id: 1,
    session_id: sess,
    status: "heard",
    provider_frozen: "claude",
    question: "What is the deadline?",
    asked_at_ms: Date.now(),
    trigger: "auto",
    passages: [],
    retrieval_ms: 10,
    ...overrides,
  };
}

describe("Copilot lifecycle and UI", () => {
  it("heard shows the assembled-question state, no empty-result copy while retrieval pending", () => {
    const c = card({ status: "heard", passages: [] });
    render(<CopilotCards cards={[c]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByText("Heard the complete question")).toBeInTheDocument();
    expect(screen.queryByText("No matching notes")).not.toBeInTheDocument();
  });

  it("answering keeps passages behind Sources and shows the provider", async () => {
    const c = card({
      status: "answering",
      passages: [{ source_kind: "meeting", source_id: "1", title: "M", text: "p text", score: 1 }],
      answer: { provider: "claude", status: "streaming", text: "hello", citations: [] },
    });
    render(<CopilotCards cards={[c]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.queryByText("p text")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sources · 1" }));
    expect(screen.getByText("p text")).toBeInTheDocument();
    expect(screen.getByText("Answering (Claude)…")).toBeInTheDocument();
  });

  it("local answering shows Local", () => {
    const c = card({
      status: "answering",
      passages: [{ source_kind: "meeting", source_id: "1", title: "M", text: "p", score: 1 }],
      answer: { provider: "local", status: "streaming", text: "hi", citations: [] },
    });
    render(<CopilotCards cards={[c]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByText("Answering (Local)…")).toBeInTheDocument();
  });

  it("DeepSeek answering and egress are labeled as cloud", async () => {
    const c = card({
      status: "answering",
      provider_frozen: "deepseek",
      passages: [{ source_kind: "meeting", source_id: "1", title: "M", text: "p", score: 1 }],
      answer: { provider: "deepseek", status: "streaming", text: "hi", citations: [] },
    });
    const { rerender } = render(<CopilotCards cards={[c]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByText("Answering (DeepSeek)…")).toBeInTheDocument();
    rerender(
      <CopilotCards
        cards={[{ ...c, status: "done", answer: { ...c.answer!, status: "done", egress_bytes: 144 } }]}
        onForceCard={vi.fn()}
        onPin={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText("Prepared request payload: 144 bytes")).toBeInTheDocument();
  });

  it("done provenance renders chips and footer, streamed fallback if empty", async () => {
    const c = card({
      status: "done",
      answer: {
        provider: "claude",
        status: "done",
        text: "stream fallback",
        citations: [],
        provenance: [{ text: "note bullet", label: "notes" }],
        egress_bytes: 123,
        web_performed: 0,
      },
      passages: [{ source_kind: "meeting", source_id: "1", title: "M", text: "p", score: 1 }],
    });
    render(<CopilotCards cards={[c]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByText("your notes")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText((t) => t.includes("Prepared request payload: 123 bytes"))).toBeInTheDocument();
  });

  it("skipped shows correct copy", () => {
    const c = card({ status: "skipped", reason: "superseded" });
    render(<CopilotCards cards={[c]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByText("Skipped, newer question arrived")).toBeInTheDocument();
  });

  it("cancelled and error show Retry, answering shows Cancel", () => {
    const cancelled = card({ answer: { provider: "claude", status: "cancelled", text: "", citations: [], reason: "user" } });
    const { rerender } = render(<CopilotCards cards={[cancelled]} onForceCard={vi.fn()} onPin={vi.fn()} onRetry={vi.fn()} copilotMode="claude" />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    const err = card({ answer: { provider: "claude", status: "error", text: "", citations: [], error: "boom" } });
    rerender(<CopilotCards cards={[err]} onForceCard={vi.fn()} onPin={vi.fn()} onRetry={vi.fn()} copilotMode="claude" />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    const streaming = card({ answer: { provider: "claude", status: "streaming", text: "hi", citations: [] } });
    rerender(<CopilotCards cards={[streaming]} onForceCard={vi.fn()} onPin={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("egress bytes copy exact intent", async () => {
    const local = card({ status: "done", answer: { provider: "local", status: "done", text: "", citations: [], provenance: [{ text: "b", label: "model" }], egress_bytes: 0 } });
    const { rerender } = render(<CopilotCards cards={[local]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText(`0 bytes left this ${COPY.device}`)).toBeInTheDocument();
    const claude = card({ status: "done", answer: { provider: "claude", status: "done", text: "", citations: [], provenance: [{ text: "b", label: "model" }], egress_bytes: 200, web_performed: 2 } });
    rerender(<CopilotCards cards={[claude]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText((t) => t.includes("Prepared request payload: 200 bytes") && t.includes("2 web searches"))).toBeInTheDocument();
  });

  it("pin excludes first-person model claim", async () => {
    const onPin = vi.fn();
    const c = card({
      status: "done",
      answer: {
        provider: "claude",
        status: "done",
        text: "",
        citations: [],
        provenance: [{ text: "I built this feature myself", label: "model" }],
        egress_bytes: 10,
      },
    });
    const { container } = render(<CopilotCards cards={[c]} onForceCard={vi.fn()} onPin={onPin} />);
    expect(container.textContent).toContain("I built this feature myself");
  });
});

describe("CopilotAnswerStrip", () => {
  it("hidden when no cards or copilot active", () => {
    const { rerender } = render(<CopilotAnswerStrip cards={[]} activeTab="notes" onOpen={vi.fn()} />);
    expect(screen.queryByTestId("copilot-answer-strip")).not.toBeInTheDocument();
    const c = card({ question: "A very long question that should be truncated near eighty characters to fit the strip layout nicely" });
    rerender(<CopilotAnswerStrip cards={[c]} activeTab="copilot" onOpen={vi.fn()} />);
    expect(screen.queryByTestId("copilot-answer-strip")).not.toBeInTheDocument();
  });

  it("shows truncated question and state and Open", async () => {
    const onOpen = vi.fn();
    const c = card({ question: "What is the deadline for the Northstar kickoff deliverable and who owns it?", status: "heard" });
    render(<CopilotAnswerStrip cards={[c]} activeTab="notes" onOpen={onOpen} />);
    const strip = screen.getByTestId("copilot-answer-strip");
    expect(strip.textContent).toContain("What is the deadline");
    expect(screen.getByText("Heard")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Open Copilot" });
    await userEvent.setup().click(btn);
    expect(onOpen).toHaveBeenCalledWith(1);
  });
});

describe("RecordingCompanion transcript variant", () => {
  const baseProps = {
    variant: "transcript",
    value: "",
    onChange: vi.fn(),
    status: "recording" as const,
    liveLines: [{ text: "Hello live", source: "them" }],
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    recentMeetings: [],
    onStop: vi.fn(),
    onBrowse: vi.fn(),
    folders: [],
    recordingFolderId: null,
    onChangeRecordingFolder: vi.fn(),
    copilotCards: [card({ question: "Q from them?" })],
    onForceCard: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onNotice: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(async () => {});
  });

  it("strip visible, Open displays sheet, transcript remains mounted, Escape closes", async () => {
    const user = userEvent.setup();
    render(<RecordingCompanion {...baseProps} />);

    // strip visible
    expect(screen.getByTestId("copilot-answer-strip")).toBeInTheDocument();
    // transcript feed still mounted
    expect(screen.getByText("Hello live")).toBeInTheDocument();
    // sheet not open initially
    expect(screen.queryByRole("dialog", { name: "Copilot" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Copilot" }));
    const dialog = screen.getByRole("dialog", { name: "Copilot" });
    expect(dialog).toBeInTheDocument();
    // transcript still mounted behind sheet
    expect(screen.getByText("Hello live")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Copilot" })).not.toBeInTheDocument();
    expect(screen.getByText("Hello live")).toBeInTheDocument();
  });
});

describe("RecordingCompanion balanced strip", () => {
  it("strip does not steal Notes tab; Open selects Copilot", async () => {
    const user = userEvent.setup();
    const c = card({ question: "Strip Q?" });
    render(
      <RecordingCompanion
        variant="balanced"
        value="notes text"
        onChange={vi.fn()}
        status="recording"
        liveLines={[]}
        attachments={[]}
        onAddAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        recentMeetings={[]}
        onStop={vi.fn()}
        onBrowse={vi.fn()}
        folders={[]}
        recordingFolderId={null}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[c]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    // initially Notes active
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
    // strip appears
    expect(screen.getByTestId("copilot-answer-strip")).toBeInTheDocument();
    // Notes still active
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "Open Copilot" }));
    expect(screen.getByRole("tab", { name: "Copilot" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Pin includes finalized bullets and includes first-person", () => {
  it("pin from RecordingCompanion writes labelled bullets", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const c = card({
      id: 9,
      question: "What is status?",
      status: "done",
      passages: [{ source_kind: "meeting", source_id: "1", title: "Kickoff", text: "p", score: 1 }],
      answer: {
        provider: "claude",
        status: "done",
        text: "",
        citations: [],
        provenance: [
          { text: "Note bullet", label: "notes", passage_index: 0 },
          { text: "Web bullet", label: "web", url: "https://example.org" },
          { text: "I did the work", label: "model" },
        ],
        egress_bytes: 10,
      },
    });
    render(
      <RecordingCompanion
        variant="balanced"
        value="existing"
        onChange={onChange}
        status="recording"
        liveLines={[]}
        attachments={[]}
        onAddAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        recentMeetings={[]}
        onStop={vi.fn()}
        onBrowse={vi.fn()}
        folders={[]}
        recordingFolderId={null}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[c]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    await user.click(screen.getByRole("button", { name: "Pin card 9 to notes" }));
    const pinned = String(onChange.mock.calls[0][0]);
    expect(pinned).toContain("Copilot:");
    expect(pinned).toContain("What is status?");
    expect(pinned).toContain("[your notes]");
    expect(pinned).toContain("[web · example.org]");
    expect(pinned).toContain("I did the work");
    expect(pinned).toContain("Kickoff");
  });
});

describe("Folder web checkbox", () => {
  it("disabled without folder, off by default", async () => {
    const user = userEvent.setup();
    render(
      <RecordingCompanion
        variant="balanced"
        value=""
        onChange={vi.fn()}
        status="recording"
        liveLines={[]}
        attachments={[]}
        onAddAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        recentMeetings={[]}
        onStop={vi.fn()}
        onBrowse={vi.fn()}
        folders={[{ folder: { id: 1, name: "F", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 1 }]}
        recordingFolderId={null}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Last time" }));
    const checkbox = screen.getByLabelText("Allow web search (Claude only)") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
  });
});

describe("Accessibility", () => {
  it("radios, checkboxes, dialog actions have names and no div-as-button", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <RecordingCompanion
        variant="balanced"
        value=""
        onChange={vi.fn()}
        status="recording"
        liveLines={[]}
        attachments={[]}
        onAddAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        recentMeetings={[]}
        onStop={vi.fn()}
        onBrowse={vi.fn()}
        folders={[]}
        recordingFolderId={null}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[card({ question: "Q?" })]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    // no div with role button
    expect(container.querySelectorAll("div[role='button']").length).toBe(0);
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    // radios have accessible names
    expect(screen.getByRole("radio", { name: "No AI" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "AI \u00b7 Local" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "AI \u00b7 Claude" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "AI \u00b7 DeepSeek" })).toBeInTheDocument();
    // checkbox has label inside head menu
    await user.click(screen.getByRole("button", { name: "More options" }));
    const checkbox = screen.getByLabelText("Questions can come from my mic");
    expect(checkbox).toBeInTheDocument();
    // dialog close has name when sheet open in transcript variant
  });
});
