// SCP-1b — the content pipeline's routes against live Postgres and Cerbos (FRONTEND-BFF-CONTRACT §63.6, §63.21). Skips
// without DATABASE_URL_TEST, like every suite here; on CI it runs for real. Every case drives the REAL endpoint as a real
// persona with the real policies (lane 1b-iam's), never a service function with the authorization mocked out.
//
// What it proves:
//   (1) every post scenario of the fixture (`scp-stage-machine.json`) through the routes, the client's own decisions taken
//       in their recorded form (`record_client_*`: the portal routes are SCP-2), each scenario on its own fresh client;
//   (2) maker/checker for the author and the officer, also as the owner and as the superadmin, also through the OBO
//       envelope with `x-obo-agent`, with another of the four passing;
//   (3) who acts: the officer only on their own clients' posts; a Web Dev head holding `manager`, a company admin and a
//       social_manager neither approve nor create; the two seats, the owner and the superadmin do; a seat on another
//       company's same-id unit does not; the owner neither blocks nor records a client decision; a Creatives designer
//       acts only on a post whose request task names them, an in-team designer only on an in_team post; an automation is
//       refused; an agent acting for the officer does what the officer can, and its activity carries `via.agent`;
//   (4) the order of checks: 403 before 400 and 409; `status_changed`; `alreadyApplied` on a replayed actionId;
//   (5) final_approve: one variant per placed network and one review each;
//   (6) SCP-Q13: schedule keeps the approved date; reschedule sends the post back with every review pending; a publisher
//       schedule is unscheduled by one of the four (its dispatch cancelled at the publisher first); a Composer caption
//       edit on an approved post sends it back; approved_time_passed;
//   (7) the designs routes (another company's asset is 404), the suggestions routes, the bulk route, the read.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId, withGlobal } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, linkIdentity } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialSeat, grantSocialRole, setEngagementOfficer } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { registerPublisher, resetPublishers } from "../publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "../publisher/mock-driver";
import { SCP, type ScpScenario, type ScpScenarioStep } from "./fixture";
import { MUST_HAVE_KEYS } from "./handoff-checks";

const FUTURE = "2027-03-10T10:00:00.000Z";
const LATER = "2027-03-12T10:00:00.000Z";
const PAST = new Date(Date.now() - 2 * 86400000).toISOString();
const SOCIAL = { modules: ["social"] };

type Who = string | { obo: string; agent?: string };
const SVC = { authorization: "Bearer svc-token" };
const headersFor = (who: Who) =>
  typeof who === "string"
    ? { ...SVC, "x-user-id": who }
    : { ...SVC, "x-obo-provider": "whatsapp", "x-obo-external-id": who.obo, ...(who.agent ? { "x-obo-agent": who.agent } : {}) };

interface Eng { clientId: string; engagementId: string; cycleId: string; officer: string; creativeSource: "creatives" | "in_team" }

/** The scenarios of other machines (SCP-4, SCP-5a), as machine.test.ts lists them. */
const OWNED_ELSEWHERE = new Set([
  "monthly boost budget: committed, lowering and the stopped boost's spend",
  "the monthly report: Draft, HoD check, Ready, Sent",
]);

describe.skipIf(!TEST_URL)("SCP-1b · the pipeline routes (BFF §63.6)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  const U: Record<string, string> = {};
  let assetId: string;
  let foreignAssetId: string;
  let n = 0;
  let pub: MockPublisherState;
  const base = () => `/api/${A}/modules/social`;

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
  async function freshEngagement(o: { creativeSource?: "creatives" | "in_team"; officer?: string; platforms?: string[] } = {}): Promise<Eng> {
    n += 1;
    const clientId = await createClient(A, `Mock Client ${n}`);
    const engagementId = newId();
    const cycleId = newId();
    const officer = o.officer ?? U.officer;
    const creativeSource = o.creativeSource ?? "creatives";
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, 'central')`,
        [engagementId, A, clientId, `Mock engagement ${n}`, officer, JSON.stringify({ networks: { instagram: true, facebook: true } }),
         creativeSource, o.platforms ?? ["instagram", "facebook"]],
      );
      const orgId = newId();
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [orgId, A, clientId, `mock-org-${n}-${newId().slice(0, 8)}`],
      );
      for (const network of ["instagram", "facebook"]) {
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, postiz_integration_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'connected', '{"igPosts24h":{"used":0,"cap":100}}', $7, 'central')`,
          [newId(), A, clientId, orgId, network, `@mock-${network}-${n}`, `int-${network}-${n}`],
        );
      }
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
         VALUES ($1, $2, $3, '2027-03-01', '2027-02-26', '2027-02-24', 'central')`,
        [cycleId, A, engagementId],
      );
    }, SOCIAL);
    return { clientId, engagementId, cycleId, officer, creativeSource };
  }

  async function row(postId: string) {
    const r = await adminPool().query(`SELECT pipeline_status, schedule_via, author_id::text AS author_id, creative_request_id::text AS creative_request_id FROM social_posts WHERE id = $1`, [postId]);
    return r.rows[0] as { pipeline_status: string | null; schedule_via: string | null; author_id: string | null; creative_request_id: string | null } | undefined;
  }

  async function act(who: Who, postId: string, action: string, body: Record<string, unknown> = {}) {
    const expectedStatus = body.expectedStatus ?? (await row(postId))?.pipeline_status ?? "planned";
    return app.inject({ method: "POST", url: `${base()}/posts/${postId}/actions`, headers: headersFor(who), payload: { action, expectedStatus, ...body } });
  }
  async function ok(res: Awaited<ReturnType<typeof act>>, label: string) {
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${label}: ${res.statusCode} ${res.body}`);
    return res.json() as { post: Record<string, any>; applied?: Record<string, unknown>; alreadyApplied?: boolean; warnings?: string[] };
  }

  async function newPost(eng: Eng, who: Who = eng.officer, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: headersFor(who),
      payload: { title: "Mock bakery: morning pastries", format: "feed", scheduledAt: FUTURE, placement: ["instagram"], ...extra },
    });
    const body = await ok(res, "create");
    return body.post.id as string;
  }

  async function fill(eng: Eng, postId: string, fields: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "PATCH", url: `${base()}/posts/${postId}/pipeline`, headers: headersFor(eng.officer),
      payload: {
        expectedStatus: "drafting",
        fields: {
          caption: "Fresh pastries every morning.", onAssetText: "Open daily", cta: "Visit us", hashtags: ["mockbakery"],
          mustHaves: [...MUST_HAVE_KEYS], rawAssets: [{ url: "https://example.invalid/ref.jpg", label: "Reference", source: "own" }],
          ...fields,
        },
      },
    });
    await ok(res, "fill");
  }

  /** Creatives names the designer on the month request's task (the PM step Creatives takes in its own board). */
  async function assignDesigner(postId: string, designerId: string) {
    const r = await row(postId);
    if (!r?.creative_request_id) throw new Error("no month request on the post");
    await adminPool().query(
      `UPDATE pm_tasks SET assignee = jsonb_set(COALESCE(assignee, '{}'::jsonb), '{responsibleId}', to_jsonb($2::text))
        WHERE id = (SELECT pm_task_id FROM work_requests WHERE id = $1)`,
      [r.creative_request_id, designerId],
    );
  }

  const designerFor = (eng: Eng) => (eng.creativeSource === "in_team" ? U.inTeamDesigner : U.designer);

  /** Drive a post through the real routes to `target`. */
  async function driveTo(eng: Eng, postId: string, target: string, o: { approver?: string; sendAnywayReason?: string; mustHaves?: string[] } = {}) {
    const approver = o.approver ?? U.hod;
    const order = ["planned", "drafting", "proofread", "hod", "design", "final", "client", "approved", "scheduled"];
    const steps: Record<string, () => Promise<void>> = {
      drafting: async () => {
        await ok(await act(eng.officer, postId, "start_draft"), "start_draft");
        await fill(eng, postId, o.mustHaves ? { mustHaves: o.mustHaves } : {});
      },
      proofread: async () => {
        await ok(await act(eng.officer, postId, "send_to_proofread", o.sendAnywayReason ? { sendAnyway: true, sendAnywayReason: o.sendAnywayReason } : {}), "send_to_proofread");
      },
      hod: async () => { await ok(await act(U.copywriter, postId, "approve_copy"), "approve_copy"); },
      design: async () => {
        await ok(await act(approver, postId, "approve_for_design"), "approve_for_design");
        if (eng.creativeSource === "creatives") await assignDesigner(postId, U.designer);
      },
      final: async () => {
        const d = designerFor(eng);
        await ok(await act(d, postId, "start_design"), "start_design");
        const add = await app.inject({ method: "POST", url: `${base()}/posts/${postId}/designs`, headers: headersFor(d), payload: { expectedStatus: "design", assetGroupId: assetId } });
        await ok(add, "add_design");
        await ok(await act(d, postId, "submit_design"), "submit_design");
      },
      client: async () => { await ok(await act(approver, postId, "final_approve"), "final_approve"); },
      approved: async () => { await ok(await act(eng.officer, postId, "record_client_approve", { channel: "whatsapp", note: "Approved on a call." }), "record_client_approve"); },
      scheduled: async () => { await ok(await act(eng.officer, postId, "schedule"), "schedule"); },
    };
    for (const s of order.slice(1, order.indexOf(target) + 1)) await steps[s]();
  }

  // ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    process.env.SOCIAL_POSTIZ_ORG_API_KEY = "mock-key";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Mock Agency", ["social", "pm"]);
    B = await createCompany("Mock Group Co", ["social"], A);
    const units = await seedSocialOrgTree(A);
    // The same node ids in B: its Social Media head is not an approver in A (the tenant trap, §53.4).
    await seedSocialOrgTree(B, units);

    const people = [
      "officer", "otherOfficer", "copywriter", "hod", "gm", "owner", "superadmin", "companyAdmin", "socialManager",
      "webHead", "designer", "otherDesigner", "inTeamDesigner", "bot", "foreignHead",
    ];
    for (const p of people) {
      U[p] = await createUser(`scp1b-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
      await addMembership(A, U[p]);
      // The `member` ROLE at company scope, which every staff member holds: the officer's and the designer's rules are
      // `member` + a relationship (derived_roles.yaml `member`), and a company membership row alone is not that grant.
      await grantSocialRole(A, U[p], "member");
    }
    await addMembership(B, U.foreignHead);
    await grantSocialRole(B, U.foreignHead, "member");
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));

    // The team's read tier (social_staff) for the officers and the copywriter (PERMISSION §53.2 `read`).
    for (const p of ["officer", "otherOfficer", "copywriter", "hod", "gm"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.inTeamDesigner, "social_designer");
    await grantSocialRole(A, U.owner, "owner");
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialRole(A, U.socialManager, "social_manager");
    await grantRole(U.superadmin, await createRole("platform_admin"), "global", null);
    await grantRole(U.webHead, await createRole("manager"), "company", A);
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    await grantSocialSeat(A, units.webDev, U.webHead);
    await grantSocialSeat(B, units.socialMedia, U.foreignHead);
    for (const p of ["officer", "hod", "superadmin"]) await linkIdentity(U[p], "whatsapp", `wa-${p}`, true);

    const asset = async (tenantId: string) => {
      const id = newId();
      await adminPool().query(
        `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
         VALUES ($1, $2, $3, 'Mock design', 'image/jpeg', '{}'::jsonb, $4, 1024, 'central')`,
        [id, tenantId, U.designer, `mock/${id}.jpg`],
      );
      return id;
    };
    assetId = await asset(A);
    foreignAssetId = await asset(B);

    app = await buildApp();
    resetPublishers();
    pub = newMockPublisherState();
  });
  afterAll(async () => {
    resetPublishers();
    await app?.close();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) every post scenario of the fixture
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  const POST_ACTIONS = new Set(SCP.actions.map((a) => a.action));
  const POST_SCENARIOS = SCP.scenarios.filter((s) => !OWNED_ELSEWHERE.has(s.name));

  it("the scenarios split into the post machine's and the two owned elsewhere", () => {
    for (const s of SCP.scenarios) expect(s.steps.every((x) => POST_ACTIONS.has(x.action)), s.name).toBe(!OWNED_ELSEWHERE.has(s.name));
    expect(POST_SCENARIOS.length).toBeGreaterThanOrEqual(18);
  });

  /** The client's decisions, recorded by the officer (the portal forms are SCP-2). */
  const RECORDED: Record<string, string> = { client_approve: "record_client_approve", client_change: "record_client_change" };

  it.each(POST_SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, sc: ScpScenario) => {
    const start = sc.start ?? {};
    const officerPersona = typeof start.officerIs === "string" ? (start.officerIs === "platform_admin" ? "superadmin" : String(start.officerIs)) : "officer";
    const draftingOfficer = start.authorIs === "approver" ? U.hod : U[officerPersona];
    const eng = await freshEngagement({ creativeSource: sc.creativeSource === "in_team" ? "in_team" : "creatives", officer: draftingOfficer });
    const realOfficer = U[officerPersona];
    if (start.publisherRegistered === true) registerPublisher(createMockPublisher(pub));
    else resetPublishers();

    const persona = (actor: string): Who => {
      const m = /^agent_acting_for_(.+)$/.exec(actor);
      if (m) return { obo: `wa-${m[1] === "platform_admin" ? "superadmin" : m[1] === "approver" ? "hod" : m[1]}`, agent: "mock-agent" };
      const map: Record<string, string> = {
        officer: realOfficer, copywriter: U.copywriter, approver: U.hod, second_approver: U.gm, owner: U.owner, platform_admin: U.superadmin,
        company_admin: U.companyAdmin, social_manager: U.socialManager, manager_of_another_department: U.webHead,
        designer: designerFor(eng), request_designer: U.designer, in_team_designer: U.inTeamDesigner, client: realOfficer, automation: U.bot,
      };
      if (!map[actor]) throw new Error(`no persona for ${actor}`);
      return map[actor];
    };

    let postId = "";
    if (start.status !== undefined) {
      postId = await newPost(eng, eng.officer, start.approvedTimeIsPast === true ? { scheduledAt: PAST } : {});
      const status = String(start.status);
      const caseKey = typeof start.changeCase === "string" ? start.changeCase : null;
      const drive = caseKey ? "final" : status;
      await driveTo(eng, postId, drive, {
        ...(start.approvedTimeIsPast === true ? { sendAnywayReason: "The client asked for this date by phone." } : {}),
        ...(Array.isArray(start.failingChecks) && start.failingChecks.includes("must_haves_unticked") ? { mustHaves: MUST_HAVE_KEYS.filter((k) => k !== "logo") } : {}),
      });
      if (caseKey === "final_design") await ok(await act(U.hod, postId, "final_changes", { changeKind: "design", note: "Logo too small." }), "final_changes");
      if (draftingOfficer !== realOfficer) await setEngagementOfficer(A, eng.engagementId, realOfficer);
    }

    for (const [i, step] of sc.steps.entries()) {
      const label = `${sc.name} · step ${i + 1} ${step.action} by ${step.actor}`;
      const action = RECORDED[step.action] ?? step.action;
      const who = persona(step.actor);
      const params = paramsFor(step, action);
      const beforeTold = postId ? await clientToldCount(postId) : 0;
      let res;
      if (action === "create") {
        res = await app.inject({ method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: headersFor(who), payload: { title: "Mock post", format: "feed", scheduledAt: FUTURE, placement: ["instagram"] } });
      } else if (action === "add_design") {
        res = await app.inject({ method: "POST", url: `${base()}/posts/${postId}/designs`, headers: headersFor(who), payload: { expectedStatus: (await row(postId))?.pipeline_status, assetGroupId: assetId } });
      } else if (action === "edit") {
        res = await app.inject({ method: "PATCH", url: `${base()}/posts/${postId}/pipeline`, headers: headersFor(who), payload: { expectedStatus: (await row(postId))?.pipeline_status, ...params } });
      } else {
        res = await act(who, postId, action, { ...params, ...(step.expectedStatus ? { expectedStatus: step.expectedStatus } : {}) });
      }

      if (step.refusal !== undefined) {
        expect(res.json().error, `${label}: ${res.body}`).toBe(step.refusal);
        expect(res.statusCode, label).toBe(SCP.refusals[step.refusal].http);
        if (step.field) expect(res.json().field, label).toBe(step.field);
        continue;
      }
      const body = await ok(res, label);
      if (action === "create") postId = body.post.id;
      if (action === "start_draft") await fill(eng, postId);
      if (action === "approve_for_design" && eng.creativeSource === "creatives") await assignDesigner(postId, U.designer);
      await checkExpect(label, step, body.post, postId, who, beforeTold);
    }
    resetPublishers();
  });

  function paramsFor(step: ScpScenarioStep, action: string): Record<string, unknown> {
    const p: Record<string, unknown> = { ...(step.params ?? {}) };
    if (p.at === "a later date and time") p.at = LATER;
    if (p.at === "a future date and time") p.at = FUTURE;
    if (p.placement === "a different network list") p.placement = ["instagram", "facebook"];
    if (action === "record_client_approve") Object.assign(p, { channel: "whatsapp", note: "Approved on a call." });
    if (action === "record_client_change") Object.assign(p, { channel: "meeting", note: String(p.note ?? "A change, asked in a meeting.") });
    return p;
  }

  async function clientToldCount(postId: string): Promise<number> {
    const r = await adminPool().query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'social.client_review.requested' AND payload->>'postId' = $1`, [postId]);
    return r.rows[0].n as number;
  }

  async function checkExpect(label: string, step: ScpScenarioStep, post: Record<string, any>, postId: string, who: Who, beforeTold: number) {
    for (const [k, v] of Object.entries(step.expect ?? {})) {
      const at = `${label} · ${k}`;
      switch (k) {
        case "status": expect(post.pipelineStatus, at).toBe(v); break;
        case "phase": expect(post.phase, at).toBe(v); break;
        case "engineStatus": expect(post.engineStatus, at).toBe(v); break;
        case "changeCase": expect(post.change?.case ?? null, at).toBe(v); break;
        case "creativeState": expect(post.creativeState, at).toBe(v); break;
        case "changedOnly": expect(post.changedOnly, at).toBe(v); break;
        case "scheduleVia": expect((await row(postId))?.schedule_via ?? null, at).toBe(v); break;
        case "blockedFrom": expect(post.block?.from ?? null, at).toBe(v); break;
        case "skippedChecks": expect(post.skippedChecks.at(-1)?.codes, at).toEqual(v); break;
        case "joinedMonthRequest": expect(post.creativeRequest !== null, at).toBe(v); break;
        case "variantsCreated": expect(post.variants.length > 0 && post.variants.length === post.placement.length, at).toBe(v); break;
        case "scheduledAtIsApproved": expect(post.approvedSchedule?.scheduledAt === post.scheduledAt, at).toBe(v); break;
        case "copyLogged": expect(post.copyLog.length > 0 && post.copyLog.every((e: { via: string }) => e.via === "fix"), at).toBe(v); break;
        case "everyReviewPending": expect(post.variants.length > 0 && post.variants.every((x: { reviewStatus: string }) => x.reviewStatus === "pending"), at).toBe(v); break;
        case "variantsSyncedToPlacement":
          expect([...post.variants.map((x: { network: string }) => x.network)].sort(), at).toEqual([...post.placement].sort());
          break;
        case "publishApprovalsFiled": {
          const r = await adminPool().query(
            `SELECT count(*)::int AS n FROM automation_approvals WHERE tool_name = 'social.publishPost' AND status = 'pending'
                AND tool_args->>'variantId' IN (SELECT id::text FROM social_post_variants WHERE post_id = $1 AND deleted_at IS NULL)`, [postId]);
          expect(r.rows[0].n > 0 && r.rows[0].n === post.variants.length, at).toBe(v);
          break;
        }
        case "notified":
          for (const who2 of v as string[]) {
            if (who2 === "client") expect(await clientToldCount(postId), `${at} client`).toBeGreaterThan(beforeTold);
            else if (who2 === "approvers_told") {
              const r = await adminPool().query(
                `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'social.post.client_changed' AND payload->>'entityId' = $2`, [U.hod, postId]);
              expect(r.rows[0].n, `${at} approvers_told`).toBeGreaterThan(0);
            } else throw new Error(`${at}: unknown notified '${who2}'`);
          }
          break;
        case "activityVia": {
          const r = await adminPool().query(
            `SELECT metadata FROM activities WHERE target_entity_type = 'social_post' AND target_entity_id = $1 AND verb = $2 ORDER BY occurred_at DESC LIMIT 1`, [postId, step.action]);
          expect(r.rows[0]?.metadata?.via?.agent, at).toBe("mock-agent");
          break;
        }
        case "activityActor": {
          const r = await adminPool().query(
            `SELECT actor_id::text AS actor_id FROM activities WHERE target_entity_type = 'social_post' AND target_entity_id = $1 AND verb = $2 ORDER BY occurred_at DESC LIMIT 1`, [postId, step.action]);
          expect(r.rows[0]?.actor_id, at).toBe(typeof who === "string" ? who : undefined);
          break;
        }
        default: throw new Error(`${at}: the HTTP adapter does not read expect.${k}`);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) maker/checker
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("an approver who is the client's officer never approves (the owner too); another of the four does", async () => {
    const eng = await freshEngagement({ officer: U.owner });
    const postId = await newPost(eng);
    await driveTo(eng, postId, "hod");
    const self = await act(U.owner, postId, "approve_for_design");
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe("author_cannot_approve");
    await ok(await act(U.gm, postId, "approve_for_design"), "gm approves");
  });

  it("the post's author never approves, also through the OBO envelope with an agent; the GM does", async () => {
    const eng = await freshEngagement({ officer: U.hod });
    const postId = await newPost(eng, U.hod);
    await driveTo(eng, postId, "hod");
    await setEngagementOfficer(A, eng.engagementId, U.officer);
    expect((await row(postId))?.author_id).toBe(U.hod);
    const viaAgent = await act({ obo: "wa-hod", agent: "mock-agent" }, postId, "approve_for_design");
    expect(viaAgent.statusCode).toBe(403);
    expect(viaAgent.json().error).toBe("author_cannot_approve");
    await ok(await act(U.gm, postId, "approve_for_design"), "gm approves");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) who acts
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("the officer acts only on their own clients' posts", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    const res = await act(U.otherOfficer, postId, "start_draft");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_the_officer");
  });

  it("a Web Dev head with manager, a company admin and a social_manager neither approve nor create; the four do", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "hod");
    for (const who of [U.webHead, U.companyAdmin, U.socialManager, U.foreignHead]) {
      const a = await act(who, postId, "approve_for_design");
      expect(a.statusCode, who).toBe(403);
      expect(a.json().error, who).toBe("not_an_approver");
      const cr = await app.inject({ method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: headersFor(who), payload: { title: "Not theirs" } });
      expect(cr.statusCode, who).toBe(403);
    }
    for (const who of [U.hod, U.gm, U.owner, U.superadmin]) {
      const cr = await app.inject({ method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: headersFor(who), payload: { title: "One of the four" } });
      expect(cr.statusCode, `create as ${who}: ${cr.body}`).toBe(201);
    }
    await ok(await act(U.superadmin, postId, "approve_for_design"), "superadmin approves");
  });

  it("the owner neither blocks nor records a client decision; the HoD does both", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    const block = await act(U.owner, postId, "block", { reason: "Waiting for photos.", waitingOn: "client" });
    expect(block.statusCode).toBe(403);
    expect(block.json().error).toBe("not_officer_or_approver");
    await ok(await act(U.hod, postId, "block", { reason: "Waiting for photos.", waitingOn: "client" }), "hod blocks");
    await ok(await act(U.hod, postId, "resolve"), "hod resolves");
    await driveTo(eng, postId, "client");
    const rec = await act(U.owner, postId, "record_client_approve", { channel: "email", note: "Fine by email." });
    expect(rec.statusCode).toBe(403);
    expect(rec.json().error).toBe("not_officer_or_approver");
    await ok(await act(U.hod, postId, "record_client_approve", { channel: "email", note: "Fine by email." }), "hod records");
  });

  it("a Creatives designer acts only on a post whose request names them; an in-team designer only on in_team posts", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "design");
    for (const who of [U.otherDesigner, U.inTeamDesigner]) {
      const res = await act(who, postId, "start_design");
      expect(res.statusCode, who).toBe(403);
      expect(res.json().error, who).toBe("not_the_designer");
    }
    await ok(await act(U.designer, postId, "start_design"), "the named designer");

    const team = await freshEngagement({ creativeSource: "in_team" });
    const teamPost = await newPost(team);
    await driveTo(team, teamPost, "design");
    expect((await row(teamPost))?.creative_request_id).toBeNull();
    const wrong = await act(U.designer, teamPost, "start_design");
    expect(wrong.json().error).toBe("not_the_designer");
    await ok(await act(U.inTeamDesigner, teamPost, "start_design"), "the in-team designer");
  });

  it("an unattended automation is refused; an agent acting for the officer acts as the officer, recorded as via.agent", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    const bot = await act(U.bot, postId, "start_draft");
    expect(bot.statusCode).toBe(403);
    expect(bot.json().error).toBe("automation_cannot_act");
    await ok(await act({ obo: "wa-officer", agent: "mock-agent" }, postId, "start_draft"), "the officer's agent");
    const a = await adminPool().query(
      `SELECT actor_id::text AS actor_id, metadata FROM activities WHERE target_entity_id = $1 AND verb = 'start_draft'`, [postId]);
    expect(a.rows[0].actor_id).toBe(U.officer);
    expect(a.rows[0].metadata.via.agent).toBe("mock-agent");
    expect((await row(postId))?.author_id).toBe(U.officer);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) the order of checks
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("403 comes before 400 and 409; status_changed; a replayed actionId is alreadyApplied", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "hod");
    // a company admin with a missing note (400 for anyone allowed) and a wrong status (409): 403 first, both times
    const noNote = await act(U.companyAdmin, postId, "hod_changes", {});
    expect(noNote.statusCode).toBe(403);
    expect(noNote.json().error).toBe("not_an_approver");
    const wrongStatus = await act(U.companyAdmin, postId, "final_approve");
    expect(wrongStatus.statusCode).toBe(403);
    // the HoD without the note: 400 with the field
    const bad = await act(U.hod, postId, "hod_changes", {});
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "missing_field", field: "note" });
    // a stale expectedStatus
    const stale = await act(U.hod, postId, "approve_for_design", { expectedStatus: "proofread" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "status_changed", detail: { status: "hod", phase: "in_production" } });
    // the wrong status
    const wrong = await act(U.hod, postId, "final_approve");
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: "invalid_transition", detail: { status: "hod" } });
    // a replayed actionId answers alreadyApplied and changes nothing
    const actionId = newId();
    const first = await ok(await act(U.hod, postId, "approve_for_design", { actionId }), "first");
    expect(first.post.pipelineStatus).toBe("design");
    const again = await act(U.hod, postId, "approve_for_design", { actionId, expectedStatus: "hod" });
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyApplied).toBe(true);
    expect((await row(postId))?.pipeline_status).toBe("design");
    // an unknown action, and an action with a route of its own, are 400 unknown_action
    expect((await act(U.hod, postId, "teleport")).json().error).toBe("unknown_action");
    expect((await act(U.officer, postId, "edit")).json().error).toBe("unknown_action");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) final_approve
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("final_approve gives one variant per placed network and one pending review each", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng, eng.officer, { placement: ["instagram", "facebook"] });
    await driveTo(eng, postId, "client");
    const v = await adminPool().query(
      `SELECT a.network, v.media, r.status AS review FROM social_post_variants v JOIN social_accounts a ON a.id = v.account_id
         LEFT JOIN social_post_client_reviews r ON r.variant_id = v.id WHERE v.post_id = $1 AND v.deleted_at IS NULL ORDER BY a.network`, [postId]);
    expect(v.rows.map((r) => [r.network, r.review])).toEqual([["facebook", "pending"], ["instagram", "pending"]]);
    // the design was materialized once as a file targeting the post, and is the variants' media
    const files = await adminPool().query(`SELECT id::text AS id FROM files WHERE target_entity_type = 'social_post' AND target_entity_id = $1`, [postId]);
    expect(files.rows).toHaveLength(1);
    for (const r of v.rows) expect(r.media[0].fileId).toBe(files.rows[0].id);
    const told = await clientToldCount(postId);
    expect(told).toBe(1);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) SCP-Q13: the client approves the content, the date, the time and the placement
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("schedule keeps the approved date; reschedule sends it back with every review pending", async () => {
    const eng = await freshEngagement();
    // Instagram only: Facebook's native schedule window (10 minutes to 30 days, media-rules.ts) refuses a date this far out.
    const postId = await newPost(eng);
    await driveTo(eng, postId, "scheduled");
    const v = await adminPool().query(`SELECT scheduled_at FROM social_post_variants WHERE post_id = $1 AND deleted_at IS NULL`, [postId]);
    for (const r of v.rows) expect(new Date(r.scheduled_at).toISOString()).toBe(FUTURE);
    const back = await ok(await act(eng.officer, postId, "reschedule", { at: LATER }), "reschedule");
    expect(back.post.pipelineStatus).toBe("client");
    expect(back.post.scheduledAt).toBe(LATER);
    expect(back.post.variants.every((x: { reviewStatus: string }) => x.reviewStatus === "pending")).toBe(true);
    expect((await row(postId))?.schedule_via).toBeNull();
  });

  it("a publisher schedule: the officer cannot reschedule it (cancel); one of the four unschedules it, cancelling the queued dispatch first", async () => {
    registerPublisher(createMockPublisher(pub));
    try {
      const eng = await freshEngagement();
      const postId = await newPost(eng);
      await driveTo(eng, postId, "approved");
      await ok(await act(U.hod, postId, "schedule_publisher"), "schedule_publisher");
      // The decided approval was dispatched: the variant is queued at the publisher.
      const variant = await adminPool().query(`SELECT id::text AS id FROM social_post_variants WHERE post_id = $1 AND deleted_at IS NULL`, [postId]);
      const approval = await adminPool().query(`SELECT id FROM automation_approvals WHERE tool_args->>'variantId' = $1`, [variant.rows[0].id]);
      await adminPool().query(
        `UPDATE automation_approvals SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [approval.rows[0].id, U.gm]);
      await adminPool().query(
        `UPDATE social_post_variants SET status = 'queued', approval_id = $2, provider_post_id = 'mock-provider-1' WHERE id = $1`,
        [variant.rows[0].id, approval.rows[0].id]);
      const re = await act(eng.officer, postId, "reschedule", { at: LATER });
      expect(re.statusCode).toBe(403);
      expect(re.json().error).toBe("cancel_required");
      const offByOfficer = await act(eng.officer, postId, "unschedule");
      expect(offByOfficer.json().error).toBe("not_an_approver");
      const calls = pub.calls.length;
      const off = await ok(await act(U.gm, postId, "unschedule"), "unschedule");
      expect(off.post.pipelineStatus).toBe("approved");
      expect(pub.calls.slice(calls).map((x) => x.op)).toContain("cancelPost");
      const after = await adminPool().query(`SELECT status, approval_id FROM social_post_variants WHERE id = $1`, [variant.rows[0].id]);
      expect(after.rows[0]).toMatchObject({ status: "draft", approval_id: null });
      await ok(await act(eng.officer, postId, "reschedule", { at: LATER }), "reschedule after unschedule");
    } finally {
      resetPublishers();
    }
  });

  it("a Composer caption edit on an approved pipeline post sends it back to the client", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "approved");
    const variant = await adminPool().query(`SELECT id::text AS id FROM social_post_variants WHERE post_id = $1 AND deleted_at IS NULL`, [postId]);
    const before = await clientToldCount(postId);
    const res = await app.inject({
      method: "PATCH", url: `${base()}/variants/${variant.rows[0].id}`, headers: headersFor(U.socialManager), payload: { body: "A new caption." },
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = await row(postId);
    expect(r?.pipeline_status).toBe("client");
    const review = await adminPool().query(`SELECT status FROM social_post_client_reviews WHERE variant_id = $1`, [variant.rows[0].id]);
    expect(review.rows[0].status).toBe("pending");
    expect(await clientToldCount(postId)).toBe(before + 1);
    const act2 = await adminPool().query(`SELECT 1 FROM activities WHERE target_entity_id = $1 AND verb = 'changed_after_client'`, [postId]);
    expect(act2.rowCount).toBe(1);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (7) the other routes
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("designs: another company's asset is 404; a link needs its source, an AI link its note; remove and patch", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "design");
    const url = `${base()}/posts/${postId}/designs`;
    const foreign = await app.inject({ method: "POST", url, headers: headersFor(U.designer), payload: { expectedStatus: "design", assetGroupId: foreignAssetId } });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe("asset_not_found");
    const noNote = await app.inject({ method: "POST", url, headers: headersFor(U.designer), payload: { expectedStatus: "design", linkUrl: "https://example.invalid/d.png", linkSource: "ai" } });
    expect(noNote.json()).toMatchObject({ error: "missing_field", field: "linkAiNote" });
    const link = await app.inject({ method: "POST", url, headers: headersFor(U.designer), payload: { expectedStatus: "design", linkUrl: "https://example.invalid/d.png", linkSource: "unknown" } });
    expect(link.statusCode, link.body).toBe(201);
    const designId = link.json().designId as string;
    const patch = await app.inject({ method: "PATCH", url: `${url}/${designId}`, headers: headersFor(U.designer), payload: { linkSource: "client" } });
    expect(patch.statusCode, patch.body).toBe(200);
    const outsider = await app.inject({ method: "DELETE", url: `${url}/${designId}`, headers: headersFor(U.inTeamDesigner) });
    expect(outsider.json().error).toBe("not_the_designer");
    const del = await app.inject({ method: "DELETE", url: `${url}/${designId}`, headers: headersFor(U.designer) });
    expect(del.statusCode, del.body).toBe(200);
    // submit with no design left: design_missing
    const submit = await act(U.designer, postId, "submit_design");
    expect(submit.json().error).toBe("design_missing");
  });

  it("suggestions: the copywriter suggests in proofread; approve_copy applies and logs it; a stale one refuses", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "proofread");
    const url = `${base()}/posts/${postId}/suggestions`;
    const notField = await app.inject({ method: "PUT", url: `${url}/title`, headers: headersFor(U.copywriter), payload: { expectedStatus: "proofread", value: "x" } });
    expect(notField.json()).toMatchObject({ error: "invalid_field", field: "field" });
    const byOfficer = await app.inject({ method: "PUT", url: `${url}/caption`, headers: headersFor(U.officer), payload: { expectedStatus: "proofread", value: "x" } });
    expect(byOfficer.json().error).toBe("author_cannot_approve");
    const put = await app.inject({ method: "PUT", url: `${url}/caption`, headers: headersFor(U.copywriter), payload: { expectedStatus: "proofread", value: "Fresh pastries, every single morning." } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().post.suggestions.caption).toMatchObject({ value: "Fresh pastries, every single morning.", stale: false });
    const done = await ok(await act(U.copywriter, postId, "approve_copy"), "approve_copy");
    expect(done.post.caption).toBe("Fresh pastries, every single morning.");
    expect(done.post.copyLog.map((e: { field: string; via: string }) => [e.field, e.via])).toEqual([["caption", "suggestion"]]);
  });

  it("send anyway records the skipped checks with the reason; the read shows the checks", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "drafting", { mustHaves: ["logo"] });
    const read = await app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: headersFor(U.officer) });
    const checks = read.json().checks as Array<{ code: string; ok: boolean; skippable: boolean }>;
    expect(checks.find((c) => c.code === "must_haves_unticked")).toMatchObject({ ok: false, skippable: true });
    expect(read.json().actions.find((a: { action: string }) => a.action === "send_to_proofread")).toMatchObject({ allowed: true });
    const refused = await act(U.officer, postId, "send_to_proofread");
    expect(refused.json()).toMatchObject({ error: "checks_failed", blockers: [{ code: "must_haves_unticked" }] });
    const sent = await ok(await act(U.officer, postId, "send_to_proofread", { sendAnyway: true, sendAnywayReason: "The client confirmed the logo by phone." }), "send anyway");
    expect(sent.post.skippedChecks).toEqual([expect.objectContaining({ codes: ["must_haves_unticked"], reason: "The client confirmed the logo by phone." })]);
  });

  it("the read: 404 for an unknown post, 409 for a Composer post, 403 for a caller with neither read nor design", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    const missing = await app.inject({ method: "GET", url: `${base()}/posts/${newId()}/pipeline`, headers: headersFor(U.officer) });
    expect(missing.statusCode).toBe(404);
    const composerId = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site) VALUES ($1, $2, $3, 'Composer post', 'central')`,
      [composerId, A, eng.engagementId]), SOCIAL);
    const composer = await app.inject({ method: "GET", url: `${base()}/posts/${composerId}/pipeline`, headers: headersFor(U.officer) });
    expect(composer.json().error).toBe("not_a_pipeline_post");
    const designerRead = await app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: headersFor(U.otherDesigner) });
    expect(designerRead.statusCode).toBe(403);
    const ownRead = await app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: headersFor(U.officer) });
    expect(ownRead.statusCode).toBe(200);
    expect(ownRead.json()).toMatchObject({ pipelineStatus: "planned", phase: "brief", health: null, boost: null, tasks: [], nextAction: "start_draft" });
    expect(composer.statusCode).toBe(409);
  });

  it("bulk: each item on its own; one refusal never undoes another", async () => {
    const eng = await freshEngagement();
    const good = await newPost(eng);
    const unready = await newPost(eng);
    await driveTo(eng, good, "drafting");
    await ok(await act(eng.officer, unready, "start_draft"), "start_draft");
    const res = await app.inject({
      method: "POST", url: `${base()}/posts/actions`, headers: headersFor(eng.officer),
      payload: { action: "send_to_proofread", items: [{ postId: good, expectedStatus: "drafting" }, { postId: unready, expectedStatus: "drafting" }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [a, b] = res.json().results;
    expect(a).toMatchObject({ postId: good, ok: true });
    expect(b).toMatchObject({ postId: unready, ok: false, error: "incomplete_post" });
    expect((await row(good))?.pipeline_status).toBe("proofread");
    expect((await row(unready))?.pipeline_status).toBe("drafting");
    const notBulk = await app.inject({ method: "POST", url: `${base()}/posts/actions`, headers: headersFor(eng.officer), payload: { action: "final_approve", items: [{ postId: good }] } });
    expect(notBulk.json()).toMatchObject({ error: "invalid_field", field: "action" });
  });

  it("archive withdraws the pending reviews; discard soft-deletes a planned post", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "client");
    await ok(await act(U.officer, postId, "archive", { reason: "The client cancelled the campaign." }), "archive");
    const reviews = await adminPool().query(
      `SELECT r.status FROM social_post_client_reviews r JOIN social_post_variants v ON v.id = r.variant_id WHERE v.post_id = $1`, [postId]);
    expect(reviews.rows.every((r) => r.status === "withdrawn")).toBe(true);
    const again = await act(U.officer, postId, "block", { reason: "Too late.", waitingOn: "client", expectedStatus: "client" });
    expect(again.json().error).toBe("post_archived");

    const planned = await newPost(eng);
    const res = await act(U.officer, planned, "discard");
    expect(res.statusCode).toBe(200);
    expect(res.json().post).toBeNull();
    const del = await adminPool().query(`SELECT deleted_at FROM social_posts WHERE id = $1`, [planned]);
    expect(del.rows[0].deleted_at).not.toBeNull();
  });

  it("follow_up tells the holder once per day", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveTo(eng, postId, "proofread");
    await ok(await act(U.officer, postId, "follow_up", { note: "Any news?" }), "follow_up");
    const told = await adminPool().query(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'social.post.follow_up' AND payload->>'entityId' = $2`, [U.copywriter, postId]);
    expect(told.rows[0].n).toBe(1);
    const soon = await act(U.officer, postId, "follow_up");
    expect(soon.statusCode).toBe(409);
    expect(soon.json().error).toBe("follow_up_too_soon");
    expect(soon.json().retryAfterSeconds).toBeGreaterThan(0);
  });
});
