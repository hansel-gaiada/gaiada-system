import { describe, it, expect } from "vitest";
import { entityHref } from "./mail";

// APPR-01 — pins `entityHref()`'s staff/portal routing so a future change can't silently regress
// the deep-link fix (the whole point of this ticket: an emailed approval must land ON the item,
// not on the bare list). `mail.ts` is `server-only`, which vitest aliases to an empty module (see
// platform-ui/CLAUDE.md's traps section) — safe here because `entityHref` itself does no I/O.
describe("entityHref", () => {
  it("automation_approval — staff gets the id-bearing detail route, portal gets the bare list (no per-item portal surface exists)", () => {
    expect(entityHref("automation_approval", "appr-1")).toBe("/approvals/appr-1");
    expect(entityHref("automation_approval", "appr-1", { portal: true })).toBe("/portal/approvals");
  });

  it("agency_approval — same shape as automation_approval", () => {
    expect(entityHref("agency_approval", "appr-2")).toBe("/approvals/appr-2");
    expect(entityHref("agency_approval", "appr-2", { portal: true })).toBe("/portal/approvals");
  });

  it("pipeline_run — unchanged by this ticket (already id-bearing on both sides)", () => {
    expect(entityHref("pipeline_run", "run-1")).toBe("/pipeline/run-1");
    expect(entityHref("pipeline_run", "run-1", { portal: true })).toBe("/portal/approvals/run-1");
  });

  // MAIL-33 — `entityId` is the GATE's own id here, and no per-gate detail page exists on either
  // side, so (unlike pipeline_run) this can never be id-bearing without an I/O call this pure
  // function is not allowed to make. Each side's actionable inbox instead — never null, never a
  // broken/guessed id-bearing link.
  it("pipeline_gate — staff gets the internal review inbox, portal gets the sign-off list (no per-gate route exists on either side)", () => {
    expect(entityHref("pipeline_gate", "gate-1")).toBe("/pipeline");
    expect(entityHref("pipeline_gate", "gate-1", { portal: true })).toBe("/portal/approvals");
  });

  it("null entityType/entityId, and an unknown entity type, all return null", () => {
    expect(entityHref(null, "x")).toBeNull();
    expect(entityHref("automation_approval", null)).toBeNull();
    expect(entityHref("something_else", "x")).toBeNull();
  });
});
