// A4 (erp-whatsapp-and-agent-runtime-e2e.md §2.4): thin proxy from the ERP to the bot's own
// ADMIN_TOKEN-gated /admin/* surface (session lifecycle, group registry, safe config). The UI
// never talks to the bot directly — every call goes through here, gated by the same isElevated
// predicate as admin-systems.controller.ts, using the platform-held bot admin token
// (config.services.bot.token) as the outbound Bearer. Fail-soft, never fabricates: bot not
// configured (no URL) -> 404 {error}; unreachable/non-2xx (other than a deliberate validation
// 400) -> 502 {error}; the bot's own 400 {error,field?} is surfaced verbatim.
//
// NOTE: there is deliberately NO "GET config" route here. Per doc §2.4's route table, the read
// path for bot config stays on the existing generic `GET /api/admin/:system/config`
// (admin-systems.controller.ts), whose connectionConfig("bot") now proxies the bot's own
// GET /admin/config fields. Only PUT lives here (matching the UI's existing updateBotConfig
// stub, which PUTs {key,value}). GET/PUT are different HTTP methods on the same path, so this
// does not collide with the generic route either way.
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { AuthGuard } from "../auth/guards";
import { isElevated } from "./elevated";

// Session start/QR involve WAHA session bring-up + QR image generation, which can be slower
// than the shared cross-service probe timeout -> a dedicated, longer budget.
const SESSION_TIMEOUT_MS = Number(process.env.ADMIN_SESSION_TIMEOUT_MS ?? 10_000);
// PUT config's allow-list: exactly the two fields the bot exposes as editable (§2.3).
const CONFIG_ALLOW_LIST = new Set(["postToGroups", "managementGroupId"]);

function requireElevated(req: FastifyRequest): void {
  if (!isElevated(req)) throw new ForbiddenException("platform admin required");
}

/** Proxy one call to the bot's admin surface. Fail-soft: no URL -> 404; network error/timeout/
 *  non-2xx (other than a passthrough 400) -> 502. Never throws anything else. */
async function botCall(
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const svc = config.services.bot;
  // Plain strings here (not objects): the global HttpErrorFilter (src/http-error.filter.ts)
  // renders a string response body verbatim as {error: <string>} — exactly the doc's contract.
  if (!svc.url) throw new NotFoundException("bot not configured");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? config.adminProbeTimeoutMs);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${svc.url.replace(/\/$/, "")}${path}`, {
      method,
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${svc.token}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new HttpException("bot admin unreachable", 502);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = undefined;
  }
  // Surface the bot's OWN validation errors verbatim (groups/config field-level checks) — this
  // is the bot being reachable and correctly rejecting bad input, not a proxy failure. The bot's
  // shape is {error, field?}; re-key `error` -> `message` so the shared filter (which reads
  // res.message) renders it, while still carrying `field` through.
  if (res.status === 400 && json && typeof json === "object") {
    const j = json as { error?: unknown; field?: unknown };
    throw new BadRequestException({
      message: typeof j.error === "string" ? j.error : "bad request",
      field: typeof j.field === "string" ? j.field : undefined,
    });
  }
  if (!res.ok) throw new HttpException("bot admin unreachable", 502);
  return json;
}

@Controller("api/admin/bot")
@UseGuards(AuthGuard)
export class BotAdminController {
  // ---- Session lifecycle ---- (@HttpCode(200): Nest defaults POST to 201, doc contract is 200)
  @Post("session/start")
  @HttpCode(200)
  async sessionStart(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("POST", "/admin/session/start", { timeoutMs: SESSION_TIMEOUT_MS });
  }

  @Get("session/status")
  async sessionStatus(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("GET", "/admin/session/status");
  }

  // QR is a pairing secret in transit — never cache it anywhere along the path.
  @Get("session/qr")
  async sessionQr(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    requireElevated(req);
    const json = await botCall("GET", "/admin/session/qr", { timeoutMs: SESSION_TIMEOUT_MS });
    reply.header("cache-control", "no-store").send(json);
  }

  @Post("session/stop")
  @HttpCode(200)
  async sessionStop(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("POST", "/admin/session/stop");
  }

  @Post("session/logout")
  @HttpCode(200)
  async sessionLogout(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("POST", "/admin/session/logout");
  }

  @Post("session/restart")
  @HttpCode(200)
  async sessionRestart(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("POST", "/admin/session/restart");
  }

  // ---- Group registry ----
  @Get("groups")
  async getGroups(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("GET", "/admin/groups");
  }

  @Put("groups")
  async setGroups(@Req() req: FastifyRequest, @Body() body: { groups?: unknown }) {
    requireElevated(req);
    // Top-level shape only — the bot owns per-field validation (id regex, isManagement
    // cardinality, length caps) and reports its own 400 {error, field} on failure.
    if (!Array.isArray(body?.groups)) {
      throw new BadRequestException({ message: "groups must be an array", field: "groups" });
    }
    return botCall("PUT", "/admin/groups", { body: { groups: body.groups } });
  }

  // ---- Safe config (write side only; read side is admin-systems.controller.ts's
  // connectionConfig("bot"), which proxies the bot's GET /admin/config) ----
  @Put("config")
  async setConfig(@Req() req: FastifyRequest, @Body() body: { key?: string; value?: unknown }) {
    requireElevated(req);
    const key = body?.key;
    if (typeof key !== "string" || !CONFIG_ALLOW_LIST.has(key)) {
      throw new BadRequestException({ message: "unsupported config key", field: "key" });
    }
    return botCall("PUT", "/admin/config", { body: { [key]: body?.value } });
  }

  // ---- Read-only chat viewer + logs (design doc addendum §chat-admin): the ERP's WA/TG
  // Bot page reads the bot's stored, already-decrypted-and-scrubbed transcripts through
  // here. Pure proxies — no additional PII handling on this side. ----
  @Get("chats")
  async listChats(@Req() req: FastifyRequest, @Query("limit") limit?: string) {
    requireElevated(req);
    return botCall("GET", `/admin/chats${limitQs(limit)}`);
  }

  @Get("chats/:chatId/messages")
  async chatMessages(@Req() req: FastifyRequest, @Param("chatId") chatId: string, @Query("limit") limit?: string) {
    requireElevated(req);
    return botCall("GET", `/admin/chats/${encodeURIComponent(chatId)}/messages${limitQs(limit)}`);
  }

  @Get("session/events")
  async sessionEvents(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("GET", "/admin/session/events");
  }

  // Exposes the bot's existing /admin/actions/audit for the Logs tab (no new bot route).
  @Get("actions/audit")
  async actionsAudit(@Req() req: FastifyRequest, @Query("limit") limit?: string) {
    requireElevated(req);
    return botCall("GET", `/admin/actions/audit${limitQs(limit)}`);
  }
}

function limitQs(limit?: string): string {
  return limit ? `?limit=${encodeURIComponent(limit)}` : "";
}
