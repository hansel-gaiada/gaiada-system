import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-5 (BFF §32.8): a refused delete must SAY so and stay on the task; it used to redirect as if it had worked.
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const deleteTask = vi.fn();
vi.mock("@/lib/pmActions", () => ({ deleteTask: (...a: unknown[]) => deleteTask(...a) }));

import { DeleteTaskButton } from "./DeleteTaskButton";

describe("DeleteTaskButton", () => {
  beforeEach(() => {
    push.mockReset();
    deleteTask.mockReset();
  });

  it("goes to the project page when the delete succeeds", async () => {
    deleteTask.mockResolvedValue({ ok: true });
    render(<DeleteTaskButton taskId="t1" projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/p1"));
    expect(deleteTask).toHaveBeenCalledWith("t1", "p1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays on the task and shows the platform's reason when the delete is refused", async () => {
    const reason = "This task carries an open request from another department. Decline or deliver the request instead of deleting its task.";
    deleteTask.mockResolvedValue({ ok: false, error: reason });
    render(<DeleteTaskButton taskId="t1" projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("says something even when the refusal carries no words", async () => {
    deleteTask.mockResolvedValue({ ok: false });
    render(<DeleteTaskButton taskId="t1" projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be deleted.");
  });
});
