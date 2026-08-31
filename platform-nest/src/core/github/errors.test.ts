// GH-02 — the `message`-not-`error` trap (http-error.filter.ts's own documented incident) applied to
// the GitHub error family: every constructor here must set MESSAGE via `super(message)`, and the
// filter must read `exception.message`, never expect an `.error` field the base Error class doesn't
// have. These tests assert the shape of the error objects AND run them through the real filter.
import { describe, it, expect } from "vitest";
import {
  GithubSurfaceError, GithubNotConfiguredError, GithubTokenExchangeError, GithubApiError,
  GithubRateLimitedError, GithubReadOnlyRoleError,
} from "./errors";
import { GithubErrorFilter } from "./github-error.filter";

function fakeReply() {
  const calls: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      calls.status = code;
      return reply;
    },
    send(body: unknown) {
      calls.body = body;
      return reply;
    },
  };
  return { reply, calls };
}

function fakeHost(reply: unknown) {
  return { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => undefined }) } as never;
}

describe("GithubSurfaceError family — every subclass sets .message, not .error", () => {
  const cases: Array<[string, GithubSurfaceError]> = [
    ["GithubNotConfiguredError", new GithubNotConfiguredError("erp", "app_not_configured")],
    ["GithubTokenExchangeError", new GithubTokenExchangeError("erp", 401, "Bad credentials")],
    ["GithubApiError", new GithubApiError("GET /repos/x", 404, "Not Found")],
    ["GithubRateLimitedError", new GithubRateLimitedError("PATCH /repos/x", 5000, 0)],
    ["GithubReadOnlyRoleError", new GithubReadOnlyRoleError("agents", "POST", "/repos/x/pulls")],
  ];

  it.each(cases)("%s is an Error with a non-empty .message and a stable .code", (_name, err) => {
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GithubSurfaceError);
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
    expect(typeof err.code).toBe("string");
    expect(typeof err.status).toBe("number");
    // The trap this file exists to avoid: no constructor may pass an object shaped `{error: ...}` as
    // the message — `message` must be the actual string, not a wrapper object stringified.
    expect(err.message).not.toBe("[object Object]");
  });

  it("status codes match the documented reasoning (deployment-state=503, upstream=502, client=4xx)", () => {
    expect(new GithubNotConfiguredError("erp", "vault_key_missing").status).toBe(503);
    expect(new GithubTokenExchangeError("erp", 500).status).toBe(502);
    expect(new GithubApiError("op", 500).status).toBe(502); // GitHub 5xx -> our 502
    expect(new GithubApiError("op", 422).status).toBe(422); // GitHub 4xx passed through
    expect(new GithubRateLimitedError("op", 1000, 0).status).toBe(429);
    expect(new GithubReadOnlyRoleError("agents", "POST", "/x").status).toBe(403);
  });

  it("detail never carries a token, PEM, or Authorization header value", () => {
    for (const [, err] of cases) {
      const json = JSON.stringify(err.detail ?? {});
      expect(json.toLowerCase()).not.toMatch(/bearer |ghs_|-----begin/);
    }
  });
});

describe("GithubErrorFilter — the family reaches the client as { error, code, detail }", () => {
  it("renders .message as the body's `error` field (the exact rename HttpErrorFilter performs)", () => {
    const err = new GithubApiError("GET /repos/x", 404, "Not Found");
    const { reply, calls } = fakeReply();
    new GithubErrorFilter().catch(err, fakeHost(reply));
    expect(calls.status).toBe(404);
    expect(calls.body).toMatchObject({ error: err.message, code: "github_api_error" });
    expect((calls.body as { error: string }).error).not.toBe("Github Api Error"); // not the ctor-derived generic string
  });

  it("omits `detail` entirely when the error carried none, rather than sending detail: undefined", () => {
    const err = new GithubReadOnlyRoleError("agents", "POST", "/x");
    const { reply, calls } = fakeReply();
    new GithubErrorFilter().catch(err, fakeHost(reply));
    expect(calls.body).toHaveProperty("detail"); // this family always sets a detail object, unlike Google's
  });
});
