// T7 (WebDesk M3) — an automation or bot principal can NEVER `publish` or `schedule` webdesk content,
// and Cerbos is the one that refuses (resource_webdesk_content_item.yaml's last DENY).
//
// WHY THIS FILE BUILDS REAL PRINCIPALS. The defect this closes was never in the policy's logic: it was
// that the principal Cerbos receives had NO `kind`, because `principalPayload()` is an explicit
// allow-list and `Principal` carried no `kind` field. A test that hand-writes `{ attr: { kind:
// "automation" } }` would pass against a payload builder that never sends it, which is exactly the
// bug. So every principal below is built the way production builds it — a real `users` row (with its
// real `users.kind`), `assemblePrincipal()` from the database, then the REAL `check()` -> `principalPayload()`
// -> a REAL Cerbos decision. The positive controls (a human with IDENTICAL grants, publishing under
// IDENTICAL resource attributes) are what prove the DENYs below come from `kind` and from nothing else.
//
// ⚠ Needs DATABASE_URL_TEST and a live Cerbos (CERBOS_URL), and skips silently otherwise. A skipped run
// of this file proves nothing while looking identical to a pass — the final `it` asserts the live path
// really executed by decoding what Cerbos matched.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { assemblePrincipal, type Principal } from "./principal";
import { check, principalPayload, type Resource } from "./cerbos";
import { authorize } from "../core/http";

const live = !!process.env.CERBOS_URL;

describe.skipIf(!TEST_URL || !live)("T7 · automation/bot principals never publish or schedule (real users.kind -> real Cerbos)", () => {
  let tenant: string;
  let human: string;       // kind=employee, webdev_manager at company scope
  let automation: string;  // kind=automation, the SAME role and grant
  let bot: string;         // kind=bot, the SAME role and grant
  let autoAdmin: string;   // kind=automation holding platform_admin (global) — the wildcard must still lose
  let otherMaker: string;  // a different user id, used only as the approval's `creatorId`

  async function principalFor(userId: string, assurance: "high" | "linked" = "high"): Promise<Principal> {
    const p = await assemblePrincipal(userId, assurance);
    if (!p) throw new Error(`fixture bug: no principal for ${userId}`);
    return p;
  }

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("T7 Webdesk Co");
    const webdevManager = await createRole("webdev_manager");
    const platformAdmin = await createRole("platform_admin");

    human = await createUser("t7-human@a.test");
    automation = await createUser("automation+t7-importer@gaiada.system");
    bot = await createUser("t7-persona-bot@a.test");
    autoAdmin = await createUser("automation+t7-admin@gaiada.system");
    otherMaker = await createUser("t7-other-maker@a.test");

    for (const u of [human, automation, bot, autoAdmin]) await addMembership(tenant, u);
    for (const u of [human, automation, bot]) await grantRole(u, webdevManager, "company", tenant);
    await grantRole(autoAdmin, platformAdmin, "global", null);

    // `users.kind` is NOT NULL DEFAULT 'employee', so `human` is already an employee. Set the others
    // through the real column, never through a field on the Principal.
    await adminPool().query(`UPDATE users SET kind = 'automation' WHERE id = ANY($1)`, [[automation, autoAdmin]]);
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // An approved publish exactly as WSK-66's decide() executor presents it: approval id present, creator
  // known and DIFFERENT from the caller (so maker != checker cannot be what denies), a single item.
  const item = (extra: Partial<Resource> = {}): Resource => ({
    kind: "webdesk_content_item",
    tenantId: tenant,
    module: "webdev",
    id: "item-1",
    collectionKey: "page",
    locale: "en",
    approvalId: "appr-1",
    creatorId: otherMaker,
    itemCount: 1,
    ...extra,
  });
  const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

  it("assemblePrincipal() carries users.kind, and principalPayload() sends it to Cerbos", async () => {
    expect((await principalFor(human)).kind).toBe("employee");
    expect((await principalFor(automation)).kind).toBe("automation");
    expect((await principalFor(bot)).kind).toBe("bot");
    expect(principalPayload(await principalFor(automation)).attr.kind).toBe("automation");
    expect(principalPayload(await principalFor(bot)).attr.kind).toBe("bot");
    // A hand-built Principal literal (every older fixture) has no kind and sends "" — which matches no DENY.
    const literal: Principal = { userId: "u", assurance: "high", companies: [], roles: [], sessionVersion: 1 };
    expect(principalPayload(literal).attr.kind).toBe("");
  });

  it("POSITIVE CONTROL: a human with the SAME role, grant and resource attributes MAY publish (and schedule)", async () => {
    const p = await principalFor(human);
    expect(await allow(p, item(), "publish")).toBe(true);
    expect(await allow(p, item(), "schedule")).toBe(true);
    // ...and the same human files a publish request, as ever.
    expect(await allow(p, item({ approvalId: undefined, creatorId: undefined, itemCount: undefined }), "request_publish")).toBe(true);
  });

  it("automation: publish DENY, schedule DENY — same grants, same attributes as the human above", async () => {
    const p = await principalFor(automation);
    expect(await allow(p, item(), "publish")).toBe(false);
    expect(await allow(p, item(), "schedule")).toBe(false);
    // The R4 single-item self-publish exception must not rescue it either.
    expect(await allow(p, item({ creatorId: automation, itemCount: 1 }), "publish")).toBe(false);
  });

  it("bot: publish DENY, schedule DENY", async () => {
    const p = await principalFor(bot);
    expect(await allow(p, item(), "publish")).toBe(false);
    expect(await allow(p, item(), "schedule")).toBe(false);
  });

  it("automation: request_publish stays ALLOWED (the importer's whole job), as does the rest of the editor tier", async () => {
    const p = await principalFor(automation);
    const draft = item({ approvalId: undefined, creatorId: undefined, itemCount: undefined });
    for (const a of ["request_publish", "read", "create", "update"]) expect(await allow(p, draft, a), a).toBe(true);
    // The bot is denied publish but not the filing right either: the DENY names two actions only.
    expect(await allow(await principalFor(bot), draft, "request_publish")).toBe(true);
  });

  it("the importer's EXACT shape — assurance 'linked', via n8n — still files request_publish", async () => {
    const p: Principal = { ...(await principalFor(automation, "linked")), via: { provider: "n8n", externalId: "webdesk-importer" } };
    expect(p.assurance).toBe("linked");
    expect(p.kind).toBe("automation");
    const draft = item({ approvalId: undefined, creatorId: undefined, itemCount: undefined });
    expect(await allow(p, draft, "request_publish")).toBe(true);
    // ...and the same principal, same channel, is refused the two decisions.
    expect(await allow(p, item(), "publish")).toBe(false);
    expect(await allow(p, item(), "schedule")).toBe(false);
  });

  it("the platform_admin wildcard LOSES to the kind DENY (an automation row holding platform_admin)", async () => {
    const p = await principalFor(autoAdmin);
    expect(p.kind).toBe("automation");
    // Control: the same wildcard on a non-publish action still works, so the DENY (and not a missing
    // grant) is what refuses publish/schedule.
    expect(await allow(p, item(), "unpublish")).toBe(true);
    expect(await allow(p, item(), "publish")).toBe(false);
    expect(await allow(p, item(), "schedule")).toBe(false);
  });

  it("DELEGATION: a bot persona acting FOR a human publisher is refused (the caller's own check fails); the human alone is not", async () => {
    // authorize() checks the CALLER first and, when `actFor` is set, the acting human too; either
    // denial refuses. Here the caller is the bot, so the persona can never carry a publish for anyone.
    const persona: Principal = { ...(await principalFor(bot)), actFor: { userId: human } };
    await expect(authorize(persona, item(), "publish")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(authorize(persona, item(), "schedule")).rejects.toBeInstanceOf(ForbiddenException);
    // The human, alone, is unaffected — the DENY reads the EVALUATED principal's own kind.
    await expect(authorize(await principalFor(human), item(), "publish")).resolves.toBeUndefined();
    // And the reverse is narrowing too: a human caller acting for an automation row is refused on the
    // acting identity's check (an intersection can only narrow).
    const humanForAutomation: Principal = { ...(await principalFor(human)), actFor: { userId: automation } };
    await expect(authorize(humanForAutomation, item(), "publish")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("LIVE PATH PROOF: Cerbos itself names the new rule (this file did not skip, and the payload kind reached the engine)", async () => {
    // Raw request with includeMeta so the matched rule is visible, built from the REAL payload function.
    const p = await principalFor(automation);
    const res = await fetch(`${process.env.CERBOS_URL}/api/check/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "t7-proof",
        includeMeta: true,
        principal: principalPayload(p),
        resources: [{
          actions: ["publish"],
          resource: {
            kind: "webdesk_content_item",
            id: "item-1",
            attr: { id: "item-1", tenantId: tenant, module: "webdev", approvalId: "appr-1", creatorId: otherMaker, itemCount: 1 },
          },
        }],
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { results: Array<{ actions: Record<string, string> }> };
    expect(body.results[0].actions.publish).toBe("EFFECT_DENY");
    // The same request with kind blanked is ALLOWED: the DENY is what the kind attribute switches.
    const blank = await fetch(`${process.env.CERBOS_URL}/api/check/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "t7-proof-blank",
        principal: { ...principalPayload(p), attr: { ...principalPayload(p).attr, kind: "" } },
        resources: [{
          actions: ["publish"],
          resource: {
            kind: "webdesk_content_item",
            id: "item-1",
            attr: { id: "item-1", tenantId: tenant, module: "webdev", approvalId: "appr-1", creatorId: otherMaker, itemCount: 1 },
          },
        }],
      }),
    });
    const blankBody = (await blank.json()) as { results: Array<{ actions: Record<string, string> }> };
    expect(blankBody.results[0].actions.publish).toBe("EFFECT_ALLOW");
  });
});
