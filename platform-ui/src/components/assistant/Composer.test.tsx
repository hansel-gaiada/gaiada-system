import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Composer } from "./Composer";
import { refreshCapabilitiesAction } from "@/lib/assistantActions";

// T4 (ASST-23, §7.4) — before this ticket NOTHING in the UI could send `mode:'tools'` at all (the
// design doc's own finding, cited in ASST-23 §1.4). This pins the composer's new affordance.
vi.mock("@/lib/assistantActions", () => ({
  refreshCapabilitiesAction: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(refreshCapabilitiesAction).mockReset();
  vi.mocked(refreshCapabilitiesAction).mockResolvedValue({
    ok: true, tools: [], hubConfigured: true,
    toolAgents: [
      { name: "status-reporter", tools: ["projects.list"], writeTools: [] },
      { name: "task-filer", tools: ["projects.list", "pm.createTask"], writeTools: ["pm.createTask"] },
    ],
  });
});

describe("Composer — tools-mode affordance", () => {
  it("a plain send passes {mode:'chat'} and no agent, byte-identical in spirit to the pre-T4 default", async () => {
    const onSend = vi.fn();
    render(<Composer canSend streaming={false} onSend={onSend} onStop={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message the assistant"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("hello", { mode: "chat" });
  });

  it("toggling 'Use tools' reveals the agent picker, sourced from GET capabilities' toolAgents", async () => {
    render(<Composer canSend streaming={false} onSend={() => {}} onStop={() => {}} />);
    await waitFor(() => expect(refreshCapabilitiesAction).toHaveBeenCalled());
    expect(screen.queryByLabelText("Tool agent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Use tools" }));
    await waitFor(() => expect(screen.getByLabelText("Tool agent")).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "task-filer (can propose writes)" })).toBeInTheDocument();
  });

  it("sending in tools mode passes {mode:'tools', agent} with the SELECTED agent", async () => {
    const onSend = vi.fn();
    render(<Composer canSend streaming={false} onSend={onSend} onStop={() => {}} />);
    await waitFor(() => expect(refreshCapabilitiesAction).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("checkbox", { name: "Use tools" }));
    await waitFor(() => expect(screen.getByLabelText("Tool agent")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Tool agent"), { target: { value: "task-filer" } });
    fireEvent.change(screen.getByLabelText("Message the assistant"), { target: { value: "file a task" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("file a task", { mode: "tools", agent: "task-filer" });
  });
});

// 2026-08-07 — the empty state's suggestion tiles fill the box through `prefill`, never sending on
// the user's behalf (see this prop's own header). This pins that the text lands in the box and that
// the user still has to press Send themselves.
describe("Composer — empty-state suggestion prefill", () => {
  it("a prefill fills the box but does NOT send", () => {
    const onSend = vi.fn();
    render(<Composer canSend streaming={false} onSend={onSend} onStop={() => {}} prefill={{ text: "What's the status of my active projects right now?", seq: 1 }} />);
    expect(screen.getByLabelText("Message the assistant")).toHaveValue("What's the status of my active projects right now?");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("pressing Send after a prefill sends exactly that text", () => {
    const onSend = vi.fn();
    render(<Composer canSend streaming={false} onSend={onSend} onStop={() => {}} prefill={{ text: "Draft a task for my team about ", seq: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("Draft a task for my team about", { mode: "chat" });
  });

  it("a SECOND prefill with a new seq overwrites the box even if the text is identical", () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer canSend streaming={false} onSend={onSend} onStop={() => {}} prefill={{ text: "same text", seq: 1 }} />);
    fireEvent.change(screen.getByLabelText("Message the assistant"), { target: { value: "something the user typed" } });
    rerender(<Composer canSend streaming={false} onSend={onSend} onStop={() => {}} prefill={{ text: "same text", seq: 2 }} />);
    expect(screen.getByLabelText("Message the assistant")).toHaveValue("same text");
  });
});
