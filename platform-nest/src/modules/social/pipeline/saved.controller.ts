// SCP-5e (W5-B3) — Saved, each client's content bank: the routes (FRONTEND-BFF-CONTRACT §63.26). Mounted under `api/:tenantId/modules/social`, behind
// AuthGuard and ModuleEnabledGuard("social"). The reads and writes are saved-data.ts's, the bodies and queries saved.ts's (pure).
//
//   GET    engagements/:engagementId/saved                         social_post · read    {collections: [{key, label, holds, derived, count, previews}], canAdd}
//   GET    engagements/:engagementId/saved?collection=&pillar=&used=&source=&cursor=&limit=   social_post · read   {items, nextCursor}
//   POST   engagements/:engagementId/saved                         social_post · create  201 {item, created: true}; 200 {item, created: false} for a replayed id or a kept asset
//   PATCH  saved/:itemId                                           its author's, else manage    200 {item}
//   DELETE saved/:itemId                                           its author's, else manage    200 {id, deleted: true}
// and `savedItemIds` on `PATCH posts/:postId/pipeline` (63.6.3), which pipeline.service.ts counts in the edit's own transaction.
//
// WHO (SCP-Q29, §63.26.2), asked on the client's WOULD-BE POST (the engagement's officer, the four's seats, no post: the resource of §63.6.1):
//   read    `social_post` · `read`: the team's read tier. The bank is never in the portal (the portal has no route here).
//   add     `social_post` · `create`: whoever holds it on the company's posts (the Social Media team's roles; also `company_admin` and `manager`, which
//           already hold it on every post). A denial is today's generic 403.
//   change  the item's author (who still holds `create`), or `manage` on the client's would-be post (the officer, the HoD and GM seats; the superadmin
//           by the wildcard): anyone else is 403 `not_officer_or_approver`.
//   An unattended automation (`users.kind` automation or bot) is refused every write 403 `automation_cannot_act`; an agent acting for a person arrives
//   as that person. No new Cerbos action (PERMISSION §57).
//
// ORDER: the reads judge `read` first (there is no per-client resource), then 404 `engagement_not_found`, then the query (400). A write answers 404
// (`engagement_not_found`, `saved_item_not_found`; another company's id is absent), then 403, then 400 `{field}`, then the body's own 404
// (`asset_not_found`). A replayed `id` answers before the body is judged, as every create does (§63.0).
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { authorize, writeActivity } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import type { Resource } from "../../../rbac/cerbos";
import type { Principal } from "../../../rbac/principal";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { loadSocialApproverIds } from "../pipeline-authz";
import { authorizeCoded } from "./boosts";
import { loadEngagement, type EngagementRow } from "./pipeline-data";
import { ScpRouteError } from "./pipeline-effects";
import { cerbosDecisionsFor, isAutomationPrincipal } from "./pipeline.service";
import { savedCategories, socialRules } from "./rules";
import {
  addSavedItemInTx, deleteSavedItemInTx, findSavedById, loadSavedRow, patchSavedItemInTx, readCollectionItems, readCollections, readSavedItem,
  type SavedPage, type SavedRow,
} from "./saved-data";
import {
  isUuid, parseSavedCreate, parseSavedListQuery, parseSavedPatch, type SavedCollection, type SavedItem,
} from "./saved";

const SOCIAL = { modules: ["social"] };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The client's would-be post (the gate of §63.6.1 and §63.25.2): its officer and the four, from the rows. */
const wouldBePost = (tenantId: string, eng: Pick<EngagementRow, "owner_id">, approverIds: string[]): Resource => ({
  kind: "social_post", tenantId, module: "social", ownerId: eng.owner_id ?? "", creatorId: "", approverIds, assigneeIds: [], creativeSource: "",
});

/** The engagement and the four's seats, or null for an engagement of no company of the caller's. */
async function loadClient(tenantId: string, engagementId: string): Promise<{ eng: EngagementRow; approverIds: string[] } | null> {
  if (!isUuid(engagementId)) return null;
  return withTenants([tenantId], async (c) => {
    const eng = await loadEngagement(c, tenantId, engagementId);
    return eng ? { eng, approverIds: await loadSocialApproverIds(c, tenantId) } : null;
  }, SOCIAL);
}

/** An automation is refused first (it holds nothing here), then `create` on the would-be post (the generic audited 403). Answers the person. */
async function authorizeAdd(principal: Principal, resource: Resource): Promise<string> {
  if (isAutomationPrincipal(principal)) throw new ScpRouteError(403, "automation_cannot_act");
  await authorize(principal, resource, "create");
  if (!principal.userId) throw new ScpRouteError(403, "automation_cannot_act");
  return principal.userId;
}

/** Change or delete (SCP-Q29): the author's own (who still holds `create`), else `manage` on the client's would-be post: 403 `not_officer_or_approver`. */
async function authorizeChange(principal: Principal, resource: Resource, authorId: string): Promise<string> {
  if (isAutomationPrincipal(principal)) throw new ScpRouteError(403, "automation_cannot_act");
  const asked = await cerbosDecisionsFor(principal, resource, ["create", "manage"]);
  const mine = !!principal.userId && principal.userId === authorId && asked.create === true;
  return authorizeCoded(principal, resource, mine ? "create" : "manage", "not_officer_or_approver");
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialSavedController {
  // ── The reads ───────────────────────────────────────────────────────────────────────────────────────────────────────
  @Get("engagements/:engagementId/saved")
  async list(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string, @Query() q: Record<string, unknown>,
  ): Promise<{ collections: SavedCollection[]; canAdd: boolean } | { items: SavedPage["items"]; nextCursor: string | null }> {
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "read");
    const pre = await loadClient(tenantId, engagementId);
    if (!pre) throw new ScpRouteError(404, "engagement_not_found");
    const canAdd = isAutomationPrincipal(req.principal) ? false : (await cerbosDecisionsFor(req.principal, wouldBePost(tenantId, pre.eng, pre.approverIds), ["create"])).create === true;
    return withTenants([tenantId], async (c) => {
      const rules = (await socialRules(c, tenantId)).rules;
      const query = parseSavedListQuery(q ?? {}, savedCategories(rules));
      if (query.collection === null) return { collections: await readCollections(c, tenantId, pre.eng, rules), canAdd };
      const page = await readCollectionItems(c, tenantId, pre.eng, rules, query);
      return { items: page.items, nextCursor: page.nextCursor };
    }, SOCIAL);
  }

  // ── Add ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  @Post("engagements/:engagementId/saved")
  @HttpCode(201)
  async add(
    @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("tenantId") tenantId: string,
    @Param("engagementId") engagementId: string, @Body() body: unknown,
  ): Promise<{ item: SavedItem; created: boolean }> {
    const pre = await loadClient(tenantId, engagementId);
    if (!pre) throw new ScpRouteError(404, "engagement_not_found");
    const actorId = await authorizeAdd(req.principal, wouldBePost(tenantId, pre.eng, pre.approverIds));

    const out = await withTenants([tenantId], async (c) => {
      // A replayed `id` answers with the item as it stands, before the rest of the body is judged (§63.0).
      const wanted = isObj(body) && isUuid(body.id) ? body.id.toLowerCase() : null;
      if (wanted) {
        const mine = await findSavedById(c, tenantId, wanted);
        if (mine) {
          if (mine.engagementId !== pre.eng.id || mine.deleted) throw new ScpRouteError(400, "invalid_field", { field: "id" });
          return { id: mine.id, created: false, item: (await readSavedItem(c, tenantId, mine.id)) as SavedItem };
        }
      }
      const rules = (await socialRules(c, tenantId)).rules;
      const input = parseSavedCreate(body, savedCategories(rules));
      const r = await addSavedItemInTx(c, { tenantId, engagementId: pre.eng.id, actorId, input });
      return { ...r, item: (await readSavedItem(c, tenantId, r.id)) as SavedItem };
    }, SOCIAL);
    if (out.created) {
      await writeActivity(tenantId, actorId, "saved_item_added", "social_saved_item", out.id, {
        engagementId: pre.eng.id, category: out.item.category, holds: out.item.holds,
      });
    } else {
      reply.status(200);
    }
    return { item: out.item, created: out.created };
  }

  // ── Change ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  @Patch("saved/:itemId")
  async change(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("itemId") itemId: string, @Body() body: unknown): Promise<{ item: SavedItem }> {
    const { row, pre } = await this.gate(tenantId, itemId);
    const actorId = await authorizeChange(req.principal, wouldBePost(tenantId, pre.eng, pre.approverIds), row.created_by);
    const item = await withTenants([tenantId], async (c) => {
      const locked = await loadSavedRow(c, tenantId, row.id, true);
      if (!locked || locked.deleted) throw new ScpRouteError(404, "saved_item_not_found");
      const rules = (await socialRules(c, tenantId)).rules;
      const patch = parseSavedPatch(body, locked, savedCategories(rules));
      await patchSavedItemInTx(c, { tenantId, itemId: row.id, actorId, patch });
      return (await readSavedItem(c, tenantId, row.id)) as SavedItem;
    }, SOCIAL);
    await writeActivity(tenantId, actorId, "saved_item_changed", "social_saved_item", row.id, { engagementId: pre.eng.id, fields: Object.keys(isObj(body) ? body : {}) });
    return { item };
  }

  // ── Delete ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  @Delete("saved/:itemId")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("itemId") itemId: string): Promise<{ id: string; deleted: true }> {
    const { row, pre } = await this.gate(tenantId, itemId);
    const actorId = await authorizeChange(req.principal, wouldBePost(tenantId, pre.eng, pre.approverIds), row.created_by);
    await withTenants([tenantId], async (c) => {
      const locked = await loadSavedRow(c, tenantId, row.id, true);
      if (!locked || locked.deleted) throw new ScpRouteError(404, "saved_item_not_found");
      await deleteSavedItemInTx(c, { tenantId, itemId: row.id, actorId });
    }, SOCIAL);
    await writeActivity(tenantId, actorId, "saved_item_removed", "social_saved_item", row.id, { engagementId: pre.eng.id });
    return { id: row.id, deleted: true };
  }

  /** 404 `saved_item_not_found` for an item that is absent, deleted or another company's; else the row and its client. */
  private async gate(tenantId: string, itemId: string): Promise<{ row: SavedRow; pre: { eng: EngagementRow; approverIds: string[] } }> {
    const found = isUuid(itemId)
      ? await withTenants([tenantId], async (c) => {
        const row = await loadSavedRow(c, tenantId, itemId);
        if (!row || row.deleted) return null;
        const eng = await loadEngagement(c, tenantId, row.engagementId);
        return eng ? { row, pre: { eng, approverIds: await loadSocialApproverIds(c, tenantId) } } : null;
      }, SOCIAL)
      : null;
    if (!found) throw new ScpRouteError(404, "saved_item_not_found");
    return found;
  }
}
