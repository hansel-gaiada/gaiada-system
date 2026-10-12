import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", async (orig) => {
  const real = await orig<typeof import("./platform")>();
  return { ...real, platformFetch: vi.fn() };
});

import { PlatformError, platformFetch } from "./platform";
import { assistFailureOf, parseAssist, runAssist } from "./webdeskAssist";
import { WireDrift } from "./webdeskContent";

const fetchMock = vi.mocked(platformFetch);
const BASE = "https://webdesk.gaiada.online/errors/";
const problem = (status: number, slug: string, extra: Record<string, unknown> = {}) =>
  new PlatformError(status, "x", undefined, undefined, undefined, { type: `${BASE}${slug}`, title: "t", status, detail: "d", ...extra });

const USAGE = { callsUsed: 3, callsLimit: 40, tokensEstimatedUsed: 900, tokensLimit: 120000, tokensAreEstimates: true, scope: "principal", automated: false };
const envelope = (kind: string, suggestions: unknown[], over: Record<string, unknown> = {}) => ({
  kind, itemId: "i1", version: 3, headVersion: 3, locale: "en", advisory: true, suggestions, provider: "openrouter", usage: USAGE, ...over,
});

beforeEach(() => { fetchMock.mockReset(); });

describe("parseAssist: every kind's suggestion shape", () => {
  it("meta_description", () => {
    const b = parseAssist(envelope("meta_description", [{ id: "s1", target: "/seo/description", text: "T", length: 1 }]));
    expect(b.suggestions[0]).toEqual({ id: "s1", kind: "meta_description", target: "/seo/description", text: "T", length: 1 });
    expect(b.usage).toEqual({ callsUsed: 3, callsLimit: 40, tokensEstimatedUsed: 900, tokensLimit: 120000 });
    expect(b.provider).toBe("openrouter");
    expect(b.notice).toBeNull();
  });
  it("outline", () => {
    const b = parseAssist(envelope("outline", [{ id: "s1", target: null, headings: [{ level: 2, text: "A" }], markdown: "## A" }]));
    expect(b.suggestions[0]).toMatchObject({ kind: "outline", headings: [{ level: 2, text: "A" }], markdown: "## A" });
  });
  it("faq", () => {
    const b = parseAssist(envelope("faq", [{ id: "s1", target: null, question: "Q?", answer: "A" }, { id: "s2", target: null, question: "R?", answer: "B" }]));
    expect(b.suggestions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });
  it("translate_draft carries the notice, on the body and on each suggestion", () => {
    const b = parseAssist(envelope("translate_draft", [{ id: "s1", target: null, sourcePath: "/blocks/0/props/h1", field: "h1", locale: "id", text: "T", status: "first_draft_needs_human", notice: "First draft — needs a human" }], { notice: "First draft — needs a human" }));
    expect(b.notice).toBe("First draft — needs a human");
    expect(b.suggestions[0]).toMatchObject({ kind: "translate_draft", field: "h1", locale: "id" });
  });
  it("alt_text", () => {
    const b = parseAssist(envelope("alt_text", [{ id: "s1", target: "/blocks/0/props/body", index: 0, imageRef: "/a.png", alt: "An image" }]));
    expect(b.suggestions[0]).toMatchObject({ kind: "alt_text", index: 0, imageRef: "/a.png", alt: "An image" });
  });
  it("a missing or odd `usage`/`provider` is information lost, not drift", () => {
    const b = parseAssist(envelope("faq", [{ id: "s1", target: null, question: "Q?", answer: "A" }], { usage: "nope", provider: 5 }));
    expect(b.usage).toBeNull();
    expect(b.provider).toBeNull();
  });
});

describe("parseAssist: a body that does not match the contract is drift, never suggestions", () => {
  const one = [{ id: "s1", target: null, question: "Q?", answer: "A" }];
  it.each([
    ["not advisory", envelope("faq", one, { advisory: false })],
    ["advisory missing", (() => { const e = envelope("faq", one); delete (e as Record<string, unknown>).advisory; return e; })()],
    ["unknown kind", envelope("rewrite", one)],
    ["suggestions missing", (() => { const e = envelope("faq", one); delete (e as Record<string, unknown>).suggestions; return e; })()],
    ["empty suggestions", envelope("faq", [])],
    ["a suggestion missing its member", envelope("faq", [{ id: "s1", target: null, question: "Q?" }])],
    ["a wrong member type", envelope("meta_description", [{ id: "s1", target: "/seo/description", text: "T", length: "1" }])],
    ["duplicate ids", envelope("faq", [...one, ...one])],
    ["itemId missing", (() => { const e = envelope("faq", one); delete (e as Record<string, unknown>).itemId; return e; })()],
    ["not an object", "nope"],
  ])("%s", (_name, body) => {
    expect(() => parseAssist(body)).toThrow(WireDrift);
  });
});

describe("assistFailureOf: the typed answers", () => {
  it("422 assist-not-applicable keeps its reason", () => {
    expect(assistFailureOf(problem(422, "assist-not-applicable", { reason: "no_text" }))).toEqual({ kind: "not_applicable", reason: "no_text" });
  });
  it("429 assist-budget-exceeded keeps retryAfterSeconds (and drops a bad one)", () => {
    expect(assistFailureOf(problem(429, "assist-budget-exceeded", { retryAfterSeconds: 3600, scope: "principal" }))).toEqual({ kind: "budget", retryAfterSeconds: 3600 });
    expect(assistFailureOf(problem(429, "assist-budget-exceeded", { retryAfterSeconds: "soon" }))).toEqual({ kind: "budget", retryAfterSeconds: null });
    expect(assistFailureOf(problem(429, "assist-budget-exceeded", { retryAfterSeconds: -5 }))).toEqual({ kind: "budget", retryAfterSeconds: null });
  });
  it("503 assist-unavailable keeps its reason", () => {
    expect(assistFailureOf(problem(503, "assist-unavailable", { reason: "gateway_busy" }))).toEqual({ kind: "unavailable", reason: "gateway_busy" });
    expect(assistFailureOf(problem(503, "assist-unavailable"))).toEqual({ kind: "unavailable", reason: null });
  });
  it("502 assist-output-invalid; any other 502 is just unreachable", () => {
    expect(assistFailureOf(problem(502, "assist-output-invalid", { reason: "not_json" }))).toEqual({ kind: "invalid_output" });
    expect(assistFailureOf(problem(502, "webdesk_ambiguous"))).toEqual({ kind: "unreachable" });
  });
  it("409 item-deleted; 403; 401; the 404s", () => {
    expect(assistFailureOf(problem(409, "item-deleted"))).toEqual({ kind: "deleted" });
    expect(assistFailureOf(new PlatformError(403, "forbidden"))).toEqual({ kind: "forbidden" });
    expect(assistFailureOf(new PlatformError(401, "no"))).toEqual({ kind: "session" });
    expect(assistFailureOf(problem(404, "item-not-found"))).toEqual({ kind: "not_found" });
    expect(assistFailureOf(problem(404, "version-not-found"))).toEqual({ kind: "not_found" });
    // a route this deployment does not serve is "not available", not "the item is gone"
    expect(assistFailureOf(new PlatformError(404, "Cannot POST /x"))).toEqual({ kind: "unavailable", reason: "not_served" });
  });
  it("400 carries the BFF's own sentence; a network error is unreachable; drift is drift", () => {
    expect(assistFailureOf(problem(400, "invalid_request"))).toMatchObject({ kind: "bad_request", message: "d" });
    expect(assistFailureOf(new TypeError("fetch failed"))).toEqual({ kind: "unreachable" });
    expect(assistFailureOf(new WireDrift("assist.kind", "string", 5))).toMatchObject({ kind: "drift" });
  });
  it("a failure never carries the response body", () => {
    const f = assistFailureOf(problem(422, "assist-not-applicable", { reason: "no_text", secret: "SUGGESTION TEXT" }));
    expect(JSON.stringify(f)).not.toContain("SUGGESTION TEXT");
  });
});

describe("runAssist", () => {
  it("POSTs {kind} to the item's assist route as the caller, with no version unless asked", async () => {
    fetchMock.mockResolvedValue(envelope("faq", [{ id: "s1", target: null, question: "Q?", answer: "A" }], { itemId: "item/1" }));
    const r = await runAssist("u1", "co 1", "gaiada", "site-1", "item/1", "faq");
    expect(r).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, userId, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/co%201/modules/webdev/content/sites/gaiada/site-1/items/item%2F1/assist");
    expect(userId).toBe("u1");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ kind: "faq" });
  });
  it("names the version when asked", async () => {
    fetchMock.mockResolvedValue(envelope("faq", [{ id: "s1", target: null, question: "Q?", answer: "A" }]));
    await runAssist("u1", "co", "gaiada", "s", "i1", "faq", 2);
    expect(JSON.parse(String((fetchMock.mock.calls[0][2] as RequestInit).body))).toEqual({ kind: "faq", version: 2 });
  });
  it("a refusal comes back as data", async () => {
    fetchMock.mockImplementation(async () => { throw problem(429, "assist-budget-exceeded", { retryAfterSeconds: 90 }); });
    expect(await runAssist("u1", "co", "gaiada", "s", "i1", "outline")).toEqual({ ok: false, failure: { kind: "budget", retryAfterSeconds: 90 } });
  });
  it("an answer for another kind or item is not an answer to this call", async () => {
    fetchMock.mockResolvedValue(envelope("faq", [{ id: "s1", target: null, question: "Q?", answer: "A" }]));
    expect(await runAssist("u1", "co", "gaiada", "s", "i1", "outline")).toMatchObject({ ok: false, failure: { kind: "drift" } });
    fetchMock.mockResolvedValue(envelope("faq", [{ id: "s1", target: null, question: "Q?", answer: "A" }], { itemId: "other" }));
    expect(await runAssist("u1", "co", "gaiada", "s", "i1", "faq")).toMatchObject({ ok: false, failure: { kind: "drift" } });
  });
  it("a 200 that fails validation is drift, not suggestions", async () => {
    fetchMock.mockResolvedValue({ kind: "faq", itemId: "i1" });
    expect(await runAssist("u1", "co", "gaiada", "s", "i1", "faq")).toMatchObject({ ok: false, failure: { kind: "drift" } });
  });
});
