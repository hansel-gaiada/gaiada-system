// OWNER DECISION 2026-08-18 — a plain `member` may create and update clients, but NOT delete them.
//
// The defect this pins, and how it was found: preparing the sensitivity-flag review surfaced
// `core.client.delete` inside the BASELINE `member` bundle. `resource_client.yaml` carried a SECOND
// rule for `create/update/delete` naming `member`, gated on nothing but `inTenant && notLow` — no
// `owns`, no ownership attribute — and `clients.controller.ts:80` authorizes
// `{kind:"client", id, tenantId}` with nothing that could narrow it. A live probe with a principal
// whose ONLY grant was `member @ company` returned EFFECT_ALLOW on all three. Every staff member
// could remove any client in their company; soft-delete and audited, so recoverable, but real.
//
// ⚠ Probed against RUNNING Cerbos, not asserted from the YAML or from a bundle. The bundle is what
// mis-reported this in the first place (it records what a rule NAMES, and treats resource-instance
// conditions as satisfied), so a bundle-level assertion here would be the same instrument that hid
// the problem. Skips without CERBOS_URL, same convention as the other live-probe suites.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal } from "./principal";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const TENANT = "11111111-1111-4111-8111-111111111111";

/** A synthetic principal carrying exactly ONE role grant, so nothing else can be what answers. */
function principalWith(role: string): Principal {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    assurance: "high",
    companies: [TENANT],
    roles: [{ role, scopeType: "company", scopeId: TENANT }],
    perms: [],
    sessionVersion: 1,
  } as unknown as Principal;
}

const client: Resource = { kind: "client", id: "33333333-3333-4333-8333-333333333333", tenantId: TENANT };

describe.skipIf(!live)("client · member reach (owner decision 2026-08-18)", () => {
  it("member may CREATE a client", async () => {
    expect((await check(principalWith("member"), client, "create")).allow).toBe(true);
  });

  it("member may UPDATE a client", async () => {
    expect((await check(principalWith("member"), client, "update")).allow).toBe(true);
  });

  it("🔴 member may NOT DELETE a client — the fix", async () => {
    expect((await check(principalWith("member"), client, "delete")).allow).toBe(false);
  });

  it("viewer may not delete either (it never could — control case)", async () => {
    expect((await check(principalWith("viewer"), client, "delete")).allow).toBe(false);
  });

  it("manager and company_admin CAN still delete — the fix did not over-correct", async () => {
    // The whole risk of a narrowing edit is taking the capability away from the tier that needs it.
    expect((await check(principalWith("manager"), client, "delete")).allow).toBe(true);
    expect((await check(principalWith("company_admin"), client, "delete")).allow).toBe(true);
  });
});

describe.skipIf(!live)("position · assign reach (owner decision 2026-08-18 — HR runs JML)", () => {
  const position: Resource = {
    kind: "position",
    id: "44444444-4444-4444-8444-444444444444",
    tenantId: TENANT,
    targetUserId: "55555555-5555-4555-8555-555555555555", // NOT the caller: the self-assign DENY must not fire
    unitAncestors: [],
  };

  it("🟢 hr_manager may now ASSIGN and UNASSIGN — this was 403 before the decision", async () => {
    expect((await check(principalWith("hr_manager"), position, "assign")).allow).toBe(true);
    expect((await check(principalWith("hr_manager"), position, "unassign")).allow).toBe(true);
  });

  it("hr_staff may NOT — `hr_people_ops` is the ACTING tier (hr_manager only)", async () => {
    expect((await check(principalWith("hr_staff"), position, "assign")).allow).toBe(false);
    expect((await check(principalWith("hr_staff"), position, "unassign")).allow).toBe(false);
  });

  it("a plain member still may not assign anyone to a seat", async () => {
    expect((await check(principalWith("member"), position, "assign")).allow).toBe(false);
  });

  it("the self-assign DENY still beats hr_manager's new reach", async () => {
    // deny-overrides: the structural DENY must survive a widened ALLOW, or the widening quietly
    // reopened D-9's no-self-escalation on this surface.
    const p = principalWith("hr_manager");
    const selfTarget: Resource = { ...position, targetUserId: p.userId! };
    expect((await check(p, selfTarget, "assign")).allow).toBe(false);
  });
});
