import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RecordingCompanion } from "./RecordingCompanion";

type Readiness = import("../types").CopilotFolderReadiness;

const listenMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

const tauriMocks = vi.hoisted(() => ({
  getConfig: vi.fn().mockResolvedValue({ copilot_hud_enabled: false }),
  getAudioLevel: vi.fn().mockResolvedValue(0),
  pickContextFile: vi.fn().mockResolvedValue(null),
  getFolderCopilotBrief: vi.fn().mockResolvedValue({
    folder_id: 1,
    folder_name: "Interviews",
    copilot_mode: "no_ai",
    copilot_web: false,
    meeting_count: 0,
    last_meeting: null,
    open_items: [],
    decisions: [],
    follow_ups: [],
  }),
  hasCopilotApiKey: vi.fn().mockResolvedValue(false),
  hasDeepSeekCopilotApiKey: vi.fn().mockResolvedValue(false),
  copilotGetMode: vi.fn().mockResolvedValue("no_ai"),
  copilotSetMode: vi.fn().mockResolvedValue("local"),
  setFolderCopilotMode: vi.fn().mockResolvedValue(undefined),
  setFolderCopilotWeb: vi.fn().mockResolvedValue(undefined),
  copilotSetMicQuestions: vi.fn().mockResolvedValue(undefined),
  copilotFolderReadiness: vi.fn(),
  copilotCardReview: vi.fn().mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T00:00:00Z", dismissed_at: null }),
  copilotLiveState: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveConfigure: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveReview: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 2, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotHudIsOpen: vi.fn().mockResolvedValue(false),
}));

vi.mock("../lib/tauri", () => tauriMocks);

const folders = [
  { folder: { id: 7, name: "Interviews", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" as const }, meeting_count: 0 },
];

const defaultProps = {
  variant: "balanced" as const,
  value: "",
  onChange: vi.fn(),
  status: "recording" as const,
  liveLines: [] as { text: string; source: string }[],
  attachments: [] as import("../types").AttachmentDraft[],
  onAddAttachment: vi.fn(),
  onRemoveAttachment: vi.fn(),
  recentMeetings: [] as { id: number; title: string }[],
  onStop: vi.fn(),
  onBrowse: vi.fn(),
  folders,
  recordingFolderId: 7 as number | null,
  onChangeRecordingFolder: vi.fn(),
  copilotCards: [] as import("../types").CopilotCard[],
  onForceCard: vi.fn(),
  onCancel: vi.fn(),
  onRetry: vi.fn(),
  onNotice: vi.fn(),
  copilotSessionId: "sess-abc",
};

describe("RecordingCompanion readiness_session_scoped", () => {
  let eventHandler: ((event: { payload: Readiness }) => void) | null = null;

  beforeEach(() => {
    eventHandler = null;
    listenMock.mockImplementation((_event: string, handler: (e: { payload: Readiness }) => void) => {
      eventHandler = handler;
      return Promise.resolve(() => {});
    });
    // default: getter pending (indexing) – never resolves until override
    tauriMocks.copilotFolderReadiness.mockReturnValue(new Promise(() => {}));
    tauriMocks.getFolderCopilotBrief.mockResolvedValue({
      folder_id: 7,
      folder_name: "Interviews",
      copilot_mode: "no_ai",
      copilot_web: false,
      meeting_count: 0,
      last_meeting: null,
      open_items: [],
      decisions: [],
      follow_ups: [],
    });
  });

  it("readiness_session_scoped", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<RecordingCompanion {...defaultProps} copilotSessionId="sess-abc" />);

    // need to open Copilot tab to see folder line (balanced right panel also shows it, but we open copilot for determinism)
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    // folder readiness lives in the head menu now
    await user.click(screen.getByRole("button", { name: "More options" }));
    // before any event, getter is pending -> indexing…
    expect(await screen.findByText("Folder: Interviews \u00b7 indexing\u2026")).toBeInTheDocument();

    // emit ready for that session
    const ready: Readiness = {
      session_id: "sess-abc",
      folder_id: 7,
      status: "ready",
      count: 33,
      pack_projects: 2,
      pack_chars: 1234,
      pack_hash: "abc",
      error: null,
    };
    eventHandler?.({ payload: ready });
    await waitFor(() => expect(screen.getByText("Folder: Interviews \u00b7 33 sources indexed \u00b7 pack 2 projects")).toBeInTheDocument());

    // emit for different session id – should not change
    const stale: Readiness = {
      session_id: "sess-other",
      folder_id: 7,
      status: "ready",
      count: 99,
      pack_projects: 9,
      pack_chars: 999,
      pack_hash: "zzz",
      error: null,
    };
    eventHandler?.({ payload: stale });
    // still shows previous ready, not stale
    await waitFor(() => expect(screen.getByText("Folder: Interviews \u00b7 33 sources indexed \u00b7 pack 2 projects")).toBeInTheDocument());
    expect(screen.queryByText("Folder: Interviews \u00b7 99 sources indexed \u00b7 pack 9 projects")).not.toBeInTheDocument();

    // emit error for original session
    const errPayload: Readiness = {
      session_id: "sess-abc",
      folder_id: 7,
      status: "error",
      count: 0,
      pack_projects: 0,
      pack_chars: 0,
      pack_hash: "",
      error: "walk failed",
    };
    eventHandler?.({ payload: errPayload });
    await waitFor(() => expect(screen.getByText("Folder: Interviews \u00b7 indexing failed: walk failed")).toBeInTheDocument());

    // finally assert getter resolves before any event: new component with getter returning ready immediately
    const getterReady: Readiness = {
      session_id: "sess-getter",
      folder_id: 7,
      status: "ready",
      count: 12,
      pack_projects: 1,
      pack_chars: 500,
      pack_hash: "hash2",
      error: null,
    };
    tauriMocks.copilotFolderReadiness.mockResolvedValue(getterReady);
    // need new listen handler for new session
    let getterHandler: ((event: { payload: Readiness }) => void) | null = null;
    listenMock.mockImplementation((_event: string, handler: (e: { payload: Readiness }) => void) => {
      getterHandler = handler;
      return Promise.resolve(() => {});
    });
    rerender(<RecordingCompanion {...defaultProps} copilotSessionId="sess-getter" />);
    // still need Copilot tab selected (already is), wait for getter to populate
    await waitFor(() => expect(screen.getByText("Folder: Interviews \u00b7 12 sources indexed \u00b7 pack 1 projects")).toBeInTheDocument());
    // ensure getter was called with correct session id
    expect(tauriMocks.copilotFolderReadiness).toHaveBeenCalledWith("sess-getter");
    // event handler should exist but not needed for this assertion
    expect(getterHandler).not.toBeNull();
  });
});
