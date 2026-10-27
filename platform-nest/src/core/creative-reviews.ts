// DW-6h (docs/FRONTEND-BFF-CONTRACT.md §35) — asset VERSIONS and review ROUNDS on the Asset Library's `creative_assets`.
// Plan: docs/plans/2026-10-13-department-workspaces.md §4.2 (DW-6h) and §14.3 ("review with versions").
//
// The routes live in creative.controller.ts (one route prefix); this file holds the rules, the input parsing and the SQL,
// so the controller reads as routes only (the work-requests.service.ts split).
//
// ── VERSIONS (§35.2) ─────────────────────────────────────────────────────────────────────────────
// The GROUP KEY is `COALESCE(version_group_id, id)`: a group's first version has no `version_group_id`, every later one
// carries the first version's id. A new version is saved through today's `POST /creative/assets` with `versionOf`; the
// saving transaction locks the group's FIRST row (`FOR UPDATE`) before it reads `max(version_no)`, so two concurrent saves
// queue on that lock and take consecutive numbers. The unique index `ux_creative_assets_version` is the second wall.
// A number is taken after EVERY row of the group, deleted ones included, so a number is never reused: a review round that
// named "version 3" keeps meaning the same bytes. The LATEST version is the live row with the highest number, so deleting
// the latest makes the previous one latest again with no write.
//
// ── ROUNDS (§35.3) ───────────────────────────────────────────────────────────────────────────────
// A round opens on the latest version only, takes the group's highest round + 1 under the same group lock, and records the
// SHA-256 of that version's graded bytes. One round may be open per group (the partial unique index
// `ux_creative_asset_reviews_one_open` is the wall; its violation is 409 `review_open`). Saving a new version closes an
// open round as `superseded` in the SAME transaction; deleting the version under review closes it as `withdrawn`. Decided
// rounds never reopen.
//
// ── LOCK ORDER ───────────────────────────────────────────────────────────────────────────────────
// The group's first `creative_assets` row first, the round row second. Every writer here takes them in that order.
//
// ── ERRORS ───────────────────────────────────────────────────────────────────────────────────────
// platform-nest's error filter renders the thrown object's `message` as `{ error }` and forwards `reason` and `field`. A
// refusal here puts its typed token at the START of `message` (`not_latest_version: …`) and repeats it in `reason`.
import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { isUuidShaped } from "./dept-resolution";
import { loadUnitAncestors } from "./org-unit-closure";

// ───────────────────────────────────────────── vocabulary ─────────────────────────────────────────────

export const REVIEW_STATUSES = ["open", "approved", "changes_requested", "withdrawn", "superseded"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const DECISIONS = ["approved", "changes_requested"] as const;
export type Decision = (typeof DECISIONS)[number];
export const NOTE_MAX = 2_000;
export const COMMENT_MAX = 4_000;

/** A refusal the controller maps to an HTTP exception. The token leads `message` and is repeated in `reason`. */
export class CreativeRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409,
    /** The machine token the contract names (`not_latest_version`, `review_open`, ...). */
    readonly token: string,
    text: string,
    readonly field?: string,
  ) {
    super(`${token}: ${text}`);
    this.name = "CreativeRuleError";
  }
}

export const assetNotFound = () => new CreativeRuleError(404, "asset_not_found", "asset not found");
export const assetDeleted = () => new CreativeRuleError(409, "asset_deleted", "the asset was deleted");
export const reviewNotFound = () => new CreativeRuleError(404, "review_not_found", "review round not found");
export const reviewNotOpen = () => new CreativeRuleError(409, "review_not_open", "the review round is no longer open");
export const reviewOpen = () => new CreativeRuleError(409, "review_open", "a review round is already open on this asset");
export const notLatestVersion = () =>
  new CreativeRuleError(409, "not_latest_version", "a review can only be opened on the latest version of the asset");

export function httpFromCreativeRule(e: CreativeRuleError): HttpException {
  const body = { message: e.message, reason: e.token, ...(e.field ? { field: e.field } : {}) };
  if (e.httpStatus === 400) return new BadRequestException(body);
  if (e.httpStatus === 404) return new NotFoundException(body);
  return new ConflictException(body);
}

/** Runs `fn`, turning a CreativeRuleError into its HTTP exception, and a unique violation of one of this feature's own
 *  indexes into the 409 the contract names. */
export async function mapCreativeRules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CreativeRuleError) throw httpFromCreativeRule(e);
    const pg = e as { code?: string; constraint?: string };
    if (pg?.code === "23505") {
      if (pg.constraint === "ux_creative_asset_reviews_one_open" || pg.constraint === "creative_asset_reviews_round_uq") {
        throw httpFromCreativeRule(reviewOpen());
      }
      if (pg.constraint === "ux_creative_assets_version") {
        throw httpFromCreativeRule(
          new CreativeRuleError(409, "version_conflict", "another version of this asset was saved at the same time; try again"),
        );
      }
    }
    throw e;
  }
}

// ───────────────────────────────────────── pure input parsing ─────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** A NUL cannot live in a Postgres text column (it would be a 500). */
const stripNul = (s: string): string => s.replace(/\u0000/g, "");

/** `versionOf` on the save body: absent or null is a new asset; otherwise one asset id of this company. A value that cannot
 *  be an id is answered like an id that names nothing (404 `asset_not_found`): neither can be versioned. */
export function parseVersionOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new CreativeRuleError(400, "version_of_invalid", "versionOf must be an asset id", "versionOf");
  }
  const v = raw.trim().toLowerCase();
  if (!isUuidShaped(v)) throw assetNotFound();
  return v;
}

export const ASSET_SOURCES = ["own", "client", "stock", "ai", "unknown"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];
export const AI_NOTE_MAX = 1_000;

/** SCP-1h (BFF §63.1 file 4, §35.2): where the saved bytes came from, and the note an AI-made picture carries. Both are optional on
 *  the save: no source is `unknown` (a new version never inherits the one it replaces: new bytes, new origin). An `ai` source needs
 *  a non-blank note (400 `ai_note_required`); a note of 1 to 1,000 characters may ride on any source; a blank one is no note.
 *  `char_length` in the database counts characters, so the bound is counted in code points here. */
export function parseSourceAndNote(rawSource: unknown, rawNote: unknown): { source: AssetSource; aiNote: string | null } {
  let source: AssetSource = "unknown";
  if (rawSource !== undefined && rawSource !== null) {
    if (typeof rawSource !== "string" || !(ASSET_SOURCES as readonly string[]).includes(rawSource)) {
      throw new CreativeRuleError(400, "source_invalid", "source must be own, client, stock, ai or unknown", "source");
    }
    source = rawSource as AssetSource;
  }
  let aiNote: string | null = null;
  if (rawNote !== undefined && rawNote !== null) {
    if (typeof rawNote !== "string") throw new CreativeRuleError(400, "ai_note_invalid", "aiNote must be text", "aiNote");
    const n = stripNul(rawNote).trim();
    if ([...n].length > AI_NOTE_MAX) {
      throw new CreativeRuleError(400, "ai_note_invalid", `aiNote must be at most ${AI_NOTE_MAX} characters`, "aiNote");
    }
    aiNote = n === "" ? null : n;
  }
  if (source === "ai" && aiNote === null) {
    throw new CreativeRuleError(400, "ai_note_required", "an AI-made asset needs a note saying how it was made", "aiNote");
  }
  return { source, aiNote };
}

/** `?versions=latest` (the default) or `?versions=all`. */
export function parseVersionsQuery(raw: unknown): "latest" | "all" {
  if (raw === undefined || raw === null) return "latest";
  if (typeof raw !== "string") {
    throw new CreativeRuleError(400, "versions_invalid", "versions must be latest or all", "versions");
  }
  const v = raw.trim();
  if (v === "" || v === "latest") return "latest";
  if (v === "all") return "all";
  throw new CreativeRuleError(400, "versions_invalid", "versions must be latest or all", "versions");
}

/** `{ note? }` for opening a round. A missing body or note is an empty note. */
export function parseReviewRequest(body: unknown): { note: string } {
  if (body === undefined || body === null) return { note: "" };
  if (!isPlainObject(body)) throw new CreativeRuleError(400, "body_invalid", "the body must be an object");
  const raw = body.note;
  if (raw === undefined || raw === null) return { note: "" };
  if (typeof raw !== "string") throw new CreativeRuleError(400, "note_invalid", "note must be text", "note");
  const note = stripNul(raw).trim();
  if (note.length > NOTE_MAX) {
    throw new CreativeRuleError(400, "note_invalid", `note must be at most ${NOTE_MAX} characters`, "note");
  }
  return { note };
}

/** `{ decision: "approved" | "changes_requested", comment? }`. `changes_requested` needs a non-blank comment. */
export function parseDecision(body: unknown): { decision: Decision; comment: string | null } {
  if (!isPlainObject(body)) throw new CreativeRuleError(400, "decision_invalid", "decision must be approved or changes_requested", "decision");
  const decision = body.decision;
  if (typeof decision !== "string" || !(DECISIONS as readonly string[]).includes(decision)) {
    throw new CreativeRuleError(400, "decision_invalid", "decision must be approved or changes_requested", "decision");
  }
  const raw = body.comment;
  let comment: string | null = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "string") throw new CreativeRuleError(400, "comment_invalid", "comment must be text", "comment");
    const c = stripNul(raw).trim();
    if (c.length > COMMENT_MAX) {
      throw new CreativeRuleError(400, "comment_invalid", `comment must be at most ${COMMENT_MAX} characters`, "comment");
    }
    comment = c === "" ? null : c;
  }
  if (decision === "changes_requested" && !comment) {
    throw new CreativeRuleError(400, "comment_required", "a comment is required when requesting changes", "comment");
  }
  return { decision: decision as Decision, comment };
}

/** The `:round` route segment: a positive integer, else no such round. */
export function parseRoundParam(raw: string): number | null {
  return /^[1-9][0-9]{0,8}$/.test(raw ?? "") ? Number(raw) : null;
}

// ───────────────────────────────────────────── reads ─────────────────────────────────────────────

export interface AssetRef {
  id: string;
  group_id: string;
  version_no: number;
  department_id: string | null;
  graded_key: string;
  deleted_at: Date | null;
}

/** One version of this company, live or deleted, with its group key. `null` when the id names nothing here. */
export async function loadAssetRef(c: PoolClient, tenantId: string, id: string): Promise<AssetRef | null> {
  if (!isUuidShaped(id)) return null;
  const { rows } = await c.query<AssetRef>(
    `SELECT id, COALESCE(version_group_id, id) AS group_id, version_no, department_id, graded_key, deleted_at
       FROM creative_assets WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}

/** The group's latest LIVE version, or null when every version is deleted. */
export async function latestLiveVersion(
  c: PoolClient, tenantId: string, groupId: string,
): Promise<{ id: string; version_no: number; department_id: string | null } | null> {
  const { rows } = await c.query<{ id: string; version_no: number; department_id: string | null }>(
    `SELECT id, version_no, department_id FROM creative_assets
      WHERE tenant_id = $1 AND COALESCE(version_group_id, id) = $2 AND deleted_at IS NULL
      ORDER BY version_no DESC LIMIT 1`,
    [tenantId, groupId],
  );
  return rows[0] ?? null;
}

/** THE GROUP LOCK: the group's first row, `FOR UPDATE`. Every write on a group's versions or rounds takes it first. */
export async function lockGroup(c: PoolClient, tenantId: string, groupId: string): Promise<void> {
  await c.query(`SELECT id FROM creative_assets WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [groupId, tenantId]);
}

/** The next version number: after every row of the group, deleted ones included (a number is never reused). Call it
 *  under `lockGroup`. */
export async function nextVersionNo(c: PoolClient, tenantId: string, groupId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT COALESCE(max(version_no), 0)::int + 1 AS n FROM creative_assets
      WHERE tenant_id = $1 AND COALESCE(version_group_id, id) = $2`,
    [tenantId, groupId],
  );
  return rows[0].n;
}

/** Who may decide as a REQUESTER: the `requested_by` of every live work request any version of the group was delivered
 *  against (DW-5c's `work_request_assets`). */
export async function loadRequesterIds(c: PoolClient, tenantId: string, groupId: string): Promise<string[]> {
  const { rows } = await c.query<{ user_id: string }>(
    `SELECT DISTINCT wr.requested_by::text AS user_id
       FROM work_request_assets wra
       JOIN work_requests wr ON wr.id = wra.request_id AND wr.tenant_id = wra.tenant_id
       JOIN creative_assets a ON a.id = wra.asset_id AND a.tenant_id = wra.tenant_id
      WHERE wra.tenant_id = $1 AND COALESCE(a.version_group_id, a.id) = $2 AND wr.deleted_at IS NULL`,
    [tenantId, groupId],
  );
  return rows.map((r) => r.user_id.toLowerCase());
}

/** The Cerbos attributes of the `creative_asset` kind, read from the database and never from a body. `departmentId` is
 *  the department of the version the action is about (the round's version for a decision or a withdrawal). */
export interface ReviewAuthFacts {
  unitAncestors: string[];
  requesterIds: string[];
}
export async function loadReviewAuthFacts(
  c: PoolClient, tenantId: string, groupId: string, departmentId: string | null,
): Promise<ReviewAuthFacts> {
  return {
    unitAncestors: departmentId ? await loadUnitAncestors(c, tenantId, departmentId) : [],
    requesterIds: await loadRequesterIds(c, tenantId, groupId),
  };
}

/** The department of one version (any state), or null. */
export async function departmentOf(c: PoolClient, tenantId: string, assetId: string): Promise<string | null> {
  const { rows } = await c.query<{ department_id: string | null }>(
    `SELECT department_id FROM creative_assets WHERE id = $1 AND tenant_id = $2`,
    [assetId, tenantId],
  );
  return rows[0]?.department_id ?? null;
}

// Today's list columns (unchanged, snake_case), then the §35.5 version fields (camelCase, as the contract names them).
const ASSET_COLUMNS = `a.id, a.name, a.content_type, a.width, a.height, a.preset_id, a.grade, a.department_id,
       a.original_key IS NOT NULL AS has_original, a.original_byte_size, a.graded_byte_size,
       a.training_ready, a.uploader_id, a.created_at, a.source, a.ai_note AS "aiNote",
       a.version_no AS "versionNo", COALESCE(a.version_group_id, a.id) AS "versionGroupId",
       a.supersedes_id AS "supersedesId", g.n AS "versionCount", (a.version_no = g.latest_no) AS "isLatest",
       (SELECT json_build_object('round', r.round, 'status', r.status)
          FROM creative_asset_reviews r
         WHERE r.tenant_id = a.tenant_id AND r.group_id = g.gid
         ORDER BY r.round DESC LIMIT 1) AS review`;

/** The live versions, each with its group's live count, whether it is the latest, and the group's latest round.
 *  `$1` is the tenant. `where` is ANDed in (it may use `a.` and further placeholders); `oneGroup` narrows the whole read
 *  to one group, whose key is `$2`, newest version first. */
export function assetListSql(opts: { where: string; latestOnly: boolean; oneGroup: boolean }): string {
  return `
    WITH g AS (
      SELECT COALESCE(version_group_id, id) AS gid, max(version_no) AS latest_no, count(*)::int AS n
        FROM creative_assets
       WHERE tenant_id = $1 AND deleted_at IS NULL${opts.oneGroup ? " AND COALESCE(version_group_id, id) = $2" : ""}
       GROUP BY 1
    )
    SELECT ${ASSET_COLUMNS}
      FROM creative_assets a
      JOIN g ON g.gid = COALESCE(a.version_group_id, a.id)
     WHERE a.tenant_id = $1 AND a.deleted_at IS NULL${opts.latestOnly ? " AND a.version_no = g.latest_no" : ""}
       AND (${opts.where})
     ORDER BY ${opts.oneGroup ? "a.version_no DESC" : "a.created_at DESC, a.id DESC"}`;
}

/** The group's live versions, newest first, in the list's row shape. */
export async function listVersions(c: PoolClient, tenantId: string, groupId: string): Promise<unknown[]> {
  const { rows } = await c.query(assetListSql({ where: "TRUE", latestOnly: false, oneGroup: true }), [tenantId, groupId]);
  return rows;
}

const ROUND_SELECT = `
  SELECT r.id, r.round, r.status, r.asset_id AS "assetId", a.version_no AS "versionNo", r.group_id AS "groupId",
         r.content_sha256 AS "contentSha256", r.note,
         r.requested_by AS "requestedBy", ru.name AS "requestedByName", r.requested_at AS "requestedAt",
         r.decided_by AS "decidedBy", du.name AS "decidedByName", r.decided_at AS "decidedAt",
         r.decision_comment AS "decisionComment"
    FROM creative_asset_reviews r
    JOIN creative_assets a ON a.id = r.asset_id
    LEFT JOIN users ru ON ru.id = r.requested_by
    LEFT JOIN users du ON du.id = r.decided_by`;

export interface RoundRow {
  id: string; round: number; status: ReviewStatus; assetId: string; versionNo: number; groupId: string;
  contentSha256: string; note: string; requestedBy: string; requestedByName: string | null; requestedAt: string;
  decidedBy: string | null; decidedByName: string | null; decidedAt: string | null; decisionComment: string | null;
}

/** The group's rounds, newest first. */
export async function listRounds(c: PoolClient, tenantId: string, groupId: string): Promise<RoundRow[]> {
  const { rows } = await c.query<RoundRow>(
    `${ROUND_SELECT} WHERE r.tenant_id = $1 AND r.group_id = $2 ORDER BY r.round DESC`,
    [tenantId, groupId],
  );
  return rows;
}

/** One round by its group and number. */
export async function getRound(c: PoolClient, tenantId: string, groupId: string, round: number): Promise<RoundRow | null> {
  const { rows } = await c.query<RoundRow>(
    `${ROUND_SELECT} WHERE r.tenant_id = $1 AND r.group_id = $2 AND r.round = $3`,
    [tenantId, groupId, round],
  );
  return rows[0] ?? null;
}

/** SHA-256 (lowercase hex) of a version's graded bytes, exactly as `GET …/content` serves them. */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ───────────────────────────────────────────── writes ─────────────────────────────────────────────

/** Closes the group's open round, if any, as `superseded` (a new version was saved). Call it under `lockGroup`, in the
 *  saving transaction. Returns the closed round, or null. */
export async function supersedeOpenRound(
  c: PoolClient, tenantId: string, groupId: string,
): Promise<{ round: number; requested_by: string } | null> {
  const { rows } = await c.query<{ round: number; requested_by: string }>(
    `UPDATE creative_asset_reviews SET status = 'superseded', decided_at = now()
      WHERE tenant_id = $1 AND group_id = $2 AND status = 'open'
      RETURNING round, requested_by`,
    [tenantId, groupId],
  );
  return rows[0] ?? null;
}

/** Closes the open round on ONE version, if any, as `withdrawn` by `userId` (that version is being deleted). Call it under
 *  `lockGroup`, in the deleting transaction. Returns the closed round number, or null. */
export async function withdrawOpenRoundOnVersion(
  c: PoolClient, tenantId: string, assetId: string, userId: string,
): Promise<number | null> {
  const { rows } = await c.query<{ round: number }>(
    `UPDATE creative_asset_reviews SET status = 'withdrawn', decided_by = $3, decided_at = now()
      WHERE tenant_id = $1 AND asset_id = $2 AND status = 'open'
      RETURNING round`,
    [tenantId, assetId, userId],
  );
  return rows[0]?.round ?? null;
}

/** The round row under its lock, after the group lock: the status the rules judge is the one committed now. */
export async function lockRound(c: PoolClient, tenantId: string, groupId: string, round: number): Promise<{ id: string; status: ReviewStatus } | null> {
  const { rows } = await c.query<{ id: string; status: ReviewStatus }>(
    `SELECT id, status FROM creative_asset_reviews WHERE tenant_id = $1 AND group_id = $2 AND round = $3 FOR UPDATE`,
    [tenantId, groupId, round],
  );
  return rows[0] ?? null;
}
