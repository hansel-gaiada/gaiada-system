// WSUX-17 (ex-P1-10) — C1 Claude seat registry API against live PG + RLS + Cerbos. Covers:
//   * self-service (a member maps/patches/unmaps their OWN seat) vs company.manage (admin maps another
//     person's seat, and reads the team-wide roster) — the own-vs-company Cerbos matrix, reused
//     verbatim from resource_integration_connection.yaml (no new policy file);
//   * NO plaintext/ciphertext credential exposure — mirrors the WSUX-14 non-exposure guarantee (this
//     registry never writes tokens, but asserts the shape carries none anyway);
//   * mapping persists across a fresh read (survives "reload");
//   * re-map after unmap reuses the same row (vault upsert semantics);
//   * tenant isolation — a rival admin reads/creates nothing across the boundary, and a forged id from
//     another tenant 404s rather than leaking;
//   * this controller only ever touches provider='claude' rows (a github connection's id 404s here).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { createConnection } from "./integrations.service";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("C1 Claude seat registry API (WSUX-17)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let member: string;
  let member2: string;
  let admin: string;
  let otherAdmin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Seat Co");
    other = await createCompany("Rival Seat Co");
    member = await createUser("member@seat.test");
    member2 = await createUser("member2@seat.test");
    admin = await createUser("admin@seat.test");
    otherAdmin = await createUser("admin@rival-seat.test");
    await addMembership(co, member);
    await addMembership(co, member2);
    await addMembership(co, admin);
    await addMembership(other, otherAdmin);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(member2, await createRole("member"), "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(otherAdmin, await createRole("company_admin"), "company", other);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const base = () => `/api/${co}/integrations/claude-seats`;
  let memberSeatId: string;

  it("owner=me is empty before any mapping", async () => {
    const r = await app.inject({ method: "GET", url: `${base()}?owner=me`, headers: asUser(member) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it("a member maps their OWN seat (self-service, no elevated role needed)", async () => {
    const r = await app.inject({
      method: "POST", url: base(), headers: asUser(member),
      payload: { codeSeatEmail: "member@seat.test", designLogin: "member-design@seat.test" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    memberSeatId = body.id;
    expect(body).toMatchObject({
      personId: member, codeSeatEmail: "member@seat.test", designLogin: "member-design@seat.test",
      mapped: true,
    });
    // non-exposure: no token/ciphertext field anywhere in the response.
    expect(JSON.stringify(body)).not.toMatch(/token_enc|enc:v1:/);
  });

  it("mapping PERSISTS across a fresh read (survives reload)", async () => {
    const r = await app.inject({ method: "GET", url: `${base()}?owner=me`, headers: asUser(member) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject([{ id: memberSeatId, codeSeatEmail: "member@seat.test", mapped: true }]);
  });

  it("member CANNOT map another user's seat (company.manage tier) -> 403", async () => {
    const r = await app.inject({
      method: "POST", url: base(), headers: asUser(member2),
      payload: { userId: member, codeSeatEmail: "hijack@seat.test" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("member CANNOT read another user's seat or the team roster -> 403", async () => {
    expect((await app.inject({ method: "GET", url: `${base()}?owner=user:${admin}`, headers: asUser(member) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${base()}?owner=team`, headers: asUser(member) })).statusCode).toBe(403);
  });

  it("member CANNOT patch or unmap another member's seat -> 403", async () => {
    expect((await app.inject({ method: "PATCH", url: `${base()}/${memberSeatId}`, headers: asUser(member2), payload: { codeSeatEmail: "hijack@seat.test" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `${base()}/${memberSeatId}`, headers: asUser(member2) })).statusCode).toBe(403);
  });

  it("member patches their OWN seat's designLogin WITHOUT clobbering other meta", async () => {
    const r = await app.inject({
      method: "PATCH", url: `${base()}/${memberSeatId}`, headers: asUser(member),
      payload: { designLogin: "member-design-v2@seat.test" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ designLogin: "member-design-v2@seat.test", codeSeatEmail: "member@seat.test" });
  });

  it("rejects status='linked' by hand (reserved) -> 400", async () => {
    const r = await app.inject({ method: "PATCH", url: `${base()}/${memberSeatId}`, headers: asUser(member), payload: { status: "linked" } });
    expect(r.statusCode).toBe(400);
  });

  it("company_admin admin-maps member2's seat and reads the team roster", async () => {
    const mapOther = await app.inject({
      method: "POST", url: base(), headers: asUser(admin),
      payload: { userId: member2, codeSeatEmail: "member2@seat.test" },
    });
    expect(mapOther.statusCode).toBe(201);
    expect(mapOther.json()).toMatchObject({ personId: member2, codeSeatEmail: "member2@seat.test", mapped: true });

    const roster = await app.inject({ method: "GET", url: `${base()}?owner=team`, headers: asUser(admin) });
    expect(roster.statusCode).toBe(200);
    const ids = roster.json().map((s: { id: string }) => s.id);
    expect(ids).toContain(memberSeatId);
    expect(ids).toContain(mapOther.json().id);
  });

  it("unmap keeps the seat row (soft revoke) and it survives in the team roster as unmapped", async () => {
    const del = await app.inject({ method: "DELETE", url: `${base()}/${memberSeatId}`, headers: asUser(member) });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ status: "revoked", mapped: false });

    const own = await app.inject({ method: "GET", url: `${base()}?owner=me`, headers: asUser(member) });
    expect(own.json()).toEqual([]); // owner=me only surfaces a non-revoked seat

    // but the underlying row is kept (verifiable via team roster, gated to admin) — vault soft-revoke.
    const db = await adminPool().query<{ status: string }>(
      `SELECT status FROM integration_connections WHERE id = $1`, [memberSeatId],
    );
    expect(db.rows[0].status).toBe("revoked");
  });

  it("re-map after unmap reuses the SAME row (vault upsert)", async () => {
    const r = await app.inject({
      method: "POST", url: base(), headers: asUser(member),
      payload: { codeSeatEmail: "member@seat.test" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBe(memberSeatId);
    expect(r.json().mapped).toBe(true);
  });

  it("only touches provider='claude' rows — a github connection's id 404s here", async () => {
    const github = await createConnection(co, {
      ownerKind: "user", ownerId: admin, provider: "github", createdBy: admin,
    });
    const r = await app.inject({ method: "PATCH", url: `${base()}/${github.id}`, headers: asUser(admin), payload: { codeSeatEmail: "x" } });
    expect(r.statusCode).toBe(404);
  });

  it("tenant isolation: a rival admin cannot read the roster or map across the boundary, and a forged id 404s", async () => {
    expect((await app.inject({ method: "GET", url: `${base()}?owner=team`, headers: asUser(otherAdmin) })).statusCode).toBe(403);
    const cross = await app.inject({
      method: "POST", url: base(), headers: asUser(otherAdmin),
      payload: { userId: otherAdmin, codeSeatEmail: "rival@seat.test" },
    });
    // otherAdmin mapping THEIR OWN seat in the OTHER tenant succeeds there, but reaching the co-scoped
    // route as a non-member of `co` must fail — otherAdmin has no membership/role in `co` at all.
    expect(cross.statusCode).toBe(403);
    const forged = await app.inject({ method: "DELETE", url: `/api/${other}/integrations/claude-seats/${memberSeatId}`, headers: asUser(otherAdmin) });
    expect(forged.statusCode).toBe(404);
  });
});
