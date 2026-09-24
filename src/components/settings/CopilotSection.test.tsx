import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  setCopilotApiKey: vi.fn().mockResolvedValue(undefined),
  clearCopilotApiKey: vi.fn().mockResolvedValue(undefined),
  hasCopilotApiKey: vi.fn().mockResolvedValue(false),
  setDeepSeekCopilotApiKey: vi.fn().mockResolvedValue(undefined),
  clearDeepSeekCopilotApiKey: vi.fn().mockResolvedValue(undefined),
  hasDeepSeekCopilotApiKey: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../lib/tauri", () => mocks);

import { CopilotSection } from "./CopilotSection";

describe("CopilotSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasCopilotApiKey.mockResolvedValue(false);
    mocks.hasDeepSeekCopilotApiKey.mockResolvedValue(false);
  });
  it("Save calls setCopilotApiKey and clears input", async () => {
    mocks.hasCopilotApiKey.mockResolvedValue(false);
    render(<CopilotSection active={true} />);
    await screen.findByText("No key saved");
    const input = screen.getByLabelText("Anthropic API key") as HTMLInputElement;
    await userEvent.setup().type(input, "sk-ant-123");
    await userEvent.setup().click(screen.getByRole("button", { name: "Save key" }));
    expect(mocks.setCopilotApiKey).toHaveBeenCalledWith("sk-ant-123");
  });
  it("Remove calls clearCopilotApiKey", async () => {
    mocks.hasCopilotApiKey.mockResolvedValue(true);
    render(<CopilotSection active={true} />);
    await screen.findByText("Key saved in your keychain");
    await userEvent.setup().click(screen.getByRole("button", { name: "Remove key" }));
    expect(mocks.clearCopilotApiKey).toHaveBeenCalled();
  });
  it("status flips to Key saved when key exists", async () => {
    mocks.hasCopilotApiKey.mockResolvedValue(true);
    render(<CopilotSection active={true} />);
    expect(await screen.findByText("Key saved in your keychain")).toBeInTheDocument();
  });
  it("saves the DeepSeek key separately", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<CopilotSection active={true} />);
    await screen.findByText("No DeepSeek key saved");
    const input = screen.getByLabelText("DeepSeek API key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "[REDACTED]" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Save DeepSeek key" }));
    expect(mocks.setDeepSeekCopilotApiKey).toHaveBeenCalledWith("[REDACTED]");
  });
  it("changing DeepSeek model calls update with pro", async () => {
    const update = vi.fn();
    const config = {
      copilot_deepseek_model: "deepseek-v4-flash" as const,
    } as unknown as import("../../types").AppConfig;
    render(<CopilotSection active={true} config={config} update={update} />);
    const select = screen.getByLabelText("DeepSeek model") as HTMLSelectElement;
    expect(select.value).toBe("deepseek-v4-flash");
    await userEvent.setup().selectOptions(select, "deepseek-v4-pro");
    expect(update).toHaveBeenCalledWith({ copilot_deepseek_model: "deepseek-v4-pro" });
  });
});
