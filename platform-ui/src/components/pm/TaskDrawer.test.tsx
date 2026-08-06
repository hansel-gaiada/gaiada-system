import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TaskDrawer } from "./TaskDrawer";

// VER-03 follow-up — pins the focus-trap fix on the PM task drawer. This file had Escape and
// focus-on-open but no Tab trap, so Tab/Shift+Tab could walk off the panel's last/first focusable
// element onto the app shell behind the scrim (the sidebar, top bar and task list underneath are all
// real, focusable DOM outside the panel — `aria-modal="true"` only affects a screen reader's browse
// mode, never a sighted keyboard-only user's physical Tab key).
//
// jsdom implements no native browser tab-order traversal, so there is nothing to assert about "where
// Tab would go next". What these tests CAN pin — and the only part that is this fix's own logic — is
// the explicit boundary-wrap `.focus()` calls, plus the negative case proving the handler keeps its
// hands off non-boundary presses. Mirrors assistant/AssistantDrawer.test.tsx by design.
const back = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ back }) }));

function renderDrawer() {
  return render(
    <TaskDrawer>
      <button type="button">First</button>
      <button type="button">Second</button>
    </TaskDrawer>,
  );
}

describe("TaskDrawer — focus trap", () => {
  it("wraps Tab from the LAST focusable element back to the FIRST (the panel's own Close button)", () => {
    renderDrawer();
    screen.getByRole("button", { name: "Second" }).focus();
    fireEvent.keyDown(document, { key: "Tab" });
    // Scoped to the DIALOG on purpose: the scrim button sits OUTSIDE the panel and is deliberately
    // not part of the trap, so an unscoped query could match it instead of the panel's own control.
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Close task detail" }),
    );
  });

  it("wraps Shift+Tab from the panel's own initial focus back to the LAST focusable element", () => {
    renderDrawer();
    // Mirrors the real mount sequence: the panel itself (tabIndex=-1) holds focus immediately after
    // open, before the user has tabbed anywhere inside it.
    screen.getByRole("dialog").focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Second" }));
  });

  it("does not hijack Tab presses that are not at a boundary", () => {
    renderDrawer();
    screen.getByRole("button", { name: "First" }).focus();
    const evt = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    const prevented = !document.dispatchEvent(evt);
    // Real tab traversal (untestable in jsdom) is what should move focus here; this only proves the
    // trap did not swallow a keystroke it has no business touching.
    expect(prevented).toBe(false);
  });

  it("Escape still closes the drawer (pre-existing behaviour, unaffected by the trap)", () => {
    renderDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(back).toHaveBeenCalled();
  });
});
