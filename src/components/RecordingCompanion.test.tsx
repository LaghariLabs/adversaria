import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RecordingCompanion } from "./RecordingCompanion";

vi.mock("../lib/tauri", () => ({
  getAudioLevel: vi.fn().mockResolvedValue(0),
  pickContextFile: vi.fn().mockResolvedValue(null),
}));

const defaultProps = {
  variant: "balanced",
  value: "",
  onChange: vi.fn(),
  status: "idle" as const,
  liveLines: [],
  attachments: [],
  onAddAttachment: vi.fn(),
  onRemoveAttachment: vi.fn(),
  recentMeetings: [],
  onStop: vi.fn(),
  onBrowse: vi.fn(),
};

describe("RecordingCompanion", () => {
  it("renders live transcript lines with speaker classes", () => {
    render(
      <RecordingCompanion
        {...defaultProps}
        liveLines={[
          { text: "I will send the proposal.", source: "me" },
          { text: "I will review it tomorrow.", source: "them" },
        ]}
      />,
    );

    expect(screen.getByText("I will send the proposal.")).toHaveClass("me");
    expect(screen.getByText("I will review it tomorrow.")).toHaveClass("them");
  });

  it("renders the streaming partial after confirmed lines", () => {
    const { container } = render(
      <RecordingCompanion
        {...defaultProps}
        liveLines={[{ text: "We shipped it.", source: "them" }]}
        livePartials={{ me: "and I think we", them: "" }}
      />,
    );

    expect(screen.getByText("and I think we")).toHaveClass("partial", "me");
    expect(
      Array.from(container.querySelectorAll(".companion-feed-line")).map(
        (line) => line.textContent,
      ),
    ).toEqual(["We shipped it.", "and I think we"]);
  });

  it("shows the partial instead of Listening… when nothing is confirmed yet", () => {
    render(
      <RecordingCompanion
        {...defaultProps}
        liveLines={[]}
        livePartials={{ me: "", them: "hello every" }}
      />,
    );

    expect(screen.queryByText("Listening…")).toBeNull();
    expect(screen.getByText("hello every")).toBeInTheDocument();
  });

  it("calls onChange when typing balanced notes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<RecordingCompanion {...defaultProps} onChange={onChange} />);

    await user.type(screen.getByRole("textbox"), "A");

    expect(onChange).toHaveBeenCalledWith("A");
  });

  it("calls onStop and disables the stop button while stopping", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <RecordingCompanion
        {...defaultProps}
        status="recording"
        onStop={onStop}
      />,
    );

    const stopButton = screen.getByRole("button", {
      name: "Stop & summarize",
    });
    await user.click(stopButton);
    expect(onStop).toHaveBeenCalledOnce();

    rerender(
      <RecordingCompanion
        {...defaultProps}
        status="stopping"
        onStop={onStop}
      />,
    );
    expect(stopButton).toBeDisabled();
  });

  it("adds the wide-layout class only to the balanced variant", () => {
    const { container, rerender } = render(
      <RecordingCompanion {...defaultProps} variant="balanced" />,
    );

    expect(container.querySelector(".companion-body")).toHaveClass(
      "balanced-wide",
    );

    rerender(<RecordingCompanion {...defaultProps} variant="transcript" />);
    expect(container.querySelector(".companion-body")).not.toHaveClass(
      "balanced-wide",
    );
  });

  it("renders staged attachments and removes the selected draft", async () => {
    const onRemoveAttachment = vi.fn();
    const user = userEvent.setup();
    render(
      <RecordingCompanion
        {...defaultProps}
        attachments={[
          { kind: "file", value: "/tmp/project-brief.md", label: "Project brief.md" },
        ]}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    expect(screen.getByText("Project brief.md")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Remove Project brief.md" }),
    );

    expect(onRemoveAttachment).toHaveBeenCalledWith(0);
  });

  it("adds a selected recent meeting as staged context", async () => {
    const onAddAttachment = vi.fn();
    const user = userEvent.setup();
    render(
      <RecordingCompanion
        {...defaultProps}
        onAddAttachment={onAddAttachment}
        recentMeetings={[{ id: 42, title: "Northstar kickoff" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "+ Add meeting" }));
    await user.click(screen.getByRole("button", { name: "Northstar kickoff" }));

    expect(onAddAttachment).toHaveBeenCalledWith({
      kind: "meeting",
      value: "42",
      label: "Northstar kickoff",
    });
  });
});
