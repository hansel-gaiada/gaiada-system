// WSK-19 — against LIVE Postgres (RLS, FORCE, third wall), proving the two tripwires the ticket is
// FOR, plus the immutability trigger and the ordinary idempotent-replay / fresh-version paths.
//
// ── WHAT THIS SUITE IS TRYING TO FALSIFY ────────────────────────────────────────────────────────
//   1. A hash mismatch against Zone B's OWN claim is refused with ZERO database writes (tripwire a).
//   2. An existing (tenant, slug, version) row whose recomputed hash DIFFERS is refused AND alerted
//      — an outbox event + a severity:"critical" activity row — not merely answered with a status
//      code (tripwire b). The ORIGINAL row is left untouched.
//   3. A same-version, same-hash re-fetch is an honest no-op (idempotent), not a duplicate row and
//      not a false positive on either tripwire.
//   4. The table is immutable BY CONSTRUCTION: a direct UPDATE or DELETE — even as the migrating/
//      owning role — is refused by the trigger, not merely "the app never does it".
//   5. Third-wall RLS: a read declaring no module scope sees ZERO rows, silently (WD-23A-1).
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { withTenants } from "../../db";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import type { ContractBundleMeta, WebdevControlProvider } from "./contract-fetch-provider";
import { computeContentHash, refreshContractSnapshot, listContractSnapshots } from "./contract-snapshot.service";

let tenant: string;
let otherTenant: string;
let manager: string;

const SLUG = "acme";

/** Deterministic fixture artifact bytes, distinguishable per "generation" so a test can prove two
 *  fetches genuinely produced DIFFERENT bytes rather than reusing a fixture by accident. */
function artifactSet(seed: string) {
  return {
    sdkTs: Buffer.from(`export const sdk = "${seed}-ts";`),
    openapi: Buffer.from(JSON.stringify({ openapi: "3.0.0", info: { title: seed } })),
    contractMd: Buffer.from(`# Contract\n\nseed: ${seed}\n`),
    sdkPhp: null as Buffer | null,
  };
}

/** A fake `WebdevControlProvider` — no real Zone B, no real HTTP. `getContractBundle` returns a bundle
 *  whose `contentHash` is computed from the SAME `computeContentHash()` the service itself uses,
 *  which is the honest way to construct a "Zone B told the truth" fixture: this is not testing
 *  `computeContentHash` twice, it is testing that the SERVICE recomputes and compares rather than
 *  trusting the claim, which the mismatch test below proves by deliberately lying in the claim. */
function fakeProvider(opts: {
  version: string;
  artifacts: ReturnType<typeof artifactSet>;
  claimedHashOverride?: string;
  /** M6-P4b0 - the block-library tarball WebDesk would serve; omitted = an older pointer (blockLibraryUrl null). */
  blockLibrary?: Buffer;
  /** Serve the PHP SDK too. */
  sdkPhp?: Buffer;
  /** M6-P4b0b - WebDesk's claim of the tarball's sha256. Omitted = the honest claim (the real sha256 of `blockLibrary`,
   *  or null when there is no tarball); `null` = no claim (an older WebDesk); a string = that exact (possibly false) claim. */
  blockLibrarySha256?: string | null;
}): WebdevControlProvider {
  const withPhp = { ...opts.artifacts, sdkPhp: opts.sdkPhp ?? opts.artifacts.sdkPhp };
  const { manifest, contentHash } = computeContentHash(withPhp);
  void manifest;
  const meta: ContractBundleMeta = {
    version: opts.version,
    vocabularyVersion: "1.2.0",
    blockLibrary: { package: "@gaiada/webdesk-blocks", version: "1.3.2", range: "^1.3" },
    artifacts: {
      sdkTsUrl: "https://fixture.invalid/sdk.ts.tgz",
      sdkPhpUrl: withPhp.sdkPhp ? "https://fixture.invalid/sdk.php" : null,
      openapiUrl: "https://fixture.invalid/openapi.v1.json",
      contractMdUrl: "https://fixture.invalid/CONTENT-CONTRACT.md",
      blockLibraryUrl: opts.blockLibrary ? "https://fixture.invalid/gaiada-webdesk-blocks-1.3.2.tgz" : null,
      blockLibrarySha256: opts.blockLibrarySha256 !== undefined
        ? opts.blockLibrarySha256
        : opts.blockLibrary ? createHash("sha256").update(opts.blockLibrary).digest("hex") : null,
    },
    contentHash: opts.claimedHashOverride ?? contentHash,
    generatedAt: new Date().toISOString(),
  };
  const byUrl: Record<string, Buffer> = {
    "https://fixture.invalid/sdk.ts.tgz": opts.artifacts.sdkTs,
    "https://fixture.invalid/openapi.v1.json": opts.artifacts.openapi,
    "https://fixture.invalid/CONTENT-CONTRACT.md": opts.artifacts.contractMd,
  };
  if (withPhp.sdkPhp) byUrl["https://fixture.invalid/sdk.php"] = withPhp.sdkPhp;
  if (opts.blockLibrary) byUrl["https://fixture.invalid/gaiada-webdesk-blocks-1.3.2.tgz"] = opts.blockLibrary;
  return {
    key: "fixture",
    getContractBundle: async () => meta,
    downloadArtifact: async (url: string) => {
      const b = byUrl[url];
      if (!b) throw new Error(`fixture provider: no artifact registered for ${url}`);
      return b;
    },
  };
}

async function storedSnapshots(tenantId: string, slug: string) {
  const r = await adminPool().query(
    `SELECT id, contract_version, content_hash, artifacts FROM webdev_contract_snapshots
      WHERE tenant_id = $1 AND webdesk_tenant_slug = $2 ORDER BY fetched_at`,
    [tenantId, slug],
  );
  return r.rows as Array<{ id: string; contract_version: string; content_hash: string; artifacts: Record<string, unknown> }>;
}

async function outboxFor(entityId: string) {
  const r = await adminPool().query(
    `SELECT event_type, payload FROM outbox_events WHERE entity_id = $1 ORDER BY created_at`,
    [entityId],
  );
  return r.rows as Array<{ event_type: string; payload: Record<string, unknown> }>;
}

async function activitiesFor(entityId: string) {
  const r = await adminPool().query(
    `SELECT verb, metadata FROM activities WHERE target_entity_id = $1 ORDER BY occurred_at`,
    [entityId],
  );
  return r.rows as Array<{ verb: string; metadata: Record<string, unknown> }>;
}

describe.skipIf(!TEST_URL)("WSK-19 — contract-snapshot mirror: the two tripwires + immutability", () => {
  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("WSK19 Tenant", ["webdev"]);
    otherTenant = await createCompany("WSK19 Other Tenant", ["webdev"]);
    manager = await createUser("wsk19-mgr@a.test", "Manager Nineteen");
    await addMembership(tenant, manager);
    await addMembership(otherTenant, manager);
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("fresh version: creates one row, stores 3 artifacts as files, and the recomputed hash matches what is stored", async () => {
    const provider = fakeProvider({ version: "1.0.0", artifacts: artifactSet("gen1") });
    const outcome = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider });

    expect(outcome.outcome).toBe("created");
    if (outcome.outcome !== "created") throw new Error("unreachable");
    expect(outcome.snapshot.contractVersion).toBe("1.0.0");
    expect(outcome.snapshot.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const rows = await storedSnapshots(tenant, SLUG);
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe(outcome.snapshot.contentHash);
    const artifacts = rows[0].artifacts as { sdkTs: string; sdkPhp: string | null; openapi: string; contractMd: string };
    expect(artifacts.sdkTs).toBeTruthy();
    expect(artifacts.openapi).toBeTruthy();
    expect(artifacts.contractMd).toBeTruthy();
    expect(artifacts.sdkPhp).toBeNull();

    // The files subsystem really holds 3 rows for this snapshot, plain tenant wall (0009).
    const files = await adminPool().query(
      `SELECT filename, byte_size FROM files WHERE tenant_id = $1 AND target_entity_type = 'webdev_contract_snapshot' AND target_entity_id = $2`,
      [tenant, rows[0].id],
    );
    expect(files.rowCount).toBe(3);

    const events = await outboxFor(rows[0].id);
    expect(events.some((e) => e.event_type === "webdev.contract.snapshotted")).toBe(true);
  });

  it("idempotent replay: same version, same bytes -> no new row, original returned unchanged", async () => {
    const artifacts = artifactSet("gen-idem");
    const provider = fakeProvider({ version: "1.1.0", artifacts });
    const first = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider });
    expect(first.outcome).toBe("created");

    const before = await storedSnapshots(tenant, SLUG);
    const countBefore = before.length;

    const replayProvider = fakeProvider({ version: "1.1.0", artifacts }); // identical bytes, fresh call
    const second = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: replayProvider });
    expect(second.outcome).toBe("idempotent");
    if (second.outcome !== "idempotent") throw new Error("unreachable");
    if (first.outcome !== "created") throw new Error("unreachable");
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(second.snapshot.contentHash).toBe(first.snapshot.contentHash);

    const after = await storedSnapshots(tenant, SLUG);
    expect(after.length).toBe(countBefore); // no new row
  });

  it("TRIPWIRE (a): hash mismatch against Zone B's own claim is refused with ZERO database writes", async () => {
    const artifacts = artifactSet("gen-mismatch");
    const provider = fakeProvider({
      version: "2.0.0",
      artifacts,
      claimedHashOverride: "sha256:0000000000000000000000000000000000000000000000000000000000000",
    });

    const before = await storedSnapshots(tenant, SLUG);

    const outcome = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider });
    expect(outcome.outcome).toBe("hash_mismatch");
    if (outcome.outcome !== "hash_mismatch") throw new Error("unreachable");
    expect(outcome.claimedHash).toBe("sha256:0000000000000000000000000000000000000000000000000000000000000");
    expect(outcome.recomputedHash).not.toBe(outcome.claimedHash);
    expect(outcome.contractVersion).toBe("2.0.0");

    const after = await storedSnapshots(tenant, SLUG);
    expect(after.length).toBe(before.length); // no row written for the mismatched version

    const stillNone = after.filter((r) => r.contract_version === "2.0.0");
    expect(stillNone).toHaveLength(0);
  });

  it("TRIPWIRE (b): DETERMINISM BREACH — a repeat fetch of the SAME version with DIFFERENT bytes is refused, alerted, and leaves the original row untouched", async () => {
    const firstArtifacts = artifactSet("gen-breach-A");
    const providerA = fakeProvider({ version: "3.0.0", artifacts: firstArtifacts });
    const first = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: providerA });
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") throw new Error("unreachable");
    const originalHash = first.snapshot.contentHash;

    // A DIFFERENT byte sequence for the SAME (tenant, slug, version) — a Zone B whose codegen
    // genuinely drifted between two "same version" fetches. Its OWN claimed hash is internally
    // consistent with these new bytes (computeContentHash of the SAME artifacts), so tripwire (a)
    // passes — this is exactly what makes it a determinism breach and not a transport error.
    const secondArtifacts = artifactSet("gen-breach-B");
    const providerB = fakeProvider({ version: "3.0.0", artifacts: secondArtifacts });

    const outcome = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: providerB });
    expect(outcome.outcome).toBe("determinism_breach");
    if (outcome.outcome !== "determinism_breach") throw new Error("unreachable");
    expect(outcome.existingSnapshotId).toBe(first.snapshot.id);
    expect(outcome.existingHash).toBe(originalHash);
    expect(outcome.recomputedHash).not.toBe(originalHash);
    expect(outcome.contractVersion).toBe("3.0.0");

    // The original row is UNTOUCHED — immutability, restated.
    const rows = await storedSnapshots(tenant, SLUG);
    const v3rows = rows.filter((r) => r.contract_version === "3.0.0");
    expect(v3rows).toHaveLength(1); // still exactly one row for this version — no second row either
    expect(v3rows[0].content_hash).toBe(originalHash);

    // ALERTED, not merely a 4xx: an outbox event AND a severity:"critical" activity row.
    const events = await outboxFor(first.snapshot.id);
    const breachEvents = events.filter((e) => e.event_type === "webdev.contract.determinism_breach");
    expect(breachEvents).toHaveLength(1);
    expect(breachEvents[0].payload).toMatchObject({
      webdeskTenantSlug: SLUG, contractVersion: "3.0.0",
      existingHash: originalHash, recomputedHash: outcome.recomputedHash,
    });

    const activities = await activitiesFor(first.snapshot.id);
    const breachActivity = activities.filter((a) => a.verb === "determinism_breach_detected");
    expect(breachActivity).toHaveLength(1);
    expect(breachActivity[0].metadata).toMatchObject({ severity: "critical", contractVersion: "3.0.0" });
  });

  it("IMMUTABILITY: a direct UPDATE (even as the migrating role) is refused by the trigger, not merely absent from the app", async () => {
    const provider = fakeProvider({ version: "4.0.0", artifacts: artifactSet("gen-immutable") });
    const outcome = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider });
    expect(outcome.outcome).toBe("created");
    if (outcome.outcome !== "created") throw new Error("unreachable");

    await expect(
      adminPool().query(`UPDATE webdev_contract_snapshots SET content_hash = 'sha256:deadbeef' WHERE id = $1`, [outcome.snapshot.id]),
    ).rejects.toThrow(/WEBDEV_CONTRACT_SNAPSHOT_IMMUTABLE/);

    await expect(
      adminPool().query(`DELETE FROM webdev_contract_snapshots WHERE id = $1`, [outcome.snapshot.id]),
    ).rejects.toThrow(/WEBDEV_CONTRACT_SNAPSHOT_IMMUTABLE/);

    const rows = await storedSnapshots(tenant, SLUG);
    const stillThere = rows.find((r) => r.id === outcome.snapshot.id);
    expect(stillThere).toBeDefined();
    expect(stillThere!.content_hash).toBe(outcome.snapshot.contentHash); // unchanged by the failed UPDATE
  });

  it("M6-P4b0: the block library is mirrored as the fifth artifact, hashed beside the manifest, and contentHash is the same with or without it", async () => {
    const artifacts = artifactSet("gen-blocks");
    const php = Buffer.from("<?php // sdk");
    const tarball = Buffer.from("fake gzip bytes of the block library");
    const withBlocks = await refreshContractSnapshot({
      tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: fakeProvider({ version: "6.0.0", artifacts, blockLibrary: tarball, sdkPhp: php }),
    });
    expect(withBlocks.outcome).toBe("created");
    if (withBlocks.outcome !== "created") throw new Error("unreachable");

    // The hashed manifest is unchanged: the same four artifacts hash to the same contentHash whether or not a library rides along.
    expect(withBlocks.snapshot.contentHash).toBe(computeContentHash({ ...artifacts, sdkPhp: php }).contentHash);

    const row = (await storedSnapshots(tenant, SLUG)).find((r) => r.contract_version === "6.0.0")!;
    const a = row.artifacts as Record<string, unknown> & { hashes: Record<string, string | null> };
    expect(typeof a.blockLibraryFile).toBe("string");
    expect(a.blockLibrary).toEqual({ package: "@gaiada/webdesk-blocks", version: "1.3.2", range: "^1.3" }); // the ref keeps its key
    expect(a.hashes.blockLibrary).toBe(createHash("sha256").update(tarball).digest("hex"));
    expect(Object.keys(a.hashes).sort()).toEqual(["blockLibrary", "contractMd", "openapi", "sdkPhp", "sdkTs"]);

    const files = await adminPool().query<{ filename: string; content_type: string }>(
      `SELECT filename, content_type FROM files WHERE tenant_id = $1 AND target_entity_type = 'webdev_contract_snapshot' AND target_entity_id = $2 ORDER BY filename`,
      [tenant, row.id],
    );
    // The SDK files carry their real labels; the tarball is gzip.
    expect(files.rows).toEqual([
      { filename: "CONTENT-CONTRACT.md", content_type: "text/markdown" },
      { filename: "gaiada-webdesk-blocks-1.3.2.tgz", content_type: "application/gzip" },
      { filename: "openapi.v1.json", content_type: "application/json" },
      { filename: "sdk.d.ts", content_type: "text/plain" },
      { filename: "sdk.php", content_type: "text/x-php" },
    ]);

    // Without a library (an older WebDesk pointer): no file, no hash key, a null file pointer, and the SAME contentHash.
    const without = await refreshContractSnapshot({
      tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: fakeProvider({ version: "4.0.1", artifacts, sdkPhp: php }),
    });
    expect(without.outcome).toBe("created");
    if (without.outcome !== "created") throw new Error("unreachable");
    expect(without.snapshot.contentHash).toBe(withBlocks.snapshot.contentHash);
    const noLib = (await storedSnapshots(tenant, SLUG)).find((r) => r.contract_version === "4.0.1")!.artifacts as Record<string, unknown> & { hashes: Record<string, unknown> };
    expect(noLib.blockLibraryFile).toBeNull();
    expect(noLib.hashes).not.toHaveProperty("blockLibrary");
  });

  it("M6-P4b0: re-fetching an already-recorded version that now arrives with a block library stays idempotent (no determinism alarm)", async () => {
    const artifacts = artifactSet("gen-blocks-replay");
    const first = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: fakeProvider({ version: "4.1.0", artifacts }) });
    expect(first.outcome).toBe("created");
    const again = await refreshContractSnapshot({
      tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: fakeProvider({ version: "4.1.0", artifacts, blockLibrary: Buffer.from("tarball") }),
    });
    expect(again.outcome).toBe("idempotent");
  });

  it("M6-P4b0b TRIPWIRE (a-prime): a block-library tarball that does not hash to WebDesk's claim is refused with ZERO writes (rows, files)", async () => {
    const tarball = Buffer.from("the bytes we downloaded");
    const claimed = createHash("sha256").update(Buffer.from("the bytes WebDesk meant")).digest("hex");
    const before = await storedSnapshots(tenant, SLUG);
    const filesBefore = await adminPool().query(`SELECT count(*)::int AS n FROM files WHERE tenant_id = $1`, [tenant]);

    const outcome = await refreshContractSnapshot({
      tenantId: tenant, slug: SLUG, fetchedBy: manager,
      provider: fakeProvider({ version: "7.0.0", artifacts: artifactSet("gen-bl-mismatch"), blockLibrary: tarball, blockLibrarySha256: claimed }),
    });
    expect(outcome).toEqual({
      outcome: "block_library_hash_mismatch",
      claimedHash: claimed,
      recomputedHash: createHash("sha256").update(tarball).digest("hex"),
      contractVersion: "7.0.0",
    });

    expect(await storedSnapshots(tenant, SLUG)).toHaveLength(before.length);
    const filesAfter = await adminPool().query(`SELECT count(*)::int AS n FROM files WHERE tenant_id = $1`, [tenant]);
    expect(filesAfter.rows[0].n).toBe(filesBefore.rows[0].n);
  });

  it("M6-P4b0b TRIPWIRE (a-prime): a claimed hash with NO tarball URL is refused (recomputedHash null), nothing persisted", async () => {
    const claimed = "ab".repeat(32);
    const before = await storedSnapshots(tenant, SLUG);
    const outcome = await refreshContractSnapshot({
      tenantId: tenant, slug: SLUG, fetchedBy: manager,
      provider: fakeProvider({ version: "7.1.0", artifacts: artifactSet("gen-bl-nourl"), blockLibrarySha256: claimed }),
    });
    expect(outcome).toEqual({ outcome: "block_library_hash_mismatch", claimedHash: claimed, recomputedHash: null, contractVersion: "7.1.0" });
    expect(await storedSnapshots(tenant, SLUG)).toHaveLength(before.length);
  });

  it("M6-P4b0b: a matching claim persists as before, and a tarball with NO claim (an older WebDesk) is still accepted", async () => {
    const tarball = Buffer.from("verified tarball");
    const matched = await refreshContractSnapshot({
      tenantId: tenant, slug: SLUG, fetchedBy: manager,
      provider: fakeProvider({ version: "7.2.0", artifacts: artifactSet("gen-bl-match"), blockLibrary: tarball }),
    });
    expect(matched.outcome).toBe("created");
    const matchedRow = (await storedSnapshots(tenant, SLUG)).find((r) => r.contract_version === "7.2.0")!;
    expect((matchedRow.artifacts.hashes as Record<string, string>).blockLibrary).toBe(createHash("sha256").update(tarball).digest("hex"));

    const unclaimed = await refreshContractSnapshot({
      tenantId: tenant, slug: SLUG, fetchedBy: manager,
      provider: fakeProvider({ version: "7.3.0", artifacts: artifactSet("gen-bl-noclaim"), blockLibrary: tarball, blockLibrarySha256: null }),
    });
    expect(unclaimed.outcome).toBe("created");
    const unclaimedRow = (await storedSnapshots(tenant, SLUG)).find((r) => r.contract_version === "7.3.0")!;
    expect(typeof unclaimedRow.artifacts.blockLibraryFile).toBe("string");
  });

  it("M6-P4b0b: the block-library check runs before the existing-row read, so a bad tarball on an already-recorded version is (a-prime), not idempotent", async () => {
    const artifacts = artifactSet("gen-bl-replay");
    const first = await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider: fakeProvider({ version: "7.4.0", artifacts }) });
    expect(first.outcome).toBe("created");
    const again = await refreshContractSnapshot({
      tenantId: tenant, slug: SLUG, fetchedBy: manager,
      provider: fakeProvider({ version: "7.4.0", artifacts, blockLibrary: Buffer.from("tarball"), blockLibrarySha256: "cd".repeat(32) }),
    });
    expect(again.outcome).toBe("block_library_hash_mismatch");
  });

  it("THIRD WALL: another tenant's snapshot list is empty — RLS, not application filtering", async () => {
    const provider = fakeProvider({ version: "5.0.0", artifacts: artifactSet("gen-wall") });
    await refreshContractSnapshot({ tenantId: tenant, slug: SLUG, fetchedBy: manager, provider });

    const otherTenantView = await listContractSnapshots(otherTenant, SLUG);
    expect(otherTenantView).toEqual([]);

    // Same tenant, no module scope declared: reads ZERO rows silently (WD-23A-1), not an error.
    const noModuleScope = await withTenants([tenant], (c) =>
      c.query(`SELECT 1 FROM webdev_contract_snapshots WHERE tenant_id = $1 AND webdesk_tenant_slug = $2`, [tenant, SLUG]),
    );
    expect(noModuleScope.rowCount).toBe(0);
  });
});
