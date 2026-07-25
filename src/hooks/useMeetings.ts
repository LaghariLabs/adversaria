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

  return {
    meetings,
    selectedId,
    selectedMeeting,
    selectMeeting,
    clearSelection,
    refresh,
  };
}
