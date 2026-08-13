// SMM-08 — the cross-service hash contract. Pure functions, no DB, no Cerbos.
//
// The three FIXED VECTORS below are copied verbatim from `mcp-hub/src/approval-grant.ts`'s header,
// which publishes them for exactly this purpose ("copy them into the platform-side test"). They are
// the only mechanical link between two implementations of the same algorithm living in two
// standalone projects that share no code. If either side drifts, the vectors break on the side that
// drifted — which is the whole point, and why these must never be "updated to match" a new output.
import { describe, it, expect } from "vitest";
import { canonicalJson, argsSha256, variantPublishArgs, variantArgsSha256 } from "./canonical-args";

describe("canonical args (SMM-08 / addendum D-15) — the hub's algorithm, mirrored", () => {
  it("reproduces the hub's three published fixed vectors exactly", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(argsSha256({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");

    expect(canonicalJson({ b: 1, a: { d: 1, c: [3, { y: 2, x: 1 }] } }))
      .toBe('{"a":{"c":[3,{"x":1,"y":2}],"d":1},"b":1}');
    expect(argsSha256({ b: 1, a: { d: 1, c: [3, { y: 2, x: 1 }] } }))
      .toBe("f2b017ad2046767a1fb4a845843b145aef66713aa8adef3952e980dc15f44ce4");

    expect(canonicalJson({ runId: "r1", repo: "acme/site" })).toBe('{"repo":"acme/site","runId":"r1"}');
    expect(argsSha256({ runId: "r1", repo: "acme/site" }))
      .toBe("756a6e9ac2f5873539d73f9a95008a46ed673573ade26e86ff42a6b27b1f9dad");
  });

  it("sorts keys by UTF-16 code unit, NOT by locale or numeric value", () => {
    // The trap the hub's header calls out: JS reorders integer-like keys ("2" before "10") on a
    // plain object, so relying on insertion order would encode an engine quirk into a cross-service
    // contract. The manual sort is what makes this deterministic.
    expect(canonicalJson({ "10": 1, "2": 2 })).toBe('{"10":1,"2":2}');
    // Uppercase sorts before lowercase in code-unit order; localeCompare would say otherwise.
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it("preserves array order — arrays are data, not sets", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    // Media order is the carousel order a human approved; sorting it would silently reorder a post.
    expect(canonicalJson({ media: [{ fileId: "b" }, { fileId: "a" }] }))
      .toBe('{"media":[{"fileId":"b"},{"fileId":"a"}]}');
  });

  it("omits undefined-valued keys but keeps explicit nulls", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined])).toBe("[null]"); // JSON.stringify semantics for array holes
  });

  it("does NOT normalize Unicode — composed and decomposed forms are different arguments", () => {
    const composed = "café";       // é as one code point
    const decomposed = "café";    // e + combining acute
    expect(argsSha256({ body: composed })).not.toBe(argsSha256({ body: decomposed }));
  });

  it("emits non-finite numbers as null, matching JSON.stringify", () => {
    expect(canonicalJson({ n: NaN })).toBe('{"n":null}');
    expect(canonicalJson({ n: Infinity })).toBe('{"n":null}');
  });
});

describe("variant publish args — what an approval is actually bound to", () => {
  const base = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    id: "22222222-2222-2222-2222-222222222222",
    accountId: "33333333-3333-3333-3333-333333333333",
    body: "Hello world",
    firstComment: null,
    media: [{ fileId: "f1", kind: "image", alt: "a" }],
    settings: { igType: "feed" },
    scheduledAt: new Date("2026-09-01T10:00:00.000Z"),
  };

  it("is stable across repeated builds and Date-vs-string scheduling", () => {
    const a = variantArgsSha256(base);
    const b = variantArgsSha256({ ...base, scheduledAt: "2026-09-01T10:00:00.000Z" });
    expect(a).toBe(b);
  });

  it("CHANGES when any approved-content field changes — the state law, mechanically", () => {
    const original = variantArgsSha256(base);
    expect(variantArgsSha256({ ...base, body: "Hello world!" })).not.toBe(original);
    expect(variantArgsSha256({ ...base, firstComment: "#tags" })).not.toBe(original);
    expect(variantArgsSha256({ ...base, media: [] })).not.toBe(original);
    expect(variantArgsSha256({ ...base, settings: { igType: "reel" } })).not.toBe(original);
    expect(variantArgsSha256({ ...base, scheduledAt: "2026-09-02T10:00:00.000Z" })).not.toBe(original);
    // Re-targeting the post at a DIFFERENT account is the wrong-account-publish nightmare; it must
    // invalidate the approval too, not just fail a later FK check.
    expect(variantArgsSha256({ ...base, accountId: "44444444-4444-4444-4444-444444444444" })).not.toBe(original);
  });

  it("treats a missing optional field and an explicit null identically", () => {
    const withNull = variantArgsSha256(base);
    const { firstComment, ...withoutKey } = base;
    expect(variantArgsSha256(withoutKey)).toBe(withNull);
  });

  it("carries exactly the approved decision — no status, no timestamps, no server-derived ids", () => {
    const keys = Object.keys(variantPublishArgs(base)).sort();
    expect(keys).toEqual([
      "accountId", "body", "firstComment", "media", "scheduledAt", "settings", "tenantId", "variantId",
    ]);
    // A status change must NOT invalidate an approval (the row moves draft -> in_review -> approved
    // while the approval is alive), which is only true while status stays out of the hash.
    expect(keys).not.toContain("status");
    expect(keys).not.toContain("updatedAt");
  });
});
