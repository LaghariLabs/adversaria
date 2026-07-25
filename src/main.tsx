import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { MeetingCard } from "./components/MeetingCard";
import { RecordingBubble } from "./components/RecordingBubble";
// Self-hosted Inter (bundled — no font-CDN runtime call; privacy-first). Matches
// the prototype's typeface. Variable font covers all weights from one file.
import "@fontsource-variable/inter";
import "./index.css";
// Prototype design system (the adversaria-samples look). Class-scoped rules stay
// dormant until a component uses them; only body/header/nav/* are global. Reskin
// components opt into these classes phase by phase. See docs/SPEC_RESKIN.md.
import "./prototype.css";

// Secondary frameless windows are selected by query param:
//  ?card=meeting       → the "Meeting detected" prompt (detector)
//  ?widget=recording   → the floating "Recording" bubble (shown while recording
//                        when the main window is minimized/blurred)
// Everything else is the main app.
const params = new URLSearchParams(window.location.search);
const isCard = params.get("card") === "meeting";
const isRecordingWidget = params.get("widget") === "recording";

// Suppress the browser-style right-click menu in the packaged (release) app so
// it feels like a native app, not a dev webview. In `tauri dev`
// (import.meta.env.DEV) this stays a no-op so right-click → Inspect Element and
// the rest of devtools remain available while developing. (Devtools themselves
// are already off in release — no `devtools` Cargo feature — this just hides the
// default copy/paste/reload menu too.)
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

async function bootstrap() {
  // The WebdriverIO bridge is present only in dedicated E2E builds. Rollup
  // removes this branch from normal production bundles.
  if (import.meta.env.VITE_WDIO === "true") {
    await import("@wdio/tauri-plugin");
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {isCard ? (
        <MeetingCard />
      ) : isRecordingWidget ? (
        <RecordingBubble />
      ) : (
        <App />
      )}
    </React.StrictMode>,
  );
}

void bootstrap();
