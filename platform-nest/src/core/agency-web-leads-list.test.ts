// M5-L6 — the Website -> Leads read, NO database. `authorize` is mocked so a test says exactly what a caller lacks;
// the service is mocked in the controller block so a test proves it was never reached after a refusal. The real
// Cerbos + RLS legs (cross-company, same slug in two tenants) run in agency-web-leads-list.db.test.ts on the Linux gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

const authorize = vi.fn<(...a: unknown[]) => unknown>();
const writeActivity = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock("./http", () => ({ authorize: (...a: unknown[]) => authorize(...a), writeActivity: (...a: unknown[]) => writeActivity(...a) }));

const listWebLeads = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("./agency-web-leads.service", async (orig) => ({
  ...(await orig<typeof import("./agency-web-leads.service")>()),
  listWebLeads: (...a: unknown[]) => listWebLeads(...a),
}));

import { AgencyLeadsController } from "./agency-leads.controller";
import { marketingConsentOf, summarizeAttribution } from "./agency-web-leads.service";

const T = "11111111-1111-4111-8111-111111111111";
const req = { principal: { userId: "u-1" } } as never;

describe("summarizeAttribution - an allow-list projection, click-id presence only", () => {
  it("keeps the shown fields and names the click ids that are set, never their values", () => {
    const s = summarizeAttribution({
      landing: "/services/web/", form_page: "/contact/", referrer: "www.google.com",
      utm_source: "google", utm_medium: "cpc", utm_campaign: "spring", utm_term: "villa", utm_content: "ad1",
      gclid: "SECRET-GCLID-VALUE", fbclid: "SECRET-FB", msclkid: "", fbp: "fb.1.123", fbc: "fb.1.456",
      sections_seen: ["home.hero"],
    });
    expect(s).toEqual({
      landing: "/services/web/", formPage: "/contact/", referrer: "www.google.com",
      utmSource: "google", utmMedium: "cpc", utmCampaign: "spring", clickIds: ["gclid", "fbclid"],
    });
    const json = JSON.stringify(s);
    for (const leak of ["SECRET-GCLID-VALUE", "SECRET-FB", "fb.1.123", "fb.1.456", "villa", "ad1"]) expect(json).not.toContain(leak);
  });

  it("null, arrays, strings and wrong-typed members read as absent, never throw", () => {
    const empty = { landing: null, formPage: null, referrer: null, utmSource: null, utmMedium: null, utmCampaign: null, clickIds: [] };
    for (const v of [null, undefined, [], "x", 5]) expect(summarizeAttribution(v)).toEqual(empty);
    expect(summarizeAttribution({ landing: 5, utm_source: {}, gclid: 7, gbraid: ["x"] })).toEqual(empty);
  });

  it("caps a long text member", () => {
    expect(summarizeAttribution({ landing: "x".repeat(2000) }).landing).toHaveLength(512);
  });
});

describe("marketingConsentOf - null means unknown, which is no consent", () => {
  it("true / false only from a boolean; everything else is null", () => {
    expect(marketingConsentOf({ analytics: true, marketing: true })).toBe(true);
    expect(marketingConsentOf({ marketing: false })).toBe(false);
    for (const v of [null, undefined, {}, [], { marketing: "true" }, { marketing: 1 }]) expect(marketingConsentOf(v)).toBeNull();
  });
});

describe("GET :tenantId/agency/web-leads/:siteSlug - authorization wiring", () => {
  const ctl = new AgencyLeadsController();
  beforeEach(() => { authorize.mockReset(); listWebLeads.mockReset(); authorize.mockResolvedValue(undefined); });

  it("authorizes agency_lead:read on the path's tenant, then reads exactly that tenant and slug", async () => {
    listWebLeads.mockResolvedValue({ leadIntakeEnabled: true, truncated: false, leads: [] });
    const out = await ctl.webLeads(req, T, "gaiada");
    expect(authorize).toHaveBeenCalledWith({ userId: "u-1" }, { kind: "agency_lead", tenantId: T, module: "agency" }, "read");
    expect(listWebLeads).toHaveBeenCalledWith(T, "gaiada");
    expect(out).toEqual({ leadIntakeEnabled: true, truncated: false, leads: [] });
  });

  it("a denied caller (valid tenant and slug) gets the 403 and the service is never reached", async () => {
    authorize.mockRejectedValue(new ForbiddenException("denied"));
    await expect(ctl.webLeads(req, T, "gaiada")).rejects.toBeInstanceOf(ForbiddenException);
    expect(listWebLeads).not.toHaveBeenCalled();
  });

  it("authz runs BEFORE slug validation: a denied caller with a bad slug still sees the 403", async () => {
    authorize.mockRejectedValue(new ForbiddenException("denied"));
    await expect(ctl.webLeads(req, T, "x".repeat(300))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an over-long slug is a 400 for an authorized caller and reads nothing", async () => {
    await expect(ctl.webLeads(req, T, "x".repeat(201))).rejects.toBeInstanceOf(BadRequestException);
    expect(listWebLeads).not.toHaveBeenCalled();
  });
});
