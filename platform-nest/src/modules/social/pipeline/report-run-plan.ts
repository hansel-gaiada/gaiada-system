// SCP-5 W5-A3 (docs/FRONTEND-BFF-CONTRACT.md §63.24.5) — "Generate with AI": what a run lists and what each client's result is. PURE: no
// I/O, no clock. pipeline/report-runs.ts reads, writes and runs; this file decides.
//
// ── THE LISTING (decided once, at the start; the run drafts exactly those clients) ─────────────────────────────────────────
//   * Who the person may draft for: one of the four (`social_engagement` · `plan`) gets every engagement of the company, anyone else
//     holding `create` the engagements they are the officer of (`social_engagements.owner_id`). Nobody else is listed.
//   * An engagement that is not `active` is left out.
//   * The internal client is listed `skipped` with `internal_client`; for a kind other than the monthly, a client not due the kind (not in
//     its `report_kinds`, SCP-Q26) is listed `skipped` with `kind_not_due`.
//   * Chosen clients (a schedule's `chosen` scope, 63.24.9, and the route's optional `engagementIds`): only those are looked at; one the
//     person may not draft for is listed `skipped` with `not_allowed` instead of being left out, so the person sees why; and the person
//     chose the client for this kind, so `kind_not_due` does not apply.
//   * Every other client is `pending`, the run's to draft. `pending` is the run's own bookkeeping in `social_report_runs.results`, never
//     answered: the progress read lists the finished results only (created, existing, skipped, failed).
//
// ── ONE CLIENT'S RESULT ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Each client is drafted through the create route's own path with a report id derived from the run and the engagement (`runReportId`),
// so the create is idempotent per run and client on top of its own idempotency per client, kind and period:
//   * a new draft is `created` with its `draftedVia` (`ai`, or `fallback` when the gateway failed: not a failure, 63.18);
//   * the client's report of the kind and period that already existed, in any state, is `existing`, never redrafted;
//   * the run's OWN report found again (a run resumed after its worker died between the insert and the result) is `created`, read back from
//     the report itself, with no second gateway call;
//   * a draft that throws is `failed` with its reason, and never stops the others.
import { createHash } from "node:crypto";

/** At most this many drafts in flight per run (§63.24.5); the gateway's own limits apply on top. */
export const MAX_DRAFTS_IN_FLIGHT = 4;
/** A running run whose heartbeat is older than this is resumed by the job (its worker died). */
export const STALE_HEARTBEAT_MINUTES = 5;
/** The most clients a run may name (a schedule's `chosen` list holds at most 200, 63.24.9). */
export const MAX_CHOSEN_CLIENTS = 200;

export type RunResultStatus = "created" | "existing" | "skipped" | "failed";
export type RunSkipReason = "kind_not_due" | "internal_client" | "not_allowed";

/** One client of a run, as `social_report_runs.results` holds it. */
export interface RunEntry {
  engagementId: string;
  clientName: string;
  status: RunResultStatus | "pending";
  reportId?: string;
  draftedVia?: "ai" | "fallback" | "none";
  reason?: string;
  simulated?: boolean;
}

/** An engagement of the company, as the listing reads it. */
export interface RunCandidate {
  engagementId: string;
  clientName: string;
  status: string;
  isInternal: boolean;
  ownerId: string | null;
  reportKinds: readonly string[];
}

export interface PlanInput {
  kind: string;
  /** One of the four: every engagement. */
  mayPlan: boolean;
  /** The person the narrowing is for (their own engagements when not one of the four). */
  personId: string | null;
  /** Only these engagements (a schedule's `chosen`, or the route's `engagementIds`); null or absent for every one the person may draft. */
  chosen?: readonly string[] | null;
}

const lc = (s: string | null | undefined): string => (s ?? "").toLowerCase();

/** The run's listing (see the header), in the order the page shows it: by client name, then engagement id. */
export function planRunEntries(candidates: readonly RunCandidate[], p: PlanInput): RunEntry[] {
  const chosen = p.chosen && p.chosen.length > 0 ? new Set(p.chosen.map(lc)) : null;
  const sorted = [...candidates].sort((a, b) =>
    a.clientName.toLowerCase() < b.clientName.toLowerCase() ? -1 : a.clientName.toLowerCase() > b.clientName.toLowerCase() ? 1
      : a.engagementId < b.engagementId ? -1 : a.engagementId > b.engagementId ? 1 : 0);
  const out: RunEntry[] = [];
  for (const c of sorted) {
    if (chosen && !chosen.has(lc(c.engagementId))) continue;
    if (c.status !== "active") continue;
    const base = { engagementId: c.engagementId, clientName: c.clientName };
    const allowed = p.mayPlan || (p.personId !== null && lc(c.ownerId) === lc(p.personId));
    if (!allowed) {
      if (chosen) out.push({ ...base, status: "skipped", reason: "not_allowed" });
      continue;
    }
    if (c.isInternal) { out.push({ ...base, status: "skipped", reason: "internal_client" }); continue; }
    if (!chosen && p.kind !== "monthly" && !c.reportKinds.includes(p.kind)) { out.push({ ...base, status: "skipped", reason: "kind_not_due" }); continue; }
    out.push({ ...base, status: "pending" });
  }
  return out;
}

/** The finished results (what the progress read answers): every entry that is not `pending`. */
export const finishedResults = (entries: readonly RunEntry[]): RunEntry[] => entries.filter((e) => e.status !== "pending");
export const pendingEntries = (entries: readonly RunEntry[]): RunEntry[] => entries.filter((e) => e.status === "pending");

export interface RunCounts { created: number; existing: number; skipped: number; failed: number; pending: number }

export function countResults(entries: readonly RunEntry[]): RunCounts {
  const out: RunCounts = { created: 0, existing: 0, skipped: 0, failed: 0, pending: 0 };
  for (const e of entries) out[e.status] += 1;
  return out;
}

/**
 * The report id a run gives one client's draft: a name-based (version 5 layout) uuid of the run and the engagement. The same run and client
 * always name the same report, so a resumed run that finds it knows it made it, and an insert can never be made twice.
 */
export function runReportId(runId: string, engagementId: string): string {
  const h = createHash("sha1").update(`social_report_run:${runId.toLowerCase()}:${engagementId.toLowerCase()}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** What the create path answered, as far as a run's result needs it. */
export interface CreateAnswerFacts {
  id: string;
  draftedVia: "ai" | "fallback" | "none" | "existing";
  simulated: boolean;
  /** The frozen numbers' record of how the narrative was made ('ai' or 'deterministic'); read when the run finds its own report again. */
  narrativeSource?: string | null;
}

/** One client's result from the create path's answer (see the header). */
export function resultFromAnswer(entry: Pick<RunEntry, "engagementId" | "clientName">, a: CreateAnswerFacts, ownReportId: string): RunEntry {
  const base = { engagementId: entry.engagementId, clientName: entry.clientName, reportId: a.id, simulated: a.simulated };
  if (a.draftedVia !== "existing") return { ...base, status: "created", draftedVia: a.draftedVia };
  if (a.id.toLowerCase() === ownReportId.toLowerCase()) {
    return { ...base, status: "created", draftedVia: a.narrativeSource === "ai" ? "ai" : "fallback" };
  }
  return { ...base, status: "existing" };
}

/** A typed reason for a client whose draft threw: the refusal's own code, never prose (no names, no ids). */
export function failureReason(err: unknown): string {
  const e = err as { getStatus?: () => number; getResponse?: () => unknown; code?: unknown } | null;
  const status = typeof e?.getStatus === "function" ? e.getStatus() : null;
  if (status === 401) return "session_revoked";
  if (status === 403) return "not_authorized";
  if (status === 404) return "engagement_not_found";
  if (status !== null && typeof e?.getResponse === "function") {
    const res = e.getResponse();
    const msg = typeof res === "string" ? res : (res as { message?: unknown } | null)?.message;
    if (typeof msg === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(msg)) return msg;
  }
  return "draft_failed";
}

/** The end notice's words (§63.24.5: "12 drafts ready, 6 already there, 1 failed"); the parts with nothing in them are left out. */
export function generatedNoticeTitle(c: Pick<RunCounts, "created" | "existing" | "skipped" | "failed">): string {
  const parts: string[] = [];
  parts.push(`${c.created} ${c.created === 1 ? "draft" : "drafts"} ready`);
  if (c.existing > 0) parts.push(`${c.existing} already there`);
  if (c.skipped > 0) parts.push(`${c.skipped} skipped`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  return parts.join(", ");
}

/**
 * Run `fn` over `items` with at most `limit` in flight, in order of `items`. Each call's rejection is the caller's to catch (the run's
 * per-client function never throws). `stop()` returning true stops new items from starting; the ones in flight finish.
 */
export async function runBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !stop()) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, () => worker()));
}
