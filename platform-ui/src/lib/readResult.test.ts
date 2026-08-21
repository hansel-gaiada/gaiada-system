// AGN-4 — the shared reader-result mapper.
//
// This is the half of criterion 5 that lives BELOW the component: the type that stops a refusal
// becoming an empty array before any page gets a chance to render it honestly. Six near-duplicate
// `safe()` helpers drifted into four different rules because each was private and nothing compared
// them (`readerDegrade.test.ts` pins that); this exists so the seventh reader has one correct shape
// to reach for instead of inventing a fifth.
import { describe, it, expect } from "vitest";
import { readResult } from "./readResult";
import { PlatformError } from "./platform";

const reject = (e: unknown) => Promise.reject(e);

describe("AGN-4 · readResult", () => {
  it("passes a successful read through, and an EMPTY success stays a success", () => {
    return Promise.all([
      readResult(Promise.resolve([1, 2])).then((r) => expect(r).toEqual({ kind: "ok", data: [1, 2] })),
      // The distinction the whole type exists for: [] from a 200 is EVIDENCE of emptiness and must
      // remain `ok`. Only a refusal is not-ok.
      readResult(Promise.resolve([])).then((r) => expect(r).toEqual({ kind: "ok", data: [] })),
    ]);
  });

  it("403 becomes `forbidden`, never `ok` with an empty payload", async () => {
    const r = await readResult(reject(new PlatformError(403, "cerbos denied")));
    expect(r).toEqual({ kind: "forbidden" });
  });

  it("carries the backend's message on `unavailable`, because the operator needs it", async () => {
    const r = await readResult(reject(new PlatformError(503, "keycloak unreachable")));
    expect(r).toEqual({ kind: "unavailable", reason: "keycloak unreachable" });
  });

  it("🔴 a non-PlatformError is `unavailable`, NOT emptiness — this is the bare-catch defect", async () => {
    // `people.ts` used to swallow exactly this class of failure into []: a timeout, a socket error, a
    // JSON parse failure, or a bug in the reader itself, all rendered as "there is nothing here".
    const r = await readResult(reject(new TypeError("fetch failed")));
    expect(r.kind).toBe("unavailable");
    expect(r).toMatchObject({ reason: "fetch failed" });
  });

  it("a thrown non-Error still degrades safely rather than crashing the mapper", async () => {
    const r = await readResult(reject("just a string"));
    expect(r).toEqual({ kind: "unavailable", reason: "unknown error" });
  });

  it("404 is only absence when the CALLER opts in, and 403 is never absence even then", async () => {
    // Opt-in is the point: a module-guarded LIST route 404s when the module is off, which genuinely
    // is not a refusal. Making that automatic would let any reader degrade a 404 without deciding
    // whether absence is a real answer for its route.
    const optedIn = await readResult(reject(new PlatformError(404, "no such route")), { absentAsEmpty: [] as number[] });
    expect(optedIn).toEqual({ kind: "ok", data: [] });

    const notOptedIn = await readResult(reject(new PlatformError(404, "no such route")));
    expect(notOptedIn.kind).toBe("unavailable");

    // The load-bearing one: opting into absence must NOT quietly opt into swallowing denials too.
    const denied = await readResult(reject(new PlatformError(403, "cerbos denied")), { absentAsEmpty: [] as number[] });
    expect(
      denied,
      "absentAsEmpty must never absorb a 403 — that would reintroduce the exact collapse (denial " +
        "rendered as no-data) this type was written to prevent",
    ).toEqual({ kind: "forbidden" });
  });
});
