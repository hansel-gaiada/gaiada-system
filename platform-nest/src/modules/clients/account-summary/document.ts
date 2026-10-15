// PV7-07 — the account summary as a `ReportDocument` (grain `client`) and its narrative (BFF §56.3). PURE: no I/O.
//
// The document is what the print pipeline renders at publish time (mintPrintJobToken + renderPdfViaSidecar, as
// buildSocialReportDocument does for a social report). It is built from the FROZEN snapshot and the narrative as it stands
// when staff publish, so an edit made in the draft is what the client's PDF says.
//
// ── THE NARRATIVE'S FACTS ARE THE SNAPSHOT'S, AND NOTHING ELSE ───────────────────────────────────────
// `summaryGroundingFacts` reads the document's KPIs and highlights, which are built from the snapshot alone. The snapshot
// holds no task, time, person, internal gate or money (snapshot.ts), so none can reach the model. The model's text is kept
// only if it passes the reports module's hallucinated-numeral guard (`parseNarrative`): a numeral that is not among the facts
// rejects the whole text and the deterministic narrative below stands. A gateway that is down or unconfigured gives the same.
import type { ReportDocument, ReportHighlight, ReportKpi, ReportNarrative, ReportTable, ReportUnit } from "../../reports/report-document";
import { buildGroundingFacts, MAX_NARRATIVE_CHARS, type NarrativeGroundingFacts } from "../../reports/narrative";
import { summaryPeriodLabel, type AccountSummarySnapshot } from "./snapshot";

export type SummaryNarrativeSource = "ai" | "human" | "deterministic";

const round1 = (x: number) => Math.round(x * 10) / 10;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function dayCount(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((e - s) / 86_400_000) + 1);
}

function resultUnit(unit: "count" | "percent" | "position" | "ratio"): ReportUnit {
  if (unit === "percent" || unit === "ratio") return "percent";
  if (unit === "position") return "score";
  return "count";
}

/** The KPI tiles: facts the client can already see. Unknown is omitted, never zero. */
export function summaryKpis(s: AccountSummarySnapshot): ReportKpi[] {
  const out: ReportKpi[] = [];
  const kpi = (metricKey: string, label: string, value: number | null | undefined, unit: ReportUnit = "count"): void => {
    if (typeof value === "number" && Number.isFinite(value)) out.push({ metricKey, label, unit, value, appraisalSafe: false });
  };
  if (s.projects) kpi("summary.projects", "Projects", s.projects.length);
  const ms = s.completed.milestones;
  if (ms) {
    const note = ms.wholeMonthKnown === true ? "" : ms.knownSince ? ` (dates recorded from ${ms.knownSince})` : " (completion dates not recorded for the whole month)";
    kpi("summary.milestones_completed", `Milestones completed${note}`, ms.count);
  }
  const ds = s.completed.deliverables;
  if (ds) kpi("summary.deliverables_delivered", "Deliverables delivered (status changed this month)", ds.count);
  if (s.waiting) {
    kpi("summary.waiting_on_you", "Waiting on you", s.waiting.onClient.count);
    kpi("summary.waiting_on_us", "Waiting on us", s.waiting.onUs.count);
  }
  if (s.turnaround) {
    kpi("summary.turnaround_you_days", "Your turnaround, median days (90 days to month end)", s.turnaround.client.withheld ? null : s.turnaround.client.medianDays);
    kpi("summary.turnaround_us_days", "Our turnaround, median days (90 days to month end)", s.turnaround.ours.withheld ? null : s.turnaround.ours.medianDays);
  }
  if (s.reports) kpi("summary.reports_published", "Reports published", s.reports.length);
  if (s.results) {
    for (const card of s.results.services) {
      for (const k of card.kpis) {
        if (k.value === null) continue;
        const value = k.unit === "ratio" ? round1(k.value * 100) : k.value;
        kpi(`results.${k.key}`, `${card.title}: ${k.label}`, value, resultUnit(k.unit));
      }
    }
  }
  return out;
}

/** Plain-words notes about what the figures cover. Deterministic, template-built from the snapshot. */
export function summaryHighlights(s: AccountSummarySnapshot): ReportHighlight[] {
  const out: ReportHighlight[] = [];
  const ms = s.completed.milestones;
  if (ms && ms.wholeMonthKnown !== true) {
    out.push({
      kind: "anomaly",
      text: ms.knownSince
        ? `Milestone completion dates are recorded from ${ms.knownSince}, so milestones finished before then are not counted.`
        : "Milestone completion dates are not recorded for this whole month, so the count may be incomplete.",
    });
  }
  if (s.completed.deliverables) {
    out.push({ kind: "compliance", text: "A deliverable is counted in the month its status last changed to delivered, approved or done." });
  }
  const late = (s.projects ?? []).reduce((n, p) => n + p.milestones.late, 0);
  if (late > 0) out.push({ kind: "risk", text: `${plural(late, "milestone is", "milestones are")} past its due date.` });
  if (s.unavailable.length > 0) {
    out.push({ kind: "anomaly", text: `Some figures could not be read when this summary was drafted (${s.unavailable.join(", ")}); they are left out.` });
  }
  return out;
}

function summaryTables(s: AccountSummarySnapshot): ReportTable[] {
  const tables: ReportTable[] = [];
  if (s.projects && s.projects.length > 0) {
    tables.push({
      key: "summary_projects",
      label: "Projects",
      columns: [
        { key: "project", label: "Project" },
        { key: "status", label: "Status" },
        { key: "milestonesDone", label: "Milestones done", unit: "count", align: "right" },
        { key: "milestonesTotal", label: "Milestones", unit: "count", align: "right" },
        { key: "milestonesLate", label: "Late", unit: "count", align: "right" },
        { key: "deliverablesDelivered", label: "Deliverables delivered", unit: "count", align: "right" },
        { key: "next", label: "Next milestone" },
      ],
      rows: s.projects.map((p) => ({
        project: p.name, status: p.status,
        milestonesDone: p.milestones.done, milestonesTotal: p.milestones.total, milestonesLate: p.milestones.late,
        deliverablesDelivered: p.deliverables.delivered,
        next: p.nextMilestone ? `${p.nextMilestone.name} (${p.nextMilestone.dueDate})` : null,
      })),
    });
  }
  const ms = s.completed.milestones;
  if (ms && ms.items.length > 0) {
    tables.push({
      key: "summary_milestones",
      label: "Milestones completed this month",
      columns: [{ key: "project", label: "Project" }, { key: "milestone", label: "Milestone" }, { key: "on", label: "Completed" }],
      rows: ms.items.map((i) => ({ project: i.projectName, milestone: i.name, on: i.completedOn })),
    });
  }
  const ds = s.completed.deliverables;
  if (ds && ds.items.length > 0) {
    tables.push({
      key: "summary_deliverables",
      label: "Deliverables delivered this month",
      columns: [{ key: "project", label: "Project" }, { key: "deliverable", label: "Deliverable" }, { key: "status", label: "Status" }, { key: "on", label: "Changed" }],
      rows: ds.items.map((i) => ({ project: i.projectName, deliverable: i.name, status: i.status, on: i.on })),
    });
  }
  if (s.reports && s.reports.length > 0) {
    tables.push({
      key: "summary_reports",
      label: "Reports published this month",
      columns: [{ key: "title", label: "Report" }, { key: "period", label: "Period" }, { key: "on", label: "Published" }],
      rows: s.reports.map((r) => ({ title: r.title, period: `${r.periodStart} to ${r.periodEnd}`, on: r.publishedOn })),
    });
  }
  return tables;
}

/** The deterministic narrative (Markdown): short, factual, built from the snapshot, with no number that is not in it. */
export function deterministicSummaryNarrative(s: AccountSummarySnapshot): string {
  const label = summaryPeriodLabel(s.period);
  const parts: string[] = [];
  const done = s.completed.milestones;
  const delivered = s.completed.deliverables;
  const bits: string[] = [];
  if (done) bits.push(`${plural(done.count, "milestone was", "milestones were")} completed`);
  if (delivered) bits.push(`${plural(delivered.count, "deliverable was", "deliverables were")} delivered`);
  if (bits.length > 0) {
    const across = s.projects ? ` across ${plural(s.projects.length, "project", "projects")}` : "";
    parts.push(`In ${label}, ${bits.join(" and ")}${across}.`);
  } else {
    parts.push(`This is the account summary for ${label}.`);
  }
  if (s.waiting) {
    parts.push(`${plural(s.waiting.onClient.count, "item is", "items are")} waiting on you and ${s.waiting.onUs.count} on us.`);
  }
  if (s.turnaround) {
    const you = s.turnaround.client;
    const us = s.turnaround.ours;
    const side = (who: string, t: { medianDays: number | null; n: number; withheld: boolean }): string | null =>
      t.withheld || t.medianDays === null ? null : `${who} took a median of ${t.medianDays} days to answer (${plural(t.n, "item", "items")})`;
    const sentences = [side("You", you), side("We", us)].filter((x): x is string => x !== null);
    if (sentences.length > 0) parts.push(`Over the 90 days to the end of the month, ${sentences.join(", and ")}.`);
  }
  if (s.reports && s.reports.length > 0) parts.push(`${plural(s.reports.length, "report was", "reports were")} published this month.`);
  return parts.join("\n\n");
}

/** The `ReportDocument` the print pipeline renders. `narrativeSource` `human` is shown as a non-AI narrative (the document
 *  type has two values, model-written or not). */
export function buildAccountSummaryDocument(input: {
  tenantId: string;
  snapshot: AccountSummarySnapshot;
  narrativeMd: string;
  narrativeSource: SummaryNarrativeSource;
  /** Defaults to the snapshot's own instant, so re-rendering a draft does not change the date it says. */
  generatedAt?: string;
}): ReportDocument {
  const s = input.snapshot;
  const narrative: ReportNarrative = { source: input.narrativeSource === "ai" ? "ai" : "deterministic", text: input.narrativeMd };
  return {
    header: {
      tenantId: input.tenantId,
      grain: "client",
      scopeRef: s.clientId,
      scopeName: s.clientName,
      periodKind: "month",
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      dayCount: dayCount(s.periodStart, s.periodEnd),
      periodLabel: summaryPeriodLabel(s.period),
      generatedAt: input.generatedAt ?? s.generatedAt,
      sealed: false,
    },
    kpis: summaryKpis(s),
    series: [],
    distributions: [],
    tables: summaryTables(s),
    highlights: summaryHighlights(s),
    narrative,
  };
}

/** The only facts the narrative prompt sees: the document's own KPI tiles and highlights, built from the snapshot. */
export function summaryGroundingFacts(s: AccountSummarySnapshot): NarrativeGroundingFacts {
  return buildGroundingFacts(buildAccountSummaryDocument({
    tenantId: "", snapshot: s, narrativeMd: "", narrativeSource: "deterministic",
  }));
}

/** The prompt for the draft's narrative. Pure; embeds the grounding facts and the house tone rules only. */
export function buildSummaryNarrativePrompt(facts: NarrativeGroundingFacts): string {
  const lines = [
    `You are writing the short opening paragraph of a monthly account summary for the client "${facts.scopeName}", period ${facts.periodLabel}. The reader is the client.`,
    "House tone: plain, factual, warm but not salesy, second person where it is about the client's own side, no hype, no speculation, no advice, no promises.",
    "Do not mention money, prices, fees, budgets, tasks, hours, or any person by name.",
    "Numbers you may reference (do not invent, round, or restate any number not listed here):",
    ...facts.kpis.map((k) => `- ${k.label}: ${k.value}`),
    facts.highlights.length > 0 ? `Notes about the figures: ${facts.highlights.join(" ")}` : "",
    `Write 2-3 short sentences (max ${MAX_NARRATIVE_CHARS} characters total) summarizing the month using ONLY the numbers listed above.`,
    "Reply with the plain-prose narrative only: no markdown, no headings, no JSON, no preamble.",
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

export { MAX_NARRATIVE_CHARS };
