import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Drawer } from "./Drawer";

describe("Drawer", () => {
  it("renders nothing when closed", () => {
    render(<Drawer open={false} onClose={() => {}} title="Details">Body</Drawer>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders as a labelled dialog when open", () => {
    render(<Drawer open onClose={() => {}} title="Details">Body copy</Drawer>);
    expect(screen.getByRole("dialog", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByText("Body copy")).toBeInTheDocument();
  });

  it("calls onClose on Escape and on scrim click", () => {
    const onClose = vi.fn();
    render(<Drawer open onClose={onClose} title="Details">Body</Drawer>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("refocuses a named trigger element on close", () => {
    document.body.innerHTML = '<button id="my-trigger">Open</button>';
    const trigger = document.getElementById("my-trigger")!;
    const { unmount, rerender } = render(<Drawer open onClose={() => {}} triggerId="my-trigger" label="Panel">Body</Drawer>);
    rerender(<Drawer open={false} onClose={() => {}} triggerId="my-trigger" label="Panel">Body</Drawer>);
    unmount();
    expect(document.activeElement).toBe(trigger);
  });
});
