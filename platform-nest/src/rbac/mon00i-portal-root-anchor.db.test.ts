// MON-00i — the client-portal root anchor. Follow-up to MON-00 (docs/plans/2026-08-20-monitoring-
// gated-rulings.md §1); ruling + design in §1b of that same file.
//
// THE GAP THIS PINS: MON-00c's cross-root boundary (`inRoot`) covers every STAFF role
// (`group_executive`'s 46 role-arm rules, its 8 split rules, and 183 `perm_*` mirrors) but had NO
// anchor at all for client-portal principals — `client_contacts` rows carry no `home_company_id`
// and clients are deliberately excluded from `company_memberships` (principal.ts's own header), so
// `assemblePrincipal()`'s `rootCompanies` resolved to `[]` for every real client. Two prior attempts
// to gate `resource_portal.yaml`'s 7 `perm_portal_*` mirrors (and, it turns out, the `client`
// role-arm rule itself — the ACTUAL path a real client authorizes through, see that file's own
// header) with `&& variables.inRoot` were reverted because of exactly this: an empty anchor denied
// every legitimate client in their own tenant. §1b closes the gap with a `client_contacts`-derived
// fallback anchor, consulted ONLY when the principal has no staff anchor at all (no `home_company_id`,
// no active `company_memberships`) — see principal.ts's own comment for why precedence (not a flat
// union across all three sources) is the safe shape.
//
// ⚠ POSITIVE CONTROLS FIRST, ALWAYS (the estate's defining failure mode: an unset GUC or a wrong
// anchor returns nothing and reports success, so "denied cross-root" passes vacuously against a
// principal who could never see ANYTHING, including their own data). Every negative assertion below
// is paired with, and follows, a proof that the same principal reaches their own tenant.
//
// ⚠ THIS SUITE PROVES THE GAP EXISTED: with `inRoot` wired onto the portal rules but WITHOUT
// principal.ts's client_contacts fallback (i.e. reverting only that one function to its
// pre-MON-00i shape), the POSITIVE control below goes red — the exact regression the two prior
// attempts hit. That was verified live during this ticket, not assumed (see docs/plans/2026-08-20-
// monitoring-gated-rulings.md §1b's "verified" note).
//
// Needs DATABASE_URL_TEST *and* a live Cerbos. Skips silently otherwise — check the skip count.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { check, type Resource } from "./cerbos";
import { assemblePrincipal } from "./principal";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole, createClient } from "../testing/fixtures";
import { withTenants, newId } from "../db";

const live = !!process.env.CERBOS_URL;
const PORTAL_ACTIONS = ["read", "decide", "sign", "pay", "update_profile", "request_change", "approve_post"] as const;
const portalResource = (tenantId: string): Resource => ({ kind: "portal", id: "p-1", tenantId });

// A string that must never appear in a response read by the unrelated root. Same discipline as
// cross-root-boundary.db.test.ts: asserted against the WHOLE raw body, not a parsed field.
const CANARY = "LEAK-CANARY-MON00i-PORTAL-7c2e9a";
const OWN_MARKER = "mon00i-own-run-9f1b";

describe.skipIf(!TEST_URL || !live)("MON-00i · the client-portal root anchor", () => {
  let app: NestFastifyApplication;
  let tenantA: string; // the agency the client is actually a contact of — its own root
  let tenantB: string; // a totally unrelated root the client has NO relationship with at all
  let clientUserId: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    // Two INDEPENDENT roots (createCompany with no parent -> root_company_id = itself, MON-00a).
    tenantA = await createCompany("MON-00i Agency A");
    tenantB = await createCompany(`MON-00i Unrelated Root B ${CANARY}`);

    const clientRoleId = await createRole("client");
    clientUserId = await createUser("mon00i-client@test.local");
    // The ONLY relationship this principal has anywhere: a client_contacts row under tenantA. No
    // home_company_id, no company_memberships (clients are deliberately excluded from that table —
    // principal.ts's header) — this is the real shape of every client-portal principal.
    await grantRole(clientUserId, clientRoleId, "company", tenantA);
    const clientRowA = await createClient(tenantA, "MON-00i Client Co (tenant A)");
    await withTenants([tenantA], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', $5)`,
        [newId(), tenantA, clientRowA, clientUserId, config.originSite],
      ),
    );
    await withTenants([tenantA], (c) =>
      c.query(
        `INSERT INTO pipeline_runs (id, tenant_id, client_id, title, status, origin_site)
         VALUES ($1, $2, $3, $4, 'delivery_active', $5)`,
        [newId(), tenantA, clientRowA, OWN_MARKER, config.originSite],
      ),
    );

    // Root B: a client and a run that must never be visible to tenantA's client — a relationship
    // this principal has never had a row for anywhere.
    const clientRowB = await createClient(tenantB, `${CANARY} Client`);
    await withTenants([tenantB], (c) =>
      c.query(
        `INSERT INTO pipeline_runs (id, tenant_id, client_id, title, status, origin_site)
         VALUES ($1, $2, $3, $4, 'delivery_active', $5)`,
        [newId(), tenantB, clientRowB, `${CANARY}-run`, config.originSite],
      ),
    );

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("positive controls — run first, so no negative below can pass vacuously", () => {
    it("assemblePrincipal anchors the client to tenantA's root via the client_contacts fallback (not empty)", async () => {
      const p = await assemblePrincipal(clientUserId, "high");
      expect(p).not.toBeNull();
      expect(p!.rootCompanies, "a real client must not resolve to an empty root anchor").toContain(tenantA);
    });

    it("the wired mirror + role-arm rule ALLOW every portal action in the client's own tenant (live Cerbos, real assemblePrincipal)", async () => {
      const p = await assemblePrincipal(clientUserId, "high");
      for (const action of PORTAL_ACTIONS) {
        const decision = await check(p!, portalResource(tenantA), action);
        expect(decision.allow, `${action}: ${JSON.stringify(decision)}`).toBe(true);
      }
    });

    it("the client CAN read their own tenant's portal runs over HTTP, and sees their own run", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${tenantA}/portal/runs`, headers: asUser(clientUserId),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(OWN_MARKER);
    });

    it("root B's canary row really exists (a typo'd fixture would fake every negative below)", async () => {
      const { rows } = await adminPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pipeline_runs WHERE tenant_id = $1 AND title = $2`,
        [tenantB, `${CANARY}-run`],
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  describe("the boundary itself — root A cannot reach root B", () => {
    it("live Cerbos DENIES every portal action against the unrelated root, for the real assembled principal", async () => {
      const p = await assemblePrincipal(clientUserId, "high");
      for (const action of PORTAL_ACTIONS) {
        const decision = await check(p!, portalResource(tenantB), action);
        expect(decision.allow, `${action} must be denied cross-root: ${JSON.stringify(decision)}`).toBe(false);
      }
    });

    it("the client CANNOT read the unrelated root's portal runs over HTTP, and the canary appears nowhere in the raw body", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${tenantB}/portal/runs`, headers: asUser(clientUserId),
      });
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain(CANARY);
    });
  });
});
