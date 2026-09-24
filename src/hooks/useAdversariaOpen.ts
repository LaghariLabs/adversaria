import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { importAdversaria, takePendingOpenFiles } from "../lib/tauri";
import type { ImportReport } from "../types";

function formatToast(report: ImportReport): string {
  return `Imported ${report.imported} meeting(s)${report.folders_created ? " into a new folder" : ""}${report.skipped_existing ? " · " + report.skipped_existing + " already here" : ""}`;
}

export interface UseAdversariaOpenOptions {
  refresh: () => Promise<void> | void;
  refreshFolders: () => Promise<void> | void;
  selectMeeting: (id: number) => void;
  setNotice: (msg: string) => void;
  setView?: (view: string) => void;
  setSelectedFolderId?: (id: number | null) => void;
}

export function useAdversariaOpen(options: UseAdversariaOpenOptions): void {
  const { refresh, refreshFolders, selectMeeting, setNotice, setView, setSelectedFolderId } = options;

  useEffect(() => {
    let cancelled = false;

    const handleReport = async (report: ImportReport | null) => {
      if (!report) return;
      setNotice(formatToast(report));
      await refresh();
      await refreshFolders();
      if (report.meeting_ids.length > 0) {
        setSelectedFolderId?.(null);
        selectMeeting(report.meeting_ids[0]);
        setView?.("meetings");
      }
    };

    takePendingOpenFiles()
      .then(async (paths) => {
        if (cancelled) return;
        for (const p of paths) {
          try {
            const report = await importAdversaria(p);
            if (cancelled) return;
            await handleReport(report);
          } catch (e) {
            if (!cancelled) setNotice(String(e).slice(0, 200));
          }
        }
      })
      .catch(() => {});

    let unlisten: (() => void) | null = null;
    listen<{ paths: string[] }>("open-adversaria-file", async (event) => {
      const paths = event.payload?.paths ?? [];
      for (const p of paths) {
        try {
          const report = await importAdversaria(p);
          await handleReport(report);
        } catch (e) {
          setNotice(String(e).slice(0, 200));
        }
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh, refreshFolders, selectMeeting, setNotice, setView, setSelectedFolderId]);
}

export function formatImportToast(report: ImportReport): string {
  return formatToast(report);
}
