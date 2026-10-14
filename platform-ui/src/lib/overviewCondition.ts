// The department's condition on its Overview (DW-3k, docs/plans/2026-10-13-department-workspaces.md §5.5 "How the HOD is made
// aware" and "Everyone else", BFF `docs/FRONTEND-BFF-CONTRACT.md` §40), as pure rules: who is shown what, and how a read becomes
// a block. No React and no server imports, so every rule here is a plain unit test.
//
//   - A HEAD of this workspace's unit (`canSwitchToTeam`, DW-3h) sees the condition banner and one tile per KPI, in Me and in Team
//     mode alike (§3.4: "always on top for the HOD").
//   - Anyone else the read admits (staff placed in the department, a company-wide tier on a visit) sees a quiet strip: one line, no
//     tiles, no ranking. Departments are never ranked to their own staff; the comparison is the company Overview's.
//   - Anyone the read REFUSES (a visitor from another department) sees nothing at all: the block is not drawn, and there is no
//     "No access" box on someone else's department.
//   - A read that FAILED for someone who may read says "Unavailable", never "on track".
//
// Nothing here is a security boundary. Who may read a unit's KPIs is the server's rule (§40: the company-wide tiers, a head on the
// unit they lead, staff on their own department); the audience below only decides how much of an answer the person is shown.
//
// The words are `deptKpiFormat.ts`'s, the same module the department KPI page and the company Overview's rows use (DW-3i2), so a
// condition reads the same everywhere.
import type { Me } from "./platform";
import { canSwitchToTeam } from "./overviewTeam";
import { reportPeriodKind } from "./overviewNumbers";
import type { OverviewPeriod } from "./overview";
import type { DeptKpiReadResult } from "./deptKpis";
import {
  bannerSentence, conditionLabel, conditionTone, formatKpiValue, ratioParts, tileFoot,
  type ConditionTone, type DeptKpisView,
} from "./deptKpiFormat";

export type ConditionAudience = "head" | "staff";

/** A head of THIS workspace's unit gets the banner and the tiles; everyone else reads the strip. A mirror of the server. */
export function conditionAudience(
  me: Me,
  tenantId: string | null | undefined,
  subject: { deptId: string | null; unitPath: readonly string[] },
): ConditionAudience {
  return canSwitchToTeam(me, tenantId, subject) ? "head" : "staff";
}

/** The block is for a workspace with a department unit of its own; HR, Finance, IT and the Company frame have none to read. */
export function conditionWidgetPlaced(key: string, subject: { deptId: string | null }): boolean {
  return key !== "condition" || !!subject.deptId;
}

/** The department KPI page for this unit and the Overview's period (the page reads `unit`, `periodKind` and `start`). */
export function conditionHref(deptId: string, period: OverviewPeriod, today: string): string {
  const qs = new URLSearchParams({ unit: deptId, periodKind: reportPeriodKind(period), start: today });
  return `/appraisals/department?${qs.toString()}`;
}

export interface ConditionTileModel {
  key: string;
  label: string;
  value: string;
  conditionText: string;
  tone: ConditionTone;
  condition: string;
  foot: string;
  parts: string | null;
}

export type ConditionView =
  /** Not drawn: the read refused this person, or the department does not exist for them. */
  | { kind: "none" }
  /** The read failed for someone who may read. Never "on track". */
  | { kind: "unavailable"; audience: ConditionAudience }
  | { kind: "banner"; sentence: string; conditionText: string; tone: ConditionTone; condition: string; tiles: ConditionTileModel[]; href: string }
  | { kind: "strip"; sentence: string; conditionText: string; tone: ConditionTone; condition: string };

/** The block's state from the audience and what the reader said. Honest by construction: only an `ok` read draws a condition,
 *  a failure is "Unavailable", and a refusal is nothing. */
export function conditionView(audience: ConditionAudience, result: DeptKpiReadResult<DeptKpisView>, href: string): ConditionView {
  if (result.kind === "forbidden" || result.kind === "not_found") return { kind: "none" };
  if (result.kind === "error") return { kind: "unavailable", audience };
  const view = result.data;
  const base = {
    sentence: bannerSentence(view),
    conditionText: conditionLabel(view.condition),
    tone: conditionTone(view.condition),
    condition: view.condition,
  };
  if (audience === "staff") return { kind: "strip", ...base };
  return {
    kind: "banner",
    ...base,
    href,
    tiles: view.kpis.map((k) => ({
      key: k.key,
      label: k.label,
      value: formatKpiValue(k.value, k.unit),
      conditionText: conditionLabel(k.condition),
      tone: conditionTone(k.condition),
      condition: k.condition,
      foot: tileFoot(k),
      parts: ratioParts(k),
    })),
  };
}
