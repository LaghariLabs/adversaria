import { useState, useCallback, useEffect, useRef } from "react";
import { getMeetings, getMeeting } from "../lib/tauri";
import type { Meeting } from "../types";

interface UseMeetingsReturn {
  meetings: Meeting[];
  selectedId: number | null;
  selectedMeeting: Meeting | null;
  selectMeeting: (id: number) => Promise<void>;
  clearSelection: () => void;
  refresh: () => Promise<void>;
}

export function useMeetings(): UseMeetingsReturn {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  // Latest-wins guard: two quick selections can resolve out of order, leaving
  // meeting A's content shown while B is selected in the sidebar.
  const latestSelectedRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await getMeetings();
      setMeetings(list);
    } catch {
      // DB may be empty or backend not available — silently handle
    }
  }, []);

  const selectMeeting = useCallback(async (id: number) => {
    latestSelectedRef.current = id;
    setSelectedId(id);
    try {
      const meeting = await getMeeting(id);
      if (latestSelectedRef.current === id) {
        setSelectedMeeting(meeting);
      } // else: a newer selection (or clear) superseded this fetch — drop it
    } catch (e) {
      console.error("Failed to load meeting:", e);
    }
  }, []);

  const clearSelection = useCallback(() => {
    latestSelectedRef.current = null;
    setSelectedId(null);
    setSelectedMeeting(null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Meetings now change WITHOUT the user doing anything: the backend drains
  // pending recordings once the transcription model lands (~60 s cadence), and
  // fills in notes retroactively when an engine is configured. A modest poll
  // plus a refresh on focus keeps the list — and the open note — honest,
  // without an event system.
  const selectedRef = useRef(selectedMeeting);
  selectedRef.current = selectedMeeting;
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      let list: Meeting[];
      try {
        list = await getMeetings();
      } catch {
        return; // offline/DB busy — the next tick tries again
      }
      if (!alive) return;
      setMeetings(list);
      const id = latestSelectedRef.current;
      const current = selectedRef.current;
      if (id === null || !current) return;
      const fresh = list.find((meeting) => meeting.id === id);
      // Only reload the open note when its content actually moved, so a poll
      // can't stomp on what the user is reading or editing.
      if (
        fresh &&
        (fresh.transcript !== current.transcript || fresh.summary !== current.summary)
      ) {
        void selectMeeting(id);
      }
    };
    const onFocus = () => void sync();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(sync, 60_000);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [selectMeeting]);

  return {
    meetings,
    selectedId,
    selectedMeeting,
    selectMeeting,
    clearSelection,
    refresh,
  };
}
