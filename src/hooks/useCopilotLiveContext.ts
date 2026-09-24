import { useEffect, useRef } from "react";
import { copilotSetLiveContext } from "../lib/tauri";
import type { AttachmentDraft, CopilotLiveContext } from "../types";

export interface UseCopilotLiveContextOptions {
  status: string;
  copilotSessionId: string | null;
  recordingFolderId: number | null;
  userNotes: string;
  pendingAttachments: AttachmentDraft[];
}

/**
 * While recording, pushes live context (folder, notes, attachments) to the
 * copilot backend debounced by 1s. Also fires once immediately on recording start.
 * Requires an active session_id; does not push until one exists.
 * A delayed timer from session A is cancelled on id change so A's notes never send under B.
 */
export function useCopilotLiveContext(options: UseCopilotLiveContextOptions): void {
  const { status, copilotSessionId, recordingFolderId, userNotes, pendingAttachments } = options;
  const prevStatusRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "recording" || !copilotSessionId || copilotSessionId.trim() === "") {
      prevStatusRef.current = status;
      prevSessionIdRef.current = copilotSessionId;
      return;
    }

    const isStart = prevStatusRef.current !== "recording" || prevSessionIdRef.current !== copilotSessionId;
    prevStatusRef.current = status;
    prevSessionIdRef.current = copilotSessionId;

    const sessionIdSnapshot = copilotSessionId;

    const context: CopilotLiveContext = {
      folder_id: recordingFolderId,
      notes: userNotes,
      attachments: pendingAttachments,
    };

    const push = () => {
      copilotSetLiveContext(sessionIdSnapshot, context).catch((e: unknown) => {
        console.warn("[copilot] live context:", e);
      });
    };

    if (isStart) {
      push();
    }

    const id = setTimeout(push, 1000);
    return () => clearTimeout(id);
  }, [status, copilotSessionId, recordingFolderId, userNotes, pendingAttachments]);
}
