// Teams CRUD + team-scope activation (Nest port of core/teams.ts). Promoting a member to
// LEAD mints a user_roles(team_lead, scope=team:<id>) grant so the team_lead derived role
// binds; removing them revokes it.
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants, withGlobal } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";

async function teamLeadRoleId(): Promise<string> {
  return withGlobal(async (c) => {
    const found = await c.query<{ id: string }>(`SELECT id FROM roles WHERE name = 'team_lead' AND company_id IS NULL LIMIT 1`);
    if (found.rows[0]) return found.rows[0].id;
    const id = newId();
    await c.query(`INSERT INTO roles (id, company_id, name, description) VALUES ($1, NULL, 'team_lead', 'Team lead (scope: team)')`, [id]);
    return id;
  });
}

@Controller("api")
@UseGuards(AuthGuard)
export class TeamsController {
  @Get(":tenantId/teams")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "team", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, name, parent_team_id FROM teams WHERE deleted_at IS NULL ORDER BY name`),
    );
    return rows.rows;
  }

  @Post(":tenantId/teams")
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { name?: string; parentTeamId?: string }) {
    const { name, parentTeamId } = body ?? {};
    if (!name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "team", tenantId }, "create");
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(`INSERT INTO teams (id, tenant_id, name, parent_team_id, origin_site) VALUES ($1, $2, $3, $4, $5)`, [
        id, tenantId, name, parentTeamId ?? null, config.originSite,
      ]),
    );
    await writeActivity(tenantId, req.principal.userId, "created", "team", id, { name });
    return { id };
  }

  @Get(":tenantId/teams/:teamId")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("teamId") teamId: string) {
    await authorize(req.principal, { kind: "team", id: teamId, teamId, tenantId }, "read");
    const team = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, name, parent_team_id FROM teams WHERE id = $1 AND deleted_at IS NULL`, [teamId]),
    );
    if (!team.rows[0]) throw new NotFoundException("team not found");
    const members = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT tm.user_id, u.name, u.email, tm.role FROM team_memberships tm JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1 AND tm.deleted_at IS NULL AND u.deleted_at IS NULL ORDER BY u.name`,
        [teamId],
      ),
    );
    return { ...team.rows[0], members: members.rows };
  }

  @Patch(":tenantId/teams/:teamId")
  async update(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("teamId") teamId: string, @Body() body: { name?: string; parentTeamId?: string | null }) {
    await authorize(req.principal, { kind: "team", id: teamId, teamId, tenantId }, "update");
    const { name, parentTeamId } = body ?? {};
    const res = await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE teams SET name = COALESCE($2, name), parent_team_id = COALESCE($3, parent_team_id), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [teamId, name ?? null, parentTeamId ?? null],
      ),
    );
    if (res.rowCount === 0) throw new NotFoundException("team not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "team", teamId);
    return { id: teamId };
  }

  @Post(":tenantId/teams/:teamId/members")
  @HttpCode(201)
  async addMember(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("teamId") teamId: string, @Body() body: { userId?: string; role?: "member" | "lead" }) {
    const { userId, role = "member" } = body ?? {};
    if (!userId) throw new BadRequestException("userId required");
    if (role !== "member" && role !== "lead") throw new BadRequestException("role must be member|lead");
    await authorize(req.principal, { kind: "team", id: teamId, teamId, tenantId }, "update");
    const isMember = await withTenants([tenantId], (c) =>
      c.query(`SELECT 1 FROM company_memberships WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active'`, [userId]),
    );
    if (!isMember.rows[0]) throw new BadRequestException("user is not a member of this company");
    const team = await withTenants([tenantId], (c) => c.query(`SELECT 1 FROM teams WHERE id = $1 AND deleted_at IS NULL`, [teamId]));
    if (!team.rows[0]) throw new NotFoundException("team not found");
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO team_memberships (id, tenant_id, user_id, team_id, role, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, user_id, team_id) DO UPDATE SET role = $5, deleted_at = NULL, updated_at = now()`,
        [newId(), tenantId, userId, teamId, role, config.originSite],
      ),
    );
    if (role === "lead") {
      const leadRole = await teamLeadRoleId();
      await withGlobal((c) =>
        c.query(
          `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, 'team', $4)
           ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
          [newId(), userId, leadRole, teamId],
        ),
      );
    }
    await writeActivity(tenantId, req.principal.userId, "added", "team", teamId, { userId, role });
    return { teamId, userId, role };
  }

  @Delete(":tenantId/teams/:teamId/members/:userId")
  async removeMember(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("teamId") teamId: string, @Param("userId") userId: string) {
    await authorize(req.principal, { kind: "team", id: teamId, teamId, tenantId }, "update");
    const res = await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE team_memberships SET deleted_at = now(), updated_at = now()
         WHERE team_id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING role`,
        [teamId, userId],
      ),
    );
    if (res.rowCount === 0) throw new NotFoundException("membership not found");
    const leadRole = await teamLeadRoleId();
    await withGlobal((c) =>
      c.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2 AND scope_type = 'team' AND scope_id = $3`, [userId, leadRole, teamId]),
    );
    await writeActivity(tenantId, req.principal.userId, "removed", "team", teamId, { userId });
    return { teamId, userId, removed: true };
  }
}
