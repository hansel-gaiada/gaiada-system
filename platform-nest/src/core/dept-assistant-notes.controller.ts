// AIP-23b (docs/plans/2026-10-31-aip-23-department-notes.md §4; owner rulings AIP-D20 to AIP-D24; docs/FRONTEND-BFF-CONTRACT.md §67;
// PERMISSION-CONTRACT §59) — department notes, a department's shared assistant memory:
//   GET    /api/:tenantId/departments/:unitNodeId/assistant-notes                 the notes the caller may read, their own, and capabilities (200)
//   POST   /api/:tenantId/departments/:unitNodeId/assistant-notes                 { body, record? }: suggest (201); an approver's own is approved at once
//   POST   /api/:tenantId/departments/:unitNodeId/assistant-notes/:id/withdraw    the author takes it back: the row is DELETED (200)
//   POST   /api/:tenantId/departments/:unitNodeId/assistant-notes/:id/decide      { approve, reason? }: approve, or reject (the row is DELETED) (200)
//   DELETE /api/:tenantId/departments/:unitNodeId/assistant-notes/:id             an approver removes a note (200)
//   POST   /api/:tenantId/departments/:unitNodeId/assistant-notes/:id/pin         { pinned }: an approver pins or unpins an approved note (200)
// The Cerbos kind is `dept_assistant_note` (resource_dept_assistant_note.yaml). The rules, validation, facts and SQL are in
// dept-assistant-notes.service.ts; this file is routes and the order of checks. NOT here: the notices (AIP-23d), the prompt feed, the
// ASSISTANT_DEPT_NOTES switch and the name guard (AIP-23c), any screen.
//
// ── THE ORDER OF CHECKS (the dept-notices trap, §57.3: a validation that fires first silently stops a denial test testing authz) ──────
//   (1) the FACTS, in one `withTenants` read: the unit's ancestry (WITH the tenant), the caller's home ancestry, the GM seats, and, for a named
//       note, its author (the row IS the Cerbos attribute of `withdraw`),
//   (2) AUTHORIZE: `manage` (the company tier) when the caller holds it, else the per-unit action (`read`, `propose`, `decide`, `delete`, `pin`);
//       `withdraw` is the author's own action and has no company tier,
//   (3) the body (400; a refused caller always gets 403, never a 400),
//   (4) the department itself (`resolveDepartment`: an ACTIVE department of THIS company), 404 `department_not_found`,
//   (5) POST only: the linked record, through the knowledge filter's per-record read check (Cerbos, so outside the transaction): 400,
//   (6) the write, one `withTenants` transaction under a per-department advisory lock: 404 `note_not_found` for a note that is not there (another
//       company's id included), 409 for the caps and the status rules,
//   (7) one activity per event, with the unit and the length and never the text.
// A member asking about a unit outside their home subtree is refused (403) before anything says whether it exists. An approver (the GM, the owner,
// a head above) is authorized company- or subtree-wide and then learns the 404. Authorization (an HTTP call to Cerbos) is never done inside a
// transaction.
//
// ── THE COMPANY TIER IS ITS OWN ACTION (`manage`) ────────────────────────────────────────────────
// `owner` is permission-native (no Cerbos role rules), and a flat permission mirror on any per-unit action would let a holder reach every
// department, so the company tier is a separate action held only by the owner (OWNER_EXTENSION) and the superadmin (AIP-13b's key split). The
// handler asks every action in one `checkActions` probe (it audits nothing), picks `manage` when it is allowed, and then authorizes the picked
// action through `authorize()`, so a denial, its audit row and the delegation intersection are the house ones.
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, HttpException, NotFoundException, Param, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { AuthGuard } from "../auth/guards";
import { checkActions } from "../rbac/cerbos";
import type { Principal } from "../rbac/principal";
import { authorize, writeActivity } from "./http";
import { resolveDepartment } from "../modules/assistant/department-context";
import type { TurnDepartment } from "../modules/assistant/department-context";
import { filterReadableHits, type Family } from "../modules/knowledge/search-filter";
import * as svc from "./dept-assistant-notes.service";

const ENTITY = svc.NOTE_KIND;

type Decisions = Record<svc.NoteAction, boolean>;

function httpFromRule(e: svc.NoteRuleError): HttpException {
  const body = { message: e.message, ...(e.field ? { field: e.field } : {}) };
  if (e.httpStatus === 400) return new BadRequestException(body);
  if (e.httpStatus === 404) return new NotFoundException(body);
  return new ConflictException(body);
}
async function mapRules<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof svc.NoteRuleError) throw httpFromRule(e);
    throw e;
  }
}

/** The request's facts and the resource built from them. `named` loads the author of `:id` too (the attribute of `withdraw`). */
async function loadContext(principal: Principal, tenantId: string, unitNodeId: string, noteId?: string) {
  return withTenants([tenantId], async (c) => {
    const facts = await svc.loadNoteFacts(c, tenantId, unitNodeId, principal.userId);
    const note = noteId === undefined ? null : await svc.loadNoteAuthor(c, tenantId, unitNodeId, noteId);
    return { facts, note, resource: svc.noteResource(tenantId, unitNodeId, facts, note) };
  });
}

/** Every action of the kind for this caller on this resource, in one advisory probe (no audit row). */
async function decisions(principal: Principal, resource: ReturnType<typeof svc.noteResource>): Promise<Decisions> {
  return (await checkActions(principal, resource, svc.NOTE_ACTIONS)) as Decisions;
}

/** Authorize `unitAction`, or the company tier's `manage` for a caller who holds it (AIP-13b's key split). */
async function authorizeUnit(principal: Principal, resource: ReturnType<typeof svc.noteResource>, d: Decisions, unitAction: svc.NoteAction): Promise<void> {
  await authorize(principal, resource, d.manage ? "manage" : unitAction);
}

/** The department this route names: an ACTIVE department of this company, or 404. The stored node id is what the rows are keyed by. */
async function departmentOf(tenantId: string, unitNodeId: string): Promise<TurnDepartment> {
  const department = await withTenants([tenantId], (c) => resolveDepartment(c, tenantId, unitNodeId));
  if (!department || svc.cpLength(department.nodeId) > svc.UNIT_NODE_ID_MAX_CHARS) throw svc.departmentNotFound();
  return department;
}

/** May this caller's own suggestion be approved at once? An approver here (a head of the unit or above, the GM, the owner, the superadmin),
 *  never when the call acts for someone else (the delegation intersection is not run on an advisory probe, so it simply waits). */
function selfApproves(principal: Principal, d: Decisions): boolean {
  if (!(d.manage || d.decide)) return false;
  return !principal.actFor || principal.actFor.userId === principal.userId;
}

@Controller("api/:tenantId/departments/:unitNodeId/assistant-notes")
@UseGuards(AuthGuard)
export class DeptAssistantNotesController {
  @Get()
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("unitNodeId") unitNodeId: string) {
    const principal = req.principal;
    const { resource } = await loadContext(principal, tenantId, unitNodeId);
    const d = await decisions(principal, resource);
    await authorizeUnit(principal, resource, d, "read");
    return mapRules(async () => {
      const department = await departmentOf(tenantId, unitNodeId);
      const capabilities: svc.NoteCapabilities = { canPropose: d.manage || d.propose, canDecide: d.manage || d.decide, canManage: d.manage };
      const userId = principal.userId ?? null;
      const lists = await withTenants([tenantId], (c) => svc.loadNoteLists(c, tenantId, department.nodeId, userId, capabilities.canDecide));

      // THE RECORD FILTER (plan §4.5, DW-D26): a note linked to a record is listed only to a caller who passes that record's read check, run as
      // the caller now, through the knowledge filter (existence in this company, the module switch, the record's own Cerbos read). A refused
      // note is dropped SILENTLY. The caller's OWN suggestions are exempt: it is their text and their link.
      const refs = new Map<string, { family: Family; id: string }>();
      for (const row of [...lists.approved, ...lists.waiting]) {
        if (!row.record_kind || !row.record_id || row.proposed_by === userId) continue;
        // A kind the filter does not know is never readable (fail closed): it is simply not asked about.
        if (!(svc.LINKABLE_KINDS as readonly string[]).includes(row.record_kind)) continue;
        refs.set(`${row.record_kind}:${row.record_id}`, { family: row.record_kind as Family, id: row.record_id });
      }
      const readable = new Set<string>();
      if (refs.size > 0) {
        for (const hit of await filterReadableHits(principal, tenantId, [...refs.values()])) readable.add(`${hit.candidate.family}:${hit.candidate.id}`);
      }
      const visible = (row: svc.NoteDbRow): boolean =>
        !row.record_kind || !row.record_id || row.proposed_by === userId || readable.has(`${row.record_kind}:${row.record_id}`);

      return {
        unitNodeId: department.nodeId,
        department: { name: department.name, key: department.key },
        approved: lists.approved.filter(visible).map(svc.toNoteView),
        waiting: lists.waiting.filter(visible).map(svc.toNoteView),
        mine: lists.mine.map(svc.toNoteView),
        capabilities,
        limits: {
          bodyMaxChars: svc.NOTE_BODY_MAX_CHARS,
          approvedPerDepartment: svc.APPROVED_PER_DEPARTMENT_MAX,
          waitingPerPerson: svc.WAITING_PER_PERSON_MAX,
        },
      };
    });
  }

  @Post()
  @HttpCode(201)
  async propose(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("unitNodeId") unitNodeId: string, @Body() body: unknown) {
    const principal = req.principal;
    const { resource } = await loadContext(principal, tenantId, unitNodeId);
    const d = await decisions(principal, resource);
    await authorizeUnit(principal, resource, d, "propose");
    if (!principal.userId) throw new BadRequestException("no principal user");
    const userId = principal.userId;
    const input = await mapRules(() => svc.parseProposeBody(body));
    return mapRules(async () => {
      const department = await departmentOf(tenantId, unitNodeId);
      // The link: the record must exist in THIS company and be readable by the caller now (the same check the list applies). One answer for
      // "absent" and "not yours to open", so the route is no existence oracle.
      if (input.record) {
        const ok = await filterReadableHits(principal, tenantId, [{ family: input.record.kind, id: input.record.id }]);
        if (ok.length === 0) throw new svc.NoteRuleError(400, "record_not_found", "record");
      }
      const approved = selfApproves(principal, d);
      const out = await withTenants([tenantId], async (c) => {
        await svc.lockDepartment(c, tenantId, department.nodeId);
        if (approved) {
          if ((await svc.countApproved(c, tenantId, department.nodeId)) >= svc.APPROVED_PER_DEPARTMENT_MAX) {
            throw new svc.NoteRuleError(409, "approved_limit_reached", "body");
          }
        } else if ((await svc.countWaitingBy(c, tenantId, department.nodeId, userId)) >= svc.WAITING_PER_PERSON_MAX) {
          throw new svc.NoteRuleError(409, "waiting_limit_reached", "body");
        }
        const name = await svc.loadUserName(c, userId);
        const id = await svc.insertNote(c, tenantId, department.nodeId, input, { id: userId, name }, approved);
        return (await svc.loadNote(c, tenantId, department.nodeId, id))!;
      });
      const meta = { unitNodeId: department.nodeId, length: svc.cpLength(input.text) };
      await writeActivity(tenantId, userId, "suggested", ENTITY, out.id, meta);
      if (approved) await writeActivity(tenantId, userId, "approved", ENTITY, out.id, meta);
      return svc.toNoteView(out);
    });
  }

  @Post(":id/withdraw")
  @HttpCode(200)
  async withdraw(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("unitNodeId") unitNodeId: string,
    @Param("id") id: string,
  ) {
    const principal = req.principal;
    const { resource } = await loadContext(principal, tenantId, unitNodeId, id);
    // The author's own action: no company tier. A note that is not there (or not theirs) feeds no author, so the rule cannot match: 403.
    await authorize(principal, resource, "withdraw");
    return mapRules(async () => {
      const department = await departmentOf(tenantId, unitNodeId);
      const gone = await withTenants([tenantId], async (c) => {
        const row = await svc.loadNote(c, tenantId, department.nodeId, id);
        if (!row) throw svc.noteNotFound();
        await svc.deleteNote(c, tenantId, row.id);
        return row;
      });
      await writeActivity(tenantId, principal.userId ?? null, "withdrawn", ENTITY, gone.id, { unitNodeId: department.nodeId, length: svc.cpLength(gone.body) });
      return { id: gone.id, status: "withdrawn" as const };
    });
  }

  @Post(":id/decide")
  @HttpCode(200)
  async decide(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("unitNodeId") unitNodeId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const principal = req.principal;
    const { resource } = await loadContext(principal, tenantId, unitNodeId, id);
    const d = await decisions(principal, resource);
    await authorizeUnit(principal, resource, d, "decide");
    if (!principal.userId) throw new BadRequestException("no principal user");
    const userId = principal.userId;
    // `reason` is validated and then dropped: nothing stores it (the notice that carries it to the person is AIP-23d).
    const input = await mapRules(() => svc.parseDecideBody(body));
    return mapRules(async () => {
      const department = await departmentOf(tenantId, unitNodeId);
      const out = await withTenants([tenantId], async (c) => {
        await svc.lockDepartment(c, tenantId, department.nodeId);
        const row = await svc.loadNote(c, tenantId, department.nodeId, id);
        if (!row) throw svc.noteNotFound();
        if (row.status !== "proposed") throw new svc.NoteRuleError(409, "note_already_decided", "id");
        if (!input.approve) {
          await svc.deleteNote(c, tenantId, row.id);
          return { row, approved: null };
        }
        if ((await svc.countApproved(c, tenantId, department.nodeId)) >= svc.APPROVED_PER_DEPARTMENT_MAX) {
          throw new svc.NoteRuleError(409, "approved_limit_reached", "approve");
        }
        await svc.approveNote(c, tenantId, row.id, { id: userId, name: await svc.loadUserName(c, userId) });
        return { row, approved: (await svc.loadNote(c, tenantId, department.nodeId, row.id))! };
      });
      const meta = { unitNodeId: department.nodeId, length: svc.cpLength(out.row.body) };
      if (!out.approved) {
        await writeActivity(tenantId, userId, "rejected", ENTITY, out.row.id, meta);
        return { id: out.row.id, status: "rejected" as const };
      }
      await writeActivity(tenantId, userId, "approved", ENTITY, out.row.id, meta);
      return svc.toNoteView(out.approved);
    });
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("unitNodeId") unitNodeId: string,
    @Param("id") id: string,
  ) {
    const principal = req.principal;
    const { resource } = await loadContext(principal, tenantId, unitNodeId, id);
    const d = await decisions(principal, resource);
    await authorizeUnit(principal, resource, d, "delete");
    return mapRules(async () => {
      const department = await departmentOf(tenantId, unitNodeId);
      const gone = await withTenants([tenantId], async (c) => {
        const row = await svc.loadNote(c, tenantId, department.nodeId, id);
        if (!row) throw svc.noteNotFound();
        await svc.deleteNote(c, tenantId, row.id);
        return row;
      });
      await writeActivity(tenantId, principal.userId ?? null, "deleted", ENTITY, gone.id, { unitNodeId: department.nodeId, length: svc.cpLength(gone.body) });
      return { id: gone.id, status: "deleted" as const };
    });
  }

  @Post(":id/pin")
  @HttpCode(200)
  async pin(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("unitNodeId") unitNodeId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const principal = req.principal;
    const { resource } = await loadContext(principal, tenantId, unitNodeId, id);
    const d = await decisions(principal, resource);
    await authorizeUnit(principal, resource, d, "pin");
    const input = await mapRules(() => svc.parsePinBody(body));
    return mapRules(async () => {
      const department = await departmentOf(tenantId, unitNodeId);
      const out = await withTenants([tenantId], async (c) => {
        const row = await svc.loadNote(c, tenantId, department.nodeId, id);
        if (!row) throw svc.noteNotFound();
        if (row.status !== "approved") throw new svc.NoteRuleError(409, "note_not_approved", "id");
        const changed = row.pinned !== input.pinned;
        if (changed) await svc.setPinned(c, tenantId, row.id, input.pinned);
        return { changed, row: (await svc.loadNote(c, tenantId, department.nodeId, row.id))! };
      });
      // A pin that changes nothing says nothing.
      if (out.changed) {
        await writeActivity(tenantId, principal.userId ?? null, input.pinned ? "pinned" : "unpinned", ENTITY, out.row.id, {
          unitNodeId: department.nodeId,
          length: svc.cpLength(out.row.body),
        });
      }
      return svc.toNoteView(out.row);
    });
  }
}
