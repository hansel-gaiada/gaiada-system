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

  // Gap 2 verification (HISTORIC) — drove the REAL `/pm` page.tsx gates (`page.tsx:85` `canEdit =
  // can(me, "pm.manage", tenant)`, `page.tsx:91` `canPassBall = can(me, BALL_GATE_CAPABILITY,
  // tenant)`) against an actual `team_lead` `Me` fixture, proving the Gap-2 fix reached the page a
  // team-scoped lead landed on. HIER-3 (2026-08-11) RETIRES `team_lead` itself (zero live grants;
  // `docs/superpowers/plans/2026-08-10-hierarchy-consolidation.md`), so the positive case this
  // block pinned no longer has a role to exercise it with — `org_unit_lead`, `team_lead`'s
  // successor (HIER-2), does NOT hold `pm.manage`/`pm.contribute` at all (its bundle is exactly
  // `reports.department.view` + `appraisal.read`; see rbac.ts's `org_unit_lead` entry), so it is
  // not a like-for-like replacement fixture here. The control case (a genuinely unauthorized staff
  // identity gets neither capability) remains valid and is kept.
  describe("the /pm page's own gates deny a genuinely unauthorized identity", () => {
    const tenant = "co-a";
    const unauthorized: Me = {
      userId: "u-hr", name: "HR", email: "hr@x.com", title: null, assurance: "high",
      companies: [{ id: tenant, name: "Company A", type: "agency" }],
      roles: [{ role: "hr_staff", scopeType: "company", scopeId: tenant }],
    };

    it("control: a genuinely unauthorized staff identity (hr_staff) gets neither", () => {
      expect(can(unauthorized, "pm.manage", tenant)).toBe(false);
      expect(can(unauthorized, BALL_GATE_CAPABILITY, tenant)).toBe(false);
    });
  });
});
