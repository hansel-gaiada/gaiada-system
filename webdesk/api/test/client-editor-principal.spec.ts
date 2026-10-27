// WSK-49b — the client-editor marker, unit level (no database): the optional `ce` claim, the principal's
// `clientEditor` flag in both resolvers, and the command allow-list a client principal is held to.
// The HTTP enforcement (422 field-not-client-editable, 403 client-command-not-allowed) is
// client-editor-enforcement.spec.ts; the adversarial rows for `ce` are in editorial-assertion-matrix.spec.ts.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { COMMAND_REGISTRY, EDITORIAL_COMMANDS, CLIENT_EDITOR_COMMANDS, type CommandName } from "../src/control/command-types";
import { ControlProblem } from "../src/control/content/content-problem";
import { verifyEditorialAssertion } from "../src/control/auth/editorial-assertion";
import { RealEditorialPrincipalResolver } from "../src/control/auth/real-editorial-principal-resolver";
import { DevModeEditorialPrincipalResolver, DEV_EDITORIAL_PRINCIPAL_HEADER } from "../src/control/auth/dev-mode-editorial-principal-resolver";
import { assertClientMayRun } from "../src/control/auth/client-editor";
import { computeCommandHash } from "../src/control/auth/ws4-assertion";
import { freshKey, keySetOf, mintEditorial, mintRaw, wireHeader, wirePayload, type ClaimInput } from "./editorial-assertion-kit";

const NOW = 1_760_000_000;
const key = freshKey("wde-ce-test");
const params = { tenantSlug: "acme", siteId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4" };
const body = { collectionKey: "page", locale: "en", slug: "page.a", fields: { title: "T" } };

function claimsFor(over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    sub: "erp-user-client-1",
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

describe("WSK-49b the `ce` claim: verifier", () => {
  it("ce: true is accepted and returned in the verified claims", async () => {
    const claims = await verifyEditorialAssertion(mintEditorial(key, claimsFor({ ce: true })), keySetOf(key), expectation, NOW + 1);
    expect(claims.ce).toBe(true);
  });

  it("ce: false is accepted; an absent ce stays absent", async () => {
    expect((await verifyEditorialAssertion(mintEditorial(key, claimsFor({ ce: false })), keySetOf(key), expectation, NOW + 1)).ce).toBe(false);
    expect((await verifyEditorialAssertion(mintEditorial(key, claimsFor()), keySetOf(key), expectation, NOW + 1)).ce).toBeUndefined();
  });

  it("a non-boolean ce is refused 401 editorial-assertion-claims, whatever its type", async () => {
    for (const bad of ["true", 1, null, [], {}]) {
      const jws = mintRaw(wireHeader(key.kid), { ...wirePayload(claimsFor()), ce: bad }, key.privateKey);
      const p = await refusal(verifyEditorialAssertion(jws, keySetOf(key), expectation, NOW + 1));
      expect(p.getStatus(), JSON.stringify(bad)).toBe(401);
      expect(p.slug, JSON.stringify(bad)).toBe("editorial-assertion-claims");
    }
  });
});

describe("WSK-49b the principal exposes clientEditor", () => {
  function realResolver() {
    const store = { consume: async () => true, close: async () => {} };
    return new RealEditorialPrincipalResolver({ keys: keySetOf(key), store, now: () => NOW + 1 });
  }
  const reqFor = (jws: string) => ({ params, headers: { "x-webdesk-editorial-assertion": jws } }) as never;
  const args = { ...params, ...body };

  it("real resolver: ce: true -> clientEditor true", async () => {
    const p = await realResolver().resolve(reqFor(mintEditorial(key, claimsFor({ ce: true }))), "content.create", args);
    expect(p.clientEditor).toBe(true);
    expect(p.sub).toBe("erp-user-client-1");
  });

  it("real resolver: ce absent or false -> the principal is exactly what it was before (no clientEditor key at all)", async () => {
    for (const over of [{}, { ce: false }]) {
      const p = await realResolver().resolve(reqFor(mintEditorial(key, claimsFor(over))), "content.create", args);
      expect(p.clientEditor).toBeUndefined();
      expect(Object.keys(p).sort()).toEqual(["jti", "pk", "sub"]);
    }
  });

  const dev = new DevModeEditorialPrincipalResolver();
  const devReq = (h: string) => ({ headers: { [DEV_EDITORIAL_PRINCIPAL_HEADER]: h } }) as never;

  it("dev resolver: {ce:true} -> clientEditor true; a bare subject and {ce:false} -> not a client", async () => {
    expect((await dev.resolve(devReq(JSON.stringify({ sub: "u1", ce: true })), "content.update", {})).clientEditor).toBe(true);
    expect((await dev.resolve(devReq("u1"), "content.update", {})).clientEditor).toBeUndefined();
    expect((await dev.resolve(devReq(JSON.stringify({ sub: "u1", ce: false })), "content.update", {})).clientEditor).toBeUndefined();
  });

  it("dev resolver: a non-boolean ce is 401 editorial-assertion-malformed", async () => {
    for (const bad of ["yes", 1, null, []]) {
      const p = await refusal(dev.resolve(devReq(JSON.stringify({ sub: "u1", ce: bad })), "content.update", {}));
      expect(p.getStatus()).toBe(401);
      expect(p.slug).toBe("editorial-assertion-malformed");
    }
  });
});

describe("WSK-49b the commands a client principal may run", () => {
  const refused = [...EDITORIAL_COMMANDS].filter((c) => !CLIENT_EDITOR_COMMANDS.has(c)).sort();

  it("the refused editorial commands are exactly schedule, unpublish, delete (content), delete (media), the M5-W1q media.review and the nine M5-W2b editorial.* review writes", () => {
    expect(refused).toEqual(
      [
        "content.delete",
        "content.schedule",
        "content.unpublish",
        "media.delete",
        "media.review",
        "editorial.submit",
        "editorial.withdraw",
        "editorial.requestChanges",
        "editorial.seoSignoff",
        "editorial.approve",
        "editorial.assign",
        "editorial.comment",
        "editorial.commentResolve",
        "editorial.policySet",
      ].sort(),
    );
  });

  it("the allowed set is create, update, restoreVersion, publish, previewToken (+ its revoke), media.uploadToken and media.update", () => {
    expect([...CLIENT_EDITOR_COMMANDS].sort()).toEqual([
      "content.create",
      "content.previewToken",
      "content.previewTokenRevoke",
      "content.publish",
      "content.restoreVersion",
      "content.update",
      "media.update",
      "media.uploadToken",
    ]);
  });

  it("the allow-list is a subset of the editorial commands (a client can only ever be expressed through an editorial assertion)", () => {
    for (const c of CLIENT_EDITOR_COMMANDS) expect(EDITORIAL_COMMANDS.has(c), c).toBe(true);
  });

  it("assertClientMayRun: a client is refused 403 client-command-not-allowed for EVERY registered command not on the list", () => {
    for (const name of Object.keys(COMMAND_REGISTRY) as CommandName[]) {
      if (CLIENT_EDITOR_COMMANDS.has(name)) {
        expect(() => assertClientMayRun({ clientEditor: true }, name), name).not.toThrow();
        continue;
      }
      let thrown: unknown;
      try {
        assertClientMayRun({ clientEditor: true }, name);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, name).toBeInstanceOf(ControlProblem);
      expect((thrown as ControlProblem).getStatus(), name).toBe(403);
      expect((thrown as ControlProblem).slug, name).toBe("client-command-not-allowed");
    }
  });

  it("assertClientMayRun never refuses a principal that is not a client", () => {
    for (const name of Object.keys(COMMAND_REGISTRY) as CommandName[]) {
      expect(() => assertClientMayRun({}, name), name).not.toThrow();
      expect(() => assertClientMayRun({ clientEditor: false }, name), name).not.toThrow();
    }
  });
});
