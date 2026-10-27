// M5-W1e — the contributor marker, unit level (no database): the optional `xc` claim, the principal's `contributor` flag in both
// resolvers, the guard, and the CONTRIBUTOR_COMMANDS allow-list pin. The HTTP enforcement (real Postgres, signed assertions) is
// contributor-editor-enforcement.spec.ts; the vector v5 shared with the ERP signer is editorial-assertion-vectors.spec.ts.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { COMMAND_REGISTRY, EDITORIAL_COMMANDS, CLIENT_EDITOR_COMMANDS, CONTRIBUTOR_COMMANDS, type CommandName } from "../src/control/command-types";
import { ControlProblem } from "../src/control/content/content-problem";
import { verifyEditorialAssertion } from "../src/control/auth/editorial-assertion";
import { RealEditorialPrincipalResolver } from "../src/control/auth/real-editorial-principal-resolver";
import { DevModeEditorialPrincipalResolver, DEV_EDITORIAL_PRINCIPAL_HEADER } from "../src/control/auth/dev-mode-editorial-principal-resolver";
import { EditorialAssertionGuard } from "../src/control/auth/editorial-assertion.guard";
import { assertContributorMayRun, CONTRIBUTOR_COMMAND_NOT_ALLOWED } from "../src/control/auth/contributor-editor";
import { computeCommandHash, mintWs4Assertion } from "../src/control/auth/ws4-assertion";
import { freshKey, keySetOf, mintEditorial, mintRaw, wireHeader, wirePayload, type ClaimInput } from "./editorial-assertion-kit";

const NOW = 1_760_000_000;
const key = freshKey("wde-xc-test");
const params = { tenantSlug: "acme", siteId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4" };
const body = { collectionKey: "page", locale: "en", slug: "page.a", fields: { title: "T" } };
const PROBLEM = "https://webdesk.gaiada.online/errors/";

function claimsFor(over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    sub: "erp-user-contributor-1",
    pk: "human",
    ten: params.tenantSlug,
    site: params.siteId,
    cmd: "content.create",
    cmh: computeCommandHash("content.create", { ...params, ...body }),
    iat: NOW,
    exp: NOW + 60,
    jti: randomUUID(),
    ...over,
  };
}
const expectation = { tenantSlug: params.tenantSlug, siteId: params.siteId, command: "content.create" as CommandName, args: { ...params, ...body }, high: false, ws4ApprovalId: null };

async function refusal(promise: Promise<unknown>): Promise<ControlProblem> {
  try {
    await promise;
  } catch (e) {
    return e as ControlProblem;
  }
  throw new Error("expected a refusal");
}

describe("M5-W1e the `xc` claim: verifier", () => {
  it("xc: true is accepted and returned in the verified claims", async () => {
    const claims = await verifyEditorialAssertion(mintEditorial(key, claimsFor({ xc: true })), keySetOf(key), expectation, NOW + 1);
    expect(claims.xc).toBe(true);
    expect(claims.ce).toBeUndefined();
  });

  it("xc: false is accepted; an absent xc stays absent", async () => {
    expect((await verifyEditorialAssertion(mintEditorial(key, claimsFor({ xc: false })), keySetOf(key), expectation, NOW + 1)).xc).toBe(false);
    expect((await verifyEditorialAssertion(mintEditorial(key, claimsFor()), keySetOf(key), expectation, NOW + 1)).xc).toBeUndefined();
  });

  it("a non-boolean xc is refused 401 editorial-assertion-claims, whatever its type (never coerced, never ignored)", async () => {
    for (const bad of ["true", "false", 1, 0, null, [], {}, [true]]) {
      const jws = mintRaw(wireHeader(key.kid), { ...wirePayload(claimsFor()), xc: bad }, key.privateKey);
      const p = await refusal(verifyEditorialAssertion(jws, keySetOf(key), expectation, NOW + 1));
      expect(p.getStatus(), JSON.stringify(bad)).toBe(401);
      expect(p.slug, JSON.stringify(bad)).toBe("editorial-assertion-claims");
    }
  });

  it("xc together with ce is refused 401 editorial-assertion-claims, whatever their values", async () => {
    for (const [xc, ce] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      const p = await refusal(verifyEditorialAssertion(mintEditorial(key, claimsFor({ xc, ce })), keySetOf(key), expectation, NOW + 1));
      expect(p.getStatus(), `xc ${xc} ce ${ce}`).toBe(401);
      expect(p.slug, `xc ${xc} ce ${ce}`).toBe("editorial-assertion-claims");
    }
  });

  it("a non-boolean xc is checked together with a boolean ce: still 401 claims (the shape check never lets the pair through)", async () => {
    const jws = mintRaw(wireHeader(key.kid), { ...wirePayload(claimsFor({ ce: true })), xc: "true" }, key.privateKey);
    const p = await refusal(verifyEditorialAssertion(jws, keySetOf(key), expectation, NOW + 1));
    expect(p.slug).toBe("editorial-assertion-claims");
  });

  it("expiry behaves as before for an xc assertion: lifetime, expired, not yet valid", async () => {
    const exp = (over: Partial<ClaimInput>, at = NOW + 1) => refusal(verifyEditorialAssertion(mintEditorial(key, claimsFor({ xc: true, ...over })), keySetOf(key), expectation, at));
    expect((await exp({ iat: NOW, exp: NOW + 121 })).slug).toBe("editorial-assertion-expired");
    expect((await exp({}, NOW + 71)).slug).toBe("editorial-assertion-expired");
    expect((await exp({ iat: NOW + 12, exp: NOW + 72 })).slug).toBe("editorial-assertion-expired");
    // the tolerance edge still passes
    await expect(verifyEditorialAssertion(mintEditorial(key, claimsFor({ xc: true })), keySetOf(key), expectation, NOW + 69)).resolves.toMatchObject({ xc: true });
  });

  it("xc is covered by the signature: adding it to a signed staff payload, or stripping it from a contributor's, breaks verification", async () => {
    const staff = mintEditorial(key, claimsFor());
    const [h, p, s] = staff.split(".");
    const withXc = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), xc: true })).toString("base64url")}.${s}`;
    expect((await refusal(verifyEditorialAssertion(withXc, keySetOf(key), expectation, NOW + 1))).slug).toBe("editorial-assertion-invalid-signature");

    const contributor = mintEditorial(key, claimsFor({ xc: true }));
    const [h2, p2, s2] = contributor.split(".");
    const payload = JSON.parse(Buffer.from(p2, "base64url").toString());
    delete payload.xc;
    const stripped = `${h2}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s2}`;
    expect((await refusal(verifyEditorialAssertion(stripped, keySetOf(key), expectation, NOW + 1))).slug).toBe("editorial-assertion-invalid-signature");
  });
});

describe("M5-W1e the principal exposes contributor", () => {
  function realResolver(store = { consume: async (_jti: string, _ttl: number) => true, close: async () => {} }) {
    return new RealEditorialPrincipalResolver({ keys: keySetOf(key), store, now: () => NOW + 1 });
  }
  const reqFor = (jws: string) => ({ params, headers: { "x-webdesk-editorial-assertion": jws } }) as never;
  const args = { ...params, ...body };

  it("real resolver: xc: true -> contributor true, and no clientEditor", async () => {
    const p = await realResolver().resolve(reqFor(mintEditorial(key, claimsFor({ xc: true }))), "content.create", args);
    expect(p.contributor).toBe(true);
    expect(p.clientEditor).toBeUndefined();
    expect(p.sub).toBe("erp-user-contributor-1");
  });

  it("real resolver: xc absent or false -> the principal is exactly what it was before (no contributor key at all)", async () => {
    for (const over of [{}, { xc: false }]) {
      const p = await realResolver().resolve(reqFor(mintEditorial(key, claimsFor(over))), "content.create", args);
      expect(p.contributor).toBeUndefined();
      expect(Object.keys(p).sort()).toEqual(["jti", "pk", "sub"]);
    }
  });

  it("real resolver: replay of an xc assertion is 401 editorial-assertion-replayed; xc with ce burns no jti", async () => {
    const seen = new Set<string>();
    const store = { consume: async (jti: string) => (seen.has(jti) ? false : (seen.add(jti), true)), close: async () => {} };
    const r = realResolver(store);
    const jws = mintEditorial(key, claimsFor({ xc: true }));
    await r.resolve(reqFor(jws), "content.create", args);
    const again = await refusal(r.resolve(reqFor(jws), "content.create", args));
    expect(again.getStatus()).toBe(401);
    expect(again.slug).toBe("editorial-assertion-replayed");
    // a refused-for-claims assertion never reaches the store
    const before = seen.size;
    const both = await refusal(r.resolve(reqFor(mintEditorial(key, claimsFor({ xc: true, ce: true }))), "content.create", args));
    expect(both.slug).toBe("editorial-assertion-claims");
    expect(seen.size).toBe(before);
  });

  const dev = new DevModeEditorialPrincipalResolver();
  const devReq = (h: string) => ({ headers: { [DEV_EDITORIAL_PRINCIPAL_HEADER]: h } }) as never;

  it("dev resolver: {xc:true} -> contributor true; a bare subject and {xc:false} -> not a contributor", async () => {
    expect((await dev.resolve(devReq(JSON.stringify({ sub: "u1", xc: true })), "content.update", {})).contributor).toBe(true);
    expect((await dev.resolve(devReq("u1"), "content.update", {})).contributor).toBeUndefined();
    expect((await dev.resolve(devReq(JSON.stringify({ sub: "u1", xc: false })), "content.update", {})).contributor).toBeUndefined();
  });

  it("dev resolver: a non-boolean xc is 401 editorial-assertion-malformed; xc with ce is 401 editorial-assertion-claims", async () => {
    for (const bad of ["yes", 1, null, []]) {
      const p = await refusal(dev.resolve(devReq(JSON.stringify({ sub: "u1", xc: bad })), "content.update", {}));
      expect(p.getStatus()).toBe(401);
      expect(p.slug).toBe("editorial-assertion-malformed");
    }
    for (const both of [{ xc: true, ce: true }, { xc: true, ce: false }, { xc: false, ce: true }]) {
      const p = await refusal(dev.resolve(devReq(JSON.stringify({ sub: "u1", ...both })), "content.update", {}));
      expect(p.getStatus()).toBe(401);
      expect(p.slug).toBe("editorial-assertion-claims");
    }
  });
});

describe("M5-W1e the commands a contributor may run (CONTRIBUTOR_COMMANDS)", () => {
  // THE PIN. A new editorial command is closed to a contributor until it is added here on purpose, by editing BOTH this list and
  // CONTRIBUTOR_COMMANDS in src/control/command-types.ts.
  const PINNED_ALLOWED = [
    "content.create",
    "content.previewToken",
    "content.previewTokenRevoke",
    "content.restoreVersion",
    "content.update",
    "editorial.comment",
    "editorial.commentResolve",
    "editorial.requestChanges",
    "editorial.seoSignoff",
    "editorial.submit",
    "editorial.withdraw",
    // M5-W1q (WSK-D84): a contributor may upload, INTO THE QUARANTINE (the minted token quarantines what it uploads).
    "media.uploadToken",
  ];
  const PINNED_REFUSED = [
    "content.delete",
    "content.publish",
    "content.schedule",
    "content.unpublish",
    "editorial.approve",
    "editorial.assign",
    "editorial.policySet",
    "media.delete",
    // M5-W1q: reviewing the quarantine is a staff function; a contributor never edits or deletes media either.
    "media.review",
    "media.update",
  ];

  it("the allowed set is exactly the pinned list", () => {
    expect([...CONTRIBUTOR_COMMANDS].sort()).toEqual(PINNED_ALLOWED);
  });

  it("the refused editorial commands are exactly the pinned list (so a NEW editorial command fails this test until someone decides)", () => {
    const refused = [...EDITORIAL_COMMANDS].filter((c) => !CONTRIBUTOR_COMMANDS.has(c)).sort();
    expect(refused).toEqual(PINNED_REFUSED);
    expect([...EDITORIAL_COMMANDS].sort()).toEqual([...PINNED_ALLOWED, ...PINNED_REFUSED].sort());
  });

  it("the allow-list is a subset of the editorial commands (a contributor can only ever be expressed through an editorial assertion)", () => {
    for (const c of CONTRIBUTOR_COMMANDS) expect(EDITORIAL_COMMANDS.has(c), c).toBe(true);
  });

  it("a contributor may never publish, approve, schedule, unpublish, delete, manage editorial settings, route work, edit or delete media or review the quarantine", () => {
    for (const never of ["content.publish", "editorial.approve", "content.schedule", "content.unpublish", "content.delete", "editorial.policySet", "editorial.assign", "media.review", "media.update", "media.delete"] as CommandName[]) {
      expect(CONTRIBUTOR_COMMANDS.has(never), never).toBe(false);
    }
  });

  it("it is narrower than a client editor's list on publishing and media, and widens it only by the review writes it needs", () => {
    for (const c of CONTRIBUTOR_COMMANDS) {
      if (c.startsWith("editorial.")) expect(CLIENT_EDITOR_COMMANDS.has(c), c).toBe(false);
      else expect(CLIENT_EDITOR_COMMANDS.has(c), c).toBe(true);
    }
  });

  it("assertContributorMayRun: a contributor is refused 403 contributor-command-not-allowed for EVERY registered command not on the list, with a well-formed body", () => {
    for (const name of Object.keys(COMMAND_REGISTRY) as CommandName[]) {
      if (CONTRIBUTOR_COMMANDS.has(name)) {
        expect(() => assertContributorMayRun({ contributor: true }, name), name).not.toThrow();
        continue;
      }
      let thrown: unknown;
      try {
        assertContributorMayRun({ contributor: true }, name);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, name).toBeInstanceOf(ControlProblem);
      const p = thrown as ControlProblem;
      expect(p.getStatus(), name).toBe(403);
      expect(p.slug, name).toBe(CONTRIBUTOR_COMMAND_NOT_ALLOWED);
      expect(p.getResponse(), name).toEqual({
        type: `${PROBLEM}contributor-command-not-allowed`,
        title: "Command not allowed for a contributor",
        status: 403,
        detail: expect.stringContaining(name),
      });
    }
  });

  it("assertContributorMayRun never refuses a principal that is not a contributor", () => {
    for (const name of Object.keys(COMMAND_REGISTRY) as CommandName[]) {
      expect(() => assertContributorMayRun({}, name), name).not.toThrow();
      expect(() => assertContributorMayRun({ contributor: false }, name), name).not.toThrow();
    }
  });
});

describe("M5-W1e EditorialAssertionGuard holds a contributor to the allow-list (real resolver, signed assertions)", () => {
  function guardFor(command: CommandName) {
    const reflector = { get: () => command } as never;
    const store = { consume: async () => true, close: async () => {} };
    const resolver = new RealEditorialPrincipalResolver({ keys: keySetOf(key), store, now: () => NOW + 1 });
    const guard = new EditorialAssertionGuard(reflector, resolver);
    const run = async (over: Partial<ClaimInput>) => {
      const a = { ...params, ...body };
      // A HIGH command (publish, schedule) is cross-bound to the request's WS4 approval: `apr` = its approvalId (Layer 4 verifies the header
      // before this guard runs in production; the resolver only reads the id).
      const high = COMMAND_REGISTRY[command].impactClass === "high";
      const approvalId = `apr-${randomUUID()}`;
      const headers: Record<string, string> = {
        "x-webdesk-editorial-assertion": mintEditorial(key, claimsFor({ cmd: command, cmh: computeCommandHash(command, a), ...(high ? { apr: approvalId } : {}), ...over })),
      };
      if (high) {
        headers["x-ws4-assertion"] = mintWs4Assertion({ approvalId, commandHash: computeCommandHash(command, a), exp: NOW + 120 }, "unit-test-ws4-key");
      }
      const request: Record<string, unknown> = { params, body, headers };
      const context = { getHandler: () => () => undefined, switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
      return { allowed: await guard.canActivate(context), request };
    };
    return run;
  }

  const editorial = [...EDITORIAL_COMMANDS].sort();
  for (const command of editorial) {
    const allowed = CONTRIBUTOR_COMMANDS.has(command);
    it(`${command}: ${allowed ? "runs" : "is refused 403 contributor-command-not-allowed"} with xc: true, and runs for a staff assertion`, async () => {
      const run = guardFor(command);
      // staff (no xc): always through; the marker only ever restricts
      const staff = await run({});
      expect(staff.allowed).toBe(true);
      expect((staff.request.editorial as { contributor?: boolean }).contributor).toBeUndefined();
      if (allowed) {
        const r = await run({ xc: true });
        expect(r.allowed).toBe(true);
        expect((r.request.editorial as { contributor?: boolean }).contributor).toBe(true);
      } else {
        const p = await refusal(run({ xc: true }));
        expect(p.getStatus()).toBe(403);
        expect(p.slug).toBe(CONTRIBUTOR_COMMAND_NOT_ALLOWED);
        expect(p.getResponse()).toMatchObject({ type: `${PROBLEM}contributor-command-not-allowed`, status: 403 });
      }
    });
  }

  it("a client editor (ce) is still held to ITS list, unchanged by W1e", async () => {
    const run = guardFor("content.delete");
    const p = await refusal(run({ ce: true }));
    expect(p.slug).toBe("client-command-not-allowed");
  });
});
