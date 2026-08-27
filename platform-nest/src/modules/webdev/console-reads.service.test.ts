// WSK-23 — the console read model, against LIVE Postgres (same posture WSK-12's own
// `zoneb-events-service.test.ts` documents: bypass the HTTP/Cerbos guard chain entirely to prove
// the DATA-LAYER guarantee — the third wall, the degrade tiers — independent of whatever Cerbos
// policy state happens to be loaded).
//
// ── THE TICKET'S OWN REQUIREMENT, PROVEN DIRECTLY ───────────────────────────────────────────────
// "Write a test that kills the upstream and asserts the response is explicitly flagged stale
// rather than empty-and-confident." That is
// `describe("getContractPinStatus — the three-tier degrade, proven by killing the upstream")`
// below: a real live success (tier 1), then the SAME provider made to throw and the cache still
// answering (tier 2), then no cache and a fact on file (tier 3), then genuinely nothing at all
// (tier 4) — and at every degraded tier, `stale: true` with a `source` that tells the caller WHICH
// kind of "not fresh" this is, never a bare empty/default value indistinguishable from "checked,
// nothing there".
//
// ASSUMES `WEBDEV_CONTROL_BASE_URL` IS UNSET in this test run (true for the throwaway Linux
// container this ticket's own verification uses) — `resolveConsoleProvider()` falls through to the
// REAL env-backed driver whenever no test override is set, and the "not configured" tier is only
// reachable when that real driver genuinely has no base URL. If a future CI environment sets that
// var globally, the "not configured" assertions below would need `providerOverride` reset to a
// stub that always throws instead of `null` — flagged here so that failure mode is legible.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { withTenants } from "../../db";
import { recordZoneBEvent } from "./zoneb-events.service";
import {
  getSiteRegistry, getReleaseHistory, getSubmissions,
  getContractPinStatus, listContractPinStatuses, setConsoleControlProviderForTests,
} from "./console-reads.service";
import { WebdevControlEgressError, type ContractBundleMeta, type WebdevControlProvider } from "../webdev-contracts/contract-fetch-provider";

function withWebdev<T>(tenantId: string, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["webdev"] });
}

async function insertSite(tenantId: string, slug: string): Promise<void> {
  await withWebdev(tenantId, (c) =>
    c.query(
      `INSERT INTO webdev_provisioned_sites (tenant_id, slug, framework, status, origin_site)
       VALUES ($1, $2, 'vite', 'requested', 'webdesk-test')`,
      [tenantId, slug],
    ),
  );
}

async function insertSnapshot(tenantId: string, slug: string, version: string): Promise<void> {
  await withWebdev(tenantId, (c) =>
    c.query(
      `INSERT INTO webdev_contract_snapshots
         (tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version, content_hash, artifacts, origin_site)
       VALUES ($1, $2, $3, '1.0.0', $4, '{}'::jsonb, 'webdesk-test')`,
      [tenantId, slug, version, `sha256:${"a".repeat(64)}`],
    ),
  );
}

function fixtureProvider(version: string, vocabularyVersion = "1.0.0"): WebdevControlProvider {
  const meta: ContractBundleMeta = {
    version, vocabularyVersion,
    blockLibrary: { package: "@gaiada/webdesk-blocks", version: "1.0.0", range: "^1.0" },
    artifacts: { sdkTsUrl: "fixture://sdk", sdkPhpUrl: null, openapiUrl: "fixture://openapi", contractMdUrl: "fixture://md" },
    contentHash: `sha256:${"b".repeat(64)}`,
    generatedAt: new Date().toISOString(),
  };
  return { key: "fixture-live", getContractBundle: async () => meta, downloadArtifact: async () => Buffer.from("") };
}

const deadProvider: WebdevControlProvider = {
  key: "fixture-dead",
  getContractBundle: async () => { throw new WebdevControlEgressError("simulated upstream kill"); },
  downloadArtifact: async () => { throw new WebdevControlEgressError("simulated upstream kill"); },
};

describe.skipIf(!TEST_URL)("WSK-23 · console read model (live Postgres)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await initTestDb();
    tenantA = await createCompany("WSK-23 Tenant A", ["webdev"]);
    tenantB = await createCompany("WSK-23 Tenant B", ["webdev"]);
  });
  afterAll(async () => {
    setConsoleControlProviderForTests(null);
    await teardownTestDb();
  });
  beforeEach(() => {
    setConsoleControlProviderForTests(null);
  });

  describe("getSiteRegistry — reuses listProvisionedSites, attaches facts, never claims 'live'", () => {
    it("a brand-new tenant with no sites and no facts is honestly 'unavailable', not an empty-and-confident list", async () => {
      const fresh = await createCompany("WSK-23 Fresh Tenant", ["webdev"]);
      const result = await getSiteRegistry(fresh);
      expect(result.sites).toEqual([]);
      expect(result.meta).toMatchObject({ stale: true, source: "unavailable", asOf: null });
    });

    it("attaches the LATEST deploy/promote/rollback fact per site slug, always marked stale (no live env-status endpoint exists)", async () => {
      await insertSite(tenantA, "acme-reg");
      await recordZoneBEvent(tenantA, {
        eventId: "reg-deploy-1", kind: "deploy.done", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(), data: { siteSlug: "acme-reg", envId: "staging", version: "1.0.0" },
      });
      await recordZoneBEvent(tenantA, {
        eventId: "reg-deploy-2", kind: "deploy.done", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(), data: { siteSlug: "acme-reg", envId: "staging", version: "1.1.0" },
      });
      await recordZoneBEvent(tenantA, {
        eventId: "reg-promote-1", kind: "promote.done", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(), data: { siteSlug: "acme-reg", envId: "production", version: "1.0.0" },
      });

      const result = await getSiteRegistry(tenantA);
      const row = result.sites.find((s) => s.slug === "acme-reg");
      expect(row).toBeTruthy();
      // The SECOND deploy.done fact (1.1.0) is the latest, not the first — proves ordering, not just presence.
      expect(row!.lastKnownDeployment).toMatchObject({ kind: "deploy.done", data: { version: "1.1.0" } });
      expect(row!.lastKnownPromotion).toMatchObject({ kind: "promote.done", data: { version: "1.0.0" } });
      expect(row!.lastKnownRollback).toBeNull();
      expect(result.meta).toMatchObject({ stale: true, source: "facts" });
      expect(result.meta.asOf).toBeTruthy();
    });

    it("THIRD WALL: tenant B's facts never attach to tenant A's site rows (RLS, cross-tenant)", async () => {
      await insertSite(tenantB, "acme-reg"); // same slug, different tenant, on purpose
      await recordZoneBEvent(tenantB, {
        eventId: "reg-b-deploy", kind: "deploy.done", tenantId: tenantB, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(), data: { siteSlug: "acme-reg", version: "9.9.9" },
      });
      const resultA = await getSiteRegistry(tenantA);
      const rowA = resultA.sites.find((s) => s.slug === "acme-reg");
      expect(rowA!.lastKnownDeployment?.data.version).not.toBe("9.9.9");
    });
  });

  describe("getReleaseHistory / getSubmissions — slug-scoped fact reads, always honestly stale", () => {
    it("releases: filters by slug, newest-first, empty (not error) when nothing matches", async () => {
      await recordZoneBEvent(tenantA, {
        eventId: "rel-1", kind: "rollback.done", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(), data: { siteSlug: "rel-site", toVersion: "1.0.0" },
      });
      const hit = await getReleaseHistory(tenantA, "rel-site");
      expect(hit.releases).toHaveLength(1);
      expect(hit.releases[0]).toMatchObject({ kind: "rollback.done" });
      expect(hit.meta).toMatchObject({ stale: true, source: "facts" });

      const miss = await getReleaseHistory(tenantA, "no-such-slug");
      expect(miss.releases).toEqual([]);
      expect(miss.meta).toMatchObject({ stale: true, source: "unavailable", asOf: null });
    });

    it("submissions: SLIM PROJECTION ONLY — no field beyond submissionId/formId/hasAttachments/receivedAt ever appears, even if a payload smuggled one", async () => {
      await recordZoneBEvent(tenantA, {
        eventId: "sub-1", kind: "form.received", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(),
        // A payload that (hypothetically, against the schema's own validator upstream) smuggled a
        // PII-shaped field — proves this read projects it away rather than trusting the payload shape.
        data: { siteSlug: "sub-site", formId: "contact", submissionId: "s-1", hasAttachments: true, email: "leaked@example.com" },
      });
      const result = await getSubmissions(tenantA, "sub-site");
      expect(result.submissions).toEqual([
        { submissionId: "s-1", formId: "contact", hasAttachments: true, receivedAt: expect.any(String) },
      ]);
      expect(JSON.stringify(result.submissions)).not.toContain("leaked@example.com");
      expect(result.meta).toMatchObject({ stale: true, source: "facts" });
    });

    it("submissions: formId narrows the result", async () => {
      await recordZoneBEvent(tenantA, {
        eventId: "sub-2", kind: "form.received", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(),
        data: { siteSlug: "sub-site-2", formId: "newsletter", submissionId: "s-2", hasAttachments: false },
      });
      await recordZoneBEvent(tenantA, {
        eventId: "sub-3", kind: "form.received", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(),
        data: { siteSlug: "sub-site-2", formId: "contact", submissionId: "s-3", hasAttachments: false },
      });
      const narrowed = await getSubmissions(tenantA, "sub-site-2", "newsletter");
      expect(narrowed.submissions.map((s) => s.submissionId)).toEqual(["s-2"]);
    });
  });

  describe("getContractPinStatus — the three-tier degrade, proven by killing the upstream", () => {
    it("tier 4: nothing configured, no cache, no fact -> 'unavailable', explicitly flagged, never a fabricated version", async () => {
      const status = await getContractPinStatus(tenantA, "pin-fresh");
      expect(status.pinned).toBeNull();
      expect(status.latest).toMatchObject({ version: null, stale: true, source: "unavailable", asOf: null });
    });

    it("tier 3: no live source, no cache, but a contract.published FACT exists -> serves it, marked stale", async () => {
      await recordZoneBEvent(tenantA, {
        eventId: "pub-1", kind: "contract.published", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(), data: { slug: "pin-facts", contractVersion: "1.2.0", vocabularyVersion: "1.1.0" },
      });
      const status = await getContractPinStatus(tenantA, "pin-facts");
      expect(status.latest).toMatchObject({ version: "1.2.0", vocabularyVersion: "1.1.0", stale: true, source: "facts" });
      expect(status.latest.asOf).toBeTruthy();
    });

    it("tier 1: a genuinely live provider answers fresh -> stale:false, source:'live', and populates the cache", async () => {
      setConsoleControlProviderForTests(fixtureProvider("2.0.0", "1.5.0"));
      const status = await getContractPinStatus(tenantA, "pin-live");
      expect(status.latest).toMatchObject({ version: "2.0.0", vocabularyVersion: "1.5.0", stale: false, source: "live" });
    });

    it("THE REQUIRED TEST: kill the upstream after a successful live read -> tier 2 (cache), still stale:true, NEVER empty-and-confident", async () => {
      // Establish a real cache entry via a genuinely successful live call, same as production would.
      setConsoleControlProviderForTests(fixtureProvider("3.0.0", "1.6.0"));
      const live = await getContractPinStatus(tenantA, "pin-kill");
      expect(live.latest).toMatchObject({ version: "3.0.0", stale: false, source: "live" });

      // KILL THE UPSTREAM. Same tenant+slug, called again immediately (within the cache TTL).
      setConsoleControlProviderForTests(deadProvider);
      const degraded = await getContractPinStatus(tenantA, "pin-kill");
      expect(degraded.latest).toMatchObject({
        version: "3.0.0", vocabularyVersion: "1.6.0", // the LAST GOOD value, not wiped to null
        stale: true, source: "cache", reason: "control_channel_egress_error",
      });
      // The falsifiable claim this whole ticket is about: a dead upstream must never look identical
      // to "checked, and there is genuinely nothing" (tier 4's shape).
      expect(degraded.latest.source).not.toBe("unavailable");
      expect(degraded.latest.version).not.toBeNull();
    });

    it("tier 2 -> tier 3 handoff: once the cache has nothing (fresh slug) and the upstream is dead, a fact still answers", async () => {
      await recordZoneBEvent(tenantA, {
        eventId: "pub-2", kind: "contract.published", tenantId: tenantA, originSite: "webdesk-test",
        occurredAt: new Date().toISOString(), data: { siteSlug: "pin-dead-with-fact", contractVersion: "0.9.0", vocabularyVersion: "0.9.0" },
      });
      setConsoleControlProviderForTests(deadProvider); // never had a live success for THIS slug -> no cache entry
      const status = await getContractPinStatus(tenantA, "pin-dead-with-fact");
      expect(status.latest).toMatchObject({ version: "0.9.0", stale: true, source: "facts", reason: "control_channel_egress_error" });
    });

    it("'pinned' is Zone A's own already-fetched snapshot — a plain DB read, present even when 'latest' is fully degraded", async () => {
      await insertSnapshot(tenantA, "pin-with-snapshot", "1.0.0");
      setConsoleControlProviderForTests(deadProvider);
      const status = await getContractPinStatus(tenantA, "pin-with-snapshot");
      expect(status.pinned).toMatchObject({ contractVersion: "1.0.0", vocabularyVersion: "1.0.0" });
      expect(status.latest.source).not.toBe("live"); // degraded independently of pinned being present
    });

    it("listContractPinStatuses(): no ?slug -> every distinct webdesk_tenant_slug this tenant has ever snapshotted, deduped", async () => {
      await insertSnapshot(tenantA, "list-a", "1.0.0");
      await insertSnapshot(tenantA, "list-a", "2.0.0"); // same slug, second version -> must not double-count
      await insertSnapshot(tenantA, "list-b", "1.0.0");
      const all = await listContractPinStatuses(tenantA);
      const slugs = all.map((p) => p.webdeskTenantSlug).filter((s) => s === "list-a" || s === "list-b");
      expect(slugs.sort()).toEqual(["list-a", "list-b"]);
    });
  });
});
