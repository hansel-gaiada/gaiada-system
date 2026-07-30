// SM-49 AC 9 (tracker §6u; design addendum §A10.4, binding) — the repointed-base-URL boot guard's
// pure predicate + assertion, consulted by main.ts's LIVE branch before any vendor
// create*ProviderFromConfig() call.
//
// THE HAZARD THIS CLOSES, NAMED PLAINLY: `SEARCH_PROVIDER_MODE=live` plus a vendor `*_BASE_URL`
// repointed at a private/loopback/internal host boots cleanly today and mints `simulated = false`
// ledger/cache rows from whatever answers there — a "live" deployment pointed at a fake endpoint,
// producing rows indistinguishable from real vendor data to every downstream reader (console badges,
// budget sums, exports). This predicate is what main.ts's live branch checks BEFORE calling any of
// the three vendor factories, so that one env-var typo (or SM-49's own sandbox, or local
// experimentation, all pointed at 127.0.0.1) cannot mint an unlabelled fake row by accident.
//
// ACCIDENT GUARD, NOT AN AUTHORIZATION CONTROL — say this as plainly as the addendum does: this is a
// LEXICAL check on the configured base URL's HOSTNAME STRING. It never performs DNS resolution, so a
// public-looking DNS name that happens to resolve to a private address sails through untouched, and
// an operator who genuinely wants `live` mode pointed at a private endpoint (a corporate proxy, an
// SSH tunnel, SM-49's own sandbox, or local experimentation) can do so with one override env var
// (SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL=1). Claiming this predicate defends against a deliberate
// adversary would be exactly the kind of overclaim this module's design addendum keeps catching in
// vendor-fact claims (§A10.5) — so this file states its own limit instead of dressing up a lexical
// check as an authz boundary.
//
// OWNERSHIP NOTE: SM-48 owns config.ts and the env/compose files this wave, so the override flag is
// read directly from `process.env` by main.ts (not threaded through `config.search`) — see main.ts's
// own comment at the call site. TODO(follow-up): fold SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL into
// config.ts alongside the rest of config.search once that file's ownership frees up, and document the
// override in .env.example as proxy/tunnel-only (also owed to that follow-up — SM-48 owns that file
// this wave too).
export interface PrivateBaseUrlCheck {
  isPrivate: boolean;
  /** Populated exactly when isPrivate is true — surfaced verbatim in the boot error. */
  reason?: string;
}

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d|0)";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

// Hostname suffixes reserved (or conventionally used) for private/internal purposes — never a real
// vendor's public API host. `.test` is IANA-reserved (RFC 2606); `.internal`/`.lan`/`.home.arpa` are
// the common private-network conventions this predicate is explicitly named after (§A10.4).
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".test", ".lan", ".home.arpa"];

function ipv4PrivateReason(host: string): string | null {
  if (!IPV4_RE.test(host)) return null;
  const [a, b] = host.split(".").map(Number);
  if (a === 127) return "loopback literal (127.0.0.0/8)";
  if (a === 10) return "RFC1918 private literal (10.0.0.0/8)";
  if (a === 172 && b >= 16 && b <= 31) return "RFC1918 private literal (172.16.0.0/12)";
  if (a === 192 && b === 168) return "RFC1918 private literal (192.168.0.0/16)";
  if (a === 169 && b === 254) return "link-local literal (169.254.0.0/16)";
  if (a === 0) return "unspecified literal (0.0.0.0/8)";
  return null;
}

/** Pure lexical check: does `baseUrl`'s hostname look like it names a private/loopback/internal
 *  destination? Never performs DNS resolution (see file header). An unparseable URL is treated as
 *  private too — a boot-time config value that cannot even be parsed as a URL is unfit to be a live
 *  vendor endpoint under any interpretation, so refusing it fail-closed costs nothing real. */
export function checkPrivateVendorBaseUrl(baseUrl: string): PrivateBaseUrlCheck {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { isPrivate: true, reason: `unparseable URL ('${baseUrl}')` };
  }
  // Trailing-dot FQDN normalization ("localhost." names the same host as "localhost" per DNS
  // convention) and IPv6-bracket stripping — WHATWG `URL.hostname` keeps the surrounding `[...]` on
  // this Node/V8 version for a bracketed IPv6 literal (confirmed directly, not assumed), so a literal
  // `:` check below would otherwise miss `[::1]` entirely.
  const rawHost = url.hostname.toLowerCase().replace(/\.$/, "");
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  if (host === "localhost") return { isPrivate: true, reason: "loopback hostname ('localhost')" };

  // IPv6 literals contain ':' (a character never valid in a DNS hostname), so this check can never
  // misfire against a real domain name — unlike a bare `startsWith("fc")`, which would wrongly flag a
  // domain like "fc-vendor.example.com".
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return { isPrivate: true, reason: `IPv6 loopback/unspecified literal ('${host}')` };
    if (/^fe80:/.test(host)) return { isPrivate: true, reason: `IPv6 link-local literal ('${host}')` };
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return { isPrivate: true, reason: `IPv6 unique-local literal ('${host}')` };
    return { isPrivate: false }; // any other IPv6 literal is out of this lexical check's scope
  }

  const ipv4Reason = ipv4PrivateReason(host);
  if (ipv4Reason) return { isPrivate: true, reason: `${ipv4Reason} ('${host}')` };

  for (const suffix of PRIVATE_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) {
      return { isPrivate: true, reason: `private-suffix hostname ('${host}')` };
    }
  }

  // A single-label hostname (no dot at all) is the shape of a Docker/Kubernetes service name
  // ("semrush-proxy", "mockserver") — never a real public vendor host, which always has at least one
  // dot (a registrable domain + TLD).
  if (!host.includes(".")) {
    return { isPrivate: true, reason: `single-label hostname ('${host}') — looks like a container/service name, not a public vendor host` };
  }

  return { isPrivate: false };
}

/** The env var main.ts reads directly (not through config.ts — see file header). Exported so the
 *  guard's own tests and main.ts's boot-error message share one string literal. */
export const SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL_ENV = "SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL";

export interface VendorBaseUrls {
  dataforseo: string;
  semrush: string;
  ahrefs: string;
}

/** Thrown by assertLiveVendorBaseUrlsAreNotPrivate — a distinct class so a future caller (or a test)
 *  can distinguish this boot refusal from any other startup error. */
export class PrivateVendorBaseUrlError extends Error {
  constructor(readonly vendor: string, readonly baseUrl: string, readonly reason: string) {
    super(
      `[search] BOOT ERROR: SEARCH_PROVIDER_MODE=live but the '${vendor}' base URL ('${baseUrl}') looks ` +
        `private (${reason}) — a live deployment must not point a vendor base URL at a private/` +
        "loopback/internal host (design addendum §A10.4: this is an ACCIDENT guard, not an authz " +
        "control — it is a lexical check, trivially bypassable by a public DNS name that resolves " +
        `privately). Set ${SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL_ENV}=1 to override for a genuine proxy/` +
        "tunnel deployment, SM-49's vendor-envelope sandbox harness, or local experimentation.",
    );
    this.name = "PrivateVendorBaseUrlError";
  }
}

/** The whole guard, as ONE call main.ts's live branch makes before any vendor factory call (SM-49
 *  AC 9). Deliberately unconditional across all three vendors — NOT gated on whether that vendor's
 *  credentials are even configured — because the override is explicitly meant to also cover "local
 *  experimentation" (§A10.4/§A10's SM-49 file-ownership note), which by definition may have no
 *  credentials set yet. Kept as a single exported, directly-testable function (rather than inlined in
 *  main.ts) so a test can prove it throws/doesn't-throw without booting the whole Nest app — see this
 *  module's own test file, which also statically pins that main.ts actually calls it (the mutation
 *  probe: deleting the call site in main.ts turns that pin red). */
export function assertLiveVendorBaseUrlsAreNotPrivate(baseUrls: VendorBaseUrls, allowOverride: boolean): void {
  if (allowOverride) return;
  const entries: Array<[string, string]> = [
    ["dataforseo", baseUrls.dataforseo],
    ["semrush", baseUrls.semrush],
    ["ahrefs", baseUrls.ahrefs],
  ];
  for (const [vendor, baseUrl] of entries) {
    const check = checkPrivateVendorBaseUrl(baseUrl);
    if (check.isPrivate) {
      throw new PrivateVendorBaseUrlError(vendor, baseUrl, check.reason ?? "unspecified");
    }
  }
}
