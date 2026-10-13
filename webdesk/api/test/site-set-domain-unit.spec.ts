// site.setDomain (M6-P6i) with NO services: no Postgres, no Redis, no Nest app. What it proves without a database:
//   - the domain rule (`checkEnvironmentDomain`): the canonical bare host is accepted, every other spelling is refused with a
//     reason, and the refusal is the same for the body validator;
//   - the controller hands the service exactly the validated values and refuses a bad body BEFORE calling it;
//   - the command is HIGH / webdesk:promote in the registry (the PDP refuses a HIGH command without a WS4 assertion);
//   - the WS4 hash binds params AND body: an assertion for one domain, one environment or one site does not verify another;
//   - CORS follows the stored value and only it: the REAL forms guard and the draft-preview origin rule are driven with a fake
//     lookup that returns the stored domain, and every lookalike of it is refused (site-set-domain.spec.ts drives the same
//     rule through the real consent route, against a database, after the command has run).
// The DB-backed behaviour (the UPDATE, the audit row, the single-use claim, the rollback) is site-set-domain.spec.ts.
import { describe, expect, it } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { COMMAND_REGISTRY } from "../src/control/command-types";
import { assertNullableEnvironmentDomain, checkEnvironmentDomain } from "../src/control/lifecycle/environment-domain";
import { LifecycleController } from "../src/control/lifecycle/lifecycle.controller";
import type { LifecycleService } from "../src/control/lifecycle/lifecycle.service";
import type { ControlRequest } from "../src/control/auth/control-request";
import { computeCommandHash } from "../src/control/auth/ws4-assertion";
import { FormContextGuard } from "../src/forms/form-context.guard";
import type { FormLookupService } from "../src/forms/form-lookup.service";
import type { TenantLookupService } from "../src/tenants/tenant-lookup.service";
import { allowedPreviewOrigin } from "../src/delivery/preview-token";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

describe("the registry", () => {
  it("site.setDomain is HIGH under webdesk:promote, so the policy decision point demands a WS4 assertion", () => {
    expect(COMMAND_REGISTRY["site.setDomain"]).toEqual({ command: "site.setDomain", impactClass: "high", scope: "webdesk:promote", jobTracked: false });
  });
});

describe("checkEnvironmentDomain: canonical bare host or refused", () => {
  it.each(["example.com", "shop.example.com", "a.b.c.example.co.id", "my-shop.example.test", "xn--exmple-4nf.test", "www.example.com", "1shop.example.com"])("accepts %j", (d) => {
    expect(checkEnvironmentDomain(d)).toEqual({ ok: true, domain: d });
    expect(assertNullableEnvironmentDomain(d)).toBe(d);
  });

  it("null is a clear, not a domain", () => {
    expect(assertNullableEnvironmentDomain(null)).toBeNull();
  });

  const refusals: Array<[string, unknown]> = [
    ["upper case", "Example.com"],
    ["mixed case (the capital-I lookalike)", "exampIe.com"],
    ["a scheme", "https://example.com"],
    ["a port", "example.com:8443"],
    ["a path", "example.com/shop"],
    ["a trailing slash", "example.com/"],
    ["a query", "example.com?x=1"],
    ["a fragment", "example.com#x"],
    ["userinfo", "user@example.com"],
    ["a wildcard", "*.example.com"],
    ["leading whitespace", " example.com"],
    ["trailing whitespace", "example.com "],
    ["an inner space", "exa mple.com"],
    ["a trailing root dot", "example.com."],
    ["a leading dot", ".example.com"],
    ["an empty label", "example..com"],
    ["a single label", "localhost"],
    ["a single label that is a word", "intranet"],
    ["an IPv4 literal", "10.0.0.1"],
    ["a public IPv4 literal", "93.184.216.34"],
    ["an IPv6 literal", "[::1]"],
    ["a Cyrillic look-alike (must be punycode)", "exаmple.com"],
    ["a non-ASCII letter", "exämple.com"],
    ["an underscore", "ex_ample.com"],
    ["a leading hyphen label", "-example.com"],
    ["a trailing hyphen label", "example-.com"],
    ["a label over 63 characters", `${"a".repeat(64)}.com`],
    ["a name over 253 characters", `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.com`],
    ["a numeric top-level label", "example.123"],
    ["the .invalid placeholder namespace", "site.provisioned.invalid"],
    ["a .local name", "printer.local"],
    ["a .localhost name", "app.localhost"],
    ["an .internal name", "db.internal"],
    ["too short", "a"],
    ["empty", ""],
    ["a number", 42],
    ["an array", ["example.com"]],
    ["an object", { domain: "example.com" }],
    ["undefined", undefined],
  ];
  it.each(refusals)("refuses %s", (_what, value) => {
    const v = checkEnvironmentDomain(value);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
    expect(() => assertNullableEnvironmentDomain(value)).toThrow(BadRequestException);
  });
});

describe("LifecycleController.setSiteDomain", () => {
  type Call = Record<string, unknown>;
  function rig() {
    const calls: Call[] = [];
    const lifecycle = { setSiteDomain: async (input: Call) => (calls.push(input), { environment: { id: input.envId, domain: input.domain }, replayed: false }) } as unknown as LifecycleService;
    return { calls, controller: new LifecycleController(lifecycle) };
  }
  const req = { control: { principal: { subject: "erp-webdesk-control" }, ws4ApprovalId: "apr-1" } } as unknown as ControlRequest;
  const call = (c: LifecycleController, body: unknown, siteId = UUID_A, idem: string | undefined = "idem-12345678") =>
    c.setSiteDomain(req, "acme", siteId, idem, body as { envId?: unknown; domain?: unknown });

  it("passes the validated values, the actor and the claimed approval id to the service, once", async () => {
    const { calls, controller } = rig();
    const res = await call(controller, { envId: UUID_B, domain: "shop.example.com" });
    expect(calls).toEqual([
      { tenantSlug: "acme", siteId: UUID_A, envId: UUID_B, domain: "shop.example.com", actor: "erp-webdesk-control", idempotencyKey: "idem-12345678", ws4ApprovalId: "apr-1" },
    ]);
    expect(res).toMatchObject({ replayed: false });
  });

  it("a clear passes `domain: null` through", async () => {
    const { calls, controller } = rig();
    await call(controller, { envId: UUID_B, domain: null });
    expect(calls[0]).toMatchObject({ envId: UUID_B, domain: null });
  });

  it.each<[string, unknown]>([
    ["an unknown key", { envId: UUID_B, domain: "shop.example.com", extra: 1 }],
    ["a missing domain", { envId: UUID_B }],
    ["a missing envId", { domain: "shop.example.com" }],
    ["a malformed envId", { envId: "nope", domain: "shop.example.com" }],
    ["a lookalike with a port", { envId: UUID_B, domain: "shop.example.com:8443" }],
    ["an upper-case domain", { envId: UUID_B, domain: "Shop.Example.com" }],
    ["a Cyrillic look-alike", { envId: UUID_B, domain: "shоp.example.com" }],
    ["a non-object body", ["shop.example.com"]],
    ["no body", undefined],
    ["a null body", null],
  ])("refuses %s before the service is called", async (_what, body) => {
    const { calls, controller } = rig();
    await expect(call(controller, body)).rejects.toThrow(BadRequestException);
    expect(calls).toEqual([]);
  });

  it("refuses a malformed site id and a missing Idempotency-Key before the service is called", async () => {
    const { calls, controller } = rig();
    await expect(call(controller, { envId: UUID_B, domain: "shop.example.com" }, "not-a-uuid")).rejects.toThrow(BadRequestException);
    await expect(controller.setSiteDomain(req, "acme", UUID_A, undefined, { envId: UUID_B, domain: "shop.example.com" })).rejects.toThrow(BadRequestException);
    expect(calls).toEqual([]);
  });
});

describe("the WS4 hash binds the params AND the body", () => {
  // Exactly what CommandAuthorizationGuard hashes: `{...params, ...body}`.
  const hash = (params: Record<string, unknown>, body: Record<string, unknown>) => computeCommandHash("site.setDomain", { ...params, ...body });
  const base = hash({ tenantSlug: "acme", siteId: UUID_A }, { envId: UUID_B, domain: "shop.example.com" });

  it("is stable for the same arguments and differs for any other domain, environment, site or tenant", () => {
    expect(hash({ tenantSlug: "acme", siteId: UUID_A }, { domain: "shop.example.com", envId: UUID_B })).toBe(base); // key order is irrelevant
    expect(hash({ tenantSlug: "acme", siteId: UUID_A }, { envId: UUID_B, domain: "evil.example.com" })).not.toBe(base);
    expect(hash({ tenantSlug: "acme", siteId: UUID_A }, { envId: UUID_C, domain: "shop.example.com" })).not.toBe(base);
    expect(hash({ tenantSlug: "acme", siteId: UUID_C }, { envId: UUID_B, domain: "shop.example.com" })).not.toBe(base);
    expect(hash({ tenantSlug: "other", siteId: UUID_A }, { envId: UUID_B, domain: "shop.example.com" })).not.toBe(base);
  });

  it("a clear (null) is a different command from setting any domain, and from the same call with the domain key absent", () => {
    const clear = hash({ tenantSlug: "acme", siteId: UUID_A }, { envId: UUID_B, domain: null });
    expect(clear).not.toBe(base);
    expect(clear).not.toBe(hash({ tenantSlug: "acme", siteId: UUID_A }, { envId: UUID_B }));
  });

  it("is a different hash from site.archive over the same params, so an archive approval can never set a domain", () => {
    expect(computeCommandHash("site.archive", { tenantSlug: "acme", siteId: UUID_A })).not.toBe(base);
  });
});

describe("CORS follows the stored domain, and a lookalike is refused", () => {
  const STORED = "shop.example.com";
  const LOOKALIKES = [
    "https://shop.example.com.evil.test", // the domain as a PREFIX of another host
    "http://shop.example.com.evil.test",
    "https://evil.shop.example.com", // a sub-domain
    "https://evilshop.example.com", // suffix of another label
    "https://shop-example.com", // a hyphen for the dot
    "https://shop.example.com.", // the root-dot spelling
    "https://shop.example.com:8443", // another port
    "https://shop.example.com@evil.test", // userinfo hiding the real host
    "https://evil.test/shop.example.com", // a path
    "https://shop.examp1e.com", // a digit for a letter
    "https://shop.exampIe.com", // a capital I for the l
    "https://shop.xn--exmple-4nf.com", // a Cyrillic "а", as a browser sends it
    "https://example.com", // the parent
    "ftp://shop.example.com",
    "shop.example.com", // not an Origin at all
    "null",
    "",
  ];

  // The REAL FormContextGuard with a fake lookup that returns the stored domain as `environments.domain` would.
  function formGuard(domains: string[]) {
    const tenants = { bySlug: async () => ({ id: "tenant-1", slug: "acme", status: "active", companyRef: "company-1" }) } as unknown as TenantLookupService;
    const forms = {
      byId: async () => ({ id: "form-1", tenant_id: "tenant-1", site_id: "site-1", key: "contact", schema: {}, notify: {}, retention_days: 30, consent_notice_version: null }),
      allowedDomainsForSite: async () => domains,
    } as unknown as FormLookupService;
    return new FormContextGuard(tenants, forms);
  }
  async function viaFormGuard(guard: FormContextGuard, origin: string | undefined) {
    const headers: Record<string, string> = {};
    const request = { params: { tenantSlug: "acme", formId: "form-1" }, headers: origin === undefined ? {} : { origin } };
    const reply = { header: (k: string, v: string) => void (headers[k] = v) };
    const ctx = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }) } as unknown as ExecutionContext;
    try {
      await guard.canActivate(ctx);
      return { allowed: true as const, headers };
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      return { allowed: false as const, headers };
    }
  }

  it("the forms guard answers the stored domain over both schemes and echoes the Origin", async () => {
    const guard = formGuard([STORED]);
    for (const origin of [`https://${STORED}`, `http://${STORED}`]) {
      const r = await viaFormGuard(guard, origin);
      expect(r.allowed, origin).toBe(true);
      expect(r.headers["Access-Control-Allow-Origin"]).toBe(origin);
    }
  });

  it.each(LOOKALIKES)("the forms guard refuses %j (403, no CORS header)", async (origin) => {
    const r = await viaFormGuard(formGuard([STORED]), origin);
    expect(r.allowed).toBe(false);
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("the forms guard refuses a request with no Origin at all, and refuses everything once the domain is cleared", async () => {
    expect((await viaFormGuard(formGuard([STORED]), undefined)).allowed).toBe(false);
    expect((await viaFormGuard(formGuard([]), `https://${STORED}`)).allowed).toBe(false);
  });

  it("the draft-preview rule answers https://<stored domain> only, and every lookalike gets no CORS header", () => {
    expect(allowedPreviewOrigin(`https://${STORED}`, [STORED])).toBe(`https://${STORED}`);
    for (const origin of LOOKALIKES) expect(allowedPreviewOrigin(origin, [STORED]), origin).toBeNull();
    expect(allowedPreviewOrigin(`https://${STORED}`, [])).toBeNull(); // a cleared domain answers nothing
  });

  it("a stored value that is not a bare host never matches anything (the rule the command enforces on the way in)", () => {
    for (const stored of ["https://shop.example.com", "shop.example.com/", "shop.example.com:443", "*.example.com", "", " "]) {
      expect(allowedPreviewOrigin(`https://${STORED}`, [stored]), stored).toBeNull();
    }
  });
});
