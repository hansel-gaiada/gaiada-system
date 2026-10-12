// M5-W2b — the editorial read routes, Zone B control plane:
//
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/editorial/board                          editorial.board
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/editorial          editorial.history
//
// Guards: ControlAuthGuard (L1 + L2) -> CommandAuthorizationGuard (L3 `webdesk:read`). No editorial assertion
// (a read needs no principal), no audit row. Query validation is strict (400 invalid-request): an unknown key,
// a bad enum, an out-of-range limit or a malformed cursor is refused, never ignored.
import { Controller, Get, Param, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { ControlProblemFilter, problems } from "../content/content-problem";
import { REVIEW_STATES, type ReviewState } from "./editorial-model";
import { EditorialReadsService, type BoardQuery } from "./editorial-reads.service";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CURSOR_CHARS = 1024;

type RawQuery = Record<string, unknown>;

function query(raw: RawQuery | undefined, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!allowed.includes(k)) throw problems.invalidRequest(`unknown query parameter "${k}" (allowed: ${allowed.join(", ") || "none"})`);
    if (typeof v !== "string") throw problems.invalidRequest(`query parameter "${k}" must be given once, as a string`);
    out[k] = v;
  }
  return out;
}

@Controller("control/v1/tenants/:tenantSlug/sites/:siteId")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
@UseFilters(ControlProblemFilter)
export class EditorialReadsController {
  constructor(private readonly reads: EditorialReadsService) {}

  @Get("editorial/board")
  @Command("editorial.board")
  async board(@Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Query() raw: RawQuery) {
    const q = query(raw, ["state", "collection", "authorSub", "dueBefore", "cursor", "limit"]);
    if (q.state !== undefined && !(REVIEW_STATES as readonly string[]).includes(q.state)) {
      throw problems.invalidRequest(`state must be one of ${REVIEW_STATES.join(", ")}`);
    }
    for (const k of ["collection", "authorSub"] as const) {
      if (q[k] !== undefined && (q[k].length === 0 || q[k].length > 200)) throw problems.invalidRequest(`${k} must be a non-empty string of at most 200 characters`);
    }
    if (q.dueBefore !== undefined && (q.dueBefore.length > 64 || Number.isNaN(Date.parse(q.dueBefore)))) {
      throw problems.invalidRequest("dueBefore must be an ISO-8601 date or date-time");
    }
    if (q.cursor !== undefined && (q.cursor.length === 0 || q.cursor.length > MAX_CURSOR_CHARS)) {
      throw problems.invalidRequest("cursor is malformed; pass back the `page.cursor` of the previous response unchanged");
    }
    if (q.limit !== undefined && (!/^\d{1,4}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > MAX_LIMIT)) {
      throw problems.invalidRequest(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    }
    const input: BoardQuery = {
      state: q.state as ReviewState | undefined,
      collection: q.collection,
      authorSub: q.authorSub,
      dueBefore: q.dueBefore === undefined ? undefined : new Date(q.dueBefore).toISOString(),
      cursor: q.cursor,
      limit: q.limit === undefined ? DEFAULT_LIMIT : Number(q.limit),
    };
    return this.reads.board(tenantSlug, siteId, input);
  }

  @Get("content/items/:itemId/editorial")
  @Command("editorial.history")
  async history(@Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string, @Query() raw: RawQuery) {
    query(raw, []);
    return this.reads.history(tenantSlug, siteId, itemId);
  }
}
