// Cross-package contract: the fixture WebDesk's real emitter is checked against
// (webdesk/api/test/zoneb-form-received-contract.spec.ts) must be accepted by this validator, and the
// internal-tenant-id mistake (fixed 2026-10-11) must be refused. Pure JSON data; no webdesk imports.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateZoneBEvent } from "./zoneb-event-schema";

const DIR = resolve(__dirname, "../../../../contracts/zoneb");
const envelope = JSON.parse(readFileSync(resolve(DIR, "form-received.envelope.json"), "utf8"));
const { internalTenantId } = JSON.parse(readFileSync(resolve(DIR, "form-received.internal-tenant-id.json"), "utf8"));
const MISMATCH = "body tenantId does not match the route tenant";

describe("form.received contract fixture vs validateZoneBEvent", () => {
  it("fixture sanity: the two ids differ", () => {
    expect(internalTenantId).toBeTruthy();
    expect(internalTenantId).not.toBe(envelope.tenantId);
  });

  it("accepts the fixture when the route tenant is its company_ref", () => {
    const r = validateZoneBEvent(envelope.tenantId, envelope);
    expect(r.ok).toBe(true);
  });

  it("refuses the fixture carrying the internal tenant id against the company_ref route", () => {
    const r = validateZoneBEvent(envelope.tenantId, { ...envelope, tenantId: internalTenantId });
    expect(r).toEqual({ ok: false, reason: MISMATCH });
  });

  it("refuses the company_ref body against a route keyed by the internal id", () => {
    const r = validateZoneBEvent(internalTenantId, envelope);
    expect(r).toEqual({ ok: false, reason: MISMATCH });
  });
});
