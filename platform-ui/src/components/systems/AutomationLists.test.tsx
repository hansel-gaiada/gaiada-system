import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { WorkflowsTable, ExecutionsTable } from "./AutomationLists";

describe("WorkflowsTable", () => {
  afterEach(() => vi.useRealTimers());

  it("paginates 40 workflows at 30/page and searches by name/state", async () => {
    vi.useFakeTimers();
    const workflows = Array.from({ length: 40 }, (_, i) => ({
      id: `wf-${i + 1}`,
      name: i === 0 ? "Nightly report" : `Workflow ${i + 1}`,
      active: i % 2 === 0,
    }));
    const toggleWorkflow = vi.fn(async () => ({ ok: true }));

    render(
      <WorkflowsTable
        workflows={workflows}
        lastRunByWorkflowId={new Map()}
        elevated={false}
        toggleWorkflow={toggleWorkflow}
      />,
    );

    expect(screen.getByText("1–30 of 40")).toBeInTheDocument();
    expect(screen.queryByText("Workflow 31")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search workflows" }), {
      target: { value: "Nightly" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText("Nightly report")).toBeInTheDocument();
    expect(screen.queryByText("Workflow 2")).not.toBeInTheDocument();
  });

  it("shows the Activate/Deactivate action column only when elevated", () => {
    render(
      <WorkflowsTable
        workflows={[{ id: "wf-1", name: "Report", active: true }]}
        lastRunByWorkflowId={new Map()}
        elevated
        toggleWorkflow={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("renders the empty state when there are no workflows", () => {
    render(
      <WorkflowsTable
        workflows={[]}
        lastRunByWorkflowId={new Map()}
        elevated={false}
        toggleWorkflow={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.getByText(/n8n Public-API key/)).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("ExecutionsTable", () => {
  afterEach(() => vi.useRealTimers());

  it("paginates 55 executions at 30/page and searches by workflow/status", async () => {
    vi.useFakeTimers();
    const executions = Array.from({ length: 55 }, (_, i) => ({
      id: `ex-${i + 1}`,
      workflowName: i === 0 ? "Special Run" : `WF ${i + 1}`,
      status: "success",
    }));

    render(<ExecutionsTable executions={executions} />);

    expect(screen.getByText("1–30 of 55")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("31–55 of 55")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search executions" }), {
      target: { value: "Special" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("Special Run")).toBeInTheDocument();
    expect(screen.queryByText("WF 2")).not.toBeInTheDocument();
  });
});
