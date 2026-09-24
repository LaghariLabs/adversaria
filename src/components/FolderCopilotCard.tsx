import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "../lib/dateFormat";
import {
  addFolderSource,
  listFolderSources,
  pickContextFile,
  pickFolderPath,
  refreshFolderProfile,
  removeFolderSource,
  setFolderCopilotFields,
  setFolderProfile,
} from "../lib/tauri";
import type { Folder, FolderSource } from "../types";

interface FolderCopilotCardProps {
  folder: Folder;
  onFolderUpdated: () => void;
}

function lastTwoSegments(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

export function FolderCopilotCard({ folder, onFolderUpdated }: FolderCopilotCardProps): JSX.Element {
  const [purposeDraft, setPurposeDraft] = useState(folder.purpose ?? "");
  const [voice1Draft, setVoice1Draft] = useState(folder.voice_1 ?? "");
  const [voice2Draft, setVoice2Draft] = useState(folder.voice_2 ?? "");
  const [profileText, setProfileText] = useState(folder.profile ?? "");
  const [profileAt, setProfileAt] = useState(folder.profile_at ?? "");
  const [sources, setSources] = useState<FolderSource[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [refreshingProfile, setRefreshingProfile] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setPurposeDraft(folder.purpose ?? "");
    setVoice1Draft(folder.voice_1 ?? "");
    setVoice2Draft(folder.voice_2 ?? "");
    setProfileText(folder.profile ?? "");
    setProfileAt(folder.profile_at ?? "");
  }, [folder.id, folder.purpose, folder.voice_1, folder.voice_2, folder.profile, folder.profile_at]);

  const loadSources = useCallback(async () => {
    try {
      const list = await listFolderSources(folder.id);
      setSources(list);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSourcesError(msg.replace(/^Error:\s*/, ""));
    }
  }, [folder.id]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const handleSaveCopilotFields = useCallback(async () => {
    try {
      await setFolderCopilotFields(folder.id, { purpose: purposeDraft, voice_1: voice1Draft, voice_2: voice2Draft });
      onFolderUpdated();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSourcesError(msg.replace(/^Error:\s*/, ""));
    }
  }, [folder.id, purposeDraft, voice1Draft, voice2Draft, onFolderUpdated]);

  const doRefreshProfile = useCallback(async () => {
    setRefreshingProfile(true);
    try {
      const text = await refreshFolderProfile(folder.id);
      setProfileText(text);
      try {
        const now = new Date().toISOString();
        setProfileAt(now);
      } catch {}
      onFolderUpdated();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSourcesError(msg.replace(/^Error:\s*/, ""));
    } finally {
      setRefreshingProfile(false);
    }
  }, [folder.id, onFolderUpdated]);

  const doSaveProfile = useCallback(async () => {
    setSavingProfile(true);
    try {
      await setFolderProfile(folder.id, profileText);
      try {
        const now = new Date().toISOString();
        setProfileAt(now);
      } catch {}
      onFolderUpdated();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSourcesError(msg.replace(/^Error:\s*/, ""));
    } finally {
      setSavingProfile(false);
    }
  }, [folder.id, profileText, onFolderUpdated]);

  const handleAddFile = useCallback(async () => {
    setSourcesError(null);
    try {
      const picked = await pickContextFile();
      if (!picked) return;
      const [filePath] = picked;
      await addFolderSource(folder.id, filePath, "file");
      await loadSources();
      if (folder.profile_hash !== "manual") await doRefreshProfile();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSourcesError(msg.replace(/^Error:\s*/, ""));
    }
  }, [folder.id, folder.profile_hash, loadSources, doRefreshProfile]);

  const handleAddFolder = useCallback(async () => {
    setSourcesError(null);
    try {
      const dirPath = await pickFolderPath();
      if (!dirPath) return;
      await addFolderSource(folder.id, dirPath, "dir");
      await loadSources();
      if (folder.profile_hash !== "manual") await doRefreshProfile();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSourcesError(msg.replace(/^Error:\s*/, ""));
    }
  }, [folder.id, folder.profile_hash, loadSources, doRefreshProfile]);

  const handleRemoveSource = useCallback(async (sourceId: number) => {
    setSourcesError(null);
    try {
      await removeFolderSource(sourceId);
      await loadSources();
      if (folder.profile_hash !== "manual") await doRefreshProfile();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSourcesError(msg.replace(/^Error:\s*/, ""));
    }
  }, [folder.profile_hash, loadSources, doRefreshProfile]);

  return (
    <div className="folder-card folder-copilot-card">
      <div className="folder-copilot-cap">Copilot sources and voice</div>
      <div className="folder-copilot-field-wrap">
        <label className="folder-copilot-label">Purpose</label>
        <input
          aria-label="Purpose"
          value={purposeDraft}
          onChange={(e) => setPurposeDraft(e.target.value)}
          onBlur={() => void handleSaveCopilotFields()}
          placeholder="Technical interviews for Lead AI/ML roles; I am the candidate"
          className="folder-copilot-field"
        />
      </div>

      <div className="folder-copilot-field-wrap">
        <div className="folder-copilot-label">Sources</div>
        {sources.length > 0 ? (
          <div className="folder-copilot-sources">
            {sources.map((s) => (
              <div key={s.id} className="folder-copilot-source">
                <span aria-hidden="true">{s.kind === "dir" ? "📁" : "📄"}</span>
                <span className="folder-copilot-source-path">{lastTwoSegments(s.path)}</span>
                <span className="folder-copilot-status">{s.doc_count} docs</span>
                <button
                  type="button"
                  className="btn-secondary folder-copilot-btn--sm"
                  onClick={() => void handleRemoveSource(s.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="folder-copilot-empty">No sources yet.</div>
        )}
        <div className="folder-copilot-actions">
          <button type="button" className="btn-secondary folder-copilot-btn" onClick={() => void handleAddFile()}>
            Add file
          </button>
          <button type="button" className="btn-secondary folder-copilot-btn" onClick={() => void handleAddFolder()}>
            Add folder
          </button>
        </div>
        {sourcesError && (
          <p className="settings-msg err">{sourcesError}</p>
        )}
      </div>

      <div className="folder-copilot-field-wrap">
        <div className="folder-copilot-label">Profile</div>
        <textarea
          aria-label="Profile"
          value={profileText}
          onChange={(e) => setProfileText(e.target.value)}
          rows={6}
          maxLength={1200}
          className="folder-copilot-field folder-copilot-field--multiline"
        />
        <div className="folder-copilot-actions folder-copilot-actions--spaced">
          <button
            type="button"
            className="btn-secondary folder-copilot-btn"
            disabled={savingProfile}
            onClick={() => void doSaveProfile()}
          >
            {savingProfile ? "Saving…" : "Save profile"}
          </button>
          <button
            type="button"
            className="btn-secondary folder-copilot-btn"
            disabled={refreshingProfile}
            onClick={() => void doRefreshProfile()}
          >
            {refreshingProfile ? "Refreshing…" : "Refresh profile"}
          </button>
          <span className="folder-copilot-status">
            {folder.profile_hash === "manual" && profileAt
              ? `Profile edited by you ${formatDateTime(profileAt)}`
              : profileText.trim() !== "" && profileAt
                ? `Profile refreshed ${formatDateTime(profileAt)}`
                : "No profile yet. Add sources, then refresh."}
          </span>
        </div>
      </div>

      <div className="folder-copilot-voices">
        <div>
          <label className="folder-copilot-label">Voice sample 1</label>
          <textarea
            aria-label="Voice sample 1"
            value={voice1Draft}
            onChange={(e) => setVoice1Draft(e.target.value)}
            onBlur={() => void handleSaveCopilotFields()}
            rows={3}
            maxLength={600}
            placeholder="Paste one of your own spoken answers. Style only, never used as facts."
            className="folder-copilot-field folder-copilot-field--multiline"
          />
        </div>
        <div>
          <label className="folder-copilot-label">Voice sample 2</label>
          <textarea
            aria-label="Voice sample 2"
            value={voice2Draft}
            onChange={(e) => setVoice2Draft(e.target.value)}
            onBlur={() => void handleSaveCopilotFields()}
            rows={3}
            maxLength={600}
            placeholder="Paste one of your own spoken answers. Style only, never used as facts."
            className="folder-copilot-field folder-copilot-field--multiline"
          />
        </div>
      </div>
    </div>
  );
}
