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

  // The MCP hub strips path params from the body (mcp-hub callPlatform), so the bridge relays envelopes with NO tenantId;
  // the route tenant, authorized by the AuthGuard and Cerbos, stands in. Found live 2026-10-12 ("tenantId is required").
  it("ACCEPTS an envelope relayed by the MCP hub with tenantId stripped into the path, and carries the ROUTE tenant", () => {
    const { tenantId: _stripped, ...relayed } = validFormReceivedBody();
    const result = validateZoneBEvent(TENANT, relayed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tenantId).toBe(TENANT);
  });

  it("still REFUSES an empty or non-string body tenantId (present but invalid is not the hub's stripping)", () => {
    for (const bad of ["", 42, null]) {
      const result = validateZoneBEvent(TENANT, validFormReceivedBody({ tenantId: bad }));
      expect(result.ok, `tenantId ${JSON.stringify(bad)} must be refused`).toBe(false);
    }
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

  // WSK-61: the content tick's fact. A hint only, but its shape is closed, so a malformed one never
  // occupies an idempotency slot.
  describe("schedule.fired data — strict, unknown keys refused", () => {
    const ITEM = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
    const SITE = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const data = (over: Record<string, unknown> = {}) => ({
      tenantSlug: "gaiada",
      siteId: SITE,
      transition: "publish",
      approvalId: null,
      items: [{ itemId: ITEM, version: 3, effectiveAt: "2026-10-11T08:00:00.000Z" }],
      ...over,
    });
    const check = (d: unknown) => validateZoneBEvent(TENANT, validFormReceivedBody({ kind: "schedule.fired", data: d }));

    it("ACCEPTS a plain publish (approvalId null), a swap (approvalId set) and a takedown (version null)", () => {
      expect(check(data()).ok).toBe(true);
      expect(check(data({ approvalId: "11111111-2222-4333-8444-555555555555" })).ok).toBe(true);
      expect(check(data({ transition: "unpublish", items: [{ itemId: ITEM, version: null, effectiveAt: "2026-10-11T08:00:00Z" }] })).ok).toBe(true);
    });

    it("REFUSES unknown keys, at the top and on an item", () => {
      expect(check(data({ note: "x" }))).toEqual({ ok: false, reason: "data has unknown keys: note" });
      const r = check(data({ items: [{ itemId: ITEM, version: 3, effectiveAt: "2026-10-11T08:00:00Z", slug: "a" }] }));
      expect(r).toEqual({ ok: false, reason: "data.items[0] has unknown keys: slug" });
    });

    it("REFUSES a bad transition, slug, siteId, approvalId, item id, version or instant", () => {
      const bad: Array<[Record<string, unknown>, string]> = [
        [{ transition: "swap" }, "data.transition must be publish|unpublish"],
        [{ tenantSlug: "Not A Slug" }, "data.tenantSlug must be a WebDesk tenant slug"],
        [{ siteId: "site-1" }, "data.siteId must be a uuid"],
        [{ approvalId: "apr-1" }, "data.approvalId must be a uuid or null"],
        [{ approvalId: undefined }, "data.approvalId must be a uuid or null"],
        [{ items: [{ itemId: "x", version: 1, effectiveAt: "2026-10-11T08:00:00Z" }] }, "data.items[0].itemId must be a uuid"],
        [{ items: [{ itemId: ITEM, version: 0, effectiveAt: "2026-10-11T08:00:00Z" }] }, "data.items[0].version must be a positive integer or null"],
        [{ items: [{ itemId: ITEM, version: 1.5, effectiveAt: "2026-10-11T08:00:00Z" }] }, "data.items[0].version must be a positive integer or null"],
        [{ items: [{ itemId: ITEM, version: 1, effectiveAt: "soon" }] }, "data.items[0].effectiveAt must be an ISO-8601 instant"],
      ];
      for (const [over, reason] of bad) expect(check(data(over))).toEqual({ ok: false, reason });
    });

    it("REFUSES an empty item list and more than 100 items (the producer chunks)", () => {
      const item = { itemId: ITEM, version: 1, effectiveAt: "2026-10-11T08:00:00Z" };
      expect(check(data({ items: [] })).ok).toBe(false);
      expect(check(data({ items: Array.from({ length: 101 }, () => item) })).ok).toBe(false);
      expect(check(data({ items: Array.from({ length: 100 }, () => item) })).ok).toBe(true);
    });
  });
});
