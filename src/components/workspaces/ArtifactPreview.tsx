import { useEffect, useState } from "react";

import { markdownToHtml } from "../../lib/markdown";
import {
  openWorkspaceArtifact,
  readWorkspaceArtifact,
  revealWorkspaceArtifact,
} from "../../lib/tauri";
import type { WorkspaceArtifact } from "../../types";

interface ArtifactPreviewProps {
  artifact: WorkspaceArtifact;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ArtifactPreview({ artifact }: ArtifactPreviewProps) {
  const lowerName = artifact.name.toLowerCase();
  const isDrawio = lowerName.endsWith(".drawio");
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setText("");
    setReadError(null);
    setActionError(null);
    if (isDrawio) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    void readWorkspaceArtifact(artifact.path)
      .then((content) => {
        if (!cancelled) setText(content);
      })
      .catch((error: unknown) => {
        if (!cancelled) setReadError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact, isDrawio]);

  const runAction = async (action: (path: string) => Promise<void>) => {
    if (actionPending) return;
    setActionPending(true);
    setActionError(null);
    try {
      await action(artifact.path);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setActionPending(false);
    }
  };

  if (loading) return <p className="ws-preview-status">Loading…</p>;

  const isMarkdown = lowerName.endsWith(".md") || lowerName.endsWith(".markdown");
  const isPlainText = [".txt", ".json", ".csv", ".yaml", ".yml", ".log"].some(
    (extension) => lowerName.endsWith(extension),
  );

  return (
    <>
      {isDrawio ? (
        <p className="ws-preview-status">Diagram — opens in draw.io</p>
      ) : readError ? (
        <p className="ws-error">{readError}</p>
      ) : isMarkdown ? (
        <article
          className="ws-artifact-preview"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }}
        />
      ) : isPlainText ? (
        <pre className="ws-artifact-preview ws-artifact-preview--plain">{text}</pre>
      ) : (
        <p className="ws-preview-status">No in-app preview for this file type.</p>
      )}
      {actionError && <p className="ws-error">{actionError}</p>}
      <div className="ws-preview-actions">
        <button
          className="btn-secondary"
          type="button"
          disabled={actionPending}
          onClick={() => void runAction(openWorkspaceArtifact)}
        >
          {isDrawio ? "Open in draw.io" : "Open in default app"}
        </button>
        <button
          className="btn-secondary"
          type="button"
          disabled={actionPending}
          onClick={() => void runAction(revealWorkspaceArtifact)}
        >
          Reveal in Finder
        </button>
      </div>
    </>
  );
}
