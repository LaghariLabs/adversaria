import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopilotConsentBar } from "./CopilotConsentBar";

describe("CopilotConsentBar missing key", () => {
  it("shows persistent line when no key", () => {
    render(<CopilotConsentBar mode="claude" hasClaudeKey={false} onChange={vi.fn()} />);
    expect(screen.getByText("Add an Anthropic API key in Settings › Live Copilot")).toBeInTheDocument();
  });
  it("hides persistent line when key exists", () => {
    render(<CopilotConsentBar mode="claude" hasClaudeKey={true} onChange={vi.fn()} />);
    expect(screen.queryByText("Add an Anthropic API key in Settings › Live Copilot")).not.toBeInTheDocument();
  });
});
