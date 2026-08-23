// SMM-26 follow-up — proves the boundary `social-content-brief-automation.ts`'s header argues for:
// a PER-TENANT automation principal's resolved `companies` (the exact field WS8's `/search` reads
// as its tenant pre-filter, per `ai-agents/src/knowledge/service.ts#resolveEnvelope` and
// `store.ts#search`) can never contain a second tenant, by construction. This is the platform-side
// half of the "what can it see" boundary the ticket asked to be TESTED, not assumed — the WS8-side
// half (that `acl='{}'` internal-tier documents are readable by ANY member of a tenant, not only the
// brand-corpus scope a caller asked for) lives in a separate project (`ai-agents/`) and is named,
// not driven, in this file's own header and in `docs/plans/smm-tracker.md`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { assemblePrincipal } from "../rbac/principal";
import {
  contentBriefAutomationEmail,
  ensureContentBriefAutomationPrincipal,
  findContentBriefAutomationPrincipal,
} from "./social-content-brief-automation";

describe.skipIf(!TEST_URL)("social-content-brief-automation principal (SMM-26 follow-up)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await initTestDb();
    tenantA = await createCompany("CB-Automation Co A", ["social"]);
    tenantB = await createCompany("CB-Automation Co B", ["social"]);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("mints a DIFFERENT principal per tenant (never one shared/global identity)", async () => {
    const userA = await ensureContentBriefAutomationPrincipal(tenantA);
    const userB = await ensureContentBriefAutomationPrincipal(tenantB);
    expect(userA).not.toBe(userB);
    expect(contentBriefAutomationEmail(tenantA)).not.toBe(contentBriefAutomationEmail(tenantB));
  });

  it("THE BOUNDARY: assemblePrincipal resolves `companies` to EXACTLY this tenant, never the other one — proven, not assumed", async () => {
    const userA = await ensureContentBriefAutomationPrincipal(tenantA);
    const userB = await ensureContentBriefAutomationPrincipal(tenantB);

    const principalA = await assemblePrincipal(userA, "linked");
    const principalB = await assemblePrincipal(userB, "linked");
    expect(principalA).not.toBeNull();
    expect(principalB).not.toBeNull();

    // This IS the property WS8's `/search` predicate reads as its tenant pre-filter
    // (`ctx.tenantSet` <- `principal.companies`). If this ever resolved to more than one tenant, the
    // per-tenant isolation the seed's header argues for would be false.
    expect(principalA!.companies).toEqual([tenantA]);
    expect(principalB!.companies).toEqual([tenantB]);
    expect(principalA!.companies).not.toContain(tenantB);
    expect(principalB!.companies).not.toContain(tenantA);

    // `assurance` actually observed at the platform boundary for THIS caller shape — stated rather
    // than assumed. `assemblePrincipal(userId, "linked")` returns exactly the assurance it was asked
    // to mint (this file drives the SAME "linked" tier `queryBrandKnowledge`'s own `selfLinkUpsert`
    // + OBO-envelope resolution produces for ANY caller, human or automation, once its
    // `identity_links` row is verified) — never silently downgraded to "low".
    expect(principalA!.assurance).toBe("linked");
  });

  it("holds NO role grant and NO home_company_id anchor — least privilege, verified", async () => {
    const userA = await ensureContentBriefAutomationPrincipal(tenantA);
    const principalA = await assemblePrincipal(userA, "linked");
    expect(principalA!.roles).toEqual([]);
    const { rows } = await withGlobal((c) =>
      c.query<{ home_company_id: string | null }>(`SELECT home_company_id FROM users WHERE id = $1`, [userA]),
    );
    expect(rows[0].home_company_id).toBeNull();
  });

  it("is idempotent AND self-healing: re-running for the SAME tenant returns the SAME userId and never creates a second membership row", async () => {
    const first = await ensureContentBriefAutomationPrincipal(tenantA);
    const second = await ensureContentBriefAutomationPrincipal(tenantA);
    expect(second).toBe(first);

    const { rows } = await withTenants([tenantA], (c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantA, first]),
    );
    expect(rows[0].n).toBe("1");
  });

  it("the membership is kind='service' — never counted as staff on a people-shaped surface", async () => {
    const userA = await ensureContentBriefAutomationPrincipal(tenantA);
    const { rows } = await withTenants([tenantA], (c) =>
      c.query<{ kind: string }>(`SELECT kind FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantA, userA]),
    );
    expect(rows[0].kind).toBe("service");
  });

  it("findContentBriefAutomationPrincipal returns null for an unprovisioned tenant — REFUSAL, never a silent mint", async () => {
    const freshTenant = await createCompany("CB-Automation Co Unprovisioned", ["social"]);
    const found = await findContentBriefAutomationPrincipal(freshTenant);
    expect(found).toBeNull();
  });
});
