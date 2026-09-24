import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { RecordingControls } from "../components/RecordingControls";
import { pendingMeeting } from "../test/fixtures";
import { appConfig } from "../test/fixtures";
import { useRecording } from "./useRecording";

function RecordingHarness({
  folderId,
}: {
  folderId?: number | null;
}) {
  const recording = useRecording();
  return (
    <>
      <RecordingControls
        status={recording.status}
        onStart={() => void recording.start()}
        onStop={() => void recording.stop("general", "live note", [], folderId ?? null)}
      />
      <output data-testid="status">{recording.status}</output>
      <output data-testid="meeting-id">{recording.lastMeetingId ?? "none"}</output>
      <output data-testid="settled">{recording.settledTick}</output>
      <output data-testid="discarded-id">{recording.lastDiscardedId ?? "none"}</output>
      <output data-testid="error">{recording.error ?? "none"}</output>
      <output data-testid="session">{recording.copilotSessionId ?? "none"}</output>
    </>
  );
}



describe("useRecording", () => {
  it("resumes recovered recordings automatically only on the local backend", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig({ transcription_base_url: "" });
      if (command === "get_meetings") return [pendingMeeting({ id: 7 })];
      if (command === "transcribe_meeting") {
        return pendingMeeting({ id: 7, transcript: "recovered", audio_file_path: null });
      }
      if (command === "calendar_event_at") return null;
      return null;
    });

    render(<RecordingHarness />);
    await waitFor(() => expect(screen.getByTestId("settled")).toHaveTextContent("1"));
  });

  it("persists a stopped capture before background transcription", async () => {
    const commands: string[] = [];
    mockIPC((command, args) => {
      if (command === "start_recording") return { copilot_session_id: "sess-start-1" };
      if (command === "stop_recording") {
        return { system_path: "/tmp/meeting.wav", mic_path: null, warning: null, copilot_session_id: "sess-start-1" };
      }
      if (command === "enqueue_recording") {
        // require nonblank session id – review gap 1
        const a = args as any;
        if (!a.copilotSessionId || String(a.copilotSessionId).trim() === "") throw new Error("missing session");
        commands.push(command);
        return pendingMeeting();
      }
      if (command === "transcribe_meeting") {
        commands.push(command);
        return pendingMeeting({ transcript: "Them: hello", audio_file_path: null });
      }
      if (command === "calendar_event_at") return null;
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness />);

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("recording"));
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent("sess-start-1"));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(screen.getByTestId("meeting-id")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByTestId("settled")).toHaveTextContent("1"));
    expect(commands.indexOf("enqueue_recording")).toBeLessThan(
      commands.indexOf("transcribe_meeting"),
    );
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent("none"));
  });

  it("keeps and queues committed audio when capture finishes with a warning", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig({ transcription_base_url: "https://cloud.invalid" });
      if (command === "get_meetings") return [];
      if (command === "start_recording") return { copilot_session_id: "sess-warn" };
      if (command === "stop_recording") {
        return {
          system_path: "/tmp/recoverable.adversaria-spool",
          mic_path: null,
          warning: "Encrypted writer could not keep up.",
          copilot_session_id: "sess-warn",
        };
      }
      if (command === "enqueue_recording") return pendingMeeting({ id: 22 });
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness />);
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(screen.getByTestId("meeting-id")).toHaveTextContent("22"));
    expect(screen.getByTestId("error")).toHaveTextContent("encrypted audio was preserved");
  });

  it("returns to idle and surfaces a capture-start failure", async () => {
    mockIPC((command) => {
      if (command === "start_recording") throw new Error("microphone denied");
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness />);
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("idle"));
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("stays recording when backend refuses with Already recording (two toggle sources raced)", async () => {
    mockIPC((command) => {
      if (command === "start_recording") throw new Error("Already recording");
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness />);
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("recording"));
    expect(screen.getByTestId("error")).toHaveTextContent("none");
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled();
  });

  it("sets lastDiscardedId when transcribeMeeting resolves null (no-speech phantom)", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig({ transcription_base_url: "" });
      if (command === "get_meetings") return [];
      if (command === "start_recording") return { copilot_session_id: "sess-phantom" };
      if (command === "stop_recording") {
        return { system_path: "/tmp/silent.wav", mic_path: null, warning: null, copilot_session_id: "sess-phantom" };
      }
      if (command === "enqueue_recording") return pendingMeeting({ id: 42 });
      if (command === "transcribe_meeting") return null; // auto-discarded
      if (command === "calendar_event_at") return null;
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness />);

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("recording"));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(screen.getByTestId("settled")).toHaveTextContent("1"));
    expect(screen.getByTestId("discarded-id")).toHaveTextContent("42");
  });

  it("invokes set_meeting_folder with pending id and folder id when supplied", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((command, args) => {
      calls.push({ cmd: command, args });
      if (command === "get_config") return appConfig({ transcription_base_url: "" });
      if (command === "get_meetings") return [];
      if (command === "start_recording") return { copilot_session_id: "sess-99" };
      if (command === "stop_recording") return { system_path: "/tmp/meeting.wav", mic_path: null, warning: null, copilot_session_id: "sess-99" };
      if (command === "enqueue_recording") return pendingMeeting({ id: 99 });
      if (command === "set_meeting_folder") return null;
      if (command === "transcribe_meeting") return pendingMeeting({ id: 99, transcript: "hello", audio_file_path: null });
      if (command === "calendar_event_at") return null;
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness folderId={7} />);

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("recording"));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(screen.getByTestId("meeting-id")).toHaveTextContent("99"));
    const folderCall = calls.find((c) => c.cmd === "set_meeting_folder");
    expect(folderCall).toBeDefined();
    expect(folderCall?.args).toEqual({ meetingId: 99, folderId: 7 });
  });

  it("does NOT invoke set_meeting_folder when folder id is null", async () => {
    const calls: string[] = [];
    mockIPC((command) => {
      calls.push(command);
      if (command === "get_config") return appConfig({ transcription_base_url: "" });
      if (command === "get_meetings") return [];
      if (command === "start_recording") return { copilot_session_id: "sess-100" };
      if (command === "stop_recording") return { system_path: "/tmp/meeting.wav", mic_path: null, warning: null, copilot_session_id: "sess-100" };
      if (command === "enqueue_recording") return pendingMeeting({ id: 100 });
      if (command === "transcribe_meeting") return pendingMeeting({ id: 100, transcript: "hello", audio_file_path: null });
      if (command === "calendar_event_at") return null;
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness folderId={null} />);

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("recording"));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(screen.getByTestId("meeting-id")).toHaveTextContent("100"));
    expect(calls).not.toContain("set_meeting_folder");
  });

  it("stop uses authoritative returned id for enqueue and next start replaces prior id (hook-level session propagation)", async () => {
    const enqueueSessions: (string | null)[] = [];
    let startCount = 0;
    mockIPC((command, args) => {
      if (command === "start_recording") {
        startCount += 1;
        return { copilot_session_id: startCount === 1 ? "sess-A" : "sess-B" };
      }
      if (command === "stop_recording") {
        return { system_path: "/tmp/a.wav", mic_path: null, warning: null, copilot_session_id: "sess-A" };
      }
      if (command === "enqueue_recording") {
        const a = args as any;
        enqueueSessions.push(a.copilotSessionId ?? null);
        return pendingMeeting({ id: 1, transcript: "", audio_file_path: "/tmp/a.wav" });
      }
      if (command === "transcribe_meeting") return pendingMeeting({ id: 1, transcript: "hi", audio_file_path: null });
      if (command === "calendar_event_at") return null;
      if (command === "get_config") return appConfig({ transcription_base_url: "" });
      if (command === "get_meetings") return [];
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness />);

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent("sess-A"));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(screen.getByTestId("meeting-id")).toHaveTextContent("1"));
    expect(enqueueSessions[0]).toBe("sess-A");

    // next start must replace prior id
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent("sess-B"));
    expect(screen.getByTestId("session").textContent).not.toBe("sess-A");
  });

  it("surfaces visible error when returned stop id differs from active ref and still uses returned id", async () => {
    mockIPC((command) => {
      if (command === "start_recording") return { copilot_session_id: "sess-active" };
      if (command === "stop_recording") return { system_path: "/tmp/mismatch.wav", mic_path: null, warning: null, copilot_session_id: "sess-returned" };
      if (command === "enqueue_recording") return pendingMeeting({ id: 5 });
      if (command === "transcribe_meeting") return pendingMeeting({ id: 5, transcript: "hi", audio_file_path: null });
      if (command === "calendar_event_at") return null;
      if (command === "get_config") return appConfig({ transcription_base_url: "" });
      if (command === "get_meetings") return [];
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness />);
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent("sess-active"));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("session mismatch"));
  });
});
