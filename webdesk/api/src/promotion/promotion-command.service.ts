// WSK-25 — the promotion engine itself: snapshot-first -> migrate -> content export/import -> FE
// deploy (behind the not-yet-available seam) -> purge/warm, and rollback = content restore.
//
// ============================================================================================
// THE ORDERING THAT MATTERS MOST (read before changing promote()):
// ============================================================================================
// Step 1 (snapshot) runs to completion — including its own COMMIT, inside
// PromotionSnapshotService.takeSnapshot — and this function `await`s that BEFORE step 2 (migrate
// +import) even builds its transaction. That is not a comment-level promise: it is two SEPARATE
// calls to `db.withTenant(...)`, each opening and closing its OWN connection/transaction, in
// sequence, with nothing overlapping them. If step 2 throws — a real Postgres constraint
// violation from a corrupt bundle, a dropped connection, anything — step 2's OWN transaction rolls
// back (leaving the target's content exactly as it was), and step 1's snapshot is already
// permanently on disk in a transaction that finished and closed before step 2 ever opened,
// unreachable by step 2's ROLLBACK. test/promotion-snapshot-first.spec.ts injects a real failure
// here (a bundle that violates content_items' own CHECK constraint) and queries the snapshot row
// back on a FRESH connection afterward to prove this, rather than merely asserting the happy path
// wrote one row.
// ============================================================================================
//
// ============================================================================================
// M3 T5b — THE APPROVAL IS CLAIMED FIRST, ON THE DURABLE IDEMPOTENCY STORE (WSK-41 envelope)
// ============================================================================================
// content.promote and content.rollback are HIGH: each is authorised by one single-use WS4 approval.
// The approval is CLAIMED by the audit row `control.content.promote|rollback` (0009 §3
// ux_audit_entries_ws4_once). Promotion cannot be ONE transaction without breaking snapshot-first
// (above), so the claim is the FIRST of the saga's transactions, run by CommandEnvelope:
//
//   claim transaction:  audit row (ws4_approval_id)  ->  promotion_runs insert  ->  idempotency
//                       complete(claim, { promotionRunId })      -- a run REFERENCE, not a result
//   then, as before:    snapshot (own tx) -> status -> import (own tx) -> status -> frontend -> status
//
// A concurrent reuse of the approval blocks on the unique index at the claim's first statement, then
// fails 23505 -> 403 ws4-approval-already-used with nothing changed: no run row, no snapshot, no import.
// Exactly one of N racers gets past the claim, so exactly one saga runs.
//
// FAIL-CLOSED. The approval is consumed the moment the claim commits. If a later step fails, the run is
// marked `failed` exactly as before and the request fails as before, but the approval stays consumed: a
// retry needs a NEW approval (and a new Idempotency-Key: the old key now names the failed run, below).
// A saga that DIED mid-way (process crash) leaves its run `pending`/`snapshotted`/`content_promoted`; as
// before there is no recovery sweep, and a replay of that key answers 409 promotion-in-progress.
//
// WHAT THE IDEMPOTENCY RECORD HOLDS. The claim stores `{ promotionRunId }`. When the saga finishes, the
// terminal status update and the final response body are written in ONE transaction (storeFinalBody):
// `{ promotionRunId, finalBody }`, where finalBody is the response as JSON TEXT. Text, not an object,
// because the column is jsonb and jsonb does not keep key order: the replay is the original's bytes.
// (promotion_runs alone cannot rebuild the body: applyResult is not persisted anywhere else.)
//
// REPLAY (same key, same request hash), by what the record holds:
//   finalBody present        -> that body again, `replayed: true`, a `.replay` audit row, no effect.
//   reference only, run `failed`        -> 409 promotion-run-failed (the original request failed).
//   reference only, any other status    -> 409 promotion-in-progress. Chosen over waiting: a saga can
//        outlive any sane HTTP wait (snapshot + import), the caller can poll by retrying, and a
//        blocked replay would hold a pooled connection. Neither refusal writes an audit row: nothing
//        was served.
// The request hash is the REQUEST (tenant, site, env, source, the version AS SENT or null, whether a
// bundle was sent), not the server-chosen defaults: `promote-<now>` differs per request, so hashing it
// made every replay of a request without `version` a 409 idempotency-key-reused.
//
// The audit row is the claim row. Fields the old after-the-fact row carried are in its args, except the
// run STATUS (not known before the run happens; it is promotion_runs.status).
import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { AuditService } from "../audit/audit.service";
import { CommandEnvelope } from "../control/command-envelope";
import { ContentBundleService } from "./content-bundle.service";
import { PromotionSnapshotService } from "./promotion-snapshot.service";
import { PromotionAuditService } from "./promotion-audit.service";
import { FRONTEND_DEPLOY_DRIVER, type FrontendDeployDriver } from "./frontend-deploy-driver";
import type { ApplyBundleResult, BundleWriter, ContentBundle } from "./content-bundle.types";
import { ControlProblem } from "../control/content/content-problem";

/**
 * What the failed run's error_detail records. A ControlProblem (409 slug-taken, 409
 * bundle-group-collection-mismatch, ...) is an HttpException whose own `message` is just
 * "Control Problem"; the useful text is its slug and detail.
 */
function describeError(err: unknown): string {
  if (err instanceof ControlProblem) {
    const detail = (err.getResponse() as { detail?: string }).detail;
    return detail ? `${err.slug}: ${detail}` : err.slug;
  }
  return err instanceof Error ? err.message : String(err);
}

interface ResolvedTarget {
  tenant: { id: string; slug: string };
  siteId: string;
  targetEnvId: string;
}

async function resolveSiteAndEnv(
  db: DbService,
  tenantId: string,
  siteId: string,
  envId: string,
): Promise<{ siteId: string; envId: string }> {
  return db.withTenant(tenantId, async (scoped) => {
    const site = await scoped.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenantId]);
    if (!site.rows[0]) throw new NotFoundException("site not found for this tenant");
    const env = await scoped.query(`SELECT 1 FROM environments WHERE id = $1 AND site_id = $2 AND tenant_id = $3`, [envId, siteId, tenantId]);
    if (!env.rows[0]) throw new NotFoundException("environment not found for this site/tenant");
    return { siteId, envId };
  });
}

export interface PromoteInput {
  tenantSlug: string;
  siteId: string;
  targetEnvId: string;
  sourceEnvId?: string | null;
  version?: string;
  /** Caller-supplied export (e.g. from a prior content.export call against a DIFFERENT Zone B instance — see this ticket's report for why Zone B never fetches this itself). Omitted => self-export from this same instance's current content (first-launch/no-op-content case). */
  bundle?: ContentBundle;
  actor: string;
  /** "automation" for an automation-initiated control call (ControlPrincipal.automation), else "human": the version attribution's `pk`. */
  actorKind: "human" | "automation";
  idempotencyKey: string;
  ws4ApprovalId: string | null;
}

export interface RollbackInput {
  tenantSlug: string;
  siteId: string;
  targetEnvId: string;
  version?: string;
  actor: string;
  /** See PromoteInput.actorKind. */
  actorKind: "human" | "automation";
  idempotencyKey: string;
  ws4ApprovalId: string | null;
}

export interface ExportInput {
  tenantSlug: string;
  siteId: string;
  actor: string;
}

/** What the claim transaction stores: a run REFERENCE (the body comes later, see storeFinalBody). */
interface RunRef {
  promotionRunId: string;
}

/** content.promote's response body (a replay returns these bytes again, with replayed: true). */
export interface PromoteBody extends RunRef {
  status: "completed" | "content_promoted_frontend_pending";
  snapshot: { id: string; checksum: string; itemCount: number };
  applyResult: ApplyBundleResult;
  frontendDeploy: { ok: boolean; reason: string | undefined };
}

/** content.rollback's response body. */
export interface RollbackBody extends RunRef {
  status: "rolled_back";
  restoredFromSnapshotId: string;
  applyResult: ApplyBundleResult;
}

@Injectable()
export class PromotionCommandService {
  private readonly logger = new Logger(PromotionCommandService.name);

  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly auditHash: AuditService,
    private readonly envelope: CommandEnvelope,
    private readonly bundles: ContentBundleService,
    private readonly snapshots: PromotionSnapshotService,
    private readonly promotionAudit: PromotionAuditService,
    @Inject(FRONTEND_DEPLOY_DRIVER) private readonly frontend: FrontendDeployDriver,
  ) {}

  private async resolveTarget(tenantSlug: string, siteId: string, targetEnvId: string): Promise<ResolvedTarget> {
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    await resolveSiteAndEnv(this.db, tenant.id, siteId, targetEnvId);
    return { tenant, siteId, targetEnvId };
  }

  async exportContent(input: ExportInput) {
    const tenant = await this.tenants.bySlug(input.tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    const bundle = await this.bundles.exportBundle(tenant.id, input.siteId);
    await this.promotionAudit.record({
      tenantId: tenant.id,
      command: "content.export",
      actor: input.actor,
      args: { tenantSlug: input.tenantSlug, siteId: input.siteId, itemCount: bundle.contentItems.length },
    });
    return { bundle };
  }


  async promote(input: PromoteInput): Promise<PromoteBody & { replayed: boolean }> {
    const { tenant, siteId, targetEnvId } = await this.resolveTarget(input.tenantSlug, input.siteId, input.targetEnvId);
    if (input.sourceEnvId) await resolveSiteAndEnv(this.db, tenant.id, siteId, input.sourceEnvId);

    const version = input.version ?? `promote-${Date.now()}`;
    const args = {
      tenantSlug: input.tenantSlug,
      siteId,
      targetEnvId,
      sourceEnvId: input.sourceEnvId ?? null,
      version,
      bundleProvided: Boolean(input.bundle),
    };
    // The REQUEST, not the server's defaults: see the header on why `version` is hashed as sent.
    const requestHash = this.auditHash.hashArgs({ ...args, version: input.version ?? null });
    const scopeKey = `${input.tenantSlug}:content.promote:${input.idempotencyKey}`;
    // Known before the claim, so the claim's audit row can carry it.
    const runId = randomUUID();

    // THE CLAIM: audit row (claims the approval) -> run row -> idempotency record, one transaction.
    const claimed = await this.envelope.run<RunRef>({
      command: "content.promote",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey,
      requestHash,
      actor: input.actor,
      auditArgs: { ...args, promotionRunId: runId },
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async (client) => {
        await client.query(
          `INSERT INTO promotion_runs (id, tenant_id, site_id, source_env_id, target_env_id, kind, version, status, current_step, created_by)
           VALUES ($1, $2, $3, $4, $5, 'promote', $6, 'pending', 'snapshot', $7)`,
          [runId, tenant.id, siteId, input.sourceEnvId ?? null, targetEnvId, version, input.actor],
        );
        return { result: { promotionRunId: runId } };
      },
      resolveReplay: (stored) => this.resolveReplay(tenant.id, stored),
    });
    // A replay: resolveReplay already turned the record into the original's body.
    if (claimed.replayed) return claimed as unknown as PromoteBody & { replayed: boolean };

    const body = await this.runPromoteSaga({ tenantId: tenant.id, tenantSlug: input.tenantSlug, siteId, targetEnvId, runId, scopeKey, version, input });
    return { ...body, replayed: false };
  }

  /**
   * Everything after the claim. Unchanged from before the move except that the run row already exists,
   * and that the terminal status update also stores the final body (storeFinalBody).
   */
  private async runPromoteSaga(c: {
    tenantId: string;
    tenantSlug: string;
    siteId: string;
    targetEnvId: string;
    runId: string;
    scopeKey: string;
    version: string;
    input: PromoteInput;
  }): Promise<PromoteBody> {
    const { tenantId, siteId, targetEnvId, runId, input, version } = c;

    // --- STEP 1: snapshot-first. Must fully commit before step 2 ever begins. -----------------
    const snapshot = await this.snapshots.takeSnapshot({ tenantId, promotionRunId: runId, envId: targetEnvId, siteId });
    await this.db.withTenant(tenantId, (db) =>
      db.transaction((client) =>
        client.query(`UPDATE promotion_runs SET status = 'snapshotted', snapshot_id = $1, current_step = 'migrate' WHERE id = $2`, [
          snapshot.id,
          runId,
        ]),
      ),
    );

    // --- STEP 2: migrate + content import (one atomic transaction; a failure here rolls back --
    //     entirely and leaves the target's content exactly as the snapshot just captured it).
    //     The transaction is db.transaction's: ANY error from applyBundle (a 409 slug-taken, a CHECK
    //     violation, ...) ROLLBACKs it whole and rethrows, so a refused bundle changes nothing. The
    //     rethrown error reaches the client as-is: a ControlProblem as a 409 problem+json (see
    //     PromotionController's ControlProblemFilter), anything else as before.
    const bundleToApply = input.bundle ?? (await this.bundles.exportBundle(tenantId, siteId));
    const writer: BundleWriter = {
      actor: input.actor,
      actorKind: input.actorKind,
      ws4ApprovalId: input.ws4ApprovalId,
      note: `promotion ${runId}`,
    };
    let applyResult: ApplyBundleResult;
    try {
      applyResult = await this.db.withTenant(tenantId, (db) =>
        db.transaction((client) => this.bundles.applyBundle(client, tenantId, siteId, bundleToApply, "merge", writer)),
      );
    } catch (err) {
      const message = describeError(err);
      await this.db.withTenant(tenantId, (db) =>
        db.transaction((client) =>
          client.query(
            `UPDATE promotion_runs SET status = 'failed', current_step = 'migrate_import', error_detail = $1::jsonb, completed_at = now() WHERE id = $2`,
            [JSON.stringify({ step: "migrate_import", message }), runId],
          ),
        ),
      );
      throw err;
    }

    await this.db.withTenant(tenantId, (db) =>
      db.transaction((client) =>
        client.query(`UPDATE promotion_runs SET status = 'content_promoted', current_step = 'frontend_deploy' WHERE id = $1`, [runId]),
      ),
    );

    // --- STEP 3: frontend artifact deploy -> domain/TLS activate -> purge/warm ----------------
    //     Expected to fail today (NotYetAvailableFrontendDeployDriver) — this is honest, not a
    //     bug: the content half above has already committed, and this failure must not roll
    //     that back. See frontend-deploy-driver.ts's header.
    let frontendDeployed = false;
    let frontendReason: string | undefined;
    try {
      for (const step of ["deployArtifact", "activateDomain", "purgeAndWarm"] as const) {
        await this.frontend.execute({ step, tenantSlug: c.tenantSlug, envId: targetEnvId, version });
      }
      frontendDeployed = true;
    } catch (err) {
      frontendReason = err instanceof Error ? err.message : String(err);
    }

    const finalStatus = frontendDeployed ? "completed" : "content_promoted_frontend_pending";
    const body: PromoteBody = {
      promotionRunId: runId,
      status: finalStatus,
      snapshot: { id: snapshot.id, checksum: snapshot.checksum, itemCount: snapshot.itemCount },
      applyResult,
      frontendDeploy: { ok: frontendDeployed, reason: frontendReason },
    };
    // The terminal status and the stored body commit together: a finished run always has its body.
    await this.db.withTenant(tenantId, (db) =>
      db.transaction(async (client) => {
        await client.query(
          `UPDATE promotion_runs SET status = $1, current_step = 'done', error_detail = $2::jsonb, completed_at = now() WHERE id = $3`,
          [finalStatus, frontendReason ? JSON.stringify({ step: "frontend_deploy", message: frontendReason }) : null, runId],
        );
        await this.storeFinalBody(client, tenantId, c.scopeKey, runId, body);
      }),
    );

    if (frontendDeployed) {
      await this.db.withTenant(tenantId, (db) =>
        db.transaction((client) =>
          client.query(
            `INSERT INTO releases (env_id, tenant_id, version, kind, snapshot_ref, created_by)
             VALUES ($1, $2, $3, 'promote', $4::jsonb, $5)
             ON CONFLICT (env_id, version) DO NOTHING`,
            [targetEnvId, tenantId, version, JSON.stringify({ promotionRunId: runId, snapshotId: snapshot.id }), input.actor],
          ),
        ),
      );
    }

    return body;
  }

  async rollback(input: RollbackInput): Promise<RollbackBody & { replayed: boolean }> {
    const { tenant, siteId, targetEnvId } = await this.resolveTarget(input.tenantSlug, input.siteId, input.targetEnvId);

    // MUST refuse when no snapshot exists — never a silent no-op. Checked BEFORE the envelope (so a
    // repeated call with no snapshot refuses identically every time and claims nothing: no audit row,
    // no idempotency key, the approval is not consumed), rather than caching a "success" that never
    // happened.
    const snapshot = await this.snapshots.latestSnapshot(tenant.id, targetEnvId);
    if (!snapshot) {
      throw new ConflictException(
        `no promotion_snapshots row exists for environment '${targetEnvId}' — nothing to roll back to. ` +
          `A rollback can only restore a POINT THAT WAS ACTUALLY SNAPSHOTTED (every content.promote takes one first); ` +
          `refusing rather than silently leaving the environment unchanged and reporting success.`,
      );
    }

    const version = input.version ?? `rollback-${snapshot.id.slice(0, 8)}`;
    const args = { tenantSlug: input.tenantSlug, siteId, targetEnvId, version, restoreFromSnapshotId: snapshot.id };
    // The REQUEST: the snapshot is chosen by the server (the latest one) and a newer promote changes
    // it, so it is not part of what the caller asked for. See the header.
    const requestHash = this.auditHash.hashArgs({ tenantSlug: input.tenantSlug, siteId, targetEnvId, version: input.version ?? null });
    const scopeKey = `${input.tenantSlug}:content.rollback:${input.idempotencyKey}`;
    const runId = randomUUID();

    const claimed = await this.envelope.run<RunRef>({
      command: "content.rollback",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey,
      requestHash,
      actor: input.actor,
      auditArgs: { ...args, promotionRunId: runId },
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async (client) => {
        await client.query(
          `INSERT INTO promotion_runs (id, tenant_id, site_id, source_env_id, target_env_id, kind, version, status, current_step, snapshot_id, created_by)
           VALUES ($1, $2, $3, NULL, $4, 'rollback', $5, 'pending', 'restore', $6, $7)`,
          [runId, tenant.id, siteId, targetEnvId, version, snapshot.id, input.actor],
        );
        return { result: { promotionRunId: runId } };
      },
      resolveReplay: (stored) => this.resolveReplay(tenant.id, stored),
    });
    if (claimed.replayed) return claimed as unknown as RollbackBody & { replayed: boolean };

    const writer: BundleWriter = {
      actor: input.actor,
      actorKind: input.actorKind,
      ws4ApprovalId: input.ws4ApprovalId,
      note: `rollback ${runId}`,
    };
    let applyResult: ApplyBundleResult;
    try {
      applyResult = await this.db.withTenant(tenant.id, (db) =>
        db.transaction((client) => this.bundles.applyBundle(client, tenant.id, siteId, snapshot.bundle, "restore", writer)),
      );
    } catch (err) {
      const message = describeError(err);
      await this.db.withTenant(tenant.id, (db) =>
        db.transaction((client) =>
          client.query(
            `UPDATE promotion_runs SET status = 'failed', current_step = 'restore', error_detail = $1::jsonb, completed_at = now() WHERE id = $2`,
            [JSON.stringify({ step: "restore", message }), runId],
          ),
        ),
      );
      throw err;
    }

    const body: RollbackBody = { promotionRunId: runId, status: "rolled_back", restoredFromSnapshotId: snapshot.id, applyResult };
    await this.db.withTenant(tenant.id, (db) =>
      db.transaction(async (client) => {
        await client.query(`UPDATE promotion_runs SET status = 'rolled_back', current_step = 'done', completed_at = now() WHERE id = $1`, [runId]);
        await this.storeFinalBody(client, tenant.id, scopeKey, runId, body);
      }),
    );

    await this.db.withTenant(tenant.id, (db) =>
      db.transaction((client) =>
        client.query(
          `INSERT INTO releases (env_id, tenant_id, version, kind, snapshot_ref, created_by)
           VALUES ($1, $2, $3, 'rollback', $4::jsonb, $5)
           ON CONFLICT (env_id, version) DO NOTHING`,
          [targetEnvId, tenant.id, version, JSON.stringify({ promotionRunId: runId, restoredFromSnapshotId: snapshot.id }), input.actor],
        ),
      ),
    );

    return { ...body, replayed: false };
  }

  /**
   * Stores the finished run's response body on its idempotency record, in the CALLER's transaction (the
   * one that moves the run to its terminal status). The body goes in as JSON TEXT so a replay is the
   * original's bytes (see the header). Fenced on the run id and on "not yet stored"; if the record is
   * gone (expired, or swept) there is nothing to store and the run must still finish, so that is a
   * warning, not a failure.
   */
  private async storeFinalBody(client: PoolClient, tenantId: string, scopeKey: string, runId: string, body: object): Promise<void> {
    const { rowCount } = await client.query(
      `UPDATE control_idempotency_keys SET response = $1::jsonb
        WHERE tenant_id = $2 AND scope_key = $3 AND status = 'completed'
          AND response ->> 'promotionRunId' = $4 AND NOT (response ? 'finalBody')`,
      [JSON.stringify({ promotionRunId: runId, finalBody: JSON.stringify(body) }), tenantId, scopeKey, runId],
    );
    if (rowCount !== 1) this.logger.warn(`promotion run ${runId}: no idempotency record to store the final body on (scope key ${scopeKey})`);
  }

  /**
   * A replay: the stored record is either the finished run's body (as text) or only the run reference.
   * See the header for the three outcomes. Runs before the envelope's replay audit row.
   */
  private async resolveReplay(tenantId: string, stored: unknown): Promise<RunRef> {
    const record = (stored ?? {}) as { promotionRunId?: string; finalBody?: string };
    if (typeof record.finalBody === "string") return JSON.parse(record.finalBody) as RunRef;

    const run = record.promotionRunId
      ? await this.db.withTenant(tenantId, async (db) => {
          const { rows } = await db.query<{ status: string; current_step: string | null; error_detail: { step?: string } | null }>(
            `SELECT status, current_step, error_detail FROM promotion_runs WHERE id = $1`,
            [record.promotionRunId],
          );
          return rows[0];
        })
      : undefined;
    if (run?.status === "failed") {
      throw new ControlProblem(
        409,
        "promotion-run-failed",
        "Promotion run failed",
        `The run this Idempotency-Key started failed at step '${run.error_detail?.step ?? run.current_step ?? "unknown"}'. ` +
          `Its WS4 approval is consumed: start a new run with a new approval and a new Idempotency-Key.`,
        { promotionRunId: record.promotionRunId },
      );
    }
    throw new ControlProblem(
      409,
      "promotion-in-progress",
      "Promotion in progress",
      "The run this Idempotency-Key started has not finished. Nothing was started again. Retry with the same key once it has.",
      { promotionRunId: record.promotionRunId, status: run?.status ?? null, currentStep: run?.current_step ?? null },
    );
  }
}
