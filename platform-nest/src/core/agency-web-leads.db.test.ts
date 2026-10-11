// M5-L4 — the real SQL for web-sourced leads, against real Postgres (migration 202610111330, the partial
// unique index, the widened source CHECK, RLS). Skips without DATABASE_URL_TEST (check the skip count).
// WebDesk is stubbed (the other half of the shared contract is built by M5-L2).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { createLeadFromWebSubmission, type WebLeadsDeps } from "./agency-web-leads.service";
import { createStaffLead } from "./agency-leads.service";

const SUB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe.skipIf(!TEST_URL)("agency web leads — real Postgres", () => {
  let a: string;
  let b: string;
  const fetchedBy: string[] = [];
  const wd = (ownerOf: Record<string, string>): WebLeadsDeps => ({
    async assertTenantOwnsSite(tenantId, slug) {
      if (ownerOf[slug] !== tenantId) throw new NotFoundException("site_not_found");
    },
    async fetchSubmission(slug, id) {
      fetchedBy.push(slug);
      return {
        submissionId: id, formId: "f", formKey: "onboard", siteSlug: slug, createdAt: "2026-10-11T09:00:00Z", status: "new",
        fields: { org_name: "Villa Sari", contact_name: "Citra", contact_email: "c@x.test" },
        attribution: { landing: "/services/web/", sections_seen: ["home.hero"] },
        visitorConsent: { analytics: true, marketing: false, version: "3" },
      };
    },
  });

  beforeAll(async () => {
    await initTestDb();
    process.env.AGENCY_WEB_LEADS_ENABLED = "1";
    a = await createCompany("Gaiada Creative");
    b = await createCompany("Other Co");
  }, 60000);
  afterAll(async () => {
    delete process.env.AGENCY_WEB_LEADS_ENABLED;
    await teardownTestDb();
  });

  it("creates one web lead with the new columns, and a repeat returns the same lead", async () => {
    const deps = wd({ gaiada: a });
    const r1 = await createLeadFromWebSubmission({ tenantId: a, siteSlug: "gaiada", submissionId: SUB }, deps);
    const r2 = await createLeadFromWebSubmission({ tenantId: a, siteSlug: "gaiada", submissionId: SUB }, deps);
    expect(r1.outcome).toBe("created");
    expect(r2).toEqual({ outcome: "existing", leadId: (r1 as { leadId: string }).leadId });
    const { rows } = await withTenants([a], (c) => c.query(`SELECT * FROM agency_leads WHERE submission_ref = $1`, [SUB]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "web", status: "new", org_name: "Villa Sari", origin_form: "onboard", origin_site: "gaiada" });
    expect(rows[0].attribution).toEqual({ landing: "/services/web/", sections_seen: ["home.hero"] });
    expect(rows[0].visitor_consent).toMatchObject({ analytics: true, marketing: false });
  });

  it("concurrent identical submissions still make exactly one lead (the unique index, not the pre-check)", async () => {
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const deps = wd({ gaiada: a });
    const rs = await Promise.all(Array.from({ length: 6 }, () => createLeadFromWebSubmission({ tenantId: a, siteSlug: "gaiada", submissionId: id }, deps)));
    expect(new Set(rs.map((r) => (r as { leadId: string }).leadId)).size).toBe(1);
    expect(rs.filter((r) => r.outcome === "created")).toHaveLength(1);
  });

  it("cross-tenant: tenant B naming A's slug is refused; B's own lead for the same id is separate and invisible to A", async () => {
    await expect(createLeadFromWebSubmission({ tenantId: b, siteSlug: "gaiada", submissionId: SUB }, wd({ gaiada: a }))).rejects.toBeInstanceOf(NotFoundException);
    const r = await createLeadFromWebSubmission({ tenantId: b, siteSlug: "other", submissionId: SUB }, wd({ other: b }));
    expect(r.outcome).toBe("created");
    const inA = await withTenants([a], (c) => c.query(`SELECT tenant_id FROM agency_leads WHERE submission_ref = $1`, [SUB]));
    expect(inA.rows.map((x) => x.tenant_id)).toEqual([a]);
  });

  it("the source CHECK keeps every pre-existing value and gains 'web'; a stranger is refused", async () => {
    await createStaffLead(a, null, { orgName: "Phoned In", contactName: null, contactEmail: null, contactPhone: null }); // 'staff'
    for (const src of ["invite", "open", "web"]) {
      await withTenants([a], (c) =>
        c.query(`INSERT INTO agency_leads (id, tenant_id, org_name, source, status, origin_site) VALUES (gen_random_uuid(), $1, 'x', $2, 'new', 's')`, [a, src]));
    }
    await expect(
      withTenants([a], (c) => c.query(`INSERT INTO agency_leads (id, tenant_id, org_name, source, status, origin_site) VALUES (gen_random_uuid(), $1, 'x', 'nope', 'new', 's')`, [a])),
    ).rejects.toThrow(/agency_leads_source_check/);
  });

  it("the partial unique index only constrains non-null refs (many NULL-ref leads coexist)", async () => {
    const { rows } = await adminPool().query(`SELECT count(*)::int AS n FROM agency_leads WHERE submission_ref IS NULL`);
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
