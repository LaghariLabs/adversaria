import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { createNote } from "../lib/tauri";
import { Plus } from "lucide-react";

interface NewNoteButtonProps {
  onCreated: (id: number) => void;
}

/** Starter scaffolds so a new note isn't a blank page. Picking one pre-fills
 *  the title + body; "Blank" keeps it empty. */
const NOTE_TEMPLATES: { key: string; label: string; title: string; body: string }[] = [
  { key: "blank", label: "Blank", title: "", body: "" },
  {
    key: "prep",
    label: "Meeting prep",
    title: "Prep — ",
    body: "## Goal\n\n\n## Questions to ask\n- \n\n## Context / background\n- \n\n## Desired outcome\n",
  },
  {
    key: "standup",
    label: "Daily standup",
    title: "Standup — ",
    body: "## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- \n",
  },
  {
    key: "idea",
    label: "Idea dump",
    title: "Idea — ",
    body: "## The idea\n\n\n## Why it matters\n\n\n## Next steps\n- \n",
  },
];

export function NewNoteButton({ onCreated }: NewNoteButtonProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  // Quick capture: the global Cmd/Ctrl+Shift+N hotkey opens this modal from
  // anywhere (Rust focuses the window and emits the event).
  useEffect(() => {
    const unlisten = listen("hotkey-new-note", () => setOpen(true));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const applyTemplate = (key: string) => {
    const t = NOTE_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    setTitle(t.title);
    setBody(t.body);
  };

  const save = async () => {
    setSaving(true);
    try {
      const note = await createNote(title.trim() || "Untitled note", body);
      setOpen(false);
      setTitle("");
      setBody("");
      onCreated(note.id);
    } catch (e) {
      console.error("Failed to create note:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="action-box">
        <button className="btn-secondary" onClick={() => setOpen(true)}>
          <Plus size={14} aria-hidden="true" />
          New Standalone Note
        </button>
      </div>
      {open && (
        <div
          className="modal-overlay open"
          onClick={() => setOpen(false)}
        >
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">New note</h3>
            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              {NOTE_TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className="btn-add-tag-pill"
                  onClick={() => applyTemplate(t.key)}
                  title={`Start from the ${t.label.toLowerCase()} template`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              className="modal-input"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your note… (Markdown supported). Tip: after saving, use “Structure with AI” to turn it into organized notes + to-dos."
              dir="auto"
              className="notes-textarea"
            />
            <div className="modal-actions">
              <button
                onClick={() => setOpen(false)}
                className="btn-modal cancel"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="btn-modal confirm"
              >
                {saving ? "Saving…" : "Save note"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
