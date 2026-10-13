// M6-P6i — the DNS checklist of a delivered site: WHICH records to create, and whether the domain POINTS at the host yet.
// Pure: no database, no clock, no network. `domain-dns.service.ts` binds it to the registry; `domain-dns-lookup.ts` is the
// one file that asks a resolver, and its answer arrives here as plain data, so a stub resolver drives every case below.
//
// ═══ WHO CHANGES THE RECORDS, AND WHAT THE ERP NEVER DOES (O-12's default; WSK-D43, WSK-D61) ═══════════════════════════════
//   - the owner changes the records for OUR domains and the client for THEIRS, from the checklist this file derives. The
//     console shows it; a person types it into their own DNS panel;
//   - NO DNS credential is stored, NO DNS API token is requested and NO DNS API is called. The only network act is a
//     READ-ONLY resolver lookup of the domain itself (domain-dns-lookup.ts), which changes nothing anywhere;
//   - nothing here reads or writes the registry: `hostKind` and `hostRef` come in as arguments.
//
// ═══ WHERE THE TARGET COMES FROM ═════════════════════════════════════════════════════════════════════════════════════════
// A site's delivery binding (M6-P6g) names the host as an OPAQUE LABEL (`hostRef`: `hostinger-1`, `delphi`), never an address
// (no column holds one, WSK-D30). The address a domain must point at is a fact about that account or box, so it is
// "the account's documented target": an operator-set map `WEBDEV_DNS_TARGETS` (config.webdevDns), keyed by `hostRef`. This
// repository is public and carries no address. A `hostRef` with no entry is NOT guessed at: the checklist says
// `target_unknown` and tells the person to ask the operator for the target.
import { isIP } from "node:net";
import { checkWebdeskEnvironmentDomain } from "./webdesk-domain";
import { BINDABLE_HOST_KINDS, HOST_REF_RE } from "./delivery-binding";

export type DnsRecordType = "A" | "AAAA" | "CNAME";

/** One documented target of a host account: an address to point an A or AAAA record at, or a name for a CNAME. */
export interface DnsTarget {
  type: DnsRecordType;
  value: string;
}

/** `hostRef` -> its documented targets. */
export type DnsTargetMap = ReadonlyMap<string, readonly DnsTarget[]>;

// ── the documented targets (operator config) ──────────────────────────────────────────────────────────────────────────

/** Canonical form of an IPv6 address (lowercase, compressed), so two spellings of one address compare equal. */
export function normalizeIp(addr: string): string {
  const v = isIP(addr);
  if (v === 4) return addr;
  if (v === 6) {
    try {
      return new URL(`http://[${addr}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return addr.toLowerCase();
    }
  }
  return addr.toLowerCase();
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Parse `WEBDEV_DNS_TARGETS`: a JSON object `{"<hostRef>": [{"type":"A","value":"<ipv4>"}, ...]}`. A malformed document, key or
 * record is DROPPED and logged, so a typo can only ever REMOVE a target (the console then says `target_unknown`, visibly),
 * never invent one. A host may list A and AAAA records, or exactly ONE CNAME and nothing else (a name cannot carry a CNAME
 * and another record, so a mixed entry is dropped whole).
 */
export function parseDnsTargets(json: string, warn: (m: string) => void = () => undefined): Map<string, DnsTarget[]> {
  const out = new Map<string, DnsTarget[]>();
  if (!json.trim()) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    warn("WEBDEV_DNS_TARGETS is not valid JSON; no DNS target is configured");
    return out;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warn("WEBDEV_DNS_TARGETS must be a JSON object keyed by host_ref; no DNS target is configured");
    return out;
  }
  for (const [hostRef, list] of Object.entries(raw as Record<string, unknown>)) {
    const bad = (why: string) => warn(`WEBDEV_DNS_TARGETS[${hostRef}] dropped: ${why}`);
    if (!HOST_REF_RE.test(hostRef)) { bad("the key is not a host_ref label"); continue; }
    if (!Array.isArray(list) || list.length === 0) { bad("not a non-empty array"); continue; }
    const targets: DnsTarget[] = [];
    let ok = true;
    for (const e of list) {
      const o = e !== null && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
      const type = o?.type;
      const value = o?.value;
      if (typeof value !== "string" || (type !== "A" && type !== "AAAA" && type !== "CNAME")) { ok = false; break; }
      if (type === "A" && isIP(value) !== 4) { ok = false; break; }
      if (type === "AAAA" && isIP(value) !== 6) { ok = false; break; }
      if (type === "CNAME" && !checkWebdeskEnvironmentDomain(normalizeName(value)).ok) { ok = false; break; }
      targets.push({ type, value: type === "CNAME" ? normalizeName(value) : normalizeIp(value) });
    }
    if (!ok) { bad("a record is not {type: A|AAAA|CNAME, value} with a value of that type"); continue; }
    const cnames = targets.filter((t) => t.type === "CNAME").length;
    if (cnames > 1 || (cnames === 1 && targets.length > 1)) { bad("a CNAME cannot be combined with any other record"); continue; }
    out.set(hostRef, targets);
  }
  return out;
}

// ── the records to create ─────────────────────────────────────────────────────────────────────────────────────────────

/** `ready`: records are known. The three others say why they are not, in the order a person fixes them. */
export type DnsChecklistState = "not_claimed" | "needs_binding" | "target_unknown" | "ready";

export interface DnsRecord {
  type: DnsRecordType;
  /** The FULL domain name the record belongs on (never `@`: apex handling is the person's DNS panel's own word for it). */
  name: string;
  target: string;
}

export interface DnsChecklist {
  state: DnsChecklistState;
  records: DnsRecord[];
  /** What to tell the person, in one sentence, when the records are not yet known; null when `ready`. */
  instruction: string | null;
}

/** The registry's placeholder namespace (M6-P4c): a domain on it has not been claimed and can never resolve. */
export function isPlaceholderDomain(domain: string): boolean {
  return domain === "invalid" || domain.endsWith(".invalid");
}

export interface ChecklistInput {
  domain: string;
  hostKind: string;
  hostRef: string | null;
  targets: DnsTargetMap;
}

/** Pure. The records to create for a site, from its domain and its delivery binding. */
export function dnsChecklistFor(i: ChecklistInput): DnsChecklist {
  if (isPlaceholderDomain(i.domain)) {
    return { state: "not_claimed", records: [], instruction: "Claim the site's real domain first; the placeholder domain cannot be pointed anywhere." };
  }
  if (!BINDABLE_HOST_KINDS.includes(i.hostKind) || i.hostRef === null || i.hostRef === "") {
    return { state: "needs_binding", records: [], instruction: "Bind the site's delivery target first (host kind and host reference); the records depend on where it is delivered." };
  }
  const targets = i.targets.get(i.hostRef);
  if (!targets || targets.length === 0) {
    return {
      state: "target_unknown",
      records: [],
      instruction: `Ask the operator for the DNS target of the host account "${i.hostRef}": it is not recorded here, and none is guessed.`,
    };
  }
  return {
    state: "ready",
    records: targets.map((t) => ({ type: t.type, name: i.domain, target: t.value })),
    instruction: null,
  };
}

/** O-12: who changes the records. Our own (internal) domains: the owner. A client's: the client. */
export function recordsOwnerFor(internal: boolean): "owner" | "client" {
  return internal ? "owner" : "client";
}

// ── the read-only check ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a resolver reported for the domain itself. `error` is a resolver failure code (a timeout, a server failure), never a verdict. */
export interface ObservedDns {
  a: string[];
  aaaa: string[];
  cname: string[];
  error?: string;
}

/** `pointing`: the domain resolves to the documented target and to nothing else. Everything else is `pending`, with a reason. */
export type DnsCheckState = "pending" | "pointing";

export type DnsPendingReason =
  | "domain_not_claimed"
  | "needs_binding"
  | "target_unknown"
  | "lookup_failed"
  | "no_records"
  | "points_elsewhere"
  | "mixed_with_other_hosts";

export interface DnsCheck {
  state: DnsCheckState;
  /** null when `pointing`. */
  reason: DnsPendingReason | null;
}

/**
 * Pure. Whether what a resolver reported is the documented target.
 *
 *   address targets (A / AAAA): `pointing` needs at least one observed address AND every observed address to be one of the
 *   documented ones. Some documented and some not is `mixed_with_other_hosts` (a half-finished cut-over: part of the traffic
 *   still goes to the old host), none documented is `points_elsewhere`;
 *   a CNAME target: `pointing` when the domain's CNAME is that name.
 * No record at all is `no_records` (the domain does not exist yet, or has no address); a resolver failure is `lookup_failed`
 * and is never read as "not pointing" evidence of anything: it is `pending` and says why.
 */
export function evaluateDns(checklist: DnsChecklist, observed: ObservedDns): DnsCheck {
  if (checklist.state === "not_claimed") return { state: "pending", reason: "domain_not_claimed" };
  if (checklist.state === "needs_binding") return { state: "pending", reason: "needs_binding" };
  if (checklist.state === "target_unknown") return { state: "pending", reason: "target_unknown" };
  if (observed.error) return { state: "pending", reason: "lookup_failed" };

  const cnameTarget = checklist.records.find((r) => r.type === "CNAME");
  if (cnameTarget) {
    const cnames = observed.cname.map(normalizeName);
    if (cnames.includes(normalizeName(cnameTarget.target))) return { state: "pointing", reason: null };
    return { state: "pending", reason: cnames.length > 0 || observed.a.length > 0 || observed.aaaa.length > 0 ? "points_elsewhere" : "no_records" };
  }

  const wantA = new Set(checklist.records.filter((r) => r.type === "A").map((r) => normalizeIp(r.target)));
  const wantAAAA = new Set(checklist.records.filter((r) => r.type === "AAAA").map((r) => normalizeIp(r.target)));
  const gotA = observed.a.map(normalizeIp);
  const gotAAAA = observed.aaaa.map(normalizeIp);
  const total = gotA.length + gotAAAA.length;
  if (total === 0) return { state: "pending", reason: "no_records" };
  const hits = gotA.filter((x) => wantA.has(x)).length + gotAAAA.filter((x) => wantAAAA.has(x)).length;
  if (hits === total) return { state: "pointing", reason: null };
  return { state: "pending", reason: hits > 0 ? "mixed_with_other_hosts" : "points_elsewhere" };
}
