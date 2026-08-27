// WSK-19 — the mirror's core: hash verification, immutability enforcement, and the two tripwires.
// Design: docs/blueprints/webdesk-design.md §06 ("Zone A end — the mirror") + §05 (the hash
// discipline) + §04 (the row shape, 202608271500_webdev_contract_snapshots.sql).
//
// ── THE TWO TRIPWIRES, RESTATED FROM THE TICKET (this file's whole reason to exist) ──────────────
// (a) HASH MISMATCH against Zone B's OWN claim (`meta.contentHash` in the /control/v1/tenants/
//     :slug/contract response) — the bytes we downloaded do not hash to what Zone B said they
//     would. Transport corruption (or a compromised/misbehaving far side). Refused BEFORE any
//     database write — there is nothing yet to be idempotent about, and this case is version-
//     agnostic (it says nothing about whether THIS version has been seen before).
// (b) DETERMINISM BREACH — an EXISTING (tenant, slug, contract_version) row's stored content_hash
//     DIFFERS from what this fetch recomputed, even though (a) passed (Zone B's claim and our
//     recomputation AGREE with each other, just not with what is already on file). This means the
//     "same version" fetched twice produced two DIFFERENT byte sequences — the double-run CI gate
//     (§05) either missed it or Zone B's generator has drifted between fetches. This is not an
//     ordinary conflict: it is ALERTED (an outbox event + a severity-tagged activity row), not
//     merely answered with a 4xx, because a determinism breach means every OTHER site pinned to
//     this same version may already be running against silently-different code.
//
// WHY (a) IS CHECKED BEFORE OPENING A TRANSACTION, AND (b) INSIDE ONE
// (a) needs no existing row and touches nothing tenant/module-scoped — it is a pure function of
// "what we downloaded" vs "what Zone B claimed", so it is refused with zero database writes.
// (b) can only be known by comparing against what THIS tenant/slug/version already has on file
// (third-wall RLS), so it must run inside a `withTenants(..., {modules:['webdev']})` transaction —
// and because the alert (event + activity) is itself a write this ticket wants to SURVIVE the
// refusal, it commits inside that same transaction rather than being lost to a rollback.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { writeActivity } from "../../core/http";
import { storage } from "../../core/storage";
import { WebdevControlEgressError, type ContractBundleMeta, type WebdevControlProvider } from "./contract-fetch-provider";

/** Advisory-lock namespace for a contract-snapshot refresh, keyed on (tenant, slug, version) —
 *  serializes two concurrent refreshes of the SAME version so the existing-row check and the
 *  eventual insert cannot race each other into two rows the UNIQUE constraint would then have to
 *  arbitrate blindly. Distinct from `WEBDEV_PROVISION_LOCK_NS` (provisioning.service.ts) so a hash
 *  can never collide across the two lock spaces. */
const WEBDEV_CONTRACT_LOCK_NS = 0x57500002;

export interface RawArtifactSet {
  sdkTs: Buffer;
  sdkPhp: Buffer | null; // null until P6 (D-10)
  openapi: Buffer;
  contractMd: Buffer;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** §05/§06: contentHash = sha256 over a CANONICAL manifest of per-artifact hashes. Sorted keys (the
 *  `JSON.stringify(obj, sortedKeyArray)` idiom — passing an array as the replacer both FILTERS and
 *  ORDERS the emitted keys), no timestamp anywhere in the hashed body. `sdkPhp: null` hashes as the
 *  literal JSON `null` rather than being omitted, so a P6-absent tenant's manifest shape can never
 *  collide with a P6-present one that happens to hash the same three other artifacts. */
export function computeContentHash(artifacts: RawArtifactSet): { manifest: Record<string, string | null>; contentHash: string } {
  const manifest: Record<string, string | null> = {
    contractMd: sha256Hex(artifacts.contractMd),
    openapi: sha256Hex(artifacts.openapi),
    sdkPhp: artifacts.sdkPhp ? sha256Hex(artifacts.sdkPhp) : null,
    sdkTs: sha256Hex(artifacts.sdkTs),
  };
  const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
  const contentHash = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  return { manifest, contentHash };
}

export interface SnapshotDto {
  id: string;
  tenantId: string;
  webdeskTenantSlug: string;
  contractVersion: string;
  vocabularyVersion: string;
  contentHash: string;
  artifacts: Record<string, unknown>;
  fetchedBy: string | null;
  fetchedAt: string;
}

interface SnapshotRow {
  id: string;
  tenant_id: string;
  webdesk_tenant_slug: string;
  contract_version: string;
  vocabulary_version: string;
  content_hash: string;
  artifacts: Record<string, unknown>;
  fetched_by: string | null;
  fetched_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function toSnapshotDto(r: SnapshotRow): SnapshotDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    webdeskTenantSlug: r.webdesk_tenant_slug,
    contractVersion: r.contract_version,
    vocabularyVersion: r.vocabulary_version,
    contentHash: r.content_hash,
    artifacts: r.artifacts,
    fetchedBy: r.fetched_by,
    fetchedAt: iso(r.fetched_at),
  };
}

const SNAPSHOT_COLUMNS = `id, tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version,
  content_hash, artifacts, fetched_by, fetched_at`;

/** Every access to `webdev_contract_snapshots`/`files`(-for-this-target) declares
 *  `{modules:['webdev']}` — 202608271500 carries the THIRD WALL (migration header); a plain
 *  `withTenants()` call would read/write ZERO ROWS on the snapshot table silently, the same
 *  WD-23A-1 regression class every sibling webdev_* table's service guards against. */
function withWebdev<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["webdev"] });
}

async function storeArtifact(
  c: PoolClient,
  tenantId: string,
  snapshotId: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  uploaderId: string | null,
): Promise<string> {
  const id = newId();
  // `files` carries the PLAIN tenant wall (0009), not the third wall — same table every other
  // module's attachments live in (FilesController's own doctrine). No FK from files.target_entity_id
  // to webdev_contract_snapshots.id (polymorphic by design, 0009's own header), so writing the file
  // row BEFORE the snapshot row it will be referenced from is safe.
  const storageKey = `${tenantId}/webdev-contract-snapshots/${snapshotId}/${filename}`;
  await storage().put(storageKey, bytes);
  await c.query(
    `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
     VALUES ($1, $2, $3, 'webdev_contract_snapshot', $4, $5, $6, $7, $8, false, $9)`,
    [id, tenantId, uploaderId, snapshotId, filename, contentType, bytes.byteLength, storageKey, config.originSite],
  );
  return id;
}

export type RefreshOutcome =
  /** A brand-new (tenant, slug, contract_version) row was written. */
  | { outcome: "created"; snapshot: SnapshotDto }
  /** Same version, same recomputed hash as what is already on file — an honest no-op replay. No
   *  new row, no new files; the ORIGINAL row is returned unchanged (immutability, restated). */
  | { outcome: "idempotent"; snapshot: SnapshotDto }
  /** TRIPWIRE (a). The downloaded artifacts do not hash to what Zone B's own response claimed. */
  | { outcome: "hash_mismatch"; claimedHash: string; recomputedHash: string; contractVersion: string }
  /** TRIPWIRE (b). An EXISTING row for this exact (tenant, slug, version) has a DIFFERENT stored
   *  hash than what this fetch recomputed — a codegen determinism breach, alerted (not just 4xx). */
  | { outcome: "determinism_breach"; existingSnapshotId: string; existingHash: string; recomputedHash: string; contractVersion: string };

export interface RefreshArgs {
  tenantId: string;
  slug: string;
  fetchedBy: string | null;
  provider: WebdevControlProvider;
}

/** The whole refresh: fetch metadata, download artifacts, verify, persist. See the file header for
 *  why (a) is checked before any transaction and (b) inside one. */
export async function refreshContractSnapshot(args: RefreshArgs): Promise<RefreshOutcome> {
  const { tenantId, slug, fetchedBy, provider } = args;

  const meta: ContractBundleMeta = await provider.getContractBundle(slug);

  const [sdkTs, openapi, contractMd] = await Promise.all([
    provider.downloadArtifact(meta.artifacts.sdkTsUrl),
    provider.downloadArtifact(meta.artifacts.openapiUrl),
    provider.downloadArtifact(meta.artifacts.contractMdUrl),
  ]);
  const sdkPhp = meta.artifacts.sdkPhpUrl ? await provider.downloadArtifact(meta.artifacts.sdkPhpUrl) : null;

  const { manifest, contentHash } = computeContentHash({ sdkTs, sdkPhp, openapi, contractMd });

  // ── TRIPWIRE (a) ──────────────────────────────────────────────────────────────────────────────
  if (contentHash !== meta.contentHash) {
    return { outcome: "hash_mismatch", claimedHash: meta.contentHash, recomputedHash: contentHash, contractVersion: meta.version };
  }

  return withWebdev(tenantId, async (c) => {
    // Serialize concurrent refreshes of the SAME (tenant, slug, version) — see the constant's own
    // comment. Taken BEFORE the existing-row read so a racer cannot observe "no row yet" for a
    // version another in-flight refresh is about to commit.
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      WEBDEV_CONTRACT_LOCK_NS, `${tenantId}:${slug}:${meta.version}`,
    ]);

    const existing = await c.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM webdev_contract_snapshots
        WHERE tenant_id = $1 AND webdesk_tenant_slug = $2 AND contract_version = $3`,
      [tenantId, slug, meta.version],
    );
    const priorRow = existing.rows[0];

    if (priorRow) {
      if (priorRow.content_hash === contentHash) {
        // Idempotent replay — the ordinary re-fetch case. No write; the original row stands.
        return { outcome: "idempotent" as const, snapshot: toSnapshotDto(priorRow) };
      }

      // ── TRIPWIRE (b) — DETERMINISM BREACH. Alert, not merely a 4xx. ──────────────────────────
      await emitEvent(c, tenantId, "webdev_contract_snapshot", priorRow.id, "webdev.contract.determinism_breach", {
        webdeskTenantSlug: slug, contractVersion: meta.version,
        existingHash: priorRow.content_hash, recomputedHash: contentHash,
      });
      await writeActivity(tenantId, fetchedBy, "determinism_breach_detected", "webdev_contract_snapshot", priorRow.id, {
        severity: "critical", webdeskTenantSlug: slug, contractVersion: meta.version,
        existingHash: priorRow.content_hash, recomputedHash: contentHash,
      });
      return {
        outcome: "determinism_breach" as const,
        existingSnapshotId: priorRow.id,
        existingHash: priorRow.content_hash,
        recomputedHash: contentHash,
        contractVersion: meta.version,
      };
    }

    // ── FRESH VERSION — persist. ──────────────────────────────────────────────────────────────
    const snapshotId = newId();
    const sdkTsId = await storeArtifact(c, tenantId, snapshotId, "sdk.ts.tgz", "application/gzip", sdkTs, fetchedBy);
    const openapiId = await storeArtifact(c, tenantId, snapshotId, "openapi.v1.json", "application/json", openapi, fetchedBy);
    const contractMdId = await storeArtifact(c, tenantId, snapshotId, "CONTENT-CONTRACT.md", "text/markdown", contractMd, fetchedBy);
    const sdkPhpId = sdkPhp ? await storeArtifact(c, tenantId, snapshotId, "sdk.php.tgz", "application/gzip", sdkPhp, fetchedBy) : null;

    const artifactsJson = {
      sdkTs: sdkTsId,
      sdkPhp: sdkPhpId, // null until P6 (D-10)
      openapi: openapiId,
      contractMd: contractMdId,
      hashes: manifest,
      blockLibrary: meta.blockLibrary,
    };

    const ins = await c.query<SnapshotRow>(
      `INSERT INTO webdev_contract_snapshots
         (id, tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version, content_hash,
          artifacts, fetched_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SNAPSHOT_COLUMNS}`,
      [snapshotId, tenantId, slug, meta.version, meta.vocabularyVersion, contentHash,
        JSON.stringify(artifactsJson), fetchedBy, config.originSite],
    );
    const row = ins.rows[0];

    await emitEvent(c, tenantId, "webdev_contract_snapshot", row.id, "webdev.contract.snapshotted", {
      webdeskTenantSlug: slug, contractVersion: meta.version, vocabularyVersion: meta.vocabularyVersion,
    });
    await writeActivity(tenantId, fetchedBy, "refreshed", "webdev_contract_snapshot", row.id, {
      webdeskTenantSlug: slug, contractVersion: meta.version,
    });

    return { outcome: "created" as const, snapshot: toSnapshotDto(row) };
  });
}

/** GET …/contracts[?slug=]. Newest first per (tenant, slug) — the Contract card's own read shape
 *  (§08, WSK-24, not built yet) and this ticket's own test assertions. */
export async function listContractSnapshots(tenantId: string, slug?: string): Promise<SnapshotDto[]> {
  const where = slug ? `WHERE webdesk_tenant_slug = $1` : ``;
  const rows = await withWebdev(tenantId, (c) =>
    c.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM webdev_contract_snapshots ${where}
        ORDER BY fetched_at DESC LIMIT 200`,
      slug ? [slug] : [],
    ),
  );
  return rows.rows.map(toSnapshotDto);
}

export { WebdevControlEgressError };
