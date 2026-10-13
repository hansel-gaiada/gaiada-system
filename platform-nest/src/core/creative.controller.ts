// Creative Image Studio — persist API. Stores the assets exported by the client-side
// grading pipeline (platform-ui). The whole point is REPRODUCIBILITY: we keep the
// original bytes, the graded bytes, and the exact grade parameters, so any correction
// can be reproduced, reversed, or (phase 2) used as an AI training pair.
//
// Reuses the existing "file" Cerbos policy + storage backend + activity log — no new
// authz surface. Bytes live in storage (keyed); only metadata + the small grade JSON
// live in Postgres (mirrors FilesController). Images are not scrubbable text, so no PII
// scrub runs on the pixels (the day-one scrubber only touches text content types).
//
// DW-6h (docs/FRONTEND-BFF-CONTRACT.md §35) adds VERSIONS and review ROUNDS. The asset routes above keep the `file` kind
// and its gates unchanged (§35.4: moving them would be an access change); only the new review routes authorise as the new
// `creative_asset` kind. Rules, parsing and SQL are in creative-reviews.ts. Every review handler follows one order:
//   (1) read what Cerbos must see from the DB (the asset's department ancestry, the requesters of linked work requests,
//       the round's opener: never from the body), (2) AUTHORIZE, (3) only then validate the body (so validation never
//       pre-empts a 403), (4) ONE `withTenants` transaction holding the group lock, (5) activity and notifications after the
//       commit. Authorization is never done inside a transaction, so no row lock is held across a network round trip.
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { storage } from "./storage";
import { AuthGuard } from "../auth/guards";
import type { Resource } from "../rbac/cerbos";
import { departmentFilterSql, parseDepartmentFilter } from "./department-filter";
import { notifyBestEffort } from "./client-notify";
import { loadUnitHeads } from "./work-requests.service";
import * as rv from "./creative-reviews";

const MAX_BYTES = 25 * 1024 * 1024;

// The nine Grade fields the studio produces (kept in sync with platform-ui lib/imaging/grade.ts).
// Server-side validation guards the reproducibility record: a malformed grade would make the
// stored asset non-reproducible, so we reject rather than store garbage.
const GRADE_KEYS = ["exposure", "contrast", "temperature", "tint", "gamma", "saturation", "vibrance", "highlights", "shadows"] as const;

function validateGrade(g: unknown): Record<string, number> {
  if (!g || typeof g !== "object") throw new BadRequestException("grade must be an object");
  const src = g as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of GRADE_KEYS) {
    const v = src[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequestException(`grade.${k} must be a finite number`);
    out[k] = v;
  }
  return out;
}

function decodeImage(b64: string, label: string): Buffer {
  const raw = Buffer.from(b64, "base64");
  if (raw.byteLength === 0) throw new BadRequestException(`${label} is empty`);
  if (raw.byteLength > MAX_BYTES) throw new BadRequestException(`${label} too large`);
  return raw;
}

interface SaveBody {
  name?: string;
  contentType?: string;
  width?: number;
  height?: number;
  presetId?: string;
  departmentId?: string;
  grade?: unknown;
  /** base64 of the exported graded image (required). */
  graded?: string;
  /** base64 of the original, pre-grade image (optional — kept for reproducibility/training). */
  original?: string;
  originalContentType?: string;
  /** DW-6h §35.2: save this as the NEXT VERSION of that asset's group (any version of the group may be named). */
  versionOf?: unknown;
}

/** The `creative_asset` resource for one review action. The attributes come from the database, never from a body. */
const reviewResource = (tenantId: string, extra: Partial<Resource> = {}): Resource => ({ kind: "creative_asset", tenantId, ...extra });

/** The UI page a review notification links to: the department's Asset Library, when the asset has a department. */
const libraryHref = (departmentId: string | null): string | undefined =>
  departmentId ? `/departments/${encodeURIComponent(departmentId)}/assets` : undefined;

@Controller("api")
@UseGuards(AuthGuard)
export class CreativeController {
  // ?trainingReady=true|false filters to curated exemplars — the trainer's data pull uses it.
  // DW-6h §35.5: ?versions=latest (default) | all, and ?departmentId= (§33's helper, on the asset's own department_id, the
  // node or its subtree). Both are parsed AFTER authorize. Each row also carries versionNo, versionGroupId, versionCount,
  // isLatest and review ({ round, status } of the group's latest round, or null).
  @Get(":tenantId/creative/assets")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("trainingReady") trainingReady?: string,
    @Query("departmentId") departmentId?: unknown,
    @Query("versions") versions?: unknown,
  ) {
    await authorize(req.principal, { kind: "file", tenantId }, "read");
    const dept = parseDepartmentFilter(departmentId);
    const which = await rv.mapCreativeRules(async () => rv.parseVersionsQuery(versions));
    const training = trainingReady === "true" ? "a.training_ready = true" : trainingReady === "false" ? "a.training_ready = false" : "TRUE";
    const df = departmentFilterSql(dept, "a.department_id", 1, 2);
    const rows = await withTenants([tenantId], (c) =>
      c.query(rv.assetListSql({ where: `${training} AND ${df.sql}`, latestOnly: which === "latest", oneGroup: false }), [tenantId, ...df.params]),
    );
    return rows.rows;
  }

  // Curation: mark whether this asset is a good training exemplar (and/or rename it).
  @Patch(":tenantId/creative/assets/:id")
  async update(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { trainingReady?: boolean; name?: string }) {
    await authorize(req.principal, { kind: "file", tenantId }, "create");
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (typeof body?.trainingReady === "boolean") { sets.push(`training_ready = $${sets.length + 1}`); vals.push(body.trainingReady); }
    if (typeof body?.name === "string" && body.name.trim()) { sets.push(`name = $${sets.length + 1}`); vals.push(body.name.trim()); }
    if (sets.length === 0) throw new BadRequestException("nothing to update");
    vals.push(id);
    const res = await withTenants([tenantId], (c) =>
      c.query(`UPDATE creative_assets SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} AND deleted_at IS NULL RETURNING id, training_ready, name`, vals),
    );
    if (!res.rows[0]) throw new NotFoundException("asset not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "creative_asset", id, { trainingReady: body.trainingReady });
    return res.rows[0];
  }

  // DW-6h §35.2: with `versionOf`, the save is the group's NEXT VERSION. The group's first row is locked FOR UPDATE before
  // the number is taken, an open review round is closed as `superseded` in the same transaction, and the department is
  // inherited from the group's latest version unless the body names one. Authorised first, then validated (§35.5).
  @Post(":tenantId/creative/assets")
  @HttpCode(201)
  async save(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: SaveBody) {
    await authorize(req.principal, { kind: "file", tenantId }, "create");
    const b = body ?? {};
    if (!b.name) throw new BadRequestException("name required");
    if (!b.graded) throw new BadRequestException("graded image content required");
    const grade = validateGrade(b.grade);
    const versionOf = await rv.mapCreativeRules(async () => rv.parseVersionOf(b.versionOf));
    const userId = req.principal.userId as string;

    const id = newId();
    const gradedBytes = decodeImage(b.graded, "graded");
    let originalBytes: Buffer | null = null;
    if (b.original) originalBytes = decodeImage(b.original, "original");
    const gradedKey = `${tenantId}/creative/${id}`;
    await storage().put(gradedKey, gradedBytes);

    let originalKey: string | null = null;
    let originalSize = 0;
    if (originalBytes) {
      originalKey = `${tenantId}/creative/${id}.orig`;
      originalSize = originalBytes.byteLength;
      await storage().put(originalKey, originalBytes);
    }

    let out: { versionNo: number; versionGroupId: string; supersedesId: string | null; superseded: { round: number } | null };
    try {
      out = await rv.mapCreativeRules(() =>
        withTenants([tenantId], async (c) => {
          let versionNo = 1;
          let groupId: string | null = null;
          let supersedesId: string | null = null;
          let departmentId: string | null = b.departmentId ?? null;
          let superseded: { round: number } | null = null;
          if (versionOf) {
            const ref = await rv.loadAssetRef(c, tenantId, versionOf);
            if (!ref) throw rv.assetNotFound();
            await rv.lockGroup(c, tenantId, ref.group_id);
            // Re-read under the lock: a concurrent delete of the named version is committed now or not at all.
            const now = await rv.loadAssetRef(c, tenantId, versionOf);
            if (!now || now.deleted_at) throw rv.assetDeleted();
            const latest = await rv.latestLiveVersion(c, tenantId, ref.group_id);
            if (!latest) throw rv.assetDeleted();
            versionNo = await rv.nextVersionNo(c, tenantId, ref.group_id);
            groupId = ref.group_id;
            supersedesId = latest.id;
            if (b.departmentId === undefined || b.departmentId === null) departmentId = latest.department_id;
          }
          await c.query(
            `INSERT INTO creative_assets
               (id, tenant_id, uploader_id, department_id, name, content_type, width, height, preset_id,
                grade, original_key, original_content_type, original_byte_size, graded_key, graded_byte_size, origin_site,
                version_group_id, version_no, supersedes_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [
              id, tenantId, userId, departmentId, b.name,
              b.contentType ?? "image/webp", b.width ?? null, b.height ?? null, b.presetId ?? "custom",
              JSON.stringify(grade), originalKey, b.originalContentType ?? null, originalSize,
              gradedKey, gradedBytes.byteLength, config.originSite,
              groupId, versionNo, supersedesId,
            ],
          );
          // §35.3: a new version supersedes the open round, in this same transaction (the group lock is held).
          if (groupId) {
            const closed = await rv.supersedeOpenRound(c, tenantId, groupId);
            if (closed) superseded = { round: closed.round };
          }
          return { versionNo, versionGroupId: groupId ?? id, supersedesId, superseded };
        }),
      );
    } catch (e) {
      // Nothing was committed: do not leave the bytes behind.
      await storage().del(gradedKey).catch(() => undefined);
      if (originalKey) await storage().del(originalKey).catch(() => undefined);
      throw e;
    }

    await writeActivity(tenantId, userId, "graded", "creative_asset", id, {
      name: b.name, presetId: b.presetId ?? "custom",
      ...(versionOf ? { versionOf, versionNo: out.versionNo, versionGroupId: out.versionGroupId } : {}),
    });
    if (out.superseded) {
      await writeActivity(tenantId, userId, "review_superseded", "creative_asset", out.versionGroupId, {
        round: out.superseded.round, byVersion: id, versionNo: out.versionNo,
      });
    }
    return {
      id, gradedByteSize: gradedBytes.byteLength, originalByteSize: originalSize,
      versionNo: out.versionNo, versionGroupId: out.versionGroupId, supersedesId: out.supersedesId,
    };
  }

  @Get(":tenantId/creative/assets/:id")
  async metadata(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "file", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, name, content_type, width, height, preset_id, grade, department_id,
                original_key IS NOT NULL AS has_original, original_byte_size, graded_byte_size,
                training_ready, uploader_id, created_at
         FROM creative_assets WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("asset not found");
    return rows.rows[0];
  }

  @Get(":tenantId/creative/assets/:id/content")
  async graded(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await this.stream(req, reply, tenantId, id, "graded");
  }

  // The original, pre-grade bytes — used to reprocess or to build AI training pairs (phase 2).
  @Get(":tenantId/creative/assets/:id/original")
  async original(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await this.stream(req, reply, tenantId, id, "original");
  }

  private async stream(req: FastifyRequest, reply: FastifyReply, tenantId: string, id: string, which: "graded" | "original") {
    await authorize(req.principal, { kind: "file", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query<{ graded_key: string; original_key: string | null; content_type: string; original_content_type: string | null; name: string }>(
        `SELECT graded_key, original_key, content_type, original_content_type, name FROM creative_assets WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    const a = rows.rows[0];
    if (!a) throw new NotFoundException("asset not found");
    const key = which === "graded" ? a.graded_key : a.original_key;
    if (!key) throw new NotFoundException("no stored content");
    const type = which === "graded" ? a.content_type : (a.original_content_type ?? "application/octet-stream");
    const bytes = await storage().get(key);
    await reply
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(type || "application/octet-stream")
      .send(bytes);
  }

  // DW-6h: the delete takes the group lock and, in the same transaction, closes an open review round on THIS version as
  // `withdrawn` (otherwise it would block every later round on the group). Deleting the latest makes the previous version
  // latest again; no other row changes.
  @Delete(":tenantId/creative/assets/:id")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "file", tenantId }, "delete");
    const userId = req.principal.userId as string;
    const out = await withTenants([tenantId], async (c) => {
      const ref = await rv.loadAssetRef(c, tenantId, id);
      if (!ref || ref.deleted_at) return null;
      await rv.lockGroup(c, tenantId, ref.group_id);
      const del = await c.query<{ graded_key: string; original_key: string | null }>(
        `UPDATE creative_assets SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL
         RETURNING graded_key, original_key`,
        [id],
      );
      if (!del.rows[0]) return null;
      const withdrawnRound = await rv.withdrawOpenRoundOnVersion(c, tenantId, id, userId);
      return { keys: del.rows[0], groupId: ref.group_id, withdrawnRound };
    });
    if (!out) throw new NotFoundException("asset not found");
    if (out.keys.graded_key) await storage().del(out.keys.graded_key);
    if (out.keys.original_key) await storage().del(out.keys.original_key);
    await writeActivity(tenantId, userId, "deleted", "creative_asset", id);
    if (out.withdrawnRound !== null) {
      await writeActivity(tenantId, userId, "review_withdrawn", "creative_asset", out.groupId, { round: out.withdrawnRound, reason: "asset_deleted" });
    }
    return { id, deleted: true };
  }

  // ═══════════════════════════════════ DW-6h §35.5: versions and review rounds ═══════════════════════════════════

  // The group's live versions, newest first, in the list's row shape. `file` · `read`, like the list.
  @Get(":tenantId/creative/assets/:id/versions")
  async versions(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "file", tenantId }, "read");
    return rv.mapCreativeRules(() =>
      withTenants([tenantId], async (c) => {
        const ref = await rv.loadAssetRef(c, tenantId, id);
        if (!ref || ref.deleted_at) throw rv.assetNotFound();
        return rv.listVersions(c, tenantId, ref.group_id);
      }),
    );
  }

  // The group's rounds, newest first. `creative_asset` · `read`.
  @Get(":tenantId/creative/assets/:id/reviews")
  async reviews(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const ref = await this.preRead(req, tenantId, id);
    if (ref.deleted_at) {
      await authorize(req.principal, reviewResource(tenantId), "read");
      throw rv.httpFromCreativeRule(rv.assetNotFound());
    }
    const facts = await withTenants([tenantId], (c) => rv.loadReviewAuthFacts(c, tenantId, ref.group_id, ref.department_id));
    await authorize(req.principal, reviewResource(tenantId, { id: ref.group_id, ...facts }), "read");
    return withTenants([tenantId], (c) => rv.listRounds(c, tenantId, ref.group_id));
  }

  // Open a round on the LATEST version. `creative_asset` · `request_review`. 409 not_latest_version, review_open,
  // asset_deleted. The SHA-256 of the version's graded bytes is taken from storage exactly as `GET …/content` serves them.
  @Post(":tenantId/creative/assets/:id/reviews")
  @HttpCode(201)
  async openReview(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const ref = await this.preRead(req, tenantId, id);
    const facts = await withTenants([tenantId], (c) => rv.loadReviewAuthFacts(c, tenantId, ref.group_id, ref.department_id));
    await authorize(req.principal, reviewResource(tenantId, { id: ref.group_id, ...facts }), "request_review");
    const { note } = await rv.mapCreativeRules(async () => rv.parseReviewRequest(body));
    const userId = req.principal.userId as string;

    // A cheap pre-check, so a refusal never costs a storage read; the transaction below re-checks under the lock.
    await rv.mapCreativeRules(async () => {
      if (ref.deleted_at) throw rv.assetDeleted();
      const latest = await withTenants([tenantId], (c) => rv.latestLiveVersion(c, tenantId, ref.group_id));
      if (!latest || latest.id !== ref.id) throw rv.notLatestVersion();
    });
    const sha = rv.sha256Hex(await storage().get(ref.graded_key));

    const round = await rv.mapCreativeRules(() =>
      withTenants([tenantId], async (c) => {
        await rv.lockGroup(c, tenantId, ref.group_id);
        const now = await rv.loadAssetRef(c, tenantId, id);
        if (!now || now.deleted_at) throw rv.assetDeleted();
        const latest = await rv.latestLiveVersion(c, tenantId, ref.group_id);
        if (!latest || latest.id !== ref.id) throw rv.notLatestVersion();
        const open = await c.query(`SELECT 1 FROM creative_asset_reviews WHERE tenant_id = $1 AND group_id = $2 AND status = 'open'`, [tenantId, ref.group_id]);
        if (open.rows[0]) throw rv.reviewOpen();
        const next = await c.query<{ n: number }>(
          `SELECT COALESCE(max(round), 0)::int + 1 AS n FROM creative_asset_reviews WHERE tenant_id = $1 AND group_id = $2`,
          [tenantId, ref.group_id],
        );
        const n = next.rows[0].n;
        await c.query(
          `INSERT INTO creative_asset_reviews (id, tenant_id, group_id, asset_id, round, status, content_sha256, requested_by, note, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9)`,
          [newId(), tenantId, ref.group_id, ref.id, n, sha, userId, note, config.originSite],
        );
        return (await rv.getRound(c, tenantId, ref.group_id, n)) as rv.RoundRow;
      }),
    );

    await writeActivity(tenantId, userId, "review_requested", "creative_asset", ref.group_id, {
      round: round.round, assetId: ref.id, versionNo: round.versionNo,
    });
    // §35.5: the asset's department head(s) and the requesters of linked requests are told; never the actor (notify()).
    try {
      const heads = ref.department_id ? await withTenants([tenantId], (c) => loadUnitHeads(c, tenantId, ref.department_id as string)) : [];
      const recipients = [...new Set([...heads.map((h) => h.toLowerCase()), ...facts.requesterIds])];
      await notifyBestEffort(tenantId, userId, recipients, "creative_review.requested", {
        title: `Review requested: version ${round.versionNo}, round ${round.round}`,
        ...(note ? { body: note } : {}),
        href: libraryHref(ref.department_id),
        entityType: "creative_asset", entityId: ref.group_id, severity: "info",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[creative] creative_review.requested notification failed (group=${ref.group_id}):`, (err as Error)?.message ?? err);
    }
    return round;
  }

  // Approve or request changes. `creative_asset` · `decide_review`: nobody decides a round they opened (Cerbos DENY).
  // 409 review_not_open; 400 { field: "comment" } when changes_requested has none.
  @Post(":tenantId/creative/assets/:id/reviews/:round/decision")
  @HttpCode(200)
  async decide(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Param("round") roundParam: string,
    @Body() body: unknown,
  ) {
    const { ref, round, facts } = await this.preReadRound(req, tenantId, id, roundParam);
    await authorize(
      req.principal,
      reviewResource(tenantId, { id: ref.group_id, ...facts, reviewRequestedBy: round.requestedBy }),
      "decide_review",
    );
    const input = await rv.mapCreativeRules(async () => rv.parseDecision(body));
    const userId = req.principal.userId as string;

    const decided = await rv.mapCreativeRules(() =>
      withTenants([tenantId], async (c) => {
        await rv.lockGroup(c, tenantId, ref.group_id);
        const locked = await rv.lockRound(c, tenantId, ref.group_id, round.round);
        if (!locked) throw rv.reviewNotFound();
        if (locked.status !== "open") throw rv.reviewNotOpen();
        await c.query(
          `UPDATE creative_asset_reviews SET status = $2, decided_by = $3, decided_at = now(), decision_comment = $4 WHERE id = $1`,
          [locked.id, input.decision, userId, input.comment],
        );
        return (await rv.getRound(c, tenantId, ref.group_id, round.round)) as rv.RoundRow;
      }),
    );

    await writeActivity(tenantId, userId, input.decision === "approved" ? "review_approved" : "review_changes_requested", "creative_asset", ref.group_id, {
      round: decided.round, assetId: decided.assetId, versionNo: decided.versionNo,
    });
    // §35.5: a decision tells whoever opened the round.
    const dept = await withTenants([tenantId], (c) => rv.departmentOf(c, tenantId, decided.assetId));
    await notifyBestEffort(tenantId, userId, [decided.requestedBy], "creative_review.decided", {
      title: input.decision === "approved"
        ? `Version ${decided.versionNo} was approved (round ${decided.round})`
        : `Changes requested on version ${decided.versionNo} (round ${decided.round})`,
      ...(input.comment ? { body: input.comment } : {}),
      href: libraryHref(dept),
      entityType: "creative_asset", entityId: ref.group_id, severity: input.decision === "approved" ? "info" : "warning",
    });
    return decided;
  }

  // Close an open round without a decision. `creative_asset` · `withdraw_review` (company_admin, manager, or the opener).
  // 409 review_not_open.
  @Post(":tenantId/creative/assets/:id/reviews/:round/withdraw")
  @HttpCode(200)
  async withdraw(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Param("round") roundParam: string) {
    const { ref, round, facts } = await this.preReadRound(req, tenantId, id, roundParam);
    await authorize(
      req.principal,
      reviewResource(tenantId, { id: ref.group_id, ...facts, reviewRequestedBy: round.requestedBy }),
      "withdraw_review",
    );
    const userId = req.principal.userId as string;

    const withdrawn = await rv.mapCreativeRules(() =>
      withTenants([tenantId], async (c) => {
        await rv.lockGroup(c, tenantId, ref.group_id);
        const locked = await rv.lockRound(c, tenantId, ref.group_id, round.round);
        if (!locked) throw rv.reviewNotFound();
        if (locked.status !== "open") throw rv.reviewNotOpen();
        await c.query(
          `UPDATE creative_asset_reviews SET status = 'withdrawn', decided_by = $2, decided_at = now() WHERE id = $1`,
          [locked.id, userId],
        );
        return (await rv.getRound(c, tenantId, ref.group_id, round.round)) as rv.RoundRow;
      }),
    );

    await writeActivity(tenantId, userId, "review_withdrawn", "creative_asset", ref.group_id, {
      round: withdrawn.round, assetId: withdrawn.assetId, versionNo: withdrawn.versionNo,
    });
    return withdrawn;
  }

  // ═══════════════════════════════════════════════ helpers ═══════════════════════════════════════════════

  /** The asset (live or deleted) the review route names. Absent, or another tenant's: a caller who may not even READ
   *  rounds is refused 403 first, so the 404 is never an existence oracle for someone outside the tenant. */
  private async preRead(req: FastifyRequest, tenantId: string, id: string): Promise<rv.AssetRef> {
    const ref = await withTenants([tenantId], (c) => rv.loadAssetRef(c, tenantId, id));
    if (!ref) {
      await authorize(req.principal, reviewResource(tenantId), "read");
      throw rv.httpFromCreativeRule(rv.assetNotFound());
    }
    return ref;
  }

  /** The asset, the round the route names and the Cerbos attributes for an action ON that round. The department is the
   *  department of the version under review. A round that does not exist is a 404 after the same read gate. */
  private async preReadRound(req: FastifyRequest, tenantId: string, id: string, roundParam: string) {
    const ref = await this.preRead(req, tenantId, id);
    const n = rv.parseRoundParam(roundParam);
    const found = n === null ? null : await withTenants([tenantId], async (c) => {
      const round = await rv.getRound(c, tenantId, ref.group_id, n);
      if (!round) return null;
      const facts = await rv.loadReviewAuthFacts(c, tenantId, ref.group_id, await rv.departmentOf(c, tenantId, round.assetId));
      return { round, facts };
    });
    if (!found) {
      await authorize(req.principal, reviewResource(tenantId), "read");
      throw rv.httpFromCreativeRule(rv.reviewNotFound());
    }
    return { ref, ...found };
  }
}
