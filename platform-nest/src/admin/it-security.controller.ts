// DW-7h — IT security on the ERP side: who is connected, every sign-in, alerts, and the two things IT can do about it
// (sign a session out, block an address). Contract: docs/FRONTEND-BFF-CONTRACT.md §52.6 (reads) and §52.7 (writes);
// authorization: docs/PERMISSION-CONTRACT.md §42.
//
// ── AUTHORIZATION ─────────────────────────────────────────────────────────────────────────────────
// No new Cerbos kind and no new action: the reads are `it_account` `read` and the writes `it_account` `disable`, the same
// people who already run logins in IT accounts (it-accounts.controller.ts). Self-protection is in the ROUTES, not the
// policy: ending your own session, blocking your own address, a private address and an address three or more members share
// (unless confirmed) are refused here, because "who is the caller" is not something Cerbos knows.
//
// ── WHERE THE ROWS LIVE ───────────────────────────────────────────────────────────────────────────
// `security_access_seen` and `security_ip_blocks` are FORCE-RLS tables: they are read and written inside `withTenants`.
// A `withGlobal` read would see ZERO rows on them, silently (migration-backfill-rls-trap). `security_session_revocations`
// is global (a session belongs to the person, not to one company), so it is written with `withGlobal`; its `revoked_from_company_id` only
// records which company's IT ended it, for that company's Blocks page.
//
// ── TYPED REFUSALS ────────────────────────────────────────────────────────────────────────────────
// A refusal carries `message` (which http-error.filter.ts renames to `error`), a machine `reason`, and where the contract
// says so a `field` or `detail`. A thrower must set `message`, never `error`: the filter reads nothing called `error`.
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../db";
import { authorize, writeActivity } from "../core/http";
import { AuthGuard } from "../auth/guards";
import {
  deleteSession, getEventsConfig, keycloakAdminConfigured, listEvents,
  KeycloakAdminError, KeycloakForbiddenError, KeycloakNotConfiguredError,
} from "../core/keycloak-admin";
import { clientContextOf } from "../core/security/client-context";
import { parseUserAgent, type DeviceInfo } from "../core/security/user-agent";
import { classifyBlockableIp, IP_REFUSAL_MESSAGE, sameAddress } from "../core/security/ip-rules";
import { parseWindow, WINDOW_MS, type SecurityWindow } from "../core/security/security-window";
import { computeAlerts, type Alert } from "../core/security/security-alerts";
import {
  mapSignInEvents, missingEventTypes, type MappedSignIns, type SignInEvent, type SignInLookups, type SignInSummary,
} from "../core/security/sign-ins";

/** Machine codes of the typed refusals. Read by the UI, so add a code rather than reword one. */
export const IT_SECURITY_ERROR = {
  revokesYourself: "revokes_yourself",
  sessionNotFound: "session_not_found",
  blocksYourself: "blocks_yourself",
  sharedAddress: "shared_address",
  alreadyBlocked: "already_blocked",
  blockNotFound: "block_not_found",
  notActive: "not_active",
} as const;

/** How long a revocation row stays. Past the ERP session's 12 h absolute life (BFF §52.4), so a row that has outlived every
 *  token it could refuse stops costing the request hook anything. */
const REVOCATION_HOURS = 13;
const SHARED_ADDRESS_MEMBERS = 3;
const DEFAULT_BLOCK_HOURS = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Person {
  userId: string;
  displayName: string;
  email: string;
}

export interface Connection {
  who: Person;
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
  device: DeviceInfo;
  firstSeenAt: string;
  lastSeenAt: string;
  requestCount: number;
  revoked: boolean;
  ipBlocked: boolean;
}

export interface IpBlock {
  id: string;
  ip: string;
  reason: string;
  /** Not lifted and not yet expired. */
  active: boolean;
  createdAt: string;
  createdBy: { userId: string; displayName: string };
  expiresAt: string;
  liftedAt: string | null;
  /** Null while active, and for a block that simply ran out (marked lifted by the next create, or never). */
  liftedBy: { userId: string; displayName: string } | null;
  hitCount: number;
  lastHitAt: string | null;
}

export interface Revocation {
  id: string;
  who: Person;
  /** Null: every session of the person issued before `revokedAt` ("Block login"). */
  sessionId: string | null;
  reason: string | null;
  revokedAt: string;
  revokedBy: { userId: string; displayName: string } | null;
  expiresAt: string;
}

type SignInsState = "on" | "off" | "unavailable";

interface SignInsRead {
  state: SignInsState;
  reason?: string;
  mapped?: MappedSignIns;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/** The caller's own Keycloak session id (`sid`), when the token carried one. Read defensively: it is a field the request
 *  hook's principal gains in this same ticket, and a service-token caller has none. */
function callerSessionId(req: FastifyRequest): string | null {
  const s = (req.principal as unknown as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof s === "string" && s !== "" ? s : null;
}

function actorId(req: FastifyRequest): string {
  const id = req.principal?.userId;
  if (!id) throw new ForbiddenException("not authorized: no signed-in person");
  return id;
}

/** Why the sign-ins could not be read, in words IT can act on. Never the response body of Keycloak. */
export function unavailableReason(err: unknown): string {
  if (err instanceof KeycloakNotConfiguredError) {
    return "Keycloak admin access is not configured on this server (KEYCLOAK_ADMIN_* settings).";
  }
  if (err instanceof KeycloakForbiddenError) {
    return (
      `The Keycloak service account lacks the realm-management role ${err.missingRole}. ` +
      `See infra/runbooks/keycloak-security-events.md.`
    );
  }
  if (err instanceof KeycloakAdminError) return `Keycloak could not be read (HTTP ${err.httpStatus}).`;
  return "Keycloak could not be read.";
}

@Controller("api")
@UseGuards(AuthGuard)
export class ItSecurityController {
  // ── reads (it_account read) ─────────────────────────────────────────────────────────────────────

  @Get(":tenantId/it/security/connections")
  async connections(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("window") rawWindow?: unknown,
  ): Promise<{ asOf: string; window: SecurityWindow; connections: Connection[] }> {
    await this.authorizeRead(req, tenantId);
    const window = this.window(rawWindow);
    const { rows } = await withTenants([tenantId], (c) =>
      c.query<{
        user_id: string; name: string; email: string; session_id: string; ip: string | null; user_agent: string | null;
        first_seen_at: Date; last_seen_at: Date; request_count: string; revoked: boolean; ip_blocked: boolean;
      }>(
        // `revoked` mirrors the request hook (§52.4): a signed-out session, or a login cut after the last time this
        // connection was seen (a person who signed in again afterwards has a newer last_seen_at and is not cut).
        // `host(ip)` and not `ip::text`: the text form of an inet carries a /32 or /128.
        `SELECT s.user_id, u.name, u.email, s.session_id, host(s.ip) AS ip, s.user_agent, s.first_seen_at, s.last_seen_at,
                s.request_count::text AS request_count,
                EXISTS (SELECT 1 FROM security_session_revocations r
                         WHERE r.user_id = s.user_id AND r.expires_at > now()
                           AND ((s.session_id <> '' AND r.session_id = s.session_id)
                                OR (r.session_id IS NULL AND r.revoked_at >= s.last_seen_at))) AS revoked,
                (s.ip IS NOT NULL AND EXISTS (SELECT 1 FROM security_ip_blocks b
                                               WHERE b.tenant_id = s.tenant_id AND b.ip = s.ip
                                                 AND b.lifted_at IS NULL AND b.expires_at > now())) AS ip_blocked
           FROM security_access_seen s
           JOIN users u ON u.id = s.user_id
          WHERE s.tenant_id = $1 AND s.last_seen_at >= now() - make_interval(secs => $2::double precision)
          ORDER BY s.last_seen_at DESC
          LIMIT 500`,
        [tenantId, WINDOW_MS[window] / 1000],
      ),
    );
    return {
      asOf: new Date().toISOString(),
      window,
      connections: rows.map((r) => ({
        who: { userId: r.user_id, displayName: r.name, email: r.email },
        sessionId: r.session_id,
        ip: r.ip,
        userAgent: r.user_agent,
        device: parseUserAgent(r.user_agent),
        firstSeenAt: r.first_seen_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        requestCount: Number(r.request_count),
        revoked: r.revoked,
        ipBlocked: r.ip_blocked,
      })),
    };
  }

  @Get(":tenantId/it/security/sign-ins")
  async signIns(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("window") rawWindow?: unknown,
  ): Promise<{
    asOf: string; window: SecurityWindow; state: SignInsState; reason?: string;
    events: SignInEvent[]; summary: SignInSummary; unknownAccounts: { failed: number };
  }> {
    await this.authorizeRead(req, tenantId);
    const window = this.window(rawWindow, ["24h", "7d"]);
    const read = await this.readSignIns(tenantId, window);
    const asOf = new Date().toISOString();
    if (read.state !== "on" || !read.mapped) {
      // Never an empty list for "off" or "unavailable": an empty list reads as "nobody failed to sign in".
      return {
        asOf, window, state: read.state, ...(read.reason ? { reason: read.reason } : {}),
        events: [], summary: { signIns: 0, failed: 0, failedByAccount: [], failedByIp: [] }, unknownAccounts: { failed: 0 },
      };
    }
    return {
      asOf, window, state: "on", events: read.mapped.events, summary: read.mapped.summary,
      unknownAccounts: read.mapped.unknownAccounts,
    };
  }

  @Get(":tenantId/it/security/alerts")
  async alerts(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("window") rawWindow?: unknown,
  ): Promise<{ asOf: string; window: SecurityWindow; signIns: SignInsState; reason?: string; alerts: Alert[] }> {
    await this.authorizeRead(req, tenantId);
    const window = this.window(rawWindow);
    const now = new Date();
    const read = await this.readSignIns(tenantId, window);

    const { seen, blocks } = await withTenants([tenantId], async (c) => ({
      // The new-device rule needs each member's history from BEFORE the window, so this reads every row of the members who
      // were active inside it, not just the window.
      seen: await c.query<{ user_id: string; email: string; ip: string | null; user_agent: string | null; first_seen_at: Date }>(
        `SELECT s.user_id, u.email, host(s.ip) AS ip, s.user_agent, s.first_seen_at
           FROM security_access_seen s
           JOIN users u ON u.id = s.user_id
          WHERE s.tenant_id = $1
            AND s.user_id IN (SELECT user_id FROM security_access_seen
                               WHERE tenant_id = $1 AND last_seen_at >= now() - make_interval(secs => $2::double precision))
          LIMIT 20000`,
        [tenantId, WINDOW_MS[window] / 1000],
      ),
      blocks: await c.query<{ ip: string; hit_count: string; last_hit_at: Date | null }>(
        `SELECT host(ip) AS ip, hit_count::text AS hit_count, last_hit_at
           FROM security_ip_blocks WHERE tenant_id = $1 AND lifted_at IS NULL AND expires_at > now()`,
        [tenantId],
      ),
    }));

    return {
      asOf: now.toISOString(),
      window,
      signIns: read.state,
      ...(read.reason ? { reason: read.reason } : {}),
      alerts: computeAlerts({
        now,
        window,
        signIns: read.state,
        failed: read.mapped?.failed ?? [],
        seen: seen.rows.map((r) => ({
          userId: r.user_id, email: r.email, ip: r.ip, userAgent: r.user_agent, firstSeenAt: r.first_seen_at,
        })),
        blocks: blocks.rows.map((b) => ({ ip: b.ip, hitCount: Number(b.hit_count), lastHitAt: b.last_hit_at })),
      }),
    };
  }

  @Get(":tenantId/it/security/blocks")
  async blocks(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
  ): Promise<{ ipBlocks: IpBlock[]; revokedSessions: Revocation[] }> {
    await this.authorizeRead(req, tenantId);
    return withTenants([tenantId], async (c) => {
      // Active first, then what ended in the last 30 days.
      const blocks = await c.query<BlockRow>(
        `${BLOCK_SELECT}
          WHERE b.tenant_id = $1 AND (${ACTIVE_SQL} OR COALESCE(b.lifted_at, b.expires_at) > now() - interval '30 days')
          ORDER BY (${ACTIVE_SQL}) DESC, b.created_at DESC
          LIMIT 200`,
        [tenantId],
      );
      const revoked = await c.query<{
        id: string; user_id: string; name: string; email: string; session_id: string | null; reason: string | null;
        revoked_at: Date; expires_at: Date; revoked_by: string | null; revoked_by_name: string | null;
      }>(
        `SELECT r.id, r.user_id, u.name, u.email, r.session_id, r.reason, r.revoked_at, r.expires_at,
                r.revoked_by, rb.name AS revoked_by_name
           FROM security_session_revocations r
           JOIN users u ON u.id = r.user_id
           LEFT JOIN users rb ON rb.id = r.revoked_by
          WHERE r.revoked_from_company_id = $1 AND r.revoked_at >= now() - interval '7 days'
          ORDER BY r.revoked_at DESC
          LIMIT 200`,
        [tenantId],
      );
      return {
        ipBlocks: blocks.rows.map(toIpBlock),
        revokedSessions: revoked.rows.map((r) => ({
          id: r.id,
          who: { userId: r.user_id, displayName: r.name, email: r.email },
          sessionId: r.session_id,
          reason: r.reason,
          revokedAt: r.revoked_at.toISOString(),
          revokedBy: r.revoked_by ? { userId: r.revoked_by, displayName: r.revoked_by_name ?? "" } : null,
          expiresAt: r.expires_at.toISOString(),
        })),
      };
    });
  }

  // ── writes (it_account disable) ─────────────────────────────────────────────────────────────────

  /** Sign one session out. The revocation ROW is what cuts the ERP (within 10 seconds, everywhere, §52.4); ending the
   *  Keycloak session as well stops it being refreshed. The answer is `revoked: true` even when Keycloak failed, and says
   *  what Keycloak did, because the row alone has already done the part that matters. */
  @Post(":tenantId/it/security/sessions/:sessionId/revoke")
  @HttpCode(200)
  async revoke(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: { userId?: unknown; reason?: unknown },
  ): Promise<{ revoked: true; keycloak: "ended" | "not_found" | "failed" }> {
    await this.authorizeWrite(req, tenantId);
    const actor = actorId(req);
    const userId = typeof body?.userId === "string" && UUID.test(body.userId) ? body.userId : null;
    if (!userId) throw new BadRequestException({ message: "userId must be the id of the person the session belongs to", field: "userId" });
    const reason = this.optionalReason(body?.reason);
    if (sessionId.length > 200) throw new BadRequestException({ message: "sessionId is too long", field: "sessionId" });

    if (callerSessionId(req) === sessionId) {
      throw new ConflictException({
        message: `${IT_SECURITY_ERROR.revokesYourself}: that is the session you are signed in with; sign out instead`,
        reason: IT_SECURITY_ERROR.revokesYourself,
      });
    }

    // Only a session this company has actually seen for that person: IT cannot sign out a stranger's session by guessing an id.
    const seen = await withTenants([tenantId], (c) =>
      c.query(`SELECT 1 FROM security_access_seen WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 LIMIT 1`, [tenantId, userId, sessionId]),
    );
    if (!seen.rows[0]) {
      throw new NotFoundException({
        message: `${IT_SECURITY_ERROR.sessionNotFound}: that session of that person has not been seen in this company`,
        reason: IT_SECURITY_ERROR.sessionNotFound,
      });
    }

    // A second click while the first revocation is still live adds nothing to the Blocks page.
    await withGlobal((c) =>
      c.query(
        `INSERT INTO security_session_revocations (user_id, session_id, revoked_by, revoked_from_company_id, reason, expires_at)
         SELECT $1::uuid, $2::text, $3::uuid, $4::uuid, $5::text, now() + make_interval(hours => $6::int)
          WHERE NOT EXISTS (SELECT 1 FROM security_session_revocations
                             WHERE user_id = $1::uuid AND session_id = $2::text AND expires_at > now())`,
        [userId, sessionId, actor, tenantId, reason, REVOCATION_HOURS],
      ),
    );

    let keycloak: "ended" | "not_found" | "failed";
    try {
      keycloak = await deleteSession(sessionId);
    } catch (err) {
      // Logged by kind only, never the response body.
      // eslint-disable-next-line no-console
      console.warn(`[it-security] Keycloak session end failed: ${err instanceof Error ? err.name : "error"}`);
      keycloak = "failed";
    }

    await writeActivity(tenantId, actor, "it.security.session_revoke", "it_account", userId, { sessionId, keycloak, reason });
    return { revoked: true, keycloak };
  }

  @Post(":tenantId/it/security/blocks")
  @HttpCode(201)
  async blockAddress(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { ip?: unknown; reason?: unknown; hours?: unknown; confirmShared?: unknown },
  ): Promise<IpBlock> {
    await this.authorizeWrite(req, tenantId);
    const actor = actorId(req);

    const checked = classifyBlockableIp(body?.ip);
    if (!checked.ok) {
      throw new BadRequestException({ message: IP_REFUSAL_MESSAGE[checked.reason], field: "ip", reason: checked.reason });
    }
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 500) {
      throw new BadRequestException({ message: "reason is required: 3 to 500 characters", field: "reason" });
    }
    const hours = body?.hours === undefined || body.hours === null ? DEFAULT_BLOCK_HOURS : body.hours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 720) {
      throw new BadRequestException({ message: "hours must be a whole number from 1 to 720", field: "hours" });
    }

    if (sameAddress(clientContextOf(req).ip, checked.ip)) {
      throw new ConflictException({
        message: `${IT_SECURITY_ERROR.blocksYourself}: that is the address you are connected from`,
        reason: IT_SECURITY_ERROR.blocksYourself,
      });
    }

    let created: IpBlock;
    try {
      created = await withTenants([tenantId], async (c) => {
        // An expired block that was never lifted still holds the one-active-per-address slot, so free those first.
        await c.query(
          `UPDATE security_ip_blocks SET lifted_at = expires_at WHERE tenant_id = $1 AND lifted_at IS NULL AND expires_at <= now()`,
          [tenantId],
        );
        const dup = await c.query(`SELECT 1 FROM security_ip_blocks WHERE tenant_id = $1 AND ip = $2::inet AND lifted_at IS NULL`, [tenantId, checked.ip]);
        if (dup.rows[0]) throw this.alreadyBlocked();
        // An address that three or more members connected from lately is probably an office or a home: IT confirms first.
        const shared = await c.query<{ n: number }>(
          `SELECT count(DISTINCT user_id)::int AS n FROM security_access_seen
            WHERE tenant_id = $1 AND ip = $2::inet AND last_seen_at >= now() - interval '24 hours'`,
          [tenantId, checked.ip],
        );
        const users = shared.rows[0]?.n ?? 0;
        if (users >= SHARED_ADDRESS_MEMBERS && body?.confirmShared !== true) {
          throw new ConflictException({
            message: `${IT_SECURITY_ERROR.sharedAddress}: ${users} members connected from this address in the last 24 hours`,
            reason: IT_SECURITY_ERROR.sharedAddress,
            detail: { users },
          });
        }
        const ins = await c.query<{ id: string }>(
          `INSERT INTO security_ip_blocks (tenant_id, ip, reason, created_by, expires_at)
           VALUES ($1, $2::inet, $3, $4, now() + make_interval(hours => $5::int)) RETURNING id`,
          [tenantId, checked.ip, reason, actor, hours],
        );
        return this.loadBlock(c, tenantId, ins.rows[0].id);
      });
    } catch (err) {
      // Two creates racing for the same address: the unique index decides, and the loser reads as "already blocked".
      if ((err as { code?: string })?.code === "23505") throw this.alreadyBlocked();
      throw err;
    }

    await writeActivity(tenantId, actor, "it.security.ip_block", "it_ip_block", created.id, {
      ip: created.ip, hours, reason, confirmShared: body?.confirmShared === true,
    });
    return created;
  }

  @Post(":tenantId/it/security/blocks/:blockId/lift")
  @HttpCode(200)
  async liftBlock(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("blockId") blockId: string,
  ): Promise<IpBlock> {
    await this.authorizeWrite(req, tenantId);
    const actor = actorId(req);
    // After the authorization decision, so a stranger learns nothing; and a non-id is a 404, never a 500 at the uuid cast.
    if (!UUID.test(blockId)) throw this.blockNotFound();

    const lifted = await withTenants([tenantId], async (c) => {
      const cur = await c.query<{ active: boolean }>(
        `SELECT (lifted_at IS NULL AND expires_at > now()) AS active FROM security_ip_blocks WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [blockId, tenantId],
      );
      if (!cur.rows[0]) throw this.blockNotFound();
      if (!cur.rows[0].active) {
        throw new ConflictException({
          message: `${IT_SECURITY_ERROR.notActive}: this block was already lifted or has run out`,
          reason: IT_SECURITY_ERROR.notActive,
        });
      }
      await c.query(`UPDATE security_ip_blocks SET lifted_at = now(), lifted_by = $3 WHERE id = $1 AND tenant_id = $2`, [blockId, tenantId, actor]);
      return this.loadBlock(c, tenantId, blockId);
    });

    await writeActivity(tenantId, actor, "it.security.ip_unblock", "it_ip_block", blockId, { ip: lifted.ip });
    return lifted;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────

  private async authorizeRead(req: FastifyRequest, tenantId: string): Promise<void> {
    await authorize(req.principal, { kind: "it_account", id: "security", tenantId }, "read");
  }

  private async authorizeWrite(req: FastifyRequest, tenantId: string): Promise<void> {
    await authorize(req.principal, { kind: "it_account", id: "security", tenantId }, "disable");
  }

  private window(raw: unknown, allowed: readonly SecurityWindow[] = ["15m", "24h", "7d"]): SecurityWindow {
    const w = parseWindow(raw, allowed);
    if (!w.ok) {
      throw new BadRequestException({ message: `window must be one of ${w.allowed.join(", ")}`, field: "window" });
    }
    return w.window;
  }

  private optionalReason(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string" || raw.trim().length > 500) {
      throw new BadRequestException({ message: "reason must be text of at most 500 characters", field: "reason" });
    }
    return raw.trim();
  }

  private alreadyBlocked(): ConflictException {
    return new ConflictException({
      message: `${IT_SECURITY_ERROR.alreadyBlocked}: this address already has an active block`,
      reason: IT_SECURITY_ERROR.alreadyBlocked,
    });
  }

  private blockNotFound(): NotFoundException {
    return new NotFoundException({
      message: `${IT_SECURITY_ERROR.blockNotFound}: no such block in this company`,
      reason: IT_SECURITY_ERROR.blockNotFound,
    });
  }

  private async loadBlock(c: PoolClient, tenantId: string, id: string): Promise<IpBlock> {
    const { rows } = await c.query<BlockRow>(`${BLOCK_SELECT} WHERE b.tenant_id = $1 AND b.id = $2`, [tenantId, id]);
    return toIpBlock(rows[0]);
  }

  /** Read Keycloak's events and map them to this company's members. `off` and `unavailable` are states of their own and
   *  never an empty result (§52.6). */
  private async readSignIns(tenantId: string, window: SecurityWindow): Promise<SignInsRead> {
    if (!keycloakAdminConfigured()) return { state: "unavailable", reason: unavailableReason(new KeycloakNotConfiguredError([])) };
    const sinceMs = Date.now() - WINDOW_MS[window];
    let events;
    try {
      const cfg = await getEventsConfig();
      if (!cfg.eventsEnabled) return { state: "off" };
      const missing = missingEventTypes(cfg.enabledEventTypes);
      if (missing.length) {
        return { state: "unavailable", reason: `The realm does not record these event types: ${missing.join(", ")}.` };
      }
      events = await listEvents({ types: ["LOGIN", "LOGIN_ERROR", "LOGOUT"], dateFrom: new Date(sinceMs), max: 5000 });
    } catch (err) {
      return { state: "unavailable", reason: unavailableReason(err) };
    }
    const recent = events.filter((e) => e.time >= sinceMs);
    return { state: "on", mapped: mapSignInEvents(recent, await this.lookups(tenantId, recent), { sinceMs }) };
  }

  /** Resolve the people the events name, the way `auth/oidc.ts` provisionUser() finds a person: by the Keycloak id (the
   *  `idp_subject` set at the first login, or an `identity_links` row set when IT provisioned the account), else by email. */
  private async lookups(tenantId: string, events: Array<{ userId: string | null; username: string | null }>): Promise<SignInLookups> {
    const kcIds = [...new Set(events.map((e) => e.userId).filter((v): v is string => !!v))];
    const emails = [...new Set(events.map((e) => e.username?.toLowerCase()).filter((v): v is string => !!v))];
    const byKeycloakId = new Map<string, { id: string; email: string }>();
    const byEmail = new Map<string, { id: string; email: string }>();
    if (kcIds.length || emails.length) {
      await withGlobal(async (c) => {
        const users = await c.query<{ id: string; email: string; idp_subject: string | null }>(
          `SELECT id, email, idp_subject FROM users
            WHERE deleted_at IS NULL AND (idp_subject = ANY($1::text[]) OR lower(email) = ANY($2::text[]))`,
          [kcIds, emails],
        );
        for (const u of users.rows) {
          byEmail.set(u.email.toLowerCase(), { id: u.id, email: u.email });
          if (u.idp_subject) byKeycloakId.set(u.idp_subject, { id: u.id, email: u.email });
        }
        const links = await c.query<{ external_id: string; id: string; email: string }>(
          `SELECT l.external_id, u.id, u.email
             FROM identity_links l JOIN users u ON u.id = l.user_id
            WHERE l.provider = 'platform' AND l.external_id = ANY($1::text[]) AND u.deleted_at IS NULL`,
          [kcIds],
        );
        for (const l of links.rows) if (!byKeycloakId.has(l.external_id)) byKeycloakId.set(l.external_id, { id: l.id, email: l.email });
      });
    }
    const ids = [...new Set([...byKeycloakId.values(), ...byEmail.values()].map((u) => u.id))];
    const memberIds = new Set<string>();
    if (ids.length) {
      const members = await withTenants([tenantId], (c) =>
        c.query<{ user_id: string }>(
          `SELECT user_id FROM company_memberships
            WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL AND user_id = ANY($2::uuid[])`,
          [tenantId, ids],
        ),
      );
      for (const m of members.rows) memberIds.add(m.user_id);
    }
    return { byKeycloakId, byEmail, memberIds };
  }
}

// ── block rows ───────────────────────────────────────────────────────────────────────────────────

/** Not lifted and not run out: the same rule as the request hook and the unique index (BFF §52.5). */
const ACTIVE_SQL = `b.lifted_at IS NULL AND b.expires_at > now()`;

const BLOCK_SELECT = `SELECT b.id, host(b.ip) AS ip, b.reason, (${ACTIVE_SQL}) AS active, b.created_at, b.created_by,
       cu.name AS created_by_name, b.expires_at, b.lifted_at, b.lifted_by, lu.name AS lifted_by_name,
       b.hit_count::text AS hit_count, b.last_hit_at
  FROM security_ip_blocks b
  JOIN users cu ON cu.id = b.created_by
  LEFT JOIN users lu ON lu.id = b.lifted_by`;

interface BlockRow {
  id: string; ip: string; reason: string; active: boolean; created_at: Date; created_by: string; created_by_name: string;
  expires_at: Date; lifted_at: Date | null; lifted_by: string | null; lifted_by_name: string | null;
  hit_count: string; last_hit_at: Date | null;
}

function toIpBlock(r: BlockRow): IpBlock {
  return {
    id: r.id,
    ip: r.ip,
    reason: r.reason,
    active: r.active,
    createdAt: r.created_at.toISOString(),
    createdBy: { userId: r.created_by, displayName: r.created_by_name },
    expiresAt: r.expires_at.toISOString(),
    liftedAt: iso(r.lifted_at),
    liftedBy: r.lifted_by ? { userId: r.lifted_by, displayName: r.lifted_by_name ?? "" } : null,
    hitCount: Number(r.hit_count),
    lastHitAt: iso(r.last_hit_at),
  };
}
