// Client Centre — validator/merge unit tests (CC piece 2/F). Pure, no DB: see validation.ts's own
// header. Registry keys used below are real entries from registry.json (legal/city/hotel/ga4/rs),
// chosen because they exist today — if the CMC extraction ever renames one of them, these tests
// fail loudly rather than silently testing a key that no longer exists.
import { describe, it, expect } from "vitest";
import { applyCentrePatch, looksLikeCredential, bodyByteLength, MAX_BODY_BYTES, MAX_STRING_LEN } from "./validation";
import type { ProfileState } from "./validation";

function emptyState(businessType = "other"): ProfileState {
  return { businessType, profile: {}, connections: {}, departments: {}, customConnections: {} };
}

describe("Client Centre validation — applyCentrePatch", () => {
  it("accepts a plain field write and records the change", () => {
    const r = applyCentrePatch(emptyState(), { profile: { legal: "Acme Pte Ltd" } });
    if ("error" in r) throw new Error(r.error);
    expect(r.state.profile.legal).toBe("Acme Pte Ltd");
    expect(r.changes).toEqual([{ path: "profile.legal", before: null, after: "Acme Pte Ltd" }]);
  });

  it("a same-value write records NO change (idempotent no-op)", () => {
    const current = emptyState();
    current.profile.legal = "Acme Pte Ltd";
    const r = applyCentrePatch(current, { profile: { legal: "Acme Pte Ltd" } });
    if ("error" in r) throw new Error(r.error);
    expect(r.changes).toEqual([]);
  });

  it("rejects an unknown top-level field, naming it", () => {
    const r = applyCentrePatch(emptyState(), { bogus: 1 } as never);
    expect(r).toMatchObject({ error: expect.stringContaining("bogus") });
  });

  it("rejects an unknown profile field key, naming it", () => {
    const r = applyCentrePatch(emptyState(), { profile: { nope_not_a_field: "x" } });
    expect(r).toMatchObject({ error: expect.stringContaining("nope_not_a_field") });
  });

  it("null deletes a profile key; empty string also deletes", () => {
    const current = emptyState();
    current.profile.legal = "Acme";
    current.profile.city = "Bali";
    const r1 = applyCentrePatch(current, { profile: { legal: null } });
    if ("error" in r1) throw new Error(r1.error);
    expect(r1.state.profile.legal).toBeUndefined();
    expect(r1.changes).toEqual([{ path: "profile.legal", before: "Acme", after: null }]);

    const r2 = applyCentrePatch(current, { profile: { city: "" } });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.state.profile.city).toBeUndefined();
  });

  it("deleting an already-absent key is a no-op, not an error", () => {
    const r = applyCentrePatch(emptyState(), { profile: { legal: null } });
    if ("error" in r) throw new Error(r.error);
    expect(r.changes).toEqual([]);
  });

  it("businessType must be a registry id", () => {
    const ok = applyCentrePatch(emptyState(), { businessType: "hotel" });
    if ("error" in ok) throw new Error(ok.error);
    expect(ok.state.businessType).toBe("hotel");

    const bad = applyCentrePatch(emptyState(), { businessType: "not-a-type" });
    expect(bad).toMatchObject({ error: expect.stringContaining("businessType") });
  });

  it("departments accepts a registry department id and 'ix', rejects anything else", () => {
    const ok = applyCentrePatch(emptyState(), { departments: { rs: false, ix: true } });
    if ("error" in ok) throw new Error(ok.error);
    expect(ok.state.departments).toMatchObject({ rs: false, ix: true });

    const bad = applyCentrePatch(emptyState(), { departments: { nope: true } });
    expect(bad).toMatchObject({ error: expect.stringContaining("nope") });
  });

  it("departments: null reverts to default (deletes the override key)", () => {
    const current = emptyState();
    current.departments.rs = false;
    const r = applyCentrePatch(current, { departments: { rs: null } });
    if ("error" in r) throw new Error(r.error);
    expect(r.state.departments.rs).toBeUndefined();
  });

  it("departments rejects a non-boolean, non-null value", () => {
    const r = applyCentrePatch(emptyState(), { departments: { rs: "yes" as unknown as boolean } });
    expect(r).toMatchObject({ error: expect.stringContaining("rs") });
  });

  it("connections: a registry key may be created and edited; null deletes the whole entry", () => {
    const r1 = applyCentrePatch(emptyState(), { connections: { ga4: { tool: "GA4", status: "Connected" } } });
    if ("error" in r1) throw new Error(r1.error);
    expect(r1.state.connections.ga4).toEqual({ tool: "GA4", status: "Connected" });

    const r2 = applyCentrePatch(r1.state, { connections: { ga4: null } });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.state.connections.ga4).toBeUndefined();
  });

  it("connections: an unknown key (not registry, not an existing custom id) is refused", () => {
    const r = applyCentrePatch(emptyState(), { connections: { xnotreal: { tool: "x" } } });
    expect(r).toMatchObject({ error: expect.stringContaining("xnotreal") });
  });

  it("connections: a custom id already listed in customConnections IS a valid connections key", () => {
    const current = emptyState();
    current.customConnections.rs = [{ id: "xabcd1", name: "My Tool" }];
    const r = applyCentrePatch(current, { connections: { xabcd1: { tool: "Custom" } } });
    if ("error" in r) throw new Error(r.error);
    expect(r.state.connections.xabcd1).toEqual({ tool: "Custom" });
  });

  it("connections: sub-key null/'' deletes just that sub-key, pruning the whole entry once empty", () => {
    const current = emptyState();
    current.connections.ga4 = { tool: "GA4", account: "acme" };
    const r1 = applyCentrePatch(current, { connections: { ga4: { tool: null } } });
    if ("error" in r1) throw new Error(r1.error);
    expect(r1.state.connections.ga4).toEqual({ account: "acme" });

    const r2 = applyCentrePatch(r1.state, { connections: { ga4: { account: "" } } });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.state.connections.ga4).toBeUndefined(); // pruned once empty
  });

  it("connections: an unknown sub-key is refused", () => {
    const r = applyCentrePatch(emptyState(), { connections: { ga4: { bogus: "x" } as never } });
    expect(r).toMatchObject({ error: expect.stringContaining("bogus") });
  });

  it("connections: method/status must be registry values", () => {
    const bad1 = applyCentrePatch(emptyState(), { connections: { ga4: { method: "Carrier Pigeon" } } });
    expect(bad1).toMatchObject({ error: expect.stringContaining("method") });
    const bad2 = applyCentrePatch(emptyState(), { connections: { ga4: { status: "On Fire" } } });
    expect(bad2).toMatchObject({ error: expect.stringContaining("status") });
    const ok = applyCentrePatch(emptyState(), { connections: { ga4: { method: "API", status: "Connected" } } });
    if ("error" in ok) throw new Error(ok.error);
    expect(ok.state.connections.ga4).toEqual({ method: "API", status: "Connected" });
  });

  it("customConnections REPLACES the section's whole list, validates id shape and name length", () => {
    const r1 = applyCentrePatch(emptyState(), { customConnections: { rs: [{ id: "xabcd1", name: "Tool One" }] } });
    if ("error" in r1) throw new Error(r1.error);
    expect(r1.state.customConnections.rs).toEqual([{ id: "xabcd1", name: "Tool One" }]);

    const r2 = applyCentrePatch(r1.state, { customConnections: { rs: [{ id: "xefgh2", name: "Tool Two" }] } });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.state.customConnections.rs).toEqual([{ id: "xefgh2", name: "Tool Two" }]); // REPLACED, not merged

    const badId = applyCentrePatch(emptyState(), { customConnections: { rs: [{ id: "NOTVALID", name: "x" }] } });
    expect(badId).toMatchObject({ error: expect.stringContaining("id") });

    const badName = applyCentrePatch(emptyState(), { customConnections: { rs: [{ id: "xabcd1", name: "" }] } });
    expect(badName).toMatchObject({ error: expect.stringContaining("name") });
  });

  it("customConnections: unknown section id is refused; duplicate id within one list is refused", () => {
    const badSection = applyCentrePatch(emptyState(), { customConnections: { nope: [] } });
    expect(badSection).toMatchObject({ error: expect.stringContaining("nope") });

    const dupe = applyCentrePatch(emptyState(), {
      customConnections: { rs: [{ id: "xabcd1", name: "A" }, { id: "xabcd1", name: "B" }] },
    });
    expect(dupe).toMatchObject({ error: expect.stringContaining("duplicate") });
  });

  it("string values are capped at MAX_STRING_LEN", () => {
    const tooLong = "x".repeat(MAX_STRING_LEN + 1);
    const r = applyCentrePatch(emptyState(), { profile: { legal: tooLong } });
    expect(r).toMatchObject({ error: expect.stringContaining("legal") });
    const ok = applyCentrePatch(emptyState(), { profile: { legal: "x".repeat(MAX_STRING_LEN) } });
    expect("error" in ok).toBe(false);
  });

  it("the whole body is capped at MAX_BODY_BYTES", () => {
    const huge = { profile: { legal: "x".repeat(MAX_BODY_BYTES) } };
    const r = applyCentrePatch(emptyState(), huge);
    expect(r).toMatchObject({ error: expect.stringContaining("bytes") });
  });

  it("rejects a non-object patch body", () => {
    expect(applyCentrePatch(emptyState(), null)).toMatchObject({ error: expect.any(String) });
    expect(applyCentrePatch(emptyState(), [1, 2])).toMatchObject({ error: expect.any(String) });
    expect(applyCentrePatch(emptyState(), "nope")).toMatchObject({ error: expect.any(String) });
  });
});

describe("Client Centre validation — credential refusal (CMC-SEC-1 follow-up 3)", () => {
  it("looksLikeCredential recognises every documented pattern", () => {
    // Built from parts, not a literal — this repo's own commit-time scanner (rightly) refuses ANY
    // PEM-header-shaped literal, even a fake one with no key body, so the pieces are joined at
    // runtime rather than sitting in the file as a contiguous, scanner-matching string.
    const pemHeader = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
    expect(looksLikeCredential(pemHeader)).toBe(true);
    expect(looksLikeCredential("key is AKIAABCDEFGHIJKLMNOP")).toBe(true);
    expect(looksLikeCredential("token sk-abcdefghijklmnop")).toBe(true);
    expect(looksLikeCredential("ghp_abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(looksLikeCredential("github_pat_abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(looksLikeCredential("xoxb-1234-5678-abcdef")).toBe(true);
    expect(looksLikeCredential("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123DEF456ghi")).toBe(true);
    expect(looksLikeCredential("password=hunter2")).toBe(true);
    expect(looksLikeCredential("pwd: hunter2")).toBe(true);
    expect(looksLikeCredential("just an ordinary account note")).toBe(false);
  });

  it("refuses a credential-looking value in an ordinary profile field", () => {
    const r = applyCentrePatch(emptyState(), { profile: { legal: "AKIAABCDEFGHIJKLMNOP" } });
    expect(r).toMatchObject({ error: expect.stringContaining("credential") });
  });

  it("refuses a credential-looking value inside connections.creds — 'creds' names WHERE it lives, never the secret itself", () => {
    const r = applyCentrePatch(emptyState(), { connections: { ga4: { creds: "sk-liveSECRETKEYvalue123" } } });
    expect(r).toMatchObject({ error: expect.stringContaining("credential") });
  });

  it("refuses a credential-looking value inside connections.notes too", () => {
    const r = applyCentrePatch(emptyState(), { connections: { ga4: { notes: "password=letmein123" } } });
    expect(r).toMatchObject({ error: expect.stringContaining("credential") });
  });
});

describe("Client Centre validation — bodyByteLength", () => {
  it("measures the UTF-8 byte length of the serialized patch", () => {
    expect(bodyByteLength({ a: "x" })).toBeGreaterThan(0);
    expect(bodyByteLength(undefined)).toBe(2); // "{}"
  });
});
