import { describe, it, expect, vi, beforeEach } from "vitest";

// "Request an API key": the strict 202 parser, the action's route/body and its error mapping, plus the decide-response parser
// and the pure helpers (tool-args, labelling, plain-words errors). The REAL BFF is driven through these same functions by
// platform-nest's `webdesk-content-ui-contract.test.ts`.

vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ id: "u1", companies: [], roles: [] })) };
});
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./entities", () => ({ listMembers: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { getSessionUserId } from "./session-server";
import { findKeyTarget, parseKeyMintDecision, parseKeyRequest, resultFromError, WireDrift } from "./webdeskContent";
import { requestKeyAction } from "./webdeskContentActions";
import {
  describeKeyMintError, isKeyMintApproval, KEY_REQUEST_COPY, keyRequestFailureCopy, parseKeyMintArgs, type WdResult,
} from "./webdeskContentModel";

const fetchMock = vi.mocked(platformFetch);
const session = vi.mocked(getSessionUserId);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const ENV = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function problem(status: number, slug: string) {
  return new PlatformError(status, slug, undefined, undefined, undefined, { type: `https://webdesk.gaiada.online/errors/${slug}`, title: slug, status });
}

beforeEach(() => { fetchMock.mockReset(); session.mockResolvedValue("u1"); });

describe("parseKeyRequest: strict", () => {
  it("a NEW filing is `{approvalId}` and is not already-pending", () => {
    expect(parseKeyRequest({ approvalId: "ap-1" })).toEqual({ approvalId: "ap-1", alreadyPending: false });
  });

  it("`alreadyPending: true` is carried", () => {
    expect(parseKeyRequest({ approvalId: "ap-1", alreadyPending: true })).toEqual({ approvalId: "ap-1", alreadyPending: true });
  });

  it.each<[string, unknown, RegExp]>([
    ["not an object", "ap-1", /<root>|key-request: expected object/],
    ["a missing approvalId", { alreadyPending: true }, /key-request\.approvalId: expected present/],
    ["a non-string approvalId", { approvalId: 7 }, /key-request\.approvalId: expected string, got number/],
    ["an alreadyPending that is not exactly true (false)", { approvalId: "a", alreadyPending: false }, /alreadyPending: expected true or absent, got boolean/],
    ["an alreadyPending that is a string", { approvalId: "a", alreadyPending: "yes" }, /alreadyPending: expected true or absent, got string/],
    ["an unknown key (a 409-shaped or renamed field must not read as 'filed')", { approvalId: "a", status: "pending" }, /key-request\.status: expected approvalId\|alreadyPending, got string/],
  ])("drift: %s", (_n, body, re) => {
    expect(() => parseKeyRequest(body)).toThrow(WireDrift);
    expect(() => parseKeyRequest(body)).toThrow(re);
  });
});

describe("requestKeyAction: route, body and the existing error machinery", () => {
  it("POSTs the control-plane route (siteId in the path, tenantSlug in the body) and returns the filed approval", async () => {
    fetchMock.mockResolvedValue({ approvalId: "ap-1" });
    const r = await requestKeyAction(SCOPE, ENV, "read");
    expect(r).toEqual({ kind: "ok", data: { approvalId: "ap-1", alreadyPending: false } });
    const [path, userId, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/co-1/modules/webdev/control/sites/site-1/keys");
    expect(userId).toBe("u1");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ tenantSlug: "gaiada", envId: ENV, scope: "read" });
  });

  it("202 alreadyPending", async () => {
    fetchMock.mockResolvedValue({ approvalId: "ap-0", alreadyPending: true });
    expect(await requestKeyAction(SCOPE, ENV, "write")).toEqual({ kind: "ok", data: { approvalId: "ap-0", alreadyPending: true } });
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body)).scope).toBe("write");
  });

  it("404 environment-not-found is not_found (and says so in plain words)", async () => {
    fetchMock.mockRejectedValue(problem(404, "environment-not-found"));
    const r = await requestKeyAction(SCOPE, ENV, "read");
    expect(r).toEqual({ kind: "not_found", slug: "environment-not-found" });
    expect(keyRequestFailureCopy(r as Exclude<WdResult<unknown>, { kind: "ok" }>)).toBe("That environment isn't part of this site.");
  });

  it("404 site-not-found (another company's site) is not_found", async () => {
    fetchMock.mockRejectedValue(problem(404, "site-not-found"));
    const r = await requestKeyAction(SCOPE, ENV, "read");
    expect(r).toEqual({ kind: "not_found", slug: "site-not-found" });
    expect(keyRequestFailureCopy(r as Exclude<WdResult<unknown>, { kind: "ok" }>)).toMatch(/site doesn't exist or isn't one of your company's/);
  });

  it("403 (Cerbos `promote`) is forbidden: \"You can't request API keys for this site.\"", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "forbidden"));
    const r = await requestKeyAction(SCOPE, ENV, "read");
    expect(r.kind).toBe("forbidden");
    expect(keyRequestFailureCopy(r as Exclude<WdResult<unknown>, { kind: "ok" }>)).toBe("You can't request API keys for this site.");
  });

  it.each([
    ["editorial_unavailable", new PlatformError(503, "editorial_unavailable", undefined, undefined, undefined, { error: "editorial_unavailable" })],
    ["webdesk_not_configured", new PlatformError(503, "webdesk_not_configured", undefined, undefined, "webdesk_not_configured", { error: "webdesk_not_configured", reason: "webdesk_not_configured" })],
  ])("503 %s is the workspace's existing unavailable state, with its existing copy", async (_n, err) => {
    fetchMock.mockRejectedValue(err);
    const r = await requestKeyAction(SCOPE, ENV, "read");
    expect(r).toMatchObject({ kind: "unavailable", code: "editorial_unavailable" });
    expect(keyRequestFailureCopy(r as Exclude<WdResult<unknown>, { kind: "ok" }>)).toBe("Editing is unavailable. WebDesk can't be reached. Nothing has been lost.");
  });

  it("400 invalid_request is `invalid`", async () => {
    fetchMock.mockRejectedValue(new PlatformError(400, "envId must be a uuid", undefined, undefined, "invalid_request", { error: "envId must be a uuid", reason: "invalid_request" }));
    expect((await requestKeyAction(SCOPE, ENV, "read")).kind).toBe("invalid");
  });

  it("a 2xx that breaks the contract is loud drift, never 'filed'", async () => {
    fetchMock.mockResolvedValue({ id: "ap-1" });
    const r = await requestKeyAction(SCOPE, ENV, "read");
    expect(r).toMatchObject({ kind: "unavailable", code: "contract_drift" });
    expect(keyRequestFailureCopy(r as Exclude<WdResult<unknown>, { kind: "ok" }>)).toMatch(/something unexpected/);
  });

  it("never calls the BFF for a request it can see is malformed", async () => {
    expect((await requestKeyAction(SCOPE, "", "read")).kind).toBe("invalid");
    expect((await requestKeyAction(SCOPE, ENV, "admin" as never)).kind).toBe("invalid");
    expect((await requestKeyAction({ tenantSlug: "", siteId: "s" }, ENV, "read")).kind).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no session: unavailable, no call", async () => {
    session.mockResolvedValue(null as never);
    expect((await requestKeyAction(SCOPE, ENV, "read")).kind).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the existing error shapes are untouched: an unknown 404 is still `not_served`, a 409 is still a conflict", () => {
    expect(resultFromError(new PlatformError(404, "Cannot POST /x"))).toEqual({ kind: "not_enabled", reason: "not_served" });
    expect(resultFromError(problem(404, "item-not-found"))).toEqual({ kind: "not_found", slug: "item-not-found" });
    expect(resultFromError(problem(409, "version-conflict")).kind).toBe("conflict");
  });
});

describe("failure copy for the rest of the kinds", () => {
  const copy = (r: Exclude<WdResult<unknown>, { kind: "ok" }>) => keyRequestFailureCopy(r);
  it("is plain words, never a raw slug", () => {
    expect(copy({ kind: "not_enabled", reason: "module_disabled" })).toMatch(/switched off/);
    expect(copy({ kind: "not_enabled", reason: "not_served" })).toMatch(/isn't available on this deployment yet/);
    expect(copy({ kind: "invalid", issues: [], message: "Choose an environment and a scope." })).toBe("Choose an environment and a scope.");
  });
});

describe("parseKeyMintDecision: the decide response, strictly", () => {
  const executed = { command: "key.mint", executionStatus: "executed", apiKeyId: "k1", envId: ENV, scope: "read", plaintextOnce: "wdk_SECRET" };

  it("executed with the key", () => {
    expect(parseKeyMintDecision({ ok: true, webdesk: executed })).toEqual({ status: "executed", envId: ENV, scope: "read", apiKeyId: "k1", plaintextOnce: "wdk_SECRET" });
  });

  it("executed whose 2xx carried no key (`plaintextOnce: null`) is not a key", () => {
    expect(parseKeyMintDecision({ ok: true, webdesk: { ...executed, plaintextOnce: null, apiKeyId: null } })).toMatchObject({ status: "executed", plaintextOnce: null, apiKeyId: null });
  });

  it("failed carries the typed error (and optionally env/scope)", () => {
    expect(parseKeyMintDecision({ ok: true, webdesk: { command: "key.mint", executionStatus: "failed", error: "webdesk_unreachable" } }))
      .toEqual({ status: "failed", envId: null, scope: null, error: "webdesk_unreachable" });
  });

  it("a rejection has no `webdesk`: nothing in-band", () => {
    expect(parseKeyMintDecision({ ok: true })).toBeNull();
  });

  it.each<[string, unknown]>([
    ["another command", { ok: true, webdesk: { ...executed, command: "content.publish" } }],
    ["an unknown executionStatus", { ok: true, webdesk: { ...executed, executionStatus: "executing" } }],
    ["a missing plaintextOnce", { ok: true, webdesk: { command: "key.mint", executionStatus: "executed", apiKeyId: "k", envId: ENV, scope: "read" } }],
    ["a non-string plaintextOnce", { ok: true, webdesk: { ...executed, plaintextOnce: 12345 } }],
    ["an out-of-set scope", { ok: true, webdesk: { ...executed, scope: "admin" } }],
    ["a failed outcome with no error", { ok: true, webdesk: { command: "key.mint", executionStatus: "failed" } }],
  ])("drift: %s", (_n, body) => {
    expect(() => parseKeyMintDecision(body)).toThrow(WireDrift);
  });

  it("a drift message names the path and the TYPE it got, never the value (a malformed key cannot leak through an error)", () => {
    for (const body of [
      { ok: true, webdesk: { ...executed, plaintextOnce: { v: "wdk_SECRET" } } },
      { ok: true, webdesk: { ...executed, scope: "wdk_SECRET" } },
      { ok: true, webdesk: { ...executed, envId: ["wdk_SECRET"] } },
    ]) {
      let msg = "";
      try { parseKeyMintDecision(body); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toBe("");
      expect(msg).not.toContain("wdk_SECRET");
    }
  });
});

describe("key.mint labelling helpers", () => {
  it("isKeyMintApproval: by workflow or by tool name; a publish is not one", () => {
    expect(isKeyMintApproval({ workflowId: "key.mint", toolName: "webdesk.key.mint" })).toBe(true);
    expect(isKeyMintApproval({ workflowId: "key.mint" })).toBe(true);
    expect(isKeyMintApproval({ toolName: "webdesk.key.mint" })).toBe(true);
    expect(isKeyMintApproval({ workflowId: "content.publish", toolName: "webdesk.content.requestPublish" })).toBe(false);
    expect(isKeyMintApproval({})).toBe(false);
  });

  it("parseKeyMintArgs reads {tenantSlug, siteId, envId, scope} and refuses anything else", () => {
    expect(parseKeyMintArgs({ command: "key.mint", tenantSlug: "gaiada", siteId: "s1", envId: ENV, scope: "write", summary: { title: "t" }, commandHash: "h" }))
      .toEqual({ tenantSlug: "gaiada", siteId: "s1", envId: ENV, scope: "write" });
    expect(parseKeyMintArgs({ tenantSlug: "g", siteId: "s", envId: ENV, scope: "admin" })).toBeNull();
    expect(parseKeyMintArgs({ tenantSlug: "g", siteId: "s", scope: "read" })).toBeNull();
    expect(parseKeyMintArgs({ tenantSlug: "g", siteId: "s", items: [] })).toBeNull();
    expect(parseKeyMintArgs(null)).toBeNull();
    expect(parseKeyMintArgs("x")).toBeNull();
  });

  it("describeKeyMintError: the executor's tokens in plain words", () => {
    expect(describeKeyMintError("webdesk_unreachable")).toBe("WebDesk couldn't be reached. Nothing was sent.");
    expect(describeKeyMintError("webdesk_refused: 409 key-limit")).toBe("WebDesk refused the request (409 key-limit).");
    expect(describeKeyMintError("webdesk_ambiguous")).toMatch(/couldn't confirm whether WebDesk created the key/);
    expect(describeKeyMintError("webdesk_args_tampered")).toMatch(/no longer matches what was filed/);
    expect(describeKeyMintError("something_new")).toBe("Reason: something_new");
    expect(describeKeyMintError(null)).toBe("No reason was recorded.");
  });

  it("the filing copy is exactly the agreed words", () => {
    expect(KEY_REQUEST_COPY.filed).toBe("Request filed. Someone else must approve it before the key is created.");
    expect(KEY_REQUEST_COPY.alreadyPending).toBe("Already requested: a request for this environment and scope is waiting for approval.");
    expect(KEY_REQUEST_COPY.viewRequest).toBe("View the request");
    expect(KEY_REQUEST_COPY.writeHint).toBe("Write keys can change content through the API. Most sites only need read.");
  });
});

describe("findKeyTarget: cosmetic names for the approval summary", () => {
  const sites = { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [{ envId: ENV, name: "production", domain: null, status: "active" }] }] }] };

  it("resolves the site and environment names (case-insensitive on the uuid)", async () => {
    fetchMock.mockResolvedValue(sites);
    expect(await findKeyTarget("u1", "co-1", "gaiada", "site-1", ENV.toUpperCase())).toEqual({ siteName: "gaiada.com", environmentName: "production" });
  });

  it("an environment that is not on the site yields a null name, not a failure", async () => {
    fetchMock.mockResolvedValue(sites);
    expect(await findKeyTarget("u1", "co-1", "gaiada", "site-1", "00000000-0000-4000-8000-000000000000")).toEqual({ siteName: "gaiada.com", environmentName: null });
  });

  it("a failed read yields null (the page shows ids), never an exception", async () => {
    fetchMock.mockRejectedValue(new PlatformError(503, "editorial_unavailable"));
    expect(await findKeyTarget("u1", "co-1", "gaiada", "site-1", ENV)).toBeNull();
    fetchMock.mockResolvedValue({ tenants: [] });
    expect(await findKeyTarget("u1", "co-1", "gaiada", "site-1", ENV)).toBeNull();
  });
});
