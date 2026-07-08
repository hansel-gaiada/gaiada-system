// 5c.8: Teams CRUD + team-scope activation. Verifies create/detail/update/member-management
// gating and — the point of the tier — that promoting a plain company MEMBER to team LEAD
// mints the team_lead grant so they can manage their own team, and that removing them
// revokes it. This exercises the previously-inert `team_lead` derived role end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("teams CRUD + team scope", () => {
  let app: NestFastifyApplication;
  let co: string, manager: string, lead: string, plain: string;
  let teamId: string;
  const svc = { authorization: "Bearer svc-token" };
  const as = (id: string) => ({ ...svc, "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Creative House");
    manager = await createUser("mgr@tm.test");
    lead = await createUser("lead@tm.test");
    plain = await createUser("plain@tm.test");
    for (const id of [manager, lead, plain]) await addMembership(co, id);
    await grantRole(manager, await createRole("manager"), "company", co);
    await grantRole(lead, await createRole("member"), "company", co);
    await grantRole(plain, await createRole("member"), "company", co);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("manager creates a team; a plain member cannot", async () => {
    const ok = await app.inject({ method: "POST", url: `/api/${co}/teams`, headers: as(manager), payload: { name: "Design Pod" } });
    expect(ok.statusCode).toBe(201);
    teamId = ok.json().id;
    const denied = await app.inject({ method: "POST", url: `/api/${co}/teams`, headers: as(plain), payload: { name: "Nope" } });
    expect(denied.statusCode).toBe(403);
  });

  it("a plain member cannot manage the team", async () => {
    const r = await app.inject({ method: "PATCH", url: `/api/${co}/teams/${teamId}`, headers: as(plain), payload: { name: "Hijack" } });
    expect(r.statusCode).toBe(403);
  });

  it("promoting a member to lead activates team-scope authority", async () => {
    const add = await app.inject({
      method: "POST", url: `/api/${co}/teams/${teamId}/members`, headers: as(manager), payload: { userId: lead, role: "lead" },
    });
    expect(add.statusCode).toBe(201);
    // The freshly-minted team_lead grant lets this (company-level 'member') user manage the team.
    const upd = await app.inject({ method: "PATCH", url: `/api/${co}/teams/${teamId}`, headers: as(lead), payload: { name: "Design Pod A" } });
    expect(upd.statusCode).toBe(200);
    // A lead may add other members to their team.
    const addMember = await app.inject({
      method: "POST", url: `/api/${co}/teams/${teamId}/members`, headers: as(lead), payload: { userId: plain, role: "member" },
    });
    expect(addMember.statusCode).toBe(201);
  });

  it("team detail lists the members", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/teams/${teamId}`, headers: as(manager) });
    const body = r.json() as { name: string; members: Array<{ user_id: string; role: string }> };
    expect(body.name).toBe("Design Pod A");
    expect(body.members.find((m) => m.user_id === lead)?.role).toBe("lead");
    expect(body.members.some((m) => m.user_id === plain)).toBe(true);
  });

  it("removing the lead revokes their team authority", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/${co}/teams/${teamId}/members/${lead}`, headers: as(manager) });
    expect(del.statusCode).toBe(200);
    // Grant revoked → the ex-lead can no longer manage the team.
    const upd = await app.inject({ method: "PATCH", url: `/api/${co}/teams/${teamId}`, headers: as(lead), payload: { name: "Back" } });
    expect(upd.statusCode).toBe(403);
  });
});
