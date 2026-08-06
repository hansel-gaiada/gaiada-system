import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AssistantDrawer } from "./AssistantDrawer";

// VER-03 — pins the focus-trap fix: before this ticket, nothing stopped Tab/Shift+Tab from walking
// off the panel's last/first focusable element onto the app shell BEHIND the scrim (the sidebar,
// top bar, the underlying page are all still real, focusable DOM outside the panel — `aria-modal`
// alone does nothing for a sighted keyboard-only user's physical Tab key). jsdom has no native
// browser tab-order traversal to test against directly, so these tests exercise the one thing that
// IS this fix's own logic: the explicit boundary-wrap `.focus()` calls in the Tab/Shift+Tab handler.
const back = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ back }) }));

function renderDrawer() {
  return render(
    <AssistantDrawer>
      <button type="button">First</button>
      <button type="button">Second</button>
    </AssistantDrawer>,
  );
}

describe("AssistantDrawer — focus trap", () => {
  it("wraps Tab from the LAST focusable element back to the FIRST (the panel's own Close button)", () => {
    renderDrawer();
    const last = screen.getByRole("button", { name: "Second" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    // Scoped to the DIALOG: the scrim button outside it shares the same "Close assistant" accessible
    // name, and is deliberately NOT part of the trap (see AssistantDrawer.tsx's header) — the panel's
    // OWN close button is the actual first focusable element inside it.
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close assistant" }));
  });

  it("wraps Shift+Tab from the panel's own initial focus back to the LAST focusable element", () => {
    renderDrawer();
    // Mirrors the real mount sequence: the panel itself (tabIndex=-1) holds focus right after open,
    // before a keyboard user has tabbed anywhere inside it yet.
    screen.getByRole("dialog").focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Second" }));
  });

  it("does not hijack Tab presses that are not at a boundary", () => {
    renderDrawer();
    const first = screen.getByRole("button", { name: "First" });
    first.focus();
    const evt = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    const prevented = !document.dispatchEvent(evt);
    // Not a boundary element, so the handler must leave the event alone (real browser tab traversal
    // — untestable in jsdom — is what would move focus next; this only proves this fix didn't
    // swallow the keystroke it has no business touching).
    expect(prevented).toBe(false);
  });

  it("Escape closes the drawer (pre-existing behaviour, unaffected by the trap)", () => {
    renderDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(back).toHaveBeenCalled();
  });

  it("restores focus to the FAB trigger on unmount", () => {
    const fab = document.createElement("button");
    fab.id = "asst-fab-trigger";
    document.body.appendChild(fab);
    const { unmount } = renderDrawer();
    unmount();
    expect(document.activeElement).toBe(fab);
    fab.remove();
  });
});
