import { describe, it, expect } from "vitest";
import { isSwimlane, isView, representativeTag, leadWithUnassigned, PM_SWIMLANES, BALL_GATE_CAPABILITY } from "./page-helpers";
import type { Tag, AxisColumn } from "@/lib/pm";
import { can } from "@/lib/rbac";
import type { Me } from "@/lib/platform";

describe("pm page-helpers", () => {
  it("isSwimlane accepts exactly the three board axes this page mounts", () => {
    expect(isSwimlane("status")).toBe(true);
    expect(isSwimlane("assignee")).toBe(true);
    expect(isSwimlane("priority")).toBe(true);
    // "ball" moved out to its own tab (owner decision 2026-08-09) — it is a PmView now, not a
    // Board swimlane, so a stale `?swimlane=ball` link must degrade rather than crash.
    expect(isSwimlane("ball")).toBe(false);
    // Division/grid swimlanes are deliberately NOT here — they only mean something inside one
    // department (see the page.tsx header note) and stay on the department board.
    expect(isSwimlane("division")).toBe(false);
    expect(isSwimlane("grid-division")).toBe(false);
    expect(isSwimlane(undefined)).toBe(false);
  });

  it("PM_SWIMLANES lists exactly what isSwimlane accepts, in the same order", () => {
    expect(PM_SWIMLANES.map((s) => s.value)).toEqual(["status", "assignee", "priority"]);
    for (const s of PM_SWIMLANES) expect(isSwimlane(s.value)).toBe(true);
  });

  it("isView accepts exactly the five mounted views, including the standalone ball tab", () => {
    expect(isView("board")).toBe(true);
    expect(isView("ball")).toBe(true);
    expect(isView("gantt")).toBe(true);
    expect(isView("charts")).toBe(true);
    expect(isView("productivity")).toBe(true);
    expect(isView("home")).toBe(false);
    expect(isView(undefined)).toBe(false);
  });

  it("representativeTag returns the first registry hit for a label, undefined when no project carries it", () => {
    const registries: Record<string, Tag[]> = {
      "p-1": [{ id: "t1", label: "Urgent", color: "clay" }],
      "p-2": [{ id: "t2", label: "Urgent", color: "slate" }, { id: "t3", label: "Design", color: "moss" }],
    };
    expect(representativeTag("Urgent", registries)?.color).toBe("clay");
    expect(representativeTag("Design", registries)?.color).toBe("moss");
    expect(representativeTag("Nope", registries)).toBeUndefined();
  });

  it("representativeTag on an empty registry map returns undefined", () => {
    expect(representativeTag("Anything", {})).toBeUndefined();
  });

  // P4-A6: `assigneeColumns` (lib/departments.ts) sorts its sentinel column alphabetically and
  // still carries the pre-rename label — this is the render-boundary fix for that, applied without
  // touching that file.
  describe("leadWithUnassigned", () => {
    const col = (key: string, label: string): AxisColumn => ({ key, label, tasks: [] });

    it("floats the sentinel column to the front and relabels it to PM_TERMS.unassigned", () => {
      const cols = [col("u-1", "Ada"), col("u-2", "Ben"), col("__unassigned", "Unassigned")];
      const out = leadWithUnassigned(cols, "__unassigned");
      expect(out.map((c) => c.key)).toEqual(["__unassigned", "u-1", "u-2"]);
      expect(out[0].label).toBe("no user");
      // The rest keep their relative order — only the sentinel moves.
      expect(out.slice(1).map((c) => c.label)).toEqual(["Ada", "Ben"]);
    });

    it("is a no-op when the sentinel is already first and already correctly labelled (ballColumns' own shape)", () => {
      const cols = [col("__no_ball", "no user"), col("u-1", "Ada"), col("u-2", "Ben")];
      expect(leadWithUnassigned(cols, "__no_ball")).toEqual(cols);
    });

    it("returns the columns untouched when the sentinel key is absent (every task assigned)", () => {
      const cols = [col("u-1", "Ada"), col("u-2", "Ben")];
      expect(leadWithUnassigned(cols, "__unassigned")).toEqual(cols);
    });

    it("returns [] untouched for an empty column list", () => {
      expect(leadWithUnassigned([], "__unassigned")).toEqual([]);
    });
  });

  // Gap 2 verification — drives the REAL `/pm` page.tsx gates (`page.tsx:85` `canEdit = can(me,
  // "pm.manage", tenant)`, `page.tsx:91` `canPassBall = can(me, BALL_GATE_CAPABILITY, tenant)`),
  // not a reinvented stand-in, against an actual team_lead `Me` fixture — proving the fix actually
  // reaches the page a team-scoped lead lands on. Before Gap 2, `team_lead` was not a member of
  // `Role` at all, so `ROLE_CAPS[g.role as Role]` looked up `undefined` for it and every capability
  // check below was `false` regardless of scope; a team_lead saw the Board/Gantt read-only note and
  // the Ball tab refusal exactly like a stranger. A genuinely unauthorized identity (`hr_staff`, a
  // real staff tier with no PM grant anywhere in Cerbos) sits right beside it as the control so the
  // pass/fail contrast is the actual proof, not an assumption.
  describe("Gap 2 — the /pm page's own gates now recognize a team_lead identity", () => {
    const tenant = "co-a";
    const teamLead: Me = {
      userId: "u-lead", name: "Lead", email: "lead@x.com", title: null, assurance: "high",
      companies: [{ id: tenant, name: "Company A", type: "agency" }],
      roles: [{ role: "team_lead", scopeType: "company", scopeId: tenant }],
    };
    const unauthorized: Me = {
      userId: "u-hr", name: "HR", email: "hr@x.com", title: null, assurance: "high",
      companies: [{ id: tenant, name: "Company A", type: "agency" }],
      roles: [{ role: "hr_staff", scopeType: "company", scopeId: tenant }],
    };

    it("team_lead: Board/Gantt's canEdit AND the Ball tab's canPassBall both render", () => {
      expect(can(teamLead, "pm.manage", tenant)).toBe(true);   // page.tsx's `canEdit`
      expect(can(teamLead, BALL_GATE_CAPABILITY, tenant)).toBe(true); // page.tsx's `canPassBall`
    });

    it("control: a genuinely unauthorized staff identity (hr_staff) gets neither", () => {
      expect(can(unauthorized, "pm.manage", tenant)).toBe(false);
      expect(can(unauthorized, BALL_GATE_CAPABILITY, tenant)).toBe(false);
    });
  });
});
