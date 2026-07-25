import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { RecordingControls } from "../components/RecordingControls";
import { pendingMeeting } from "../test/fixtures";
import { appConfig } from "../test/fixtures";
import { useRecording } from "./useRecording";

function RecordingHarness() {
  const recording = useRecording();
  return (
    <>
      <RecordingControls
        status={recording.status}
        onStart={() => void recording.start()}
        onStop={() => void recording.stop("general", "live note")}
      />
      <output data-testid="status">{recording.status}</output>
      <output data-testid="meeting-id">{recording.lastMeetingId ?? "none"}</output>
      <output data-testid="settled">{recording.settledTick}</output>
      <output data-testid="discarded-id">{recording.lastDiscardedId ?? "none"}</output>
      <output data-testid="error">{recording.error ?? "none"}</output>
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
    mockIPC((command) => {
      commands.push(command);
      if (command === "stop_recording") {
        return { system_path: "/tmp/meeting.wav", mic_path: null, warning: null };
      }
      if (command === "enqueue_recording") return pendingMeeting();
      if (command === "transcribe_meeting") {
        return pendingMeeting({ transcript: "Them: hello", audio_file_path: null });
      }
      if (command === "calendar_event_at") return null;
      return null;
    });

    const user = userEvent.setup();
    render(<RecordingHarness />);

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("recording"));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(screen.getByTestId("meeting-id")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByTestId("settled")).toHaveTextContent("1"));
    expect(commands.indexOf("enqueue_recording")).toBeLessThan(
      commands.indexOf("transcribe_meeting"),
    );
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("keeps and queues committed audio when capture finishes with a warning", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig({ transcription_base_url: "https://cloud.invalid" });
      if (command === "get_meetings") return [];
      if (command === "stop_recording") {
        return {
          system_path: "/tmp/recoverable.adversaria-spool",
          mic_path: null,
          warning: "Encrypted writer could not keep up.",
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
      if (command === "stop_recording") {
        return { system_path: "/tmp/silent.wav", mic_path: null, warning: null };
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
});
