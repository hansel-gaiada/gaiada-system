// M5-V3-e — the consent.status caller against a fake transport (contract: design §4.3; WebDesk side V3-a).
import { describe, it, expect, vi } from "vitest";
import {
  ConsentStatusError, createConsentReader, hasAnalyticsConsent, mapTransportError, parseConsentStatusBody, pickTenantForDomain,
  type ConsentTransport, type TenantLike,
} from "./visitor-consent-client";

const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";
const entry = (consentId: string, analytics: boolean, action = "grant") => ({ consentId, analytics, marketing: false, action, noticeVersion: "3", recordedAt: "2026-10-12T09:00:00.000Z" });
const tenants: TenantLike[] = [
  { slug: "gaiada", status: "active", sites: [{ environments: [{ name: "production", domain: "www.gaiada.com" }, { name: "staging", domain: "staging.gaiada.com" }] }] },
  { slug: "other", status: "active", sites: [{ environments: [{ name: "production", domain: "other.example" }] }] },
  { slug: "old", status: "archived", sites: [{ environments: [{ name: "production", domain: "gaiada.com" }] }] },
];

describe("pickTenantForDomain (the cross-company wall is the tenant list itself)", () => {
  it("matches a property's domain to exactly one active tenant, ignoring case and www.", () => {
    expect(pickTenantForDomain(tenants, "gaiada.com")).toBe("gaiada");
    expect(pickTenantForDomain(tenants, "WWW.GAIADA.COM")).toBe("gaiada");
  });
  it("none or several is site_unresolved, never a guess", () => {
    expect(() => pickTenantForDomain(tenants, "unknown.example")).toThrow(ConsentStatusError);
    const twice = [...tenants, { slug: "dup", status: "active", sites: [{ environments: [{ domain: "gaiada.com" }] }] }];
    try { pickTenantForDomain(twice, "gaiada.com"); throw new Error("no throw"); } catch (e) { expect((e as ConsentStatusError).kind).toBe("site_unresolved"); }
  });
});

describe("parseConsentStatusBody", () => {
  it("reads the latest record per id and leaves absent ids absent", () => {
    const out = parseConsentStatusBody({ statuses: [entry(C1.toUpperCase(), false, "update")] }, new Set([C1, C2]));
    expect(out).toEqual([{ ...entry(C1, false, "update") }]);
  });
  it("anything off-contract fails the WHOLE answer (a broken answer must never read as 'absent')", () => {
    const req = new Set([C1]);
    for (const body of [null, {}, { statuses: {} }, { statuses: [{ consentId: "x" }] }, { statuses: [entry(C2, true)] },
      { statuses: [entry(C1, true), entry(C1, true)] }, { statuses: [{ ...entry(C1, true), analytics: "true" }] }]) {
      expect(() => parseConsentStatusBody(body, req), JSON.stringify(body)).toThrow(ConsentStatusError);
    }
  });
});

describe("hasAnalyticsConsent (D5: keyed on analytics, never on action)", () => {
  it("only a present record with analytics === true is consent", () => {
    expect(hasAnalyticsConsent(entry(C1, true))).toBe(true);
    expect(hasAnalyticsConsent(entry(C1, false, "update"))).toBe(false);
    expect(hasAnalyticsConsent(entry(C1, false, "withdraw"))).toBe(false);
    expect(hasAnalyticsConsent(entry(C1, true, "update"))).toBe(true);
    expect(hasAnalyticsConsent(undefined)).toBe(false);
  });
});

describe("createConsentReader", () => {
  const transport = (send: ConsentTransport["send"]): ConsentTransport => ({ tenantsOf: async () => tenants, send });

  it("asks WebDesk in batches of 100 for the resolved site, and merges the answers", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const send = vi.fn(async (req: { siteSlug: string; consentIds: string[] }) => ({ status: 200, json: { statuses: req.consentIds.slice(0, 2).map((c) => entry(c, true)) } }));
    const r = createConsentReader(transport(send));
    const slug = await r.resolveSiteSlug("company", "gaiada.com");
    const map = await r.statuses("company", slug, [...ids, ids[0]!.toUpperCase(), "junk"]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[0].consentIds.length)).toEqual([100, 50]);
    expect(send.mock.calls.every((c) => c[0].siteSlug === "gaiada")).toBe(true);
    expect(map.size).toBe(4);
  });

  it("maps every non-200 and every transport failure to a typed error", async () => {
    const cases: Array<[number, string]> = [[401, "rejected"], [403, "rejected"], [404, "site_unresolved"], [400, "bad_response"], [500, "unreachable"], [503, "unreachable"]];
    for (const [status, kind] of cases) {
      const r = createConsentReader(transport(async () => ({ status, json: {} })));
      await expect(r.statuses("company", "gaiada", [C1]), String(status)).rejects.toMatchObject({ kind });
    }
    const down = createConsentReader(transport(async () => { throw Object.assign(new Error("socket hang up"), { code: "webdesk_control_transport" }); }));
    await expect(down.statuses("company", "gaiada", [C1])).rejects.toMatchObject({ kind: "unreachable" });
    const unconfigured = createConsentReader(transport(async () => { throw Object.assign(new Error("x"), { code: "webdesk_control_not_configured" }); }));
    await expect(unconfigured.statuses("company", "gaiada", [C1])).rejects.toMatchObject({ kind: "not_configured" });
    const listDown = createConsentReader({ tenantsOf: async () => { throw new Error("boom"); }, send: async () => ({ status: 200, json: { statuses: [] } }) });
    await expect(listDown.resolveSiteSlug("company", "gaiada.com")).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("the HttpException shape of 'not configured' from the webdev seam is recognised", () => {
    const e = { getResponse: () => ({ message: "webdesk_not_configured", reason: "control_channel_not_configured" }) };
    expect(mapTransportError(e).kind).toBe("not_configured");
    expect(mapTransportError({ getResponse: () => ({ message: "editorial_unavailable" }) }).kind).toBe("unreachable");
  });
});
