import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(<Modal open={false} onClose={() => {}} title="Confirm">Body</Modal>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders as a labelled dialog when open", () => {
    render(<Modal open onClose={() => {}} title="Confirm">Body copy</Modal>);
    const dialog = screen.getByRole("dialog", { name: "Confirm" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Body copy")).toBeInTheDocument();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Confirm">Body</Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on scrim click and on the close button", () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Confirm">Body</Modal>);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders an optional footer", () => {
    render(<Modal open onClose={() => {}} title="Confirm" footer={<button type="button">Save</button>}>Body</Modal>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
