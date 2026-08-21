// AGN-4 — the shared typed-refusal surface (plan action item 4).
//
// ⚠ THE COPY IS THE FEATURE, so it is asserted here rather than left to review. The defect this
// closes is not a crash; it is a CONFIDENT WRONG ANSWER — a denied or unreadable read rendered as
// "nothing found". Criterion 5's recorded incident is a portal page telling staff "your kickoff is
// being processed" when the read had been refused. A component that renders a refusal in words the
// reader can mistake for emptiness has not fixed anything, so the "this is NOT a statement that
// there is nothing here" sentence is pinned: shortening it away should fail a test, not pass review.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReadRefusal } from "./ReadRefusal";

describe("AGN-4 · ReadRefusal", () => {
  it("forbidden says plainly that the viewer lacks access, and does NOT hedge about existence", () => {
    render(<ReadRefusal subject="account provisioning" kind="forbidden" />);
    expect(screen.getByText(/don't have access to account provisioning/i)).toBeTruthy();
    // "this may or may not exist" leaks nothing useful and reads as evasion. If someone adds that
    // hedging later, this catches it.
    expect(document.body.textContent).not.toMatch(/may or may not/i);
  });

  it("🔴 unavailable REFUSES to imply emptiness — the sentence that closes criterion 5", () => {
    render(<ReadRefusal subject="The account worklist" kind="unavailable" reason="keycloak unreachable" />);
    const text = document.body.textContent ?? "";
    expect(
      text,
      "the disclaimer is the entire point of this state: without it, 'unavailable' reads as 'empty', " +
        "which is the exact failure (a denied read presented as no-data) that criterion 5 exists for",
    ).toMatch(/not a statement that there is nothing here/i);
    expect(text).toMatch(/cannot tell/i);
  });

  it("shows the backend's own reason, but never as the headline", () => {
    render(<ReadRefusal subject="The worklist" kind="unavailable" reason="keycloak unreachable" />);
    // Present, so an operator can act on it...
    expect(screen.getByText("keycloak unreachable")).toBeTruthy();
    // ...but carried in the quiet class, not the primary copy: a raw upstream string is evidence,
    // not an explanation, and leading with it tells the reader nothing about what to conclude.
    expect(screen.getByText("keycloak unreachable").className).toContain("sys-refusal__reason");
  });

  it("a forbidden refusal never renders an unavailable reason, even if one is passed", () => {
    // Guards against the two states blurring: a denial must not start showing internals, which is
    // both a leak and a different message ("something broke" vs "you may not see this").
    render(<ReadRefusal subject="tasks" kind="forbidden" reason="leaked internal detail" />);
    expect(document.body.textContent).not.toMatch(/leaked internal detail/);
  });

  it("inline mode drops the Card chrome but keeps the wording intact", () => {
    const { container } = render(<ReadRefusal subject="this run's project" kind="forbidden" inline />);
    expect(container.querySelector(".sys-refusal--inline")).toBeTruthy();
    expect(document.body.textContent).toMatch(/don't have access to this run's project/i);
  });

  it("detail is appended for both kinds — it is where a caller's better knowledge goes", () => {
    // The pipeline run page KNOWS the project exists (the run references it), so its copy asserts so.
    render(<ReadRefusal subject="this run's project" kind="forbidden" detail="It exists — ask an admin if you need it." inline />);
    expect(document.body.textContent).toMatch(/It exists — ask an admin/);
  });
});
