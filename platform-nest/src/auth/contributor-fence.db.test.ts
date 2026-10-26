// M5-W1d — AuthGuard's contributor fence over the REAL HTTP surface (buildApp + app.inject, real Postgres + RLS + Cerbos).
//
//   * EVERY guarded route that is not marked `@ContributorRoute()` answers a contributor 403 `contributor_route_forbidden`,
//     before its handler runs. The list is not hand-written: it is every route of AppModule (testing/route-inventory.ts),
//     so a route added next month is in this sweep the day it lands.
//   * A marked route passes the fence at assurance high (`/api/me` answers 200 with `kind: "contributor"`), and the SAME
//     route through an OBO envelope (assurance `linked`) is 403: the fence wants a real second factor.
//   * Creating an assistant thread is 403 for a contributor; an employee's same request is not refused by the fence.
//   * A contributor never appears in a people list (`/members`, `/users`, even with `includeService=1`), beside the staff
//     member who does (the control that the list is not simply empty).
// Needs DATABASE_URL_TEST and Cerbos. NOT RUN LOCALLY (owner order: no docker on the laptop); it runs on GitHub Actions.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { addMembership, createCompany, createRole, createUser, grantRole, linkIdentity } from "../testing/fixtures";
import { appRoutes, concretePath, routeKey } from "../testing/route-inventory";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const OTHER_ID = "00000000-0000-4000-8000-0000000000a1";
const INJECTABLE = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

describe.skipIf(!TEST_URL)("M5-W1d: AuthGuard's contributor fence over every route", () => {
  let app: NestFastifyApplication;
  let A: string;
  let contributor: string;
  let staff: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W1d Fence Co", ["webdev", "assistant", "pm", "hr", "search", "social", "finance", "clients"]);
    staff = await createUser("staff@w1d-fence.test");
    await addMembership(A, staff);
    await grantRole(staff, await createRole("company_admin"), "company", A);
    contributor = await createUser("writer@w1d-fence.test", "Freelance Writer");
    await adminPool().query(`UPDATE users SET kind = 'contributor' WHERE id = $1`, [contributor]);
    await adminPool().query(
      `INSERT INTO editorial_contributors (tenant_id, user_id, sponsor_user_id, status, valid_until, origin_site)
       VALUES ($1, $2, $3, 'active', now() + interval '30 days', $4)`,
      [A, contributor, staff, config.originSite],
    );
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("a marked route passes at assurance high: /api/me is 200 and says kind contributor, with the anchor's company", async () => {
    const r = await app.inject({ method: "GET", url: "/api/me", headers: asUser(contributor) });
    expect(r.statusCode).toBe(200);
    expect(r.json().kind).toBe("contributor");
    expect(r.json().companies.map((c: { id: string }) => c.id)).toEqual([A]);
  });

  it("`linked` assurance (an OBO envelope) is 403 on the same marked route; an employee's envelope is not refused", async () => {
    await linkIdentity(contributor, "whatsapp", "w1d-contributor", true);
    const r = await app.inject({
      method: "GET", url: "/api/me", headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "w1d-contributor" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: "contributor_route_forbidden", reason: "assurance_high_required" });
    // control: an employee through the same channel reaches /me (the fence touches only contributors)
    await linkIdentity(staff, "whatsapp", "w1d-staff", true);
    const s = await app.inject({
      method: "GET", url: "/api/me", headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "w1d-staff" },
    });
    expect(s.statusCode).toBe(200);
    expect(s.json().kind).toBe("employee");
  });

  it("creating an assistant thread is 403 contributor_route_forbidden; the employee's request is not fenced", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(contributor), payload: { title: "hi" } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: "contributor_route_forbidden", reason: "route_not_open_to_contributors" });
    const s = await app.inject({ method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(staff), payload: { title: "hi" } });
    expect(s.json()?.error).not.toBe("contributor_route_forbidden");
  });

  it("EVERY guarded route without @ContributorRoute() answers a contributor 403 contributor_route_forbidden", async () => {
    const routes = appRoutes().filter((r) => r.authGuarded && !r.contributorRoute && INJECTABLE.has(r.method));
    expect(routes.length).toBeGreaterThan(300); // the sweep is real
    const offenders: string[] = [];
    const preGuarded: string[] = [];
    for (const r of routes) {
      const url = concretePath(r.path, (p) => (p === "tenantId" ? A : OTHER_ID));
      const res = await app.inject({
        method: r.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        url,
        headers: asUser(contributor),
        ...(r.method === "GET" ? {} : { payload: {} }),
      });
      if (r.guardsBeforeAuth.length > 0) {
        // A guard that runs BEFORE AuthGuard (a feature flag that 404s for everyone) may answer first; it must never let
        // the request through to a handler.
        if (res.statusCode < 400) offenders.push(`${routeKey(r)} -> ${res.statusCode} (guards before AuthGuard: ${r.guardsBeforeAuth.join(", ")})`);
        else preGuarded.push(routeKey(r));
        continue;
      }
      let error: unknown;
      try {
        error = res.json()?.error;
      } catch {
        error = undefined;
      }
      if (res.statusCode !== 403 || error !== "contributor_route_forbidden") {
        offenders.push(`${routeKey(r)} -> ${res.statusCode} ${String(error)}`);
      }
    }
    expect(offenders, `routes a contributor was NOT fenced from:\n${offenders.join("\n")}`).toEqual([]);
    // the pre-AuthGuard set is small and named; a growth here is worth a look
    expect(preGuarded.length).toBeLessThan(20);
  }, 300_000);

  it("the fence answers before the handler: a contributor's write leaves no trace (no assistant thread row)", async () => {
    const n = await adminPool().query(`SELECT count(*)::int AS n FROM assistant_threads WHERE owner_user_id = $1`, [contributor]);
    expect(n.rows[0].n).toBe(0);
  });

  it("a contributor never appears in a people list, even with includeService=1; the staff member does (control)", async () => {
    for (const url of [`/api/${A}/members`, `/api/${A}/members?includeService=1`, `/api/${A}/users`, `/api/${A}/users?includeService=1`]) {
      const r = await app.inject({ method: "GET", url, headers: asUser(staff) });
      expect(r.statusCode, url).toBe(200);
      const rows = r.json() as Array<{ id?: string; user_id?: string; email?: string }> | { users?: unknown[] };
      const list = (Array.isArray(rows) ? rows : ((rows as { users?: unknown[]; members?: unknown[] }).users ?? (rows as { members?: unknown[] }).members ?? [])) as Array<{ id?: string; user_id?: string; email?: string }>;
      const emails = list.map((x) => x.email);
      expect(emails, url).toContain("staff@w1d-fence.test");
      expect(emails, url).not.toContain("writer@w1d-fence.test");
    }
  });
});
