// M5-L4 — gaiada.com submission -> agency lead. Runs WITHOUT a database: `../db`'s `withTenants` is replaced
// by a small in-memory `agency_leads` that honours the one behaviour the service relies on (the partial
// unique on (tenant_id, submission_ref)). The real SQL (ON CONFLICT against the real index, the CHECK, RLS) is
// proven by agency-web-leads.db.test.ts, which needs DATABASE_URL_TEST.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger, NotFoundException } from "@nestjs/common";

interface Row { id: string; tenant_id: string; submission_ref: string | null; params: unknown[] }
const store: Row[] = [];
const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
/** M5-G5: hashed contacts on the suppression list (scope 'all'), answered by the mock below. */
const suppressed = new Set<string>();
let idSeq = 0;

vi.mock("../db", async (orig) => {
  const actual = await orig<typeof import("../db")>();
  const client = {
    async query(sql: string, p: unknown[]) {
      if (sql.includes("agency_contact_suppressions")) {
        const hashes = (p[3] as string[]) ?? [];
        return { rows: [{ hit: hashes.some((h) => suppressed.has(h)) }] };
      }
      if (sql.includes("INSERT INTO agency_leads")) {
        const [id, tenant, , , , , , , ref] = p as string[];
        if (store.some((r) => r.tenant_id === tenant && r.submission_ref === ref)) return { rows: [] };
        store.push({ id, tenant_id: tenant, submission_ref: ref, params: p });
        return { rows: [{ id }] };
      }
      const [tenant, ref] = p as string[];
      return { rows: store.filter((r) => r.tenant_id === tenant && r.submission_ref === ref).map((r) => ({ id: r.id })) };
    },
  };
  return {
    ...actual,
    newId: () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`,
    withTenants: async (_t: string[], fn: (c: unknown) => unknown) => fn(client),
  };
});
vi.mock("../events/outbox.service", () => ({
  emitEvent: async (_c: unknown, _t: string, _et: string, _id: string, type: string, payload: Record<string, unknown>) => {
    events.push({ type, payload });
    return "evt";
  },
}));

import {
  createLeadFromWebSubmission, mapSubmissionToLead, WEB_FORM_MAPPINGS, type WebLeadsDeps,
} from "./agency-web-leads.service";
import { config } from "../config";
import { maybeFileLeadFromFormReceived } from "../modules/webdev/form-received-lead";
import { normalizePhone, subjectHash } from "./agency-privacy.subject";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const SUB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUB2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Distinctive values: if any of these shows up in a log line, the no-PII rule is broken.
const NAME = "Zebedee Quuxington";
const EMAIL = "zebedee.quux@leaktest.example";
const PHONE = "+62 811 555 0199";
const BIZ = "Quuxington Holdings Pte";
const MSG = "please call me about the secret project";
const SECRETS = [NAME, EMAIL, PHONE, BIZ, MSG, "Quuxington", "leaktest.example"];

function submission(formKey: string | null, fields: Record<string, unknown>, id = SUB): Record<string, unknown> {
  return {
    submissionId: id, formId: "ffffffff-ffff-4fff-8fff-ffffffffffff", ...(formKey ? { formKey } : {}), siteSlug: "gaiada",
    createdAt: "2026-10-11T09:00:00Z", status: "new", fields,
    consent: { text: "t", version: "1", acceptedAt: "2026-10-11T09:00:00Z" },
    attribution: { landing: "/services/web/", utm_source: "google" },
    visitorConsent: { analytics: true, marketing: false, version: "3", decided_at: "2026-10-11T09:00:00Z" },
  };
}

/** A WebDesk whose tenants are `owned`: any other slug fails the wall exactly as the real one does (404). */
function deps(opts: { owned?: string[]; answer?: Record<string, unknown> | "gone" } = {}): WebLeadsDeps & { fetched: string[] } {
  const owned = opts.owned ?? ["gaiada"];
  const fetched: string[] = [];
  return {
    fetched,
    async assertTenantOwnsSite(_t, slug) {
      if (!owned.includes(slug)) throw new NotFoundException("site_not_found");
    },
    async fetchSubmission(_slug, id) {
      fetched.push(id);
      return opts.answer ?? submission("contact", { name: NAME, email_address: EMAIL, phone_number: PHONE, message: MSG }, id);
    },
  };
}

let logged: string[];
beforeEach(() => {
  store.length = 0;
  events.length = 0;
  suppressed.clear();
  logged = [];
  process.env.AGENCY_WEB_LEADS_ENABLED = "1";
  for (const m of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
    vi.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => { logged.push(JSON.stringify(a)); });
  }
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(JSON.stringify(a)); });
  }
});
afterEach(() => {
  delete process.env.AGENCY_WEB_LEADS_ENABLED;
  vi.restoreAllMocks();
});

describe("mapSubmissionToLead — one documented table, keyed by form key", () => {
  it("contact: name/email_address/phone_number; no business field so org_name = the contact's name", () => {
    expect(mapSubmissionToLead("contact", { name: "Ayu", selectcontact: "email", email_address: "a@x.test", phone_number: "123", message: "hi" }))
      .toEqual({ orgName: "Ayu", contactName: "Ayu", contactEmail: "a@x.test", contactPhone: "123" });
  });
  it("audit: business_type is a category, NOT a business name", () => {
    expect(mapSubmissionToLead("audit", { name: "Bayu", email_address: "b@x.test", website_url: "https://x.test", business_type: "Hotel / resort" }))
      .toEqual({ orgName: "Bayu", contactName: "Bayu", contactEmail: "b@x.test", contactPhone: null });
  });
  it("onboard: org_name / contact_name / contact_email / contact_phone", () => {
    expect(mapSubmissionToLead("onboard", { org_name: "Villa Sari", contact_name: "Citra", contact_email: "c@x.test", contact_phone: "999", business_type: ["Villa / rental"] }))
      .toEqual({ orgName: "Villa Sari", contactName: "Citra", contactEmail: "c@x.test", contactPhone: "999" });
  });
  it("org_name falls back: business name, else contact name, else '(not given)'", () => {
    expect(mapSubmissionToLead("onboard", { contact_name: "Citra" })!.orgName).toBe("Citra");
    expect(mapSubmissionToLead("onboard", {})!.orgName).toBe("(not given)");
    expect(mapSubmissionToLead("contact", { name: "   " })!.orgName).toBe("(not given)");
    expect(mapSubmissionToLead("contact", null)!.orgName).toBe("(not given)");
  });
  it("an unknown or absent form key maps to nothing (and prototype keys are not form keys)", () => {
    expect(mapSubmissionToLead("newsletter", { name: "x" })).toBeNull();
    expect(mapSubmissionToLead(null, { name: "x" })).toBeNull();
    expect(mapSubmissionToLead("constructor", { name: "x" })).toBeNull();
    expect(mapSubmissionToLead("__proto__", { name: "x" })).toBeNull();
  });
  it("covers exactly the three site forms", () => {
    expect(Object.keys(WEB_FORM_MAPPINGS).sort()).toEqual(["audit", "contact", "onboard"]);
  });
});

describe("createLeadFromWebSubmission", () => {
  it("creates a source 'web', status 'new' lead carrying form, attribution and visitor consent", async () => {
    const d = deps();
    const r = await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, d);
    expect(r.outcome).toBe("created");
    expect(store).toHaveLength(1);
    const p = store[0].params as unknown[];
    expect(p.slice(2, 6)).toEqual([NAME, NAME, EMAIL, PHONE]); // org (fallback), name, email, phone
    expect(p[6]).toBe(config.originSite); // origin_site = the platform identity
    expect(p[11]).toBe("gaiada"); // web_site_slug
    expect(p[7]).toBe("contact"); // origin_form
    expect(p[8]).toBe(SUB); // submission_ref
    expect(JSON.parse(p[9] as string)).toEqual({ landing: "/services/web/", utm_source: "google" });
    expect(JSON.parse(p[10] as string)).toMatchObject({ analytics: true, marketing: false, version: "3" });
  });

  it("is idempotent on (tenant, submission): a repeat returns the existing lead and does not re-fetch", async () => {
    const d = deps();
    const first = await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, d);
    const again = await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, d);
    expect(first.outcome).toBe("created");
    expect(again).toEqual({ outcome: "existing", leadId: (first as { leadId: string }).leadId });
    expect(store).toHaveLength(1);
    expect(d.fetched).toHaveLength(1);
    expect(events.filter((e) => e.type === "agency.lead.created")).toHaveLength(1);
  });

  it("flag off (the default): no lead, no fetch, no wall call", async () => {
    delete process.env.AGENCY_WEB_LEADS_ENABLED;
    const d = deps();
    const wall = vi.spyOn(d, "assertTenantOwnsSite");
    expect(await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, d)).toEqual({ outcome: "disabled" });
    expect(store).toHaveLength(0);
    expect(d.fetched).toHaveLength(0);
    expect(wall).not.toHaveBeenCalled();
    process.env.AGENCY_WEB_LEADS_ENABLED = "true"; // only the literal "1" enables
    expect((await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, d)).outcome).toBe("disabled");
  });

  it("410 submission-gone creates nothing and logs the id only", async () => {
    const r = await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, deps({ answer: "gone" }));
    expect(r).toEqual({ outcome: "gone" });
    expect(store).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(logged.join("\n")).toContain(SUB);
  });

  it("cross-tenant refusal with a VALID body: another company's slug is a 404 and nothing is fetched or created", async () => {
    const d = deps({ owned: ["someone-else"] });
    await expect(createLeadFromWebSubmission({ tenantId: TENANT_B, siteSlug: "gaiada", submissionId: SUB }, d))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(d.fetched).toHaveLength(0);
    expect(store).toHaveLength(0);
  });

  it("the same submission id in two tenants yields two leads (the key is (tenant, submission))", async () => {
    const d = deps({ owned: ["gaiada"] });
    await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, d);
    await createLeadFromWebSubmission({ tenantId: TENANT_B, siteSlug: "gaiada", submissionId: SUB }, d);
    expect(store.map((r) => r.tenant_id).sort()).toEqual([TENANT_A, TENANT_B]);
  });

  it("an unmapped form creates nothing; a mismatched submission id in the answer is refused", async () => {
    expect(await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, deps({ answer: submission("newsletter", { name: NAME }) })))
      .toEqual({ outcome: "unmapped_form" });
    await expect(createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, deps({ answer: submission("contact", { name: NAME }, SUB2) })))
      .rejects.toThrow(/unexpected shape/);
    expect(store).toHaveLength(0);
  });

  it("a non-uuid submission id is 'invalid' before any call", async () => {
    const d = deps();
    expect(await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: "not-a-uuid" }, d)).toEqual({ outcome: "invalid" });
    expect(d.fetched).toHaveLength(0);
  });

  it("an oversized attribution is dropped, not stored", async () => {
    const big = { ...submission("contact", { name: NAME }), attribution: { landing: "x".repeat(5000) } };
    await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, deps({ answer: big }));
    expect((store[0].params as unknown[])[9]).toBeNull();
  });

  it("M5-G5: a suppressed email OR phone stores nothing, emits nothing, and logs the outcome token only", async () => {
    suppressed.add(subjectHash(EMAIL.toLowerCase()));
    expect(await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, deps()))
      .toEqual({ outcome: "suppressed" });
    expect(store).toHaveLength(0);
    expect(events).toHaveLength(0);

    suppressed.clear();
    suppressed.add(subjectHash(normalizePhone(PHONE)!));
    expect(await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB2 }, deps()))
      .toEqual({ outcome: "suppressed" });
    expect(store).toHaveLength(0);
    const all = logged.join("\n");
    expect(all).toContain("suppressed");
    for (const s of SECRETS) expect(all).not.toContain(s);
  });

  it("M5-G5: an unrelated suppression does not block a different person", async () => {
    suppressed.add(subjectHash("someone.else@example.com"));
    const r = await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, deps());
    expect(r.outcome).toBe("created");
  });
});

describe("no field value is ever logged or put on the outbox", () => {
  const fieldsFor: Record<string, Record<string, unknown>> = {
    contact: { name: NAME, email_address: EMAIL, phone_number: PHONE, message: MSG },
    audit: { name: NAME, email_address: EMAIL, phone_number: PHONE, website_url: "https://leaktest.example", message: MSG },
    onboard: { org_name: BIZ, contact_name: NAME, contact_email: EMAIL, contact_phone: PHONE, anything_else: MSG },
    newsletter: { name: NAME, email_address: EMAIL, message: MSG },
  };

  it.each(Object.keys(fieldsFor))("form %s: created, repeated, and hooked — nothing personal in any log line or event", async (key) => {
    const d = deps({ answer: submission(key, fieldsFor[key]) });
    await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, d);
    await createLeadFromWebSubmission({ tenantId: TENANT_A, siteSlug: "gaiada", submissionId: SUB }, d);
    await maybeFileLeadFromFormReceived(TENANT_A, { kind: "form.received", originSite: "gaiada.com", data: { siteSlug: "gaiada", formId: "f", submissionId: SUB2, hasAttachments: false } }, d);
    const all = logged.join("\n") + JSON.stringify(events);
    for (const s of SECRETS) expect(all, `leaked ${s}`).not.toContain(s);
    expect(logged.length, "the test must have captured the service's own log lines").toBeGreaterThan(0);
  });

  it("an infrastructure failure (even one whose message quotes a value) logs a name only", async () => {
    const d: WebLeadsDeps = {
      assertTenantOwnsSite: async () => {},
      fetchSubmission: async () => { throw new Error(`boom ${EMAIL} ${NAME}`); },
    };
    await maybeFileLeadFromFormReceived(TENANT_A, { kind: "form.received", originSite: "gaiada.com", data: { siteSlug: "gaiada", formId: "f", submissionId: SUB, hasAttachments: false } }, d);
    const all = logged.join("\n");
    expect(all).toContain(SUB);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain(NAME);
  });
});

describe("the form.received hook", () => {
  const ev = { kind: "form.received", originSite: "gaiada.com", data: { siteSlug: "gaiada", formId: "f", submissionId: SUB, hasAttachments: false } };

  it("files a lead when the flag is on and the event is form.received", async () => {
    await maybeFileLeadFromFormReceived(TENANT_A, ev, deps());
    expect(store).toHaveLength(1);
    const p = store[0].params as unknown[];
    expect(p[6]).toBe(config.originSite);
    expect(p[6]).not.toBe("webdesk");
    expect(p[6]).not.toBe("gaiada.com");
    expect(p[11]).toBe("gaiada");
  });
  it("flag off: nothing happens", async () => {
    delete process.env.AGENCY_WEB_LEADS_ENABLED;
    const d = deps();
    await maybeFileLeadFromFormReceived(TENANT_A, ev, d);
    expect(store).toHaveLength(0);
    expect(d.fetched).toHaveLength(0);
  });
  it("another event kind is ignored; a replay is a no-op on the lead", async () => {
    const d = deps();
    await maybeFileLeadFromFormReceived(TENANT_A, { ...ev, kind: "deploy.done" }, d);
    expect(store).toHaveLength(0);
    await maybeFileLeadFromFormReceived(TENANT_A, ev, d);
    await maybeFileLeadFromFormReceived(TENANT_A, ev, d);
    expect(store).toHaveLength(1);
  });
  it("a foreign slug never throws out of the hook and creates nothing", async () => {
    await expect(maybeFileLeadFromFormReceived(TENANT_B, ev, deps({ owned: ["other"] }))).resolves.toBeUndefined();
    expect(store).toHaveLength(0);
  });
});
