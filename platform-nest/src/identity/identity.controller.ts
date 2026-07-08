// Root-level identity/admin/dev routes (Nest port of server.ts). Paths match the Fastify
// server exactly (no /api prefix): /principal/resolve, /identity/enroll/*, /admin/*, /dev/*.
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { newId, withGlobal } from "../db";
import { assemblePrincipal, ANONYMOUS } from "../rbac/principal";
import { AuthGuard, ServiceGuard } from "../auth/guards";

@Controller()
export class IdentityController {
  // D4: surfaces exchange an external envelope for a platform-minted principal.
  @Post("principal/resolve")
  @HttpCode(200)
  @UseGuards(ServiceGuard)
  async resolve(@Body() body: { provider?: string; externalId?: string }) {
    const { provider, externalId } = body ?? {};
    if (!provider || !externalId) return { ...ANONYMOUS };
    const link = await withGlobal((c) =>
      c.query<{ user_id: string; verified_at: string | null }>(
        `SELECT user_id, verified_at FROM identity_links WHERE provider = $1 AND external_id = $2`,
        [provider, externalId],
      ),
    );
    const row = link.rows[0];
    if (!row) return { ...ANONYMOUS };
    if (!row.verified_at) return { ...ANONYMOUS, userId: row.user_id };
    return (await assemblePrincipal(row.user_id, "linked")) ?? { ...ANONYMOUS };
  }

  // Dual-proof enrollment (D4.4): a high-assurance user requests a one-time code.
  @Post("identity/enroll/start")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async enrollStart(@Req() req: FastifyRequest) {
    if (!req.principal.userId) throw new UnauthorizedException("no user");
    if (req.principal.assurance !== "high") {
      throw new ForbiddenException("step up (MFA) required to link a chat identity");
    }
    const code = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await withGlobal((c) =>
      c.query(`INSERT INTO enrollment_codes (id, user_id, code, expires_at) VALUES ($1, $2, $3, $4)`, [
        newId(), req.principal.userId, code, expiresAt,
      ]),
    );
    return { code, expiresAt, instructions: "Send this code to the bot from the WhatsApp/Telegram identity you want to link, within 10 minutes." };
  }

  // The bot (service auth) confirms the code + observed external identity → set verified_at.
  @Post("identity/enroll/confirm")
  @HttpCode(200)
  @UseGuards(ServiceGuard)
  async enrollConfirm(@Body() body: { code?: string; provider?: string; externalId?: string }) {
    const { code, provider, externalId } = body ?? {};
    if (!code || !provider || !externalId) throw new BadRequestException("code, provider, externalId required");
    const linked = await withGlobal(async (c) => {
      const rows = await c.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM enrollment_codes WHERE code = $1 AND consumed_at IS NULL AND expires_at > now()`,
        [code.toUpperCase()],
      );
      const enrollment = rows.rows[0];
      if (!enrollment) return null;
      await c.query(`UPDATE enrollment_codes SET consumed_at = now() WHERE id = $1`, [enrollment.id]);
      await c.query(
        `INSERT INTO identity_links (id, user_id, provider, external_id, verified_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (provider, external_id) DO UPDATE SET user_id = $2, verified_at = now()`,
        [newId(), enrollment.user_id, provider, externalId],
      );
      return enrollment.user_id;
    });
    if (!linked) throw new BadRequestException("invalid, expired, or already-used code");
    return { linked: true, userId: linked };
  }

  // D11: authoritative revocation — platform_admin bumps the user's session_version.
  @Post("admin/users/:userId/revoke")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async revoke(@Req() req: FastifyRequest, @Param("userId") userId: string) {
    const isAdmin = req.principal.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
    if (!isAdmin) throw new ForbiddenException("platform_admin required");
    await withGlobal((c) =>
      c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
    );
    return { revoked: true };
  }

  // Dev-auth v1 (replaced by IdP): exchange an email for a userId. Service-token-gated.
  @Get("dev/user-by-email")
  @UseGuards(ServiceGuard)
  async userByEmail(@Query("email") email?: string) {
    if (!email) throw new BadRequestException("email required");
    const rows = await withGlobal((c) =>
      c.query<{ id: string; name: string }>(
        `SELECT id, name FROM users WHERE email = $1 AND status = 'active' AND deleted_at IS NULL`,
        [email],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("unknown user");
    return rows.rows[0];
  }
}
