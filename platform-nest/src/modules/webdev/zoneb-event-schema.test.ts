// WSK-12 — the Zone A shape-validator, unit-tested in isolation (no DB/HTTP needed). Defense in
// depth behind the n8n flow's own hand-transliterated schema-check (§10) and BEFORE the
// idempotent insert — see the file's own header for why this duplication across the zone
// boundary is deliberate, not an oversight.
import { describe, it, expect } from "vitest";
import { validateZoneBEvent } from "./zoneb-event-schema";

const TENANT = "tenant-abc";

function validFormReceivedBody(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "evt-1",
    kind: "form.received",
    tenantId: TENANT,
    originSite: "webdesk",
    occurredAt: new Date().toISOString(),
    data: { siteSlug: "acme", formId: "contact", submissionId: "sub-1", hasAttachments: false },
    ...overrides,
  };
}

describe("WSK-12 · validateZoneBEvent", () => {
  it("ACCEPTS a well-formed form.received envelope", () => {
    const result = validateZoneBEvent(TENANT, validFormReceivedBody());
    expect(result.ok).toBe(true);
  });

  it("REFUSES a non-object body", () => {
    for (const bad of [null, undefined, "a string", 42, ["array"]]) {
      const result = validateZoneBEvent(TENANT, bad);
      expect(result.ok, `body ${JSON.stringify(bad)} must be refused`).toBe(false);
    }
  });

  it("REFUSES an unknown `kind` — the CHECK-enumerated vocabulary is closed", () => {
    const result = validateZoneBEvent(TENANT, validFormReceivedBody({ kind: "deploy.staging.started" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/kind must be one of/);
  });

  it("REFUSES a body tenantId that disagrees with the route tenant — never silently trust or override", () => {
    const result = validateZoneBEvent(TENANT, validFormReceivedBody({ tenantId: "a-different-tenant" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match the route tenant/);
  });

  it("REFUSES a missing eventId", () => {
    const body = validFormReceivedBody();
    delete (body as Record<string, unknown>).eventId;
    const result = validateZoneBEvent(TENANT, body);
    expect(result.ok).toBe(false);
  });

  it("REFUSES an unparseable occurredAt", () => {
    const result = validateZoneBEvent(TENANT, validFormReceivedBody({ occurredAt: "not-a-date" }));
    expect(result.ok).toBe(false);
  });

  it("REFUSES a non-object `data`", () => {
    const result = validateZoneBEvent(TENANT, validFormReceivedBody({ data: "not-an-object" }));
    expect(result.ok).toBe(false);
  });

  describe("form.received data — the slim-projection shape, correlators only", () => {
    it("REFUSES a missing siteSlug/formId/submissionId", () => {
      for (const key of ["siteSlug", "formId", "submissionId"]) {
        const data = { siteSlug: "acme", formId: "contact", submissionId: "sub-1", hasAttachments: false };
        delete (data as Record<string, unknown>)[key];
        const result = validateZoneBEvent(TENANT, validFormReceivedBody({ data }));
        expect(result.ok, `missing data.${key} must be refused`).toBe(false);
      }
    });

    it("REFUSES a non-boolean hasAttachments", () => {
      const result = validateZoneBEvent(
        TENANT,
        validFormReceivedBody({ data: { siteSlug: "a", formId: "f", submissionId: "s", hasAttachments: "yes" } }),
      );
      expect(result.ok).toBe(false);
    });

    it("REFUSES a data object carrying a submitted field VALUE — never the raw blob (§04)", () => {
      // Not a claim this validator scrubs unknown keys (it does not — it validates SHAPE), but the
      // REQUIRED keys are correlators only, and a caller sending the raw form fields instead of the
      // slim projection fails on the required-key check, not silently passing through PII.
      const result = validateZoneBEvent(
        TENANT,
        validFormReceivedBody({ data: { email: "someone@example.com", message: "hello" } }),
      );
      expect(result.ok).toBe(false);
    });
  });

  it("ACCEPTS a non-form.received kind with an opaque object payload (future emitters not built yet)", () => {
    const result = validateZoneBEvent(
      TENANT,
      validFormReceivedBody({ kind: "alert.raised", data: { severity: "warn", message: "disk 80% full" } }),
    );
    expect(result.ok).toBe(true);
  });
});
