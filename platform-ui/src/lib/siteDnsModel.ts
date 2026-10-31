// M6-P6i + M6-P6p — the site console's "Domain and DNS" card: the contract's types, strict parsers and every state, reason and refusal as a
// sentence. Pure and client-safe (no I/O, no `server-only`): the card is a client component.
// Contract: docs/FRONTEND-BFF-CONTRACT.md, the rows for `GET sites/:id/dns`, `GET sites/:id/dns/task` and `POST sites/:id/dns/recheck`.
// The readers are siteDns-data.ts (server-only), the write is siteDnsActions.ts ("use server").
//
// An off-contract body is a `SiteDnsShapeError`, shown as a "contract drift" sentence: never a crash, never an empty card, never "no task".

export type ChecklistState = "not_claimed" | "needs_binding" | "target_unknown" | "ready";
export type CheckState = "pending" | "pointing";
export type PendingReason =
  | "domain_not_claimed" | "needs_binding" | "target_unknown" | "lookup_failed" | "no_records" | "points_elsewhere" | "mixed_with_other_hosts";
export type PropertyState = "none" | "unverified" | "verified";
export type TaskState = "none" | "open" | "closed";
export type AssigneeSource = "project_owner" | "web_dev_head" | "unassigned";
export type ClosedBy = "erp_check" | "manual" | "domain_changed" | "site_archived";

export interface DnsRecord { type: "A" | "AAAA" | "CNAME"; name: string; target: string }
export interface DnsCheck { state: CheckState; reason: PendingReason | null }
export interface ObservedDns { a: string[]; aaaa: string[]; cname: string[]; error: string | null }

export interface SiteDns {
  siteId: string;
  domain: string;
  environment: string;
  hostKind: string;
  hostRef: string | null;
  recordsOwner: "owner" | "client";
  checklist: { state: ChecklistState; records: DnsRecord[]; instruction: string | null };
  observed: ObservedDns | null;
  check: DnsCheck;
  checkedAt: string;
  property: { id: string | null; state: PropertyState };
}

export interface SiteDnsTask {
  id: string | null;
  siteId: string;
  state: TaskState;
  domain: string | null;
  taskId: string | null;
  records: DnsRecord[];
  assigneeSource: AssigneeSource | null;
  assigneeUserId: string | null;
  closedBy: ClosedBy | null;
  closedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckReason: PendingReason | null;
  erpSawPointing: boolean;
}

export interface Recheck { task: SiteDnsTask; check: DnsCheck | null }

/** One read of the card: the parsed body, or the sentence that stands in its place. `forbidden` is a 403 (about seeing), `unavailable` is everything else. */
export type DnsRead<T> = { state: "ok"; data: T } | { state: "unavailable"; kind: "forbidden" | "unavailable"; message: string };

export class SiteDnsShapeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (why: string): never => { throw new SiteDnsShapeError(why); };

const CHECKLIST_STATES: readonly string[] = ["not_claimed", "needs_binding", "target_unknown", "ready"];
const REASONS: readonly string[] = ["domain_not_claimed", "needs_binding", "target_unknown", "lookup_failed", "no_records", "points_elsewhere", "mixed_with_other_hosts"];
const PROPERTY_STATES: readonly string[] = ["none", "unverified", "verified"];
const ASSIGNEES: readonly string[] = ["project_owner", "web_dev_head", "unassigned"];
const CLOSERS: readonly string[] = ["erp_check", "manual", "domain_changed", "site_archived"];
const RECORD_TYPES: readonly string[] = ["A", "AAAA", "CNAME"];

function str(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  return typeof v === "string" ? v : bad(`${where}.${k}: expected a string`);
}
function strOrNull(o: Record<string, unknown>, k: string, where: string): string | null {
  const v = o[k];
  if (v === null) return null;
  return typeof v === "string" ? v : bad(`${where}.${k}: expected a string or null`);
}
function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return bad(`${where}: expected a list of strings`);
  return v as string[];
}
function reasonOrNull(v: unknown, where: string): PendingReason | null {
  if (v === null) return null;
  return typeof v === "string" && REASONS.includes(v) ? (v as PendingReason) : bad(`${where}: unknown reason`);
}

function parseRecords(v: unknown, where: string): DnsRecord[] {
  if (!Array.isArray(v)) return bad(`${where}: expected a list`);
  return v.map((r, i) => {
    if (!isObj(r)) return bad(`${where}[${i}]: expected an object`);
    const type = r.type;
    if (typeof type !== "string" || !RECORD_TYPES.includes(type)) return bad(`${where}[${i}].type: unknown value`);
    return { type: type as DnsRecord["type"], name: str(r, "name", `${where}[${i}]`), target: str(r, "target", `${where}[${i}]`) };
  });
}

function parseCheck(v: unknown, where: string): DnsCheck {
  if (!isObj(v)) return bad(`${where}: expected an object`);
  const state = v.state;
  if (state !== "pending" && state !== "pointing") return bad(`${where}.state: unknown value`);
  const reason = reasonOrNull(v.reason === undefined ? null : v.reason, `${where}.reason`);
  if (state === "pending" && reason === null) return bad(`${where}: a pending check must carry a reason`);
  if (state === "pointing" && reason !== null) return bad(`${where}: a pointing check carries no reason`);
  return { state, reason };
}

function parseObserved(v: unknown): ObservedDns | null {
  if (v === null) return null;
  if (!isObj(v)) return bad("observed: expected an object or null");
  const error = v.error === undefined ? null : v.error;
  if (error !== null && typeof error !== "string") return bad("observed.error: expected a string");
  return { a: strList(v.a, "observed.a"), aaaa: strList(v.aaaa, "observed.aaaa"), cname: strList(v.cname, "observed.cname"), error };
}

/** `GET …/sites/:id/dns` 200 body, strict. */
export function parseSiteDns(b: unknown): SiteDns {
  if (!isObj(b)) return bad("dns checklist: expected an object");
  const owner = b.recordsOwner;
  if (owner !== "owner" && owner !== "client") return bad("recordsOwner: unknown value");
  const c = b.checklist;
  if (!isObj(c)) return bad("checklist: expected an object");
  const cstate = c.state;
  if (typeof cstate !== "string" || !CHECKLIST_STATES.includes(cstate)) return bad("checklist.state: unknown value");
  const p = b.property;
  if (!isObj(p)) return bad("property: expected an object");
  const pstate = p.state;
  if (typeof pstate !== "string" || !PROPERTY_STATES.includes(pstate)) return bad("property.state: unknown value");
  const out: SiteDns = {
    siteId: str(b, "siteId", "dns"),
    domain: str(b, "domain", "dns"),
    environment: str(b, "environment", "dns"),
    hostKind: str(b, "hostKind", "dns"),
    hostRef: strOrNull(b, "hostRef", "dns"),
    recordsOwner: owner,
    checklist: { state: cstate as ChecklistState, records: parseRecords(c.records, "checklist.records"), instruction: strOrNull(c, "instruction", "checklist") },
    observed: parseObserved(b.observed === undefined ? null : b.observed),
    check: parseCheck(b.check, "check"),
    checkedAt: str(b, "checkedAt", "dns"),
    property: { id: strOrNull(p, "id", "property"), state: pstate as PropertyState },
  };
  // A claim the checklist cannot back is drift, not something to draw: `ready` lists its records.
  if (out.checklist.state === "ready" && out.checklist.records.length === 0) return bad("checklist: state ready with no records");
  return out;
}

/** `GET …/sites/:id/dns/task` 200 body (and the `task` of the recheck answer), strict. */
export function parseSiteDnsTask(b: unknown, where = "dns task"): SiteDnsTask {
  if (!isObj(b)) return bad(`${where}: expected an object`);
  const state = b.state;
  if (state !== "none" && state !== "open" && state !== "closed") return bad(`${where}.state: unknown value`);
  const as = b.assigneeSource;
  if (as !== null && (typeof as !== "string" || !ASSIGNEES.includes(as))) return bad(`${where}.assigneeSource: unknown value`);
  const cb = b.closedBy;
  if (cb !== null && (typeof cb !== "string" || !CLOSERS.includes(cb))) return bad(`${where}.closedBy: unknown value`);
  if (typeof b.erpSawPointing !== "boolean") return bad(`${where}.erpSawPointing: expected a boolean`);
  const out: SiteDnsTask = {
    id: strOrNull(b, "id", where),
    siteId: str(b, "siteId", where),
    state,
    domain: strOrNull(b, "domain", where),
    taskId: strOrNull(b, "taskId", where),
    records: parseRecords(b.records, `${where}.records`),
    assigneeSource: as as AssigneeSource | null,
    assigneeUserId: strOrNull(b, "assigneeUserId", where),
    closedBy: cb as ClosedBy | null,
    closedAt: strOrNull(b, "closedAt", where),
    lastCheckedAt: strOrNull(b, "lastCheckedAt", where),
    lastCheckReason: reasonOrNull(b.lastCheckReason, `${where}.lastCheckReason`),
    erpSawPointing: b.erpSawPointing,
  };
  // `none` is "never had a task": a task id on it would be drawn as a link to nothing, and a missing id on a real task has nowhere to link.
  if (state === "none" && out.taskId !== null) return bad(`${where}: state none with a task id`);
  if (state !== "none" && out.taskId === null) return bad(`${where}: state ${state} without a task id`);
  if (state === "closed" && out.closedBy === null) return bad(`${where}: a closed task must say who closed it`);
  return out;
}

/** `POST …/sites/:id/dns/recheck` 200 body, strict. */
export function parseRecheck(b: unknown): Recheck {
  if (!isObj(b)) return bad("dns recheck: expected an object");
  const check = b.check === undefined ? bad("check: missing (expected an object or null)") : b.check;
  return { task: parseSiteDnsTask(b.task, "recheck.task"), check: check === null ? null : parseCheck(check, "check") };
}

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const RECORDS_OWNER_COPY: Record<SiteDns["recordsOwner"], string> = {
  owner: "We change the records (this is one of our own domains).",
  client: "The client changes the records (this is a client's domain). We send them the list below.",
};

export const CHECKLIST_COPY: Record<ChecklistState, string> = {
  not_claimed: "No real domain has been claimed for this site yet: it is still on its placeholder name, which can never resolve. There are no records to create until the domain is claimed.",
  needs_binding: "This site is not bound to a host yet, so the ERP cannot say which records it needs. Bind it to a host first.",
  target_unknown: "The site is bound to a host, but nobody has documented that host's address for the ERP, so the records are not known yet. The ERP never guesses an address: ask the operator for the target.",
  ready: "These are the records this domain needs.",
};

/** One sentence per pending reason. `lookup_failed` says it is NOT "not pointing". */
export const REASON_COPY: Record<PendingReason, string> = {
  domain_not_claimed: "Nothing was compared: the domain is still a placeholder name.",
  needs_binding: "Nothing was compared: the site is not bound to a host yet.",
  target_unknown: "Nothing was compared: the host's address is not documented, so there is nothing to compare DNS with.",
  lookup_failed: "The DNS lookup failed, so the ERP cannot say whether the domain points. That is not the same as not pointing.",
  no_records: "DNS answered with no address for this domain yet.",
  points_elsewhere: "DNS answers with addresses that are not this site's host.",
  mixed_with_other_hosts: "DNS answers with this site's host and with other hosts too: a half-finished cut-over.",
};

export const PROPERTY_COPY: Record<PropertyState, string> = {
  none: "No search property exists for this domain, so no consent to probe it is on record. HTTP and TLS checks do not run on it.",
  unverified: "A search property exists but is not verified, so no consent to probe this domain is on record. HTTP and TLS checks wait for it.",
  verified: "The search property is verified, so consent to probe this domain is on record. HTTP and TLS checks may run on it.",
};

export const TASK_STATE_COPY: Record<TaskState, string> = {
  none: "No DNS task has been made for this site. The ERP makes one when the checklist first has records, and only for a site that belongs to a project.",
  open: "Open: a Web Dev task asks a person to create these records. The ERP completes it when it sees every record point.",
  closed: "Closed.",
};

export const ASSIGNEE_COPY: Record<AssigneeSource, string> = {
  project_owner: "Assigned to the project's active owner.",
  web_dev_head: "Assigned to the Web Dev head, because the project has no active owner.",
  unassigned: "Assigned to nobody: the project has no active owner and the department has no lead seat holder. The task sits on the project board.",
};

export const CLOSED_BY_COPY: Record<ClosedBy, string> = {
  erp_check: "Closed by the ERP's own DNS check, which saw every record point.",
  manual: "Completed by a person, by hand.",
  domain_changed: "Closed because the site's domain changed. A new task replaces it.",
  site_archived: "Closed because the site was archived.",
};

export function observedLine(label: string, values: readonly string[]): string {
  return `${label}: ${values.length ? values.join(", ") : "no answer"}`;
}

/** The PM task's own page (`app/(app)/tasks/[taskId]`, which takes a `pm_tasks` id). */
export function taskHref(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

/** What a recheck said, in one sentence. `check: null` is "there was nothing to check", never "pointing" or "pending". */
export function recheckSentence(r: Recheck): string {
  if (r.check === null) {
    return r.task.state === "closed"
      ? "Nothing was checked: this site's DNS task is already closed, so no lookup was made."
      : "Nothing was checked: this site has no open DNS task, so no lookup was made.";
  }
  if (r.check.state === "pointing") {
    return r.task.state === "closed"
      ? "DNS was checked just now: the domain points at its host. The check closed the task."
      : "DNS was checked just now: the domain points at its host.";
  }
  const why = r.check.reason ? REASON_COPY[r.check.reason] : "";
  return `DNS was checked just now: the domain does not point at its host yet. ${why} The task stays open.`.replace(/\s+/g, " ").trim();
}

/** The recheck's refusals as one sentence. A 403 here is about changing (the check can close the task), not about seeing. */
export function recheckRefusalSentence(status: number): string {
  if (status === 401) return "Your session has ended. Sign in again, then run the check. Nothing was checked.";
  if (status === 403) return "You are not allowed to run the DNS check for this site: it can close the task, so it needs the right to edit the site registry. Nothing was checked.";
  if (status === 404) return "This site was not found for this company, so nothing was checked.";
  return "The DNS check could not be run just now. Nothing was changed. Try again in a moment.";
}

/** A failed READ as a sentence. `what` names the read ("The DNS checklist", "The DNS task"). */
export function dnsReadSentence(what: string, status: number): string {
  if (status === 403) return `You do not have access to this site's ${what.toLowerCase().replace(/^the /, "")}.`;
  if (status === 404) return `${what} was not found for this site: the site is not this company's, or it was removed.`;
  if (status === 401) return `${what} could not be read: your session has ended. Sign in again.`;
  return `${what} could not be read just now. Try again in a moment.`;
}

export function dnsDriftSentence(what: string, why: string): string {
  return `${what} answer did not match the contract (${why}). This is a defect, not an empty value.`;
}
