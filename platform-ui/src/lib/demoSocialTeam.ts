// SCP-5d (BFF §63.19) — the DEMO_MODE answer of `GET team?month=YYYY-MM`, the Social Media Team dashboard. Built from the pipeline demo store
// (`demoSocialPipeline.ts`: three INVENTED clients, their cycles and a month of posts), so what the dashboard says matches the Clients, the cycles table and the
// post pages in the same demo. No real client or person. Health is the store's FIXED mock values, as everywhere in the demo (the server's maths is platform-nest's).
//
// Who: the four approvers only (the HoD `u-pm`, the GM `u-gm`, the owner and the superadmin); anyone else gets 403 `not_a_social_approver`, the server's order
// (the check before the month's validation).
//
// Per-person rows (BFF §63.19): a person in the Social Media unit is shown to all four; a person outside it (the Creatives designer, the GM's own row) is shown
// to the owner and the superadmin (the company-wide tiers), and to that person themselves, and is left out for the HoD and the GM, with `personRowsLimited: true`.
//
// The report rows (`report_due`, `report_to_check`) are invented from the allocations' report day: the demo has no reports store for the dashboard to read yet.
import "server-only";
import { todayIsoInDisplayZone } from "./format";
import { scpHolderOf } from "./scpStageMachine";
import {
  COPYWRITER, CREATIVES_DESIGNER, DEMO_MEMBER_NAMES, IN_TEAM_DESIGNER, PIPE_ENGAGEMENTS, PIPE_POSTS, SEAT_APPROVERS, allocStore, demoCycleTable, demoPostHealth,
  isDemoSocialApprover, type DemoResult, type PipePost,
} from "./demoSocialPipeline";

const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });

/** The people outside the Social Media unit, whose rows only the company-wide tiers (and the person) read. */
const OUTSIDE_UNIT: readonly string[] = [CREATIVES_DESIGNER, "u-gm"];
const COMPANY_WIDE: readonly string[] = ["demo-owner", "demo-hansel"];
const nameOf = (id: string): string => DEMO_MEMBER_NAMES[id] ?? "A colleague";

type Role = "officer" | "copywriter" | "approver" | "designer" | "client" | "external";
const TRACKED = ["planned", "drafting", "proofread", "hod", "design", "final", "client", "approved", "scheduled", "changes", "blocked"];

const holderRoleOf = (p: PipePost): Role | null => {
  const r = scpHolderOf({ pipelineStatus: p.pipelineStatus, changeCase: p.changeCase, scheduleVia: p.scheduleVia, blockWaitingOn: p.blockWaitingOn, creativeState: p.creativeState });
  if (r === null) return null;
  return r === "publisher" ? "external" : (r as Role);
};
/** The people who hold a post in a role, the way the pipeline read names them. */
const holdersOf = (p: PipePost, role: Role): string[] => {
  const officer = allocStore.byEngagement[p.engagementId]?.officerId ?? null;
  if (role === "officer") return officer ? [officer] : [];
  if (role === "copywriter") return [COPYWRITER];
  if (role === "designer") return [p.creativeSource === "in_team" ? IN_TEAM_DESIGNER : CREATIVES_DESIGNER];
  if (role === "approver") return [...SEAT_APPROVERS.filter((u) => u !== "demo-hansel")];
  return [];
};
const ROLE_LABEL: Record<string, string> = { officer: "Officer", copywriter: "Copywriter", approver: "Approvers", designer: "Designer", client: "Client", external: "Outside party" };

const dayOf = (iso: string): string => iso.slice(0, 10);
const olderOf = (a: string | null, b: string): string => (a === null || b < a ? b : a);
/** Calendar days to working days, roughly (the demo has no holiday data; the server counts real working days). */
const workingDaysBetween = (from: string, to: string): number => {
  const days = Math.max(0, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  return Math.round(days * (5 / 7) * 10) / 10;
};

export interface DemoTeamOptions {
  /** A part the server could not work out (tests use it to prove the page names it as unknown). */
  partial?: string[];
}

export function demoTeamDashboard(month: string, userId: string, opts: DemoTeamOptions = {}): Record<string, unknown> {
  const today = todayIsoInDisplayZone();
  const cycleTable = demoCycleTable(month, userId) as { rows: Array<Record<string, unknown>> };
  const posts = PIPE_POSTS.filter((p) => p.cycleMonth === month && !p.archivedAt);

  // ── clients: the cycles table's rows, narrowed to what the dashboard names ──
  const clients = cycleTable.rows.map((r) => {
    const counts = r.counts as Record<string, number>;
    return {
      engagementId: r.engagementId, clientName: r.clientName, officer: r.officer, target: r.target, counted: counts.counted, approved: counts.approved,
      live: counts.live, extra: counts.extra, stories: counts.stories, health: r.health,
    };
  });

  // ── needs attention ──
  const needsAttention: Array<Record<string, unknown>> = [];
  const holderOf = (p: PipePost) => {
    const role = holderRoleOf(p);
    if (role === null) return undefined;
    const ids = holdersOf(p, role);
    return { role, label: ids.length === 1 ? nameOf(ids[0]) : ROLE_LABEL[role] };
  };
  for (const p of posts) {
    const h = demoPostHealth(p);
    const base = { postId: p.id, engagementId: p.engagementId, clientName: PIPE_ENGAGEMENTS.find((e) => e.id === p.engagementId)?.clientName ?? "", title: p.title, since: dayOf(p.statusSince), holder: holderOf(p) };
    if (h.state === "late") needsAttention.push({ kind: "late", ...base });
    else if (h.state === "at_risk") needsAttention.push({ kind: "at_risk", ...base });
    if (p.pipelineStatus === "blocked") needsAttention.push({ kind: "blocked", ...base });
    if (p.pipelineStatus === "live" && p.metrics && p.metrics.reach >= 2000) needsAttention.push({ kind: "boost_waiting", boostId: `boost-demo-${p.id}`, ...base });
  }
  if (month <= today.slice(0, 7)) {
    const engs = PIPE_ENGAGEMENTS.filter((e) => e.status !== "closed");
    if (engs[1]) needsAttention.push({ kind: "report_due", reportId: `rep-demo-${engs[1].id}-${month}`, engagementId: engs[1].id, clientName: engs[1].clientName, since: `${month}-05`, holder: { role: "officer", label: nameOf(allocStore.byEngagement[engs[1].id]?.officerId ?? "") } });
    if (engs[2]) needsAttention.push({ kind: "report_to_check", reportId: `rep-demo-${engs[2].id}-${month}`, engagementId: engs[2].id, clientName: engs[2].clientName, since: `${month}-07`, holder: { role: "approver", label: "Approvers" } });
  }

  // ── who holds what (the post's holder, never the officer for time with someone else) ──
  const held = posts.filter((p) => TRACKED.includes(p.pipelineStatus) && holderRoleOf(p) !== null);
  const visible = (id: string): boolean => !OUTSIDE_UNIT.includes(id) || COMPANY_WIDE.includes(userId) || id === userId;
  let limited = false;
  const keep = <T extends { userId: string }>(rows: T[]): T[] => rows.filter((r) => { const v = visible(r.userId); if (!v) limited = true; return v; });

  const perPerson = new Map<string, { role: string; holding: number; late: number; oldest: string | null }>();
  for (const p of held) {
    const role = holderRoleOf(p) as Role;
    if (role !== "officer" && role !== "copywriter" && role !== "designer" && role !== "approver") continue;
    const late = demoPostHealth(p).state === "late";
    for (const id of holdersOf(p, role)) {
      const k = `${id}|${role}`;
      const row = perPerson.get(k) ?? { role, holding: 0, late: 0, oldest: null };
      row.holding += 1;
      if (late) row.late += 1;
      row.oldest = olderOf(row.oldest, dayOf(p.statusSince));
      perPerson.set(k, row);
    }
  }
  const workload = keep([...perPerson.entries()].map(([k, v]) => ({ userId: k.split("|")[0], name: nameOf(k.split("|")[0]), role: v.role, holding: v.holding, late: v.late, oldestSince: v.oldest })));

  // ── where work waits longest ──
  const waits = (["officer", "copywriter", "approver", "designer", "client", "external"] as Role[]).flatMap((role) => {
    const ps = held.filter((p) => holderRoleOf(p) === role);
    if (ps.length === 0) return [];
    let oldest: string | null = null;
    let sum = 0;
    const byPerson = new Map<string, { posts: number; oldest: string | null }>();
    for (const p of ps) {
      oldest = olderOf(oldest, dayOf(p.statusSince));
      sum += workingDaysBetween(dayOf(p.statusSince), today);
      for (const id of holdersOf(p, role)) {
        const e = byPerson.get(id) ?? { posts: 0, oldest: null };
        e.posts += 1; e.oldest = olderOf(e.oldest, dayOf(p.statusSince));
        byPerson.set(id, e);
      }
    }
    const people = keep([...byPerson.entries()].map(([id, e]) => ({ userId: id, name: nameOf(id), posts: e.posts, oldestSince: e.oldest })));
    return [{ holderRole: role, posts: ps.length, oldestSince: oldest, averageWorkingDays: Math.round((sum / ps.length) * 10) / 10, people }];
  });

  // ── step averages: only a month with posts has any (the invented figures are the demo's own) ──
  const stepAverages = posts.length === 0 ? [] : [
    { step: "proofread", averageWorkingDays: 0.6, samples: Math.max(1, posts.length - 2) },
    { step: "hod", averageWorkingDays: 1.4, samples: Math.max(1, posts.length - 3) },
    { step: "design", averageWorkingDays: 2.8, samples: Math.max(1, posts.length - 4) },
    { step: "final", averageWorkingDays: 0.5, samples: Math.max(1, posts.length - 5) },
    { step: "client", averageWorkingDays: 2.1, samples: Math.max(1, posts.length - 6) },
  ];

  const estimatesNotSet = PIPE_ENGAGEMENTS.filter((e) => e.status !== "closed" && Object.keys(allocStore.byEngagement[e.id]?.stepEstimates ?? {}).length === 0)
    .map((e) => ({ engagementId: e.id, clientName: e.clientName }));

  return { month, needsAttention, clients, workload, waits, stepAverages, estimatesNotSet, personRowsLimited: limited, partial: opts.partial ?? [] };
}

/** `GET team?month=` in the server's order of checks: who (403 `not_a_social_approver`), then the month (400 `invalid_field`). */
export function demoTeamRoute(params: URLSearchParams, userId: string): DemoResult {
  if (!isDemoSocialApprover(userId)) return err(403, "not_a_social_approver");
  const month = params.get("month") || todayIsoInDisplayZone().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { status: 400, json: { error: "invalid_field", field: "month" } };
  return ok(demoTeamDashboard(month, userId));
}
