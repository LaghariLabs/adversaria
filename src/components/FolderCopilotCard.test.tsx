import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FolderCopilotCard } from "./FolderCopilotCard";
import type { Folder } from "../types";

const tauriMocks = vi.hoisted(() => ({
  listFolderSources: vi.fn(),
  addFolderSource: vi.fn(),
  removeFolderSource: vi.fn(),
  refreshFolderProfile: vi.fn(),
  setFolderCopilotFields: vi.fn(),
  setFolderProfile: vi.fn().mockResolvedValue(undefined),
  pickFolderPath: vi.fn(),
  pickContextFile: vi.fn(),
}));

vi.mock("../lib/tauri", () => tauriMocks);

const folder: Folder = {
  id: 4,
  name: "Launch",
  color: "purple",
  instructions: "",
  created_at: "2026-08-17T10:00:00Z",
  updated_at: "2026-08-17T10:00:00Z",
  purpose: "initial purpose",
  profile: "initial profile",
  profile_at: "2026-08-20T12:00:00Z",
  voice_1: "voice one",
  voice_2: "",
};

function source(overrides: Partial<ReturnType<typeof tauriMocks.listFolderSources>> = {}): any {
  return {
    id: 10,
    folder_id: 4,
    path: "/a/b/c/file.md",
    kind: "file" as const,
    added_at: "2026-08-20T10:00:00Z",
    doc_count: 3,
    ...overrides,
  };
}

beforeEach(() => {
  tauriMocks.listFolderSources.mockReset();
  tauriMocks.listFolderSources.mockResolvedValue([]);
  tauriMocks.addFolderSource.mockReset();
  tauriMocks.addFolderSource.mockResolvedValue(source({ id: 11 }));
  tauriMocks.removeFolderSource.mockReset();
  tauriMocks.removeFolderSource.mockResolvedValue(undefined);
  tauriMocks.refreshFolderProfile.mockReset();
  tauriMocks.refreshFolderProfile.mockResolvedValue("refreshed profile");
  tauriMocks.setFolderCopilotFields.mockReset();
  tauriMocks.setFolderCopilotFields.mockResolvedValue(undefined);
  tauriMocks.setFolderProfile.mockReset();
  tauriMocks.setFolderProfile.mockResolvedValue(undefined);
  tauriMocks.pickFolderPath.mockReset();
  tauriMocks.pickFolderPath.mockResolvedValue(null);
  tauriMocks.pickContextFile.mockReset();
  tauriMocks.pickContextFile.mockResolvedValue(null);
});

describe("FolderCopilotCard", () => {
  it("sources list renders rows with N docs", async () => {
    tauriMocks.listFolderSources.mockResolvedValue([
      source({ id: 10, path: "/a/b/file.md", kind: "file", doc_count: 2 }),
      source({ id: 11, path: "/x/y/dir", kind: "dir", doc_count: 5 }),
    ]);
    render(<FolderCopilotCard folder={folder} onFolderUpdated={vi.fn()} />);
    expect(await screen.findByText("2 docs")).toBeVisible();
    expect(screen.getByText("5 docs")).toBeVisible();
    // last two segments displayed
    expect(screen.getByText("b/file.md")).toBeVisible();
    expect(screen.getByText("y/dir")).toBeVisible();
    expect(screen.getByText("📄")).toBeVisible();
    expect(screen.getByText("📁")).toBeVisible();
  });

  it("Add folder calls pickFolderPath then addFolderSource dir then refreshFolderProfile", async () => {
    const user = userEvent.setup();
    tauriMocks.pickFolderPath.mockResolvedValue("/tmp/newdir");
    tauriMocks.addFolderSource.mockResolvedValue(source({ id: 99, path: "/tmp/newdir", kind: "dir", doc_count: 1 }));
    tauriMocks.refreshFolderProfile.mockResolvedValue("new profile from folder");
    render(<FolderCopilotCard folder={folder} onFolderUpdated={vi.fn()} />);
    await waitFor(() => expect(tauriMocks.listFolderSources).toHaveBeenCalledWith(4));
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    await waitFor(() => expect(tauriMocks.pickFolderPath).toHaveBeenCalled());
    await waitFor(() => expect(tauriMocks.addFolderSource).toHaveBeenCalledWith(4, "/tmp/newdir", "dir"));
    await waitFor(() => expect(tauriMocks.refreshFolderProfile).toHaveBeenCalledWith(4));
  });

  it("Add file calls pickContextFile then addFolderSource file", async () => {
    const user = userEvent.setup();
    tauriMocks.pickContextFile.mockResolvedValue(["/tmp/file.md", "file.md"]);
    tauriMocks.addFolderSource.mockResolvedValue(source({ id: 12, path: "/tmp/file.md", kind: "file", doc_count: 1 }));
    tauriMocks.refreshFolderProfile.mockResolvedValue("new profile from file");
    render(<FolderCopilotCard folder={folder} onFolderUpdated={vi.fn()} />);
    await waitFor(() => expect(tauriMocks.listFolderSources).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Add file" }));
    await waitFor(() => expect(tauriMocks.pickContextFile).toHaveBeenCalled());
    await waitFor(() => expect(tauriMocks.addFolderSource).toHaveBeenCalledWith(4, "/tmp/file.md", "file"));
    await waitFor(() => expect(tauriMocks.refreshFolderProfile).toHaveBeenCalledWith(4));
  });

  it("Remove calls removeFolderSource", async () => {
    const user = userEvent.setup();
    tauriMocks.listFolderSources.mockResolvedValue([source({ id: 10, path: "/a/b/file.md", kind: "file", doc_count: 1 })]);
    tauriMocks.refreshFolderProfile.mockResolvedValue("after remove");
    render(<FolderCopilotCard folder={folder} onFolderUpdated={vi.fn()} />);
    expect(await screen.findByText("1 docs")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(tauriMocks.removeFolderSource).toHaveBeenCalledWith(10));
    await waitFor(() => expect(tauriMocks.refreshFolderProfile).toHaveBeenCalledWith(4));
  });

  it("Refresh profile shows returned text and status line", async () => {
    const user = userEvent.setup();
    tauriMocks.refreshFolderProfile.mockResolvedValue("fresh profile text");
    render(<FolderCopilotCard folder={folder} onFolderUpdated={vi.fn()} />);
    // initial profile from folder prop visible
    expect(screen.getByDisplayValue("initial profile")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh profile" }));
    await waitFor(() => expect(tauriMocks.refreshFolderProfile).toHaveBeenCalledWith(4));
    expect(await screen.findByDisplayValue("fresh profile text")).toBeVisible();
    expect(screen.getByText(/Profile refreshed/)).toBeVisible();
  });

  it("blur on Purpose calls setFolderCopilotFields with three fields", async () => {
    const user = userEvent.setup();
    const onFolderUpdated = vi.fn();
    render(<FolderCopilotCard folder={folder} onFolderUpdated={onFolderUpdated} />);
    const purpose = screen.getByLabelText("Purpose");
    await user.clear(purpose);
    await user.type(purpose, "New purpose");
    // blur by clicking elsewhere
    await user.click(screen.getByText("Sources"));
    await waitFor(() =>
      expect(tauriMocks.setFolderCopilotFields).toHaveBeenCalledWith(4, {
        purpose: "New purpose",
        voice_1: "voice one",
        voice_2: "",
      }),
    );
  });

  it("rejected addFolderSource shows message in .settings-msg.err", async () => {
    const user = userEvent.setup();
    tauriMocks.pickFolderPath.mockResolvedValue("/tmp/bad.pdf");
    tauriMocks.addFolderSource.mockRejectedValue(new Error("Only .md and .txt files can be added in this version"));
    render(<FolderCopilotCard folder={folder} onFolderUpdated={vi.fn()} />);
    await waitFor(() => expect(tauriMocks.listFolderSources).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    expect(await screen.findByText("Only .md and .txt files can be added in this version")).toBeVisible();
    expect(document.querySelector(".settings-msg.err")).not.toBeNull();
  });

  it("typing into Profile and clicking Save profile calls setFolderProfile and onFolderUpdated", async () => {
    const user = userEvent.setup();
    const onFolderUpdated = vi.fn();
    render(<FolderCopilotCard folder={folder} onFolderUpdated={onFolderUpdated} />);
    const profile = screen.getByLabelText("Profile");
    await user.clear(profile);
    await user.type(profile, "new typed profile");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(tauriMocks.setFolderProfile).toHaveBeenCalledWith(4, "new typed profile"));
    await waitFor(() => expect(onFolderUpdated).toHaveBeenCalled());
  });

  it("manual profile renders Profile edited by you status", async () => {
    const manualFolder: Folder = { ...folder, profile: "manual text", profile_hash: "manual", profile_at: "2026-08-20T12:00:00Z" };
    render(<FolderCopilotCard folder={manualFolder} onFolderUpdated={vi.fn()} />);
    expect(await screen.findByText(/^Profile edited by you/)).toBeVisible();
  });
});
