// M5-L5 — the staff alert for a new web lead. No database: the sender is injected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import {
  alertStaffOfWebLead, buildWebLeadAlert, firstNameOf, webLeadAlertRecipients, WEB_LEAD_ALERT_TYPE,
} from "./agency-web-lead-alert";

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";

beforeEach(() => { process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS = `${U1}, ${U2},not-a-uuid,${U1}`; });
afterEach(() => { delete process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS; vi.restoreAllMocks(); });

describe("firstNameOf", () => {
  it("first token, or 'someone'", () => {
    expect(firstNameOf("Zebedee Quuxington")).toBe("Zebedee");
    expect(firstNameOf("  Ayu  ")).toBe("Ayu");
    expect(firstNameOf(null)).toBe("someone");
    expect(firstNameOf("   ")).toBe("someone");
  });
});

describe("buildWebLeadAlert — only id, first name, form and link", () => {
  it("carries the allowed fields and none of the personal data", () => {
    const p = buildWebLeadAlert({ leadId: LEAD, contactName: "Zebedee Quuxington", originForm: "contact" });
    const all = JSON.stringify(p);
    expect(all).toContain(LEAD);
    expect(all).toContain("Zebedee");
    expect(all).toContain("contact");
    expect(p.href).toBe(`/agency/leads/${LEAD}`);
    // the surname, email, phone, message, org and attribution must not appear
    for (const leak of ["Quuxington", "@", "+62", "secret project", "utm_", "gclid", "landing"]) expect(all).not.toContain(leak);
    expect(Object.keys(p).sort()).toEqual(["body", "entityId", "entityType", "href", "severity", "title"]);
  });
  it("the builder's signature cannot accept email/phone/message (inputs are only id, name, form)", () => {
    const p = buildWebLeadAlert({
      leadId: LEAD, contactName: "Ayu", originForm: "audit",
      ...({ contactEmail: "a@leak.test", contactPhone: "+62 811", message: "hello secret" } as object),
    } as never);
    const all = JSON.stringify(p);
    for (const leak of ["a@leak.test", "+62 811", "hello secret"]) expect(all).not.toContain(leak);
  });
});

describe("alertStaffOfWebLead", () => {
  it("sends once to the de-duplicated, uuid-only configured recipients", async () => {
    const send = vi.fn(async () => {});
    await alertStaffOfWebLead(TENANT, { leadId: LEAD, contactName: "Ayu Putri", originForm: "contact" }, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(TENANT, [U1, U2], WEB_LEAD_ALERT_TYPE, expect.objectContaining({ entityId: LEAD }));
  });
  it("sends nothing when no destination is configured (fail-closed)", async () => {
    delete process.env.AGENCY_WEB_LEAD_ALERT_USER_IDS;
    expect(webLeadAlertRecipients()).toEqual([]);
    const send = vi.fn(async () => {});
    await alertStaffOfWebLead(TENANT, { leadId: LEAD, contactName: "Ayu", originForm: "contact" }, send);
    expect(send).not.toHaveBeenCalled();
  });
  it("never throws when the sender fails, and logs no personal data", async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((...a: unknown[]) => { lines.push(JSON.stringify(a)); });
    const send = vi.fn(async () => { throw new Error("boom zebedee@leak.test"); });
    await expect(alertStaffOfWebLead(TENANT, { leadId: LEAD, contactName: "Zebedee", originForm: "contact" }, send)).resolves.toBeUndefined();
    expect(lines.join("")).toContain(LEAD);
    expect(lines.join("")).not.toContain("leak.test");
  });
});
