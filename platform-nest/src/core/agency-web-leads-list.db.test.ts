// M5-L6 - the Website -> Leads read over HTTP (app.inject) against REAL Postgres and REAL Cerbos: the filter
// (source 'web' AND this site slug), newest first, the privacy projection, the intake-flag boolean, and the
// cross-company wall. Needs DATABASE_URL_TEST (+ CERBOS_URL, REDIS_URL_TEST): the Linux gate. Skips without it.
// Every denial below sends a VALID tenant and slug, so validation can never stand in for the 403.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("M5-L6 - web leads list: filter, projection, flag, cross-company", () => {
  let app: NestFastifyApplication;
  let co: string;
  let coB: string;
  let viewer: string;
  let adminB: string;
  let outsider: string;
  const ids: Record<string, string> = {};
  let seq = 0;

  async function seed(
    tenant: string,
    key: string,
    o: { source?: string; slug?: string | null; at: string; org: string; attribution?: unknown; consent?: unknown; web?: boolean },
  ) {
    const id = newId();
    ids[key] = id;
    const n = ++seq;
    const ref = o.web === false ? null : `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, source, status, origin_site, origin_form, submission_ref,
                                   attribution, visitor_consent, web_site_slug, created_at)
         VALUES ($1, $2, $3, 'Contact', $4, 'new', 'test', 'contact', $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [id, tenant, o.org, o.source ?? "web", ref, o.attribution == null ? null : JSON.stringify(o.attribution),
         o.consent == null ? null : JSON.stringify(o.consent), o.slug === undefined ? "gaiada" : o.slug, o.at],
      ),
    );
  }
  const get = (tenant: string, user: string, slug: string) =>
    app.inject({ method: "GET", url: `/api/${tenant}/agency/web-leads/${slug}`, headers: asUser(user) });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Web Leads A");
    coB = await createCompany("Web Leads B");
    const mk = async (email: string, role: string, tenant: string) => {
      const id = await createUser(email);
      await addMembership(tenant, id);
      await grantRole(id, await createRole(role), "company", tenant);
      return id;
    };
    viewer = await mk("viewer@web-leads-list.test", "viewer", co);
    adminB = await mk("admin-b@web-leads-list.test", "company_admin", coB);
    outsider = await createUser("outsider@web-leads-list.test");
    await seed(co, "deleted", { org: "Deleted Web", at: "2026-10-01T09:00:00Z", attribution: { landing: "/a/" } });
    await seed(co, "old", { org: "Old Web", at: "2026-10-02T09:00:00Z" });
    await seed(co, "new", {
      org: "New Web", at: "2026-10-10T09:00:00Z",
      attribution: { landing: "/services/web/", utm_source: "google", utm_medium: "cpc", utm_campaign: "spring", gclid: "SECRET-GCLID", fbp: "fb.1.2", sections_seen: ["home.hero"] },
      consent: { analytics: true, marketing: true, version: "3" },
    });
    await seed(co, "other-site", { org: "Other Site", at: "2026-10-11T09:00:00Z", slug: "other" });
    await seed(co, "staff", { org: "Staff Entered", source: "staff", at: "2026-10-12T09:00:00Z", web: false });
    await seed(coB, "b-same-slug", { org: "B Web", at: "2026-10-11T09:00:00Z" });
    await withTenants([co], (c) => c.query(`UPDATE agency_leads SET deleted_at = now() WHERE id = $1`, [ids.deleted]));
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    delete process.env.AGENCY_WEB_LEADS_ENABLED;
    await app.close();
    await teardownTestDb();
  });

  it("returns only this tenant's web leads for the slug, newest first; staff-entered, other-site, deleted and other-company leads are absent", async () => {
    const res = await get(co, viewer, "gaiada");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.leads.map((l: { orgName: string }) => l.orgName)).toEqual(["New Web", "Old Web"]);
    expect(body.truncated).toBe(false);
  });

  it("projects attribution and consent; never a click-id value or fbp/fbc anywhere in the body", async () => {
    const res = await get(co, viewer, "gaiada");
    const row = res.json().leads[0];
    expect(row).toMatchObject({
      id: ids.new, originForm: "contact", status: "new", stage: "enquiry", marketingConsent: true,
      attribution: { landing: "/services/web/", utmSource: "google", utmMedium: "cpc", utmCampaign: "spring", clickIds: ["gclid"] },
    });
    expect(res.payload).not.toContain("SECRET-GCLID");
    expect(res.payload).not.toContain("fb.1.2");
    expect(res.json().leads[1].marketingConsent).toBeNull();
  });

  it("leadIntakeEnabled mirrors the flag as a boolean and never the raw value", async () => {
    delete process.env.AGENCY_WEB_LEADS_ENABLED;
    expect((await get(co, viewer, "gaiada")).json().leadIntakeEnabled).toBe(false);
    process.env.AGENCY_WEB_LEADS_ENABLED = "1";
    expect((await get(co, viewer, "gaiada")).json().leadIntakeEnabled).toBe(true);
  });

  it("a slug with no leads is a 200 with an empty list (evidence of emptiness, not a refusal)", async () => {
    const res = await get(co, viewer, "no-such-site");
    expect(res.statusCode).toBe(200);
    expect(res.json().leads).toEqual([]);
  });

  it("cross-company: another company's admin is 403 on this tenant's path (valid slug); a non-member is 403; neither sees a lead", async () => {
    const b = await get(co, adminB, "gaiada");
    expect(b.statusCode).toBe(403);
    expect(b.payload).not.toContain("New Web");
    expect((await get(co, outsider, "gaiada")).statusCode).toBe(403);
  });

  it("the same slug in another company is that company's own list, never this one's", async () => {
    const res = await get(coB, adminB, "gaiada");
    expect(res.statusCode).toBe(200);
    expect(res.json().leads.map((l: { orgName: string }) => l.orgName)).toEqual(["B Web"]);
  });
});
