// Domain expiry via RDAP (2026-09-29) — fills `monitors.domain_expires_at`, which had a column and a
// UI column since MON-00 but no writer at all, so every monitor showed an empty "Domain" cell.
//
// ── WHY THIS DOES NOT GO THROUGH THE EGRESS GUARD ─────────────────────────────────────────────────
// The guard exists because monitors dial TENANT-SUPPLIED hostnames. RDAP never does: the host we
// dial is a registry base URL taken from IANA's bootstrap file (https only), and the tenant's domain
// is only a validated path segment. A tenant cannot steer this request anywhere IANA did not list.
//
// ── COST ─────────────────────────────────────────────────────────────────────────────────────────
// The runner calls this at most once per monitor per day (`domain_checked_at`), and the bootstrap
// file once per process per day. Registrations change on a scale of years; daily is generous.

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8_000;

/** Suffixes registered at the SECOND level, where the registrable domain has three labels
 *  (`ypi.or.id`, not `or.id`). Not a full public-suffix list — the ones this estate's clients use,
 *  plus the common neighbours. An unknown one falls back to two labels, which at worst looks up the
 *  wrong name and gets no expiry: a missing date, never a wrong one. */
const SECOND_LEVEL = new Set([
  "co.id", "or.id", "ac.id", "go.id", "web.id", "my.id", "biz.id", "sch.id", "net.id", "ponpes.id",
  "co.uk", "org.uk", "com.au", "net.au", "org.au", "com.sg", "com.my", "co.nz", "co.jp", "com.br",
]);

/** The name a registry holds a record for: `www.shop.example.co.id` → `example.co.id`. */
export function registrableDomain(host: string): string | null {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes(".")) return null;
  if (/^\d+(\.\d+){3}$/.test(h)) return null; // an IP literal has no registration
  const labels = h.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  const take = SECOND_LEVEL.has(lastTwo) ? 3 : 2;
  if (labels.length < take) return null;
  return labels.slice(-take).join(".");
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

let bootstrap: { byTld: Map<string, string>; fetchedAt: number } | null = null;

/** Test seam: forget the cached bootstrap. */
export function resetRdapBootstrap(): void {
  bootstrap = null;
}

async function registryBase(tld: string, fetchImpl: FetchLike, nowMs: number): Promise<string | null> {
  if (!bootstrap || nowMs - bootstrap.fetchedAt > BOOTSTRAP_TTL_MS) {
    const res = await fetchImpl(BOOTSTRAP_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`RDAP bootstrap answered HTTP ${res.status}`);
    const body = (await res.json()) as { services?: [string[], string[]][] };
    const byTld = new Map<string, string>();
    for (const [tlds, urls] of body.services ?? []) {
      const base = (urls ?? []).find((u) => typeof u === "string" && u.startsWith("https://"));
      if (!base) continue;
      for (const t of tlds ?? []) byTld.set(String(t).toLowerCase(), base.endsWith("/") ? base : `${base}/`);
    }
    bootstrap = { byTld, fetchedAt: nowMs };
  }
  return bootstrap.byTld.get(tld) ?? null;
}

/** The registration's expiry for a registrable domain, or null when the registry has no RDAP
 *  service, no record, or no `expiration` event. Throws only on transport failure, which the runner
 *  records as "not checked" rather than as a date. */
export async function lookupDomainExpiry(
  domain: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  nowMs = Date.now(),
): Promise<Date | null> {
  const d = registrableDomain(domain);
  if (!d) return null;
  const base = await registryBase(d.split(".").pop() as string, fetchImpl, nowMs);
  if (!base) return null;
  const res = await fetchImpl(`${base}domain/${encodeURIComponent(d)}`, {
    // Some registries (Verisign) answer an empty body without the RDAP media type.
    headers: { accept: "application/rdap+json, application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`RDAP ${d} answered HTTP ${res.status}`);
  const body = (await res.json()) as { events?: { eventAction?: string; eventDate?: string }[] };
  const ev = (body.events ?? []).find((e) => e?.eventAction === "expiration" && e.eventDate);
  if (!ev) return null;
  const when = new Date(ev.eventDate as string);
  return Number.isNaN(when.getTime()) ? null : when;
}
