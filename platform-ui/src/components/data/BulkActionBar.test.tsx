import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ToastQueueProvider } from "@/components/ToastQueue";
import { BulkActionBar, type BulkAction } from "./BulkActionBar";

function renderBar(actions: BulkAction[], selectedIds = ["1", "2"], onClear = vi.fn()) {
  return render(
    <ToastQueueProvider>
      <BulkActionBar selectedIds={selectedIds} actions={actions} onClear={onClear} itemLabel="client" />
    </ToastQueueProvider>,
  );
}

describe("BulkActionBar", () => {
  it("renders nothing when nothing is selected", () => {
    const { container } = render(
      <ToastQueueProvider>
        <BulkActionBar selectedIds={[]} actions={[]} onClear={() => {}} />
      </ToastQueueProvider>,
    );
    expect(container.querySelector(".bab")).toBeNull();
  });

  it("shows the selection count and runs a non-destructive action immediately", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, succeeded: 2 });
    const onClear = vi.fn();
    renderBar([{ key: "export", label: "Export", run }], ["1", "2"], onClear);
    expect(screen.getByText("2 clients selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(["1", "2"]));
    await waitFor(() => expect(onClear).toHaveBeenCalled());
    expect(await screen.findByText(/Export: done for 2 clients\./)).toBeInTheDocument();
  });

  it("gates a confirm-required action behind the Modal and only runs on Confirm", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, succeeded: 2 });
    renderBar([{ key: "delete", label: "Delete", danger: true, confirmMessage: "Delete 2 clients?", run }]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete 2 clients?");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(["1", "2"]));
  });

  it("reports a non-ok result as an error toast without clearing selection", async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, error: "You don't have permission." });
    const onClear = vi.fn();
    renderBar([{ key: "export", label: "Export", run }], ["1", "2"], onClear);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByText("You don't have permission.")).toBeInTheDocument();
    expect(onClear).not.toHaveBeenCalled();
  });
});
