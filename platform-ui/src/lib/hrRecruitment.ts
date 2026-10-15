// HR › Recruitment — the value sets, status moves and small pure helpers the DW-7f-2 write screens share.
// No "server-only" and no "use server": the client components import these too. Backend: platform-nest
// src/modules/hr/recruitment.controller.ts and migration 202608240141_hr_recruitment.sql.
//
// Everything here MIRRORS what the server accepts. It hides or pre-checks nothing the server decides.
import type { Application, PipelineStage } from "./hr-full";

export const EMPLOYMENT_TYPES: readonly string[] = ["permanent", "contract", "probation", "intern", "part_time", "freelance"];
export const WORK_MODES: readonly string[] = ["onsite", "hybrid", "remote"];
export const CANDIDATE_SOURCES: readonly string[] = ["direct", "referral", "agency", "job_board", "linkedin", "career_site", "event", "other"];
export const INTERVIEW_KINDS: readonly string[] = ["screen", "interview", "technical", "panel", "culture", "final", "other"];
export const INTERVIEW_STATUSES: readonly string[] = ["scheduled", "completed", "cancelled", "no_show", "rescheduled"];
export const INTERVIEW_OUTCOMES: readonly string[] = ["advance", "hold", "reject"];
export const RECOMMENDATIONS: readonly string[] = ["strong_yes", "yes", "neutral", "no", "strong_no"];
export const RATE_BASES: readonly string[] = ["monthly", "annual", "hourly", "daily", "weekly", "piece_rate"];
export const PANELIST_ROLES: readonly string[] = ["interviewer", "lead", "observer"];

/** The statuses a PATCH may set. The server refuses `pending_approval` and `open`: the approval flow owns them. */
export const PATCHABLE_REQUISITION_STATUSES: readonly string[] = ["draft", "on_hold", "filled", "cancelled", "closed"];
/** The statuses POST offers/:id/status accepts. `converted` is only ever set by the convert route. */
export const OFFER_SET_STATUSES: readonly string[] = ["sent", "accepted", "declined", "expired", "withdrawn"];
/** An offer in one of these statuses blocks a second offer (the server's ux_hr_offers_live index). */
export const LIVE_OFFER_STATUSES: readonly string[] = ["draft", "pending_approval", "sent", "accepted"];

export type StatusMove = { to: string; label: string; confirm?: string };

/**
 * The moves the UI offers on a requisition. The server is wider than this (it lets a PATCH set any of the
 * patchable statuses from any status, even from `pending_approval`, which would orphan the approval), so
 * this is a deliberately narrower mirror. A requisition can never go back to `open` by hand: it is
 * re-submitted from draft and approved again.
 */
export function requisitionMoves(status: string): StatusMove[] {
  switch (status) {
    case "draft":
      return [{ to: "cancelled", label: "Cancel requisition", confirm: "Cancel this requisition? It will not open." }];
    case "open":
      return [
        { to: "on_hold", label: "Put on hold" },
        { to: "closed", label: "Close", confirm: "Close this requisition? No more applications should be added." },
        { to: "cancelled", label: "Cancel requisition", confirm: "Cancel this requisition? It will stop recruiting." },
      ];
    case "on_hold":
      return [
        { to: "draft", label: "Return to draft", confirm: "Return this requisition to draft? It needs to be submitted and approved again to reopen." },
        { to: "closed", label: "Close", confirm: "Close this requisition?" },
        { to: "cancelled", label: "Cancel requisition", confirm: "Cancel this requisition?" },
      ];
    default:
      return []; // pending_approval is in the approvals queue; filled, closed and cancelled are final
  }
}

/** The moves the UI offers on an offer, by its status. `converted` is the convert route's alone. */
export function offerMoves(status: string): StatusMove[] {
  switch (status) {
    case "draft":
      return [{ to: "sent", label: "Mark as sent" }, { to: "withdrawn", label: "Withdraw offer", confirm: "Withdraw this offer?" }];
    case "sent":
      return [
        { to: "accepted", label: "Candidate accepted" },
        { to: "declined", label: "Candidate declined" },
        { to: "expired", label: "Mark expired", confirm: "Mark this offer as expired?" },
        { to: "withdrawn", label: "Withdraw offer", confirm: "Withdraw this offer?" },
      ];
    case "accepted":
      return [{ to: "withdrawn", label: "Withdraw offer", confirm: "Withdraw this accepted offer?" }];
    default:
      return [];
  }
}

export type RecruitmentControls = {
  /** Create, submit, erase, offers, applications: the server has NO attribute arm for these. */
  manage: boolean;
  /** Convert an accepted offer into an employee (hr.recruitment.approve; the server also needs a high-assurance sign-in). */
  convert: boolean;
  /** Edit a requisition, move a stage, schedule or edit an interview. The server also lets a requisition's hiring manager or recruiter do these. */
  update: boolean;
  /** File a scorecard. The server also lets an interview panelist do this. */
  score: boolean;
};

/**
 * Which controls to SHOW. A mirror, never a check (the server decides). `manage` and `convert` are exact.
 * `update` and `score` also have an attribute arm in the policy (hiring manager, recruiter, panelist) that
 * the capability list cannot express. A person who can reach the page WITHOUT hr.recruitment.view can only
 * have come in through that arm, so they are shown the control and the server refuses in words if the
 * attribute does not hold. A reader with the view capability and no manage is shown a read-only page, unless
 * the page can see they are a panelist (`isPanelist`).
 */
export function recruitmentControls(
  caps: { view: boolean; manage: boolean; approve: boolean }, isPanelist = false,
): RecruitmentControls {
  const attributeOnly = !caps.view && !caps.manage;
  return {
    manage: caps.manage,
    convert: caps.approve,
    update: caps.manage || attributeOnly,
    score: caps.manage || attributeOnly || isPanelist,
  };
}

// ---------- Time zones ----------
// The backend takes `scheduledStart` as a timestamp string and does not apply the interview's `timezone` to
// it (that column is only displayed). A bare "2026-10-20T09:00" would be read in the database's own zone, so
// the screens convert what was typed, in the chosen zone, to an exact instant before sending it.

function zoneOffsetMs(tz: string, utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "2026-10-20T09:00" typed in `tz` → an ISO instant ("2026-10-20T01:00:00.000Z"), or null for a bad date or an unknown zone. */
export function zonedLocalToIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  try {
    let t = naive - zoneOffsetMs(tz, naive);
    t = naive - zoneOffsetMs(tz, t); // second pass settles a zone whose offset changes on that day
    return new Date(t).toISOString();
  } catch {
    return null;
  }
}

/** An ISO instant → the "YYYY-MM-DDTHH:mm" a datetime-local input wants, as the clock reads in `tz`. */
export function isoToZonedLocal(iso: string, tz: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).formatToParts(new Date(t)).map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  } catch {
    return "";
  }
}

/** An ISO instant read on the clock of `tz`, for display. Falls back to the raw string. */
export function formatInZone(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ---------- Pipeline grouping ----------

export type StageGroup = { key: string; label: string; isTerminal: boolean; apps: Application[] };

/**
 * Applications grouped under the configured stages, in the stage order. An application whose stage is not in
 * the list (a stage deactivated since) goes under "Other stage", never dropped: a pipeline view that loses
 * people is worse than one that says it does not know where they are.
 */
export function groupByStage(apps: Application[], stages: PipelineStage[]): StageGroup[] {
  const active = [...stages].filter((s) => s.isActive).sort((a, b) => a.sortOrder - b.sortOrder);
  const known = new Set(active.map((s) => s.key));
  const groups: StageGroup[] = active.map((s) => ({
    key: s.key, label: s.label, isTerminal: s.isTerminal, apps: apps.filter((a) => a.stageKey === s.key),
  }));
  const orphans = apps.filter((a) => !known.has(a.stageKey));
  if (orphans.length) groups.push({ key: "__other", label: "Other stage", isTerminal: false, apps: orphans });
  return groups;
}
