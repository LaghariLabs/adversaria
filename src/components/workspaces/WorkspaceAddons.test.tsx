import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceAddon } from "../../types";
import { WorkspaceAddons } from "./WorkspaceAddons";

const researcher: WorkspaceAddon = {
  id: 1,
  kind: "agent",
  slug: "researcher",
  name: "Researcher",
  description: "Investigates first.",
  instructions: "Investigate first.",
  builtin: true,
  created_at: "2026-08-22T10:00:00Z",
};

const deepResearch: WorkspaceAddon = {
  id: 2,
  kind: "skill",
  slug: "deep-research",
  name: "Deep research",
  description: "Research method.",
  instructions: "Show confidence.",
  builtin: true,
  created_at: "2026-08-22T10:00:00Z",
};

const marketingCopy: WorkspaceAddon = {
  id: 3,
  kind: "skill",
  slug: "marketing-copy",
  name: "Marketing copy",
  description: "Write concrete copy.",
  instructions: "Use concrete nouns.",
  builtin: true,
  created_at: "2026-08-22T10:00:00Z",
};

const catalog = [researcher, deepResearch, marketingCopy];

describe("WorkspaceAddons", () => {
  it("renders the built-in agent and skill catalog", async () => {
    mockIPC((command) => {
      if (command === "list_workspace_addons") return catalog;
      return null;
    });

    render(
      <WorkspaceAddons workspaceId={4} attached={[]} onChanged={vi.fn()} />,
    );

    expect(await screen.findByRole("button", { name: "Researcher" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Deep research" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Marketing copy" })).toBeVisible();
  });

  it("attaches a skill when its chip is clicked", async () => {
    let attachPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspace_addons") return catalog;
      if (command === "attach_workspace_addon") {
        attachPayload = payload;
        return [deepResearch];
      }
      return null;
    });
    const user = userEvent.setup();
    render(
      <WorkspaceAddons workspaceId={4} attached={[]} onChanged={vi.fn()} />,
    );

    await user.click(await screen.findByRole("button", { name: "Deep research" }));

    await waitFor(() =>
      expect(attachPayload).toEqual({ workspaceId: 4, addonId: 2 }),
    );
  });

  it("detaches the active agent when its chip is clicked", async () => {
    let detachPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspace_addons") return catalog;
      if (command === "detach_workspace_addon") {
        detachPayload = payload;
        return [];
      }
      return null;
    });
    const user = userEvent.setup();
    render(
      <WorkspaceAddons
        workspaceId={4}
        attached={[researcher]}
        onChanged={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Researcher" }));

    await waitFor(() =>
      expect(detachPayload).toEqual({ workspaceId: 4, addonId: 1 }),
    );
  });

  it("creates and attaches a custom skill", async () => {
    const custom: WorkspaceAddon = {
      id: 9,
      kind: "skill",
      slug: "customer-language",
      name: "Customer language",
      description: "Use customer terms.",
      instructions: "Prefer words customers used in meetings.",
      builtin: false,
      created_at: "2026-08-22T10:00:00Z",
    };
    let createPayload: unknown;
    let attachPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspace_addons") return catalog;
      if (command === "create_workspace_addon") {
        createPayload = payload;
        return custom;
      }
      if (command === "attach_workspace_addon") {
        attachPayload = payload;
        return [custom];
      }
      return null;
    });
    const user = userEvent.setup();
    render(
      <WorkspaceAddons workspaceId={4} attached={[]} onChanged={vi.fn()} />,
    );

    await user.click(await screen.findByRole("button", { name: "Add custom skill…" }));
    await user.type(screen.getByRole("textbox", { name: "Skill name" }), custom.name);
    await user.type(
      screen.getByRole("textbox", { name: "Skill description" }),
      custom.description,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Skill instructions" }),
      custom.instructions,
    );
    await user.click(screen.getByRole("button", { name: "Save & attach" }));

    await waitFor(() =>
      expect(createPayload).toEqual({
        kind: "skill",
        name: custom.name,
        description: custom.description,
        instructions: custom.instructions,
      }),
    );
    await waitFor(() =>
      expect(attachPayload).toEqual({ workspaceId: 4, addonId: 9 }),
    );
  });
});
