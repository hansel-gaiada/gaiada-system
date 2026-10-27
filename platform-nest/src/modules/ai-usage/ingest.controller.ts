// AIP-03b — `POST /api/internal/ai-usage`: the one route AI callers outside platform-nest (ai-agents runner, knowledge service, MCP hub,
// WhatsApp bot) report their gateway calls through. The rules live in ingest.ts; this file is the door.
//
// AUTH: ServiceGuard, exactly as `/principal/resolve`, `/auth/magic-link` and `/mcp/tool-defs` use it (auth/guards.ts): the Bearer token must
// equal PLATFORM_SERVICE_TOKEN, compared in constant time, and an unset token refuses everyone (fail-closed). A user session is a different
// credential (an OIDC JWT or a cookie), not the service token, so it is 401 here like a missing or wrong token. No tenant comes from the
// URL or a header: each event names its own company, which the ingest checks exists.
//
// SHAPE: the body is `{events: [...]}` with 1 to 100 events; anything else is 400. A bad event does not fail the batch (200 with its index in
// `rejected`). Nothing in the answer echoes a value the caller sent.
import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ServiceGuard } from "../../auth/guards";
import { INGEST_MAX_EVENTS, ingestAiUsage, type IngestResult } from "./ingest";

@Controller("api/internal/ai-usage")
export class AiUsageIngestController {
  @Post()
  @HttpCode(200)
  @UseGuards(ServiceGuard)
  async ingest(@Body() body: { events?: unknown }): Promise<IngestResult> {
    const events = body?.events;
    if (!Array.isArray(events) || events.length < 1 || events.length > INGEST_MAX_EVENTS) {
      throw new BadRequestException(`events must be an array of 1 to ${INGEST_MAX_EVENTS} events`);
    }
    return ingestAiUsage(events);
  }
}
