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
// A manual digest run calls the AI gateway (map-reduce summarization over a day's messages) —
// a real run over 11 groups measured ~90s. The run itself is now ASYNC (the bot answers 202
// immediately; see runDigest below), but this budget still gates the async trigger call itself,
// the preview route (which DOES synchronously wait on summarization for one chat), and gives
// headroom over the old 60s that produced a false "502 bot admin unreachable" while a sync run
// was still completing.
const DIGEST_TIMEOUT_MS = Number(process.env.ADMIN_DIGEST_TIMEOUT_MS ?? 180_000);
// PUT config's allow-list: exactly the two fields the bot exposes as editable (§2.3).
const CONFIG_ALLOW_LIST = new Set(["postToGroups", "managementGroupId"]);

function requireElevated(req: FastifyRequest): void {
  if (!isElevated(req)) throw new ForbiddenException("platform admin required");
}

interface RawBotResult {
  status: number;
  json: unknown;
}

/** The raw fetch shared by botCall and botCallRawStatus below: resolves the bot's URL, sets the
 *  Bearer + timeout, and parses whatever JSON comes back. Never throws except NotFoundException
 *  (no bot URL configured) or HttpException(502) (network error/timeout) — both terminal, since
 *  neither caller can do anything useful with a response that never arrived. */
async function fetchBot(
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<RawBotResult> {
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
  return { status: res.status, json };
}

/** Proxy one call to the bot's admin surface. Fail-soft: no URL -> 404; network error/timeout/
 *  non-2xx (other than a passthrough 400) -> 502. Never throws anything else. */
async function botCall(
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const { status, json } = await fetchBot(method, path, opts);
  // Surface the bot's OWN validation errors verbatim (groups/config field-level checks) — this
  // is the bot being reachable and correctly rejecting bad input, not a proxy failure. The bot's
  // shape is {error, field?}; re-key `error` -> `message` so the shared filter (which reads
  // res.message) renders it, while still carrying `field` through.
  if (status === 400 && json && typeof json === "object") {
    const j = json as { error?: unknown; field?: unknown };
    throw new BadRequestException({
      message: typeof j.error === "string" ? j.error : "bad request",
      field: typeof j.field === "string" ? j.field : undefined,
    });
  }
  // 404 is likewise the bot answering correctly ("unknown chat (no stored messages)"), not a
  // proxy failure — collapsing it into 502 made the Chats tab report the bot as unreachable
  // for a chat that simply has no transcript yet.
  if (status === 404) {
    const j = (json ?? {}) as { error?: unknown };
    throw new NotFoundException(typeof j.error === "string" ? j.error : "not found");
  }
  if (status < 200 || status >= 300) throw new HttpException("bot admin unreachable", 502);
  return json;
}

/** Like botCall, but for the ONE route whose non-2xx status is itself meaningful to the caller
 *  (the async digest trigger's 409 "already in flight") and must reach the UI verbatim instead
 *  of being collapsed into botCall's throw-on-anything-but-2xx contract. Everything else behaves
 *  exactly like botCall: 400 passthrough validation, 404, unreachable -> 502. */
async function botCallRawStatus(
  method: "GET" | "POST" | "PUT",
  path: string,
  opts: { body?: unknown; timeoutMs?: number; passthroughStatuses: number[] },
): Promise<RawBotResult> {
  const { status, json } = await fetchBot(method, path, opts);
  if (opts.passthroughStatuses.includes(status)) return { status, json };
  if (status === 400 && json && typeof json === "object") {
    const j = json as { error?: unknown; field?: unknown };
    throw new BadRequestException({
      message: typeof j.error === "string" ? j.error : "bad request",
      field: typeof j.field === "string" ? j.field : undefined,
    });
  }
  if (status === 404) {
    const j = (json ?? {}) as { error?: unknown };
    throw new NotFoundException(typeof j.error === "string" ? j.error : "not found");
  }
  if (status < 200 || status >= 300) throw new HttpException("bot admin unreachable", 502);
  return { status, json };
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
  async listChats(
    @Req() req: FastifyRequest,
    @Query("limit") limit?: string,
    @Query("q") q?: string,
    @Query("kind") kind?: string,
  ) {
    requireElevated(req);
    return botCall("GET", `/admin/chats${qs({ limit, q, kind })}`);
  }

  @Get("chats/:chatId/messages")
  async chatMessages(
    @Req() req: FastifyRequest,
    @Param("chatId") chatId: string,
    @Query("limit") limit?: string,
    @Query("beforeTs") beforeTs?: string,
  ) {
    requireElevated(req);
    return botCall("GET", `/admin/chats/${encodeURIComponent(chatId)}/messages${qs({ limit, beforeTs })}`);
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

  // ---- Actions kill switch (Controls tab) ----
  @Post("actions/:state")
  @HttpCode(200)
  async setActionsState(@Req() req: FastifyRequest, @Param("state") state: string) {
    requireElevated(req);
    if (state !== "on" && state !== "off") {
      throw new BadRequestException({ message: "state must be on or off", field: "state" });
    }
    return botCall("POST", `/admin/actions/${state}`);
  }

  // ---- Manual digest runs + history (Controls tab). Proxies the bot's ASYNC trigger
  // (POST /admin/digests/run/:slot — NOT the older synchronous /run-digests/:slot, which the
  // n8n digest-fanout automation calls directly with BOT_ADMIN_TOKEN and which this proxy no
  // longer touches). The bot never awaits the run itself — it answers 202 the instant the run
  // starts, or 409 if this slot already has one in flight — so both statuses are passed straight
  // through to the UI rather than collapsed to 200. The digest-history route below is the
  // authoritative record of what a run actually did. ----
  @Post("digests/run/:slot")
  async runDigest(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("slot") slot: string) {
    requireElevated(req);
    if (slot !== "noon" && slot !== "evening") {
      throw new BadRequestException({ message: "slot must be noon or evening", field: "slot" });
    }
    const { status, json } = await botCallRawStatus("POST", `/admin/digests/run/${slot}`, {
      timeoutMs: DIGEST_TIMEOUT_MS,
      passthroughStatuses: [202, 409],
    });
    reply.code(status).send(json);
  }

  @Get("digests")
  async digestHistory(@Req() req: FastifyRequest, @Query("limit") limit?: string) {
    requireElevated(req);
    return botCall("GET", `/admin/digests${limitQs(limit)}`);
  }

  // ---- Digest PREVIEW (Controls tab): generates the digest text for one chat WITHOUT sending
  // it anywhere — a pure proxy to the bot's read-only preview route. Uses the same longer
  // DIGEST_TIMEOUT_MS as the (now-async) run trigger above: summarization is the slow part
  // either way, and this route DOES synchronously wait on it. ----
  @Get("digests/preview")
  async digestPreview(@Req() req: FastifyRequest, @Query("chatId") chatId?: string, @Query("limit") limit?: string) {
    requireElevated(req);
    if (!chatId) {
      throw new BadRequestException({ message: "chatId is required", field: "chatId" });
    }
    return botCall("GET", `/admin/digests/preview${qs({ chatId, limit })}`, { timeoutMs: DIGEST_TIMEOUT_MS });
  }

  // ---- Skills catalog (Controls tab, read-only) ----
  @Get("skills")
  async skills(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("GET", "/admin/skills");
  }

  // ---- Media-queue health (Controls tab, read-only) ----
  @Get("media/status")
  async mediaStatus(@Req() req: FastifyRequest) {
    requireElevated(req);
    return botCall("GET", "/admin/media/status");
  }

  // ---- Group ignore list (Groups tab): full-replace, same shape as PUT groups ----
  @Put("groups/ignored")
  async setIgnoredGroups(@Req() req: FastifyRequest, @Body() body: { ids?: unknown }) {
    requireElevated(req);
    if (!Array.isArray(body?.ids)) {
      throw new BadRequestException({ message: "ids must be an array", field: "ids" });
    }
    return botCall("PUT", "/admin/groups/ignored", { body: { ids: body.ids } });
  }

  // ---- Message search across all chats (Chats tab) ----
  @Get("search")
  async search(@Req() req: FastifyRequest, @Query("q") q?: string, @Query("limit") limit?: string) {
    requireElevated(req);
    return botCall("GET", `/admin/search${qs({ q, limit })}`);
  }
}

function limitQs(limit?: string): string {
  return limit ? `?limit=${encodeURIComponent(limit)}` : "";
}

/** Build a `?a=1&b=2` querystring from the given params, skipping any that are undefined or
 *  empty — same "omit if absent" convention as limitQs, generalized to more than one param. */
function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (e): e is [string, string] => typeof e[1] === "string" && e[1] !== "",
  );
  if (entries.length === 0) return "";
  return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}
