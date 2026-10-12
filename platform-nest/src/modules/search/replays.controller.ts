// M5-V6-b — the session-recording routes (design 2026-10-12 §6.3, §4.8). Under api/:tenantId/modules/search/properties/:propertyId/:
//   GET  visitors/:visitorId/recordings        Cerbos resource_search_property · view_replay   METADATA ONLY (MCP: search.replays.list)
//   GET  recordings/:recordingId/chunks?from   Cerbos resource_search_property · view_replay   the content, 20 chunks a page, through the BFF
// There is NO download route and NO MCP tool for the content (O7: in v1 no tool returns recording content). The player (V6-c) calls the chunk
// route; the browser never talks to the collector.
//
// `view_replay` (V3-f) is a separate action from `read_visitors`: module_manager and company_admin only, never plain module_staff. Authorize
// BEFORE validating (a denial never depends on an id or `from`); 403 (not allowed) and 404 (the property, the visitor or the recording is not
// this company's, or has no live verified profile) are distinct. A collector that cannot answer is a typed 503 {error, reason}, never an empty
// list. Opening a recording (the first page, `from` absent or 0) writes ONE activity row, before any content leaves; see replays.service.ts.
import {
  BadRequestException, Controller, Get, Header, NotFoundException, Param, Query, Req, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  ReplayRequestError, ReplayUnavailableError, listRecordings, readRecordingChunks, type ChunksPage, type RecordingsList,
} from "./replays.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The collector keeps at most 1000 chunks (seq 0..999) per recording. */
export const REPLAY_FROM_MAX = 999;

/** `from`: absent or empty = 0; otherwise a whole number 0..999. */
export function parseFrom(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) > REPLAY_FROM_MAX) throw new ReplayRequestError("from_invalid", `from must be a whole number from 0 to ${REPLAY_FROM_MAX}`);
  return Number(raw);
}

function asHttp(e: unknown): unknown {
  if (e instanceof ReplayRequestError) return new BadRequestException({ message: e.message, reason: e.reason });
  if (e instanceof ReplayUnavailableError) return new ServiceUnavailableException({ message: e.message, reason: e.reason });
  return e;
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchReplaysController {
  private async gate(req: FastifyRequest, tenantId: string, propertyId: string): Promise<void> {
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, "view_replay");
  }

  @Get("properties/:propertyId/visitors/:visitorId/recordings")
  @Header("Cache-Control", "no-store")
  async recordings(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("visitorId") visitorId: string,
  ): Promise<RecordingsList> {
    await this.gate(req, tenantId, propertyId);
    if (!UUID_RE.test(visitorId)) throw new BadRequestException({ message: "visitorId must be a valid id", reason: "visitor_id_invalid" });
    let out;
    try { out = await listRecordings(tenantId, propertyId, visitorId.toLowerCase()); } catch (e) { throw asHttp(e); }
    if (!out.propertyFound) throw new NotFoundException("property not found");
    if (!out.visitorFound) throw new NotFoundException({ message: "no consented visitor with this id on this property", reason: "visitor_not_found" });
    return out.list;
  }

  @Get("properties/:propertyId/recordings/:recordingId/chunks")
  @Header("Cache-Control", "no-store")
  async chunks(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("recordingId") recordingId: string,
    @Query("from") from?: string,
  ): Promise<ChunksPage> {
    await this.gate(req, tenantId, propertyId);
    if (!UUID_RE.test(recordingId)) throw new BadRequestException({ message: "recordingId must be a valid id", reason: "recording_id_invalid" });
    let out;
    try {
      out = await readRecordingChunks(tenantId, propertyId, recordingId.toLowerCase(), parseFrom(from), req.principal.userId ?? null);
    } catch (e) { throw asHttp(e); }
    if (!out.propertyFound) throw new NotFoundException("property not found");
    if (!out.page) throw new NotFoundException({ message: "no recording with this id for a consented visitor on this property", reason: "recording_not_found" });
    return out.page;
  }
}
