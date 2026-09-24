import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecordingCompanion } from "./RecordingCompanion";

const mocks = vi.hoisted(() => ({
  getBrief: vi.fn(),
  getAudio: vi.fn().mockResolvedValue(0),
  pickFile: vi.fn().mockResolvedValue(null),
  hasKey: vi.fn().mockResolvedValue(false),
  hasDeepSeekKey: vi.fn().mockResolvedValue(false),
  getMode: vi.fn().mockResolvedValue("no_ai"),
  setMode: vi.fn().mockResolvedValue("local"),
  setFolderMode: vi.fn().mockResolvedValue(undefined),
  setFolderWeb: vi.fn().mockResolvedValue(undefined),
  copilotSetMicQuestions: vi.fn().mockResolvedValue(undefined),
  copilotLiveState: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveConfigure: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveReview: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 2, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
}));

vi.mock("../lib/tauri", () => ({
  getConfig: vi.fn().mockResolvedValue({ copilot_hud_enabled: false }),
  getAudioLevel: mocks.getAudio,
  pickContextFile: mocks.pickFile,
  getFolderCopilotBrief: mocks.getBrief,
  setFolderCopilotMode: mocks.setFolderMode,
  hasCopilotApiKey: mocks.hasKey,
  hasDeepSeekCopilotApiKey: mocks.hasDeepSeekKey,
  copilotGetMode: mocks.getMode,
  copilotSetMode: mocks.setMode,
  setFolderCopilotWeb: mocks.setFolderWeb,
  copilotSetMicQuestions: mocks.copilotSetMicQuestions,
  copilotCardReview: vi.fn().mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T00:00:00Z", dismissed_at: null }),
  copilotLiveState: mocks.copilotLiveState,
  copilotLiveConfigure: mocks.copilotLiveConfigure,
  copilotLiveReview: mocks.copilotLiveReview,
  copilotHudIsOpen: vi.fn().mockResolvedValue(false),
}));

function brief(folderId: number, web: boolean) {
  return {
    folder_id: folderId,
    folder_name: `F${folderId}`,
    copilot_mode: "no_ai" as const,
    copilot_web: web,
    meeting_count: 0,
    last_meeting: null,
    open_items: [],
    decisions: [],
    follow_ups: [],
  };
}

describe("RecordingCompanion folderWebEnabled from brief", () => {
  it("already-enabled folder loads as checked", async () => {
    mocks.getBrief.mockReset();
    mocks.getBrief.mockResolvedValue(brief(7, true));
    mocks.setFolderWeb.mockReset();
    mocks.setFolderWeb.mockResolvedValue(undefined);
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
        folders={[
          { folder: { id: 7, name: "F7", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 0 },
        ]}
        recordingFolderId={7}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={vi.fn()}
        copilotSessionId="sess-7"
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Last time" }));
    await waitFor(() => {
      const cb = screen.getByLabelText("Allow web search (Claude only)") as HTMLInputElement;
      expect(cb.checked).toBe(true);
      expect(cb.disabled).toBe(false);
    });
  });

  it("A-to-B switch with out-of-order brief keeps B's value (safe reset)", async () => {
    // A slow (true), B fast (false) – final should be false even though A resolves later
    let resolveA: (v: any) => void = () => {};
    const promiseA = new Promise((res) => { resolveA = res; });
    mocks.getBrief.mockImplementation((id: number) => {
      if (id === 1) return promiseA; // slow A
      if (id === 2) return Promise.resolve(brief(2, false)); // fast B
      return Promise.resolve(brief(id, false));
    });

    const { rerender } = render(
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
        folders={[
          { folder: { id: 1, name: "F1", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 0 },
          { folder: { id: 2, name: "F2", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 0 },
        ]}
        recordingFolderId={1}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={vi.fn()}
        copilotSessionId="sess-ongoing"
      />,
    );

    // switch quickly to B before A resolves
    rerender(
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
        folders={[
          { folder: { id: 1, name: "F1", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 0 },
          { folder: { id: 2, name: "F2", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 0 },
        ]}
        recordingFolderId={2}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={vi.fn()}
        copilotSessionId="sess-ongoing"
      />,
    );

    // B's brief already resolved -> checkbox false
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Last time" }));
    await waitFor(() => {
      const cb = screen.getByLabelText("Allow web search (Claude only)") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });

    // now resolve slow A (true) – should be ignored
    resolveA(brief(1, true));
    await new Promise((r) => setTimeout(r, 20));
    await waitFor(() => {
      const cb = screen.getByLabelText("Allow web search (Claude only)") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });
  });

  it("retain optimistic rollback on IPC failure", async () => {
    mocks.getBrief.mockReset();
    mocks.getBrief.mockResolvedValue(brief(5, false));
    mocks.setFolderWeb.mockReset();
    mocks.setFolderWeb.mockRejectedValueOnce(new Error("ipc fail"));
    const user = userEvent.setup();
    const onNotice = vi.fn();
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
        folders={[
          { folder: { id: 5, name: "F5", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 0 },
        ]}
        recordingFolderId={5}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={onNotice}
        copilotSessionId="sess-5"
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Last time" }));
    await waitFor(() => expect(screen.getByLabelText("Allow web search (Claude only)")).toBeInTheDocument());
    // wait for brief to settle (initial false)
    await waitFor(() => expect((screen.getByLabelText("Allow web search (Claude only)") as HTMLInputElement).checked).toBe(false));
    const cb = screen.getByLabelText("Allow web search (Claude only)") as HTMLInputElement;
    expect(cb.checked).toBe(false);
    await user.click(cb);
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText("Allow web search (Claude only)") as HTMLInputElement).checked).toBe(false));
    expect(mocks.setFolderWeb).toHaveBeenCalledWith(5, true, "sess-5");
  });
});
