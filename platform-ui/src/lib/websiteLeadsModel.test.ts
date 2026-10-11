import { describe, it, expect } from "vitest";
import { clickIdLabel, consentBadge, humanize, parseWebLeads, utmSummary, WebLeadsShapeError } from "./websiteLeadsModel";

const attr = (o: Record<string, unknown> = {}) => ({ landing: "/", formPage: null, referrer: null, utmSource: null, utmMedium: null, utmCampaign: null, clickIds: [], ...o });
const lead = (o: Record<string, unknown> = {}) => ({
  id: "l1", orgName: "Org", contactName: null, originForm: "contact", createdAt: "2026-10-10T09:00:00Z",
  status: "new", stage: "enquiry", attribution: attr(), marketingConsent: null, ...o,
});
const ok = (o: Record<string, unknown> = {}) => ({ leadIntakeEnabled: true, truncated: false, leads: [lead()], ...o });

describe("parseWebLeads", () => {
  it("accepts the BFF's shape", () => {
    const b = parseWebLeads(ok({ leads: [lead({ marketingConsent: true, attribution: attr({ clickIds: ["gclid", "li_fat_id"] }) })] }));
    expect(b.leads[0].marketingConsent).toBe(true);
    expect(b.leads[0].attribution.clickIds).toEqual(["gclid", "li_fat_id"]);
  });

  it("an empty list is a valid read", () => {
    expect(parseWebLeads(ok({ leads: [] })).leads).toEqual([]);
  });

  it("refuses a click id that is not a known NAME (so a value can never be rendered)", () => {
    expect(() => parseWebLeads(ok({ leads: [lead({ attribution: attr({ clickIds: ["EAIaIQobChMI-secret-value"] }) })] }))).toThrow(WebLeadsShapeError);
  });

  it("drift is loud: missing flag, non-array leads, wrong-typed member, non-boolean consent", () => {
    expect(() => parseWebLeads({ truncated: false, leads: [] })).toThrow(WebLeadsShapeError);
    expect(() => parseWebLeads({ leadIntakeEnabled: true, truncated: false, leads: {} })).toThrow(WebLeadsShapeError);
    expect(() => parseWebLeads(ok({ leads: [lead({ stage: 5 })] }))).toThrow(WebLeadsShapeError);
    expect(() => parseWebLeads(ok({ leads: [lead({ marketingConsent: "yes" })] }))).toThrow(WebLeadsShapeError);
    expect(() => parseWebLeads([])).toThrow(WebLeadsShapeError);
    expect(() => parseWebLeads(null)).toThrow(WebLeadsShapeError);
  });
});

describe("words", () => {
  it("consentBadge: unknown is its own state, never consent", () => {
    expect(consentBadge(true)).toEqual({ label: "Marketing consent", tone: "ok" });
    expect(consentBadge(false)).toEqual({ label: "No marketing consent", tone: "warn" });
    expect(consentBadge(null)).toEqual({ label: "Consent unknown", tone: "neutral" });
  });
  it("clickIdLabel shows presence only", () => expect(clickIdLabel("gclid")).toBe("gclid ✓"));
  it("humanize handles snake case and unknown values", () => {
    expect(humanize("in_review")).toBe("In review");
    expect(humanize("proposal")).toBe("Proposal");
    expect(humanize("")).toBe("");
  });
  it("utmSummary joins what is present", () => {
    expect(utmSummary(parseWebLeads(ok({ leads: [lead({ attribution: attr({ utmSource: "g", utmCampaign: "c" }) })] })).leads[0].attribution)).toBe("g / c");
    expect(utmSummary(attr() as never)).toBeNull();
  });
});
