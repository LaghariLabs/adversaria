import { useState, useCallback, useEffect, useRef } from "react";
import {
  startRecording,
  stopRecording,
  enqueueRecording,
  transcribeMeeting,
  calendarEventAt,
  getConfig,
  getMeetings,
} from "../lib/tauri";
import type { CalendarEvent } from "../types";
import { isUnrecoverable } from "../lib/recordingErrors";

/** Capture status only. Transcription no longer blocks this — once a recording
 *  is stopped it's enqueued for background transcription and the status returns
 *  to "idle" immediately, so the next meeting can be recorded right away. */
export type RecordingStatus = "idle" | "recording" | "stopping";

/** Attendees suggested from a calendar event overlapping the recording time. */
export interface RosterSuggestion {
  eventTitle: string;
  provider: string;
  attendees: string[]; // formatted as "Name <email>" for the existing UI
}

interface UseRecordingReturn {
  status: RecordingStatus;
  error: string | null;
  /** Id of the meeting created by the last completed recording, or null. */
  lastMeetingId: number | null;
  /** Calendar-sourced roster suggestion for the last recording, or null. */
  rosterSuggestion: RosterSuggestion | null;
  /** Meeting ids waiting to be transcribed in the background (oldest first). */
  transcriptionQueue: number[];
  /** Meeting id currently being transcribed in the background, or null. */
  transcribingId: number | null;
  /** Increments each time a background transcription settles (success OR
   *  failure); paired with `lastSettledId` so the UI can refresh the list and
   *  reload the open note. */
  settledTick: number;
  lastSettledId: number | null;
  /** Id of a meeting auto-deleted because its recording contained no speech;
   *  pair with settledTick. */
  lastDiscardedId: number | null;
  start: () => Promise<void>;
  stop: (templateName?: string, userNotes?: string) => Promise<void>;
  dismissError: () => void;
  dismissRosterSuggestion: () => void;
}

interface QueueJob {
  id: number;
  recordedAt: string;
}

export function useRecording(): UseRecordingReturn {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastMeetingId, setLastMeetingId] = useState<number | null>(null);
  const [rosterSuggestion, setRosterSuggestion] =
    useState<RosterSuggestion | null>(null);

  // Background transcription queue. On stop, a recording is saved as a pending
  // meeting and pushed here; a single-worker drain (concurrency 1, PAUSED while a
  // recording is active) transcribes them via `transcribe_meeting` — decoupling
  // transcription from capture so back-to-back meetings can be recorded.
  const [queue, setQueue] = useState<QueueJob[]>([]);
  const [transcribingId, setTranscribingId] = useState<number | null>(null);
  const [settledTick, setSettledTick] = useState(0);
  const [lastSettledId, setLastSettledId] = useState<number | null>(null);
  const [lastDiscardedId, setLastDiscardedId] = useState<number | null>(null);
  const drainingRef = useRef(false);

  // Rehydrate the queue after a restart. Recovered/local pending recordings
  // resume automatically; cloud transcription remains an explicit user action
  // because it would upload the retained audio off-device.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getConfig(), getMeetings()])
      .then(([config, meetings]) => {
        if (cancelled || config.transcription_base_url.trim()) return;
        const pending = meetings
          .filter((meeting) => meeting.audio_file_path && !meeting.transcript)
          .map((meeting) => ({ id: meeting.id, recordedAt: meeting.recorded_at }));
        setQueue((current) => {
          const known = new Set(current.map((job) => job.id));
          return [...current, ...pending.filter((job) => !known.has(job.id))];
        });
      })
      .catch((error) => {
        console.warn("[recovery] could not restore the local transcription queue:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setRosterSuggestion(null);
    setStatus("recording");
    try {
      await startRecording();
    } catch (e) {
      if (String(e).includes("Already recording")) {
        // A capture is already running (two toggle sources raced) — keep the
        // optimistic "recording" status so the UI matches the backend and
        // Stop still works.
        return;
      }
      setError(String(e));
      setStatus("idle");
    }
  }, []);

  const stop = useCallback(
    async (templateName?: string, userNotes?: string) => {
      setStatus("stopping");
      try {
        const stopped = await stopRecording();
        const audioPath = stopped.system_path;
        // Persist the recording as a pending meeting and enqueue it, then free
        // the UI immediately — the next meeting can be recorded without waiting
        // for transcription. The background worker (below) does the rest.
        const pending = await enqueueRecording(
          audioPath,
          templateName ?? "general",
          userNotes,
        );
        setLastMeetingId(pending.id);
        setQueue((q) => [...q, { id: pending.id, recordedAt: pending.recorded_at }]);
        if (stopped.warning) {
          setError(`${stopped.warning} The encrypted audio was preserved and queued for recovery.`);
        }
        setStatus("idle");
      } catch (e) {
        setError(String(e));
        setStatus("idle");
      }
    },
    [],
  );

  // Background queue worker — transcribe one meeting at a time. PAUSED while a
  // recording is active (`status !== "idle"`) so the new meeting's live captions
  // stay responsive (the ML service has a single transcription model); it drains
  // the moment recording stops / the app is idle.
  useEffect(() => {
    if (status !== "idle") return; // pause while recording / stopping
    if (drainingRef.current || transcribingId !== null) return;
    if (queue.length === 0) return;

    const job = queue[0];
    drainingRef.current = true;
    setTranscribingId(job.id);
    setQueue((q) => q.slice(1));

    transcribeMeeting(job.id)
      .then(async (updated) => {
        if (updated === null) {
          setLastDiscardedId(job.id);
          return;
        }
        // After a successful transcription, surface a calendar roster suggestion
        // (best-effort, non-fatal) — same as the old inline flow, just deferred
        // to when the background job completes.
        try {
          const event: CalendarEvent | null = await calendarEventAt(job.recordedAt);
          if (event && event.attendees.length > 0) {
            const formatted = event.attendees
              .filter((a) => !a.organizer)
              .map((a) =>
                a.name && a.email ? `${a.name} — ${a.email}` : a.email || a.name,
              )
              .filter(Boolean);
            if (formatted.length > 0) {
              setRosterSuggestion({
                eventTitle: event.title || "calendar event",
                provider: event.provider,
                attendees: formatted,
              });
            }
          }
        } catch (e) {
          console.warn("[calendar] roster pre-fill lookup failed (non-fatal):", e);
        }
      })
      .catch((e) => {
        // Transcription failed (e.g. the transcription model isn't on this
        // machine yet). The meeting stays a pending row with its audio kept, so
        // it can be retried — but silence here meant a recording that quietly
        // never became a transcript, with only the console to say why. The
        // message arrives already human from the Rust boundary.
        console.warn(
          `[queue] background transcription failed for meeting ${job.id} (audio kept for retry):`,
          e,
        );
        // Only promise a retry that can actually work. A spool whose index is
        // gone fails the same way forever, and telling the user their recording
        // is safe while offering a doomed button is worse than saying it plainly.
        setError(
          isUnrecoverable(e)
            ? String(e)
            : `${String(e)} The recording is safe on this device — open it and press "Transcribe now" to retry.`,
        );
      })
      .finally(() => {
        setLastSettledId(job.id);
        setSettledTick((n) => n + 1);
        setTranscribingId(null);
        drainingRef.current = false;
      });
  }, [status, queue, transcribingId]);

  const dismissError = useCallback(() => setError(null), []);
  const dismissRosterSuggestion = useCallback(
    () => setRosterSuggestion(null),
    [],
  );

  return {
    status,
    error,
    lastMeetingId,
    rosterSuggestion,
    transcriptionQueue: queue.map((j) => j.id),
    transcribingId,
    settledTick,
    lastSettledId,
    lastDiscardedId,
    start,
    stop,
    dismissError,
    dismissRosterSuggestion,
  };
}
