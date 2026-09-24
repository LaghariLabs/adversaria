import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecordingCompanion } from "./RecordingCompanion";

vi.mock("../lib/tauri", () => ({
  getConfig: vi.fn().mockResolvedValue({ copilot_hud_enabled: false }),
  getAudioLevel: vi.fn().mockResolvedValue(0),
  pickContextFile: vi.fn().mockResolvedValue(null),
  getFolderCopilotBrief: vi.fn().mockResolvedValue({ folder_id: 1, folder_name: "F", copilot_mode: "no_ai", copilot_web: false, meeting_count: 0, last_meeting: null, open_items: [], decisions: [], follow_ups: [] }),
  hasCopilotApiKey: vi.fn().mockResolvedValue(true),
  hasDeepSeekCopilotApiKey: vi.fn().mockResolvedValue(false),
  copilotGetMode: vi.fn().mockResolvedValue("no_ai"),
  copilotSetMode: vi.fn().mockRejectedValue(new Error("mode fail")),
  setFolderCopilotMode: vi.fn().mockResolvedValue(undefined),
  setFolderCopilotWeb: vi.fn().mockResolvedValue(undefined),
  copilotSetMicQuestions: vi.fn().mockResolvedValue(undefined),
  copilotCardReview: vi.fn().mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T00:00:00Z", dismissed_at: null }),
  copilotLiveState: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveConfigure: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveReview: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 2, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotHudIsOpen: vi.fn().mockResolvedValue(false),
}));

describe("RecordingCompanion mode failure", () => {
  it("restores previous segment and calls notice on IPC failure", async () => {
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
        folders={[]}
        recordingFolderId={null}
        onChangeRecordingFolder={vi.fn()}
        copilotCards={[]}
        onForceCard={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onNotice={onNotice}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    expect(screen.getByRole("radio", { name: "No AI" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "AI \u00b7 Local" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByRole("radio", { name: "No AI" })).toHaveAttribute("aria-checked", "true");
    expect(onNotice).toHaveBeenCalled();
  });
});
