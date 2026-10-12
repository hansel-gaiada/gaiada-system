#!/usr/bin/env node
// MON-01 — generate Prometheus file_sd targets for CLIENT PROPERTIES from `search_properties`.
//
// ── M6-P3d: SUPERSEDED AS THE SHIPPER, KEPT AS THE REFERENCE ───────────────────────────────────
// gda-aicenter has no Node and no DB login that reads search_properties across tenants, so this
// script never ran there. The target file is now rendered by platform-nest
// (platform-nest/src/modules/monitoring/client-targets.ts), which ports isProbeableUrl()/toFileSd()
// below to TypeScript and reads across tenants under the same RLS scope as the monitoring runner.
// sumopod then pulls the file over a one-file forced-command SSH key
// (infra/scripts/pull-client-property-targets.sh). THIS FILE IS THE SPECIFICATION: the two copies
// are pinned together by platform-nest/src/modules/monitoring/client-targets-parity.test.ts, which
// imports isProbeableUrl and toFileSd from here and runs the same fixtures through both. Change
// the selection or label rules in one place and that test fails until the other follows.
// (Why not ONE shared file: the platform image is built from platform-nest/ alone and infra/ must
// not depend on platform-nest, so a shared module would have to live in a third package.)
//
// ── WHAT THIS UNLOCKS, AND WHY IT WAS THOUGHT BLOCKED ──────────────────────────────────────────
// The ~63 managed client properties are monitored by nobody. The portfolio program recorded this
// as blocked behind the observe-only ruling on `delphi`/`helios` — but that ruling gates *making
// changes on those hosts*, and this makes none. It is an outbound HTTP GET, the same thing any
// visitor does. Re-probed 2026-08-30: SSH to both hosts is filtered, HTTP and HTTPS answer. So
// uptime and TLS-expiry monitoring for the whole portfolio is available TODAY, on infrastructure
// that already exists, without touching a single client machine.
//
// ── THE CONSENT GATE IS THE POINT OF THIS FILE ─────────────────────────────────────────────────
// Scheduled requests to someone else's server is a permissions question, not a technical one.
// `search_properties.verified_at` exists precisely to answer it, and this generator emits a target
// ONLY for a property that is verified, active and not deleted. An unverified property is not
// probed — not throttled, not warned about: absent. The SQL below is the enforcement, and it is
// deliberately the simplest thing in the file so that nobody has to trust a comment.
//
// Private/loopback/link-local hosts are refused as well. A property row is client-supplied data,
// and a generator that will happily probe 169.254.169.254 because a row said so is an SSRF with a
// cron attached.
//
// ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────────
// It writes a file. It does not reload Prometheus, does not touch the running observability stack,
// and does not decide WHICH host should do the probing — that is a topology decision with an
// egress consequence (the prober reaches out to client domains, so it should not be the ERP box).
// See the companion job config for where it must be wired.
//
// Run:
//   DATABASE_URL=... node gen-client-property-targets.mjs --out /etc/prometheus/targets/clients.json
//   node gen-client-property-targets.mjs --selftest      # no DB, proves the filters actually filter

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

/** Hosts we refuse to probe regardless of what a row says. */
const PRIVATE_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local, incl. the cloud metadata endpoint
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique-local v6
  /\.internal$/i,
  /\.local$/i,
];

export function isProbeableUrl(siteUrl) {
  let u;
  try {
    u = new URL(siteUrl);
  } catch {
    return { ok: false, reason: "not a parseable URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `refusing protocol ${u.protocol}` };
  }
  if (PRIVATE_PATTERNS.some((re) => re.test(u.hostname))) {
    return { ok: false, reason: `refusing private/loopback host ${u.hostname}` };
  }
  return { ok: true };
}

/** The consent gate, as SQL. Verified, active, not deleted — nothing else is probed. */
export const PROBEABLE_SQL = `
  SELECT p.id, p.tenant_id, p.client_id, p.domain, p.site_url,
         p.hosting_provider, p.control_panel, p.stack
    FROM search_properties p
   WHERE p.verified_at IS NOT NULL
     AND p.status = 'active'
     AND p.deleted_at IS NULL
   ORDER BY p.domain
`;

/**
 * MON-04 / WSK-D36: same consent gate, same rows, plus `internal` from clients.is_internal so
 * client-facing dashboards can exclude our own sites. LEFT JOIN: a property whose client row is
 * missing is still probed (and labelled internal="false"). Used when the column exists; see
 * PROBEABLE_SQL for the fallback on a DB that predates migration 202610111100.
 */
export const PROBEABLE_WITH_INTERNAL_SQL = `
  SELECT p.id, p.tenant_id, p.client_id, p.domain, p.site_url,
         p.hosting_provider, p.control_panel, p.stack,
         COALESCE(c.is_internal, false) AS is_internal
    FROM search_properties p
    LEFT JOIN clients c ON c.id = p.client_id
   WHERE p.verified_at IS NOT NULL
     AND p.status = 'active'
     AND p.deleted_at IS NULL
   ORDER BY p.domain
`;

export function toFileSd(rows) {
  const targets = [];
  const skipped = [];
  for (const r of rows) {
    const verdict = isProbeableUrl(r.site_url);
    if (!verdict.ok) {
      skipped.push({ domain: r.domain, reason: verdict.reason });
      continue;
    }
    targets.push({
      targets: [r.site_url],
      labels: {
        // Kept deliberately small. Every label here is a time series dimension forever, and
        // per-property cardinality is already the expensive axis.
        property_domain: r.domain,
        tenant_id: String(r.tenant_id),
        client_id: String(r.client_id),
        // Missing/undefined (no column, no client row) is "false", never "unknown".
        internal: r.is_internal === true ? "true" : "false",
        ...(r.hosting_provider ? { hosting_provider: r.hosting_provider } : {}),
        ...(r.control_panel ? { control_panel: r.control_panel } : {}),
        ...(r.stack ? { stack: r.stack } : {}),
      },
    });
  }
  return { targets, skipped };
}

function selftest() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
    if (!cond) failed++;
  };

  check("a public https property becomes a target",
    toFileSd([{ domain: "a.test", site_url: "https://a.test", tenant_id: "t", client_id: "c" }]).targets.length === 1);

  check("THE SSRF CASE: a row naming the cloud metadata endpoint is refused",
    toFileSd([{ domain: "x", site_url: "http://169.254.169.254/latest/meta-data", tenant_id: "t", client_id: "c" }]).targets.length === 0);

  check("a private RFC1918 host is refused",
    toFileSd([{ domain: "x", site_url: "http://10.0.0.5", tenant_id: "t", client_id: "c" }]).targets.length === 0);

  check("localhost is refused",
    toFileSd([{ domain: "x", site_url: "http://localhost:8080", tenant_id: "t", client_id: "c" }]).targets.length === 0);

  check("a non-http scheme is refused",
    toFileSd([{ domain: "x", site_url: "file:///etc/passwd", tenant_id: "t", client_id: "c" }]).targets.length === 0);

  check("a skipped row is REPORTED, not silently dropped",
    toFileSd([{ domain: "x", site_url: "http://10.0.0.5", tenant_id: "t", client_id: "c" }]).skipped[0].reason.includes("private"));

  check("optional topology labels are omitted when unknown, not emitted as 'unknown'",
    Object.keys(toFileSd([{ domain: "a", site_url: "https://a.test", tenant_id: "t", client_id: "c" }]).targets[0].labels)
      .every((k) => !["hosting_provider", "control_panel", "stack"].includes(k)));

  check("the consent gate is in the SQL, not in a comment",
    /verified_at IS NOT NULL/.test(PROBEABLE_SQL) && /status = 'active'/.test(PROBEABLE_SQL));

  const lbl = (row) => toFileSd([{ domain: "a", site_url: "https://a.test", tenant_id: "t", client_id: "c", ...row }]).targets[0].labels.internal;
  check("internal=true when clients.is_internal is true", lbl({ is_internal: true }) === "true");
  check("internal=false when clients.is_internal is false", lbl({ is_internal: false }) === "false");
  check("internal=false when the column/client is missing (no sentinel yet)", lbl({}) === "false" && lbl({ is_internal: null }) === "false");
  check("the internal join is a LEFT JOIN and keeps the consent gate",
    /LEFT JOIN clients/.test(PROBEABLE_WITH_INTERNAL_SQL) && /verified_at IS NOT NULL/.test(PROBEABLE_WITH_INTERNAL_SQL)
    && /status = 'active'/.test(PROBEABLE_WITH_INTERNAL_SQL) && /deleted_at IS NULL/.test(PROBEABLE_WITH_INTERNAL_SQL));

  console.log(`\n  selftest: ${12 - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();

  const outIdx = process.argv.indexOf("--out");
  const out = outIdx > -1 ? process.argv[outIdx + 1] : null;
  if (!out) {
    console.error("usage: gen-client-property-targets.mjs --out <path.json> | --selftest");
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — refusing to run.");
    return 2;
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    let res;
    try {
      res = await client.query(PROBEABLE_WITH_INTERNAL_SQL);
    } catch (e) {
      // 42703 undefined_column / 42P01 undefined_table: DB predates clients.is_internal.
      if (e && (e.code === "42703" || e.code === "42P01")) {
        console.warn('[mon-01] clients.is_internal unavailable; labelling every target internal="false"');
        res = await client.query(PROBEABLE_SQL);
      } else throw e;
    }
    const { targets, skipped } = toFileSd(res.rows);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(targets, null, 2) + "\n");
    console.log(`[mon-01] wrote ${targets.length} probe target(s) to ${out} (from ${res.rows.length} consented propert(ies))`);
    // Never silent about what was dropped: a target that vanishes from monitoring without a line
    // in the log is indistinguishable from one that was never there.
    for (const s of skipped) console.warn(`[mon-01] SKIPPED ${s.domain}: ${s.reason}`);
    return 0;
  } finally {
    await client.end();
  }
}

// Run main() only when executed directly. platform-nest's parity test imports isProbeableUrl and
// toFileSd from this file, and an unconditional main() would call process.exit() inside that import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(`[mon-01] ${e.message}`);
    process.exit(1);
  });
}
