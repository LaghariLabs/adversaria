import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Floating "Meeting detected" card. Rendered in its own small,
 * frameless, always-on-top webview window (label "notification"). Clicking
 * Record signals the main window to start recording via the existing
 * `tray-toggle-recording` event; Dismiss just closes the card.
 */
export function MeetingCard() {
  const appName =
    new URLSearchParams(window.location.search).get("app") ?? "a meeting";

  useEffect(() => {
    // The window is transparent so the rounded card edges show through.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    // Auto-dismiss after 30s so a missed prompt doesn't linger forever.
    const id = setTimeout(() => {
      void getCurrentWindow().close();
    }, 30_000);
    return () => clearTimeout(id);
  }, []);

  const dismiss = () => {
    void getCurrentWindow().close();
  };

  const record = async () => {
    await emit("tray-toggle-recording");
    await getCurrentWindow().close();
  };

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        padding: "8px",
        userSelect: "none",
        boxSizing: "border-box",
      }}
    >
      <div
        className="modal-box"
        style={{
          width: "100%",
          height: "100%",
          transform: "none",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
          <span
            aria-hidden="true"
            className="record-dot-pulse"
            style={{ marginTop: "4px", flexShrink: 0 }}
          />
          <div style={{ minWidth: 0 }}>
            <p className="modal-title" style={{ marginBottom: "2px" }}>
              Meeting detected
            </p>
            <p
              className="modal-desc"
              style={{
                marginBottom: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {appName} — record it?
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={dismiss} className="btn-popup-action cancel">
            Dismiss
          </button>
          <button onClick={record} className="btn-popup-action confirm">
            Record
          </button>
        </div>
      </div>
    </div>
  );
}
