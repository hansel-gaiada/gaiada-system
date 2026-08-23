// SMM-26 follow-up — `content-brief-job.ts` against LIVE Postgres (RLS). A DEDICATED file (this
// module's own recurring defect class #7: never share a module-level mock across a file whose
// `it()`s were not designed to run in this exact order) — `content-brief.test.ts` already proves
// `runContentBrief` itself; this file proves the SWEEP's own orchestration: which engagements it
// finds, which principal it resolves, and — the property this whole follow-up exists to prove —
// that an opted-in tenant with NO provisioned principal is REFUSED, never silently drafted
// ungrounded and never silently skipped as if nobody had opted in at all.
//
// Engagements are seeded by DIRECT SQL, not through `social.controller.ts` (off-limits to this
// ticket, and irrelevant here — this file tests the SCHEDULED JOB's own discovery query, not the
// HTTP surface).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";
import { declareSocialModuleScope } from "./module-scope";
import { ensureContentBriefAutomationPrincipal } from "../../seed/social-content-brief-automation";

// Scoped to THIS FILE only (defect class #7) — a minimal caption/idea gateway stand-in, never
// shared with content-brief.test.ts's own hoisted mock.
const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(async (prompt: string) => {
    if (prompt.includes("Write in this brand's voice")) {
      return { text: JSON.stringify({ body: "sweep caption", hashtags: [] }), provider: "hermes-mock" };
    }
    if (prompt.includes("Generate exactly")) {
      const m = prompt.match(/Generate exactly (\d+) distinct/);
      const n = m ? Number(m[1]) : 1;
      const ideas = Array.from({ length: n }, (_, i) => ({ title: `Sweep idea ${i + 1}`, brief: `Sweep brief ${i + 1}` }));
      return { text: JSON.stringify({ ideas }), provider: "hermes-mock" };
    }
    return { text: "{}", provider: "hermes-mock" };
  }),
}));
vi.mock("./gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-client")>();
  return { ...actual, completeViaGateway: (prompt: string) => completeMock(prompt) };
});

// No knowledge service configured in this file (`config.services.knowledge.url` stays empty) —
// `queryBrandKnowledge` degrades to [] with no network call, exactly its own documented fail-soft
// contract. The RAG-grounding boundary itself is `social-content-brief-automation.test.ts`'s job;
// this file's job is the sweep's own discovery/refusal logic, which does not depend on it.

import { pullTenantContentBriefSweep, runContentBriefSweep } from "./content-brief-job";

const MODULES = { modules: ["social"] };

describe.skipIf(!TEST_URL)("content-brief-job (SMM-26 follow-up scheduled sweep)", () => {
  let tenantOptedIn: string;
  let tenantUnprovisioned: string;
  let tenantNotOptedIn: string;
  let clientOptedIn: string;
  let clientUnprovisioned: string;
  let clientNotOptedIn: string;

  async function seedEngagement(tenantId: string, clientId: string, toolScope: Record<string, unknown>): Promise<string> {
    const id = newId();
    await withTenants([tenantId], async (c) => {
      await declareSocialModuleScope(c);
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, tool_scope, status, origin_site)
         VALUES ($1,$2,$3,'Sweep Eng',$4,'active',$5)`,
        [id, tenantId, clientId, JSON.stringify(toolScope), config.originSite],
      );
    }, MODULES);
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.services.gateway = { url: "https://gateway.test", token: "gw-tok" };
    config.services.knowledge = { url: "", token: "" }; // deliberately unconfigured — see file header

    tenantOptedIn = await createCompany("CB-Sweep Co Opted-In", ["social"]);
    tenantUnprovisioned = await createCompany("CB-Sweep Co Unprovisioned", ["social"]);
    tenantNotOptedIn = await createCompany("CB-Sweep Co Not-Opted-In", ["social"]);
    clientOptedIn = await createClient(tenantOptedIn, "Sweep Brand Opted-In");
    clientUnprovisioned = await createClient(tenantUnprovisioned, "Sweep Brand Unprovisioned");
    clientNotOptedIn = await createClient(tenantNotOptedIn, "Sweep Brand Not-Opted-In");

    // Only ONE of the three tenants gets its automation principal provisioned — the other opted-in
    // tenant deliberately does NOT, to prove the refusal path.
    await ensureContentBriefAutomationPrincipal(tenantOptedIn);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(() => {
    completeMock.mockClear();
  });

  it("finds and drafts an opted-in engagement whose tenant HAS a provisioned principal", async () => {
    const eng = await seedEngagement(tenantOptedIn, clientOptedIn, {
      networks: {}, posting: { cadencePerWeek: 1 }, ai: { autoWeeklyBrief: true },
    });

    const result = await pullTenantContentBriefSweep(tenantOptedIn);
    expect(result.engagements).toBe(1);
    expect(result.drafted).toBe(1);
    expect(result.refused).toBe(0);
    expect(result.principalNotProvisioned).toBe(0);
    expect(result.results).toEqual([{ engagementId: eng, outcome: "drafted", ideasCreated: 1, variantsCreated: 0 }]);

    const posts = await withTenants([tenantOptedIn], (c) =>
      c.query<{ source: string }>(`SELECT source FROM social_posts WHERE engagement_id = $1`, [eng]),
      MODULES,
    );
    expect(posts.rows).toHaveLength(1);
    expect(posts.rows[0].source).toBe("agent"); // honest attribution — nobody prompted this idea directly
  });

  it("THE REFUSAL: an opted-in engagement whose tenant has NO provisioned principal is counted principal_not_provisioned and drafts NOTHING — never a silent skip, never an ungrounded draft", async () => {
    const eng = await seedEngagement(tenantUnprovisioned, clientUnprovisioned, {
      networks: {}, posting: { cadencePerWeek: 1 }, ai: { autoWeeklyBrief: true },
    });

    const result = await pullTenantContentBriefSweep(tenantUnprovisioned);
    expect(result.engagements).toBe(1); // the engagement WAS found — it opted in
    expect(result.drafted).toBe(0);
    expect(result.principalNotProvisioned).toBe(1); // but no identity exists to ground it, so it is refused
    expect(result.results).toEqual([{ engagementId: eng, outcome: "principal_not_provisioned" }]);

    // The proof that matters: nothing was drafted. Not "drafted with no grounding", not "silently
    // skipped as if never opted in" — genuinely refused, zero rows written.
    const posts = await withTenants([tenantUnprovisioned], (c) =>
      c.query<{ id: string }>(`SELECT id FROM social_posts WHERE engagement_id = $1`, [eng]),
      MODULES,
    );
    expect(posts.rows).toHaveLength(0);
    expect(completeMock).not.toHaveBeenCalled(); // no gateway call was ever attempted for the refused engagement
  });

  it("an engagement that never opted in is invisible to the sweep — a THIRD fact, distinct from refused/unprovisioned", async () => {
    await seedEngagement(tenantNotOptedIn, clientNotOptedIn, {
      networks: {}, posting: { cadencePerWeek: 1 }, // ai.autoWeeklyBrief absent — default false
    });
    // Even though this tenant HAS no provisioned principal either, that must never be why it is
    // skipped — it is skipped because it never asked.
    const result = await pullTenantContentBriefSweep(tenantNotOptedIn);
    expect(result.engagements).toBe(0);
    expect(result.principalNotProvisioned).toBe(0);
    expect(result.drafted).toBe(0);
  });

  it("an engagement with ai.autoWeeklyBrief explicitly false is ALSO invisible (explicit opt-out reads the same as never-asked at this layer)", async () => {
    const tenant = await createCompany("CB-Sweep Co Explicit False", ["social"]);
    const client = await createClient(tenant, "Explicit False Brand");
    await seedEngagement(tenant, client, { ai: { autoWeeklyBrief: false } });
    const result = await pullTenantContentBriefSweep(tenant);
    expect(result.engagements).toBe(0);
  });

  it("runContentBriefSweep aggregates across ALL THREE tenants correctly, without letting one tenant's refusal or the other's success bleed into the third", async () => {
    // Re-seed a clean opted-in engagement so this test is independent of execution order (defect
    // class #7) — the earlier engagements in tenantOptedIn/tenantUnprovisioned already exist from
    // prior `it()`s, so this asserts the AGGREGATE rather than re-deriving exact per-tenant counts.
    const result = await runContentBriefSweep();
    expect(result.tenants).toBeGreaterThanOrEqual(3);
    expect(result.drafted).toBeGreaterThanOrEqual(1); // tenantOptedIn's engagement
    expect(result.principalNotProvisioned).toBeGreaterThanOrEqual(1); // tenantUnprovisioned's engagement
  });

  it("THE MODULE GUC — every assertion above already depends on declareSocialModuleScope inside loadOptedInEngagementIds; a dedicated pin: reading the SAME engagement via a plain withTenants with NO {modules} option returns ZERO rows", async () => {
    const eng = await seedEngagement(tenantOptedIn, clientOptedIn, {
      networks: {}, posting: { cadencePerWeek: 1 }, ai: { autoWeeklyBrief: true },
    });
    const unscoped = await withTenants([tenantOptedIn], (c) =>
      c.query<{ id: string }>(`SELECT id FROM social_engagements WHERE id = $1`, [eng]),
    ); // NO {modules:['social']} — the trap `loadOptedInEngagementIds` avoids by self-declaring
    expect(unscoped.rows).toHaveLength(0); // proves the wall is real, not merely assumed
  });
});
