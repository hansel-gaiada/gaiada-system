// SCP-1d — `checkEach`: ONE CheckResources request for many resources, each with its OWN actions (the Social feed asks each post for its primary
// step). It needs no running Cerbos: `fetch` is stubbed, so this pins the request it builds (the same principal and resource payloads `check` sends,
// chunks of at most 50) and how it reads the answer (by position, confirmed by the echoed kind and id, failing closed).
import { describe, it, expect, vi, afterEach } from "vitest";
import { CERBOS_BATCH_LIMIT, checkEach, type Resource } from "./cerbos";
import type { Principal } from "./principal";

const T = "aaaaaaaa-0000-0000-0000-000000000001";
const me: Principal = { userId: "u1", assurance: "high", companies: [T], roles: [], rootCompanies: [T], sessionVersion: 1 };
const res = (i: number): Resource => ({ kind: "social_post", id: `post-${i}`, tenantId: T, module: "social" });
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ resource: res(i), actions: i % 2 === 0 ? ["author"] : ["approve", "proofread"] }));

type Sent = { principal: unknown; resources: Array<{ actions: string[]; resource: { kind: string; id: string } }> };
/** A Cerbos that allows the actions `allowed(resourceId, action)` says, answering in the order it was asked (or as `shape` rewrites it). */
function stubCerbos(allowed: (id: string, action: string) => boolean, shape: (results: unknown[]) => unknown[] = (r) => r) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Sent;
    sent.push(body);
    const results = body.resources.map((r) => ({
      resource: { kind: r.resource.kind, id: r.resource.id },
      actions: Object.fromEntries(r.actions.map((a) => [a, allowed(r.resource.id, a) ? "EFFECT_ALLOW" : "EFFECT_DENY"])),
    }));
    return new Response(JSON.stringify({ results: shape(results) }), { status: 200 });
  }));
  return sent;
}
afterEach(() => vi.unstubAllGlobals());

describe("checkEach", () => {
  it("is one request for a page of 50, each resource asked its own actions, answered per input in order", async () => {
    const sent = stubCerbos((id, a) => a === "author" || id === "post-1");
    const out = await checkEach(me, items(CERBOS_BATCH_LIMIT));
    expect(sent).toHaveLength(1);
    expect(sent[0].resources).toHaveLength(CERBOS_BATCH_LIMIT);
    expect(sent[0].resources[0].actions).toEqual(["author"]);
    expect(sent[0].resources[1].actions).toEqual(["approve", "proofread"]);
    expect(sent[0].resources[1].resource).toMatchObject({ kind: "social_post", id: "post-1" });
    expect(out).toHaveLength(CERBOS_BATCH_LIMIT);
    expect(out[0]).toEqual({ author: true });
    expect(out[1]).toEqual({ approve: true, proofread: true });
    expect(out[3]).toEqual({ approve: false, proofread: false });
  });

  it("splits a longer list into requests of at most 50 and keeps the input order", async () => {
    const sent = stubCerbos((id) => Number(id.slice(5)) % 3 === 0);
    const out = await checkEach(me, items(120));
    expect(sent.map((s) => s.resources.length)).toEqual([50, 50, 20]);
    expect(out).toHaveLength(120);
    out.forEach((o, i) => expect(Object.values(o).every((v) => v === (i % 3 === 0)), `${i}`).toBe(true));
  });

  it("answers an empty list without asking", async () => {
    const sent = stubCerbos(() => true);
    expect(await checkEach(me, [])).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("fails closed: a response of the wrong length, or a result for another resource, allows nothing", async () => {
    stubCerbos(() => true, (r) => r.slice(1));
    const short = await checkEach(me, items(3));
    expect(short.every((o) => Object.values(o).every((v) => v === false))).toBe(true);
    stubCerbos(() => true, (r) => (r as Array<{ resource: { kind: string; id: string } }>).map((x, i) => (i === 1 ? { ...x, resource: { kind: "social_post", id: "someone-else" } } : x)));
    const swapped = await checkEach(me, items(3));
    expect(swapped[0]).toEqual({ author: true });
    expect(swapped[1]).toEqual({ approve: false, proofread: false });
    expect(swapped[2]).toEqual({ author: true });
  });

  it("throws on an HTTP error, so 'Cerbos is down' is never read as 'nothing is allowed'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    await expect(checkEach(me, items(2))).rejects.toThrow("cerbos 503");
  });
});
