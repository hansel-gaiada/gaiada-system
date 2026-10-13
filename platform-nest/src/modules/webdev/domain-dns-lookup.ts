// M6-P6i — the ONE place the webdev module asks a DNS resolver anything: a READ-ONLY lookup of a registry row's own domain
// (A, AAAA and CNAME), so the console can say whether the domain points at its host yet (`domain-dns.ts` evaluateDns).
//
// WHAT THIS IS NOT: it calls no DNS provider's API, holds no DNS credential and changes no record (WSK-D43/D61, O-12's default:
// the owner or the client edits the records by hand from the console's checklist). It is the same query any browser's
// resolver makes for the name, over the host's configured resolvers (`node:dns/promises`, public resolution). It connects to
// nothing it resolves, so the answer can never steer a request at an address (no SSRF surface: a name goes in, strings come out).
// The domain argument is always a value already validated and stored on the registry (`normalizeSiteDomain`), never a request value.
//
// TESTS: `setDnsLookupForTests` installs a stub, and under vitest the real resolver is OFF (an answer of `resolver_unavailable`),
// so no suite ever dials a resolver by accident; the monitoring runner's RDAP lookup follows the same rule (`runner.ts`).
import { Resolver } from "node:dns/promises";
import { config } from "../../config";
import type { ObservedDns } from "./domain-dns";

export type DnsLookupFn = (domain: string) => Promise<ObservedDns>;

let override: DnsLookupFn | null = null;

/** Tests only. `null` restores the real resolver (itself off under vitest). */
export function setDnsLookupForTests(fn: DnsLookupFn | null): void {
  override = fn;
}

/** Resolver error codes that mean "this name has no such record", which is an answer, not a failure. */
const NO_ANSWER_CODES: ReadonlySet<string> = new Set(["ENODATA", "ENOTFOUND", "NODATA", "NXDOMAIN"]);

/** Exported for the unit suite: a resolver promise becomes `{values}`, an empty answer for a name that has no such record, or `{error: <code>}`. */
export async function settleLookup(p: Promise<string[]>): Promise<{ values: string[]; error?: string }> {
  try {
    return { values: await p };
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : "ERROR";
    return NO_ANSWER_CODES.has(code) ? { values: [] } : { values: [], error: code };
  }
}

/** Ask the host's resolvers for the domain's A, AAAA and CNAME records. Never throws: a failure is `{error}`. */
export async function lookupDomainRecords(domain: string): Promise<ObservedDns> {
  if (override) return override(domain);
  if (process.env.VITEST) return { a: [], aaaa: [], cname: [], error: "resolver_unavailable" };
  const resolver = new Resolver({ timeout: config.webdevDns.timeoutMs, tries: 2 });
  const [a, aaaa, cname] = await Promise.all([
    settleLookup(resolver.resolve4(domain)),
    settleLookup(resolver.resolve6(domain)),
    settleLookup(resolver.resolveCname(domain)),
  ]);
  const error = a.error ?? aaaa.error ?? cname.error;
  return { a: a.values, aaaa: aaaa.values, cname: cname.values, ...(error ? { error } : {}) };
}
