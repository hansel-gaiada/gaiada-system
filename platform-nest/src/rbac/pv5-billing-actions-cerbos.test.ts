// PV5-02 — who may `issue` / `void_issued` an `invoice`, `set_bank_details` on `finance_config`, and
// `mark_certified` a `contract`, checked directly against a LIVE Cerbos, no DB or app. Same direct-check
// pattern as contract-countersign-cerbos.test.ts (PV3-01), whose owner-only shape `set_bank_details` copies.
// Needs CERBOS_URL (skips otherwise) and a Cerbos restarted after the policy change: a stale policy denies
// every allowed case and reads exactly like a logic bug.
//
// WHAT EACH BLOCK PINS, per action: a member is denied; a bot and an automation principal are denied for
// EVERY grant, platform_admin included (the T7 `roles: ["user"]` DENY beats the wildcard); the right roles are
// allowed; and a DELEGATED call (a bot acting for a human who holds the right) is still denied, because the
// caller is checked first.
//
// The delegated check is modelled, not driven through `authorize()`: authorize() writes an audit row on a
// denial, which needs the database. `delegated()` below repeats its two-step exactly (caller, then the acting
// human with the caller's channel), so the property under test is the same: either denial refuses.
//
// `mark_certified` has NO bot DENY by design (PV5-02 spec); it is therefore not asserted either way here.
//
// PV-D29 (2026-10-13) relaxed the `set_bank_details` DENY, temporarily, for an owner or finance_manager of the tenant;
// PV-D40 (2026-10-13, PV5-14) LIFTED that relaxation: PV-D26 applies in full again, met on the dev stage by the
// simulated second factor (src/auth/step-up.ts), which reaches Cerbos as `assurance: "high"`.
// PV-D26 (owner ruling, 2026-10-12): the PV-D26 describe pins the high-assurance DENY on `set_bank_details` and on
// `vendor_master` (finance_ap), which applies to platform_admin too. Every other test here runs at high assurance
// (the `principal()` default), so none of them is affected by it.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant, PrincipalKind } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "dddddddd-5020-0000-0000-000000000001"; // the resource's company
const T2 = "dddddddd-5020-0000-0000-000000000002"; // another company in the same root
const USER = "11111111-5020-0000-0000-000000000001";
const HUMAN = "11111111-5020-0000-0000-000000000002"; // the human a bot acts for

function principal(
  roles: RoleGrant[],
  opts: {
    perms?: PermissionGrant[];
    companies?: string[];
    assurance?: Principal["assurance"];
    kind?: PrincipalKind;
    userId?: string;
  } = {},
): Principal {
  const companies = opts.companies ?? [T1, T2];
  return {
    userId: opts.userId ?? USER,
    assurance: opts.assurance ?? "high",
    companies,
    rootCompanies: companies,
    roles,
    perms: opts.perms ?? [],
    sessionVersion: 1,
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
}
const co = (role: string, scopeId: string = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
const key = (k: string, scopeId: string = T1): PermissionGrant => ({ key: k, scopeType: "company", scopeId });

const invoice = (tenantId: string = T1, extra: Partial<Resource> = {}): Resource => ({ kind: "invoice", id: "inv-1", tenantId, ...extra });
const contract = (tenantId: string = T1): Resource => ({ kind: "contract", id: "k-1", tenantId });
const financeConfig = (tenantId: string = T1): Resource => ({ kind: "finance_config", tenantId, module: "finance" });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

/** `authorize()`'s delegation rule (rbac/../core/http.ts): the caller must be allowed AND the acting human
 *  must independently be allowed, the human checked WITHOUT actFor. Both must allow. */
async function delegated(caller: Principal, human: Principal, r: Resource, a: string): Promise<boolean> {
  const c = await check({ ...caller, actFor: { userId: human.userId ?? HUMAN } }, r, a);
  if (!c.allow) return false;
  return (await check({ ...human, via: caller.via }, r, a)).allow;
}

const BOT_KINDS: PrincipalKind[] = ["bot", "automation"];

describe.skipIf(!live)("PV5-02 · invoice `issue` (live Cerbos)", () => {
  const A = "issue";

  it("company_admin and manager of the invoice's company issue", async () => {
    expect(await allow(principal([co("company_admin")]), invoice(), A)).toBe(true);
    expect(await allow(principal([co("manager")]), invoice(), A)).toBe(true);
  });

  it("platform_admin issues (the wildcard)", async () => {
    expect(await allow(principal([glob("platform_admin")], { companies: [] }), invoice(), A)).toBe(true);
  });

  it("an owner reaches it through the permission arm (the key in its bundle)", async () => {
    expect(await allow(principal([co("owner")], { perms: [key("invoice.issue")] }), invoice(), A)).toBe(true);
    // ...and a bare owner grant with no key reaches nothing: owner has no role rules.
    expect(await allow(principal([co("owner")]), invoice(), A)).toBe(false);
  });

  it("NOT maker/checker-bound: the invoice's own creator may issue it", async () => {
    const p = principal([co("company_admin")]);
    expect(await allow(p, invoice(T1, { creatorId: USER }), "approve")).toBe(false); // the control: approve IS bound
    expect(await allow(p, invoice(T1, { creatorId: USER }), A)).toBe(true);
  });

  it("🔴 a member and a viewer are denied", async () => {
    for (const role of ["member", "viewer"]) {
      expect(await allow(principal([co(role)]), invoice(), A), role).toBe(false);
    }
  });

  it("🔴 a company_admin of ANOTHER company, or one on a low-assurance session, is denied", async () => {
    expect(await allow(principal([co("company_admin", T2)], { companies: [T2] }), invoice(), A)).toBe(false);
    expect(await allow(principal([co("company_admin")], { assurance: "low" }), invoice(), A)).toBe(false);
  });

  it("a custom role holding the key reaches it (the mirror); one holding every other invoice key does not", async () => {
    expect(await allow(principal([co("pv502_custom")], { perms: [key("invoice.issue")] }), invoice(), A)).toBe(true);
    const others = ["read", "create", "update", "delete"].map((a) => key(`invoice.${a}`));
    expect(await allow(principal([co("pv502_custom")], { perms: others }), invoice(), A)).toBe(false);
  });

  for (const kind of BOT_KINDS) {
    it(`🔴 a ${kind} is denied for every grant, platform_admin and the permission arm included`, async () => {
      expect(await allow(principal([co("company_admin")], { kind }), invoice(), A)).toBe(false);
      expect(await allow(principal([co("manager")], { kind }), invoice(), A)).toBe(false);
      expect(await allow(principal([glob("platform_admin")], { kind, companies: [] }), invoice(), A)).toBe(false);
      expect(await allow(principal([co("pv502_custom")], { kind, perms: [key("invoice.issue")] }), invoice(), A)).toBe(false);
    });
  }

  it("🔴 a delegated call is denied: a bot acting for a company_admin who may issue", async () => {
    const human = principal([co("company_admin")], { userId: HUMAN });
    const bot = principal([co("company_admin")], { kind: "bot" });
    expect(await allow(human, invoice(), A), "control: the human alone may").toBe(true);
    expect(await delegated(bot, human, invoice(), A)).toBe(false);
    // Even a bot that holds NOTHING itself cannot borrow the human's right.
    expect(await delegated(principal([], { kind: "bot" }), human, invoice(), A)).toBe(false);
  });

  it("the DENY names issue and void_issued only: a bot keeps every other invoice right it had", async () => {
    const bot = principal([co("company_admin")], { kind: "bot" });
    for (const a of ["read", "create", "update", "delete"]) expect(await allow(bot, invoice(), a), a).toBe(true);
  });
});

describe.skipIf(!live)("PV5-02 · invoice `void_issued` (live Cerbos)", () => {
  const A = "void_issued";

  it("company_admin of the invoice's company voids an issued invoice", async () => {
    expect(await allow(principal([co("company_admin")]), invoice(), A)).toBe(true);
  });

  it("platform_admin voids (the wildcard)", async () => {
    expect(await allow(principal([glob("platform_admin")], { companies: [] }), invoice(), A)).toBe(true);
  });

  it("an owner reaches it through the permission arm (the key in its bundle)", async () => {
    expect(await allow(principal([co("owner")], { perms: [key("invoice.void_issued")] }), invoice(), A)).toBe(true);
    expect(await allow(principal([co("owner")]), invoice(), A)).toBe(false);
  });

  it("🔴 a manager may issue but may NOT void an issued invoice", async () => {
    const m = principal([co("manager")]);
    expect(await allow(m, invoice(), "issue")).toBe(true);
    expect(await allow(m, invoice(), A)).toBe(false);
  });

  it("🔴 a member and a viewer are denied", async () => {
    for (const role of ["member", "viewer"]) {
      expect(await allow(principal([co(role)]), invoice(), A), role).toBe(false);
    }
  });

  it("🔴 a company_admin of ANOTHER company, or on a low-assurance session, is denied", async () => {
    expect(await allow(principal([co("company_admin", T2)], { companies: [T2] }), invoice(), A)).toBe(false);
    expect(await allow(principal([co("company_admin")], { assurance: "low" }), invoice(), A)).toBe(false);
  });

  for (const kind of BOT_KINDS) {
    it(`🔴 a ${kind} is denied for every grant, platform_admin and the permission arm included`, async () => {
      expect(await allow(principal([co("company_admin")], { kind }), invoice(), A)).toBe(false);
      expect(await allow(principal([glob("platform_admin")], { kind, companies: [] }), invoice(), A)).toBe(false);
      expect(await allow(principal([co("owner")], { kind, perms: [key("invoice.void_issued")] }), invoice(), A)).toBe(false);
    });
  }

  it("🔴 a delegated call is denied: a bot acting for a company_admin who may void", async () => {
    const human = principal([co("company_admin")], { userId: HUMAN });
    expect(await allow(human, invoice(), A), "control: the human alone may").toBe(true);
    expect(await delegated(principal([co("company_admin")], { kind: "bot" }), human, invoice(), A)).toBe(false);
    expect(await delegated(principal([co("company_admin")], { kind: "automation" }), human, invoice(), A)).toBe(false);
  });
});

describe.skipIf(!live)("PV5-02 · finance_config `set_bank_details` (live Cerbos)", () => {
  const A = "set_bank_details";
  /** Every finance.config.* key the catalog has, set_bank_details included. */
  const ALL_CONFIG_KEYS: PermissionGrant[] = ["read", "create", "update", "delete", "set_bank_details"].map((a) => key(`finance.config.${a}`));

  it("an owner of the company sets the bank details", async () => {
    expect(await allow(principal([co("owner")]), financeConfig(), A)).toBe(true);
  });

  it("the company's finance_manager sets the bank details", async () => {
    expect(await allow(principal([co("finance_manager")]), financeConfig(), A)).toBe(true);
  });

  it("platform_admin sets them too, at high assurance: the wildcard at the top of the policy keeps its reach (PV-D26)", async () => {
    expect(await allow(principal([glob("platform_admin")], { companies: [] }), financeConfig(), A)).toBe(true);
  });

  it("🔴 company_admin is denied, even though it may update the rest of the accounting vocabulary", async () => {
    const p = principal([co("company_admin")]);
    expect(await allow(p, financeConfig(), "update"), "control: company_admin updates config").toBe(true);
    expect(await allow(p, financeConfig(), A)).toBe(false);
  });

  it("🔴 a member, a viewer, a manager and finance_staff are denied", async () => {
    for (const role of ["member", "viewer", "manager", "finance_staff"]) {
      expect(await allow(principal([co(role)]), financeConfig(), A), role).toBe(false);
    }
  });

  it("🔴 a custom role holding EVERY finance.config.* key, set_bank_details included, is denied (no perm arm reads it)", async () => {
    // (finance_config is role-arm only, so such a role reaches none of the kind; the point here is that the
    // NEW key does not change that.)
    const p = principal([co("pv502_custom")], { perms: ALL_CONFIG_KEYS });
    expect(await allow(p, financeConfig(), A)).toBe(false);
    // An owner who ALSO carries the key by bundle is unaffected by the key: it is the grant that counts.
    expect(await allow(principal([co("owner")], { perms: ALL_CONFIG_KEYS }), financeConfig(), A)).toBe(true);
  });

  it("🔴 the owner or finance_manager of ANOTHER company is denied, even as a member of this one", async () => {
    expect(await allow(principal([co("owner", T2)]), financeConfig(), A)).toBe(false);
    expect(await allow(principal([co("finance_manager", T2)]), financeConfig(), A)).toBe(false);
  });

  it("🔴 a GLOBAL owner or finance_manager grant matches nothing: both are per-company grants", async () => {
    expect(await allow(principal([glob("owner")]), financeConfig(), A)).toBe(false);
    expect(await allow(principal([glob("finance_manager")]), financeConfig(), A)).toBe(false);
  });

  it("🔴 an owner who is not a member of the tenant, or on a low-assurance session, is denied", async () => {
    expect(await allow(principal([co("owner")], { companies: [T2] }), financeConfig(), A)).toBe(false);
    expect(await allow(principal([co("owner")], { assurance: "low" }), financeConfig(), A)).toBe(false);
    expect(await allow(principal([co("finance_manager")], { assurance: "low" }), financeConfig(), A)).toBe(false);
  });

  it("🔴 the rule grants set_bank_details ONLY: a bare owner or finance_manager grant moves nothing else here", async () => {
    // The finance_manager's other reach is the module tier (a `module: "finance"` resource), which a bare
    // grant on this resource shape does reach; the owner has no role rules at all, so a bare owner gets none.
    const owner = principal([co("owner")]);
    for (const action of ["read", "create", "update", "delete"]) {
      expect(await allow(owner, financeConfig(), action), action).toBe(false);
    }
  });

  for (const kind of BOT_KINDS) {
    it(`🔴 a ${kind} is denied for every grant, platform_admin included`, async () => {
      expect(await allow(principal([co("owner")], { kind }), financeConfig(), A)).toBe(false);
      expect(await allow(principal([co("finance_manager")], { kind }), financeConfig(), A)).toBe(false);
      expect(await allow(principal([glob("platform_admin")], { kind, companies: [] }), financeConfig(), A)).toBe(false);
    });
  }

  it("🔴 a delegated call is denied: a bot acting for an owner or finance_manager", async () => {
    const owner = principal([co("owner")], { userId: HUMAN });
    const fm = principal([co("finance_manager")], { userId: HUMAN });
    expect(await allow(owner, financeConfig(), A), "control: the owner alone may").toBe(true);
    expect(await allow(fm, financeConfig(), A), "control: the finance_manager alone may").toBe(true);
    for (const kind of BOT_KINDS) {
      expect(await delegated(principal([co("finance_manager")], { kind }), owner, financeConfig(), A), `${kind} for owner`).toBe(false);
      expect(await delegated(principal([co("owner")], { kind }), fm, financeConfig(), A), `${kind} for finance_manager`).toBe(false);
    }
  });

  it("the DENY names set_bank_details only: a bot keeps the config rights it had", async () => {
    const bot = principal([co("company_admin")], { kind: "bot" });
    for (const a of ["read", "create", "update", "delete"]) expect(await allow(bot, financeConfig(), a), a).toBe(true);
  });
});

describe.skipIf(!live)("PV-D26 (restored by PV-D40) · bank details: high assurance for EVERYONE, the company's own owner / finance_manager included (live Cerbos)", () => {
  // Assurance is "low" | "linked" | "high"; the ruling's "medium" is "linked" (a plain SSO login, no fresh second factor).
  const SET = "set_bank_details";
  const ap = (tenantId: string = T1): Resource => ({ kind: "finance_ap", tenantId, module: "finance" });
  const admin = (assurance: Principal["assurance"]) => principal([glob("platform_admin")], { companies: [], assurance });

  // PV-D40 (2026-10-13, PV5-14) lifted PV-D29's interim relaxation: an owner or finance_manager of the company at
  // "linked" is DENIED again, exactly as PV-D26 ruled. "high" is what a real second factor, or on the dev stage the
  // simulated one (principal.attr.assuranceSource "simulated"), produces; the policy reads only `assurance`.
  it("set_bank_details (PV-D26 restored): an owner at linked assurance is DENIED, at high is ALLOWED, at low is DENIED", async () => {
    expect(await allow(principal([co("owner")], { assurance: "linked" }), financeConfig(), SET)).toBe(false);
    expect(await allow(principal([co("owner")], { assurance: "high" }), financeConfig(), SET)).toBe(true);
    expect(await allow(principal([co("owner")], { assurance: "low" }), financeConfig(), SET)).toBe(false);
  });

  it("set_bank_details (PV-D26 restored): a finance_manager at linked is DENIED, at high is ALLOWED, at low is DENIED", async () => {
    expect(await allow(principal([co("finance_manager")], { assurance: "linked" }), financeConfig(), SET)).toBe(false);
    expect(await allow(principal([co("finance_manager")], { assurance: "high" }), financeConfig(), SET)).toBe(true);
    expect(await allow(principal([co("finance_manager")], { assurance: "low" }), financeConfig(), SET)).toBe(false);
  });

  it("🔴 another company's, or a global, owner / finance_manager grant is DENIED at linked (and stays denied at high: no ALLOW)", async () => {
    expect(await allow(principal([co("owner", T2)], { assurance: "linked" }), financeConfig(), SET)).toBe(false);
    expect(await allow(principal([co("finance_manager", T2)], { assurance: "linked" }), financeConfig(), SET)).toBe(false);
    expect(await allow(principal([glob("owner")], { assurance: "linked" }), financeConfig(), SET)).toBe(false);
    expect(await allow(principal([co("owner", T2)], { assurance: "high" }), financeConfig(), SET)).toBe(false);
    expect(await allow(principal([glob("owner")], { assurance: "high" }), financeConfig(), SET)).toBe(false);
  });

  it("PV5-14: the simulated second factor is authorization-neutral beyond `assurance`: assuranceSource \"simulated\" at high decides exactly as high, and never lifts linked", async () => {
    const sim = (assurance: Principal["assurance"], roles: RoleGrant[]) =>
      ({ ...principal(roles, { assurance }), assuranceSource: "simulated" as const });
    expect(await allow(sim("high", [co("owner")]), financeConfig(), SET)).toBe(true);
    expect(await allow(sim("high", [co("finance_manager")]), financeConfig(), SET)).toBe(true);
    expect(await allow(sim("linked", [co("owner")]), financeConfig(), SET)).toBe(false);
    expect(await allow(sim("high", [co("company_admin")]), financeConfig(), SET)).toBe(false);
    expect(await allow({ ...sim("high", [co("owner")]), kind: "bot" }, financeConfig(), SET)).toBe(false);
  });

  it("set_bank_details: platform_admin at linked (and low) is DENIED, at high is ALLOWED: the wildcard keeps its reach but not a way round the step-up", async () => {
    expect(await allow(admin("linked"), financeConfig(), SET)).toBe(false);
    expect(await allow(admin("low"), financeConfig(), SET)).toBe(false);
    expect(await allow(admin("high"), financeConfig(), SET)).toBe(true);
  });

  it("set_bank_details: a bot is still DENIED at high and at linked assurance; company_admin is DENIED at linked and at high (no ALLOW for it at all)", async () => {
    for (const assurance of ["high", "linked"] as const) {
      expect(await allow(principal([co("owner")], { kind: "bot", assurance }), financeConfig(), SET), `bot owner ${assurance}`).toBe(false);
      expect(await allow(principal([co("finance_manager")], { kind: "automation", assurance }), financeConfig(), SET), `automation fm ${assurance}`).toBe(false);
      expect(await allow(principal([co("company_admin")], { assurance }), financeConfig(), SET), `company_admin ${assurance}`).toBe(false);
    }
  });

  it("the assurance DENY names set_bank_details only: platform_admin keeps the rest of finance_config at linked assurance", async () => {
    for (const a of ["read", "create", "update", "delete"]) expect(await allow(admin("linked"), financeConfig(), a), a).toBe(true);
  });

  it("vendor_master (supplier bank details): platform_admin at linked (and low) is DENIED, at high is ALLOWED", async () => {
    expect(await allow(admin("linked"), ap(), "vendor_master")).toBe(false);
    expect(await allow(admin("low"), ap(), "vendor_master")).toBe(false);
    expect(await allow(admin("high"), ap(), "vendor_master")).toBe(true);
  });

  it("vendor_master: finance_manager and company_admin keep their reach at high and are still refused below it", async () => {
    for (const role of ["finance_manager", "company_admin"]) {
      expect(await allow(principal([co(role)], { assurance: "high" }), ap(), "vendor_master"), `${role} high`).toBe(true);
      expect(await allow(principal([co(role)], { assurance: "linked" }), ap(), "vendor_master"), `${role} linked`).toBe(false);
    }
    // control: finance_staff never held it, at any assurance
    expect(await allow(principal([co("finance_staff")], { assurance: "high" }), ap(), "vendor_master")).toBe(false);
  });

  it("the vendor_master DENY names that action only: platform_admin keeps the other AP actions at linked assurance", async () => {
    for (const a of ["read", "bill_entry"]) expect(await allow(admin("linked"), ap(), a), a).toBe(true);
  });
});

describe.skipIf(!live)("PV5-02 · contract `mark_certified` (live Cerbos)", () => {
  const A = "mark_certified";

  it("company_admin of the contract's company marks a contract certified", async () => {
    expect(await allow(principal([co("company_admin")]), contract(), A)).toBe(true);
  });

  it("platform_admin marks (the wildcard)", async () => {
    expect(await allow(principal([glob("platform_admin")], { companies: [] }), contract(), A)).toBe(true);
  });

  it("an owner reaches it through the permission arm (the key in its bundle)", async () => {
    expect(await allow(principal([co("owner")], { perms: [key("core.contract.mark_certified")] }), contract(), A)).toBe(true);
    expect(await allow(principal([co("owner")]), contract(), A)).toBe(false);
  });

  it("the holders are exactly the holders of `send`: a manager has neither", async () => {
    for (const [label, p] of [
      ["company_admin", principal([co("company_admin")])],
      ["manager", principal([co("manager")])],
      ["member", principal([co("member")])],
    ] as Array<[string, Principal]>) {
      expect(await allow(p, contract(), A), label).toBe(await allow(p, contract(), "send"));
    }
  });

  it("🔴 a member, a viewer and a manager are denied", async () => {
    for (const role of ["member", "viewer", "manager"]) {
      expect(await allow(principal([co(role)]), contract(), A), role).toBe(false);
    }
  });

  it("a custom role holding the key reaches it (the mirror); one holding `send` alone does not", async () => {
    expect(await allow(principal([co("pv502_custom")], { perms: [key("core.contract.mark_certified")] }), contract(), A)).toBe(true);
    expect(await allow(principal([co("pv502_custom")], { perms: [key("core.contract.send")] }), contract(), A)).toBe(false);
  });

  it("🔴 a company_admin of ANOTHER company, or on a low-assurance session, is denied", async () => {
    expect(await allow(principal([co("company_admin", T2)], { companies: [T2] }), contract(), A)).toBe(false);
    expect(await allow(principal([co("company_admin")], { assurance: "low" }), contract(), A)).toBe(false);
  });

  it("marking certified does not widen anything: countersign stays owner-only", async () => {
    const p = principal([co("company_admin")], { perms: [key("core.contract.mark_certified")] });
    expect(await allow(p, contract(), "countersign")).toBe(false);
  });
});
