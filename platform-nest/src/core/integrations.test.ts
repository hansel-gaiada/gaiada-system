// WSUX-14 (ex-P1-08) — F1 connections API against live PG + RLS + Cerbos. Covers decision #8's
// full surface + the security bar the WSUX-12 gate probes for:
//   * self-service (member CRUDs their OWN user connection) vs company.manage (manager+ for company
//     rows and OTHERS' rows) — the own-vs-company Cerbos matrix;
//   * TOKEN NON-EXPOSURE — no response ever serializes access_token_enc/refresh_token_enc; a stored
//     credential surfaces only as hasToken/hasRefreshToken; the DB holds enc:v1 ciphertext, not plaintext;
//   * the vault write path is FAIL-CLOSED without INTEGRATION_TOKEN_KEY;
//   * soft revoke keeps the row (status='revoked', tokens nulled);
//   * tenant isolation (a rival admin sees/creates nothing across the boundary).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { setConnectionTokens } from "./integrations.service";
import { randomBytes } from "node:crypto";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("F1 connections API (WSUX-14)", () => {
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
    config.integrationTokenKey = randomBytes(32).toString("base64");
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Web Dev");
    other = await createCompany("Rival Co");
    member = await createUser("member@conn.test");
    member2 = await createUser("member2@conn.test");
    admin = await createUser("admin@conn.test");
    otherAdmin = await createUser("admin@rival-conn.test");
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

  const base = () => `/api/${co}/integrations/connections`;
  let memberConnId: string;

  it("a member creates their OWN user connection (owner defaults to self); no token fields leak", async () => {
    const r = await app.inject({
      method: "POST", url: base(), headers: asUser(member),
      payload: { provider: "github", externalAccount: "octo-member" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    memberConnId = body.id;
    expect(body).toMatchObject({ ownerKind: "user", ownerId: member, provider: "github", status: "unconfigured", hasToken: false });
    // token non-exposure: no *_enc key, and the raw text carries no token column name.
    expect(body.access_token_enc).toBeUndefined();
    expect(body.refresh_token_enc).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/token_enc/);
  });

  it("member lists owner=me and sees their connection", async () => {
    const r = await app.inject({ method: "GET", url: `${base()}?owner=me`, headers: asUser(member) });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((c: { id: string }) => c.id)).toContain(memberConnId);
  });

  it("member CANNOT create a company connection (company.manage tier) → 403", async () => {
    const r = await app.inject({
      method: "POST", url: base(), headers: asUser(member),
      payload: { ownerKind: "company", provider: "github" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("member CANNOT read owner=company or another user's rows → 403", async () => {
    expect((await app.inject({ method: "GET", url: `${base()}?owner=company`, headers: asUser(member) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${base()}?owner=user:${admin}`, headers: asUser(member) })).statusCode).toBe(403);
  });

  it("member CANNOT patch or revoke another member's connection → 403", async () => {
    // member2 tries to touch member's row
    expect((await app.inject({ method: "PATCH", url: `${base()}/${memberConnId}`, headers: asUser(member2), payload: { externalAccount: "hijack" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `${base()}/${memberConnId}`, headers: asUser(member2) })).statusCode).toBe(403);
  });

  it("member patches their OWN connection (externalAccount/meta)", async () => {
    const r = await app.inject({
      method: "PATCH", url: `${base()}/${memberConnId}`, headers: asUser(member),
      payload: { externalAccount: "octo-member-2", meta: { note: "primary" }, status: "pending" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ externalAccount: "octo-member-2", status: "pending", meta: { note: "primary" } });
  });

  it("rejects setting status='linked' by hand (reserved for the token path) → 400", async () => {
    const r = await app.inject({ method: "PATCH", url: `${base()}/${memberConnId}`, headers: asUser(member), payload: { status: "linked" } });
    expect(r.statusCode).toBe(400);
  });

  let companyConnId: string;
  it("company_admin creates a company connection and manages others' rows", async () => {
    const create = await app.inject({
      method: "POST", url: base(), headers: asUser(admin),
      payload: { ownerKind: "company", provider: "google_drive", externalAccount: "team@drive" },
    });
    expect(create.statusCode).toBe(201);
    companyConnId = create.json().id;
    expect(create.json()).toMatchObject({ ownerKind: "company", ownerId: co, provider: "google_drive" });

    // admin reads company rows AND the member's user rows (company.manage)
    const compList = await app.inject({ method: "GET", url: `${base()}?owner=company`, headers: asUser(admin) });
    expect(compList.statusCode).toBe(200);
    expect(compList.json().map((c: { id: string }) => c.id)).toContain(companyConnId);

    const memberList = await app.inject({ method: "GET", url: `${base()}?owner=user:${member}`, headers: asUser(admin) });
    expect(memberList.statusCode).toBe(200);
    expect(memberList.json().map((c: { id: string }) => c.id)).toContain(memberConnId);
  });

  it("VAULT: a sealed token surfaces only as hasToken; DB stores enc:v1 ciphertext, never plaintext", async () => {
    const PLAINTEXT = "ghp_live_secret_should_never_be_returned";
    await setConnectionTokens(co, memberConnId, { accessToken: PLAINTEXT, refreshToken: "rt_secret", scopes: ["repo"] });

    // API read: hasToken true, tokenKeyVersion v1, and the plaintext / ciphertext columns are absent.
    const r = await app.inject({ method: "GET", url: `${base()}?owner=me`, headers: asUser(member) });
    const row = r.json().find((c: { id: string }) => c.id === memberConnId);
    expect(row).toMatchObject({ hasToken: true, hasRefreshToken: true, tokenKeyVersion: "v1", status: "linked" });
    const asText = JSON.stringify(r.json());
    expect(asText).not.toContain(PLAINTEXT);
    expect(asText).not.toContain("rt_secret");
    expect(asText).not.toMatch(/token_enc/);
    expect(asText).not.toContain("enc:v1:");

    // DB (bypassing RLS): the stored value is enc:v1 ciphertext, not the plaintext.
    const db = await adminPool().query<{ access_token_enc: string; refresh_token_enc: string }>(
      `SELECT access_token_enc, refresh_token_enc FROM integration_connections WHERE id = $1`, [memberConnId],
    );
    expect(db.rows[0].access_token_enc.startsWith("enc:v1:")).toBe(true);
    expect(db.rows[0].access_token_enc).not.toContain(PLAINTEXT);
    expect(db.rows[0].refresh_token_enc.startsWith("enc:v1:")).toBe(true);
  });

  it("VAULT FAIL-CLOSED: token write is refused (503) when INTEGRATION_TOKEN_KEY is unset", async () => {
    const saved = config.integrationTokenKey;
    config.integrationTokenKey = "";
    try {
      await expect(setConnectionTokens(co, companyConnId, { accessToken: "x" })).rejects.toThrow(/vault not configured/i);
      // and nothing was written
      const db = await adminPool().query(`SELECT access_token_enc FROM integration_connections WHERE id = $1`, [companyConnId]);
      expect(db.rows[0].access_token_enc).toBeNull();
    } finally {
      config.integrationTokenKey = saved;
    }
  });

  it("soft revoke keeps the row (status='revoked', tokens nulled)", async () => {
    const del = await app.inject({ method: "DELETE", url: `${base()}/${memberConnId}`, headers: asUser(member) });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ status: "revoked", hasToken: false, hasRefreshToken: false });
    // row still present in the DB
    const db = await adminPool().query<{ status: string; access_token_enc: string | null }>(
      `SELECT status, access_token_enc FROM integration_connections WHERE id = $1`, [memberConnId],
    );
    expect(db.rows[0].status).toBe("revoked");
    expect(db.rows[0].access_token_enc).toBeNull();
    // default list excludes revoked
    const list = await app.inject({ method: "GET", url: `${base()}?owner=me`, headers: asUser(member) });
    expect(list.json().map((c: { id: string }) => c.id)).not.toContain(memberConnId);
  });

  it("re-link (POST) reuses the revoked row and brings it back unconfigured", async () => {
    const r = await app.inject({ method: "POST", url: base(), headers: asUser(member), payload: { provider: "github" } });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBe(memberConnId); // same row (UNIQUE upsert)
    expect(r.json().status).toBe("unconfigured");
  });

  it("emitted integration_connection.created to the outbox", async () => {
    const rows = await adminPool().query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'integration_connection.created'`,
      [companyConnId],
    );
    expect(rows.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("tenant isolation: a rival admin cannot read or create across the boundary", async () => {
    expect((await app.inject({ method: "GET", url: `${base()}?owner=company`, headers: asUser(otherAdmin) })).statusCode).toBe(403);
    const cross = await app.inject({
      method: "POST", url: base(), headers: asUser(otherAdmin),
      payload: { ownerKind: "company", provider: "github" },
    });
    expect(cross.statusCode).toBe(403);
    // and a forged id from another tenant is a 404, not a leak
    const forged = await app.inject({ method: "DELETE", url: `/api/${other}/integrations/connections/${companyConnId}`, headers: asUser(otherAdmin) });
    expect(forged.statusCode).toBe(404);
  });
});
