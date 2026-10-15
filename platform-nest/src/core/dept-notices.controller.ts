// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57; PERMISSION-CONTRACT §47; owner ruling DW-D32: heads post, the department reads) — the
// department notice board:
//   GET  /api/:tenantId/notices?unitNodeId=U&state=current|past&limit=&cursor=   a unit's notices (its own, those of every unit above it, company-wide)
//   GET  /api/:tenantId/notices?scope=company&state=…                            company-wide notices only
//   GET  /api/:tenantId/notices/:id                                              one notice
//   POST /api/:tenantId/notices                                                  post (201); the fan-out follows the commit
//   PATCH /api/:tenantId/notices/:id                                             edit title, body, pin, end date (200; no notification)
//   POST /api/:tenantId/notices/:id/withdraw                                     take it down (200; no notification; a second one is 404)
// The Cerbos kind is `dept_notice` (resource_dept_notice.yaml). The rules, validation and SQL are in dept-notices.service.ts; this file
// is routes, the order of checks and the fan-out.
//
// ── THE ORDER OF CHECKS (a known trap, §57.3) ────────────────────────────────────────────────────
//   POST:  (1) read ONLY `scope` and `unitNodeId` from the body, (2) the unit's ancestry from the closure, (3) AUTHORIZE `post`,
//          (4) only then validate title, body, pin, end date (a refused caller always gets 403, never 400), (5) existence of the unit
//          (404 `unit_not_found`, root refused) inside the transaction, (6) the pin limit (409), (7) the insert.
//   Named notice (GET one, PATCH, withdraw): the row first (it IS the Cerbos attribute), then the caller's READ right and the unit
//          narrowing. A refusal there is a 404 `notice_not_found`, the same answer an absent or withdrawn notice gets, so an id is never
//          an existence oracle (§57.2). Only a caller who CAN read the notice and may not edit it gets 403.
//   List:  Cerbos `read`, then the query shape (400), then the unit narrowing (403 `outside your reporting line`), then existence (404).
//   Authorization (an HTTP call to Cerbos) is never done inside a transaction.
//
// ── THE UNIT NARROWING ───────────────────────────────────────────────────────────────────────────
// `dept_notice · read` is tenant-wide in Cerbos (placement as of today is not something Cerbos can read), so the handler narrows with
// core/unit-reach.ts, the same predicate `GET /dept-kpis` uses (`authorizeUnitRead`): placed in the unit's subtree today, or leading
// the unit, or a company-wide tier. A unit notice is read by the callers who reach ITS unit; company-wide notices by anyone with `read`.
//
// ── THE FAN-OUT (§57.6) ──────────────────────────────────────────────────────────────────────────
// After the commit, one `notice.posted` notification per recipient with `notify()`. A failure (computing the audience or sending one)
// is logged WITH the notice id and never undoes the post. Never the author. Unit notice: the people placed in the unit or below it
// today, plus the heads who lead the unit itself (not heads above, not the company-wide tiers). Company notice: every active member.
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { AuthGuard } from "../auth/guards";
import { checkMany, type Resource } from "../rbac/cerbos";
import type { Principal } from "../rbac/principal";
import { authorize, notify, writeActivity } from "./http";
import { isUuidShaped } from "./dept-resolution";
import { loadUnitAncestors } from "./org-unit-closure";
import { callerReachesUnit, loadUnitReach, type UnitReach } from "./unit-reach";
import { findOrgUnit } from "../modules/reports/dept-kpis";
import { loadUnitLeadUserIds } from "../modules/reports/dept-kpi-watch";
import {
  OUT_OF_LINE_MESSAGE, collectUnitSubtree, loadOrgStructure, loadUnitRoster, resolveSubjectUnit, todayIsoInTz, unwrapOrgRoot,
} from "../modules/reports/person-scope";
import * as svc from "./dept-notices.service";

const KIND = "dept_notice";
/** Rows fetched per round trip while filling a page the per-notice reach may thin, and the most rounds one request makes. */
const BATCH = 100;
const MAX_BATCHES = 30;

function httpFromRule(e: svc.NoticeRuleError): HttpException {
  const body = { message: e.message, ...(e.field ? { field: e.field } : {}) };
  if (e.httpStatus === 400) return new BadRequestException(body);
  if (e.httpStatus === 404) return new NotFoundException(body);
  return new ConflictException(body);
}
async function mapRules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof svc.NoticeRuleError) throw httpFromRule(e);
    throw e;
  }
}

const today = (): string => todayIsoInTz(config.reportsTz);

/** The Cerbos resource of one notice: `scope` and `unitAncestors` come from the validated request (post) or the STORED row, never a body. */
function noticeResource(tenantId: string, scope: svc.NoticeScope, unitAncestors: string[], id?: string): Resource {
  return { kind: KIND, tenantId, ...(id ? { id } : {}), scope, unitAncestors };
}

const ancestorsOf = (tenantId: string, unitNodeId: string | null): Promise<string[]> =>
  unitNodeId ? withTenants([tenantId], (c) => loadUnitAncestors(c, tenantId, unitNodeId)) : Promise.resolve([]);

/** Name of a unit in the org tree at read time; a node that left the tree reads null ("a former unit"). */
const nameIn = (structure: unknown) => (unitNodeId: string): string | null => findOrgUnit(structure, unitNodeId)?.name ?? null;

/** The edit decision for many rows at once: ONE Cerbos action over at most 50 resources a call (`checkMany` chunks), the ancestry of
 *  every distinct unit read in one query. Same resource a PATCH builds, so `canEdit` and the write cannot disagree. */
async function canEditFlags(principal: Principal, tenantId: string, rows: svc.NoticeDbRow[], ancestors: Map<string, string[]>): Promise<boolean[]> {
  if (rows.length === 0) return [];
  return checkMany(
    principal,
    rows.map((r) => noticeResource(tenantId, r.scope, r.unit_node_id ? (ancestors.get(r.unit_node_id) ?? []) : [], r.id)),
    "edit",
  );
}

interface Readable {
  row: svc.NoticeDbRow;
  structure: unknown;
  reaches: boolean;
}

/** A named notice, to the point of "the caller may read it": the row (404 when absent or withdrawn), the Cerbos `read` decision and the
 *  unit narrowing, every refusal a 404 `notice_not_found` (§57.2). The ancestry for later decisions is the caller's to load. */
async function readableNotice(principal: Principal, tenantId: string, id: string): Promise<Readable> {
  if (!isUuidShaped(id)) throw svc.noticeNotFound();
  const found = await withTenants([tenantId], async (c) => {
    const row = await svc.loadNotice(c, tenantId, id);
    if (!row || row.withdrawn_at) return null;
    const structure = await loadOrgStructure(c, tenantId);
    const reaches =
      row.scope === "company" || row.unit_node_id === null
        ? true
        : await callerReachesUnit(c, principal, tenantId, structure, row.unit_node_id, today());
    return { row, structure, reaches };
  });
  if (!found) throw svc.noticeNotFound();
  try {
    await authorize(principal, noticeResource(tenantId, found.row.scope, [], found.row.id), "read");
  } catch (e) {
    if (e instanceof ForbiddenException) throw svc.noticeNotFound();
    throw e; // a revoked session (401) and a Cerbos outage stay what they are
  }
  if (!found.reaches) throw svc.noticeNotFound();
  return found;
}

const cursorOf = (r: svc.NoticeDbRow, state: svc.NoticeState): svc.Cursor => ({ state, pinned: r.pinned, createdKey: r.created_key, id: r.id });

@Controller("api/:tenantId/notices")
@UseGuards(AuthGuard)
export class DeptNoticesController {
  // ═══════════════════════════════════════════════ READS ═══════════════════════════════════════════════

  @Get()
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() rawQuery: Record<string, unknown>) {
    const principal = req.principal;
    const raw = rawQuery ?? {};
    // (1) Cerbos `read`, tenant-wide, before the query is looked at beyond its mode (a refused caller never gets a 400).
    await authorize(principal, noticeResource(tenantId, svc.listModeOf(raw) === "company" ? "company" : "unit", []), "read");
    // (2) the query's shape.
    const q = await mapRules(async () => svc.parseListQuery(raw));
    const asOf = today();

    const page = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const structure = await loadOrgStructure(c, tenantId);
        let unitIds: string[] | null = null;
        let reach: UnitReach | null = null;
        if (q.mode === "unit") {
          reach = await loadUnitReach(c, principal, tenantId, structure, asOf);
          let unit = q.unitNodeId as string;
          if (unit === svc.HOME) {
            const home = principal.userId ? await resolveSubjectUnit(c, tenantId, principal.userId, asOf) : null;
            if (!home) throw new svc.NoticeRuleError(400, "you have no home department: name a unit, or use scope=company", "unitNodeId");
            unit = home;
          }
          // (3) the unit narrowing (403), then (4) existence (404), the order every unit read follows.
          if (!reach.reaches(unit)) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
          if (!findOrgUnit(structure, unit) || unwrapOrgRoot(structure)?.id === unit) throw svc.unitNotFound();
          unitIds = [...new Set([unit, ...(await loadUnitAncestors(c, tenantId, unit))])];
        }

        // Fill one page. The per-notice reach (a notice of a unit ABOVE this one may not be readable by this caller) can thin a
        // batch, so ask again from where the last batch stopped, up to a cap.
        const kept: svc.NoticeDbRow[] = [];
        let after = q.cursor;
        let exhausted = false;
        let lastScanned: svc.NoticeDbRow | null = null;
        for (let i = 0; i < MAX_BATCHES && kept.length <= q.limit && !exhausted; i++) {
          const rows = await svc.listNoticeRows(c, tenantId, { unitIds, state: q.state, today: asOf, after, limit: BATCH });
          for (const r of rows) {
            lastScanned = r;
            if (r.scope === "company" || (reach !== null && r.unit_node_id !== null && reach.reaches(r.unit_node_id))) kept.push(r);
            if (kept.length > q.limit) break;
          }
          if (rows.length < BATCH) exhausted = true;
          else after = cursorOf(rows[rows.length - 1], q.state);
        }
        const items = kept.slice(0, q.limit);
        let nextCursor: string | null = null;
        if (kept.length > q.limit) nextCursor = svc.encodeCursor(cursorOf(items[items.length - 1], q.state));
        else if (!exhausted && lastScanned) nextCursor = svc.encodeCursor(cursorOf(lastScanned, q.state)); // the cap, not the end
        const ancestors = await svc.loadAncestorsOf(c, tenantId, items.flatMap((r) => (r.unit_node_id ? [r.unit_node_id] : [])));
        return { items, nextCursor, structure, ancestors };
      }),
    );

    const flags = await canEditFlags(principal, tenantId, page.items, page.ancestors);
    const unitName = nameIn(page.structure);
    return { items: page.items.map((r, i) => svc.toNoticeRow(r, asOf, unitName, flags[i])), nextCursor: page.nextCursor };
  }

  @Get(":id")
  async one(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const { row, structure } = await mapRules(() => readableNotice(req.principal, tenantId, id));
    const ancestors = await ancestorsOf(tenantId, row.unit_node_id);
    const [canEdit] = await canEditFlags(req.principal, tenantId, [row], new Map(row.unit_node_id ? [[row.unit_node_id, ancestors]] : []));
    return svc.toNoticeRow(row, today(), nameIn(structure), canEdit);
  }

  // ═══════════════════════════════════════════════ WRITES ═══════════════════════════════════════════════

  @Post()
  @HttpCode(201)
  async post(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    const principal = req.principal;
    // (1) `scope` and `unitNodeId` only, (2) the ancestry, (3) AUTHORIZE: before any other field is looked at.
    const facts = svc.authFactsOf(body);
    const unitAncestors = facts.scope === "unit" ? await ancestorsOf(tenantId, facts.unitNodeId) : [];
    await authorize(principal, noticeResource(tenantId, facts.scope, unitAncestors), "post");
    if (!principal.userId) throw new BadRequestException("no principal user");
    const userId = principal.userId;

    // (4) the body, (5) the unit, (6) the pin limit, (7) the row.
    const asOf = today();
    const input = await mapRules(async () => svc.parsePost(body, asOf));
    const id = newId();
    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const structure = await loadOrgStructure(c, tenantId);
        if (input.scope === "unit") {
          const unit = findOrgUnit(structure, input.unitNodeId as string);
          // The tree's ROOT is the company: company-wide is `scope: 'company'`, never a unit notice on the root.
          if (!unit || unwrapOrgRoot(structure)?.id === input.unitNodeId) throw svc.unitNotFound();
        }
        await svc.lockPinSlot(c, tenantId, input.scope, input.unitNodeId);
        if (input.pinned && (await svc.countCurrentPins(c, tenantId, input.scope, input.unitNodeId, asOf, null)) >= svc.PIN_LIMIT) {
          throw new svc.NoticeRuleError(409, "pin_limit", "pinned");
        }
        await c.query(
          `INSERT INTO dept_notices (id, tenant_id, scope, unit_node_id, title, body, pinned, ends_on, author_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)`,
          [id, tenantId, input.scope, input.unitNodeId, input.title, input.body, input.pinned, input.endsOn, userId, config.originSite],
        );
        const row = (await svc.loadNotice(c, tenantId, id)) as svc.NoticeDbRow;
        return { row, structure };
      }),
    );

    // Activity carries ids and flags, never the title or the body.
    await writeActivity(tenantId, userId, "posted", "dept_notice", id, { scope: input.scope, unitNodeId: input.unitNodeId, pinned: input.pinned });
    // The author passed `post`, which is exactly the `edit` rule on the same row, so `canEdit` is true without a second Cerbos call.
    const view = svc.toNoticeRow(out.row, asOf, nameIn(out.structure), true);
    await this.fanOut(tenantId, userId, view, asOf);
    return view;
  }

  @Patch(":id")
  @HttpCode(200)
  async edit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const principal = req.principal;
    const { row } = await mapRules(() => readableNotice(principal, tenantId, id));
    const unitAncestors = await ancestorsOf(tenantId, row.unit_node_id);
    await authorize(principal, noticeResource(tenantId, row.scope, unitAncestors, row.id), "edit");
    if (!principal.userId) throw new BadRequestException("no principal user");
    const userId = principal.userId;
    const patch = await mapRules(async () => svc.parsePatch(body));
    const asOf = today();

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        // The advisory lock first, then the row lock (the post path takes only the advisory one): the pin check below reads what
        // the lock protects. The row is re-read under its lock, so the rules judge the committed state.
        await svc.lockPinSlot(c, tenantId, row.scope, row.unit_node_id);
        const cur = await svc.loadNotice(c, tenantId, row.id, true);
        if (!cur || cur.withdrawn_at) throw svc.noticeNotFound();
        const title = patch.title ?? cur.title;
        const text = patch.body ?? cur.body;
        const pinned = patch.pinned ?? cur.pinned;
        const endsOn = patch.endsOn !== undefined ? patch.endsOn : cur.ends_on;
        const wasCurrentPin = cur.pinned && svc.stateOf(cur.ends_on, asOf) === "current";
        const willBeCurrentPin = pinned && svc.stateOf(endsOn, asOf) === "current";
        if (willBeCurrentPin && !wasCurrentPin && (await svc.countCurrentPins(c, tenantId, cur.scope, cur.unit_node_id, asOf, cur.id)) >= svc.PIN_LIMIT) {
          throw new svc.NoticeRuleError(409, "pin_limit", "pinned");
        }
        await c.query(
          `UPDATE dept_notices SET title = $2, body = $3, pinned = $4, ends_on = $5::date, edited_at = now(), edited_by = $6
            WHERE id = $1`,
          [cur.id, title, text, pinned, endsOn, userId],
        );
        return { row: (await svc.loadNotice(c, tenantId, cur.id)) as svc.NoticeDbRow, structure: await loadOrgStructure(c, tenantId) };
      }),
    );

    await writeActivity(tenantId, userId, "edited", "dept_notice", row.id, { changed: Object.keys(patch) });
    // The editor passed `edit` on this very row a moment ago (the unit cannot have moved: a notice's unit is never edited).
    return svc.toNoticeRow(out.row, asOf, nameIn(out.structure), true);
  }

  @Post(":id/withdraw")
  @HttpCode(200)
  async withdraw(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const principal = req.principal;
    const { row } = await mapRules(() => readableNotice(principal, tenantId, id));
    const unitAncestors = await ancestorsOf(tenantId, row.unit_node_id);
    await authorize(principal, noticeResource(tenantId, row.scope, unitAncestors, row.id), "withdraw");
    if (!principal.userId) throw new BadRequestException("no principal user");
    const userId = principal.userId;

    const withdrawnAt = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const cur = await svc.loadNotice(c, tenantId, row.id, true);
        // A second withdrawal (or one that lost a race with the first) finds it withdrawn: 404, nothing written (§57.4).
        if (!cur || cur.withdrawn_at) throw svc.noticeNotFound();
        const { rows } = await c.query<{ withdrawn_at: Date }>(
          `UPDATE dept_notices SET withdrawn_at = now(), withdrawn_by = $2 WHERE id = $1 AND withdrawn_at IS NULL RETURNING withdrawn_at`,
          [cur.id, userId],
        );
        return rows[0].withdrawn_at;
      }),
    );

    await writeActivity(tenantId, userId, "withdrew", "dept_notice", row.id, { scope: row.scope, unitNodeId: row.unit_node_id });
    return { id: row.id, withdrawnAt: withdrawnAt.toISOString() };
  }

  // ═══════════════════════════════════════════════ FAN-OUT (§57.6) ═══════════════════════════════════════════════

  /** One `notice.posted` per recipient, after the commit. Best effort at every step: whatever fails is logged with the notice id and
   *  the post stays posted. The recipients are computed from today's committed state; the author is never one. */
  private async fanOut(tenantId: string, authorId: string, notice: svc.NoticeRow, asOf: string): Promise<void> {
    let recipients: string[];
    try {
      recipients = await this.recipientsOf(tenantId, notice, asOf);
    } catch (err) {
      console.error(`[dept-notices] notice ${notice.id}: computing the audience failed, nobody notified:`, (err as Error)?.message ?? err);
      return;
    }
    const payload = {
      noticeId: notice.id,
      title: notice.title,
      scope: notice.scope,
      unitNodeId: notice.unitNodeId,
      unitName: notice.unitName,
      // The typed fields every notification carries (BFF §9(c)); the Inbox renders "<unit or Whole company>: <title>" and links here.
      href: svc.noticeHref(notice.scope, notice.unitNodeId, notice.id),
      entityType: "dept_notice",
      entityId: notice.id,
      severity: "info" as const,
    };
    for (const recipientId of recipients) {
      if (recipientId === authorId) continue;
      try {
        await notify(tenantId, recipientId, authorId, svc.NOTICE_POSTED, payload);
      } catch (err) {
        console.error(`[dept-notices] notice ${notice.id}: notify failed (recipient=${recipientId}):`, (err as Error)?.message ?? err);
      }
    }
  }

  private async recipientsOf(tenantId: string, notice: svc.NoticeRow, asOf: string): Promise<string[]> {
    if (notice.scope === "company" || notice.unitNodeId === null) {
      return withTenants([tenantId], (c) => svc.loadActiveMemberIds(c, tenantId));
    }
    const unit = notice.unitNodeId;
    const placed = await withTenants([tenantId], async (c) => {
      const structure = await loadOrgStructure(c, tenantId);
      return loadUnitRoster(c, tenantId, collectUnitSubtree(structure, unit), asOf);
    });
    // The heads of THIS unit exactly (a current org_unit_lead grant on it, held by an active member of this company): not the
    // heads above it, and not the company-wide tiers.
    const heads = await loadUnitLeadUserIds(tenantId, unit);
    return [...new Set([...placed, ...heads])].sort();
  }
}
