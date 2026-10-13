// M6-P6i — `GET /api/:t/modules/webdev/sites/:id/dns`: the DNS checklist the console shows for one registry row. The Postgres
// half of domain-dns.ts: it reads the row, its delivery binding, its client and its `search_properties` row, derives the records
// to create, and runs ONE read-only resolver lookup (domain-dns-lookup.ts). Writes nothing; calls no DNS API; holds no credential.
//
// The answer is a CLAIM about the world, so each part says what it is built from:
//   - `records`: derived from the row's own `host_kind` / `host_ref` and the operator's documented targets (`WEBDEV_DNS_TARGETS`).
//     With no documented target the state is `target_unknown` and `instruction` says to ask the operator: no address is invented;
//   - `check`: what a resolver reported for the domain RIGHT NOW (`checkedAt`), mapped by `evaluateDns`. A resolver failure is
//     `pending` with `lookup_failed`, not "not pointing";
//   - `property`: the consent gate's state, because pointing a domain at a host is not consent to probe it. HTTP and TLS checks
//     (MON-01) wait for `verified_at`; this is where the console reads whether that has happened.
// RLS: `webdev_sites` is webdev-walled and `search_properties` is search-walled, so BOTH module scopes are declared; omit one and
// its table reads zero rows with no error (the RLS zero-row trap).
import { Logger, NotFoundException } from "@nestjs/common";
import { withTenants } from "../../db";
import { config } from "../../config";
import {
  dnsChecklistFor, evaluateDns, parseDnsTargets, recordsOwnerFor,
  type DnsCheck, type DnsChecklist, type DnsTargetMap, type ObservedDns,
} from "./domain-dns";
import { lookupDomainRecords } from "./domain-dns-lookup";

const logger = new Logger("WebdevDomainDns");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let targetsOverride: DnsTargetMap | null = null;
/** Tests only: the documented targets, in place of `config.webdevDns.targetsJson`. `null` restores config. */
export function setDnsTargetsForTests(m: DnsTargetMap | null): void {
  targetsOverride = m;
}

/** The documented targets. Parsed per call (a small JSON document) so an operator's change needs no restart; a bad entry is logged and dropped. */
export function documentedDnsTargets(): DnsTargetMap {
  return targetsOverride ?? parseDnsTargets(config.webdevDns.targetsJson, (m) => logger.warn(m));
}

export type PropertyConsentState = "none" | "unverified" | "verified";

export interface SiteDnsDto {
  siteId: string;
  domain: string;
  environment: string;
  hostKind: string;
  hostRef: string | null;
  /** O-12: who edits the records. `owner` for an internal domain (no client, or the internal sentinel), `client` for a client's. */
  recordsOwner: "owner" | "client";
  checklist: DnsChecklist;
  /** What a resolver reported just now. Present only when there is something to check against (a claimed domain). */
  observed: ObservedDns | null;
  check: DnsCheck;
  checkedAt: string;
  /** The consent gate for this domain: MON-01 probes it only when `verified`. */
  property: { id: string | null; state: PropertyConsentState };
}

export async function readSiteDns(tenantId: string, siteId: string, now: () => Date = () => new Date()): Promise<SiteDnsDto> {
  // A malformed id would die at the uuid cast as a 500; it can match no row, so it is a 404.
  if (!UUID_RE.test(siteId)) throw new NotFoundException("webdev site not found");
  const facts = await withTenants(
    [tenantId],
    async (c) => {
      const site = await c.query<{ id: string; domain: string; environment: string; host_kind: string; host_ref: string | null; client_id: string | null }>(
        `SELECT id, domain, environment, host_kind, host_ref, client_id FROM webdev_sites WHERE id = $1 AND deleted_at IS NULL`,
        [siteId],
      );
      const row = site.rows[0];
      if (!row) return null;
      let clientInternal = row.client_id === null;
      if (row.client_id !== null) {
        const cl = await c.query<{ is_internal: boolean }>(`SELECT is_internal FROM clients WHERE id = $1 AND tenant_id = $2`, [row.client_id, tenantId]);
        clientInternal = cl.rows[0]?.is_internal === true;
      }
      const prop = await c.query<{ id: string; verified_at: Date | null }>(
        `SELECT id, verified_at FROM search_properties WHERE tenant_id = $1 AND lower(domain) = lower($2) AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1`,
        [tenantId, row.domain],
      );
      return { row, clientInternal, prop: prop.rows[0] ?? null };
    },
    { modules: ["webdev", "search"] },
  );
  if (!facts) throw new NotFoundException("webdev site not found");

  const { row } = facts;
  const checklist = dnsChecklistFor({ domain: row.domain, hostKind: row.host_kind, hostRef: row.host_ref, targets: documentedDnsTargets() });
  // Ask the resolver only when there is a claimed domain to ask about and a target to compare it with.
  const observed = checklist.state === "ready" ? await lookupDomainRecords(row.domain) : null;
  const check = evaluateDns(checklist, observed ?? { a: [], aaaa: [], cname: [] });
  return {
    siteId: row.id,
    domain: row.domain,
    environment: row.environment,
    hostKind: row.host_kind,
    hostRef: row.host_ref,
    recordsOwner: recordsOwnerFor(facts.clientInternal),
    checklist,
    observed,
    check,
    checkedAt: now().toISOString(),
    property: {
      id: facts.prop?.id ?? null,
      state: !facts.prop ? "none" : facts.prop.verified_at ? "verified" : "unverified",
    },
  };
}
